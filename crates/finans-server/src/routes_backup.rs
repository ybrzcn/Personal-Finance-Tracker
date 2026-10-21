//! CSV dışa/içe aktarma ve JSON yedek (oturum gerekir). Hesap finans-core::import ve ::backup'ta.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use finans_core::backup::{backup_json, create_backup, now_iso, parse_backup, read_backup_data};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::import::{merge_csv_rows, parse_transactions_csv, transactions_to_csv, CsvMerge, CsvParse, CsvRow};
use finans_core::store;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app::{with_user_db, ApiError, AppState, AuthUser};

/// Yedek ve CSV metni gövdede gelir: girintili ve kaçışlı yedek metni, `restore`'un 25 MB'lık sıkışık verisinin yaklaşık iki katıdır
const TEXT_BODY_LIMIT: usize = 64 * 1024 * 1024;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/export/csv", post(export_csv).layer(DefaultBodyLimit::max(TEXT_BODY_LIMIT)))
        .route("/api/export/backup", get(export_backup))
        .route("/api/backup/parse", post(backup_parse).layer(DefaultBodyLimit::max(TEXT_BODY_LIMIT)))
        .route("/api/csv/parse", post(csv_parse).layer(DefaultBodyLimit::max(TEXT_BODY_LIMIT)))
        .route("/api/csv/merge", post(csv_merge).layer(DefaultBodyLimit::max(TEXT_BODY_LIMIT)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CsvRequest {
    /// null: bütün işlemler (veritabanı sırası); dizi: bu işlemler bu sırayla (bu kullanıcıda olmayanlar atlanır)
    transaction_ids: Option<Vec<String>>,
}

#[derive(Serialize)]
struct CsvText {
    csv: String,
}

#[derive(Serialize)]
struct JsonText {
    json: String,
}

#[derive(Deserialize)]
struct TextBody {
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeRequest {
    rows: Vec<CsvRow>,
    default_account_id: String,
}

async fn export_csv(State(s): State<Arc<AppState>>, user: AuthUser, Json(req): Json<CsvRequest>) -> Result<Json<CsvText>, ApiError> {
    let (txs, cats, accounts) =
        with_user_db(&s, &user, |c| Ok((store::list_transactions(c)?, store::list_categories(c)?, store::list_accounts(c)?))).await?;
    let csv = tokio::task::spawn_blocking(move || {
        let txs = match req.transaction_ids {
            None => txs,
            Some(ids) => {
                let by_id: HashMap<&str, &finans_core::db::Transaction> = txs.iter().map(|t| (t.id.as_str(), t)).collect();
                ids.iter().filter_map(|id| by_id.get(id.as_str()).map(|t| (*t).clone())).collect()
            }
        };
        transactions_to_csv(&txs, &cats, &accounts)
    })
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(CsvText { csv }))
}

async fn export_backup(State(s): State<Arc<AppState>>, user: AuthUser) -> Result<Json<JsonText>, ApiError> {
    let (data, settings) = with_user_db(&s, &user, |c| Ok((read_backup_data(c)?, store::get_settings(c)?))).await?;
    let json = tokio::task::spawn_blocking(move || backup_json(&create_backup(&data, &settings, &now_iso())))
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(JsonText { json }))
}

async fn backup_parse(_user: AuthUser, Json(b): Json<TextBody>) -> Result<Json<Value>, ApiError> {
    let today = ymd(istanbul_today(unix_now()));
    let out = tokio::task::spawn_blocking(move || parse_backup(&b.text, &today))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::from)?;
    Ok(Json(out))
}

async fn csv_parse(_user: AuthUser, Json(b): Json<TextBody>) -> Result<Json<CsvParse>, ApiError> {
    let out = tokio::task::spawn_blocking(move || parse_transactions_csv(&b.text))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::from)?;
    Ok(Json(out))
}

async fn csv_merge(State(s): State<Arc<AppState>>, user: AuthUser, Json(req): Json<MergeRequest>) -> Result<Json<CsvMerge>, ApiError> {
    let (cats, accounts) = with_user_db(&s, &user, |c| Ok((store::list_categories(c)?, store::list_accounts(c)?))).await?;
    if !accounts.iter().any(|a| a.id == req.default_account_id) {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Bulunamadı."));
    }
    let out = tokio::task::spawn_blocking(move || merge_csv_rows(&req.rows, &cats, &accounts, &req.default_account_id, &now_iso()))
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(out))
}
