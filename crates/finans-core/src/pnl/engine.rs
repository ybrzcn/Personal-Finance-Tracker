//! Bütün işlemler tek tarih sırasıyla yürünür: edinimler maliyete eklenir, çıkışlarda ortalama maliyet düşülür;
//! aynı para birimli iki hesap arası transferde maliyet taşınır (satış sayılmaz).

use std::collections::{BTreeMap, HashMap};

use super::*;
use crate::cpi::{month_key, month_label, CpiSeries};
use crate::fx::amount::{signed_value_to_minor, tl_cents, value_to_minor};
use crate::fx::{self, Unit};

/// Sabit TL ölçeği: maliyet × REAL_SCALE / endeks
const REAL_SCALE: i128 = 1_000_000_000_000;

fn too_big() -> String {
    "Tutar çok büyük.".into()
}

/// Yarım sıfırdan uzağa yuvarlanan bölme (payda > 0)
fn div_round(n: i128, d: i128) -> i128 {
    let q = (n.abs() + d / 2) / d;
    if n < 0 {
        -q
    } else {
        q
    }
}

fn to_i64(v: i128) -> CoreResult<i64> {
    i64::try_from(v).map_err(|_| too_big())
}

fn bp(part: i128, base: i128) -> CoreResult<Option<i64>> {
    if base <= 0 {
        return Ok(None);
    }
    Ok(Some(to_i64(div_round(part * 10_000, base))?))
}

fn cents(amount: f64) -> i128 {
    (amount * 100.0).round() as i128
}

struct Holding {
    qty: i64,
    cost: i128,
    /// Sabit TL birimleri; None = TÜFE yok ya da bir edinimin ayı bulunamadı
    real: Option<i128>,
    unknown: bool,
    approx: bool,
    inconsistent_since: Option<String>,
}

/// Çıkışta düşülen pay
struct Taken {
    cost: i128,
    real: Option<i128>,
    unknown: bool,
}

fn index(series: Option<&CpiSeries>, date: &str) -> Option<(i64, bool)> {
    series?.index_at(month_key(date)?)
}

fn in_range(date: &str, from: Option<&str>, to: Option<&str>) -> bool {
    from.is_none_or(|f| date >= f) && to.is_none_or(|t| date <= t)
}

/// "…T10:00:01.1Z" ile "…T10:00:01.12Z" metin olarak yanlış sıralanır: kesir 9 haneye tamamlanır.
fn created_key(s: &str) -> String {
    let s = s.trim_end_matches('Z');
    let (base, frac) = s.split_once('.').unwrap_or((s, ""));
    format!("{base}.{frac:0<9}")
}

fn opening(a: &Account, unit: Unit, input: &PnlInput, series: Option<&CpiSeries>) -> CoreResult<Holding> {
    let mut h = Holding { qty: 0, cost: 0, real: series.map(|_| 0), unknown: false, approx: false, inconsistent_since: None };
    let open = signed_value_to_minor(a.opening_balance, unit)?;
    if open < 0 {
        h.inconsistent_since = Some(a.opening_date.clone());
    } else if open > 0 {
        let cost = match (a.opening_cost.flatten(), input.opening_rates.get(&a.id)) {
            (Some(c), _) => Some(cents(c)),
            (None, Some(r)) => Some(tl_cents(open, *r, unit)? as i128),
            (None, None) => None,
        };
        h.qty = open;
        match cost {
            Some(c) => acquire(&mut h, c, &a.opening_date, series),
            None => h.unknown = true,
        }
    }
    Ok(h)
}

/// Eldekinden `qty` çıkarır: ortalama maliyetle düşülen pay döner. Eldekinden fazlası maliyetsiz sayılır.
fn take(h: &mut Holding, qty: i64, date: &str, series: Option<&CpiSeries>) -> Taken {
    let held = h.qty.max(0);
    let covered = qty.min(held);
    if qty > held && h.inconsistent_since.is_none() {
        h.inconsistent_since = Some(date.to_string());
    }
    let (cost, real) = if covered == 0 {
        (0, Some(0))
    } else if covered == held {
        (h.cost, h.real)
    } else {
        (div_round(h.cost * covered as i128, held as i128), h.real.map(|u| div_round(u * covered as i128, held as i128)))
    };
    let unknown = h.unknown;
    h.cost -= cost;
    h.real = h.real.zip(real).map(|(u, x)| u - x);
    h.qty = held - covered;
    if h.qty == 0 {
        h.cost = 0;
        h.unknown = false;
        h.approx = false;
        h.real = series.map(|_| 0);
    }
    Taken { cost, real, unknown }
}

