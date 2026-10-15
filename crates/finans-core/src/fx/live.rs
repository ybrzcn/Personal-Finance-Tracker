//! Kurları saklamadan kullanan önbellek: masaüstü/mobil ve SQLite modundaki sunucu.
//! Kaynaklar en çok 60 sn'de bir çekilir. Kilit yalnız karar ve kayıt için tutulur, ağ isteği kilit dışında yapılır:
//! bir çekim sürerken gelen istekler eldeki kurla hemen döner, aynı kaynağı ikinci kez çekmez.

use std::collections::HashMap;
use std::sync::Mutex;

use super::funds::{FundCache, FundHit, FundSource, TEFAS};
use super::instruments::{is_fund, source_of, Source};
use super::sources::*;
use super::time::*;
use crate::CoreResult;

pub const REFRESH_SECS: i64 = 60;
/// Arşive ulaşılamazsa bu süre yeniden denenmez (çevrimdışıyken her rapor ağ beklemesin)
const ARCHIVE_RETRY: i64 = 600;
/// Bellekte tutulan en fazla arşiv günü (≈ 11 yıl); dolunca baştan başlanır (sunucuda keyfi tarihler belleği büyütmesin)
const ARCHIVE_MAX: usize = 4000;

#[derive(Default)]
struct State {
    harem: Vec<Quote>,
    tcmb: Vec<Quote>,
    /// Son deneme zamanı (başarısız da olsa; kaynak düşükken her istekte beklenmesin)
    harem_at: i64,
    tcmb_at: i64,
    last_error: Option<String>,
}

pub struct LiveRates {
    state: Mutex<State>,
    /// Arşiv günleri: gün → o günün yayını (None = yayın yok)
    archive: Mutex<HashMap<i64, Option<Vec<Quote>>>>,
    /// Arşiv günü çekme (doğrulamada sahtesi verilir)
    fetch_day: fn(i64) -> CoreResult<Option<TcmbDay>>,
    /// Son arşiv hatası ve o ana kadar yeniden denenmeyeceği zaman
    archive_down: Mutex<Option<(i64, String)>>,
    /// Fon fiyatları (TEFAS)
    funds: FundCache,
}

impl Default for LiveRates {
    fn default() -> Self {
        Self::with_archive_fetcher(fetch_tcmb_on)
    }
}

fn log_once(state: &mut State, e: String) {
    if state.last_error.as_ref() != Some(&e) {
        eprintln!("kur: {e}");
        state.last_error = Some(e);
    }
}

impl LiveRates {
    pub fn new() -> Self {
        Self::default()
    }

    /// Arşiv çekme fonksiyonu verilmiş önbellek (doğrulama betikleri için)
    #[doc(hidden)]
    pub fn with_archive_fetcher(fetch_day: fn(i64) -> CoreResult<Option<TcmbDay>>) -> Self {
        LiveRates { state: Default::default(), archive: Default::default(), fetch_day, archive_down: Default::default(), funds: FundCache::new(TEFAS) }
    }

    /// Fon kaynağı verilmiş önbellek (doğrulama betikleri için)
    #[doc(hidden)]
    pub fn with_fund_source(mut self, src: FundSource) -> Self {
        self.funds = FundCache::new(src);
        self
    }

    /// `FON:XXX` kodlarının güncel fiyatı
    pub fn funds_latest(&self, codes: &[String], refresh: bool) -> Vec<RateView> {
        self.funds.latest(codes, refresh, unix_now())
    }

    pub fn funds_search(&self, q: &str) -> CoreResult<Vec<FundHit>> {
        self.funds.search(q, unix_now())
    }

    /// Fon fiyat geçmişi (döviz/altın geçmişi yalnız Postgres'li sunucuda)
    pub fn history(&self, code: &str, from: &str, to: &str) -> CoreResult<Vec<RateView>> {
        if !is_fund(code) {
            return Err("Kur geçmişi yalnızca sunucuya bağlıyken görülebilir.".into());
        }
        let (Some(f), Some(t)) = (parse_ymd(from), parse_ymd(to)) else {
            return Err("Geçersiz tarih aralığı.".into());
        };
        self.funds.history(code, f, t, unix_now())
    }

