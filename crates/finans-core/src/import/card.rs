//! Ekstre özetiyle kart ayarlarının karşılaştırılması (TS diyalogdaki `cardFix`, `beforeTracking`)

use serde::{Deserialize, Serialize};

use super::StatementSummary;
use crate::accounts::cards::first_tracked_closing;
use crate::db::Account;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardPatch {
    pub statement_day: Option<i64>,
    pub due_day: Option<i64>,
    pub credit_limit: Option<f64>,
    pub interest_rate: Option<f64>,
    pub min_payment_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFix {
    pub patch: CardPatch,
    /// Farklı alanlar (TS anahtar adlarıyla, sırayla)
    pub differs: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementCard {
    pub card_fix: Option<CardFix>,
    /// Ekstre kartın takip başlangıcından önce mi
    pub before_tracking: bool,
}

/// Kart farkı önizlemesi: kartın şimdiki ayarları da gelir ama yalnız yenileme anahtarıdır (kart veritabanından okunur)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDraft {
    pub account_id: String,
    #[serde(default)]
    pub summary: Option<StatementSummary>,
}

/// Hesap bulunamazsa fark yok
pub fn card_for(d: &CardDraft, accounts: &[Account]) -> StatementCard {
    match accounts.iter().find(|a| a.id == d.account_id) {
        Some(a) => statement_card(a, d.summary.as_ref()),
        None => StatementCard { card_fix: None, before_tracking: false },
    }
}

pub fn statement_card(account: &Account, summary: Option<&StatementSummary>) -> StatementCard {
    let card = account.kind == "credit_card";
    let card_fix = summary.filter(|_| card).and_then(|s| {
        let day = |iso: &Option<String>| iso.as_deref().and_then(|d| d.get(8..10)).and_then(|x| x.parse::<i64>().ok());
        let patch = CardPatch {
            statement_day: day(&s.closing_date).or(account.statement_day),
            due_day: day(&s.due_date).or(account.due_day),
            credit_limit: s.credit_limit.or(account.credit_limit),
            interest_rate: s.interest_rate.or(account.interest_rate),
            min_payment_rate: s.min_payment_rate.or(account.min_payment_rate),
        };
        let mut differs = Vec::new();
        if patch.statement_day != account.statement_day {
            differs.push("statementDay");
        }
        if patch.due_day != account.due_day {
            differs.push("dueDay");
        }
        if patch.credit_limit != account.credit_limit {
            differs.push("creditLimit");
        }
        if patch.interest_rate != account.interest_rate {
            differs.push("interestRate");
        }
        if patch.min_payment_rate != account.min_payment_rate {
            differs.push("minPaymentRate");
        }
        (!differs.is_empty()).then_some(CardFix { patch, differs })
    });
    let before_tracking = card && summary.and_then(|s| s.closing_date.as_deref()).is_some_and(|c| !c.is_empty() && c < first_tracked_closing(account).as_str());
    StatementCard { card_fix, before_tracking }
}