pub fn report(input: &PnlInput) -> CoreResult<PnlReport> {
    let series = input.cpi.series.as_ref();
    let foreign_accounts: Vec<&Account> = input.accounts.iter().filter(|a| foreign(a)).collect();
    let mut hold: HashMap<&str, Holding> = HashMap::new();
    let mut acc: HashMap<&str, (&Account, Unit)> = HashMap::new();
    for a in &foreign_accounts {
        let unit = fx::unit_or_try(Some(&a.currency));
        hold.insert(a.id.as_str(), opening(a, unit, input, series)?);
        acc.insert(a.id.as_str(), (a, unit));
    }
    let mut txs: Vec<(String, u8, &Transaction)> = input
        .transactions
        .iter()
        .filter(|t| t.date.as_str() <= input.today)
        .map(|t| {
            // Aynı an (toplu ekleme, geri yükleme) eşitliğinde edinim önce: yanlışlıkla "eldekinden fazla satış" olmasın
            let held = |id: Option<&str>| id.is_some_and(|id| acc.contains_key(id));
            let acquisition = (t.kind == "income" && held(Some(&t.account_id)))
                || (t.kind == "transfer" && !held(Some(&t.account_id)) && held(t.to_account_id.as_deref()));
            (created_key(&t.created_at), if acquisition { 0 } else { 1 }, t)
        })
        .collect();
    txs.sort_by(|x, y| (&x.2.date, &x.0, x.1, &x.2.id).cmp(&(&y.2.date, &y.0, y.1, &y.2.id)));

    let mut realized = Vec::new();
    for (_, _, t) in txs {
        let src = acc.get(t.account_id.as_str()).copied();
        let dst = match (t.kind.as_str(), t.to_account_id.as_deref()) {
            ("transfer", Some(id)) => acc.get(id).copied(),
            _ => None,
        };
        let out_qty = match (src, t.orig_amount) {
            (Some((_, unit)), Some(q)) => Some(value_to_minor(q, unit)?),
            _ => None,
        };
        let in_qty = match (dst, t.to_orig_amount) {
            (Some((_, unit)), Some(q)) => Some(value_to_minor(q, unit)?),
            _ => None,
        };
        let amount = cents(t.amount);
        match (t.kind.as_str(), src, out_qty) {
            ("income", Some((a, _)), Some(q)) => {
                let h = hold.get_mut(a.id.as_str()).expect("hesap");
                h.qty += q;
                acquire(h, amount, &t.date, series);
                continue;
            }
            ("transfer", Some((a, _)), Some(q)) => {
                // Aynı para birimli iki hesap arası: satış değil, maliyet (ve reel birimler) taşınır
                if let (Some((b, _)), Some(qin)) = (dst, in_qty) {
                    if a.currency == b.currency {
                        let taken = take(hold.get_mut(a.id.as_str()).expect("hesap"), q, &t.date, series);
                        let h = hold.get_mut(b.id.as_str()).expect("hesap");
                        h.qty += qin;
                        h.cost += taken.cost;
                        h.real = h.real.zip(taken.real).map(|(u, x)| u + x);
                        h.unknown |= taken.unknown;
                        continue;
                    }
                }
            }
            _ => {}
        }
        // Çıkış (gider ya da başka birime/TL'ye transfer)
        if let (Some((a, _)), Some(q), "expense" | "transfer") = (src, out_qty, t.kind.as_str()) {
            let taken = take(hold.get_mut(a.id.as_str()).expect("hesap"), q, &t.date, series);
            if in_range(&t.date, input.from, input.to) {
                let sale_idx = index(series, &t.date);
                let real_pnl = match (taken.real, sale_idx, taken.unknown) {
                    (Some(u), Some((i, _)), false) => Some(to_i64(amount - div_round(u * i as i128, REAL_SCALE))?),
                    _ => None,
                };
                realized.push(RealizedItem {
                    transaction_id: t.id.clone(),
                    date: t.date.clone(),
                    account_id: a.id.clone(),
                    kind: t.kind.clone(),
                    qty_minor: q,
                    qty: fx::qty_of(q, &a.currency),
                    currency: a.currency.clone(),
                    proceeds_cents: to_i64(amount)?,
                    cost_cents: if taken.unknown { None } else { Some(to_i64(taken.cost)?) },
                    pnl_cents: if taken.unknown { None } else { Some(to_i64(amount - taken.cost)?) },
                    real_pnl_cents: real_pnl,
                    cost_unknown: taken.unknown,
                    cpi_approx: sale_idx.is_some_and(|(_, ap)| ap),
                });
            }
        }
        // Giriş (TL'den ya da başka birimden alım)
        if let (Some((b, _)), Some(q)) = (dst, in_qty) {
            let h = hold.get_mut(b.id.as_str()).expect("hesap");
            h.qty += q;
            acquire(h, amount, &t.date, series);
        }
    }

    let mut accounts = Vec::new();
    for a in &foreign_accounts {
        let h = &hold[a.id.as_str()];
        if a.archived && h.qty == 0 {
            continue;
        }
        accounts.push(account_row(a, acc[a.id.as_str()].1, h, input, series)?);
    }
    // Süzgeç yürüyüşten sonra: fondan dövize transferde maliyet doğru taşınsın
    accounts.retain(|a| input.filter.matches(&a.currency));
    realized.retain(|r| input.filter.matches(&r.currency));
    realized.sort_by(|x, y| (&x.date, &x.transaction_id).cmp(&(&y.date, &y.transaction_id)));
    let months = months(&realized, input)?;
    let totals = totals(&accounts, &realized)?;
    let latest = series.and_then(|s| s.latest());
    Ok(PnlReport {
        accounts,
        realized,
        months,
        totals,
        cpi: CpiInfo { status: input.cpi.status, latest_month: latest.map(|(k, _)| month_label(k)), message: input.cpi.message.clone() },
    })
}

