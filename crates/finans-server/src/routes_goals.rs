//! Birikim hedefleri (oturum gerekir). Doğrulama finans-core::store'da, hesap finans-core::goals'ta.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use finans_core::db::{Goal, GoalInput};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::goals::{self, GoalsInput, GoalsReport};
use finans_core::{pnl, store};

use crate::app::{blocking, with_user_db, ApiError, AppState, AuthUser};

type S = State<Arc<AppState>>;
type R<T> = Result<T, ApiError>;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/goals", get(list).post(create))
        .route("/api/goals/report", get(report))
        .route("/api/goals/{id}", put(update).delete(remove))
}

fn today() -> String {
    ymd(istanbul_today(unix_now()))
}

async fn list(State(s): S, user: AuthUser) -> R<Json<Vec<Goal>>> {
    Ok(Json(with_user_db(&s, &user, |c| store::list_goals(c)).await?))
}

async fn create(State(s): S, user: AuthUser, Json(input): Json<GoalInput>) -> R<(StatusCode, Json<Goal>)> {
    let t = today();
    Ok((StatusCode::CREATED, Json(with_user_db(&s, &user, move |c| store::create_goal(c, input, &t)).await?)))
}

async fn update(State(s): S, user: AuthUser, Path(id): Path<String>, Json(goal): Json<Goal>) -> R<Json<Goal>> {
    if goal.id != id {
        return Err("Kayıt kimliği uyuşmuyor.".to_string().into());
    }
    let t = today();
    Ok(Json(with_user_db(&s, &user, move |c| store::update_goal(c, goal, &t)).await?))
}

async fn remove(State(s): S, user: AuthUser, Path(id): Path<String>) -> R<StatusCode> {
    with_user_db(&s, &user, move |c| store::delete_goal(c, &id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn report(State(s): S, user: AuthUser) -> R<Json<GoalsReport>> {
    // Veri tek işlemde okunur; kurlar (ağ) veritabanı işlemi dışında toplanır
    let (list, accounts, txs) = with_user_db(&s, &user, |c| {
        Ok((store::list_goals(c)?, store::list_accounts(c)?, store::list_transactions(c)?))
    })
    .await?;
    let out = blocking(move || {
        let mut views = s.rates.latest(false)?;
        views.extend(s.rates.funds_latest(&pnl::fund_codes(&accounts), false)?);
        let rates = pnl::current_rates(&views);
        let t = today();
        goals::report(&GoalsInput { goals: &list, accounts: &accounts, transactions: &txs, rates: &rates, today: &t })
            .map_err(ApiError::from)
    })
    .await?;
    Ok(Json(out))
}
