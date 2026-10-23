//! Dönemsel raporlar: seçilen dönemde kategori / hesap / etiket kırılımı, önceki dönemle ya da geçen yılla karşılaştırma,
//! aylık seyir ve gelir akışı (gelir kaynakları → giderler ve birikim). Harcama tarihine göre; taksitler kendi aylarına
//! dağıtılır, transferler sayılmaz. Gelirler Bütçe'deki gibi bütçe ayında sayılır (10 Ekim'de yatan Eylül maaşı Eylül'de).
//! Tutarlar kuruş.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use crate::accounts::cards::{add_days, clamped_date, spread_installments};
use crate::budget::income::income_budget_dates;
use crate::budget::recurring::shift_month;
use crate::db::{Category, RecurringItem, Transaction};
use crate::fx::time::{days_between, parse_ymd};
use crate::CoreResult;

/// Akış diyagramında adıyla gösterilen en çok kalem (kalanı "Diğer")
const FLOW_TOP: usize = 7;

pub struct ReportsInput<'a> {
    pub transactions: &'a [Transaction],
    pub categories: &'a [Category],
    /// Gelirin bütçe ayı için (önceki ayı karşılayan maaş)
    pub recurring: &'a [RecurringItem],
    /// "thisMonth" | "lastMonth" | "thisYear" | "lastYear" | "last12" | "custom"
    pub preset: &'a str,
    /// Yalnız "custom": YYYY-MM-DD (dahil)
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
    /// "previous" (bir önceki eşdeğer dönem) | "lastYear" (geçen yılın aynı dönemi) | "none"
    pub compare: &'a str,
    /// "expense" | "income"
    pub kind: &'a str,
    /// "category" | "account" | "tag"
    pub group: &'a str,
    /// YYYY-MM-DD
    pub today: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DateRange {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub income_cents: i64,
    pub expense_cents: i64,
    pub net_cents: i64,
    /// Net / gelir, baz puan; gelir yoksa None
    pub savings_rate_bp: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    /// Kategori / hesap / etiket kimliği; None: kategorisiz ya da etiketsiz
    pub key: Option<String>,
    pub cents: i64,
    pub count: i64,
    /// Seçili türün toplamına oranı, baz puan (etikette bir işlem birden çok satıra girebilir)
    pub share_bp: i64,
    pub compare_cents: Option<i64>,
    pub delta_cents: Option<i64>,
    /// Karşılaştırma dönemine göre değişim, baz puan; o dönemde yoksa None
    pub delta_bp: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthPoint {
    /// "YYYY-MM"
    pub month: String,
    pub cents: i64,
    /// Karşılaştırma döneminin aynı sıradaki ayı
    pub compare_cents: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowItem {
    /// Kategori kimliği; None: kategorisiz; "other": kalan küçük kalemler
    pub key: Option<String>,
    pub cents: i64,
}

/// Gelir akışı: gelir kaynakları (kategori) → toplam gelir → giderler (kategori) ve birikim (artı) ya da açık (eksi)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    pub incomes: Vec<FlowItem>,
    pub expenses: Vec<FlowItem>,
    pub saved_cents: i64,
    /// Gider gelirden fazla: birikimden ya da borçla karşılanan
    pub deficit_cents: i64,
    /// Dönemde gelir de gider de yok (diyagram çizilmez)
    pub empty: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportsReport {
    pub range: DateRange,
    pub compare_range: Option<DateRange>,
    pub totals: Totals,
    pub compare_totals: Option<Totals>,
    /// Bu dönem − karşılaştırma dönemi (gelir, gider, net)
    pub totals_delta: Option<Totals>,
    /// Seçili tür ve kırılım; büyükten küçüğe
    pub rows: Vec<Row>,
    pub months: Vec<MonthPoint>,
    pub flow: Flow,
}

/// Harcama tarihine dağıtılmış parça (taksitler kendi aylarında)
struct Part<'a> {
    t: &'a Transaction,
    date: String,
    cents: i64,
}

fn parts<'a>(txs: &'a [Transaction], recurring: &'a [RecurringItem], today: &str) -> Vec<Part<'a>> {
    // Gelir bütçe ayında (taksit yalnız giderde; gelir tek parça)
    let moved = income_budget_dates(txs, recurring, today);
    txs.iter()
        .filter(|t| t.kind == "income" || t.kind == "expense")
        .flat_map(|t| {
            let moved = moved.get(t.id.as_str()).cloned();
            spread_installments(t).into_iter().map(move |p| Part { t, date: moved.clone().unwrap_or(p.date), cents: p.cents })
        })
        .collect()
}

fn ym0(date: &str) -> (i64, i64, i64) {
    let n = |r: std::ops::Range<usize>| date.get(r).and_then(|s| s.parse::<i64>().ok()).unwrap_or(1);
    (n(0..4), n(5..7) - 1, n(8..10))
}

/// Tarihi `months` ay kaydırır (ay sonuna sıkıştırarak: 31 Mart − 1 ay = 28/29 Şubat)
fn shift_date(date: &str, months: i64) -> String {
    let (y, m, d) = ym0(date);
    clamped_date(y, m + months, d)
}

fn month_last(date: &str) -> String {
    let (y, m, _) = ym0(date);
    clamped_date(y, m, 31)
}

/// Dönem sonunu kaydırır: ay sonuysa yine ay sonu (30 Eylül − 1 ay = 31 Ağustos)
fn shift_end(date: &str, months: i64) -> String {
    if date == month_last(date) {
        month_last(&shift_date(date, months))
    } else {
        shift_date(date, months)
    }
}

/// Aralık tam aylardan oluşuyorsa ay sayısı
fn whole_months(from: &str, to: &str) -> Option<i64> {
    let ((fy, fm, fd), (ty, tm, _)) = (ym0(from), ym0(to));
    (fd == 1 && to == month_last(to)).then(|| (ty * 12 + tm) - (fy * 12 + fm) + 1)
}

/// Seçilen dönem ve karşılaştırma dönemi. "Bu ay / bu yıl" bugüne kadar; karşılaştırması aynı uzunlukta.
pub fn ranges(preset: &str, from: Option<&str>, to: Option<&str>, compare: &str, today: &str) -> CoreResult<(DateRange, Option<DateRange>)> {
    let (y, m, _) = ym0(today);
    let month_start = clamped_date(y, m, 1);
    let r = |f: String, t: String| DateRange { from: f, to: t };
    let (cur, prev) = match preset {
        "thisMonth" => (r(month_start.clone(), today.into()), r(shift_date(&month_start, -1), shift_end(today, -1))),
        "lastMonth" => {
            let s = shift_date(&month_start, -1);
            (r(s.clone(), month_last(&s)), r(shift_date(&s, -1), month_last(&shift_date(&s, -1))))
        }
        "thisYear" => (r(format!("{y}-01-01"), today.into()), r(format!("{}-01-01", y - 1), shift_date(today, -12))),
        "lastYear" => (r(format!("{}-01-01", y - 1), format!("{}-12-31", y - 1)), r(format!("{}-01-01", y - 2), format!("{}-12-31", y - 2))),
        // Bu ay bugüne kadar (gelecek tarihli kayıtlar ve taksit parçaları sayılmaz; "bu ay" ile aynı)
        "last12" => {
            let s = shift_date(&month_start, -11);
            (r(s.clone(), today.into()), r(shift_date(&s, -12), shift_end(today, -12)))
        }
        "custom" => {
            let (f, t) = (from.unwrap_or_default(), to.unwrap_or_default());
            if parse_ymd(f).is_none() || parse_ymd(t).is_none() {
                return Err("Geçerli bir başlangıç ve bitiş tarihi girin.".into());
            }
            if f > t {
                return Err("Başlangıç tarihi bitişten sonra olamaz.".into());
            }
            let len = days_between(f, t);
            if len > 3660 {
                return Err("Dönem en çok 10 yıl olabilir.".into());
            }
            // Tam aylarsa önceki aynı sayıda ay (Mart → Şubat), değilse aynı gün sayısı
            let prev = match whole_months(f, t) {
                Some(n) => r(shift_date(f, -n), month_last(&shift_date(t, -n))),
                None => {
                    let p_to = add_days(f, -1);
                    r(add_days(&p_to, -len), p_to)
                }
            };
            (r(f.into(), t.into()), prev)
        }
        other => return Err(format!("Geçersiz dönem: {other}")),
    };
    let compare_range = match compare {
        "previous" => Some(prev),
        "lastYear" => Some(r(shift_date(&cur.from, -12), shift_end(&cur.to, -12))),
        "none" => None,
        other => return Err(format!("Geçersiz karşılaştırma: {other}")),
    };
    Ok((cur, compare_range))
}

fn totals(parts: &[Part], range: &DateRange) -> Totals {
    let (mut inc, mut exp) = (0, 0);
    for p in parts.iter().filter(|p| p.date >= range.from && p.date <= range.to) {
        match p.t.kind.as_str() {
            "income" => inc += p.cents,
            _ => exp += p.cents,
        }
    }
    Totals {
        income_cents: inc,
        expense_cents: exp,
        net_cents: inc - exp,
        savings_rate_bp: (inc > 0).then(|| ((inc - exp) as i128 * 10_000 / inc as i128) as i64),
    }
}

/// Seçili tür ve kırılıma göre (anahtar → (kuruş, adet)); etikette işlem her etiketine, etiketsizse None'a
fn grouped(parts: &[Part], range: &DateRange, kind: &str, group: &str) -> HashMap<Option<String>, (i64, i64)> {
    let mut out: HashMap<Option<String>, (i64, i64)> = HashMap::new();
    for p in parts.iter().filter(|p| p.t.kind == kind && p.date >= range.from && p.date <= range.to) {
        let keys: Vec<Option<String>> = match group {
            "account" => vec![Some(p.t.account_id.clone())],
            "tag" if !p.t.tag_ids.is_empty() => p.t.tag_ids.iter().map(|t| Some(t.clone())).collect(),
            "tag" => vec![None],
            _ => vec![p.t.category_id.clone().filter(|c| !c.is_empty())],
        };
        for k in keys {
            let e = out.entry(k).or_default();
            e.0 += p.cents;
            e.1 += 1;
        }
    }
    out
}

/// Oran, baz puan (yarım yukarı, işaretten bağımsız)
fn bp(part: i64, whole: i64) -> i64 {
    if whole == 0 {
        0
    } else {
        (part as f64 * 10_000.0 / whole as f64).round() as i64
    }
}

/// Aylık seri: dönemin ayları; karşılaştırmanın aynı sıradaki ayı
fn months(parts: &[Part], kind: &str, range: &DateRange, compare: Option<&DateRange>) -> Vec<MonthPoint> {
    let sum = |r: &DateRange| -> BTreeMap<String, i64> {
        let mut m = BTreeMap::new();
        for p in parts.iter().filter(|p| p.t.kind == kind && p.date >= r.from && p.date <= r.to) {
            *m.entry(p.date[..7].to_string()).or_default() += p.cents;
        }
        m
    };
    let list = |r: &DateRange| -> Vec<String> {
        let mut out = Vec::new();
        let mut m = r.from[..7].to_string();
        while m.as_str() <= &r.to[..7] && out.len() < 240 {
            out.push(m.clone());
            m = shift_month(&m, 1);
        }
        out
    };
    let cur = sum(range);
    let (cmp, cmp_months) = match compare {
        Some(c) => (sum(c), list(c)),
        None => (BTreeMap::new(), Vec::new()),
    };
    list(range)
        .into_iter()
        .enumerate()
        .map(|(i, month)| MonthPoint {
            cents: cur.get(&month).copied().unwrap_or(0),
            compare_cents: compare.map(|_| cmp_months.get(i).and_then(|m| cmp.get(m)).copied().unwrap_or(0)),
            month,
        })
        .collect()
}

/// Kategoriye göre, büyükten küçüğe; ilk `FLOW_TOP` adıyla, kalanı "Diğer"
fn flow_side(parts: &[Part], range: &DateRange, kind: &str) -> Vec<FlowItem> {
    let mut by: Vec<(Option<String>, i64)> = grouped(parts, range, kind, "category").into_iter().map(|(k, (c, _))| (k, c)).filter(|(_, c)| *c > 0).collect();
    by.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let mut out: Vec<FlowItem> = by.iter().take(FLOW_TOP).map(|(k, c)| FlowItem { key: k.clone(), cents: *c }).collect();
    let rest: i64 = by.iter().skip(FLOW_TOP).map(|(_, c)| c).sum();
    if rest > 0 {
        out.push(FlowItem { key: Some("other".into()), cents: rest });
    }
    out
}

pub fn report(input: &ReportsInput) -> CoreResult<ReportsReport> {
    if !matches!(input.kind, "expense" | "income") {
        return Err(format!("Geçersiz tür: {}", input.kind));
    }
    if !matches!(input.group, "category" | "account" | "tag") {
        return Err(format!("Geçersiz kırılım: {}", input.group));
    }
    let (range, compare_range) = ranges(input.preset, input.from, input.to, input.compare, input.today)?;
    let parts = parts(input.transactions, input.recurring, input.today);
    let totals_now = totals(&parts, &range);
    let compare_totals = compare_range.as_ref().map(|c| totals(&parts, c));

    let cur = grouped(&parts, &range, input.kind, input.group);
    let cmp = compare_range.as_ref().map(|c| grouped(&parts, c, input.kind, input.group));
    let whole = if input.kind == "income" { totals_now.income_cents } else { totals_now.expense_cents };
    let mut rows: Vec<Row> = cur
        .iter()
        .map(|(k, (cents, count))| {
            let before = cmp.as_ref().map(|m| m.get(k).map_or(0, |e| e.0));
            Row {
                key: k.clone(),
                cents: *cents,
                count: *count,
                share_bp: bp(*cents, whole),
                compare_cents: before,
                delta_cents: before.map(|b| cents - b),
                delta_bp: before.filter(|b| *b != 0).map(|b| bp(cents - b, b)),
            }
        })
        .collect();
    // Karşılaştırma döneminde olup bu dönemde olmayan kalemler de (0 ile) görünür
    if let Some(m) = &cmp {
        for (k, (before, _)) in m.iter().filter(|(k, _)| !cur.contains_key(*k)) {
            rows.push(Row { key: k.clone(), cents: 0, count: 0, share_bp: 0, compare_cents: Some(*before), delta_cents: Some(-before), delta_bp: Some(-10_000) });
        }
    }
    let name: HashMap<&str, &str> = input.categories.iter().map(|c| (c.id.as_str(), c.name.as_str())).collect();
    rows.sort_by(|a, b| {
        b.cents.cmp(&a.cents).then(b.compare_cents.cmp(&a.compare_cents)).then_with(|| {
            let n = |r: &Row| r.key.as_deref().and_then(|k| name.get(k).copied()).unwrap_or("");
            crate::order::cmp_tr(n(a), n(b))
        })
        // Hesap ve etiket satırlarında da sabit sıra (eşit tutarlar her istekte yer değiştirmesin)
        .then_with(|| a.key.cmp(&b.key))
    });

    let incomes = flow_side(&parts, &range, "income");
    let expenses = flow_side(&parts, &range, "expense");
    let flow = Flow {
        empty: totals_now.income_cents == 0 && totals_now.expense_cents == 0,
        saved_cents: totals_now.net_cents.max(0),
        deficit_cents: (-totals_now.net_cents).max(0),
        incomes,
        expenses,
    };
    let totals_delta = compare_totals.as_ref().map(|c| Totals {
        income_cents: totals_now.income_cents - c.income_cents,
        expense_cents: totals_now.expense_cents - c.expense_cents,
        net_cents: totals_now.net_cents - c.net_cents,
        savings_rate_bp: None,
    });
    Ok(ReportsReport {
        totals_delta,
        months: months(&parts, input.kind, &range, compare_range.as_ref()),
        range,
        compare_range,
        totals: totals_now,
        compare_totals,
        rows,
        flow,
    })
}
