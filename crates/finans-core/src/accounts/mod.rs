//! Hesap özetleri: kart ekstreleri ve borcu, kredi ödeme planı, banka/nakit ve döviz bakiyeleri.
//! Arayüzdeki `cards.ts`, `loans.ts`, `accounts.ts` kurallarının aynısı; net servet ve hedefler de bu yardımcıları kullanır.

pub mod bank;
pub mod cards;
pub mod loans;

use std::collections::HashMap;

use serde::Serialize;

use crate::analysis::norm;
use crate::db::{Account, Category, Transaction};
use crate::fx;
use crate::fx::time::days_between;
use crate::pnl::CurrentRate;
use crate::CoreResult;

pub use bank::{BankSummary, FxSummary};
pub use cards::{AmountHint, CardReport, Statement};
pub use loans::{LoanRow, LoanSummary};

pub struct AccountsInput<'a> {
    pub accounts: &'a [Account],
    pub transactions: &'a [Transaction],
    /// Kredi taksit ödemesinin faiz kategorisi için
    pub categories: &'a [Category],
    /// Kod → güncel alış kuru (pnl::current_rates)
    pub rates: &'a HashMap<String, CurrentRate>,
    /// "YYYY-MM-DD"
    pub today: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountReport {
    pub account_id: String,
    /// "bank" | "cash" | "fx" | "card" | "loan"
    pub kind: String,
    pub bank: Option<BankSummary>,
    pub fx: Option<FxSummary>,
    pub card: Option<CardReport>,
    pub loan: Option<LoanSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsReport {
    pub accounts: Vec<AccountReport>,
    /// Kredi taksit ödemesinde faizin yazılacağı "Faiz ve Masraflar" gider kategorisi (yoksa None)
    pub fee_category_id: Option<String>,
}

/// "Faiz ve Masraflar" gider kategorisi: Türkçe harf ve büyük/küçük harf duyarsız ilk eşleşme (liste sırasıyla)
pub fn fee_category_id(categories: &[Category]) -> Option<String> {
    let want = norm("Faiz ve Masraflar");
    categories.iter().find(|c| c.kind == "expense" && norm(&c.name) == want).map(|c| c.id.clone())
}

pub fn report(input: &AccountsInput) -> CoreResult<AccountsReport> {
    let mut out = Vec::with_capacity(input.accounts.len());
    for a in input.accounts {
        if a.currency != fx::TRY && fx::source_of(&a.currency).is_none() {
            return Err(format!("Bilinmeyen para birimi: {}", a.currency));
        }
        let mut r = AccountReport { account_id: a.id.clone(), kind: a.kind.clone(), bank: None, fx: None, card: None, loan: None };
        match a.kind.as_str() {
            "credit_card" => {
                r.kind = "card".into();
                r.card = Some(cards::card_report(a, input.transactions, input.today));
            }
            "loan" => {
                let mut l = loans::loan_summary(a, input.transactions);
                l.next_due_in_days = l.next.as_ref().map(|n| days_between(input.today, &n.date));
                r.loan = Some(l);
            }
            _ if a.currency != fx::TRY => {
                r.kind = "fx".into();
                let unit = fx::unit_or_try(Some(&a.currency));
                let rate = input.rates.get(&a.currency).map(|q| q.buy);
                r.fx = Some(bank::fx_summary(a, unit, input.transactions, rate, input.today));
            }
            _ => r.bank = Some(bank::bank_summary(a, input.transactions, input.today)),
        }
        out.push(r);
    }
    Ok(AccountsReport { accounts: out, fee_category_id: fee_category_id(input.categories) })
}
