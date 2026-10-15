//! Fon fiyatı önbelleği (masaüstü, SQLite ve Postgres sunucusu ortak). Ağ istekleri kilit dışında;
//! istek sınırı ve hata sonrası bekleme `tefas::Limiter` ile.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

use super::sources::{RateView, Quote};
use super::tefas::{fetch_fund, fetch_list, fund_quote, FundKind, FundPrice, Limiter};
use super::time::*;
use super::{fund_code, live::REFRESH_SECS};
use crate::CoreResult;

/// Liste önbelleği süresi
const LIST_TTL: i64 = 3600;
/// Liste penceresi (gün): uzun bayram tatilinde de son fiyat bulunsun
const LIST_DAYS: i64 = 14;
/// Bellekte tutulan en fazla geçmiş gün (fon × gün)
const AT_MAX: usize = 4000;
/// Listede olmayan (kapanmış) fonun son fiyatı en çok bu kadar gün geriye aranır
const GONE_DAYS: i64 = 92;

#[derive(Clone, Copy)]
pub struct FundSource {
    pub list: fn(FundKind, i64, i64) -> CoreResult<Vec<FundPrice>>,
    pub range: fn(&str, FundKind, i64, i64) -> CoreResult<Vec<FundPrice>>,
}

pub const TEFAS: FundSource = FundSource { list: fetch_list, range: fetch_fund };

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FundHit {
    /// TEFAS kodu (öneksiz)
    pub code: String,
    pub name: String,
    /// "YAT" | "BYF"
    pub kind: &'static str,
    pub kind_label: &'static str,
    pub price: f64,
    pub date: String,
}

#[derive(Default)]
struct State {
    /// Tür → (son deneme, son 14 günün fiyatları)
    lists: HashMap<FundKind, (i64, Vec<FundPrice>)>,
    /// Liste alınamadıysa: tür → yeniden deneme zamanı (önbellek süresi beklenmez)
    list_retry: HashMap<FundKind, i64>,
    /// (öneksiz kod, gün) → o güne kadarki son fiyat (None = 10 günde yayın yok)
    at: HashMap<(String, i64), Option<FundPrice>>,
    /// (öneksiz kod, başlangıç, bitiş) → tam çekilmiş geçmiş (bugün çekildiyse geçerli)
    history: HashMap<(String, i64, i64), (i64, Vec<FundPrice>)>,
    /// Listede olmayan fonlar: öneksiz kod → o günkü arama (istek sınırına takılırsa sonraki çağrıda kaldığı yerden sürer)
    gone: HashMap<String, Gone>,
    limiter: Limiter,
    last_error: Option<String>,
}

#[derive(Clone)]
struct Gone {
    day: i64,
    /// Sıradaki istek: (tür sırası, bitiş günü); bittiyse yok
    next: Option<(usize, i64)>,
    price: Option<FundPrice>,
}

pub struct FundCache {
    src: FundSource,
    state: Mutex<State>,
}

fn view(p: &FundPrice, prev: Option<i64>, now: i64) -> RateView {
    RateView::from_quote(&fund_quote(p), prev, now)
}

