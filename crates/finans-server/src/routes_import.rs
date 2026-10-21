//! Ekstre satırları ve kategori önerileri (oturum gerekir). Hesap finans-core::import ve ::rules'ta.

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use finans_core::import::{rows_for, ImportRows, RowsRequest};
use finans_core::rules::{category_suggestions, read_rules, CategorySuggestions};
use finans_core::store;

use crate::app::{with_user_db, ApiError, AppState, AuthUser};

/// Satır isteği okunmuş tabloyu taşır (25 MB'lık ekstrenin tablosu sığsın)
const ROWS_BODY_LIMIT: usize = 32 * 1024 * 1024;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/statements/rows", post(rows).layer(DefaultBodyLimit::max(ROWS_BODY_LIMIT)))
        .route("/api/categories/suggestions", get(suggestions))
}

async fn rows(State(s): State<Arc<AppState>>, user: AuthUser, Json(req): Json<RowsRequest>) -> Result<Json<ImportRows>, ApiError> {
    // Veri bağlantı altında okunur, hesap bağlantı bırakıldıktan sonra (büyük tablo kullanıcının veritabanı kilidini tutmasın)
    let (accounts, txs, cats, settings) =
        with_user_db(&s, &user, |c| Ok((store::list_accounts(c)?, store::list_transactions(c)?, store::list_categories(c)?, store::get_settings(c)?))).await?;
    let out = tokio::task::spawn_blocking(move || rows_for(req, &accounts, &txs, &cats, &read_rules(&settings)))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::from)?;
    Ok(Json(out))
}

async fn suggestions(State(s): State<Arc<AppState>>, user: AuthUser) -> Result<Json<CategorySuggestions>, ApiError> {
    let out = with_user_db(&s, &user, move |c| {
        let (txs, cats, settings) = (store::list_transactions(c)?, store::list_categories(c)?, store::get_settings(c)?);
        Ok(category_suggestions(&txs, &cats, &read_rules(&settings)))
    })
    .await?;
    Ok(Json(out))
}
