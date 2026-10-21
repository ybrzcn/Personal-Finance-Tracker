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

fn find(t: &str, labels: &[&str], value: &str) -> Option<String> {
    labels.iter().find_map(|l| js_re(&format!(r"{l}\s*:?\s*{value}")).captures(t).ok().flatten().map(|m| m[1].to_string()))
}

pub fn statement_summary(text: &str) -> StatementSummary {
    let t = TABS.replace_all(&norm(text), " ").into_owned();
    let date = |labels: &[&str]| find(&t, labels, DATE).and_then(|v| parse_date(&v));
    let amount = |labels: &[&str]| find(&t, labels, AMT).and_then(|v| parse_amount(&v));
    let pct = |labels: &[&str]| find(&t, labels, PCT).map(|v| v.replace(',', ".").parse::<f64>().unwrap_or(f64::NAN));
    StatementSummary {
        closing_date: date(&["hesap kesim tarihi", "ekstre kesim tarihi", "kesim tarihi"]),
        due_date: date(&["son odeme tarihi"]),
        period_debt: amount(&["donem borcu", "ekstre borcu", "toplam borc"]),
        period_spending: amount(&["donem ici harcamalar", "donem ici harcama"]),
        min_payment_rate: MIN_RATE.captures(&t).ok().flatten().map(|m| m[1].parse::<f64>().unwrap_or(f64::NAN)),
        credit_limit: amount(&["kart limiti", "kredi karti limiti"]),
        interest_rate: pct(&["akdi faiz orani", "alisveris faiz orani"]),
    }
}