impl FundCache {
    pub fn new(src: FundSource) -> Self {
        FundCache { src, state: Mutex::new(State::default()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn log(s: &mut State, e: &str) {
        if s.last_error.as_deref() != Some(e) {
            eprintln!("fon: {e}");
            s.last_error = Some(e.to_string());
        }
    }

    /// Ağ çağrısı: sınır kilit altında ayrılır, istek kilit dışında yapılır; hata sonrası bekleme başlar.
    fn call<T>(&self, now: i64, f: impl FnOnce() -> CoreResult<T>) -> CoreResult<T> {
        {
            let mut s = self.lock();
            if let Err(e) = s.limiter.check(now) {
                Self::log(&mut s, &e);
                return Err(e);
            }
        }
        let r = f();
        if let Err(e) = &r {
            let mut s = self.lock();
            s.limiter.failed(now);
            Self::log(&mut s, e);
        }
        r
    }

    /// İki türün son 14 günlük listesi (1 saat önbellek; `refresh` en çok 60 sn'de bir). Hata olursa eldeki;
    /// alınamayan liste bekleme süresi (istek sınırı/10 dk) bitince yeniden denenir.
    pub fn lists(&self, refresh: bool, now: i64) -> Vec<FundPrice> {
        let today = istanbul_today(now);
        for kind in FundKind::ALL {
            let due = {
                let mut s = self.lock();
                let at = s.lists.get(&kind).map(|x| x.0).unwrap_or(i64::MIN / 2);
                let retry = s.list_retry.get(&kind).is_some_and(|t| now >= *t);
                let due = now - at >= LIST_TTL || retry || (refresh && now - at >= REFRESH_SECS);
                if due {
                    // Deneme zamanı hemen yazılır: başka istek aynı listeyi yeniden çekmez
                    let old = s.lists.remove(&kind).map(|x| x.1).unwrap_or_default();
                    s.lists.insert(kind, (now, old));
                }
                due
            };
            if due {
                match self.call(now, || (self.src.list)(kind, today - LIST_DAYS, today)) {
                    Ok(list) if !list.is_empty() => {
                        let mut s = self.lock();
                        s.lists.insert(kind, (now, list));
                        s.list_retry.remove(&kind);
                    }
                    // Hata ya da istek sınırı: dakikada bir denenir (ağa gidilmesini sınırlayıcı belirler)
                    Err(_) => {
                        self.lock().list_retry.insert(kind, now + REFRESH_SECS);
                    }
                    Ok(_) => {
                        self.lock().list_retry.insert(kind, now + Limiter::RETRY_SECS);
                    }
                }
            }
        }
        let s = self.lock();
        FundKind::ALL.iter().flat_map(|k| s.lists.get(k).map(|x| x.1.clone()).unwrap_or_default()).collect()
    }

    pub fn kind_of(&self, code: &str) -> Option<FundKind> {
        let s = self.lock();
        FundKind::ALL.into_iter().find(|k| s.lists.get(k).is_some_and(|l| l.1.iter().any(|p| p.code == code)))
    }

    /// `FON:XXX` kodlarının son fiyatı ve bir önceki fiyat günü (günlük değişim). Listede olmayan (kapanmış)
    /// fon son 92 günde bulunan son fiyatıyla döner; hiç bulunamayan kod dönmez.
    pub fn latest(&self, codes: &[String], refresh: bool, now: i64) -> Vec<RateView> {
        if codes.is_empty() {
            return Vec::new();
        }
        let all = self.lists(refresh, now);
        codes
            .iter()
            .filter_map(|c| {
                let code = fund_code(c)?;
                let mut rows: Vec<&FundPrice> = all.iter().filter(|p| p.code == code).collect();
                rows.sort_by(|a, b| b.date.cmp(&a.date));
                match rows.first() {
                    Some(last) => Some(view(last, rows.get(1).map(|p| p.price), now)),
                    // Liste hiç alınamadıysa TEFAS'a ulaşılamıyordur: aranmaz
                    None if !all.is_empty() => self.last_known(code, now).map(|p| view(&p, None, now)),
                    None => None,
                }
            })
            .collect()
    }

    /// Listede olmayan fonun son fiyatı: türler sırayla, en yeniden geriye 28 günlük parçalarla. Çağrı başına tek
    /// istek (istek sınırını grafik ve geçmiş fiyatlara bırakır); arama sonraki çağrıda kaldığı yerden sürer,
    /// sonuç gün boyu saklanır.
    fn last_known(&self, fc: &str, now: i64) -> Option<FundPrice> {
        let today = istanbul_today(now);
        let mut g = self.lock().gone.get(fc).filter(|g| g.day == today).cloned().unwrap_or(Gone {
            day: today,
            next: Some((0, today)),
            price: None,
        });
        if let Some((k, end)) = g.next {
            let start = end - 27;
            let Ok(rows) = self.call(now, || (self.src.range)(fc, FundKind::ALL[k], start, end)) else { return None };
            if let Some(p) = rows.into_iter().filter(|p| p.code == fc).max_by(|a, b| a.date.cmp(&b.date)) {
                g.price = Some(p);
                g.next = None;
            } else if start <= today - GONE_DAYS {
                g.next = (k + 1 < FundKind::ALL.len()).then_some((k + 1, today));
            } else {
                g.next = Some((k, start - 1));
            }
        }
        let mut s = self.lock();
        if s.gone.len() >= 200 {
            s.gone.clear();
        }
        s.gone.insert(fc.to_string(), g.clone());
        g.price
    }

    /// `day` gününe kadarki son fiyat (en çok 10 gün geriye). Bugünün "yok" sonucu saklanmaz.
    pub fn at(&self, code: &str, day: i64, now: i64) -> CoreResult<Option<RateView>> {
        let fc = fund_code(code).ok_or_else(|| format!("Bilinmeyen para birimi: {code}"))?.to_string();
        let today = istanbul_today(now);
        if day > today {
            return Ok(None);
        }
        if let Some(hit) = self.lock().at.get(&(fc.clone(), day)).cloned() {
            return Ok(hit.map(|p| view(&p, None, now)));
        }
        // Güncel listede o güne kadar fiyat varsa ağa gidilmez
        let listed: Vec<FundPrice> = {
            let s = self.lock();
            FundKind::ALL.iter().filter_map(|k| s.lists.get(k)).flat_map(|l| l.1.iter().filter(|p| p.code == fc).cloned()).collect()
        };
        let in_list = listed.iter().filter(|p| parse_ymd(&p.date).is_some_and(|d| d <= day && d >= day - 10)).max_by(|a, b| a.date.cmp(&b.date));
        if let Some(p) = in_list {
            return Ok(Some(view(p, None, now)));
        }
        let kinds: Vec<FundKind> = match self.kind_of(&fc) {
            Some(k) => vec![k],
            None => FundKind::ALL.to_vec(),
        };
        let mut found = None;
        for kind in kinds {
            let rows = self.call(now, || (self.src.range)(&fc, kind, day - 10, day))?;
            if let Some(p) = rows.into_iter().filter(|p| parse_ymd(&p.date).is_some_and(|d| d <= day)).max_by(|a, b| a.date.cmp(&b.date)) {
                found = Some(p);
                break;
            }
        }
        if found.is_some() || day < today {
            let mut s = self.lock();
            if s.at.len() >= AT_MAX {
                s.at.clear();
            }
            s.at.insert((fc, day), found.clone());
        }
        Ok(found.map(|p| view(&p, None, now)))
    }

    /// Fonun `[from, to]` günlük fiyatları (en çok 92 gün; 28 günlük parçalar).
    pub fn history(&self, code: &str, from: i64, to: i64, now: i64) -> CoreResult<Vec<RateView>> {
        let fc = fund_code(code).ok_or_else(|| format!("Bilinmeyen para birimi: {code}"))?.to_string();
        let to = to.min(istanbul_today(now));
        let from = from.max(to - 91);
        let kind = match self.kind_of(&fc) {
            Some(k) => k,
            None => {
                self.lists(false, now);
                self.kind_of(&fc).ok_or_else(|| format!("TEFAS'ta {fc} kodlu fon bulunamadı."))?
            }
        };
        let key = (fc.clone(), from, to);
        let today = istanbul_today(now);
        if let Some((day, rows)) = self.lock().history.get(&key) {
            if *day == today {
                return Ok(rows.iter().map(|p| view(p, None, now)).collect());
            }
        }
        // En yeni dönemden geriye; istek sınırı dolarsa o ana kadar gelenle dönülür (grafik kısa görünür, hata yok)
        let mut out: Vec<FundPrice> = Vec::new();
        let mut complete = true;
        let mut end = to;
        while end >= from {
            let start = (end - 27).max(from);
            match self.call(now, || (self.src.range)(&fc, kind, start, end)) {
                Ok(rows) => out.extend(rows),
                Err(e) if out.is_empty() => return Err(e),
                Err(_) => {
                    complete = false;
                    break;
                }
            }
            end = start - 1;
        }
        out.sort_by(|a, b| a.date.cmp(&b.date));
        out.dedup_by(|a, b| a.date == b.date);
        if complete {
            let mut s = self.lock();
            if s.history.len() >= 50 {
                s.history.clear();
            }
            s.history.insert(key, (today, out.clone()));
        }
        Ok(out.iter().map(|p| view(p, None, now)).collect())
    }

    /// Kod ya da adda arama (Türkçe büyük/küçük harf duyarsız), en çok 20 sonuç; her fonun son fiyatı.
    /// Liste hiç alınamadıysa hata ("bulunamadı" değil "ulaşılamıyor").
    pub fn search(&self, q: &str, now: i64) -> CoreResult<Vec<FundHit>> {
        let (q, qk) = (tr_lower(q.trim()), code_key(q.trim()));
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let mut last: HashMap<&str, &FundPrice> = HashMap::new();
        let all = self.lists(false, now);
        if all.is_empty() && self.lock().last_error.is_some() {
            return Err("TEFAS'a şu an ulaşılamıyor; birkaç dakika sonra tekrar deneyin.".into());
        }
        for p in &all {
            let e = last.entry(p.code.as_str()).or_insert(p);
            if p.date > e.date {
                *e = p;
            }
        }
        let mut hits: Vec<&FundPrice> = last.into_values().filter(|p| code_key(&p.code).contains(&qk) || tr_lower(&p.name).contains(&q)).collect();
        // Kodu tam eşleşen ve kodla başlayan önce
        hits.sort_by_key(|p| (code_key(&p.code) != qk, !code_key(&p.code).starts_with(&qk), p.code.clone()));
        Ok(hits
            .into_iter()
            .take(20)
            .map(|p| FundHit {
                code: p.code.clone(),
                name: p.name.clone(),
                kind: p.kind.as_str(),
                kind_label: p.kind.label(),
                price: super::amount::rate_to_f64(p.price),
                date: p.date.clone(),
            })
            .collect())
    }
}

/// Türkçe küçük harf (İ → i, I → ı)
pub fn tr_lower(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'İ' => 'i',
            'I' => 'ı',
            c => c.to_lowercase().next().unwrap_or(c),
        })
        .collect()
}

/// Kod karşılaştırması: büyük harf, i/ı/İ hepsi I (fon kodları Latin harfli; "ti2" ve "Tİ2" TI2'yi bulsun)
fn code_key(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'i' | 'ı' | 'İ' => 'I',
            c => c.to_uppercase().next().unwrap_or(c),
        })
        .collect()
}

/// Postgres toplayıcısı için: listedeki fiyatlardan kotalar
pub fn quotes_of(prices: &[FundPrice]) -> Vec<Quote> {
    prices.iter().map(fund_quote).collect()
}
