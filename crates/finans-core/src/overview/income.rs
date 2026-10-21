//! Genel Bakış gelirleri (TS `cashIncomeForMonth`, `plannedRegularIncomeInRange`)

use crate::accounts::cards::js_round;
use crate::budget::income::{active_incomes, assign_regular};
use crate::budget::recurring::{amount_for_occurrence, has_started, month_of, occurrence_in, shift_month};
use crate::db::{RecurringItem, Transaction};

fn month_income_txs<'a>(txs: &'a [Transaction], month: &str) -> Vec<&'a Transaction> {
    txs.iter().filter(|t| t.kind == "income" && month_of(&t.date) == month).collect()
}

/// Ayın nakit geliri (o ay hesaba giren): düzenli gelirler o aydaki yatış tarihiyle (yattıysa yatan, yatmadıysa plan;
/// başlangıç, zam ve istisnalar dahil) + düzenli gelirle eşleşmeyen gelir işlemleri. `since` öncesine plan yazılmaz.
pub fn cash_income_for_month(txs: &[Transaction], recurring: &[RecurringItem], month: &str, since: Option<&str>) -> i64 {
    let month_txs = month_income_txs(txs, month);
    let items = active_incomes(recurring);
    let assigned = assign_regular(&month_txs, &items);
    let mut cents = 0;
    for item in &items {
        let date = occurrence_in(item, month);
        let received: i64 = month_txs.iter().filter(|t| assigned.get(&t.id).is_some_and(|id| *id == item.id)).map(|t| js_round(t.amount * 100.0)).sum();
        if received > 0 {
            cents += received;
        } else if has_started(item, &date) && since.is_none_or(|s| date.as_str() >= s) {
            cents += js_round(amount_for_occurrence(item, &date) * 100.0);
        }
    }
    // Nakit akışı: düzensiz gelirler bütçe ayına değil, hesaba girdiği tarihe göre sayılır
    for t in &month_txs {
        if !assigned.contains_key(&t.id) {
            cents += js_round(t.amount * 100.0);
        }
    }
    cents
}

/// [from, to] aralığındaki düzenli gelir yatışları: o ayki karşılığı İşlemler'e girilmediyse plan tutarı
pub fn planned_regular_income_in_range(txs: &[Transaction], recurring: &[RecurringItem], from: &str, to: &str, since: Option<&str>) -> i64 {
    let from = match since {
        Some(s) if s > from => s,
        _ => from,
    };
    let items = active_incomes(recurring);
    let last = month_of(to).to_string();
    let mut month = month_of(from).to_string();
    let mut cents = 0;
    // YYYY-MM olmayan uç (bozuk tarih) döngüye sokmaz
    while month.len() == 7 && month <= last {
        let month_txs = month_income_txs(txs, &month);
        let assigned = assign_regular(&month_txs, &items);
        for item in &items {
            let date = occurrence_in(item, &month);
            if date.as_str() < from || date.as_str() > to || !has_started(item, &date) {
                continue;
            }
            if month_txs.iter().any(|t| assigned.get(&t.id).is_some_and(|id| *id == item.id)) {
                continue;
            }
            cents += js_round(amount_for_occurrence(item, &date) * 100.0);
        }
        month = shift_month(&month, 1);
    }
    cents
}
