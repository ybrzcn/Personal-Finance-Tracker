//! Net servet geçmişi (oturum gerekir). Hesap finans-core::networth'te; burada yalnız veri ve kurlar toplanır.

use std::sync::Arc;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::networth::{self, NetWorthInput, NetWorthReport};
use finans_core::{pnl, store};

use crate::app::{blocking, with_user_db, ApiError, AppState, AuthUser};

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/networth", get(report))
}

async fn report(State(s): State<Arc<AppState>>, user: AuthUser) -> Result<Json<NetWorthReport>, ApiError> {
    // Veri tek işlemde okunur; kurlar (ağ) veritabanı işlemi dışında toplanır
    let (accounts, txs) =
        with_user_db(&s, &user, |c| Ok((store::list_accounts(c)?, store::list_transactions(c)?))).await?;
    let out = blocking(move || {
        let today = ymd(istanbul_today(unix_now()));
        let mut views = s.rates.latest(false)?;
        views.extend(s.rates.funds_latest(&pnl::fund_codes(&accounts), false)?);
        let rates = pnl::current_rates(&views);
        let opening = pnl::opening_rates(&accounts, |code, d| s.rates.at(code, d).map_err(|e| e.message));
        networth::report(&NetWorthInput { accounts: &accounts, transactions: &txs, rates: &rates, opening_rates: &opening, today: &today })
            .map_err(ApiError::from)
    })
    .await?;
    Ok(Json(out))
}
