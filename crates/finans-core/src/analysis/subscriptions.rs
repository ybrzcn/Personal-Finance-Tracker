//! Abonelik tespiti (TS `detectSubscriptions`)

use std::collections::HashMap;

use serde::Serialize;

use super::{cents, lower_tr, round2, Override};
use crate::accounts::cards::js_round;
use crate::cashplan::obligations::add_months;
use crate::db::{Category, Transaction};
use crate::fx::time::days_between;
use crate::overview::breakdown::{is_code_letter, js_space, merchant_name, upper_tr};

/// Fiyat değişimi ya da kur farkı bu oranın altındaysa aynı abonelik sayılır
const SAME_PLAN_TOLERANCE: f64 = 0.07;
/// Beklenen ödemeden bu kadar gün sonra hâlâ görülmediyse "gecikti"
const LATE_GRACE_DAYS: i64 = 40;
/// Ödeme aralıklarının medyanı bu kadar gün ve üstündeyse yıllık
const YEARLY_GAP_DAYS: f64 = 300.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionRow {
    /// Kalıcı anahtar (düzeltmeler bununla saklanır): harcama yeri + ilk ödeme tutarı
    pub key: String,
    pub name: String,
    /// Ekstredeki açıklama
    pub merchant: String,
    pub period: &'static str,
    pub detected_period: &'static str,
    pub last_amount_cents: i64,
    pub last_date: String,
    pub next_date: String,
    pub monthly_cents: i64,
    pub yearly_cents: i64,
    pub count: i64,
    pub total_paid_cents: i64,
    pub account_id: String,
    /// active | late | cancelled
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionsReport {
    pub items: Vec<SubscriptionRow>,
    /// İptal edilmeyenler (aktif ve geciken)
    pub active_count: i64,
    pub monthly_cents: i64,
    pub yearly_cents: i64,
}

pub fn is_subscription_category(c: &Category) -> bool {
    c.kind == "expense" && super::norm(&c.name).starts_with("abonelik")
}

fn median(xs: &[i64]) -> f64 {
    let mut s = xs.to_vec();
    s.sort_unstable();
    let m = s.len() / 2;
    if s.len() % 2 == 1 { s[m] as f64 } else { (s[m - 1] + s[m]) as f64 / 2.0 }
}

/// Ekstre açıklamasından okunur abonelik adı: kod parçaları ve yinelenen kelimeler atılır
fn display_name(description: &str) -> String {
    let replaced = description.replace('*', " ");
    let words: Vec<&str> = replaced
        .split(js_space)
        .filter(|w| !w.is_empty())
        .filter(|w| {
            let long_number = w.len() >= 4 && w.bytes().all(|b| b.is_ascii_digit());
            let code = w.encode_utf16().count() >= 6 && w.chars().any(|c| c.is_ascii_digit()) && w.chars().any(is_code_letter);
            !long_number && !code
        })
        .collect();
    let words = words.iter().enumerate().filter(|(i, w)| *i == 0 || upper_tr(w) != upper_tr(words[i - 1])).map(|(_, w)| *w).take(3);
    // Türkçe harf yoksa (NETFLIX, GITHUB) İngilizce kurallarla küçültülür: "I" → "i", "ı" değil
    let tr = description.chars().any(|c| "ÇĞİÖŞÜçğıöşü".contains(c));
    words
        .map(|w| {
            let mut cs = w.chars();
            let first = cs.next().map(|c| c.to_string()).unwrap_or_default();
            let rest = cs.as_str();
            if tr { upper_tr(&first) + &lower_tr(rest) } else { first.to_uppercase() + &rest.to_lowercase() }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

struct Group<'a> {
    key: String,
    merchant: String,
    description: &'a str,
    clusters: Vec<Vec<&'a Transaction>>,
}

/// Abonelikler kategorisindeki giderlerden abonelik listesi
pub fn detect(txs: &[Transaction], categories: &[Category], overrides: &HashMap<String, Override>, today: &str) -> SubscriptionsReport {
    let sub_ids: Vec<&str> = categories.iter().filter(|c| is_subscription_category(c)).map(|c| c.id.as_str()).collect();
    let mut charges: Vec<&Transaction> =
        txs.iter().filter(|t| t.kind == "expense" && t.category_id.as_deref().is_some_and(|id| !id.is_empty() && sub_ids.contains(&id))).collect();
    charges.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.created_at.cmp(&b.created_at)));

    // Harcama yeri → tutarına göre kümeler
    let mut groups: Vec<Group> = Vec::new();
    for t in charges {
        let merchant = merchant_name(&t.description);
        let key = upper_tr(&merchant);
        let gi = match groups.iter().position(|g| g.key == key) {
            Some(i) => i,
            None => {
                groups.push(Group { key, merchant, description: &t.description, clusters: Vec::new() });
                groups.len() - 1
            }
        };
        let g = &mut groups[gi];
        match g.clusters.iter_mut().find(|c| {
            let last = c[c.len() - 1].amount;
            (t.amount - last).abs() <= last * SAME_PLAN_TOLERANCE
        }) {
            Some(c) => c.push(t),
            None => g.clusters.push(vec![t]),
        }
    }

    let none = Override::default();
    let mut out: Vec<(f64, SubscriptionRow)> = Vec::new();
    for g in &groups {
        for c in &g.clusters {
            let key = format!("{}@{}", g.key, js_round(c[0].amount));
            let o = overrides.get(&key).unwrap_or(&none);
            let last = c[c.len() - 1];
            let gaps: Vec<i64> = c.windows(2).map(|w| days_between(&w[0].date, &w[1].date)).collect();
            let detected = if !gaps.is_empty() && median(&gaps) >= YEARLY_GAP_DAYS { "yearly" } else { "monthly" };
            let period = o.period.unwrap_or(detected);
            let next_date = add_months(&last.date, if period == "yearly" { 12 } else { 1 });
            let yearly = if period == "yearly" { last.amount } else { last.amount * 12.0 };
            let status = if o.cancelled {
                "cancelled"
            } else if days_between(&next_date, today) > LATE_GRACE_DAYS {
                "late"
            } else {
                "active"
            };
            let name = match &o.name {
                Some(n) => n.clone(),
                None => Some(display_name(g.description)).filter(|n| !n.is_empty()).unwrap_or_else(|| g.merchant.clone()),
            };
            let total_paid = round2(c.iter().fold(0.0, |s, t| s + t.amount));
            out.push((round2(yearly), SubscriptionRow {
                key,
                name,
                merchant: g.description.to_string(),
                period,
                detected_period: detected,
                last_amount_cents: cents(last.amount),
                last_date: last.date.clone(),
                next_date,
                monthly_cents: cents(round2(yearly / 12.0)),
                yearly_cents: cents(round2(yearly)),
                count: c.len() as i64,
                total_paid_cents: cents(total_paid),
                account_id: last.account_id.clone(),
                status,
            }));
        }
    }
    let rank = |s: &str| match s {
        "active" => 0,
        "late" => 1,
        _ => 2,
    };
    out.sort_by(|(ya, a), (yb, b)| rank(a.status).cmp(&rank(b.status)).then(yb.partial_cmp(ya).unwrap_or(std::cmp::Ordering::Equal)));
    let items: Vec<SubscriptionRow> = out.into_iter().map(|(_, r)| r).collect();
    let live = items.iter().filter(|s| s.status != "cancelled");
    SubscriptionsReport {
        active_count: live.clone().count() as i64,
        monthly_cents: live.clone().map(|s| s.monthly_cents).sum(),
        yearly_cents: live.map(|s| s.yearly_cents).sum(),
        items,
    }
}
