//! Etiket raporu: etiket başına net harcama (gider − gelir; transfer yok), kategori kırılımı, aylık seyir ve bütçe durumu.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use crate::db::{Tag, Transaction};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryAmount {
    pub category_id: Option<String>,
    pub amount: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MonthAmount {
    /// YYYY-MM
    pub month: String,
    pub amount: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagStats {
    pub tag_id: String,
    /// TL; eksi = net gelir
    pub spent: f64,
    pub count: i64,
    pub first_date: Option<String>,
    pub last_date: Option<String>,
    pub by_category: Vec<CategoryAmount>,
    pub monthly: Vec<MonthAmount>,
    pub budget: Option<f64>,
    pub remaining: Option<f64>,
    pub percent: Option<f64>,
    /// ok | near | over
    pub budget_status: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TagsReport {
    pub tags: Vec<TagStats>,
}

fn cents(v: f64) -> i64 {
    (v * 100.0).round() as i64
}

fn money(c: i64) -> f64 {
    c as f64 / 100.0
}

/// `from`..=`to` arası aylar (YYYY-MM)
fn months(from: &str, to: &str) -> Vec<String> {
    let (mut y, mut m): (i32, u32) = (from[0..4].parse().unwrap_or(0), from[5..7].parse().unwrap_or(1));
    let (ty, tm): (i32, u32) = (to[0..4].parse().unwrap_or(0), to[5..7].parse().unwrap_or(1));
    let mut out = Vec::new();
    while (y, m) <= (ty, tm) {
        out.push(format!("{y:04}-{m:02}"));
        (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    }
    out
}

pub fn report(tags: &[Tag], transactions: &[Transaction]) -> TagsReport {
    // Etiket → işlemler (bir kez)
    let mut by_tag: HashMap<&str, Vec<&Transaction>> = HashMap::new();
    for t in transactions {
        let mut seen: Vec<&str> = Vec::new();
        for id in &t.tag_ids {
            if !seen.contains(&id.as_str()) {
                seen.push(id);
                by_tag.entry(id.as_str()).or_default().push(t);
            }
        }
    }
    let empty = Vec::new();
    let mut out: Vec<TagStats> = tags
        .iter()
        .map(|tag| {
            let txs = by_tag.get(tag.id.as_str()).unwrap_or(&empty);
            let mut spent = 0i64;
            let mut cats: HashMap<Option<&str>, i64> = HashMap::new();
            let mut monthly: BTreeMap<&str, i64> = BTreeMap::new();
            let (mut first, mut last): (Option<&str>, Option<&str>) = (None, None);
            for t in txs {
                let d = t.date.as_str();
                first = Some(first.map_or(d, |f| f.min(d)));
                last = Some(last.map_or(d, |l| l.max(d)));
                let signed = match t.kind.as_str() {
                    "expense" => cents(t.amount),
                    "income" => -cents(t.amount),
                    _ => continue,
                };
                spent += signed;
                *cats.entry(t.category_id.as_deref()).or_default() += signed;
                *monthly.entry(&d[..7.min(d.len())]).or_default() += signed;
            }
            let mut by_category: Vec<CategoryAmount> = cats
                .into_iter()
                .filter(|(_, v)| *v != 0)
                .map(|(k, v)| CategoryAmount { category_id: k.map(str::to_string), amount: money(v) })
                .collect();
            by_category.sort_by(|a, b| b.amount.total_cmp(&a.amount).then_with(|| a.category_id.cmp(&b.category_id)));
            let monthly = match (monthly.keys().next(), monthly.keys().last()) {
                (Some(f), Some(l)) => months(f, l)
                    .into_iter()
                    .map(|m| MonthAmount { amount: money(*monthly.get(m.as_str()).unwrap_or(&0)), month: m })
                    .collect(),
                _ => Vec::new(),
            };
            let budget_cents = tag.budget.map(cents);
            let (remaining, percent, status) = match budget_cents {
                Some(b) if b > 0 => {
                    let pct = spent.max(0) as f64 / b as f64 * 100.0;
                    let st = if spent > b { "over" } else if pct >= 80.0 { "near" } else { "ok" };
                    (Some(money(b - spent)), Some(pct), Some(st))
                }
                _ => (None, None, None),
            };
            TagStats {
                tag_id: tag.id.clone(),
                spent: money(spent),
                count: txs.len() as i64,
                first_date: first.map(str::to_string),
                last_date: last.map(str::to_string),
                by_category,
                monthly,
                budget: budget_cents.map(money),
                remaining,
                percent,
                budget_status: status,
            }
        })
        .collect();
    // Son işlem tarihi en yeni önce, işlemsizler sonda; eşitlikte etiketin oluşturulma sırası
    let created: HashMap<&str, &str> = tags.iter().map(|t| (t.id.as_str(), t.created_at.as_str())).collect();
    out.sort_by(|a, b| match (&a.last_date, &b.last_date) {
        (Some(x), Some(y)) if x != y => y.cmp(x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => created[a.tag_id.as_str()].cmp(created[b.tag_id.as_str()]),
    });
    TagsReport { tags: out }
}
