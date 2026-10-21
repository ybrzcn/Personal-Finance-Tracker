//! Aylık borç simülasyonları (TS `simulate`, `simulateManual`, `minimumMonthlyCents`)

use std::cmp::Ordering;
use std::collections::{BTreeMap, VecDeque};

use super::debts::Debt;
use crate::accounts::cards::js_round;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    Avalanche,
    Snowball,
    Custom,
    Minimum,
    Manual,
}

impl Strategy {
    /// Raporun plan sırası
    pub const ALL: [Strategy; 5] = [Strategy::Avalanche, Strategy::Snowball, Strategy::Custom, Strategy::Minimum, Strategy::Manual];

    pub fn key(self) -> &'static str {
        match self {
            Strategy::Avalanche => "avalanche",
            Strategy::Snowball => "snowball",
            Strategy::Custom => "custom",
            Strategy::Minimum => "minimum",
            Strategy::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleMode {
    Full,
    Minimum,
    Fixed,
    None,
}

/// "Kendi planım"da borç başına kural
#[derive(Debug, Clone, Copy)]
pub struct Rule {
    pub mode: RuleMode,
    /// Yalnız `Fixed`: aylık tutar (TL)
    pub amount: f64,
}

/// "Kendi planım"da bir ayın bir borcuna elle girilen ödeme
#[derive(Debug, Clone, Copy)]
pub enum Cell {
    /// Ödenmesi gelen bakiyenin tamamı (faiz işlemez)
    Full,
    Cents(i64),
}

pub struct MonthPlan {
    /// Plan ayı (1 = bu ay)
    pub month: i64,
    /// Borç sırasıyla (`debts` dizisiyle aynı)
    pub payments: Vec<i64>,
    pub balances: Vec<i64>,
}

pub struct SimResult {
    /// Tüm borçların kapandığı ay sayısı; kapanmadıysa yok
    pub months: Option<i64>,
    pub total_interest_cents: i64,
    pub total_paid_cents: i64,
    /// Borç sırasıyla kapanış ayı
    pub payoff_month: Vec<Option<i64>>,
    /// İlk 60 ay
    pub timeline: Vec<MonthPlan>,
    /// Asgari ödemeler bütçeyi aştı
    pub budget_short: bool,
}

/// Defter: `billed` ödenmesi gelmiş (faiz işleyen) bakiye, `future` ileriki aylara düşecek kısımlar
struct Ledger {
    billed: Vec<i64>,
    future: Vec<VecDeque<i64>>,
}

impl Ledger {
    fn new(debts: &[Debt]) -> Self {
        Ledger {
            billed: debts.iter().map(Debt::first_due).collect(),
            future: debts.iter().map(|d| d.billing.as_ref().map(|b| b.iter().skip(1).copied().collect()).unwrap_or_default()).collect(),
        }
    }

    fn total(&self, i: usize) -> i64 {
        self.billed[i] + self.future[i].iter().sum::<i64>()
    }

    /// Ayın başında o aya düşen kısım ödenecek bakiyeye eklenir
    fn advance(&mut self, month: i64) {
        if month > 1 {
            for (b, f) in self.billed.iter_mut().zip(self.future.iter_mut()) {
                *b += f.pop_front().unwrap_or(0);
            }
        }
    }

    fn balances(&self) -> Vec<i64> {
        (0..self.billed.len()).map(|i| self.total(i)).collect()
    }
}

pub fn minimum_due(d: &Debt, balance: i64, interest: i64) -> i64 {
    if let Some(fixed) = d.fixed_payment_cents {
        return balance.min(fixed);
    }
    // Bankalar küçük bakiyelerde tamamını ister; 100 TL taban, yuvarlama yüzünden borcun hiç bitmemesini önler
    if let Some(pct) = d.min_rate_pct {
        return balance.min(js_round(balance as f64 * pct / 100.0).max(interest + 1).max(10000));
    }
    balance.min(interest) // KMH: en az faiz
}

fn by_rate_desc(a: &Debt, b: &Debt) -> Ordering {
    b.monthly_rate.partial_cmp(&a.monthly_rate).unwrap_or(Ordering::Equal)
}

/// Önce faiz eklenir, sonra her borca asgari/taksit ödenir, bütçeden artan tutar stratejinin sırasıyla borçlara
/// aktarılır. Krediler (erken kapama masrafı nedeniyle) ek ödeme sırasında en sona bırakılır.
pub fn simulate(debts: &[Debt], budget_for: &dyn Fn(i64) -> i64, strategy: Strategy, max_months: i64) -> SimResult {
    let n = debts.len();
    let mut book = Ledger::new(debts);
    let start = book.billed.clone();
    let mut payoff_month: Vec<Option<i64>> = debts.iter().map(|d| if d.balance_cents > 0 { None } else { Some(0) }).collect();
    let mut timeline = Vec::new();
    let (mut total_interest, mut total_paid, mut budget_short) = (0i64, 0i64, false);
    let loan = |i: usize| debts[i].kind == "loan";
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        loan(a).cmp(&loan(b)).then_with(|| match strategy {
            Strategy::Avalanche => by_rate_desc(&debts[a], &debts[b]).then(start[a].cmp(&start[b])),
            Strategy::Snowball => start[a].cmp(&start[b]).then_with(|| by_rate_desc(&debts[a], &debts[b])),
            _ => debts[a].order.cmp(&debts[b].order),
        })
    });
    for month in 1..=max_months {
        book.advance(month);
        let live: Vec<usize> = (0..n).filter(|&i| book.total(i) > 0).collect();
        if live.is_empty() {
            return SimResult { months: Some(month - 1), total_interest_cents: total_interest, total_paid_cents: total_paid, payoff_month, timeline, budget_short };
        }
        let mut payments = vec![0i64; n];
        let mut interest = vec![0i64; n];
        for &i in &live {
            let x = js_round(book.billed[i] as f64 * debts[i].monthly_rate);
            interest[i] = x;
            book.billed[i] += x;
            total_interest += x;
        }
        let mut spent = 0i64;
        for &i in &live {
            let p = minimum_due(&debts[i], book.billed[i], interest[i]);
            payments[i] = p;
            book.billed[i] -= p;
            spent += p;
        }
        if strategy != Strategy::Minimum {
            let budget = budget_for(month);
            if spent > budget {
                budget_short = true;
            }
            let mut extra = (budget - spent).max(0);
            for &i in &order {
                if extra <= 0 {
                    break;
                }
                let p = extra.min(book.billed[i]);
                if p <= 0 {
                    continue;
                }
                payments[i] += p;
                book.billed[i] -= p;
                extra -= p;
                spent += p;
            }
        }
        // Ödenmesi gelen bakiyesi bu ay tamamen kapanan borca faiz işlemez ("Kendi planım" ile aynı kural)
        for &i in &live {
            let x = interest[i];
            if x > 0 && book.billed[i] == 0 && payments[i] >= x {
                payments[i] -= x;
                spent -= x;
                total_interest -= x;
            }
        }
        total_paid += spent;
        for &i in &live {
            if book.total(i) == 0 && payoff_month[i].is_none() {
                payoff_month[i] = Some(month);
            }
        }
        if timeline.len() < 60 {
            timeline.push(MonthPlan { month, payments, balances: book.balances() });
        }
    }
    let done = (0..n).all(|i| book.total(i) == 0);
    SimResult { months: done.then_some(max_months), total_interest_cents: total_interest, total_paid_cents: total_paid, payoff_month, timeline, budget_short }
}

