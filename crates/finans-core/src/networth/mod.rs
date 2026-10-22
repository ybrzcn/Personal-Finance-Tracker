//! Net servet geçmişi: ilk hesabın açılış ayından bugüne her ay sonu (son nokta bugün) için hesapların TL değeri.
//! Döviz/altın/fon bugünkü alış fiyatıyla ve maliyetle (Kâr/Zarar motoru o tarihe kadar yürütülür) değerlenir.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::cpi::{CpiData, CpiStatus};
use crate::db::{Account, Transaction};
use crate::fx::time::{civil_from_days, days_from_civil, parse_ymd, ymd};
use crate::fx;
use crate::pnl::{self, AssetFilter, CurrentRate, PnlInput};
use crate::CoreResult;

use crate::accounts::bank::{qty_at, tl_balance, tl_value, value_cents};
use crate::accounts::cards::{card_movements, debt_at, Movement};
use crate::accounts::loans::loan_balance;

pub struct NetWorthInput<'a> {
    pub accounts: &'a [Account],
    pub transactions: &'a [Transaction],
    /// Kod → güncel alış kuru (pnl ile aynı)
    pub rates: &'a HashMap<String, CurrentRate>,
    /// Hesap id → açılış günü kuru (pnl ile aynı)
    pub opening_rates: &'a HashMap<String, i64>,
    /// "YYYY-MM-DD"
    pub today: &'a str,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByKind {
    pub tl_cents: i64,
    pub fx_cents: i64,
    pub fund_cents: i64,
    /// Vadeli mevduat, BES ve diğer varlıklar (ev, araba)
    pub saving_cents: i64,
    /// Borçlar pozitif tutar
    pub card_cents: i64,
    pub loan_cents: i64,
    pub overdraft_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountValue {
    pub account_id: String,
    /// Borç hesaplarında eksi
    pub value_cents: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub date: String,
    pub assets_cents: i64,
    pub card_debt_cents: i64,
    pub loan_debt_cents: i64,
    pub overdraft_cents: i64,
    /// Bugünkü fiyatla
    pub net_cents: i64,
    /// Döviz/altın/fon maliyetle
    pub net_cost_cents: i64,
    pub by_kind: ByKind,
    pub accounts: Vec<AccountValue>,
    /// Kur alınamadığı için katılmayan hesap sayısı
    pub unvalued_count: i64,
    /// En az bir hesabın maliyeti bilinmiyor (maliyet çizgisine değeri girdi)
    pub cost_partial: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub account_id: String,
    pub name: String,
    pub kind: String,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetWorthReport {
    pub points: Vec<Point>,
    pub accounts: Vec<AccountInfo>,
    /// 1 yıl / 3 yıl / Tümü görünümleri: ilk nokta ve dönemdeki değişim
    pub ranges: Ranges,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Ranges {
    #[serde(rename = "1y")]
    pub y1: RangeSummary,
    #[serde(rename = "3y")]
    pub y3: RangeSummary,
    pub all: RangeSummary,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeSummary {
    /// Görünümün ilk noktası (`points` dizini)
    pub start: usize,
    /// İlk noktadan son noktaya net servet değişimi (bugünkü fiyatla)
    pub change_cents: i64,
    /// Değişimin kur/fiyat kazancından gelen kısmı
    pub fx_gain_cents: i64,
}

/// Görünümün özeti: ilk nokta `start`, son nokta bugün
pub fn range_summary(points: &[Point], start: usize) -> RangeSummary {
    match (points.get(start), points.last()) {
        (Some(f), Some(l)) => RangeSummary {
            start,
            change_cents: l.net_cents - f.net_cents,
            fx_gain_cents: l.net_cents - l.net_cost_cents - (f.net_cents - f.net_cost_cents),
        },
        _ => RangeSummary { start, ..Default::default() },
    }
}

/// Net servet döneminin (son `years` yıl) başlangıç noktası: kesim gününden (son noktadan `years` yıl önce) önceki ya da
/// o günkü son nokta; böylece dönemdeki değişim tam dönemi ölçer. Kesim dizge olarak kurulur (29 Şubat → "YYYY-02-29").
pub fn range_start(dates: &[&str], years: i64) -> usize {
    let Some(today) = dates.last() else { return 0 };
    let year: i64 = today.get(..4).and_then(|y| y.parse().ok()).unwrap_or(0);
    let cutoff = format!("{}{}", year - years, today.get(4..).unwrap_or(""));
    dates.iter().rposition(|d| *d <= cutoff.as_str()).unwrap_or(0)
}

fn last_day(y: i64, m: u32) -> String {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    ymd(days_from_civil(ny, nm, 1) - 1)
}

/// `first` ayından `today`'den önceki aya kadar ay sonları, ardından `today`
pub fn month_ends(first: &str, today: &str) -> Vec<String> {
    let (Some(f), Some(t)) = (parse_ymd(first), parse_ymd(today)) else { return vec![today.to_string()] };
    let (mut y, mut m, _) = civil_from_days(f);
    let (ty, tm, _) = civil_from_days(t);
    let mut out = Vec::new();
    while (y, m) < (ty, tm) {
        out.push(last_day(y, m));
        (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    }
    out.push(today.to_string());
    out
}

pub fn report(input: &NetWorthInput) -> CoreResult<NetWorthReport> {
    let accounts = input.accounts;
    for a in accounts {
        if a.currency != fx::TRY && fx::source_of(&a.currency).is_none() {
            return Err(format!("Bilinmeyen para birimi: {}", a.currency));
        }
    }
    let Some(first) = accounts.iter().map(|a| a.opening_date.as_str()).min() else {
        return Ok(NetWorthReport { points: Vec::new(), accounts: Vec::new(), ranges: Ranges::default() });
    };
    let cards: HashMap<&str, Vec<Movement>> =
        accounts.iter().filter(|a| a.kind == "credit_card").map(|a| (a.id.as_str(), card_movements(a, input.transactions))).collect();
    let has_foreign = accounts.iter().any(|a| a.kind != "loan" && a.kind != "credit_card" && a.currency != fx::TRY);
    let no_cpi = CpiData { series: None, status: CpiStatus::NoKey, message: None };
    let mut seen: HashSet<String> = HashSet::new();
    let mut points = Vec::new();
    for d in month_ends(first, input.today) {
        // Maliyet: Kâr/Zarar motoru bu tarihe kadar. Motor hata verirse (bozuk döviz kaydı) maliyetler bilinmiyor
        // sayılır; rapor yine döner. Hesap başına (maliyet, motorun miktarı, tutarsız çıkış var mı)
        let costs: HashMap<String, (Option<i64>, i64, bool)> = if has_foreign {
            match pnl::report(&PnlInput {
                accounts,
                transactions: input.transactions,
                rates: input.rates,
                opening_rates: input.opening_rates,
                cpi: &no_cpi,
                today: &d,
                from: None,
                to: None,
                filter: AssetFilter::All,
                income_categories: None,
            }) {
                Ok(r) => r.accounts.into_iter().map(|p| (p.account_id, (p.cost_cents, p.qty_minor, p.inconsistent_since.is_some()))).collect(),
                Err(_) => HashMap::new(),
            }
        } else {
            HashMap::new()
        };
        let mut p = Point {
            date: d.clone(),
            assets_cents: 0,
            card_debt_cents: 0,
            loan_debt_cents: 0,
            overdraft_cents: 0,
            net_cents: 0,
            net_cost_cents: 0,
            by_kind: ByKind::default(),
            accounts: Vec::new(),
            unvalued_count: 0,
            cost_partial: false,
        };
        let (mut fx_value, mut fx_cost) = (0i64, 0i64);
        let last = d == input.today;
        // Açılışı gelecekte olan hesap bugünkü noktada sayılır (arayüzdeki bugünkü toplamla aynı)
        for a in accounts.iter().filter(|a| a.opening_date <= d || last) {
            let value = match a.kind.as_str() {
                "loan" => {
                    let v = loan_balance(a, input.transactions, &d);
                    p.loan_debt_cents += v;
                    p.by_kind.loan_cents += v;
                    -v
                }
                "credit_card" => {
                    let v = debt_at(&cards[a.id.as_str()], &d);
                    p.card_debt_cents += v;
                    p.by_kind.card_cents += v;
                    -v
                }
                _ if a.currency != fx::TRY => {
                    let unit = fx::unit_or_try(Some(&a.currency));
                    let Some(r) = input.rates.get(&a.currency) else {
                        p.unvalued_count += 1;
                        continue;
                    };
                    let qty = qty_at(a, unit, input.transactions, &d);
                    let v = value_cents(qty, r.buy, unit);
                    // Eldekinden fazla çıkış (motor miktarı 0'a sabitler) ya da bilinmeyen maliyet: maliyet = değer
                    let cost = match costs.get(&a.id) {
                        Some(&(Some(c), q, false)) if q == qty => c,
                        _ => {
                            p.cost_partial |= v != 0;
                            v
                        }
                    };
                    fx_value += v;
                    fx_cost += cost;
                    p.assets_cents += v;
                    if fx::is_fund(&a.currency) {
                        p.by_kind.fund_cents += v;
                    } else {
                        p.by_kind.fx_cents += v;
                    }
                    v
                }
                _ if a.is_saving() => {
                    // Mevduat (bakiye), BES ve diğer varlık (son elle değerleme)
                    let v = tl_value(a, input.transactions, &d);
                    p.assets_cents += v;
                    p.by_kind.saving_cents += v;
                    v
                }
                _ => {
                    let b = tl_balance(a, input.transactions, &d);
                    if a.kind == "bank" && b < 0 {
                        p.overdraft_cents += -b;
                        p.by_kind.overdraft_cents += -b;
                    } else {
                        p.assets_cents += b;
                        p.by_kind.tl_cents += b;
                    }
                    b
                }
            };
            seen.insert(a.id.clone());
            p.accounts.push(AccountValue { account_id: a.id.clone(), value_cents: value });
        }
        p.net_cents = p.assets_cents - p.card_debt_cents - p.loan_debt_cents - p.overdraft_cents;
        p.net_cost_cents = p.net_cents - fx_value + fx_cost;
        points.push(p);
    }
    let infos = accounts
        .iter()
        .filter(|a| seen.contains(&a.id))
        .map(|a| AccountInfo { account_id: a.id.clone(), name: a.name.clone(), kind: a.kind.clone(), currency: a.currency.clone() })
        .collect();
    let dates: Vec<&str> = points.iter().map(|p| p.date.as_str()).collect();
    let ranges = Ranges {
        y1: range_summary(&points, range_start(&dates, 1)),
        y3: range_summary(&points, range_start(&dates, 3)),
        all: range_summary(&points, 0),
    };
    Ok(NetWorthReport { points, accounts: infos, ranges })
}
