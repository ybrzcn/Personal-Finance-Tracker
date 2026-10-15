//! Kur uç noktaları (oturum gerekir).

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use finans_core::fx::funds::FundHit;
use finans_core::fx::sources::RateView;
use finans_core::{pnl, store};
use serde::Deserialize;

use crate::app::{blocking, with_user_db, ApiError, AppState, AuthUser};

type S = State<Arc<AppState>>;
type R<T> = Result<T, ApiError>;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/rates/latest", get(latest))
        .route("/api/rates/at", get(at))
        .route("/api/rates/history", get(history))
        .route("/api/funds/search", get(search))
}

#[derive(Deserialize)]
struct LatestQuery {
    refresh: Option<String>,
}

async fn latest(State(s): S, user: AuthUser, Query(q): Query<LatestQuery>) -> R<Json<Vec<RateView>>> {
    let refresh = q.refresh.as_deref() == Some("1");
    // Kullanıcının fon hesapları veritabanı işleminde okunur; kurlar (ağ) işlem dışında
    let codes = with_user_db(&s, &user, |c| Ok(pnl::fund_codes(&store::list_accounts(c)?))).await?;
    Ok(Json(
        blocking(move || {
            let mut v = s.rates.latest(refresh)?;
            v.extend(s.rates.funds_latest(&codes, refresh)?);
            Ok(v)
        })
        .await?,
    ))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn search(State(s): S, _user: AuthUser, Query(q): Query<SearchQuery>) -> R<Json<Vec<FundHit>>> {
    Ok(Json(blocking(move || s.rates.funds_search(&q.q)).await?))
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
