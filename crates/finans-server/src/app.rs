use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use finans_core::data_store::DataStore;

use crate::auth::{self, RateLimiter};
use crate::auth_store::{AuthStore, StoreError};
use crate::config::Config;
use crate::data::DataBackend;

pub struct AppState {
    pub config: Config,
    /// Hesaplar ve oturumlar
    pub auth: Box<dyn AuthStore>,
    /// Kullanıcı verisi
    pub data: DataBackend,
    /// Kurlar (Postgres: toplanır ve saklanır; SQLite: canlı)
    pub rates: crate::rates::RateService,
    /// TÜFE (Postgres: günlük toplanır; SQLite: istekte)
    pub cpi: crate::cpi::CpiService,
    pub limiter: RateLimiter,
    /// İki aşamalı giriş ve passkey adımları arasındaki kısa ömürlü biletler
    pub tickets: crate::mfa::Tickets,
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

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Unavailable(m) => {
                eprintln!("veritabanına ulaşılamıyor: {m}");
                ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "Veritabanına ulaşılamıyor.")
            }
            StoreError::Other(m) => ApiError::internal(m),
        }
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
            let Some(s) = state.auth.session(&hash)? else { return Err(unauthorized()) };
            let t = auth::now();
            if t - s.last_seen > auth::SESSION_TTL {
                state.auth.delete_session(&hash)?;
                return Err(unauthorized());
            }
            // Her istekte yazmamak için en fazla saatte bir güncellenir
            if t - s.last_seen > 3600 {
                state.auth.touch_session(&hash, t)?;
            }
            Ok(AuthUser { id: s.user_id, email: s.email, token_hash: hash })
        })
        .await
    }
}

// ---------------------------------------------------------------------------
// Kullanıcı verisi
// ---------------------------------------------------------------------------

/// Oturumdaki kullanıcının verisinde `f`'i tek veritabanı işleminde çalıştırır; finans-core hataları 400 olur.
pub async fn with_user_db<T: Send + 'static>(
    state: &Arc<AppState>,
    user: &AuthUser,
    f: impl FnOnce(&mut dyn DataStore) -> finans_core::CoreResult<T> + Send + 'static,
) -> Result<T, ApiError> {
    let state = state.clone();
    let id = user.id.clone();
    blocking(move || state.data.with_user(&*state.auth, &id, f)).await
}
