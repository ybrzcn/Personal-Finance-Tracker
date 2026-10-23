//! İki aşamalı doğrulama: doğrulama uygulaması kodu (TOTP) kurulumu ve passkey ekleme/giriş.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::app::{blocking, hashing, ApiError, AppState, AuthUser};
use crate::auth;
use crate::auth_store::PasskeyRow;
use crate::mfa::{self, Ticket};
use crate::routes_auth::{client_ip, session_response, MINUTE};
use crate::webauthn::{self, Assertion, Registration};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/me/security", get(security))
        .route("/api/me/totp/setup", post(totp_setup))
        .route("/api/me/totp/enable", post(totp_enable))
        .route("/api/me/totp/disable", post(totp_disable))
        .route("/api/me/passkeys/options", post(passkey_register_options))
        .route("/api/me/passkeys", post(passkey_register))
        .route("/api/me/passkeys/{id}", delete(passkey_delete))
        .route("/api/auth/passkey/options", post(passkey_login_options))
        .route("/api/auth/passkey/login", post(passkey_login))
}

const TOTP_ON: &str = "Doğrulama uygulaması zaten açık; değiştirmek için önce kapatın.";
const SETUP_TTL: Duration = Duration::from_secs(600);
const CEREMONY_TTL: Duration = Duration::from_secs(300);
/// Kullanıcı başına en çok passkey
const MAX_PASSKEYS: usize = 20;

fn passkey_json(p: &PasskeyRow) -> serde_json::Value {
    json!({ "id": p.id, "name": p.name, "createdAt": p.created_at, "lastUsed": p.last_used })
}

async fn security(State(state): State<Arc<AppState>>, user: AuthUser) -> Result<Json<serde_json::Value>, ApiError> {
    let st = state.clone();
    blocking(move || {
        let (secret, _) = st.auth.totp(&user.id)?;
        let passkeys: Vec<_> = st.auth.list_passkeys(&user.id)?.iter().map(passkey_json).collect();
        Ok(Json(json!({ "totp": secret.is_some(), "passkeys": passkeys })))
    })
    .await
}

/// Güvenlik ayarı değişikliklerinde şifre yeniden sorulur (açık kalmış bir oturumla ayar değiştirilemesin).
pub(crate) async fn check_password(state: &Arc<AppState>, user: &AuthUser, password: String) -> Result<(), ApiError> {
    if password.len() > 512 || !state.limiter.allow(&format!("security:{}", user.id), 10, MINUTE) {
        return Err(ApiError::too_many());
    }
    let st = state.clone();
    let id = user.id.clone();
    hashing(state, move || {
        let hash = st.auth.password_hash(&id)?.ok_or_else(|| ApiError::internal("kullanıcı yok"))?;
        if !auth::verify_secret(&password, &hash) {
            return Err("Şifre hatalı.".to_string().into());
        }
        Ok(())
    })
    .await
}

#[derive(Deserialize)]
struct PasswordBody {
    password: String,
}

#[derive(Deserialize)]
struct PasskeyOptionsBody {
    password: String,
    /// Doğrulama uygulaması açıksa güncel kod
    #[serde(default)]
    code: String,
}

/// Kurulum: yeni anahtar üretilir ama ilk doğru koda kadar kaydedilmez.
/// Açıkken yeni anahtar verilmez (yalnız şifreyle ikinci adım değiştirilemesin); önce kod ve şifreyle kapatılır.
async fn totp_setup(State(state): State<Arc<AppState>>, user: AuthUser, Json(b): Json<PasswordBody>) -> Result<Json<serde_json::Value>, ApiError> {
    check_password(&state, &user, b.password).await?;
    let st = state.clone();
    let uid = user.id.clone();
    if blocking(move || Ok(st.auth.totp(&uid)?.0.is_some())).await? {
        return Err(TOTP_ON.to_string().into());
    }
    let secret = mfa::new_totp_secret();
    let uri = mfa::otpauth_uri(&user.email, &secret);
    let qr = mfa::qr_svg(&uri);
    let ticket = state.tickets.issue(Ticket::TotpSetup { user_id: user.id, secret: secret.clone() }, SETUP_TTL);
    Ok(Json(json!({ "ticket": ticket, "secret": secret, "uri": uri, "qr": qr })))
}

#[derive(Deserialize)]
struct TotpEnable {
    ticket: String,
    code: String,
}

