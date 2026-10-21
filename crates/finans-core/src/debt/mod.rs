//! Borç planı (TS `debt.ts` + Borç Planı sayfasının satır hesapları): borçlar, dört strateji ve "Kendi planım",
//! en az faizli plan, ilk 24 ayın tablosu. Ayarlar (`debtBudget`, `debtBudgetOverrides`, `debtRules`, `debtCells`)
//! veritabanındaki `settings` tablosundan; bozuk değerler yok sayılır.

pub mod debts;
pub mod simulate;

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};

use self::debts::debts_from_accounts;
use self::simulate::{minimum_monthly_cents, simulate, simulate_manual, Cell, Rule, RuleMode, SimResult, Strategy};
use crate::accounts::cards::js_round;
use crate::budget::income::{primary_salary, regular_expense_for_month, regular_income_for_month, salary_month_for, split_month_income};
use crate::budget::recurring::{occurrence_in, shift_month};
use crate::cashplan::obligations::add_months;
use crate::db::{Account, RecurringItem, Transaction};

/// Simülasyon süresi (30 yıl)
const MAX_MONTHS: i64 = 360;
/// Tabloda gösterilen ay sayısı
const TABLE_MONTHS: usize = 24;

pub struct DebtPlanInput<'a> {
    pub accounts: &'a [Account],
    pub transactions: &'a [Transaction],
    pub recurring: &'a [RecurringItem],
    /// `store::get_settings` haritası
    pub settings: &'a Map<String, Value>,
    pub today: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtRow {
    pub id: String,
    pub kind: String,
    pub balance_cents: i64,
    /// Kart: ilk aya düşen kısım (kalanı ileriki ekstreler); KMH ve kredide yok
    pub first_month_cents: Option<i64>,
    pub monthly_rate: f64,
    /// İlk ayın faizi
    pub interest_cents: i64,
    /// İlk ayın asgari ödemesi / taksiti
    pub minimum_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payoff {
    pub id: String,
    pub month: i64,
    pub month_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRow {
    /// Plan ayı (1 = bu ay)
    pub month: i64,
    pub month_key: String,
    /// Satırın ödemelerini karşılayan maaşın ayı (maaş yoksa takvim ayı)
    pub salary_month: String,
    pub income_cents: i64,
    pub fixed_cents: i64,
    /// Borçlara ayrılan (aya özel tutar ya da varsayılan)
    pub allotted_cents: i64,
    pub overridden: bool,
    /// Gelirden (düzenli giderler düşülünce) fazlası ayrılıyor
    pub over_income: bool,
    /// Yalnız sıfırdan farklı ödemeler
    pub payments: BTreeMap<String, i64>,
    pub balances: BTreeMap<String, i64>,
    pub total_cents: i64,
    pub left_cents: i64,
    /// Gelir − düzenli gider − bu ayki borç ödemeleri
    pub free_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub strategy: &'static str,
    pub months: Option<i64>,
    pub payoff_date: Option<String>,
    pub total_interest_cents: i64,
    pub total_paid_cents: i64,
    /// En az faizli plana göre fazla faiz (bu plan en iyiyse ya da en iyi yoksa yok)
    pub extra_interest_cents: Option<i64>,
    pub budget_short: bool,
    /// Kapanış ayına göre sıralı
    pub payoffs: Vec<Payoff>,
    pub rows: Vec<PlanRow>,
    pub income_same: bool,
    pub fixed_same: bool,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebtPlanReport {
    pub today: String,
    pub debts: Vec<DebtRow>,
    pub minimum_cents: i64,
    pub budget_cents: i64,
    pub budget_is_default: bool,
    pub best: Option<&'static str>,
    pub manual_empty: bool,
    pub plans: Vec<Plan>,
}

struct DebtSettings {
    budget_cents: Option<i64>,
    overrides: BTreeMap<String, i64>,
    rules: BTreeMap<String, Rule>,
    cells: BTreeMap<String, Cell>,
    /// Hiç kural ve hücre yok
    empty: bool,
}

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

fn is_month(k: &str) -> bool {
    let b = k.as_bytes();
    b.len() == 7 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit())
}

/// YYYY-MM → ay sayısı
fn month_index(ym: &str) -> i64 {
    let num = |r: std::ops::Range<usize>| ym.get(r).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    num(0..4) * 12 + num(5..7)
}

fn read_settings(s: &Map<String, Value>) -> DebtSettings {
    let obj = |k: &str| s.get(k).and_then(Value::as_object);
    let budget_cents = s.get("debtBudget").and_then(finite).filter(|v| *v > 0.0).map(|v| js_round(v * 100.0));
    let overrides = obj("debtBudgetOverrides")
        .map(|m| m.iter().filter(|(k, _)| is_month(k)).filter_map(|(k, v)| Some((k.clone(), js_round(finite(v)? * 100.0)))).collect())
        .unwrap_or_default();
    let rules = obj("debtRules")
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| {
                    let mode = match v.get("mode")?.as_str()? {
                        "full" => RuleMode::Full,
                        "minimum" => RuleMode::Minimum,
                        "fixed" => RuleMode::Fixed,
                        "none" => RuleMode::None,
                        _ => return None,
                    };
                    Some((k.clone(), Rule { mode, amount: v.get("amount").and_then(finite).unwrap_or(0.0) }))
                })
                .collect()
        })
        .unwrap_or_default();
    // -1: "bu ayın tamamını öde"
    let cells = obj("debtCells")
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| {
                    let x = finite(v)?;
                    Some((k.clone(), if x == -1.0 { Cell::Full } else { Cell::Cents(js_round(x * 100.0)) }))
                })
                .collect()
        })
        .unwrap_or_default();
    let empty = obj("debtRules").is_none_or(Map::is_empty) && obj("debtCells").is_none_or(Map::is_empty);
    DebtSettings { budget_cents, overrides, rules, cells, empty }
}

