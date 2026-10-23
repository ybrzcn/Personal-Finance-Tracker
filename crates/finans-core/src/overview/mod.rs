//! Genel Bakış (TS Dashboard `stats`/`report`/`monthly`) ve Kategoriler kullanımı (TS Categories `usage`)

pub mod breakdown;
pub mod income;
pub mod period;

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use self::breakdown::{by_account, by_category, spread, top_merchants, AccountSlice, CategorySlice, MerchantRow, Part};
use self::income::planned_regular_income_in_range;
pub use self::period::Period;
use self::period::{month_end, previous, range};
use crate::accounts::cards::{js_cents, js_round};
use crate::budget::income::income_budget_dates;
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
    // İstatistiklerde taksitli harcamalar aylara bölünür; gelir Bütçe ve Raporlar'daki gibi bütçe ayında (10 Ekim'de yatan
    // Eylül maaşı Eylül'de)
    let moved = income_budget_dates(txs, rec, today);
    let parts: Vec<Part> = spread(txs)
        .into_iter()
        .map(|mut p| {
            if let Some(d) = moved.get(p.tx.id.as_str()) {
                p.date = d.clone();
            }
            p
        })
        .collect();
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
    // Maaş gibi düzenli gelirler İşlemler'e girilmese de plan tutarıyla sayılır: yalnız bu ayın başından ay sonuna kadar
    // (geçmiş ayda girilmemiş maaş yatmış varsayılmaz)
    let end = month_end(today);
    let this_month = month_of(today);
    let month_start = format!("{this_month}-01");
    let from = match &r.from {
        Some(f) => f.clone(),
        None => txs
            .iter()
            .map(|t| t.date.clone())
            .chain(rec.iter().map(|x| x.start_date.clone().unwrap_or_else(|| end.clone())))
            .min()
            .unwrap_or_else(|| end.clone()),
    };
    let from = from.max(month_start.clone());
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

    // Gelir: bütçe ayındaki gelir işlemleri, bu ay girilmemiş düzenli gelirin planı; gider: bölünmüş giderler
    let mut monthly: Vec<MonthRow> = (0..MONTHS)
        .rev()
        .map(|i| {
            let month = shift_month(this_month, -i);
            let sum = |kind: &str| parts.iter().filter(|p| p.tx.kind == kind && month_of(&p.date) == month).fold(0.0, |s, p| s + p.amount);
            let planned = if month == this_month { planned_regular_income_in_range(txs, rec, &month_start, &end, tracking_start) } else { 0 };
            MonthRow { income_cents: js_round(sum("income") * 100.0) + planned, expense_cents: js_round(sum("expense") * 100.0), month }
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
