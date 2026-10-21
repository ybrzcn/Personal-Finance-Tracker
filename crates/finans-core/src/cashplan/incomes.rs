//! Ödeme takviminin gelir olayları: arayüzdeki `plan.ts` `incomeEvents` ve `withFutureIncomes` kurallarının aynısı.

use std::collections::HashSet;

use serde::Serialize;

use super::obligations::occurrences_between;
use crate::accounts::cards::js_cents;
use crate::budget::income::assign_regular;
use crate::budget::recurring::{amount_for_occurrence, cover_date, exception_for, has_started, month_of, scheduled_month};
use crate::db::{RecurringItem, Transaction};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeEvent {
    pub key: String,
    /// Düzenli gelir kaydı; tek seferlik gelirde None
    pub recurring_id: Option<String>,
    /// Tek seferlik gelirin işlemi
    pub transaction_id: Option<String>,
    pub date: String,
    pub amount_cents: i64,
    pub account_id: Option<String>,
    /// Karşılık gelinen aya özel istisnanın notu (boşsa None)
    pub exception_note: Option<String>,
    /// İşlemler'e girilmiş tutarla değiştirildi ("girilen tutar")
    pub entered: bool,
    /// O ay yatmayacak (tutar 0)
    pub skipped: bool,
    /// Karşılık gelinen ay için tutarı 0 olan istisna var ("yatmayacak" işaretli; geri alınabilir)
    pub skip_exception: bool,
    pub one_time: bool,
    pub cover_month: String,
    /// Tek seferlik gelirde bütçe ayı elle seçildi
    pub fixed_month: bool,
    /// Girilmiş ve tarihi bugün/geçmiş: tutarı bugünkü nakitte
    pub recorded: bool,
}

impl IncomeEvent {
    /// TS `isUpcomingIncome`: bugünkü nakde henüz girmemiş gelir
    pub fn is_upcoming(&self, today: &str) -> bool {
        !self.skipped && if self.recorded { self.date.as_str() > today } else { self.date.as_str() >= today }
    }
}

/// Aktif düzenli gelirlerin [from, until] tekrarları (TS `incomeEvents`), tarihe göre
pub fn income_events(recurring: &[RecurringItem], from: &str, until: &str) -> Vec<IncomeEvent> {
    let mut out = Vec::new();
    for r in recurring.iter().filter(|r| r.active && r.kind == "income") {
        for date in occurrences_between(r, from, until) {
            if !has_started(r, &date) {
                continue;
            }
            let cover = month_of(&cover_date(r, &date)).to_string();
            let amount_cents = js_cents(amount_for_occurrence(r, &date));
            out.push(IncomeEvent {
                key: format!("inc:{}:{}", r.id, date),
                recurring_id: Some(r.id.clone()),
                transaction_id: None,
                account_id: r.account_id.clone(),
                exception_note: exception_for(r, &cover).map(|e| e.note.clone()).filter(|n| !n.is_empty()),
                entered: false,
                skipped: amount_cents == 0,
                skip_exception: exception_for(r, &cover).is_some_and(|e| e.amount == 0.0),
                one_time: false,
                cover_month: cover,
                fixed_month: false,
                recorded: false,
                amount_cents,
                date,
            });
        }
    }
    out.sort_by(|a, b| a.date.cmp(&b.date));
    out
}

/// İşlemler'e girilmiş gelirleri ekler (TS `withFutureIncomes`): düzenli gelire karşılık gelenler o ayın planının
/// yerine geçer; diğer ileri tarihli gelirler tek seferlik olay olur
pub fn with_future_incomes(events: Vec<IncomeEvent>, txs: &[Transaction], recurring: &[RecurringItem], today: &str, until: &str) -> Vec<IncomeEvent> {
    let month_start = format!("{}-01", month_of(today));
    let candidates: Vec<&Transaction> = txs.iter().filter(|t| t.kind == "income" && t.date >= month_start && t.date.as_str() <= until).collect();
    let regular: Vec<&RecurringItem> = recurring.iter().filter(|r| r.kind == "income" && r.active).collect();
    let assigned = assign_regular(&candidates, &regular);
    let mut used: HashSet<String> = HashSet::new();
    let mut out: Vec<IncomeEvent> = events
        .into_iter()
        .map(|e| {
            if e.date.as_str() < today {
                return e;
            }
            let Some(item) = e.recurring_id.as_deref().and_then(|id| regular.iter().copied().find(|r| r.id == id)) else { return e };
            // Aynı ayın maaşı: hafta sonu kuralıyla komşu aya kaymış yatış da asıl ayıyla karşılaştırılır
            let month = scheduled_month(item, &e.date);
            let matched: Vec<&Transaction> =
                candidates.iter().copied().filter(|t| assigned.get(&t.id) == Some(&item.id) && scheduled_month(item, &t.date) == month).collect();
            if matched.is_empty() {
                return e;
            }
            for t in &matched {
                used.insert(t.id.clone());
            }
            let amount_cents: i64 = matched.iter().map(|t| js_cents(t.amount)).sum();
            IncomeEvent {
                date: matched[0].date.clone(),
                amount_cents,
                entered: true,
                skipped: amount_cents == 0,
                recorded: matched.iter().all(|t| t.date.as_str() <= today),
                ..e
            }
        })
        .collect();
    for t in txs.iter().filter(|t| t.kind == "income" && t.date.as_str() > today && t.date.as_str() <= until) {
        if used.contains(&t.id) {
            continue;
        }
        out.push(IncomeEvent {
            key: format!("tx:{}", t.id),
            recurring_id: None,
            transaction_id: Some(t.id.clone()),
            date: t.date.clone(),
            amount_cents: js_cents(t.amount),
            account_id: Some(t.account_id.clone()),
            exception_note: None,
            entered: false,
            skipped: false,
            skip_exception: false,
            one_time: true,
            cover_month: t.budget_month.clone().unwrap_or_else(|| month_of(&t.date).to_string()),
            fixed_month: t.budget_month.as_deref().is_some_and(|m| !m.is_empty()),
            recorded: false,
        });
    }
    out.sort_by(|a, b| a.date.cmp(&b.date));
    out
}
