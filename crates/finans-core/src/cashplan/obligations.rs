//! Ödeme takvimi ödemeleri: arayüzdeki `plan.ts` `obligations` kurallarının aynısı.

use std::collections::HashSet;

use serde::Serialize;

use crate::accounts::cards::{add_days, card_dues, clamped_date, js_cents, shift_closing};
use crate::accounts::loans::loan_summary;
use crate::budget::income::matches_regular;
use crate::budget::recurring::{amount_for_occurrence, has_started, month_of, occurrence_in, shift_month};
use crate::db::{Account, RecurringItem, Transaction};
use crate::fx;
use crate::fx::time::{days_between, parse_ymd, ymd};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installment {
    pub index: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Obligation {
    pub key: String,
    /// "card" | "loan" | "recurring" | "planned"
    pub kind: &'static str,
    pub date: String,
    pub amount_cents: i64,
    pub account_id: Option<String>,
    pub recurring_id: Option<String>,
    pub transaction_id: Option<String>,
    pub installment: Option<Installment>,
    /// Tutar henüz kesinleşmedi (gelecek ekstre)
    pub estimated: bool,
    pub overdue: bool,
    /// Karşılayan gelir son ödemeden sonra yatıyor (yalnız takvim modunda)
    pub before_income: bool,
    /// Borcun ait olduğu ay: kartta harcama döneminin ortası, diğerlerinde ödeme ayı
    pub period_month: String,
    pub loan_interest_cents: Option<i64>,
    pub loan_principal_cents: Option<i64>,
    /// Satır adı ("… ekstresi", "… · 3/12. taksit"); rapor kurarken yazılır
    pub label: String,
    /// Bugünden ödeme tarihine gün (eksi: gecikti)
    pub days_left: i64,
}

/// TS `isForeign`
pub fn is_foreign(currency: &str) -> bool {
    !currency.is_empty() && currency != fx::TRY
}

/// Takvimin nakdi: TL banka/nakit hesabı (vadeli mevduat, BES ve diğer varlık harcanabilir nakit değil)
pub fn is_cash_account(a: &Account) -> bool {
    (a.kind == "bank" || a.kind == "cash") && !is_foreign(&a.currency) && !a.is_saving()
}

/// İki tarihin orta gününün ayı (TS `periodMidMonth`; Türkiye'de yaz saati yok)
fn period_mid_month(start: &str, end: &str) -> String {
    match (parse_ymd(start), parse_ymd(end)) {
        (Some(a), Some(b)) => ymd((a + b).div_euclid(2))[..7].to_string(),
        _ => month_of(end).to_string(),
    }
}

/// Düzenli kaydın [from, to] tekrarları (TS `occurrencesBetween`; kaydırma komşu aya taşıyabilir)
pub fn occurrences_between(item: &RecurringItem, from: &str, to: &str) -> Vec<String> {
    let mut out = Vec::new();
    let end = shift_month(month_of(to), 1);
    let mut m = shift_month(month_of(from), -1);
    while m <= end {
        let d = occurrence_in(item, &m);
        if d.as_str() >= from && d.as_str() <= to {
            out.push(d);
        }
        m = shift_month(&m, 1);
    }
    out
}

/// TS `addMonthsISO`
pub fn add_months(iso: &str, months: i64) -> String {
    let num = |r: std::ops::Range<usize>| iso.get(r).and_then(|s| s.parse::<i64>().ok()).unwrap_or(1);
    clamped_date(num(0..4), num(5..7) - 1 + months, num(8..10))
}

/// Bugünden `until`'e kadar kart, kredi, ileri tarihli ve düzenli gider ödemeleri (gecikmişler dahil); tarih, sonra anahtar sırasıyla
pub fn obligations(accounts: &[Account], txs: &[Transaction], recurring: &[RecurringItem], today: &str, until: &str) -> Vec<Obligation> {
    let mut out = Vec::new();
    for a in accounts {
        if a.kind == "credit_card" {
            let sd = a.statement_day.unwrap_or(1);
            for d in card_dues(a, txs, today, until) {
                out.push(Obligation {
                    key: format!("card:{}:{}", a.id, d.closing_date),
                    kind: "card",
                    period_month: period_mid_month(&add_days(&shift_closing(&d.closing_date, -1, sd), 1), &d.closing_date),
                    overdue: d.due_date.as_str() < today,
                    date: d.due_date,
                    amount_cents: d.amount_cents,
                    account_id: Some(a.id.clone()),
                    recurring_id: None,
                    transaction_id: None,
                    installment: None,
                    estimated: d.estimated,
                    before_income: false,
                    loan_interest_cents: None,
                    loan_principal_cents: None,
                    label: String::new(),
                    days_left: 0,
                });
            }
        } else if a.kind == "loan" {
            let s = loan_summary(a, txs);
            let count = s.schedule.len() as i64;
            for row in &s.schedule[s.paid_count as usize..] {
                if row.date.as_str() > until {
                    break;
                }
                out.push(Obligation {
                    key: format!("loan:{}:{}", a.id, row.index),
                    kind: "loan",
                    date: row.date.clone(),
                    amount_cents: row.payment_cents,
                    account_id: Some(a.id.clone()),
                    recurring_id: None,
                    transaction_id: None,
                    installment: Some(Installment { index: row.index, count }),
                    estimated: false,
                    overdue: row.date.as_str() < today,
                    before_income: false,
                    period_month: month_of(&row.date).to_string(),
                    loan_interest_cents: Some(row.interest_cents),
                    loan_principal_cents: Some(row.principal_cents),
                    label: String::new(),
                    days_left: 0,
                });
            }
        }
    }
    let cash: HashSet<&str> = accounts.iter().filter(|a| is_cash_account(a)).map(|a| a.id.as_str()).collect();
    let active_expenses: Vec<&RecurringItem> = recurring.iter().filter(|r| r.active && r.kind == "expense").collect();
    let regular_for = |t: &Transaction| active_expenses.iter().copied().find(|r| matches_regular(t, r));
    let mut replaced: HashSet<String> = HashSet::new();
    // Bu ay zaten ödenmiş düzenli gider o ayın planından düşer
    let month_start = format!("{}-01", month_of(today));
    for t in txs {
        if t.kind != "expense" || t.date < month_start || t.date.as_str() > today {
            continue;
        }
        if let Some(r) = regular_for(t) {
            replaced.insert(format!("{}:{}", r.id, month_of(&t.date)));
        }
    }
    // İleri tarihli banka/nakit giderleri; düzenli gidere karşılık geliyorsa o ayın tekrarının yerine geçer
    for t in txs.iter().filter(|t| t.kind == "expense" && cash.contains(t.account_id.as_str()) && t.date.as_str() > today && t.date.as_str() <= until) {
        if let Some(r) = regular_for(t) {
            replaced.insert(format!("{}:{}", r.id, month_of(&t.date)));
        }
        out.push(Obligation {
            key: format!("tx:{}", t.id),
            kind: "planned",
            date: t.date.clone(),
            amount_cents: js_cents(t.amount),
            account_id: Some(t.account_id.clone()),
            recurring_id: None,
            transaction_id: Some(t.id.clone()),
            installment: None,
            estimated: false,
            overdue: false,
            before_income: false,
            period_month: month_of(&t.date).to_string(),
            loan_interest_cents: None,
            loan_principal_cents: None,
            label: String::new(),
            days_left: 0,
        });
    }
    for r in recurring.iter().filter(|r| r.active && r.kind == "expense") {
        for date in occurrences_between(r, today, until) {
            if !has_started(r, &date) || replaced.contains(&format!("{}:{}", r.id, month_of(&date))) {
                continue;
            }
            out.push(Obligation {
                key: format!("rec:{}:{}", r.id, date),
                kind: "recurring",
                amount_cents: js_cents(amount_for_occurrence(r, &date)),
                account_id: r.account_id.clone(),
                recurring_id: Some(r.id.clone()),
                transaction_id: None,
                installment: None,
                estimated: false,
                overdue: false,
                before_income: false,
                period_month: month_of(&date).to_string(),
                loan_interest_cents: None,
                loan_principal_cents: None,
                label: String::new(),
                days_left: 0,
                date,
            });
        }
    }
    out.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.key.cmp(&b.key)));
    for o in &mut out {
        o.days_left = days_between(today, &o.date);
    }
    out
}
