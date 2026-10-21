//! Dönemin zaten ödenmiş / yatmış kalemleri: takvimde soluk "ödendi" / "yattı" satırları (bakiye tahminine girmez).

use std::collections::HashSet;

use serde::Serialize;

use super::key_of;
use super::obligations::{is_cash_account, Installment};
use crate::accounts::cards::{card_movements, card_statements, js_cents};
use crate::accounts::loans::loan_summary;
use crate::budget::income::{assign_regular, matches_regular};
use crate::budget::recurring::{amount_for_occurrence, month_of, occurrence_in, shift_month};
use crate::db::{Account, RecurringItem, Transaction};
use crate::fx::time::parse_ymd;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaidRow {
    pub key: String,
    /// "card" | "loan" | "recurring"
    pub kind: &'static str,
    pub date: String,
    pub amount_cents: i64,
    pub account_id: Option<String>,
    pub recurring_id: Option<String>,
    pub transaction_id: Option<String>,
    pub installment: Option<Installment>,
    /// Kartta: "paid" | "minPaid" | "partial" (bugüne kadar yapılan ödemeye göre)
    pub card_status: Option<&'static str>,
    /// İleri tarihli (henüz yapılmamış, planlanmış) ödeme
    pub scheduled: bool,
    /// Satır adı (ödeme satırıyla aynı kural)
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedRow {
    pub key: String,
    pub transaction_id: String,
    pub date: String,
    pub amount_cents: i64,
    pub account_id: String,
}

/// Dönem anahtarıyla satırlar
pub struct Settled {
    pub paid: Vec<(String, PaidRow)>,
    pub received: Vec<(String, ReceivedRow)>,
}

/// Ödemenin karşılık geldiği tekrar: ödeme tarihine en yakın tekrar (önceki, aynı, sonraki ay; eşitlikte önceki)
fn nearest_occurrence(r: &RecurringItem, date: &str) -> String {
    let m = month_of(date);
    let at = parse_ymd(date).unwrap_or(0);
    let mut best: Option<(i64, String)> = None;
    for month in [shift_month(m, -1), m.to_string(), shift_month(m, 1)] {
        let d = occurrence_in(r, &month);
        let gap = (parse_ymd(&d).unwrap_or(0) - at).abs();
        if best.as_ref().is_none_or(|(g, _)| gap < *g) {
            best = Some((gap, d));
        }
    }
    best.map(|(_, d)| d).unwrap_or_default()
}

/// `txs` ve `recurring` döviz kalemlerinden arındırılmış olmalı (takvimle aynı girdi); `listed` takvimdeki ödeme anahtarları
pub fn settled(
    accounts: &[Account],
    txs: &[Transaction],
    recurring: &[RecurringItem],
    today: &str,
    salary: Option<&RecurringItem>,
    listed: &HashSet<&str>,
) -> Settled {
    let mut paid = Vec::new();
    let current = key_of(salary, today);
    // Bugüne kadar yapılmış işlemler: ileri tarihli ödemeler "ödendi" değil "planlandı"
    let past_txs: Vec<Transaction> = txs.iter().filter(|t| t.date.as_str() <= today).cloned().collect();
    for a in accounts {
        if a.kind == "credit_card" {
            let mv = card_movements(a, txs);
            let mv_past: Vec<_> = mv.iter().filter(|m| m.date.as_str() <= today).cloned().collect();
            for (s, p) in card_statements(a, &mv, today, 6).into_iter().zip(card_statements(a, &mv_past, today, 6)) {
                let paid_all = s.paid_cents.min(s.statement_cents).max(0);
                let paid_now = p.paid_cents.min(p.statement_cents).max(0).min(paid_all);
                // Gecikmiş ekstrenin ödenen kısmı, kalanıyla aynı döneme (bugünün dönemine)
                let key = key_of(salary, if s.status == "overdue" { today } else { &s.due_date });
                let row = |key_suffix: &str, amount_cents: i64, card_status: Option<&'static str>, scheduled: bool| PaidRow {
                    key: format!("paid:card:{}:{}{}", a.id, s.closing_date, key_suffix),
                    kind: "card",
                    date: s.due_date.clone(),
                    amount_cents,
                    account_id: Some(a.id.clone()),
                    recurring_id: None,
                    transaction_id: None,
                    installment: None,
                    card_status,
                    scheduled,
                    label: String::new(),
                };
                if paid_now > 0 {
                    let status = match p.status {
                        "paid" => "paid",
                        "minPaid" => "minPaid",
                        _ => "partial",
                    };
                    paid.push((key.clone(), row("", paid_now, Some(status), false)));
                }
                if paid_all > paid_now {
                    paid.push((key, row(":planned", paid_all - paid_now, None, true)));
                }
            }
        } else if a.kind == "loan" {
            let s = loan_summary(a, txs);
            let paid_now = loan_summary(a, &past_txs).paid_count;
            let count = s.schedule.len() as i64;
            for row in &s.schedule[..s.paid_count as usize] {
                // Erken kapatma: sonraki dönemlerin taksitleri o dönemlerde "ödendi" görünmez
                let key = key_of(salary, &row.date);
                if key > current {
                    continue;
                }
                paid.push((
                    key,
                    PaidRow {
                        key: format!("paid:loan:{}:{}", a.id, row.index),
                        kind: "loan",
                        date: row.date.clone(),
                        amount_cents: row.payment_cents,
                        account_id: Some(a.id.clone()),
                        recurring_id: None,
                        transaction_id: None,
                        installment: Some(Installment { index: row.index, count }),
                        card_status: None,
                        scheduled: row.index > paid_now,
                        label: String::new(),
                    },
                ));
            }
        }
    }
    // Banka/nakitten ödenmiş düzenli giderler (kartla ödenenler ekstrede sayılır)
    let cash: HashSet<&str> = accounts.iter().filter(|a| is_cash_account(a)).map(|a| a.id.as_str()).collect();
    let active_expenses: Vec<&RecurringItem> = recurring.iter().filter(|r| r.active && r.kind == "expense").collect();
    // Her düzenli gider tekrarı için en fazla bir ödeme: tutarı o tekrarın planına en yakın olan (aynı kategorideki diğer
    // faturalar o kaydın ödemesi sayılmaz)
    let mut chosen: Vec<(&RecurringItem, String, &Transaction, f64)> = Vec::new();
    for t in txs.iter().filter(|t| t.kind == "expense" && cash.contains(t.account_id.as_str()) && t.date.as_str() <= today) {
        let Some(r) = active_expenses.iter().copied().find(|r| matches_regular(t, r)) else { continue };
        let occurrence = nearest_occurrence(r, &t.date);
        let diff = (t.amount - amount_for_occurrence(r, &occurrence)).abs();
        match chosen.iter_mut().find(|(cr, co, _, _)| cr.id == r.id && *co == occurrence) {
            Some(c) if diff < c.3 => {
                c.2 = t;
                c.3 = diff;
            }
            Some(_) => {}
            None => chosen.push((r, occurrence, t, diff)),
        }
    }
    for (r, occurrence, t, _) in chosen {
        // Erken ödenmiş ama tekrarı takvimde hâlâ ödeme olarak duran kalem iki kez sayılmasın
        if listed.contains(format!("rec:{}:{}", r.id, occurrence).as_str()) {
            continue;
        }
        paid.push((
            key_of(salary, &t.date),
            PaidRow {
                key: format!("paid:tx:{}", t.id),
                kind: "recurring",
                date: t.date.clone(),
                amount_cents: js_cents(t.amount),
                account_id: Some(t.account_id.clone()),
                recurring_id: Some(r.id.clone()),
                transaction_id: Some(t.id.clone()),
                installment: None,
                card_status: None,
                scheduled: false,
                label: String::new(),
            },
        ));
    }
    // Yatmış ve düzenli bir gelire karşılık gelmeyen gelirler
    // Yalnız TL banka/nakit hesaplarına yatanlar (karta girilen iade/nakit iade "yattı" değildir)
    let incomes: Vec<&Transaction> =
        txs.iter().filter(|t| t.kind == "income" && cash.contains(t.account_id.as_str()) && t.date.as_str() <= today).collect();
    let regular: Vec<&RecurringItem> = recurring.iter().filter(|r| r.kind == "income" && r.active).collect();
    let assigned = assign_regular(&incomes, &regular);
    let received = incomes
        .into_iter()
        .filter(|t| !assigned.contains_key(&t.id))
        .map(|t| {
            let key = match (salary, t.budget_month.as_deref().filter(|m| !m.is_empty())) {
                (Some(_), Some(m)) => m.to_string(),
                (Some(_), None) => key_of(salary, &t.date),
                (None, _) => month_of(&t.date).to_string(),
            };
            (key, ReceivedRow { key: format!("got:tx:{}", t.id), transaction_id: t.id.clone(), date: t.date.clone(), amount_cents: js_cents(t.amount), account_id: t.account_id.clone() })
        })
        .collect();
    Settled { paid, received }
}
