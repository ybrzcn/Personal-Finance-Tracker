//! Birikim hedefleri: bağlı hesapların hedef birimindeki değeri, aylık seri, son 3 ayın hızı,
//! aylık gereken tutar, tahmini ulaşım tarihi ve durum. Değerleme net servetle aynı (bugünkü alış kuru).

use std::collections::HashMap;

use serde::Serialize;

use crate::db::{Account, Goal, Transaction};
use crate::fx::amount::RATE_SCALE;
use crate::fx::time::{civil_from_days, parse_ymd, ymd};
use crate::fx::{self, Unit};
use crate::accounts::bank::{qty_at, tl_value, value_cents};
use crate::accounts::cards::clamped_date;
use crate::networth::month_ends;
use crate::pnl::CurrentRate;
use crate::CoreResult;

/// Ortalama ay uzunluğu (gün)
const MONTH_DAYS: f64 = 30.4375;
/// En uzak tahmin (ay)
const MAX_MONTHS: f64 = 1200.0;

pub struct GoalsInput<'a> {
    pub goals: &'a [Goal],
    pub accounts: &'a [Account],
    pub transactions: &'a [Transaction],
    pub rates: &'a HashMap<String, CurrentRate>,
    pub today: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalAccountValue {
    pub account_id: String,
    /// Bugünkü değer hedef biriminde; kur yoksa yok
    pub value: Option<f64>,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SeriesPoint {
    pub date: String,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalProgress {
    pub goal_id: String,
    pub current: f64,
    pub target: f64,
    pub percent: f64,
    pub remaining: f64,
    pub required_per_month: Option<f64>,
    pub pace_per_month: Option<f64>,
    pub projected_date: Option<String>,
    /// reached | on_track | behind | unknown
    pub status: &'static str,
    pub date_overdue: bool,
    pub unvalued_count: i64,
    pub accounts: Vec<GoalAccountValue>,
    pub series: Vec<SeriesPoint>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GoalsReport {
    pub goals: Vec<GoalProgress>,
}

fn days(d: &str) -> i64 {
    parse_ymd(d).unwrap_or(0)
}

/// TL kuruş → hedef biriminin en küçük parçası (yarım yukarı, işaret korunur)
fn from_cents(cents: i64, rate: i64, unit: Unit) -> i64 {
    if cents == 0 || rate <= 0 {
        return 0;
    }
    let num = cents.unsigned_abs() as i128 * unit.divisor() as i128 * RATE_SCALE as i128;
    let den = 100i128 * rate as i128;
    cents.signum() * ((num + den / 2) / den) as i64
}

/// Hesabın `d` tarihindeki değeri hedef biriminde (en küçük parça); gereken kur yoksa `None`
fn account_minor(a: &Account, goal_cur: &str, goal_unit: Unit, input: &GoalsInput, d: &str) -> Option<i64> {
    if a.opening_date.as_str() > d {
        return Some(0);
    }
    let txs = input.transactions;
    if a.currency == goal_cur {
        return Some(if a.currency == fx::TRY { tl_value(a, txs, d) } else { qty_at(a, goal_unit, txs, d) });
    }
    let cents = if a.currency == fx::TRY {
        tl_value(a, txs, d)
    } else {
        let unit = fx::unit_or_try(Some(&a.currency));
        value_cents(qty_at(a, unit, txs, d), input.rates.get(&a.currency)?.buy, unit)
    };
    if goal_cur == fx::TRY {
        return Some(cents);
    }
    Some(from_cents(cents, input.rates.get(goal_cur)?.buy, goal_unit))
}

/// `today`'den `n` ay önceki aynı gün (ayda yoksa ayın son günü)
fn months_back(today: &str, n: i64) -> String {
    let (y, m, d) = civil_from_days(days(today));
    clamped_date(y, m as i64 - 1 - n, d as i64)
}

/// Bugünden hedef tarihine tam ay farkı; kalan gün varsa +1; en az 1
fn months_until(today: &str, target: &str) -> i64 {
    let (ty, tm, td) = civil_from_days(days(today));
    let (gy, gm, gd) = civil_from_days(days(target));
    let mut n = (gy - ty) * 12 + gm as i64 - tm as i64;
    if gd < td {
        n -= 1;
    }
    if clamped_date(ty, tm as i64 - 1 + n, td as i64).as_str() < target {
        n += 1;
    }
    n.max(1)
}

pub fn report(input: &GoalsInput) -> CoreResult<GoalsReport> {
    let by_id: HashMap<&str, &Account> = input.accounts.iter().map(|a| (a.id.as_str(), a)).collect();
    let today = input.today;
    let mut out = Vec::with_capacity(input.goals.len());
    for g in input.goals {
        let unit = fx::unit_or_try(Some(&g.currency));
        let div = unit.divisor() as f64;
        let value = |m: i64| m as f64 / div;
        let accs: Vec<&Account> = g.account_ids.iter().filter_map(|id| by_id.get(id.as_str()).copied()).collect();
        let total_at = |d: &str| -> (i64, i64) {
            let (mut sum, mut unvalued) = (0i64, 0i64);
            for a in &accs {
                match account_minor(a, &g.currency, unit, input, d) {
                    Some(v) => sum += v,
                    None => unvalued += 1,
                }
            }
            (sum, unvalued)
        };
        let (current, unvalued_count) = total_at(today);
        let target_minor = (g.target * div).round() as i64;
        let remaining = (target_minor - current).max(0);
        let start = accs.iter().map(|a| a.opening_date.as_str()).min();
        let series = match start {
            None => Vec::new(),
            Some(f) => month_ends(f, today).into_iter().map(|d| SeriesPoint { value: value(total_at(&d).0), date: d }).collect(),
        };
        // Değerlenemeyen hesap varsa hız ve tahmin bilinmez (eksik toplamdan "Geride" çıkmasın)
        let pace = start.filter(|_| unvalued_count == 0).and_then(|f| {
            let back = months_back(today, 3);
            let from = if back.as_str() > f { back } else { f.to_string() };
            let months = (days(today) - days(&from)) as f64 / MONTH_DAYS;
            (months >= 1.0).then(|| value(current - total_at(&from).0) / months)
        });
        let overdue = g.target_date.as_deref().is_some_and(|t| t < today);
        let required = match g.target_date.as_deref() {
            Some(t) if !overdue && remaining > 0 => Some(value(remaining) / months_until(today, t) as f64),
            _ => None,
        };
        let projected = match pace {
            // 100 yıldan uzak tahmin gösterilmez (ulaşılamıyor sayılır)
            Some(p) if p > 0.0 && remaining > 0 && value(remaining) / p <= MAX_MONTHS => {
                Some(ymd(days(today) + (value(remaining) / p * MONTH_DAYS).ceil() as i64))
            }
            _ => None,
        };
        let status = if current >= target_minor {
            "reached"
        } else if accs.is_empty() || unvalued_count > 0 || (pace.is_none() && !overdue) {
            "unknown"
        } else if overdue {
            "behind"
        } else {
            let p = pace.unwrap_or(0.0);
            let late = match (g.target_date.as_deref(), projected.as_deref()) {
                (Some(t), Some(x)) => x > t,
                _ => projected.is_none(),
            };
            if p <= 0.0 || late { "behind" } else { "on_track" }
        };
        out.push(GoalProgress {
            goal_id: g.id.clone(),
            current: value(current),
            target: value(target_minor),
            percent: if target_minor > 0 { current.max(0) as f64 / target_minor as f64 * 100.0 } else { 0.0 },
            remaining: value(remaining),
            required_per_month: required,
            pace_per_month: pace,
            projected_date: projected,
            status,
            date_overdue: overdue,
            unvalued_count,
            accounts: accs
                .iter()
                .map(|a| GoalAccountValue {
                    account_id: a.id.clone(),
                    value: account_minor(a, &g.currency, unit, input, today).map(value),
                    archived: a.archived,
                })
                .collect(),
            series,
        });
    }
    Ok(GoalsReport { goals: out })
}
