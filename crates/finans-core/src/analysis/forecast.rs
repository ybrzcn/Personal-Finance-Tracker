//! Değişken gider tahmini (TS `forecastCategoryIds`, `completeMonths`, `forecastCategories`)

use std::collections::HashMap;

use serde::Serialize;

use super::{cents, norm, round2};
use crate::accounts::cards::js_round;
use crate::budget::recurring::shift_month;
use crate::db::{Budget, Category, Transaction};
use crate::overview::breakdown::{top_merchants, MerchantRow, Part};

pub const DEFAULT_CATEGORIES: [&str; 4] = ["Eğlence", "Restoran", "Kafe", "Market"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthTotal {
    /// YYYY-MM
    pub month: String,
    pub total_cents: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastItem {
    pub category_id: String,
    /// Tahmine giren tamamlanmış aylar (en fazla son 3)
    pub basis: Vec<MonthTotal>,
    /// Grafikte gösterilen tamamlanmış aylar (en fazla son 6)
    pub history: Vec<MonthTotal>,
    pub monthly_cents: i64,
    pub yearly_cents: i64,
    /// Tahmin bu ayın gidişatından mı (geçmiş ay yok)
    pub from_run_rate: bool,
    pub spent_this_month_cents: i64,
    pub count_this_month: i64,
    pub projected_month_end_cents: i64,
    pub avg_ticket_cents: Option<i64>,
    pub per_month_count: Option<f64>,
    pub top_merchants: Vec<MerchantRow>,
    pub budget_cents: Option<i64>,
    pub over_budget: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastReport {
    pub selected_category_ids: Vec<String>,
    /// Tamamlanmış ay sayısı (tahminin dayandığı veri)
    pub months_of_data: i64,
    pub items: Vec<ForecastItem>,
    pub monthly_cents: i64,
    pub yearly_cents: i64,
}

/// Tahmini gösterilecek kategoriler: kullanıcı seçimi (var olanlar) ya da varsayılan adlar
pub fn selected_ids(categories: &[Category], selected: Option<&[&str]>) -> Vec<String> {
    match selected {
        Some(ids) => ids.iter().filter(|id| categories.iter().any(|c| c.id == **id)).map(|id| id.to_string()).collect(),
        None => {
            let wanted: Vec<String> = DEFAULT_CATEGORIES.iter().map(|n| norm(n)).collect();
            categories.iter().filter(|c| c.kind == "expense" && wanted.contains(&norm(&c.name))).map(|c| c.id.clone()).collect()
        }
    }
}

/// Tamamlanmış aylar: takibin başladığı aydan (ilk gider ayın ilk haftasındaysa o ay da) geçen aya kadar
pub fn complete_months(txs: &[Transaction], today: &str) -> Vec<String> {
    let Some(first) = txs.iter().filter(|t| t.kind == "expense").map(|t| t.date.as_str()).min() else {
        return Vec::new();
    };
    let day: i64 = first.get(8..10).and_then(|d| d.parse().ok()).unwrap_or(0);
    let mut m = if day <= 7 { ym(first).to_string() } else { shift_month(ym(first), 1) };
    let current = ym(today);
    let mut out = Vec::new();
    while m.as_str() < current {
        out.push(m.clone());
        m = shift_month(&m, 1);
    }
    out
}

/// Tarihin ayı (YYYY-MM); kısa ya da bozuk tarihte JS `slice(0, 7)` gibi elde olan kısım (çökmez)
fn ym(date: &str) -> &str {
    date.get(..7).unwrap_or(date)
}

fn days_in_month(ym: &str) -> i64 {
    let y: i64 = ym.get(..4).and_then(|y| y.parse().ok()).unwrap_or(1970);
    let m: u32 = ym.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
    crate::accounts::cards::days_in_month(y, m) as i64
}

/// Seçili kategoriler için aylık/yıllık harcama tahmini (harcama tarihine göre)
pub fn forecast(txs: &[Transaction], ids: Vec<String>, budgets: &[Budget], today: &str) -> ForecastReport {
    let months = complete_months(txs, today);
    let basis_months = &months[months.len().saturating_sub(3)..];
    let history_months = &months[months.len().saturating_sub(6)..];
    let current = ym(today);
    let dim = days_in_month(current) as f64;
    let day: f64 = today.get(8..10).and_then(|d| d.parse::<i64>().ok()).unwrap_or(1) as f64;

    let mut items: Vec<(f64, ForecastItem)> = Vec::new();
    for id in &ids {
        let own: Vec<&Transaction> = txs.iter().filter(|t| t.kind == "expense" && t.category_id.as_deref() == Some(id.as_str())).collect();
        let mut by_month: HashMap<&str, (f64, i64)> = HashMap::new();
        for t in &own {
            let row = by_month.entry(ym(&t.date)).or_insert((0.0, 0));
            row.0 = round2(row.0 + t.amount);
            row.1 += 1;
        }
        let pick = |m: &str| by_month.get(m).copied().unwrap_or((0.0, 0));
        let to_row = |m: &String| {
            let (total, count) = pick(m);
            MonthTotal { month: m.clone(), total_cents: cents(total), count }
        };
        let basis: Vec<(f64, i64)> = basis_months.iter().map(|m| pick(m)).collect();
        let now = pick(current);

        let from_run_rate = basis.is_empty();
        let basis_total = basis.iter().fold(0.0, |s, b| s + b.0);
        let basis_count: i64 = basis.iter().map(|b| b.1).sum();
        let avg = if from_run_rate { (now.0 / day) * dim } else { basis_total / basis.len() as f64 };
        let projected = round2(if from_run_rate { avg } else { now.0 + (avg * (dim - day)) / dim });

        let recent: Vec<&str> = basis_months.iter().map(String::as_str).chain([current]).collect();
        let parts: Vec<Part> = own.iter().filter(|t| recent.contains(&ym(&t.date))).map(|t| Part { date: t.date.clone(), amount: t.amount, tx: t }).collect();
        let budget = budgets.iter().find(|b| b.category_id == *id).map(|b| b.amount);
        let monthly = round2(avg);
        items.push((monthly, ForecastItem {
            category_id: id.clone(),
            basis: basis_months.iter().map(to_row).collect(),
            history: history_months.iter().map(to_row).collect(),
            monthly_cents: cents(monthly),
            yearly_cents: cents(round2(avg * 12.0)),
            from_run_rate,
            spent_this_month_cents: cents(now.0),
            count_this_month: now.1,
            projected_month_end_cents: cents(projected),
            avg_ticket_cents: (basis_count > 0).then(|| cents(round2(basis_total / basis_count as f64))),
            per_month_count: (!basis.is_empty()).then(|| js_round(basis_count as f64 / basis.len() as f64 * 10.0) as f64 / 10.0),
            top_merchants: top_merchants(&parts, 3),
            budget_cents: budget.map(cents),
            over_budget: budget.is_some_and(|b| projected > b),
        }));
    }
    items.sort_by(|(a, _), (b, _)| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let monthly_total = round2(items.iter().fold(0.0, |s, (m, _)| s + m));
    ForecastReport {
        selected_category_ids: ids,
        months_of_data: basis_months.len() as i64,
        items: items.into_iter().map(|(_, i)| i).collect(),
        monthly_cents: cents(monthly_total),
        yearly_cents: cents(round2(monthly_total * 12.0)),
    }
}