async fn totp_enable(State(state): State<Arc<AppState>>, user: AuthUser, Json(b): Json<TotpEnable>) -> Result<StatusCode, ApiError> {
    if !state.limiter.allow(&format!("security:{}", user.id), 10, MINUTE) {
        return Err(ApiError::too_many());
    }
    let expired = || ApiError::from("Kurulumun süresi doldu; baştan başlayın.".to_string());
    let Some(Ticket::TotpSetup { user_id, secret }) = state.tickets.peek(&b.ticket) else { return Err(expired()) };
    if user_id != user.id {
        return Err(expired());
    }
    let Some((_, last_try)) = state.tickets.attempt(&b.ticket) else { return Err(expired()) };
    let Some(step) = mfa::verify_totp(&secret, &b.code, auth::now(), None) else {
        if last_try {
            state.tickets.take(&b.ticket);
            return Err("Kod hatalı. Çok fazla yanlış deneme: kurulumun süresi doldu; baştan başlayın.".to_string().into());
        }
        return Err("Kod hatalı. Uygulamadaki güncel kodu girin.".to_string().into());
    };
    state.tickets.take(&b.ticket).ok_or_else(expired)?;
    let st = state.clone();
    blocking(move || {
        if st.auth.totp(&user.id)?.0.is_some() {
            return Err(TOTP_ON.to_string().into());
        }
        st.auth.set_totp(&user.id, Some(&secret))?;
        // Kurulumda girilen kod girişte tekrar kullanılamasın
        st.auth.use_totp_step(&user.id, step)?;
        // Açık kalmış başka oturumlar (ör. çalınmış çerez) kapanır
        st.auth.delete_sessions(&user.id, Some(&user.token_hash))?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct TotpDisable {
    password: String,
    code: String,
}

/// Kapatmak için şifre ve güncel kod birlikte istenir.
async fn totp_disable(State(state): State<Arc<AppState>>, user: AuthUser, Json(b): Json<TotpDisable>) -> Result<StatusCode, ApiError> {
    check_password(&state, &user, b.password).await?;
    let st = state.clone();
    blocking(move || {
        let (secret, last) = st.auth.totp(&user.id)?;
        let Some(secret) = secret else { return Ok(()) };
        let ok = match mfa::verify_totp(&secret, &b.code, auth::now(), last) {
            Some(step) => st.auth.use_totp_step(&user.id, step)?,
            None => false,
        };
        if !ok {
            return Err("Kod hatalı. Uygulamadaki güncel kodu girin.".to_string().into());
        }
        st.auth.set_totp(&user.id, None)?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Passkey'in bağlanacağı alan adı: isteğin Host başlığı (HTTP/2'de adres).
fn rp_id(headers: &HeaderMap, uri: &Uri) -> Result<String, ApiError> {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).or_else(|| uri.authority().map(|a| a.as_str())).unwrap_or("");
    Ok(webauthn::rp_id_from_host(host)?)
}

async fn passkey_register_options(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    headers: HeaderMap,
    uri: Uri,
    Json(b): Json<PasskeyOptionsBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let rp_id = rp_id(&headers, &uri)?;
    check_password(&state, &user, b.password).await?;
    let st = state.clone();
    let uid = user.id.clone();
    // Doğrulama uygulaması açıksa passkey ancak kodla eklenir (passkey ikinci adımı atlar)
    let existing = blocking(move || {
        let (secret, last) = st.auth.totp(&uid)?;
        if let Some(secret) = secret {
            if b.code.trim().is_empty() {
                return Err("Doğrulama uygulamasındaki kodu da girin.".to_string().into());
            }
            let ok = match mfa::verify_totp(&secret, &b.code, auth::now(), last) {
                Some(step) => st.auth.use_totp_step(&uid, step)?,
                None => false,
            };
            if !ok {
                return Err("Kod hatalı. Uygulamadaki güncel kodu girin.".to_string().into());
            }
        }
        Ok(st.auth.list_passkeys(&uid)?)
    })
    .await?;
    if existing.len() >= MAX_PASSKEYS {
        return Err(format!("En çok {MAX_PASSKEYS} passkey eklenebilir.").into());
    }
    let challenge = webauthn::new_challenge();
    let exclude: Vec<_> = existing.iter().filter(|p| p.rp_id == rp_id).map(|p| p.id.clone()).collect();
    let ticket =
        state.tickets.issue(Ticket::PasskeyRegister { user_id: user.id.clone(), challenge: challenge.clone(), rp_id: rp_id.clone() }, CEREMONY_TTL);
    Ok(Json(json!({
        "ticket": ticket,
        "challenge": challenge,
        "rp": { "id": rp_id, "name": "Finans" },
        "user": { "id": webauthn::b64(user.id.as_bytes()), "name": user.email, "displayName": user.email },
        "algs": webauthn::ALGS,
        "excludeCredentials": exclude,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasskeyRegister {
    ticket: String,
    #[serde(default)]
    name: String,
    id: String,
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
    authenticator_data: String,
    public_key: String,
    alg: i64,
}

async fn passkey_register(State(state): State<Arc<AppState>>, user: AuthUser, Json(b): Json<PasskeyRegister>) -> Result<Json<serde_json::Value>, ApiError> {
    let expired = || ApiError::from("Passkey ekleme süresi doldu; baştan başlayın.".to_string());
    let Some(Ticket::PasskeyRegister { user_id, challenge, rp_id }) = state.tickets.take_if(&b.ticket, |t| matches!(t, Ticket::PasskeyRegister { .. })) else {
        return Err(expired());
    };
    if user_id != user.id {
        return Err(expired());
    }
    let client_data = webauthn::unb64(&b.client_data_json)?;
    let auth_data = webauthn::unb64(&b.authenticator_data)?;
    let public_key = webauthn::unb64(&b.public_key)?;
    let sign_count = webauthn::verify_registration(
        &Registration { id: &b.id, client_data: &client_data, auth_data: &auth_data, public_key: &public_key, alg: b.alg },
        &challenge,
        &rp_id,
    )?;
    let name: String = b.name.trim().chars().filter(|c| !c.is_control()).take(60).collect();
    let token_hash = user.token_hash.clone();
    let row = PasskeyRow {
        // Tek biçim (dolgusuz base64url): aynı kimlik farklı yazımla ikinci kez eklenemesin
        id: webauthn::b64(&webauthn::unb64(&b.id)?),
        user_id: user.id,
        name: if name.is_empty() { "Passkey".into() } else { name },
        rp_id,
        alg: b.alg,
        public_key,
        sign_count: i64::from(sign_count),
        created_at: auth::now(),
        last_used: None,
    };
    let st = state.clone();
    blocking(move || {
        if st.auth.list_passkeys(&row.user_id)?.len() >= MAX_PASSKEYS {
            return Err(format!("En çok {MAX_PASSKEYS} passkey eklenebilir.").into());
        }
        if !st.auth.insert_passkey(&row)? {
            return Err("Bu passkey zaten kayıtlı.".to_string().into());
        }
        // Açık kalmış başka oturumlar (ör. çalınmış çerez) kapanır
        st.auth.delete_sessions(&row.user_id, Some(&token_hash))?;
        Ok(Json(passkey_json(&row)))
    })
    .await
}

/// Silmek de şifre ister (açık kalmış bir oturumla kullanıcının giriş yolu kaldırılamasın).
async fn passkey_delete(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(b): Json<PasswordBody>,
) -> Result<StatusCode, ApiError> {
    check_password(&state, &user, b.password).await?;
    let st = state.clone();
    let found = blocking(move || Ok(st.auth.delete_passkey(&user.id, &id)?)).await?;
    if found {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::new(StatusCode::NOT_FOUND, "Passkey bulunamadı."))
    }
}

async fn passkey_login_options(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !state.limiter.allow(&format!("passkey:ip:{}", client_ip(&state, &headers, &peer)), 30, MINUTE) {
        return Err(ApiError::too_many());
    }
    let rp_id = rp_id(&headers, &uri)?;
    let challenge = webauthn::new_challenge();
    let ticket = state.tickets.issue(Ticket::PasskeyLogin { challenge: challenge.clone(), rp_id: rp_id.clone() }, CEREMONY_TTL);
    Ok(Json(json!({ "ticket": ticket, "challenge": challenge, "rpId": rp_id })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasskeyLogin {
    ticket: String,
    id: String,
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
    authenticator_data: String,
    signature: String,
    #[serde(default)]
    device: String,
}

/// Passkey ile şifresiz giriş (parmak izi/yüz/PIN zorunlu olduğu için iki aşamalı doğrulama yerine geçer).
async fn passkey_login(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(b): Json<PasskeyLogin>,
) -> Result<Response, ApiError> {
    let bad = |m: &str| ApiError::new(StatusCode::UNAUTHORIZED, m);
    if !state.limiter.allow(&format!("passkey:ip:{}", client_ip(&state, &headers, &peer)), 30, MINUTE) {
        return Err(ApiError::too_many());
    }
    let Some(Ticket::PasskeyLogin { challenge, rp_id }) = state.tickets.take_if(&b.ticket, |t| matches!(t, Ticket::PasskeyLogin { .. })) else {
        return Err(bad("Giriş adımının süresi doldu; yeniden deneyin."));
    };
    if b.id.len() > 1400 {
        return Err(bad("Passkey doğrulanamadı."));
    }
    let unb64 = |s: &str| webauthn::unb64(s).map_err(|m| bad(&m));
    let (client_data, auth_data, signature) = (unb64(&b.client_data_json)?, unb64(&b.authenticator_data)?, unb64(&b.signature)?);
    let cred_id = webauthn::b64(&unb64(&b.id)?);
    let st = state.clone();
    let (id, email, token) = blocking(move || {
        let bad = |m: &str| ApiError::new(StatusCode::UNAUTHORIZED, m);
        let pk = st.auth.passkey(&cred_id)?.filter(|p| p.rp_id == rp_id).ok_or_else(|| bad("Bu passkey bu sunucuda kayıtlı değil."))?;
        let count = webauthn::verify_assertion(
            &Assertion { client_data: &client_data, auth_data: &auth_data, signature: &signature },
            &challenge,
            &rp_id,
            pk.alg,
            &pk.public_key,
            pk.sign_count,
        )
        .map_err(|m| bad(&m))?;
        if !st.auth.passkey_used(&pk.id, pk.sign_count, i64::from(count), auth::now())? {
            return Err(bad("Passkey doğrulanamadı."));
        }
        let email = st.auth.user_email(&pk.user_id)?.ok_or_else(|| bad("Passkey doğrulanamadı."))?;
        let token = auth::create_session(&*st.auth, &pk.user_id, &b.device)?;
        Ok((pk.user_id, email, token))
    })
    .await?;
    Ok(session_response(&state, StatusCode::OK, &token, json!({ "token": token, "user": { "id": id, "email": email } })))
}
