//! Devreden bütçe: devri açık kategoride her ayın artanı (limit aşıldıysa eksi olarak aşanı) sonraki aya geçer.

use std::collections::HashMap;

use super::expenses::BudgetExpense;
use super::recurring::shift_month;
use super::valid_month;
use crate::accounts::cards::js_cents;
use crate::db::Budget;

/// `month` ayına devreden tutar, kategori → kuruş. Yalnız devri bu ay ya da daha önce başlamış kategoriler (başladığı ay 0).
/// Geçmiş aylar bugünkü limitle hesaplanır (limit geçmişi tutulmaz).
pub fn carry_by_category(all: &[BudgetExpense], budgets: &[Budget], month: &str) -> HashMap<String, i64> {
    let active: Vec<(&Budget, &str)> = budgets
        .iter()
        .filter_map(|b| b.rollover_from.as_deref().filter(|f| valid_month(f) && *f <= month).map(|f| (b, f)))
        .collect();
    let mut spent: HashMap<(&str, &str), i64> = HashMap::new();
    for e in all {
        if let Some(cat) = e.t.category_id.as_deref() {
            if active.iter().any(|(b, f)| b.category_id == cat && e.month.as_str() >= *f && e.month.as_str() < month) {
                *spent.entry((cat, e.month.as_str())).or_default() += e.cents;
            }
        }
    }
    active
        .into_iter()
        .map(|(b, from)| {
            let limit = js_cents(b.amount);
            let (mut carry, mut m) = (0, from.to_string());
            while m.as_str() < month {
                carry += limit - spent.get(&(b.category_id.as_str(), m.as_str())).copied().unwrap_or(0);
                m = shift_month(&m, 1);
            }
            (b.category_id.clone(), carry)
        })
        .collect()
}
