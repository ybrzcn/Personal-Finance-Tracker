//! Uçtan uca şifreli eşitleme (oturum gerekir). Sunucu yalnız şifreli parçaları ve parolayla sarılmış anahtarı
//! saklar; içeriği okuyamaz. Veri sürümlüdür: istemci okuduğu sürümün üzerine yazar, arada değiştiyse 409.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use finans_core::sync::crypto::Keyring;
use finans_core::sync::remote::{MAX_DATA, MAX_FILE};
use serde::Deserialize;
use serde_json::json;

use crate::app::{blocking, ApiError, AppState, AuthUser};
use crate::auth;
use crate::auth_store::SyncPut;
use crate::routes_security::check_password;

type S = State<Arc<AppState>>;
type R<T> = Result<T, ApiError>;

const MINUTE: Duration = Duration::from_secs(60);

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/sync", get(meta).delete(delete_all))
        .route("/api/sync/keyring", put(set_keyring))
        .route("/api/sync/data", get(get_data).put(put_data).layer(DefaultBodyLimit::max(MAX_DATA as usize)))
        .route("/api/sync/files", get(list_files))
        .route("/api/sync/files/{id}", get(get_file).put(put_file).delete(delete_file).layer(DefaultBodyLimit::max(MAX_FILE as usize)))
}

fn key_changed() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "Eşitleme başka bir cihazdan sıfırlanmış ya da kapatılmış; bu cihazı yeniden bağlayın.")
}

fn limit(s: &AppState, user: &AuthUser) -> R<()> {
    // Dosya aktarımı tek tek istek: yüksek ama sınırlı
    if s.limiter.allow(&format!("sync:{}", user.id), 600, MINUTE) {
        Ok(())
    } else {
        Err(ApiError::too_many())
    }
}

fn valid_id(id: &str) -> R<()> {
    if (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::NOT_FOUND, "Dosya bulunamadı."))
    }
}

fn key_header(h: &HeaderMap) -> R<String> {
    h.get("x-sync-key").and_then(|v| v.to_str().ok()).filter(|k| k.len() <= 64).map(str::to_string).ok_or_else(key_changed)
}

fn quota(s: &AppState) -> Option<i64> {
    (s.config.sync_quota_mb > 0).then(|| (s.config.sync_quota_mb * 1024 * 1024) as i64)
}

fn over_quota(s: &AppState) -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, format!("Eşitleme kotası ({} MB) doldu.", s.config.sync_quota_mb))
}

async fn meta(State(s): S, user: AuthUser) -> R<Json<serde_json::Value>> {
    limit(&s, &user)?;
    let st = s.clone();
    blocking(move || {
        Ok(Json(match st.auth.sync_meta(&user.id)? {
            None => json!({ "keyring": null, "version": 0 }),
            Some(m) => {
                let keyring: serde_json::Value = serde_json::from_str(&m.keyring).unwrap_or(serde_json::Value::Null);
                json!({
                    "keyring": keyring,
                    "version": m.version,
                    "updatedAt": m.updated_at,
                    "dataBytes": m.data_bytes,
                    "files": m.files,
                    "filesBytes": m.files_bytes,
                })
            }
        }))
    })
    .await
}

#[derive(Deserialize)]
struct KeyringBody {
    keyring: Keyring,
}

/// İlk kurulum ya da aynı anahtarın yeni parolayla sarımı. Başka anahtar ancak sunucudaki veri silinince kurulur.
async fn set_keyring(State(s): S, user: AuthUser, Json(b): Json<KeyringBody>) -> R<StatusCode> {
    limit(&s, &user)?;
    let k = &b.keyring;
    let ok = k.key_id.len() == 32
        && k.key_id.bytes().all(|c| c.is_ascii_hexdigit())
        && [&k.kdf, &k.salt, &k.nonce, &k.wrapped].iter().all(|v| v.len() <= 256);
    if !ok {
        return Err("Eşitleme anahtarlığı geçersiz.".to_string().into());
    }
    let json = serde_json::to_string(k).map_err(ApiError::internal)?;
    let key_id = k.key_id.clone();
    let st = s.clone();
    if blocking(move || Ok(st.auth.sync_set_keyring(&user.id, &key_id, &json, auth::now())?)).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(key_changed())
    }
}

