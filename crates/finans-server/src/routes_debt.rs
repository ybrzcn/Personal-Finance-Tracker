//! Borç planı (oturum gerekir). Hesap finans-core::debt'te; borç ayarları kullanıcının ayarlarından okunur.

use std::sync::Arc;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use finans_core::debt::{self, DebtPlanInput, DebtPlanReport};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::store;

use crate::app::{with_user_db, ApiError, AppState, AuthUser};

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/debt/plan", get(plan))
}

async fn plan(State(s): State<Arc<AppState>>, user: AuthUser) -> Result<Json<DebtPlanReport>, ApiError> {
    let today = ymd(istanbul_today(unix_now()));
    let out = with_user_db(&s, &user, move |c| {
        let (accs, txs, rec, settings) = (store::list_accounts(c)?, store::list_transactions(c)?, store::list_recurring(c)?, store::get_settings(c)?);
        Ok(debt::plan(&DebtPlanInput { accounts: &accs, transactions: &txs, recurring: &rec, settings: &settings, today: &today }))
    })
    .await?;
    Ok(Json(out))
}
