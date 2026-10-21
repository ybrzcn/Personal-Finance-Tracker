//! Hesap özetleri (oturum gerekir). Hesap finans-core::accounts'ta; burada yalnız veri ve kurlar toplanır.

use std::sync::Arc;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use finans_core::accounts::{self, AccountsInput, AccountsReport};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::{pnl, store};

use crate::app::{blocking, with_user_db, ApiError, AppState, AuthUser};

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/accounts/report", get(report))
}

async fn report(State(s): State<Arc<AppState>>, user: AuthUser) -> Result<Json<AccountsReport>, ApiError> {
    // Veri tek işlemde okunur; kurlar (ağ) veritabanı işlemi dışında toplanır
    let (accs, txs, cats) = with_user_db(&s, &user, |c| Ok((store::list_accounts(c)?, store::list_transactions(c)?, store::list_categories(c)?))).await?;
    let out = blocking(move || {
        let today = ymd(istanbul_today(unix_now()));
        let mut views = s.rates.latest(false)?;
        views.extend(s.rates.funds_latest(&pnl::fund_codes(&accs), false)?);
        let rates = pnl::current_rates(&views);
        accounts::report(&AccountsInput { accounts: &accs, transactions: &txs, categories: &cats, rates: &rates, today: &today }).map_err(ApiError::from)
    })
    .await?;
    Ok(Json(out))
}
