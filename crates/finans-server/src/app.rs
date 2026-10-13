use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::{Connection, OptionalExtension};

use crate::auth::{self, RateLimiter};
use crate::config::Config;

pub struct AppState {
    pub config: Config,
    /// auth.db: hesaplar ve oturumlar
    pub auth: Mutex<Connection>,
    pub limiter: RateLimiter,
    /// Kullanıcı id → kendi veritabanının bağlantısı (ilk istekte açılır)
    pub user_dbs: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
    /// Veritabanı açma (migration'lar) sırası: aynı dosyanın migration'ı iki kez çalışmasın; açık olanlara erişimi bloklamaz
    pub open_lock: Mutex<()>,
    /// Aynı anda en fazla bu kadar Argon2 (şifre/kurtarma kodu) hesabı: kayıt/giriş seliyle işlemci tüketilemesin
    pub hash_permits: tokio::sync::Semaphore,
    /// Aynı anda en fazla bu kadar ekstre ayrıştırma alt süreci
    pub parse_permits: tokio::sync::Semaphore,
}

/// API hatası: durum kodu + kullanıcıya gösterilecek Türkçe mesaj.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        ApiError { status, message: message.into() }
    }

    pub fn internal(e: impl std::fmt::Display) -> Self {
        eprintln!("iç hata: {e}");
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Sunucu hatası.")
    }

    pub fn too_many() -> Self {
        ApiError::new(StatusCode::TOO_MANY_REQUESTS, "Çok fazla deneme. Biraz bekleyip tekrar deneyin.")
    }
}

/// finans-core'un doğrulama/iş kuralı hataları 400 olur.
impl From<String> for ApiError {
    fn from(message: String) -> Self {
        ApiError::new(StatusCode::BAD_REQUEST, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(serde_json::json!({ "error": self.message }))).into_response()
    }
}

/// SQLite ve Argon2 gibi bloklayan işler async iş parçacığını tutmasın.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, ApiError> + Send + 'static) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f).await.map_err(ApiError::internal)?
}

/// Bir istek panik ederse kilit "zehirlenir"; bağlantı yine kullanılabilir olduğu için sunucu kilitlenmesin.
/// Argon2 içeren işler: eşzamanlılık sınırı + bloklamayan iş parçacığı.
pub async fn hashing<T: Send + 'static>(
    state: &Arc<AppState>,
    f: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let _permit = state.hash_permits.acquire().await.map_err(ApiError::internal)?;
    blocking(f).await
}

/// Kullanıcının veritabanı kotası doldu mu (yazan isteklerden önce). Dosya + WAL boyutu.
pub fn check_quota(state: &AppState, user: &AuthUser) -> Result<(), ApiError> {
    let dir = state.config.data_dir.join("users");
    let size: u64 = ["", "-wal"]
        .iter()
        .filter_map(|suffix| std::fs::metadata(dir.join(format!("{}.db{suffix}", user.id))).ok())
        .map(|m| m.len())
        .sum();
    if size > state.config.user_quota_bytes {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Depolama kotanız doldu. Eski kayıtları silin ya da sunucu yöneticisiyle görüşün.",
        ));
    }
    Ok(())
}

pub fn lock_auth(state: &AppState) -> Result<std::sync::MutexGuard<'_, Connection>, ApiError> {
    Ok(state.auth.lock().unwrap_or_else(|e| e.into_inner()))
}

// ---------------------------------------------------------------------------
// Oturum çerezi ve token
// ---------------------------------------------------------------------------

pub const COOKIE: &str = "finans_session";

pub fn session_cookie(config: &Config, token: &str) -> String {
    format!(
        "{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
        auth::SESSION_TTL,
        if config.secure_cookie { "; Secure" } else { "" }
    )
}

pub fn clear_cookie(config: &Config) -> String {
    format!(
        "{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
        if config.secure_cookie { "; Secure" } else { "" }
    )
}

/// Token: önce `Authorization: Bearer` (masaüstü/mobil), yoksa oturum çerezi (web).
fn token_from(parts: &Parts) -> Option<String> {
    let headers = &parts.headers;
    if let Some(v) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        return v.strip_prefix("Bearer ").map(|t| t.trim().to_string());
    }
    let prefix = format!("{COOKIE}=");
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|kv| kv.trim().strip_prefix(&prefix).map(str::to_string))
}

/// Oturum açmış kullanıcı; işleyici parametresi olarak kullanılınca oturum zorunlu olur.
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub token_hash: String,
}

