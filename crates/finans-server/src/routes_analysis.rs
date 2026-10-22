//! Analiz: abonelikler ve değişken gider tahmini (oturum gerekir). Hesap finans-core::analysis'te.

use std::sync::Arc;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use finans_core::analysis::{self, AnalysisInput, AnalysisReport};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::store;

use crate::app::{with_user_db, ApiError, AppState, AuthUser};

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/analysis", get(report))
}

async fn report(State(s): State<Arc<AppState>>, user: AuthUser) -> Result<Json<AnalysisReport>, ApiError> {
    let today = ymd(istanbul_today(unix_now()));
    let out = with_user_db(&s, &user, move |c| {
        let (txs, cats, buds, settings) = (store::list_transactions(c)?, store::list_categories(c)?, store::list_budgets(c)?, store::get_settings(c)?);
        let (accs, rec) = (store::list_accounts(c)?, store::list_recurring(c)?);
        Ok(analysis::analysis(&AnalysisInput {
            transactions: &txs,
            accounts: &accs,
            recurring: &rec,
            categories: &cats,
            budgets: &buds,
            settings: &settings,
            today: &today,
        }))
    })
    .await?;
    Ok(Json(out))
}
