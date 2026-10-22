//! Uzun vadeli tahmin (oturum gerekir). Hesap finans-core::projection'da; başlangıç net serveti net servet raporundan.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::networth::{self, NetWorthInput};
use finans_core::projection::{self, Assumptions, ProjectionInput, ProjectionReport};
use finans_core::{pnl, store};

use crate::app::{blocking, with_user_db, ApiError, AppState, AuthUser};

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/projection", get(report))
}

/// Varsayımlar sorgudan (eksik alan varsayılan)
async fn report(State(s): State<Arc<AppState>>, user: AuthUser, Query(a): Query<Assumptions>) -> Result<Json<ProjectionReport>, ApiError> {
    // Veri tek işlemde okunur; kurlar (ağ) veritabanı işlemi dışında toplanır
    let (accounts, txs, rec, buds) = with_user_db(&s, &user, |c| {
        Ok((store::list_accounts(c)?, store::list_transactions(c)?, store::list_recurring(c)?, store::list_budgets(c)?))
    })
    .await?;
    let out = blocking(move || {
        let today = ymd(istanbul_today(unix_now()));
        let mut views = s.rates.latest(false)?;
        views.extend(s.rates.funds_latest(&pnl::fund_codes(&accounts), false)?);
        let rates = pnl::current_rates(&views);
        let opening = pnl::opening_rates(&accounts, |code, d| s.rates.at(code, d).map_err(|e| e.message));
        let nw = networth::report(&NetWorthInput { accounts: &accounts, transactions: &txs, rates: &rates, opening_rates: &opening, today: &today })
            .map_err(ApiError::from)?;
        let net_worth_cents = nw.points.last().map_or(0, |p| p.net_cents);
        Ok::<_, ApiError>(projection::report(&ProjectionInput {
            accounts: &accounts,
            transactions: &txs,
            recurring: &rec,
            budgets: &buds,
            net_worth_cents,
            assumptions: &a,
            today: &today,
        }))
    })
    .await?;
    Ok(Json(out))
}
