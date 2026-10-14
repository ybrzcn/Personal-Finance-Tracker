//! TÜFE servisi. Postgres modunda günde bir EVDS'ten çekilip `cpi` tablosuna yazılır (geçmiş saklanır);
//! SQLite modunda saklanmaz, istekte çekilip 24 saat bellekte tutulur. Ağ ve veritabanı işi kilit dışında.

use std::sync::Mutex;

use finans_core::cpi::{evds, live::LiveCpi, CpiData, CpiStatus};
use finans_core::fx::time::unix_now;

use crate::pg::{self, Pool};

const EVERY: i64 = 24 * 3600;
const RETRY: i64 = 3600;

pub enum CpiService {
    Stored(StoredCpi),
    Live { live: LiveCpi, key: Option<String> },
}

pub struct StoredCpi {
    pool: Pool,
    key: Option<String>,
    /// (bir sonraki çekim, son hata)
    state: Mutex<(i64, Option<String>)>,
}

impl StoredCpi {
    pub fn new(pool: Pool, key: Option<String>) -> Self {
        StoredCpi { pool, key, state: Mutex::new((0, None)) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, (i64, Option<String>)> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn log_once(&self, e: String) {
        let mut s = self.lock();
        if s.1.as_ref() != Some(&e) {
            eprintln!("tüfe: {e}");
            s.1 = Some(e);
        }
    }

    /// Arka plan adımı (dakikada bir): günde bir çeker; hata olursa saatte bir yeniden dener.
    pub fn tick(&self) {
        let Some(key) = self.key.as_deref() else { return };
        let now = unix_now();
        {
            let mut s = self.lock();
            if now < s.0 {
                return;
            }
            s.0 = now + RETRY;
        }
        // Tablo doluysa yalnız son iki yıl çekilir (geç düzeltilen aylar da güncellenir); boşsa tüm seri
        let rows = match pg::cpi::load(&self.pool) {
            Ok(s) if !s.0.is_empty() => {
                let last_year = s.latest().map(|(k, _)| k.div_euclid(12)).unwrap_or(2003);
                evds::fetch_recent(key, last_year - 1)
            }
            _ => evds::fetch_series(key),
        };
        match rows.and_then(|rows| pg::cpi::upsert(&self.pool, &rows).map_err(|e| format!("TÜFE yazılamadı: {e}"))) {
            Ok(_) => {
                let mut s = self.lock();
                s.0 = now + EVERY;
                s.1 = None;
            }
            Err(e) => self.log_once(e),
        }
    }

    fn get(&self) -> CpiData {
        match pg::cpi::load(&self.pool) {
            Ok(s) if !s.0.is_empty() => CpiData { series: Some(s), status: CpiStatus::Ok, message: None },
            Ok(_) if self.key.is_none() => CpiData { series: None, status: CpiStatus::NoKey, message: None },
            Ok(_) => CpiData { series: None, status: CpiStatus::Unavailable, message: self.lock().1.clone() },
            Err(e) => {
                eprintln!("tüfe deposu: {e}");
                CpiData { series: None, status: CpiStatus::Unavailable, message: Some("TÜFE verisi okunamadı.".into()) }
            }
        }
    }
}

impl CpiService {
    pub fn tick(&self) {
        if let CpiService::Stored(s) = self {
            s.tick();
        }
    }

    pub fn get(&self) -> CpiData {
        match self {
            CpiService::Stored(s) => s.get(),
            CpiService::Live { live, key } => live.get(key.as_deref()),
        }
    }
}
