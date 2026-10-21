//! Seçili satırların toplamı ve özetteki dönem içi harcamayla uyumu (TS diyalogdaki `totals`)

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct TotalsRow {
    pub amount: f64,
    #[serde(rename = "type")]
    pub kind: String,
}

/// TL (TS'deki gibi kayan noktayla toplanır; gösterimi birebir aynı kalsın)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementTotals {
    pub expense: f64,
    pub income: f64,
    /// Gider − gelir
    pub net: f64,
    /// |gider − gelir − dönem içi harcama|; özette yoksa null
    pub difference: Option<f64>,
    pub matches_summary: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TotalsDraft {
    pub rows: Vec<TotalsRow>,
    #[serde(default)]
    pub period_spending: Option<f64>,
}

pub fn statement_totals(rows: &[TotalsRow], period_spending: Option<f64>) -> StatementTotals {
    let (mut out, mut inc) = (0.0, 0.0);
    for r in rows {
        if r.kind == "expense" {
            out += r.amount;
        } else if r.kind == "income" {
            inc += r.amount;
        }
    }
    let difference = period_spending.map(|p| (out - inc - p).abs());
    StatementTotals { expense: out, income: inc, net: out - inc, difference, matches_summary: difference.map(|d| d < 0.01) }
}