/// "Kendi planım": her borç kendi kuralıyla ödenir (tam / asgari / sabit / hiç); `cell` ile belirli bir ayın belirli
/// borcuna elle tutar girilebilir. Faiz her ay ödemeden önce eklenir.
pub fn simulate_manual(debts: &[Debt], rules: &BTreeMap<String, Rule>, cell: &dyn Fn(i64, &str) -> Option<Cell>, max_months: i64) -> SimResult {
    let n = debts.len();
    let mut book = Ledger::new(debts);
    let mut payoff_month: Vec<Option<i64>> = debts.iter().map(|d| if d.balance_cents > 0 { None } else { Some(0) }).collect();
    let mut timeline = Vec::new();
    let (mut total_interest, mut total_paid) = (0i64, 0i64);
    for month in 1..=max_months {
        book.advance(month);
        let live: Vec<usize> = (0..n).filter(|&i| book.total(i) > 0).collect();
        if live.is_empty() {
            return SimResult { months: Some(month - 1), total_interest_cents: total_interest, total_paid_cents: total_paid, payoff_month, timeline, budget_short: false };
        }
        let mut payments = vec![0i64; n];
        for &i in &live {
            let d = &debts[i];
            let manual = cell(month, &d.id);
            let rule = rules.get(&d.id).copied().unwrap_or(Rule { mode: RuleMode::None, amount: 0.0 });
            // Borcun tamamı ödenirse (ör. kart ekstresi son ödemeye kadar tam) faiz işlemez
            let pays_in_full = match manual {
                Some(Cell::Full) => true,
                Some(Cell::Cents(c)) => c >= book.billed[i],
                None => rule.mode == RuleMode::Full,
            };
            let x = if pays_in_full { 0 } else { js_round(book.billed[i] as f64 * d.monthly_rate) };
            book.billed[i] += x;
            total_interest += x;
            let bal = book.billed[i];
            let p = match (manual, rule.mode) {
                (Some(Cell::Full), _) | (None, RuleMode::Full) => bal,
                (Some(Cell::Cents(c)), _) => c,
                (None, RuleMode::Fixed) => js_round(rule.amount * 100.0),
                (None, RuleMode::None) => 0,
                (None, RuleMode::Minimum) => minimum_due(d, bal, x),
            };
            let p = p.min(bal).max(0);
            payments[i] = p;
            book.billed[i] -= p;
            total_paid += p;
            if book.total(i) == 0 && payoff_month[i].is_none() {
                payoff_month[i] = Some(month);
            }
        }
        if timeline.len() < 60 {
            timeline.push(MonthPlan { month, payments, balances: book.balances() });
        }
    }
    let done = (0..n).all(|i| book.total(i) == 0);
    SimResult { months: done.then_some(max_months), total_interest_cents: total_interest, total_paid_cents: total_paid, payoff_month, timeline, budget_short: false }
}

/// Bütün borçlar için ilk ayın asgari/taksit toplamı
pub fn minimum_monthly_cents(debts: &[Debt]) -> i64 {
    debts
        .iter()
        .map(|d| {
            let due = d.first_due();
            let i = js_round(due as f64 * d.monthly_rate);
            minimum_due(d, due + i, i)
        })
        .sum()
}
