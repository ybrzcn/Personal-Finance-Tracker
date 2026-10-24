//! Ekstre özeti (TS `extractStatementSummary`): kesim/son ödeme tarihi, dönem borcu, limit, faiz

use std::sync::LazyLock;

use fancy_regex::Regex;
use serde::Serialize;

use super::{js_re, parse_amount, parse_date};
use crate::analysis::norm;

#[derive(Debug, Clone, Default, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatementSummary {
    pub closing_date: Option<String>,
    pub due_date: Option<String>,
    /// Dönem borcu (ödenmesi gereken toplam)
    pub period_debt: Option<f64>,
    /// Dönem içi harcamalar
    pub period_spending: Option<f64>,
    pub min_payment_rate: Option<f64>,
    pub credit_limit: Option<f64>,
    pub interest_rate: Option<f64>,
}

impl StatementSummary {
    pub fn is_empty(&self) -> bool {
        *self == StatementSummary::default()
    }
}

const DATE: &str = r"(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2} [a-z]+ \d{4})";
const AMT: &str = r"([\d.]+,\d{2})";
const PCT: &str = r"%?\s*(\d+(?:,\d+)?)";
static TABS: LazyLock<Regex> = LazyLock::new(|| js_re(r"[ \t]+"));
static MIN_RATE: LazyLock<Regex> = LazyLock::new(|| js_re(r"asgari[^\n]*?/\s*%?\s*(\d{1,2})\s*%?"));
/// Özet denklemi (Garanti BBVA/Bonus): önceki bakiye + dönem harcamaları + faiz ve ücretler − ödemeler = dönem borcu
static EQUATION: LazyLock<Regex> = LazyLock::new(|| {
    js_re(r"([\d.]+,\d{2}) tl \+ ([\d.]+,\d{2}) tl \+ ([\d.]+,\d{2}) tl - ([\d.]+,\d{2}) tl = ([\d.]+,\d{2}) tl")
});

fn find(t: &str, labels: &[&str], value: &str) -> Option<String> {
    labels.iter().find_map(|l| js_re(&format!(r"{l}\s*:?\s*{value}")).captures(t).ok().flatten().map(|m| m[1].to_string()))
}

pub fn statement_summary(text: &str) -> StatementSummary {
    let t = TABS.replace_all(&norm(text), " ").into_owned();
    let date = |labels: &[&str]| find(&t, labels, DATE).and_then(|v| parse_date(&v));
    let amount = |labels: &[&str]| find(&t, labels, AMT).and_then(|v| parse_amount(&v));
    let pct = |labels: &[&str]| find(&t, labels, PCT).map(|v| v.replace(',', ".").parse::<f64>().unwrap_or(f64::NAN));
    let equation = EQUATION.captures(&t).ok().flatten();
    let term = |i: usize| equation.as_ref().and_then(|m| parse_amount(&m[i]));
    let period_debt = amount(&["donem borcu", "donem borcunuz", "ekstre borcu", "toplam borc"]).or_else(|| term(5));
    // Oran yazmayan ekstrede asgari tutarın dönem borcuna oranı (tam yüzde çıkıyorsa)
    let min_rate_from_amount = || {
        let min = amount(&["min. odeme tutari", "minimum odeme tutari", "asgari odeme tutari"])?;
        let rate = min / period_debt.filter(|d| *d > 0.0)? * 100.0;
        ((rate - rate.round()).abs() < 0.1 && (1.0..=100.0).contains(&rate.round())).then(|| rate.round())
    };
    StatementSummary {
        closing_date: date(&["hesap kesim tarihi", "ekstre kesim tarihi", "kesim tarihi"]),
        due_date: date(&["son odeme tarihi"]),
        period_debt,
        period_spending: amount(&["donem ici harcamalar", "donem ici harcama"]).or_else(|| term(2)),
        min_payment_rate: MIN_RATE.captures(&t).ok().flatten().map(|m| m[1].parse::<f64>().unwrap_or(f64::NAN)).or_else(min_rate_from_amount),
        credit_limit: amount(&["kart limiti", "kredi karti limiti"]),
        interest_rate: pct(&["akdi faiz orani", "alisveris faiz orani", "akdi faiz"]),
    }
}
