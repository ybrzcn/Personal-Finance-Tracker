//! Analiz sayfası: abonelik tespiti ve değişken gider tahmini (TS `analysis.ts`)

pub mod forecast;
pub mod subscriptions;

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::accounts::cards::js_round;
use crate::db::{Budget, Category, Transaction};
use crate::overview::breakdown::js_space;

pub use self::forecast::{ForecastItem, ForecastReport, MonthTotal};
pub use self::subscriptions::{SubscriptionRow, SubscriptionsReport};

pub struct AnalysisInput<'a> {
    pub transactions: &'a [Transaction],
    pub categories: &'a [Category],
    pub budgets: &'a [Budget],
    pub settings: &'a Map<String, Value>,
    /// YYYY-MM-DD
    pub today: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisReport {
    pub subscriptions: SubscriptionsReport,
    pub forecast: ForecastReport,
    /// Kafe kategorisine taşınması önerilen harcamalar (yoksa null)
    pub cafe_suggestion: Option<crate::rules::CafeSuggestion>,
}

/// Kullanıcının abonelik düzeltmesi; tipi ya da değeri yanlış alanlar yok sayılır
#[derive(Debug, Clone, Default)]
pub struct Override {
    pub name: Option<String>,
    pub period: Option<&'static str>,
    pub cancelled: bool,
}

pub fn analysis(input: &AnalysisInput) -> AnalysisReport {
    let overrides = read_overrides(input.settings);
    let selected = input.settings.get("forecastCategoryIds").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>());
    let ids = forecast::selected_ids(input.categories, selected.as_deref());
    AnalysisReport {
        subscriptions: subscriptions::detect(input.transactions, input.categories, &overrides, input.today),
        forecast: forecast::forecast(input.transactions, ids, input.budgets, input.today),
        cafe_suggestion: crate::rules::cafe_suggestion(input.transactions, input.categories),
    }
}

fn read_overrides(s: &Map<String, Value>) -> HashMap<String, Override> {
    let Some(m) = s.get("subscriptionOverrides").and_then(Value::as_object) else {
        return HashMap::new();
    };
    m.iter()
        .filter_map(|(k, v)| {
            let o = v.as_object()?;
            let name = o.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_string);
            let period = match o.get("period").and_then(Value::as_str) {
                Some("monthly") => Some("monthly"),
                Some("yearly") => Some("yearly"),
                _ => None,
            };
            let cancelled = o.get("cancelled").and_then(Value::as_bool) == Some(true);
            Some((k.clone(), Override { name, period, cancelled }))
        })
        .collect()
}

/// TS `csv.ts` `norm`: kırp, Türkçe küçük harf, Türkçe harfleri ASCII'ye indir
pub fn norm(s: &str) -> String {
    lower_tr(s.trim_matches(js_space)).chars().map(|c| match c {
        'ı' => 'i',
        'ş' => 's',
        'ç' => 'c',
        'ğ' => 'g',
        'ü' => 'u',
        'ö' => 'o',
        _ => c,
    }).collect()
}

/// TS `toLocaleLowerCase("tr")`
pub(crate) fn lower_tr(s: &str) -> String {
    s.replace('İ', "i").replace('I', "ı").to_lowercase()
}

/// TS `round2`: TL'yi kuruşa yuvarlar (kayan nokta)
pub(crate) fn round2(v: f64) -> f64 {
    js_round(v * 100.0) as f64 / 100.0
}

pub(crate) fn cents(v: f64) -> i64 {
    js_round(v * 100.0)
}
