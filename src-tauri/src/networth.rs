//! Net servet geçmişi (yerel mod). Hesap finans-core::networth'te; burada veri ve kurlar toplanır.

use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::networth::{self, NetWorthInput, NetWorthReport};
use finans_core::{pnl, sqlite, store};
use tauri::Manager;

use crate::commands::AppState;
use crate::rates::RatesState;

#[tauri::command]
pub async fn networth_report(app: tauri::AppHandle) -> Result<NetWorthReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        // Veri kilit altında okunur; kurlar (ağ) kilit dışında
        let (accounts, txs) = {
            let mut conn = st.conn.lock().map_err(|_| "Veritabanı bağlantısı kullanılamıyor.".to_string())?;
            sqlite::run(&mut conn, |s| Ok((store::list_accounts(s)?, store::list_transactions(s)?)))?
        };
        let live = &app.state::<RatesState>().0;
        let mut views = live.latest();
        views.extend(live.funds_latest(&pnl::fund_codes(&accounts), false));
        let rates = pnl::current_rates(&views);
        let opening = pnl::opening_rates(&accounts, |code, d| live.at(code, d));
        let today = ymd(istanbul_today(unix_now()));
        networth::report(&NetWorthInput { accounts: &accounts, transactions: &txs, rates: &rates, opening_rates: &opening, today: &today })
    })
    .await
    .map_err(|e| e.to_string())?
}
