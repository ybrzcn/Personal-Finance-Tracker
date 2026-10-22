//! İşlem ekleri (fiş, fatura) ve PDF'ten fiş önerisi (oturum gerekir). Doğrulama finans-core::store'da.
//! Ek içeriği kullanıcının yüklediği dosyadır: yalnız içerikten tanınan JPEG/PNG/WebP/PDF saklanır ve kum havuzunda sunulur.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use finans_core::db::Attachment;
use finans_core::receipt::ReceiptHint;
use finans_core::store;
use serde::Deserialize;
use serde_json::Value;

use crate::app::{with_user_db, ApiError, AppState, AuthUser};

type S = State<Arc<AppState>>;
type R<T> = Result<T, ApiError>;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/transactions/{id}/attachments", get(list).post(add))
        .route("/api/attachments/counts", get(counts))
        .route("/api/attachments/{id}", get(content).delete(remove))
        .route("/api/receipts/parse", post(parse_receipt))
        .layer(DefaultBodyLimit::max(store::ATTACHMENT_MAX_BYTES + 1024))
}

#[derive(Deserialize)]
struct NameQuery {
    #[serde(default)]
    name: String,
}

async fn add(State(s): S, user: AuthUser, Path(id): Path<String>, Query(q): Query<NameQuery>, body: Bytes) -> R<Json<Attachment>> {
    if !s.limiter.allow(&format!("attach:{}", user.id), 60, Duration::from_secs(60)) {
        return Err(ApiError::too_many());
    }
    let quota = (s.config.attachment_quota_mb > 0).then(|| (s.config.attachment_quota_mb * 1024 * 1024) as i64);
    Ok(Json(with_user_db(&s, &user, move |c| store::add_attachment(c, &id, &q.name, &body, quota)).await?))
}

async fn list(State(s): S, user: AuthUser, Path(id): Path<String>) -> R<Json<Vec<Attachment>>> {
    Ok(Json(with_user_db(&s, &user, move |c| store::list_attachments(c, &id)).await?))
}

async fn counts(State(s): S, user: AuthUser) -> R<Json<std::collections::BTreeMap<String, i64>>> {
    Ok(Json(with_user_db(&s, &user, store::attachment_counts).await?))
}

/// İçerik: saklanırken içerikten tanınan tür; tarayıcı tür tahmin etmez, belge kum havuzunda açılır (betik çalışmaz)
async fn content(State(s): S, user: AuthUser, Path(id): Path<String>) -> R<Response> {
    // Her istek 10 MB'a kadar belleğe okur: kullanıcı başına sınırlı
    if !s.limiter.allow(&format!("attach-get:{}", user.id), 300, Duration::from_secs(60)) {
        return Err(ApiError::too_many());
    }
    let found = with_user_db(&s, &user, move |c| store::get_attachment(c, &id)).await?;
    let Some((a, data)) = found else { return Err(ApiError::new(StatusCode::NOT_FOUND, "Belge bulunamadı.")) };
    let mut res = data.into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&a.mime).map_err(ApiError::internal)?);
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox; default-src 'none'; img-src 'self'; object-src 'self'"));
    // Ad yalnız ASCII ile; Türkçe ad filename* ile (RFC 5987)
    let ascii: String = a.name.chars().map(|c| if c.is_ascii_alphanumeric() || ".-_ ".contains(c) { c } else { '_' }).collect();
    let utf8: String = a.name.bytes().map(|b| if b.is_ascii_alphanumeric() || b".-_".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let disposition = format!("inline; filename=\"{ascii}\"; filename*=UTF-8''{utf8}");
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).map_err(ApiError::internal)?);
    Ok(res)
}

async fn remove(State(s): S, user: AuthUser, Path(id): Path<String>) -> R<StatusCode> {
    if with_user_db(&s, &user, move |c| store::delete_attachment(c, &id)).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::new(StatusCode::NOT_FOUND, "Belge bulunamadı."))
    }
}

/// PDF fişten tutar ve tarih önerisi: sınırlı alt süreçte (bellek, işlemci, 30 sn)
async fn parse_receipt(State(s): S, user: AuthUser, body: Bytes) -> R<Json<ReceiptHint>> {
    use tokio::io::AsyncWriteExt;
    if !s.limiter.allow(&format!("parse:{}", user.id), 20, Duration::from_secs(60)) {
        return Err(ApiError::too_many());
    }
    let _permit = s.parse_permits.acquire().await.map_err(ApiError::internal)?;
    let unreadable = || ApiError::from("Belge okunamadı.".to_string());
    let exe = std::env::current_exe().map_err(ApiError::internal)?;
    let mut child = tokio::process::Command::new(exe)
        .arg("parse-receipt")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(ApiError::internal)?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&body).await;
    }
    let out = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output()).await.map_err(|_| unreadable())?.map_err(ApiError::internal)?;
    if !out.status.success() {
        return Err(unreadable());
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| unreadable())?;
    match v.get("ok").and_then(Value::as_bool) {
        Some(true) => serde_json::from_value(v.get("hint").cloned().unwrap_or(Value::Null)).map(Json).map_err(|_| unreadable()),
        _ => Err(v.get("error").and_then(Value::as_str).map(str::to_string).map(ApiError::from).unwrap_or_else(unreadable)),
    }
}
