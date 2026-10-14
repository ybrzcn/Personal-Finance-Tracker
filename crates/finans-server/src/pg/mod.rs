//! Postgres arka ucu (yalnız sunucu): bağlantı havuzu, şema geçişleri, kullanıcı verisi ve hesaplar.
//! `postgres` istemcisi senkrondur ve async bağlamda kullanılamaz: buradaki her şey `spawn_blocking` içinde çağrılır.

mod auth;
pub mod cpi;
mod data;
pub mod rates;

use std::time::{Duration, Instant};

use axum::http::StatusCode;
use finans_core::data_store::DataStore;
use finans_core::CoreResult;
use postgres::error::SqlState;
use r2d2_postgres::PostgresConnectionManager;
use tokio_postgres_rustls::MakeRustlsConnect;

pub use auth::PgAuthStore;

use crate::app::ApiError;
use crate::auth_store::StoreError;

pub type Pool = r2d2::Pool<PostgresConnectionManager<MakeRustlsConnect>>;

const MIGRATIONS: &[(i32, &str)] = &[
    (1, include_str!("migrations/0001_init.sql")),
    (2, include_str!("migrations/0002_doviz.sql")),
    (3, include_str!("migrations/0003_kar_zarar.sql")),
];

fn make_tls() -> MakeRustlsConnect {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let config = rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
    MakeRustlsConnect::new(config)
}

/// Havuzu kurar; Postgres henüz açılmadıysa 30 sn boyunca 2 sn arayla yeniden dener.
pub fn connect(url: &str, size: u32) -> Result<Pool, String> {
    let config: postgres::Config = url.parse().map_err(|e| format!("FINANS_DATABASE_URL geçersiz: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let manager = PostgresConnectionManager::new(config.clone(), make_tls());
        match r2d2::Pool::builder().max_size(size).connection_timeout(Duration::from_secs(5)).build(manager) {
            Ok(pool) => return Ok(pool),
            Err(e) if Instant::now() < deadline => {
                eprintln!("Postgres'e bağlanılamadı, yeniden deneniyor: {e}");
                std::thread::sleep(Duration::from_secs(2));
            }
            Err(e) => return Err(format!("Postgres'e bağlanılamadı: {e}")),
        }
    }
}

/// Süper kullanıcı ve BYPASSRLS rolleri satır düzeyi güvenliği atlar; bunlarla açılmaz.
fn check_role(c: &mut postgres::Client) -> Result<(), String> {
    let row = c
        .query_one("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user", &[])
        .map_err(|e| format!("Postgres rolü okunamadı: {e}"))?;
    if row.get::<_, bool>(0) {
        return Err("Postgres kullanıcısı süper kullanıcı ya da BYPASSRLS yetkili; satır düzeyi güvenlik bu rolde çalışmaz. \
                    README'deki gibi ayrı bir uygulama kullanıcısıyla bağlanın."
            .into());
    }
    Ok(())
}

/// Bekleyen şema geçişlerini tek işlemde, danışma kilidi altında uygular (iki sunucu aynı anda açılsa da bir kez çalışır).
pub fn migrate(pool: &Pool) -> Result<(), String> {
    let mut c = pool.get().map_err(|e| format!("Postgres'e bağlanılamadı: {e}"))?;
    check_role(&mut c)?;
    let e = |e: postgres::Error| format!("Postgres şema geçişi başarısız: {e}");
    let mut tx = c.transaction().map_err(e)?;
    tx.execute("SELECT pg_advisory_xact_lock(727274)", &[]).map_err(e)?;
    tx.batch_execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    )
    .map_err(e)?;
    let current: i32 = tx.query_one("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", &[]).map_err(e)?.get(0);
    let latest = MIGRATIONS.last().map(|m| m.0).unwrap_or(0);
    if current > latest {
        return Err(format!(
            "Postgres şeması bu sunucudan yeni (şema {current}); sunucuyu güncelleyin."
        ));
    }
    for (version, sql) in MIGRATIONS {
        if *version > current {
            tx.batch_execute(sql).map_err(e)?;
            tx.execute("INSERT INTO schema_migrations (version) VALUES ($1)", &[version]).map_err(e)?;
            println!("Postgres şema geçişi uygulandı: {version}");
        }
    }
    tx.commit().map_err(e)
}

/// SQLite modundaki Türkçe mesajların aynısı.
pub fn pg_err(e: postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        if *db.code() == SqlState::UNIQUE_VIOLATION {
            match db.constraint() {
                Some("accounts_name_unique") => return "Bu isimde bir hesap zaten mevcut.".into(),
                Some("categories_name_unique") => return "Bu isimde ve türde bir kategori zaten mevcut.".into(),
                _ => {}
            }
        }
    }
    format!("Veritabanı hatası: {e}")
}

pub(crate) fn unavailable() -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "Veritabanına ulaşılamıyor.")
}

/// Kullanıcı verisi (tek şema, `user_id` + RLS).
pub struct PgData {
    pool: Pool,
}

impl PgData {
    pub fn new(pool: Pool) -> Self {
        PgData { pool }
    }

    /// `f`'i tek işlemde, kullanıcı ayarlanmış olarak çalıştırır. Bağlantı koptuysa 503.
    pub fn with_user<T>(&self, user_id: &str, f: impl FnOnce(&mut dyn DataStore) -> CoreResult<T>) -> Result<T, ApiError> {
        let mut client = self.pool.get().map_err(|e| {
            eprintln!("Postgres havuzu: {e}");
            unavailable()
        })?;
        let result = (|| -> Result<CoreResult<T>, postgres::Error> {
            let mut tx = client.transaction()?;
            tx.execute("SELECT set_config('finans.user_id', $1, true)", &[&user_id])?;
            let out = {
                let mut store = data::PgStore { tx: &mut tx, user_id: user_id.to_string() };
                f(&mut store)
            };
            if out.is_ok() {
                tx.commit()?;
            }
            Ok(out)
        })();
        match result {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) | Err(_) if client.is_closed() => Err(unavailable()),
            Ok(Err(msg)) => Err(ApiError::from(msg)),
            Err(e) => Err(ApiError::internal(e)),
        }
    }

    /// Yeni kullanıcıya varsayılan kategoriler ve "Genel Hesap" (SQLite modundaki gibi).
    pub fn init_user(&self, user_id: &str) -> Result<(), ApiError> {
        // SQLite'taki date('now', 'localtime') karşılığı: sunucunun saat dilimindeki bugün
        let today: String = {
            let mut c = self.pool.get().map_err(|_| unavailable())?;
            c.query_one("SELECT to_char(current_date, 'YYYY-MM-DD')", &[]).map_err(ApiError::internal)?.get(0)
        };
        self.with_user(user_id, |s| finans_core::store::seed_new_user(s, &today))
    }

    /// Kur deposu aynı havuzu kullanır
    pub fn pool(&self) -> Pool {
        self.pool.clone()
    }

    pub fn ping(&self) -> Result<(), String> {
        let mut c = self.pool.get().map_err(|e| e.to_string())?;
        c.execute("SELECT 1", &[]).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Havuz ve bağlantı hataları `Unavailable` olur.
fn store_err(e: postgres::Error) -> StoreError {
    if e.is_closed() || e.as_db_error().is_none() {
        StoreError::Unavailable(e.to_string())
    } else {
        StoreError::Other(e.to_string())
    }
}
