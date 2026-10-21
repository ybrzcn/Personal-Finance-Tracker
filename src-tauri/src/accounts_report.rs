//! Hesap özetleri (yerel mod). Hesap finans-core::accounts'ta; burada veri ve kurlar toplanır.

use finans_core::accounts::{self, AccountsInput, AccountsReport};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::{pnl, sqlite, store};
use tauri::Manager;

use crate::commands::AppState;
use crate::rates::RatesState;

#[tauri::command]
pub async fn accounts_report(app: tauri::AppHandle) -> Result<AccountsReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        // Veri kilit altında okunur; kurlar (ağ) kilit dışında
        let (accs, txs, cats) = {
            let mut conn = st.conn.lock().map_err(|_| "Veritabanı bağlantısı kullanılamıyor.".to_string())?;
            sqlite::run(&mut conn, |s| Ok((store::list_accounts(s)?, store::list_transactions(s)?, store::list_categories(s)?)))?
        };
        let live = &app.state::<RatesState>().0;
        let mut views = live.latest();
        views.extend(live.funds_latest(&pnl::fund_codes(&accs), false));
        let rates = pnl::current_rates(&views);
        let today = ymd(istanbul_today(unix_now()));
        accounts::report(&AccountsInput { accounts: &accs, transactions: &txs, categories: &cats, rates: &rates, today: &today })
    })
    .await
    .map_err(|e| e.to_string())?
}
