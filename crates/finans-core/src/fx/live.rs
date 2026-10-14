//! Kurları saklamadan kullanan önbellek: masaüstü/mobil ve SQLite modundaki sunucu.
//! Kaynaklar en çok 60 sn'de bir çekilir. Kilit yalnız karar ve kayıt için tutulur, ağ isteği kilit dışında yapılır:
//! bir çekim sürerken gelen istekler eldeki kurla hemen döner, aynı kaynağı ikinci kez çekmez.

use std::collections::HashMap;
use std::sync::Mutex;

use super::instruments::{find, Source};
use super::sources::*;
use super::time::*;
use crate::CoreResult;

pub const REFRESH_SECS: i64 = 60;

#[derive(Default)]
struct State {
    harem: Vec<Quote>,
    tcmb: Vec<Quote>,
    /// Son deneme zamanı (başarısız da olsa; kaynak düşükken her istekte beklenmesin)
    harem_at: i64,
    tcmb_at: i64,
    last_error: Option<String>,
}

#[derive(Default)]
pub struct LiveRates {
    state: Mutex<State>,
    /// Arşiv günleri: gün → o günün yayını (None = yayın yok)
    archive: Mutex<HashMap<i64, Option<Vec<Quote>>>>,
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
        let inst = find(code).ok_or_else(|| format!("Bilinmeyen para birimi: {code}"))?;
        let day = parse_ymd(date).ok_or_else(|| format!("Geçersiz tarih: {date}"))?;
        if inst.source != Source::Tcmb {
            return Ok(None);
        }
        let now = unix_now();
        for d in (day - 10..=day).rev() {
            if weekday(d) >= 5 || d > istanbul_today(now) {
                continue;
            }
            let cached = self.archive.lock().unwrap_or_else(|e| e.into_inner()).get(&d).cloned();
            let quotes = match cached {
                Some(q) => q,
                None => {
                    let fetched = fetch_tcmb_on(d)?.map(|t| t.quotes);
                    self.archive.lock().unwrap_or_else(|e| e.into_inner()).insert(d, fetched.clone());
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