async fn get_data(State(s): S, user: AuthUser) -> R<Response> {
    limit(&s, &user)?;
    let st = s.clone();
    let Some((version, data)) = blocking(move || Ok(st.auth.sync_data(&user.id)?)).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Sunucuda eşitleme verisi yok."));
    };
    let mut res = data.into_response();
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    res.headers_mut().insert("x-sync-version", HeaderValue::from(version));
    Ok(res)
}

async fn put_data(State(s): S, user: AuthUser, headers: HeaderMap, body: Bytes) -> R<Response> {
    limit(&s, &user)?;
    if !s.limiter.allow(&format!("sync-put:{}", user.id), 30, MINUTE) {
        return Err(ApiError::too_many());
    }
    let key_id = key_header(&headers)?;
    let base: i64 = headers
        .get("x-sync-base")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .filter(|v| *v >= 0)
        .ok_or_else(|| ApiError::from("Eşitleme sürümü eksik.".to_string()))?;
    let (st, q) = (s.clone(), quota(&s));
    match blocking(move || Ok(st.auth.sync_put_data(&user.id, &key_id, base, &body, auth::now(), q)?)).await? {
        SyncPut::Ok(v) => Ok(Json(json!({ "version": v })).into_response()),
        SyncPut::Conflict => Ok((
            StatusCode::CONFLICT,
            Json(json!({ "error": "Sunucudaki veri bu arada değişti.", "code": "conflict" })),
        )
            .into_response()),
        SyncPut::KeyChanged => Err(key_changed()),
        SyncPut::OverQuota => Err(over_quota(&s)),
    }
}

async fn list_files(State(s): S, user: AuthUser) -> R<Json<serde_json::Value>> {
    limit(&s, &user)?;
    let st = s.clone();
    let files = blocking(move || Ok(st.auth.sync_files(&user.id)?)).await?;
    let files: Vec<_> = files.iter().map(|f| json!({ "id": f.id, "size": f.size, "createdAt": f.created_at })).collect();
    Ok(Json(json!({ "files": files })))
}

async fn get_file(State(s): S, user: AuthUser, Path(id): Path<String>) -> R<Response> {
    limit(&s, &user)?;
    valid_id(&id)?;
    let st = s.clone();
    let Some(data) = blocking(move || Ok(st.auth.sync_file(&user.id, &id)?)).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Dosya bulunamadı."));
    };
    let mut res = data.into_response();
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    Ok(res)
}

async fn put_file(State(s): S, user: AuthUser, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> R<StatusCode> {
    limit(&s, &user)?;
    valid_id(&id)?;
    let key_id = key_header(&headers)?;
    let (st, q) = (s.clone(), quota(&s));
    match blocking(move || Ok(st.auth.sync_put_file(&user.id, &key_id, &id, &body, auth::now(), q)?)).await? {
        SyncPut::Ok(_) => Ok(StatusCode::NO_CONTENT),
        SyncPut::OverQuota => Err(over_quota(&s)),
        _ => Err(key_changed()),
    }
}

async fn delete_file(State(s): S, user: AuthUser, Path(id): Path<String>) -> R<StatusCode> {
    limit(&s, &user)?;
    valid_id(&id)?;
    let st = s.clone();
    if blocking(move || Ok(st.auth.sync_delete_file(&user.id, &id)?)).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::new(StatusCode::NOT_FOUND, "Dosya bulunamadı."))
    }
}

#[derive(Deserialize)]
struct PasswordBody {
    password: String,
}

/// Sunucudaki şifreli veri, dosyalar ve anahtarlık silinir; bağlı cihazlar sonraki turda durur (verileri yerinde kalır).
async fn delete_all(State(s): S, user: AuthUser, Json(b): Json<PasswordBody>) -> R<StatusCode> {
    check_password(&s, &user, b.password).await?;
    let st = s.clone();
    blocking(move || Ok(st.auth.sync_delete(&user.id)?)).await?;
    Ok(StatusCode::NO_CONTENT)
}
