//! /api/auth/* ve /api/me: kayıt, giriş, çıkış.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::app::{
    blocking, clear_cookie, hashing, delete_user, lock_auth, remove_user_files, session_cookie, user_db, ApiError, AppState, AuthUser,
};
use crate::auth;
use crate::config::ProxyMode;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/change-password", post(change_password))
        .route("/api/auth/recover", post(recover))
        .route("/api/me", get(me).delete(delete_me))
}

#[derive(Deserialize)]
struct Credentials {
    email: String,
    password: String,
    #[serde(default)]
    device: String,
}

const MINUTE: Duration = Duration::from_secs(60);
const HOUR: Duration = Duration::from_secs(3600);
const BAD_LOGIN: &str = "E-posta veya şifre hatalı.";

/// İstemci IP'si (deneme sınırları için). Proxy başlıklarına yalnız `FINANS_TRUST_PROXY` ayarlıysa güvenilir;
/// sunucu yalnız proxy'den erişilebilir olmalı (compose portu 127.0.0.1'e açar).
fn client_ip(state: &AppState, headers: &HeaderMap, peer: &SocketAddr) -> String {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim).filter(|v| !v.is_empty());
    let ip = match state.config.proxy {
        ProxyMode::Cloudflare => header("cf-connecting-ip").map(str::to_string),
        ProxyMode::ForwardedFor => headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .map(str::trim)
            .rfind(|v| !v.is_empty())
            .map(str::to_string),
        ProxyMode::None => None,
    };
    ip.map(|v| v.chars().take(64).collect()).unwrap_or_else(|| peer.ip().to_string())
}

/// Giriş/kurtarma denemeleri: IP başına 30/dk, e-posta başına 10/dk. IP sınırı önce bakılır
/// (aşılmışsa e-posta sayacına yeni kayıt eklenmez).
fn limit_attempts(state: &AppState, kind: &str, email: &str, ip: &str) -> Result<(), ApiError> {
    if !state.limiter.allow(&format!("{kind}:ip:{ip}"), 30, MINUTE) || !state.limiter.allow(&format!("{kind}:e:{email}"), 10, MINUTE) {
        return Err(ApiError::too_many());
    }
    Ok(())
}

/// Oturum açan yanıt: çerez (web) + gövdede token (masaüstü/mobil).
fn session_response(state: &AppState, status: StatusCode, token: &str, body: serde_json::Value) -> Response {
    (status, [(header::SET_COOKIE, session_cookie(&state.config, token))], Json(body)).into_response()
}

async fn register(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(c): Json<Credentials>,
) -> Result<Response, ApiError> {
    if !state.config.registration_open {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Bu sunucuda yeni kayıt kapalı."));
    }
    if !state.limiter.allow(&format!("register:ip:{}", client_ip(&state, &headers, &peer)), 5, HOUR) {
        return Err(ApiError::too_many());
    }
    let email = auth::normalize_email(&c.email)?;
    auth::check_password(&c.password)?;
    let st = state.clone();
    let user_email = email.clone();
    let (id, token, code) = hashing(&state, move || {
        if st.config.max_users > 0 {
            let count: i64 = lock_auth(&st)?
                .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
                .map_err(ApiError::internal)?;
            if count as u64 >= st.config.max_users {
                return Err(ApiError::new(StatusCode::FORBIDDEN, "Bu sunucuda yeni hesap açılamıyor (kullanıcı sınırına ulaşıldı)."));
            }
        }
        let password_hash = auth::hash_secret(&c.password);
        let code = auth::new_recovery_code();
        let recovery_hash = auth::hash_secret(&code);
        let id = uuid::Uuid::new_v4().to_string();
        let conn = lock_auth(&st)?;
        let inserted = conn.execute(
            "INSERT INTO users (id, email, password_hash, recovery_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            (&id, &email, &password_hash, &recovery_hash, auth::now()),
        );
        match inserted {
            Err(rusqlite::Error::SqliteFailure(f, _)) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                return Err("Bu e-posta ile kayıtlı bir hesap var.".to_string().into());
            }
            other => other.map_err(ApiError::internal)?,
        };
        let token = auth::create_session(&conn, &id, &c.device).map_err(ApiError::internal)?;
        drop(conn);
        // Kullanıcının veritabanı hemen oluşturulur (varsayılan kategorilerle); olmazsa yarım hesap bırakılmaz
        if let Err(e) = user_db(&st, &id) {
            let _ = lock_auth(&st)?.execute("DELETE FROM users WHERE id = ?1", [&id]);
            remove_user_files(&st.config.data_dir.join("users"), &id);
            return Err(e);
        }
        Ok((id, token, code))
    })
    .await?;
    Ok(session_response(
        &state,
        StatusCode::CREATED,
        &token,
        json!({ "token": token, "user": { "id": id, "email": user_email }, "recoveryCode": code }),
    ))
}

async fn login(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(c): Json<Credentials>,
) -> Result<Response, ApiError> {
    // Aşırı uzun girdiler sayaca ve Argon2'ye hiç ulaşmaz
    let email = auth::normalize_email(&c.email).map_err(|_| ApiError::new(StatusCode::UNAUTHORIZED, BAD_LOGIN))?;
    if c.password.len() > 512 {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, BAD_LOGIN));
    }
    limit_attempts(&state, "login", &email, &client_ip(&state, &headers, &peer))?;
    let st = state.clone();
    let (id, email, token) = hashing(&state, move || {
        let user = auth::find_user(&*lock_auth(&st)?, &email).map_err(ApiError::internal)?;
        let bad = || ApiError::new(StatusCode::UNAUTHORIZED, BAD_LOGIN);
        let Some(user) = user else {
            auth::dummy_verify(&c.password);
            return Err(bad());
        };
        if !auth::verify_secret(&c.password, &user.password_hash) {
            return Err(bad());
        }
        let token = auth::create_session(&*lock_auth(&st)?, &user.id, &c.device).map_err(ApiError::internal)?;
        Ok((user.id, user.email, token))
    })
    .await?;
    Ok(session_response(&state, StatusCode::OK, &token, json!({ "token": token, "user": { "id": id, "email": email } })))
}

