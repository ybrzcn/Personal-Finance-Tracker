//! Takvim satırlarının adı ve sırası (eski arayüz `obligationLabel` / `sortByDateLabel` kuralı).

use std::collections::HashMap;

use super::obligations::{Installment, Obligation};
use super::settled::PaidRow;
use crate::db::{Account, RecurringItem, Transaction};
use crate::order::cmp_tr;

/// Satır adları için kimlik → ad
pub struct PlanNames<'a> {
    accounts: HashMap<&'a str, &'a str>,
    recurring: HashMap<&'a str, &'a str>,
    descriptions: HashMap<&'a str, &'a str>,
}

impl<'a> PlanNames<'a> {
    pub fn new(accounts: &'a [Account], recurring: &'a [RecurringItem], transactions: &'a [Transaction]) -> Self {
        PlanNames {
            accounts: accounts.iter().map(|a| (a.id.as_str(), a.name.as_str())).collect(),
            recurring: recurring.iter().map(|r| (r.id.as_str(), r.name.as_str())).collect(),
            descriptions: transactions.iter().map(|t| (t.id.as_str(), t.description.as_str())).collect(),
        }
    }

    fn label(&self, kind: &str, account_id: Option<&str>, installment: Option<&Installment>, recurring_id: Option<&str>, transaction_id: Option<&str>) -> String {
        let look = |m: &HashMap<&'a str, &'a str>, id: Option<&str>| id.filter(|id| !id.is_empty()).and_then(|id| m.get(id).copied());
        obligation_label(kind, look(&self.accounts, account_id), installment, look(&self.recurring, recurring_id), look(&self.descriptions, transaction_id))
    }
}

/// Boş ad JS'teki `||` gibi "yok" sayılır
fn given(s: Option<&str>) -> Option<&str> {
    s.filter(|s| !s.is_empty())
}

/// Ödeme / ödendi satırının adı
pub fn obligation_label(kind: &str, account_name: Option<&str>, installment: Option<&Installment>, recurring_name: Option<&str>, tx_description: Option<&str>) -> String {
    let account = given(account_name).unwrap_or("Silinmiş hesap");
    match kind {
        "card" => format!("{account} ekstresi"),
        "loan" => match installment {
            Some(i) => format!("{account} · {}/{}. taksit", i.index, i.count),
            None => account.to_string(),
        },
        "recurring" => given(recurring_name).unwrap_or("Düzenli gider").to_string(),
        _ => given(tx_description).unwrap_or("Planlı gider").to_string(),
    }
}

/// Tarihe, aynı tarihte ada göre (kararlı: eşitler geldiği sırada kalır)
pub fn sort_by_date_label(xs: &mut [Obligation]) {
    xs.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| cmp_tr(&a.label, &b.label)));
}

/// Adları yazar, tarihe ve ada göre sıralar
pub fn label_obligations(xs: &mut [Obligation], names: &PlanNames) {
    for o in xs.iter_mut() {
        o.label = names.label(o.kind, o.account_id.as_deref(), o.installment.as_ref(), o.recurring_id.as_deref(), o.transaction_id.as_deref());
    }
    sort_by_date_label(xs);
}

/// Ödendi satırları: adları yazar, tarihe ve ada göre sıralar
pub fn label_paid(xs: &mut [PaidRow], names: &PlanNames) {
    for p in xs.iter_mut() {
        p.label = names.label(p.kind, p.account_id.as_deref(), p.installment.as_ref(), p.recurring_id.as_deref(), p.transaction_id.as_deref());
    }
    xs.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| cmp_tr(&a.label, &b.label)));
}