    /// Ortak fon önbelleği (Postgres sunucusu `StoredRates` de kullanır)
    pub fn fund_cache(&self) -> &FundCache {
        &self.funds
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Güncel kurlar; önbellek 60 sn'den eskiyse kaynaklardan yenilenir. Kaynak düşerse eldekiyle devam edilir.
    pub fn latest(&self) -> Vec<RateView> {
        let now = unix_now();
        // Çekme sırası alınır (zaman damgası hemen yazılır: başka istek aynı kaynağı yeniden çekmez)
        let (pull_harem, pull_tcmb) = {
            let mut s = self.lock();
            let h = now - s.harem_at >= REFRESH_SECS;
            let t = now - s.tcmb_at >= REFRESH_SECS;
            if h {
                s.harem_at = now;
            }
            if t {
                s.tcmb_at = now;
            }
            (h, t)
        };
        let harem = pull_harem.then(fetch_harem);
        let tcmb = pull_tcmb.then(fetch_tcmb_today);
        let mut s = self.lock();
        match harem {
            Some(Ok(q)) => s.harem = q,
            Some(Err(e)) => log_once(&mut s, e),
            None => {}
        }
        match tcmb {
            Some(Ok(d)) => s.tcmb = d.quotes,
            Some(Err(e)) => log_once(&mut s, e),
            None => {}
        }
        s.tcmb.iter().chain(s.harem.iter()).map(|q| RateView::from_quote(q, None, now)).collect()
    }

    /// Belirli günün kuru. Döviz: o gün ya da geriye doğru en yakın iş gününün TCMB kuru (en çok 10 gün).
    /// Altın: geçmiş tutulmadığı için None.
    pub fn at(&self, code: &str, date: &str) -> CoreResult<Option<RateView>> {
        let source = source_of(code).ok_or_else(|| format!("Bilinmeyen para birimi: {code}"))?;
        let day = parse_ymd(date).ok_or_else(|| format!("Geçersiz tarih: {date}"))?;
        if source == Source::Tefas {
            return self.funds.at(code, day, unix_now());
        }
        if source != Source::Tcmb {
            return Ok(None);
        }
        let now = unix_now();
        let today = istanbul_today(now);
        for d in ((day - 10).max(tcmb_archive_start())..=day).rev() {
            if weekday(d) >= 5 || d > today {
                continue;
            }
            let cached = self.archive.lock().unwrap_or_else(|e| e.into_inner()).get(&d).cloned();
            let quotes = match cached {
                Some(q) => q,
                None => {
                    if let Some((until, e)) = self.archive_down.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                        if now < until {
                            return Err(e);
                        }
                    }
                    let fetched = match (self.fetch_day)(d) {
                        Ok(t) => t.map(|t| t.quotes),
                        Err(e) => {
                            *self.archive_down.lock().unwrap_or_else(|e| e.into_inner()) = Some((now + ARCHIVE_RETRY, e.clone()));
                            return Err(e);
                        }
                    };
                    // Bugünün kuru henüz yayınlanmamış olabilir (15:30): "yok" yalnız geçmiş günler için saklanır
                    if fetched.is_some() || d < today {
                        let mut archive = self.archive.lock().unwrap_or_else(|e| e.into_inner());
                        if archive.len() >= ARCHIVE_MAX {
                            archive.clear();
                        }
                        archive.insert(d, fetched.clone());
                    }
                    fetched
                }
            };
            if let Some(q) = quotes.as_ref().and_then(|qs| qs.iter().find(|q| q.code == code)) {
                return Ok(Some(RateView::from_quote(q, None, now)));
            }
        }
        Ok(None)
    }
}
