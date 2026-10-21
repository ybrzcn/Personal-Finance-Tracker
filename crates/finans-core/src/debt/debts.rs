//! Hesaplardan faiz işleyen borçlar (TS `debtsFromAccounts`)

use crate::accounts::bank::bank_summary;
use crate::accounts::cards::{add_days, card_dues, card_report};
use crate::accounts::loans::{effective_monthly_rate, loan_summary, DEFAULT_LOAN_TAX};
use crate::cashplan::obligations::is_foreign;
use crate::db::{Account, Transaction};

/// Kredi kartı ve KMH faizine eklenen KKDF (%15) + BSMV (%15)
pub const REVOLVING_TAX: f64 = 30.0;

#[derive(Debug, Clone)]
pub struct Debt {
    pub id: String,
    /// "credit_card" | "bank" (KMH) | "loan"
    pub kind: String,
    pub balance_cents: i64,
    /// Vergi dahil aylık efektif faiz (oran)
    pub monthly_rate: f64,
    /// Kart: asgari oran (yüzde)
    pub min_rate_pct: Option<f64>,
    /// Kredi: sabit taksit
    pub fixed_payment_cents: Option<i64>,
    pub order: i64,
    /// Kart: borcun planın aylarına düşen kısımları (0 = 1. ay); henüz ekstreye girmemiş tutar faiz işletmez.
    /// KMH ve kredide yok: borcun tamamı ilk aydan ödenebilir.
    pub billing: Option<Vec<i64>>,
}

impl Debt {
    /// İlk ay ödenmesi gelen bakiye
    pub fn first_due(&self) -> i64 {
        match &self.billing {
            Some(b) => b.first().copied().unwrap_or(0),
            None => self.balance_cents,
        }
    }
}

/// `bucket(son ödeme tarihi)`: ekstrenin düştüğü plan ayı (1 = ilk ay)
pub fn debts_from_accounts(accounts: &[Account], txs: &[Transaction], today: &str, bucket: &dyn Fn(&str) -> i64) -> Vec<Debt> {
    let mut out = Vec::new();
    for a in accounts {
        let debt = |balance_cents: i64, monthly_rate: f64, min_rate_pct: Option<f64>, fixed_payment_cents: Option<i64>, billing: Option<Vec<i64>>| Debt {
            id: a.id.clone(),
            kind: a.kind.clone(),
            balance_cents,
            monthly_rate,
            min_rate_pct,
            fixed_payment_cents,
            order: a.sort_order,
            billing,
        };
        if a.kind == "credit_card" {
            let bal = card_report(a, txs, today).total_debt_cents;
            if bal > 0 {
                let mut billing = vec![0i64];
                for due in card_dues(a, txs, today, &add_days(today, 3700)) {
                    let k = (bucket(&due.due_date).max(1) - 1) as usize;
                    if billing.len() <= k {
                        billing.resize(k + 1, 0);
                    }
                    billing[k] += due.amount_cents;
                }
                // Ekstrelere dağılmayan fark (iade, kesim tarihi eksik vb.) ilk aya
                let spread: i64 = billing.iter().sum();
                billing[0] = (billing[0] + bal - spread).max(0);
                let rate = effective_monthly_rate(a.interest_rate, Some(REVOLVING_TAX));
                out.push(debt(bal, rate, Some(a.min_payment_rate.unwrap_or(20.0)), None, Some(billing)));
            }
        } else if a.kind == "bank" && !is_foreign(&a.currency) {
            let used = bank_summary(a, txs, today).overdraft_used_cents;
            if used > 0 {
                out.push(debt(used, effective_monthly_rate(a.interest_rate, Some(REVOLVING_TAX)), None, None, None));
            }
        } else if a.kind == "loan" {
            let s = loan_summary(a, txs);
            if s.remaining_cents > 0 {
                let fixed = s.next.as_ref().map_or(s.remaining_cents, |n| n.payment_cents);
                let rate = effective_monthly_rate(a.interest_rate, Some(a.tax_rate.unwrap_or(DEFAULT_LOAN_TAX)));
                out.push(debt(s.remaining_cents, rate, None, Some(fixed), None));
            }
        }
    }
    out
}
