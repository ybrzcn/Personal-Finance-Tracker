//! Ödeme takvimi ve yaklaşan ödemeler (oturum gerekir). Hesap finans-core::cashplan'da; kur ya da ağ gerekmez.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use finans_core::cashplan::{self, CashPlanInput, CashPlanReport, UpcomingInput, UpcomingObligations};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::store;
use serde::Deserialize;

use crate::app::{with_user_db, ApiError, AppState, AuthUser};

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/cashplan", get(plan)).route("/api/obligations/upcoming", get(upcoming))
}

#[derive(Deserialize)]
struct PlanQuery {
    months: Option<String>,
}

#[derive(Deserialize)]
struct UpcomingQuery {
    days: Option<String>,
}

/// Eksik ya da sayı olmayan süre 0 olur; finans-core "Geçersiz süre" der
fn num(v: Option<String>) -> i64 {
    v.as_deref().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

async fn plan(State(s): State<Arc<AppState>>, user: AuthUser, Query(q): Query<PlanQuery>) -> Result<Json<CashPlanReport>, ApiError> {
    let months = num(q.months);
    // Geçersiz süre veriyi okumadan reddedilir
    if !(1..=24).contains(&months) {
        return Err(ApiError::from("Geçersiz süre".to_string()));
    }
    let today = ymd(istanbul_today(unix_now()));
    let out = with_user_db(&s, &user, move |c| {
        let (accs, txs, rec) = (store::list_accounts(c)?, store::list_transactions(c)?, store::list_recurring(c)?);
        cashplan::cash_plan(&CashPlanInput { accounts: &accs, transactions: &txs, recurring: &rec, today: &today, months })
    })
    .await?;
    Ok(Json(out))
}

async fn upcoming(State(s): State<Arc<AppState>>, user: AuthUser, Query(q): Query<UpcomingQuery>) -> Result<Json<UpcomingObligations>, ApiError> {
    let days = num(q.days);
    if !(1..=365).contains(&days) {
        return Err(ApiError::from("Geçersiz süre".to_string()));
    }
    let today = ymd(istanbul_today(unix_now()));
    let out = with_user_db(&s, &user, move |c| {
        let (accs, txs) = (store::list_accounts(c)?, store::list_transactions(c)?);
        cashplan::upcoming(&UpcomingInput { accounts: &accs, transactions: &txs, today: &today, days })
    })
    .await?;
    Ok(Json(out))
}
