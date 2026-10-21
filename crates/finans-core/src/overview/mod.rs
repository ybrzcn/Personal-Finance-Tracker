//! Genel Bakış (TS Dashboard `stats`/`report`/`monthly`) ve Kategoriler kullanımı (TS Categories `usage`)

pub mod breakdown;
pub mod income;
pub mod period;

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use self::breakdown::{by_account, by_category, spread, top_merchants, AccountSlice, CategorySlice, MerchantRow, Part};
use self::income::{cash_income_for_month, planned_regular_income_in_range};
pub use self::period::Period;
use self::period::{month_end, previous, range};
use crate::accounts::cards::{js_cents, js_round};
use crate::budget::recurring::{month_of, shift_month};
use crate::db::{Account, Category, RecurringItem, Transaction};

/// Satıcı listesindeki en fazla satır
const MERCHANTS: usize = 30;
/// Aylık tablonun ay sayısı (bu ay dahil)
const MONTHS: i64 = 6;

pub struct OverviewInput<'a> {
    pub accounts: &'a [Account],
    pub categories: &'a [Category],
    pub transactions: &'a [Transaction],
    pub recurring: &'a [RecurringItem],
    pub today: &'a str,
    pub period: Period,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    /// Plan maaşı dahil
    pub income_cents: i64,
    pub expense_cents: i64,
    /// Plan maaşı dahil
    pub net_cents: i64,
    /// İşlem olarak girilmemiş düzenli gelirlerin plan tutarı
    pub planned_cents: i64,
    /// Dönemdeki gerçek işlemler (taksit parçaları değil, her tür)
    pub count: i64,
    pub savings_rate_pct: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthRow {
    pub month: String,
    pub income_cents: i64,
    pub expense_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewReport {
    pub period: &'static str,
    pub from: Option<String>,
    pub to: Option<String>,
    pub totals: Totals,
    pub categories: Vec<CategorySlice>,
    pub previous: Option<Vec<CategorySlice>>,
    pub accounts: Vec<AccountSlice>,
    pub merchants: Vec<MerchantRow>,
    pub monthly: Vec<MonthRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryUsage {
    pub category_id: String,
    pub count: i64,
    pub total_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryUsageReport {
    pub categories: Vec<CategoryUsage>,
}

pub fn overview(input: &OverviewInput) -> OverviewReport {
    let (txs, rec, today) = (input.transactions, input.recurring, input.today);
    // Takip başlangıcı: en eski hesap açılışı veya işlem; öncesine plan maaşı yazılmaz
    let tracking_start: Option<&str> =
        input.accounts.iter().map(|a| a.opening_date.as_str()).chain(txs.iter().map(|t| t.date.as_str())).filter(|d| !d.is_empty()).min();
    // İstatistiklerde taksitli harcamalar aylara bölünür
    let parts = spread(txs);
    let r = range(input.period, today);
    let in_period: Vec<Part> = parts.iter().filter(|p| r.contains(&p.date)).cloned().collect();

    let (mut inc, mut exp) = (0i64, 0i64);
    for p in &in_period {
        let c = js_round(p.amount * 100.0);
        match p.tx.kind.as_str() {
            "income" => inc += c,
            "expense" => exp += c,
            _ => {}
        }
    }
    // Maaş gibi düzenli gelirler İşlemler'e girilmese de plan tutarıyla sayılır (ayın sonuna kadar)
    let end = month_end(today);
    let from = match &r.from {
        Some(f) => f.clone(),
        None => txs
            .iter()
            .map(|t| t.date.clone())
            .chain(rec.iter().map(|x| x.start_date.clone().unwrap_or_else(|| end.clone())))
            .min()
            .unwrap_or_else(|| end.clone()),
    };
    let to = match &r.to {
        Some(t) if *t < end => t.clone(),
        _ => end.clone(),
    };
    let planned = if from <= to { planned_regular_income_in_range(txs, rec, &from, &to, tracking_start) } else { 0 };
    // Adet olarak gerçek işlemler sayılır (taksit parçaları değil)
    let count = txs.iter().filter(|t| r.contains(&t.date)).count() as i64;
    // Oran TS'deki TL değerlerle hesaplanır (kayan nokta adımları aynı)
    let income_tl = inc as f64 / 100.0 + planned as f64 / 100.0;
    let net_tl = (inc - exp) as f64 / 100.0 + planned as f64 / 100.0;
    let savings_rate_pct = (income_tl > 0.0).then(|| js_round(net_tl / income_tl * 100.0));

    let existing: HashSet<&str> = input.categories.iter().map(|c| c.id.as_str()).collect();
    let previous = previous(input.period, today).map(|pr| {
        let before: Vec<Part> = parts.iter().filter(|p| pr.contains(&p.date)).cloned().collect();
        by_category(&before, &existing)
    });

    // Gelir: düzenli gelirler yatış tarihlerine göre (girilmediyse plan) ve diğer gelir işlemleri; gider: bölünmüş giderler
    let this_month = month_of(today);
    let mut monthly: Vec<MonthRow> = (0..MONTHS)
        .rev()
        .map(|i| {
            let month = shift_month(this_month, -i);
            let expense = parts.iter().filter(|p| p.tx.kind == "expense" && month_of(&p.date) == month).fold(0.0, |s, p| s + p.amount);
            MonthRow { income_cents: cash_income_for_month(txs, rec, &month, tracking_start), expense_cents: js_round(expense * 100.0), month }
        })
        .collect();
    // Takip başlamadan önceki boş aylar gösterilmez
    let monthly = match monthly.iter().position(|m| m.income_cents > 0 || m.expense_cents > 0) {
        Some(i) => monthly.split_off(i),
        None => Vec::new(),
    };

    OverviewReport {
        period: input.period.key(),
        from: r.from.clone(),
        to: r.to.clone(),
        totals: Totals { income_cents: inc + planned, expense_cents: exp, net_cents: inc - exp + planned, planned_cents: planned, count, savings_rate_pct },
        categories: by_category(&in_period, &existing),
        previous,
        accounts: by_account(&in_period),
        merchants: top_merchants(&in_period, MERCHANTS),
        monthly,
    }
}

/// Kategori başına işlem sayısı ve tutar toplamı (her tür; kategorisi olanlar)
pub fn category_usage(txs: &[Transaction]) -> CategoryUsageReport {
    let mut categories: Vec<CategoryUsage> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for t in txs {
        let Some(id) = t.category_id.as_deref().filter(|s| !s.is_empty()) else { continue };
        let i = *index.entry(id.to_string()).or_insert_with(|| {
            categories.push(CategoryUsage { category_id: id.to_string(), count: 0, total_cents: 0 });
            categories.len() - 1
        });
        categories[i].count += 1;
        categories[i].total_cents += js_cents(t.amount);
    }
    CategoryUsageReport { categories }
}
