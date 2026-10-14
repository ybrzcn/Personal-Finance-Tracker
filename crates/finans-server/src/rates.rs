//! Kur servisi. Postgres modunda kurlar arka planda toplanıp `fx_rates`'e yazılır (geçmiş tutulur);
//! SQLite modunda saklanmaz, masaüstündeki gibi canlı çekilip 60 sn bellekte tutulur.
//! Kilit yalnız karar ve kayıt için tutulur; ağ ve veritabanı işleri kilit dışında yapılır (yavaş kaynak diğer istekleri bekletmez).

use std::collections::HashMap;
use std::sync::Mutex;

use axum::http::StatusCode;
use finans_core::fx::live::{LiveRates, REFRESH_SECS};
use finans_core::fx::sources::{fetch_harem, fetch_tcmb_on, fetch_tcmb_today, tcmb_archive_start, Quote, RateView, TcmbDay};
use finans_core::fx::time::*;
use finans_core::fx::{find, Source};

use finans_core::CoreResult;

use crate::app::ApiError;
use crate::pg::{self, Pool};

/// Harem toplama aralığı
const HAREM_EVERY: i64 = 15 * 60;
/// TCMB yayımlanmadıysa yeniden deneme aralığı
const TCMB_RETRY: i64 = 3600;
/// Arşive ulaşılamadıysa yeniden deneme aralığı
const ARCHIVE_RETRY: i64 = 600;
/// Bellekte hatırlanan en fazla arşiv günü (≈ 11 yıl); dolunca baştan başlanır
const ARCHIVE_MAX: usize = 4000;

pub enum RateService {
    Stored(StoredRates),
    Live(LiveRates),
}

#[derive(Default)]
struct Fetch {
    harem_at: i64,
    tcmb_at: i64,
    /// Son başarılı `today.xml`'in kur tarihi (gün)
    tcmb_day: Option<i64>,
    /// Arşivden çekilmiş günler (bu süreç boyunca): true = yayın var (tabloya yazıldı), false = yayın yok (tatil)
    archive_days: HashMap<i64, bool>,
    /// Arşive ulaşılamadı: bu zamana kadar yeniden denenmez
    archive_down_until: i64,
    last_error: Option<String>,
}

pub struct StoredRates {
    pool: Pool,
    fetch: Mutex<Fetch>,
    /// TCMB arşivinden bir günü çeker (doğrulamada sahte kaynak verilebilir)
    fetch_day: fn(i64) -> CoreResult<Option<TcmbDay>>,
}

fn db_down(e: String) -> ApiError {
    eprintln!("kur deposu: {e}");
    pg::unavailable()
}

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Kur geçmişi bu sunucuda tutulmuyor.")
}

/// Arşiv gününü hatırlar; liste sınırı aşınca baştan başlar (keyfi tarih istekleri belleği büyütmesin).
fn remember(f: &mut Fetch, day: i64, published: bool) {
    if f.archive_days.len() >= ARCHIVE_MAX {
        f.archive_days.clear();
    }
    f.archive_days.insert(day, published);
}

impl StoredRates {
    pub fn new(pool: Pool) -> Self {
        Self::with_archive_fetcher(pool, fetch_tcmb_on)
    }

    /// Arşiv kaynağı verilerek kurulur (doğrulama için; `LiveRates::with_archive_fetcher` gibi).
    #[allow(dead_code)]
    pub fn with_archive_fetcher(pool: Pool, fetch_day: fn(i64) -> CoreResult<Option<TcmbDay>>) -> Self {
        StoredRates { pool, fetch: Mutex::new(Fetch::default()), fetch_day }
    }

