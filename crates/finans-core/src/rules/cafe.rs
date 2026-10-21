//! Analiz'deki "Kafe'ye taşı" önerisi: Kafe kategorisi varken Restoran'da ya da kategorisiz kalmış kahve harcamaları

use serde::Serialize;

use super::suggest::matches_category_rule;
use crate::analysis::norm;
use crate::db::{Category, Transaction};
use crate::overview::breakdown::js_space;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CafeSuggestion {
    pub category_id: String,
    pub transaction_ids: Vec<String>,
    /// Açıklamanın ilk kelimesi, tekrarsız ilk üçü
    pub merchants: Vec<String>,
}

pub fn cafe_suggestion(txs: &[Transaction], categories: &[Category]) -> Option<CafeSuggestion> {
    let find = |n: &str| categories.iter().find(|c| c.kind == "expense" && norm(&c.name) == n);
    let cafe = find("kafe")?;
    let restaurant = find("restoran").map(|c| c.id.as_str());
    let candidates: Vec<&Transaction> = txs
        .iter()
        .filter(|t| {
            t.kind == "expense"
                && (t.category_id.is_none() || t.category_id.as_deref() == restaurant)
                && matches_category_rule(&t.description, "Kafe")
        })
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let mut merchants: Vec<String> = Vec::new();
    for t in &candidates {
        let first = t.description.split(js_space).next().unwrap_or("").to_string();
        if !merchants.contains(&first) {
            merchants.push(first);
        }
    }
    merchants.truncate(3);
    Some(CafeSuggestion { category_id: cafe.id.clone(), transaction_ids: candidates.iter().map(|t| t.id.clone()).collect(), merchants })
}