impl FromRequestParts<Arc<AppState>> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &Arc<AppState>) -> Result<Self, Self::Rejection> {
        let unauthorized = || ApiError::new(StatusCode::UNAUTHORIZED, "Oturum açmanız gerekiyor.");
        let token = token_from(parts).filter(|t| !t.is_empty()).ok_or_else(unauthorized)?;
        let hash = auth::token_hash(&token);
        let state = state.clone();
        blocking(move || {
            let conn = lock_auth(&state)?;
            let row: Option<(String, String, i64)> = conn
                .query_row(
                    "SELECT u.id, u.email, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token_hash = ?1",
                    [&hash],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(ApiError::internal)?;
            let Some((id, email, last_seen)) = row else { return Err(unauthorized()) };
            let t = auth::now();
            if t - last_seen > auth::SESSION_TTL {
                conn.execute("DELETE FROM sessions WHERE token_hash = ?1", [&hash])
                    .map_err(ApiError::internal)?;
                return Err(unauthorized());
            }
            // Her istekte yazmamak için en fazla saatte bir güncellenir
            if t - last_seen > 3600 {
                conn.execute("UPDATE sessions SET last_seen = ?2 WHERE token_hash = ?1", (&hash, t))
                    .map_err(ApiError::internal)?;
            }
            Ok(AuthUser { id, email, token_hash: hash })
        })
        .await
    }
}

// ---------------------------------------------------------------------------
// Kullanıcı veritabanları
// ---------------------------------------------------------------------------

/// Kullanıcının veritabanı bağlantısı (ilk istekte açılır, migration'lar uygulanır).
/// Kilit sırası her yerde aynıdır: `user_dbs` → `auth` (kilitlenme olmasın).
pub fn user_db(state: &AppState, id: &str) -> Result<Arc<Mutex<Connection>>, ApiError> {
    let cached = |state: &AppState| state.user_dbs.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned();
    if let Some(db) = cached(state) {
        return Ok(db);
    }
    // id auth.db'den gelir (uuid); yine de dosya yolu veri klasörünün dışına çıkamasın
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(ApiError::internal("geçersiz kullanıcı kimliği"));
    }
    let gone = || ApiError::new(StatusCode::UNAUTHORIZED, "Oturum açmanız gerekiyor.");
    let exists = || -> Result<bool, ApiError> {
        lock_auth(state)?
            .query_row("SELECT EXISTS (SELECT 1 FROM users WHERE id = ?1)", [id], |r| r.get(0))
            .map_err(ApiError::internal)
    };
    // Açma (migration, yedek kopyası) genel önbellek kilidi dışında: diğer kullanıcıların istekleri beklemesin
    let _opening = state.open_lock.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(db) = cached(state) {
        return Ok(db);
    }
    if !exists()? {
        return Err(gone());
    }
    let path = state.config.data_dir.join("users").join(format!("{id}.db"));
    let conn = finans_core::db::open(&path).map_err(ApiError::internal)?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(ApiError::internal)?;
    // Açarken hesap silindiyse (delete_user önbellek kilidini tutarak çalışır) yeniden oluşan dosya kaldırılır
    let mut dbs = state.user_dbs.lock().unwrap_or_else(|e| e.into_inner());
    if !exists()? {
        drop(conn);
        remove_user_files(&state.config.data_dir.join("users"), id);
        return Err(gone());
    }
    let db = Arc::new(Mutex::new(conn));
    dbs.insert(id.to_string(), db.clone());
    Ok(db)
}

/// Hesabı ve verisini siler. `user_dbs` kilidi boyunca yeni bağlantı açılamaz; süren işlemin bitmesi beklenir,
/// sonra kullanıcı satırı (oturumlar CASCADE) ve dosyalar silinir.
pub fn delete_user(state: &AppState, id: &str) -> Result<(), ApiError> {
    let mut dbs = state.user_dbs.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(db) = dbs.remove(id) {
        // Süren isteğin bitmesini bekle; bağlantı bu blokta kapanır
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        drop(conn);
    }
    lock_auth(state)?
        .execute("DELETE FROM users WHERE id = ?1", [id])
        .map_err(ApiError::internal)?;
    remove_user_files(&state.config.data_dir.join("users"), id);
    Ok(())
}

/// `<id>.db`, `-wal`, `-shm` ve migration yedekleri (`<id>.db.v14.bak` gibi).
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

/// Oturumdaki kullanıcının veritabanında `f`'i çalıştırır; finans-core hataları 400 olur.
pub async fn with_user_db<T: Send + 'static>(
    state: &Arc<AppState>,
    user: &AuthUser,
    f: impl FnOnce(&mut Connection) -> finans_core::CoreResult<T> + Send + 'static,
) -> Result<T, ApiError> {
    let state = state.clone();
    let id = user.id.clone();
    blocking(move || {
        let db = user_db(&state, &id)?;
        let mut conn = db.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut conn).map_err(ApiError::from)
    })
    .await
}
