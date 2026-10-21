//! Kredi: arayüzdeki `loans.ts` kurallarının aynısı.

use serde::Serialize;

use crate::db::{Account, Transaction};

use super::cards::{clamped_date, js_cents, js_round};

/// TS `liabilityBalanceCents`: açılış + giderler + giden transferler − gelirler − gelen transferler.
/// `d` verilirse sonraki işlemler sayılmaz. Kırpılmaz (fazla ödeme eksi).
pub fn liability_at(a: &Account, txs: &[Transaction], d: Option<&str>) -> i64 {
    let mut b = js_cents(a.opening_balance);
    for t in txs.iter().filter(|t| d.is_none_or(|d| t.date.as_str() <= d)) {
        let c = js_cents(t.amount);
        if t.account_id == a.id {
            b += if t.kind == "income" { -c } else { c };
        }
        if t.kind == "transfer" && t.to_account_id.as_deref() == Some(a.id.as_str()) {
            b -= c;
        }
    }
    b
}

/// Net servet: `d` tarihindeki kredi borcu, en az 0
pub fn loan_balance(a: &Account, txs: &[Transaction], d: &str) -> i64 {
    liability_at(a, txs, Some(d)).max(0)
}

/// Tüketici kredilerinde faize eklenen KKDF (%15) + BSMV (%15)
pub const DEFAULT_LOAN_TAX: f64 = 30.0;

/// Vergi dahil aylık efektif faiz (oran, ör. 0.0429)
pub fn effective_monthly_rate(rate_pct: Option<f64>, tax_pct: Option<f64>) -> f64 {
    (rate_pct.unwrap_or(0.0) / 100.0) * (1.0 + tax_pct.unwrap_or(0.0) / 100.0)
}

/// Eşit taksitli (anüite) aylık ödeme, kuruş (TS `annuityPaymentCents`)
pub fn annuity_payment_cents(principal: i64, r: f64, n: i64) -> i64 {
    if n <= 0 {
        return 0;
    }
    if r == 0.0 {
        return (principal as f64 / n as f64).ceil() as i64;
    }
    js_round((principal as f64 * r) / (1.0 - (1.0 + r).powf(-(n as f64))))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanRow {
    /// 1'den başlar
    pub index: i64,
    pub date: String,
    pub payment_cents: i64,
    pub interest_cents: i64,
    pub principal_cents: i64,
    /// Bu taksitten sonra kalan anapara
    pub balance_cents: i64,
}

/// TS `loanSchedule`: açılış tutarı kalan anapara, vade kalan taksit sayısı, ilk taksit tarihi sonraki taksit
pub fn loan_schedule(a: &Account) -> Vec<LoanRow> {
    let n = a.term_months.unwrap_or(0);
    let first = a.first_due_date.as_deref().unwrap_or("");
    if n == 0 || first.is_empty() {
        return Vec::new();
    }
    let principal = js_cents(a.opening_balance);
    let r = effective_monthly_rate(a.interest_rate, Some(a.tax_rate.unwrap_or(DEFAULT_LOAN_TAX)));
    let pay = match a.installment_amount {
        Some(x) if x != 0.0 => js_cents(x),
        _ => annuity_payment_cents(principal, r, n),
    };
    let num = |s: Option<&str>| s.and_then(|s| s.parse::<i64>().ok()).unwrap_or(1);
    let (y, m, day) = (num(first.get(0..4)), num(first.get(5..7)) - 1, num(first.get(8..10)));
    let mut rows = Vec::new();
    let mut bal = principal;
    let mut k = 0;
    while k < n && bal > 0 {
        let interest = js_round(bal as f64 * r);
        let mut principal_part = (pay - interest).max(0);
        let mut payment = pay;
        if k == n - 1 || principal_part >= bal {
            principal_part = bal;
            payment = bal + interest;
        }
        bal -= principal_part;
        rows.push(LoanRow {
            index: k + 1,
            date: clamped_date(y, m + k, day),
            payment_cents: payment,
            interest_cents: interest,
            principal_cents: principal_part,
            balance_cents: bal,
        });
        k += 1;
    }
    rows
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanSummary {
    pub schedule: Vec<LoanRow>,
    pub remaining_cents: i64,
    /// Ödenmiş sayılan taksit sayısı (kalan anaparaya göre)
    pub paid_count: i64,
    pub next: Option<LoanRow>,
    pub remaining_interest_cents: i64,
    /// Bugünden sonraki taksite gün (eksi: gecikti); hesap raporu doldurur
    pub next_due_in_days: Option<i64>,
}

/// TS `loanSummary` (ileri tarihli ödemeler de sayılır)
pub fn loan_summary(a: &Account, txs: &[Transaction]) -> LoanSummary {
    let schedule = loan_schedule(a);
    let remaining_cents = liability_at(a, txs, None).max(0);
    // Kalan anaparadan küçük "taksit sonrası bakiye"ye sahip ilk satır sıradaki taksittir
    let paid = if remaining_cents == 0 {
        schedule.len()
    } else {
        schedule.iter().position(|row| row.balance_cents < remaining_cents).unwrap_or(schedule.len())
    };
    let rest = &schedule[paid..];
    LoanSummary {
        next: rest.first().cloned(),
        next_due_in_days: None,
        remaining_interest_cents: rest.iter().map(|r| r.interest_cents).sum(),
        paid_count: paid as i64,
        remaining_cents,
        schedule,
    }
}
