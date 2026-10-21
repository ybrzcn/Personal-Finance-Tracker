//! Genel Bakış istatistikleri ve kategori kullanımı (oturum gerekir). Hesap finans-core::overview'da.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::overview::{self, CategoryUsageReport, OverviewInput, OverviewReport, Period};
use finans_core::store;
use serde::Deserialize;

use crate::app::{with_user_db, ApiError, AppState, AuthUser};

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/overview", get(report)).route("/api/categories/usage", get(usage))
}

#[derive(Deserialize)]
struct OverviewQuery {
    period: Option<String>,
}

async fn report(State(s): State<Arc<AppState>>, user: AuthUser, Query(q): Query<OverviewQuery>) -> Result<Json<OverviewReport>, ApiError> {
    // Geçersiz dönem veriyi okumadan reddedilir
    let Some(period) = q.period.as_deref().and_then(Period::parse) else {
        return Err(ApiError::from("Geçersiz dönem".to_string()));
    };
    let today = ymd(istanbul_today(unix_now()));
    let out = with_user_db(&s, &user, move |c| {
        let (accs, cats, txs, rec) = (store::list_accounts(c)?, store::list_categories(c)?, store::list_transactions(c)?, store::list_recurring(c)?);
        Ok(overview::overview(&OverviewInput { accounts: &accs, categories: &cats, transactions: &txs, recurring: &rec, today: &today, period }))
    })
    .await?;
    Ok(Json(out))
}

async fn usage(State(s): State<Arc<AppState>>, user: AuthUser) -> Result<Json<CategoryUsageReport>, ApiError> {
    let out = with_user_db(&s, &user, move |c| Ok(overview::category_usage(&store::list_transactions(c)?))).await?;
    Ok(Json(out))
}