/// Tablo satırının plana bağlı olmayan kısmı
struct MonthInfo {
    key: String,
    salary_month: String,
    income: i64,
    fixed: i64,
    allotted: i64,
    overridden: bool,
}

pub fn plan(input: &DebtPlanInput) -> DebtPlanReport {
    let (today, txs, rec) = (input.today, input.transactions, input.recurring);
    let this_month = today.get(..7).unwrap_or(today);
    let salary = primary_salary(rec, today);
    let month_key = |i: i64| shift_month(this_month, i - 1);
    // Satırın ödemelerini karşılayan maaşın ayı (bütçe ayı): o ay yatan maaşın ait olduğu ay
    let income_month = |i: i64| match salary {
        Some(s) => salary_month_for(s, &occurrence_in(s, &month_key(i))),
        None => month_key(i),
    };
    let first = month_index(&income_month(1));
    // Kart ekstreleri, son ödemelerini karşılayan maaşın satırına düşer (Ödeme Takvimi ile aynı kural)
    let bucket = |due: &str| -> i64 {
        let m = match salary {
            Some(s) => salary_month_for(s, due),
            None => due.get(..7).unwrap_or(due).to_string(),
        };
        (month_index(&m) - first + 1).max(1)
    };
    let debts = debts_from_accounts(input.accounts, txs, today, &bucket);
    let set = read_settings(input.settings);
    let minimum_cents = minimum_monthly_cents(&debts);
    let budget_cents = set.budget_cents.unwrap_or(minimum_cents);
    let budget_for = |i: i64| set.overrides.get(&month_key(i)).copied().unwrap_or(budget_cents);
    let cell = |i: i64, id: &str| -> Option<Cell> { set.cells.get(&format!("{}:{id}", month_key(i))).copied() };
    let results: Vec<(Strategy, SimResult)> = Strategy::ALL
        .iter()
        .map(|&s| {
            let r = if s == Strategy::Manual { simulate_manual(&debts, &set.rules, &cell, MAX_MONTHS) } else { simulate(&debts, &budget_for, s, MAX_MONTHS) };
            (s, r)
        })
        .collect();
    // En az faizli tamamlanan plan; eşitlikte sıradaki ilk (min_by_key ilk en küçüğü verir, TS kararlı sıralama)
    let best = results.iter().filter(|(_, r)| r.months.is_some()).min_by_key(|(_, r)| r.total_interest_cents).map(|(s, r)| (*s, r.total_interest_cents));
    let months: Vec<MonthInfo> = (1..=TABLE_MONTHS as i64)
        .map(|i| {
            let key = month_key(i);
            let salary_month = income_month(i);
            let income = regular_income_for_month(txs, rec, &salary_month).iter().map(|l| l.used_cents).sum::<i64>()
                + split_month_income(txs, rec, &salary_month).irregular_cents;
            MonthInfo { overridden: set.overrides.contains_key(&key), allotted: budget_for(i), fixed: regular_expense_for_month(rec, &key), key, salary_month, income }
        })
        .collect();
    let by_id = |v: &[i64], keep_zero: bool| -> BTreeMap<String, i64> {
        debts.iter().zip(v).filter(|(_, x)| keep_zero || **x != 0).map(|(d, x)| (d.id.clone(), *x)).collect()
    };
    let plans = results
        .iter()
        .map(|(s, r)| {
            let rows: Vec<PlanRow> = r
                .timeline
                .iter()
                .take(TABLE_MONTHS)
                .map(|m| {
                    let x = &months[(m.month - 1) as usize];
                    let total: i64 = m.payments.iter().sum();
                    PlanRow {
                        month: m.month,
                        month_key: x.key.clone(),
                        salary_month: x.salary_month.clone(),
                        income_cents: x.income,
                        fixed_cents: x.fixed,
                        allotted_cents: x.allotted,
                        overridden: x.overridden,
                        over_income: x.income > 0 && x.allotted > x.income - x.fixed,
                        payments: by_id(&m.payments, false),
                        balances: by_id(&m.balances, true),
                        total_cents: total,
                        left_cents: m.balances.iter().sum(),
                        free_cents: x.income - x.fixed - total,
                    }
                })
                .collect();
            let same = |f: fn(&PlanRow) -> i64| rows.len() > 1 && rows.iter().all(|x| f(x) == f(&rows[0]));
            let (income_same, fixed_same) = (same(|x| x.income_cents), same(|x| x.fixed_cents));
            let mut payoffs: Vec<Payoff> = debts
                .iter()
                .zip(&r.payoff_month)
                .filter_map(|(d, m)| m.filter(|m| *m > 0).map(|m| Payoff { id: d.id.clone(), month: m, month_key: month_key(m) }))
                .collect();
            payoffs.sort_by_key(|p| p.month);
            Plan {
                strategy: s.key(),
                months: r.months,
                payoff_date: r.months.map(|m| add_months(today, m)),
                total_interest_cents: r.total_interest_cents,
                total_paid_cents: r.total_paid_cents,
                extra_interest_cents: best.filter(|(b, _)| b != s).map(|(_, i)| r.total_interest_cents - i),
                budget_short: r.budget_short,
                payoffs,
                income_same,
                fixed_same,
                has_more: r.timeline.len() > TABLE_MONTHS,
                rows,
            }
        })
        .collect();
    let minimum_plan = results.iter().find(|(s, _)| *s == Strategy::Minimum).map(|(_, r)| r);
    let debt_rows = debts
        .iter()
        .enumerate()
        .map(|(i, d)| DebtRow {
            id: d.id.clone(),
            kind: d.kind.clone(),
            balance_cents: d.balance_cents,
            first_month_cents: d.billing.as_ref().map(|_| d.first_due()),
            monthly_rate: d.monthly_rate,
            interest_cents: js_round(d.first_due() as f64 * d.monthly_rate),
            minimum_cents: minimum_plan.and_then(|r| r.timeline.first()).map_or(0, |m| m.payments[i]),
        })
        .collect();
    DebtPlanReport {
        today: today.to_string(),
        debts: debt_rows,
        minimum_cents,
        budget_cents,
        budget_is_default: set.budget_cents.is_none(),
        best: best.map(|(s, _)| s.key()),
        manual_empty: set.empty,
        plans,
    }
}
