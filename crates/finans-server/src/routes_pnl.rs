//! Kâr/zarar raporu (oturum gerekir). Hesap finans-core::pnl'de; burada yalnız veri, kur ve TÜFE toplanır.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use finans_core::fx::time::{istanbul_today, parse_ymd, unix_now, ymd};
use finans_core::pnl::{self, PnlInput, PnlReport};
use finans_core::store;
use serde::Deserialize;

use crate::app::{blocking, with_user_db, ApiError, AppState, AuthUser};

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/pnl", get(report))
}

#[derive(Deserialize)]
struct PnlQuery {
    from: Option<String>,
    to: Option<String>,
}

fn date(v: Option<String>) -> Result<Option<String>, ApiError> {
    match v.filter(|s| !s.is_empty()) {
        Some(d) if parse_ymd(&d).is_some() => Ok(Some(d)),
        Some(d) => Err(ApiError::from(format!("Geçersiz tarih: {d}"))),
        None => Ok(None),
    }
}

async fn report(State(s): State<Arc<AppState>>, user: AuthUser, Query(q): Query<PnlQuery>) -> Result<Json<PnlReport>, ApiError> {
    let (from, to) = (date(q.from)?, date(q.to)?);
    // Veri tek işlemde okunur; kur ve TÜFE (ağ) veritabanı işlemi dışında toplanır
    let (accounts, txs) =
        with_user_db(&s, &user, |c| Ok((store::list_accounts(c)?, store::list_transactions(c)?))).await?;
    let out = blocking(move || {
        let today = ymd(istanbul_today(unix_now()));
        let rates = pnl::current_rates(&s.rates.latest(false)?);
        let opening = pnl::opening_rates(&accounts, |code, d| s.rates.at(code, d).map_err(|e| e.message));
        let cpi = s.cpi.get();
        pnl::report(&PnlInput {
            accounts: &accounts,
            transactions: &txs,
            rates: &rates,
            opening_rates: &opening,
            cpi: &cpi,
            today: &today,
            from: from.as_deref(),
            to: to.as_deref(),
        })
        .map_err(ApiError::from)
    })
    .await?;
    Ok(Json(out))
}
