//! Dönemsel raporlar (oturum gerekir). Hesap finans-core::reports'ta.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::reports::{self, ReportsInput, ReportsReport};
use finans_core::store;
use serde::Deserialize;

use crate::app::{with_user_db, ApiError, AppState, AuthUser};

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/reports", get(report))
}

#[derive(Deserialize)]
struct ReportsQuery {
    preset: Option<String>,
    from: Option<String>,
    to: Option<String>,
    compare: Option<String>,
    kind: Option<String>,
    group: Option<String>,
}

async fn report(State(s): State<Arc<AppState>>, user: AuthUser, Query(q): Query<ReportsQuery>) -> Result<Json<ReportsReport>, ApiError> {
    let today = ymd(istanbul_today(unix_now()));
    let out = with_user_db(&s, &user, move |c| {
        let (txs, cats) = (store::list_transactions(c)?, store::list_categories(c)?);
        reports::report(&ReportsInput {
            transactions: &txs,
            categories: &cats,
            preset: q.preset.as_deref().unwrap_or("thisMonth"),
            from: q.from.as_deref(),
            to: q.to.as_deref(),
            compare: q.compare.as_deref().unwrap_or("previous"),
            kind: q.kind.as_deref().unwrap_or("expense"),
            group: q.group.as_deref().unwrap_or("category"),
            today: &today,
        })
    })
    .await?;
    Ok(Json(out))
}