fn acquire(h: &mut Holding, cost: i128, date: &str, series: Option<&CpiSeries>) {
    h.cost += cost;
    h.real = match (h.real, index(series, date)) {
        (Some(u), Some((i, ap))) => {
            h.approx |= ap;
            Some(u + div_round(cost * REAL_SCALE, i as i128))
        }
        _ => None,
    };
}

fn account_row(a: &Account, unit: Unit, h: &Holding, input: &PnlInput, series: Option<&CpiSeries>) -> CoreResult<AccountPnl> {
    let rate = input.rates.get(&a.currency);
    let value: Option<i128> = match (h.qty, rate) {
        (0, _) => Some(0),
        (q, Some(r)) => Some(tl_cents(q, r.buy, unit)? as i128),
        (_, None) => None,
    };
    let cost = (!h.unknown).then_some(h.cost);
    let unrealized = value.zip(cost).map(|(v, c)| v - c);
    let latest = series.and_then(|s| s.latest());
    let real_cost = match (h.real, latest, h.unknown, h.qty) {
        (Some(u), Some((_, i)), false, q) if q > 0 => Some(div_round(u * i as i128, REAL_SCALE)),
        _ => None,
    };
    let real_unrealized = value.zip(real_cost).map(|(v, c)| v - c);
    Ok(AccountPnl {
        account_id: a.id.clone(),
        name: a.name.clone(),
        currency: a.currency.clone(),
        qty_minor: h.qty,
        qty: fx::qty_of(h.qty, &a.currency),
        cost_cents: cost.map(to_i64).transpose()?,
        avg_cost_micros: match cost {
            Some(c) if h.qty > 0 => Some(to_i64(div_round(c * unit.divisor() as i128 * 10_000, h.qty as i128))?),
            _ => None,
        },
        rate_micros: rate.map(|r| r.buy),
        rate_observed_at: rate.map(|r| r.observed_at.clone()),
        value_cents: value.map(to_i64).transpose()?,
        unrealized_cents: unrealized.map(to_i64).transpose()?,
        unrealized_bp: match unrealized.zip(cost) {
            Some((u, c)) => bp(u, c)?,
            None => None,
        },
        real_cost_cents: real_cost.map(to_i64).transpose()?,
        real_unrealized_cents: real_unrealized.map(to_i64).transpose()?,
        real_unrealized_bp: match real_unrealized.zip(real_cost) {
            Some((u, c)) => bp(u, c)?,
            None => None,
        },
        inflation_bp: match real_cost.zip(cost) {
            Some((r, c)) => bp(r - c, c)?,
            None => None,
        },
        cost_unknown: h.unknown && h.qty > 0,
        inconsistent_since: h.inconsistent_since.clone(),
        rate_stale: rate.is_some_and(|r| r.stale),
        no_rate: h.qty > 0 && rate.is_none(),
        cpi_approx: h.approx && real_cost.is_some(),
    })
}

