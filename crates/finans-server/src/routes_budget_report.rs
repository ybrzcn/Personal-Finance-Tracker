//! Bütçe raporu ve gelir durumu (oturum gerekir). Hesap finans-core::budget'ta; kur ya da ağ gerekmez.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use finans_core::budget::{self, BudgetInput, BudgetReport, IncomeStatus, IncomeStatusInput};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::store;
use serde::Deserialize;

use crate::app::{with_user_db, ApiError, AppState, AuthUser};

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/budget/report", get(report)).route("/api/income/status", get(status))
}

#[derive(Deserialize)]
struct MonthQuery {
    /// Eksikse boş: finans-core "Geçersiz ay" der
    month: Option<String>,
}

async fn report(State(s): State<Arc<AppState>>, user: AuthUser, Query(q): Query<MonthQuery>) -> Result<Json<BudgetReport>, ApiError> {
    let month = q.month.unwrap_or_default();
    let out = with_user_db(&s, &user, move |c| {
        let (accs, txs, rec, buds, cats) =
            (store::list_accounts(c)?, store::list_transactions(c)?, store::list_recurring(c)?, store::list_budgets(c)?, store::list_categories(c)?);
        budget::report(&BudgetInput { accounts: &accs, transactions: &txs, recurring: &rec, budgets: &buds, categories: &cats, month: &month })
    })
    .await?;
    Ok(Json(out))
}

async fn status(State(s): State<Arc<AppState>>, user: AuthUser) -> Result<Json<IncomeStatus>, ApiError> {
    let today = ymd(istanbul_today(unix_now()));
    let out = with_user_db(&s, &user, move |c| {
        let (txs, rec) = (store::list_transactions(c)?, store::list_recurring(c)?);
        Ok(budget::income_status(&IncomeStatusInput { transactions: &txs, recurring: &rec, today: &today }))
    })
    .await?;
    Ok(Json(out))
}
