//! Kur uç noktaları (oturum gerekir).

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use finans_core::fx::sources::RateView;
use serde::Deserialize;

use crate::app::{blocking, ApiError, AppState, AuthUser};

type S = State<Arc<AppState>>;
type R<T> = Result<T, ApiError>;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/rates/latest", get(latest))
        .route("/api/rates/at", get(at))
        .route("/api/rates/history", get(history))
}

#[derive(Deserialize)]
struct LatestQuery {
    refresh: Option<String>,
}

async fn latest(State(s): S, _user: AuthUser, Query(q): Query<LatestQuery>) -> R<Json<Vec<RateView>>> {
    let refresh = q.refresh.as_deref() == Some("1");
    Ok(Json(blocking(move || s.rates.latest(refresh)).await?))
}

#[derive(Deserialize)]
struct AtQuery {
    code: String,
    date: String,
}

/// Bulunamazsa `null` (200): istemci "elle girin" der.
async fn at(State(s): S, _user: AuthUser, Query(q): Query<AtQuery>) -> R<Json<Option<RateView>>> {
    Ok(Json(blocking(move || s.rates.at(&q.code, &q.date)).await?))
}

#[derive(Deserialize)]
struct HistoryQuery {
    code: String,
    from: String,
    to: String,
}

async fn history(State(s): S, _user: AuthUser, Query(q): Query<HistoryQuery>) -> R<Json<Vec<RateView>>> {
    Ok(Json(blocking(move || s.rates.history(&q.code, &q.from, &q.to)).await?))
}