fn months(items: &[RealizedItem], input: &PnlInput) -> CoreResult<Vec<MonthTotal>> {
    let start = match input.from {
        Some(f) => month_key(f),
        None => items.first().and_then(|i| month_key(&i.date)),
    };
    let end = month_key(input.to.unwrap_or(input.today));
    let (Some(start), Some(end)) = (start, end) else { return Ok(Vec::new()) };
    let real0 = input.cpi.series.as_ref().map(|_| 0i128);
    let mut map: BTreeMap<i32, (i128, Option<i128>, bool)> = (start..=end).map(|k| (k, (0, real0, false))).collect();
    for i in items {
        let Some(e) = month_key(&i.date).and_then(|k| map.get_mut(&k)) else { continue };
        match i.pnl_cents {
            Some(p) => e.0 += p as i128,
            None => e.2 = true,
        }
        e.1 = e.1.zip(i.real_pnl_cents).map(|(a, b)| a + b as i128);
    }
    map.into_iter()
        .map(|(k, (p, r, partial))| {
            Ok(MonthTotal { month: month_label(k), pnl_cents: to_i64(p)?, real_pnl_cents: r.map(to_i64).transpose()?, partial })
        })
        .collect()
}

fn totals(accounts: &[AccountPnl], items: &[RealizedItem]) -> CoreResult<PnlTotals> {
    // Değer: değeri bilinen bütün hesaplar. Maliyet ve kâr/zarar: hem değeri hem maliyeti bilinenler.
    let (mut cost, mut value, mut valued, mut real_cost) = (0i128, 0i128, 0i128, Some(0i128));
    let mut partial = false;
    for a in accounts {
        if let Some(v) = a.value_cents {
            value += v as i128;
        }
        match (a.cost_cents, a.value_cents) {
            (Some(c), Some(v)) => {
                cost += c as i128;
                valued += v as i128;
                real_cost = match (real_cost, a.real_cost_cents, a.qty_minor) {
                    (r, _, 0) => r,
                    (Some(r), Some(x), _) => Some(r + x as i128),
                    _ => None,
                };
            }
            _ => partial = true,
        }
    }
    let mut realized = 0i128;
    let mut real_realized = Some(0i128);
    for i in items {
        match i.pnl_cents {
            Some(p) => realized += p as i128,
            None => partial = true,
        }
        real_realized = real_realized.zip(i.real_pnl_cents).map(|(a, b)| a + b as i128);
    }
    let any_real = accounts.iter().any(|a| a.real_cost_cents.is_some());
    let real_cost = real_cost.filter(|_| any_real);
    let real_unrealized = real_cost.map(|r| valued - r);
    Ok(PnlTotals {
        cost_cents: to_i64(cost)?,
        value_cents: to_i64(value)?,
        unrealized_cents: to_i64(valued - cost)?,
        unrealized_bp: bp(valued - cost, cost)?,
        real_unrealized_cents: real_unrealized.map(to_i64).transpose()?,
        real_unrealized_bp: match real_unrealized.zip(real_cost) {
            Some((u, r)) => bp(u, r)?,
            None => None,
        },
        inflation_bp: match real_cost {
            Some(r) => bp(r - cost, cost)?,
            None => None,
        },
        realized_cents: to_i64(realized)?,
        real_realized_cents: if items.iter().any(|i| i.real_pnl_cents.is_some()) { real_realized.map(to_i64).transpose()? } else { None },
        partial,
    })
}
