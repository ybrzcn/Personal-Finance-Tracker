//! Kullanıcı verisi: SQLite (kullanıcı başına dosya) ya da Postgres (tek şema). Uç noktalar hangisi olduğunu bilmez.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use finans_core::data_store::DataStore;
use finans_core::CoreResult;
use rusqlite::Connection;

use crate::app::ApiError;
use crate::auth_store::AuthStore;

pub enum DataBackend {
    Sqlite(SqliteData),
    Postgres(crate::pg::PgData),
}

impl DataBackend {
    /// Kullanıcının verisinde `f`'i tek veritabanı işleminde çalıştırır; finans-core hataları 400 olur.
    pub fn with_user<T>(
        &self,
        auth: &dyn AuthStore,
        user_id: &str,
        f: impl FnOnce(&mut dyn DataStore) -> CoreResult<T>,
    ) -> Result<T, ApiError> {
        match self {
            DataBackend::Sqlite(d) => {
                let db = d.user_db(auth, user_id)?;
                let mut conn = db.lock().unwrap_or_else(|e| e.into_inner());
                finans_core::sqlite::run(&mut conn, f).map_err(ApiError::from)
            }
            DataBackend::Postgres(d) => d.with_user(user_id, f),
        }
    }

    /// Yeni kullanıcının verisini hazırlar (varsayılan kategoriler).
    pub fn init_user(&self, auth: &dyn AuthStore, user_id: &str) -> Result<(), ApiError> {
        match self {
            DataBackend::Sqlite(d) => d.user_db(auth, user_id).map(|_| ()),
            DataBackend::Postgres(d) => d.init_user(user_id),
        }
    }

    /// Hesabı ve bütün verisini siler.
    pub fn delete_user(&self, auth: &dyn AuthStore, user_id: &str) -> Result<(), ApiError> {
        match self {
            DataBackend::Sqlite(d) => d.delete_user(auth, user_id),
            // Kullanıcı satırı silinince bütün verisi CASCADE ile gider
            DataBackend::Postgres(_) => Ok(auth.delete_user(user_id)?),
        }
    }

    /// Sağlık kontrolü.
    pub fn ping(&self) -> Result<(), String> {
        match self {
            DataBackend::Sqlite(_) => Ok(()),
            DataBackend::Postgres(d) => d.ping(),
        }
    }
}

pub struct SqliteData {
    dir: PathBuf,
    /// Kullanıcı id → kendi veritabanının bağlantısı (ilk istekte açılır)
    dbs: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
    /// Veritabanı açma (geçişler) sırası: aynı dosyanın geçişi iki kez çalışmasın; açık olanlara erişimi bloklamaz
    open_lock: Mutex<()>,
}

impl SqliteData {
    pub fn new(dir: PathBuf) -> Self {
        SqliteData { dir, dbs: Default::default(), open_lock: Default::default() }
    }

    /// Kilit sırası her yerde aynıdır: `dbs` → auth (kilitlenme olmasın).
    fn user_db(&self, auth: &dyn AuthStore, id: &str) -> Result<Arc<Mutex<Connection>>, ApiError> {
        let cached = || self.dbs.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned();
        if let Some(db) = cached() {
            return Ok(db);
        }
        // id auth'tan gelir (uuid); yine de dosya yolu veri klasörünün dışına çıkamasın
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return Err(ApiError::internal("geçersiz kullanıcı kimliği"));
        }
        let gone = || ApiError::new(StatusCode::UNAUTHORIZED, "Oturum açmanız gerekiyor.");
        let _opening = self.open_lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(db) = cached() {
            return Ok(db);
        }
        if !auth.user_exists(id)? {
            return Err(gone());
        }
        let path = self.dir.join(format!("{id}.db"));
        let conn = finans_core::db::open(&path).map_err(ApiError::internal)?;
        conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(ApiError::internal)?;
        // Açarken hesap silindiyse (delete_user önbellek kilidini tutarak çalışır) yeniden oluşan dosya kaldırılır
        let mut dbs = self.dbs.lock().unwrap_or_else(|e| e.into_inner());
        if !auth.user_exists(id)? {
            drop(conn);
            remove_user_files(&self.dir, id);
            return Err(gone());
        }
        let db = Arc::new(Mutex::new(conn));
        dbs.insert(id.to_string(), db.clone());
        Ok(db)
    }

    /// `dbs` kilidi boyunca yeni bağlantı açılamaz; süren işlemin bitmesi beklenir,
    /// sonra kullanıcı satırı (oturumlar CASCADE) ve dosyalar silinir.
    fn delete_user(&self, auth: &dyn AuthStore, id: &str) -> Result<(), ApiError> {
        let mut dbs = self.dbs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(db) = dbs.remove(id) {
            let conn = db.lock().unwrap_or_else(|e| e.into_inner());
            drop(conn);
        }
        auth.delete_user(id)?;
        remove_user_files(&self.dir, id);
        Ok(())
    }
}

/// `<id>.db`, `-wal`, `-shm` ve geçiş yedekleri (`<id>.db.v14.bak` gibi).
pub fn remove_user_files(dir: &std::path::Path, id: &str) {
    let prefix = format!("{id}.db");
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().starts_with(&prefix) {
            if let Err(err) = std::fs::remove_file(e.path()) {
                eprintln!("dosya silinemedi ({}): {err}", e.path().display());
            }
        }
    }
}