async fn logout(State(state): State<Arc<AppState>>, user: AuthUser) -> Result<Response, ApiError> {
    let st = state.clone();
    blocking(move || {
        lock_auth(&st)?
            .execute("DELETE FROM sessions WHERE token_hash = ?1", [&user.token_hash])
            .map_err(ApiError::internal)?;
        Ok(())
    })
    .await?;
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, clear_cookie(&state.config))]).into_response())
}

async fn me(user: AuthUser) -> Json<serde_json::Value> {
    Json(json!({ "id": user.id, "email": user.email }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePassword {
    current_password: String,
    new_password: String,
}

/// Şifre değişince bu oturum dışındaki tüm oturumlar kapanır.
async fn change_password(State(state): State<Arc<AppState>>, user: AuthUser, Json(b): Json<ChangePassword>) -> Result<StatusCode, ApiError> {
    auth::check_password(&b.new_password)?;
    if !state.limiter.allow(&format!("change:{}", user.id), 10, MINUTE) {
        return Err(ApiError::too_many());
    }
    let st = state.clone();
    hashing(&state, move || {
        let current: String = lock_auth(&st)?
            .query_row("SELECT password_hash FROM users WHERE id = ?1", [&user.id], |r| r.get(0))
            .map_err(ApiError::internal)?;
        if !auth::verify_secret(&b.current_password, &current) {
            return Err("Mevcut şifre hatalı.".to_string().into());
        }
        let hash = auth::hash_secret(&b.new_password);
        let conn = lock_auth(&st)?;
        conn.execute("UPDATE users SET password_hash = ?2 WHERE id = ?1", (&user.id, &hash))
            .map_err(ApiError::internal)?;
        conn.execute("DELETE FROM sessions WHERE user_id = ?1 AND token_hash <> ?2", (&user.id, &user.token_hash))
            .map_err(ApiError::internal)?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recover {
    email: String,
    recovery_code: String,
    new_password: String,
    #[serde(default)]
    device: String,
}

/// Kurtarma kodu tek kullanımlıktır: başarılı kurtarmada yeni kod verilir, tüm oturumlar kapanır.
async fn recover(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(b): Json<Recover>,
) -> Result<Response, ApiError> {
    let email = auth::normalize_email(&b.email).map_err(|_| ApiError::from("E-posta veya kurtarma kodu hatalı.".to_string()))?;
    if b.recovery_code.len() > 64 {
        return Err("E-posta veya kurtarma kodu hatalı.".to_string().into());
    }
    limit_attempts(&state, "recover", &email, &client_ip(&state, &headers, &peer))?;
    auth::check_password(&b.new_password)?;
    let st = state.clone();
    let (id, email, token, code) = hashing(&state, move || {
        let bad = || ApiError::from("E-posta veya kurtarma kodu hatalı.".to_string());
        let code = auth::normalize_recovery_code(&b.recovery_code);
        let Some(user) = auth::find_user(&*lock_auth(&st)?, &email).map_err(ApiError::internal)? else {
            auth::dummy_verify(&code);
            return Err(bad());
        };
        if !auth::verify_secret(&code, &user.recovery_hash) {
            return Err(bad());
        }
        let password_hash = auth::hash_secret(&b.new_password);
        let new_code = auth::new_recovery_code();
        let recovery_hash = auth::hash_secret(&new_code);
        let conn = lock_auth(&st)?;
        conn.execute(
            "UPDATE users SET password_hash = ?2, recovery_hash = ?3 WHERE id = ?1",
            (&user.id, &password_hash, &recovery_hash),
        )
        .map_err(ApiError::internal)?;
        conn.execute("DELETE FROM sessions WHERE user_id = ?1", [&user.id]).map_err(ApiError::internal)?;
        let token = auth::create_session(&conn, &user.id, &b.device).map_err(ApiError::internal)?;
        Ok((user.id, user.email, token, new_code))
    })
    .await?;
    Ok(session_response(
        &state,
        StatusCode::OK,
        &token,
        json!({ "token": token, "user": { "id": id, "email": email }, "recoveryCode": code }),
    ))
}

#[derive(Deserialize)]
struct DeleteMe {
    password: String,
}

/// Hesabı ve tüm verisini siler (oturumlar, kullanıcı satırı, veritabanı dosyası ve yedekleri).
async fn delete_me(State(state): State<Arc<AppState>>, user: AuthUser, Json(b): Json<DeleteMe>) -> Result<Response, ApiError> {
    if !state.limiter.allow(&format!("delete:{}", user.id), 10, MINUTE) {
        return Err(ApiError::too_many());
    }
    let st = state.clone();
    hashing(&state, move || {
        let hash: String = lock_auth(&st)?
            .query_row("SELECT password_hash FROM users WHERE id = ?1", [&user.id], |r| r.get(0))
            .map_err(ApiError::internal)?;
        if !auth::verify_secret(&b.password, &hash) {
            return Err("Şifre hatalı.".to_string().into());
        }
        delete_user(&st, &user.id)
    })
    .await?;
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, clear_cookie(&state.config))]).into_response())
}