    fn log_once(f: &mut Fetch, e: String) {
        if f.last_error.as_ref() != Some(&e) {
            eprintln!("kur: {e}");
            f.last_error = Some(e);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Fetch> {
        self.fetch.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Kilit dışında yazar; hata kilit alınıp bir kez günlüğe düşer.
    fn save(&self, quotes: &[Quote]) {
        if let Err(e) = pg::rates::insert_if_changed(&self.pool, quotes) {
            Self::log_once(&mut self.lock(), format!("kurlar yazılamadı: {e}"));
        }
    }

    fn pull_harem(&self) {
        match fetch_harem() {
            Ok(q) => self.save(&q),
            Err(e) => Self::log_once(&mut self.lock(), e),
        }
    }

    fn pull_tcmb(&self) {
        match fetch_tcmb_today() {
            Ok(day) => {
                self.save(&day.quotes);
                self.lock().tcmb_day = parse_ymd(&day.date);
            }
            Err(e) => Self::log_once(&mut self.lock(), e),
        }
    }

    /// Çekme sırasını alır: zaman damgası hemen yazılır, böylece aynı kaynağı başka istek yeniden çekmez.
    fn claim(&self, harem: impl Fn(&Fetch, i64) -> bool, tcmb: impl Fn(&Fetch, i64) -> bool) -> (bool, bool) {
        let now = unix_now();
        let mut f = self.lock();
        let (h, t) = (harem(&f, now), tcmb(&f, now));
        if h {
            f.harem_at = now;
        }
        if t {
            f.tcmb_at = now;
        }
        (h, t)
    }

    fn pull(&self, (harem, tcmb): (bool, bool)) {
        if harem {
            self.pull_harem();
        }
        if tcmb {
            self.pull_tcmb();
        }
    }

    /// Arka plan adımı (dakikada bir çağrılır): Harem 15 dk'da bir; TCMB açılışta bir kez,
    /// sonra iş günü 15:30'dan sonra o günün kuru alınana kadar saatte bir.
    pub fn tick(&self) {
        let claimed = self.claim(
            |f, now| now - f.harem_at >= HAREM_EVERY,
            |f, now| {
                let today = istanbul_today(now);
                let published = weekday(today) < 5 && istanbul_minute(now) >= 15 * 60 + 30;
                f.tcmb_at == 0 || (published && f.tcmb_day != Some(today) && now - f.tcmb_at >= TCMB_RETRY)
            },
        );
        self.pull(claimed);
    }

    fn latest(&self, refresh: bool) -> Result<Vec<RateView>, ApiError> {
        if refresh {
            let claimed = self.claim(|f, now| now - f.harem_at >= REFRESH_SECS, |f, now| now - f.tcmb_at >= REFRESH_SECS);
            self.pull(claimed);
        }
        let now = unix_now();
        Ok(pg::rates::latest(&self.pool)
            .map_err(db_down)?
            .iter()
            .map(|(q, prev)| RateView::from_quote(q, *prev, now))
            .collect())
    }

    /// Gün `day` (İstanbul) için son fiyat. Döviz: tabloda o güne ait yayın yoksa TCMB arşivinden çekilip yazılır.
    fn at(&self, code: &str, day: i64) -> Result<Option<RateView>, ApiError> {
        let inst = find(code).ok_or_else(|| ApiError::from(format!("Bilinmeyen para birimi: {code}")))?;
        let now = unix_now();
        let until = iso_utc(istanbul_to_unix(day + 1, 0, 0, 0));
        let since = iso_utc(istanbul_to_unix(day - 10, 0, 0, 0));
        if inst.source == Source::Tcmb {
            // `day`'den geriye en yakın iş günü yayını çekilmemişse arşivden alınır (yalnız değişen yazıldığı için
            // tabloda satır olmaması "çekilmedi" ya da "değişmedi" olabilir; çekilen günler bellekte tutulur).
            // Ağ isteği kilit dışında.
            let today = istanbul_today(now);
            for d in ((day - 10).max(tcmb_archive_start())..=day.min(today)).rev() {
                if weekday(d) >= 5 {
                    continue;
                }
                {
                    let f = self.lock();
                    if f.tcmb_day == Some(d) || f.archive_days.get(&d) == Some(&true) {
                        break;
                    }
                    // Tatil: bir önceki iş gününe bakılır
                    if f.archive_days.get(&d) == Some(&false) {
                        continue;
                    }
                    if now < f.archive_down_until {
                        break;
                    }
                }
                match (self.fetch_day)(d) {
                    Ok(Some(t)) => {
                        self.save(&t.quotes);
                        remember(&mut self.lock(), d, true);
                        break;
                    }
                    // Bugünün kuru henüz yayınlanmamış olabilir (15:30): "yok" yalnız geçmiş günler için saklanır
                    Ok(None) if d < today => remember(&mut self.lock(), d, false),
                    Ok(None) => {}
                    Err(e) => {
                        let mut f = self.lock();
                        f.archive_down_until = now + ARCHIVE_RETRY;
                        Self::log_once(&mut f, e);
                        break;
                    }
                }
            }
        }
        let q = pg::rates::last_between(&self.pool, code, &since, &until).map_err(db_down)?;
        Ok(q.map(|q| RateView::from_quote(&q, None, now)))
    }

    fn history(&self, code: &str, from: i64, to: i64) -> Result<Vec<RateView>, ApiError> {
        let now = unix_now();
        let rows = pg::rates::history(
            &self.pool,
            code,
            &iso_utc(istanbul_to_unix(from, 0, 0, 0)),
            &iso_utc(istanbul_to_unix(to + 1, 0, 0, 0)),
        )
        .map_err(db_down)?;
        Ok(rows.iter().map(|q| RateView::from_quote(q, None, now)).collect())
    }
}

impl RateService {
    pub fn tick(&self) {
        if let RateService::Stored(s) = self {
            s.tick();
        }
    }

    pub fn latest(&self, refresh: bool) -> Result<Vec<RateView>, ApiError> {
        match self {
            RateService::Stored(s) => s.latest(refresh),
            RateService::Live(l) => Ok(l.latest()),
        }
    }

    pub fn at(&self, code: &str, date: &str) -> Result<Option<RateView>, ApiError> {
        let day = parse_ymd(date).ok_or_else(|| ApiError::from(format!("Geçersiz tarih: {date}")))?;
        match self {
            RateService::Stored(s) => s.at(code, day),
            RateService::Live(l) => l.at(code, date).map_err(ApiError::from),
        }
    }

    pub fn history(&self, code: &str, from: &str, to: &str) -> Result<Vec<RateView>, ApiError> {
        let (Some(f), Some(t)) = (parse_ymd(from), parse_ymd(to)) else {
            return Err(ApiError::from("Geçersiz tarih aralığı.".to_string()));
        };
        if find(code).is_none() {
            return Err(ApiError::from(format!("Bilinmeyen para birimi: {code}")));
        }
        if t < f || t - f > 3660 {
            return Err(ApiError::from("Tarih aralığı en çok 10 yıl olabilir.".to_string()));
        }
        match self {
            RateService::Stored(s) => s.history(code, f, t),
            RateService::Live(_) => Err(not_found()),
        }
    }
}
