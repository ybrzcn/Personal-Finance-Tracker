//! TÜFE'yi saklamadan kullanan önbellek (masaüstü/mobil ve SQLite modundaki sunucu): 24 saat bellekte.
//! Hata durumunda 10 dakika yeniden denenmez. Ağ isteği kilit dışında yapılır; eldeki seri yokken çekim sürerken
//! gelen istekler o çekimin sonucunu bekler (ilk açılışta yanlışlıkla "alınamadı" görünmesin).

use std::sync::{Condvar, Mutex};

use super::{evds, CpiData, CpiSeries, CpiStatus};
use crate::fx::time::unix_now;

const TTL: i64 = 24 * 3600;
const RETRY: i64 = 600;

#[derive(Default)]
struct State {
    key: Option<String>,
    /// Bir sonraki çekim zamanı
    next: i64,
    series: Option<CpiSeries>,
    error: Option<String>,
    /// Bir çekim sürüyor
    fetching: bool,
}

#[derive(Default)]
pub struct LiveCpi {
    state: Mutex<State>,
    done: Condvar,
}

impl LiveCpi {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn data(s: &State) -> CpiData {
        match (&s.series, &s.error) {
            (Some(series), _) => CpiData { series: Some(series.clone()), status: CpiStatus::Ok, message: None },
            (None, e) => CpiData { series: None, status: CpiStatus::Unavailable, message: e.clone() },
        }
    }

    pub fn get(&self, key: Option<&str>) -> CpiData {
        let Some(key) = key.map(str::trim).filter(|k| !k.is_empty()) else {
            return CpiData { series: None, status: CpiStatus::NoKey, message: None };
        };
        let now = unix_now();
        {
            let mut s = self.lock();
            if s.key.as_deref() != Some(key) {
                *s = State { key: Some(key.to_string()), ..State::default() };
                // Eski anahtarın çekimini bekleyenler uyansın
                self.done.notify_all();
            }
            // Eldeki seri yokken süren çekim beklenir; varsa eldeki hemen döner
            s = self
                .done
                .wait_while(s, |s| s.fetching && s.series.is_none() && s.key.as_deref() == Some(key))
                .unwrap_or_else(|e| e.into_inner());
            if now < s.next || s.fetching || s.key.as_deref() != Some(key) {
                return Self::data(&s);
            }
            // Çekim sırası alınır
            s.next = now + RETRY;
            s.fetching = true;
        }
        let r = evds::fetch_series(key);
        let mut s = self.lock();
        if s.key.as_deref() != Some(key) {
            return Self::data(&s);
        }
        s.fetching = false;
        self.done.notify_all();
        match r {
            Ok(v) => {
                s.series = Some(CpiSeries(v.into_iter().collect()));
                s.error = None;
                s.next = now + TTL;
            }
            Err(e) => {
                if s.error.as_ref() != Some(&e) {
                    eprintln!("tüfe: {e}");
                }
                s.error = Some(e);
            }
        }
        Self::data(&s)
    }
}
