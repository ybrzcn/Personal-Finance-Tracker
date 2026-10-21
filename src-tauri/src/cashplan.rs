//! Ödeme takvimi ve yaklaşan ödemeler (yerel mod). Hesap finans-core::cashplan'da; veri kilit altında okunur, hesap kilit dışında.

use finans_core::cashplan::{self, CashPlanInput, CashPlanReport, UpcomingInput, UpcomingObligations};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::{sqlite, store};
use tauri::Manager;

use crate::commands::AppState;

const NO_DB: &str = "Veritabanı bağlantısı kullanılamıyor.";

#[tauri::command]
pub async fn cash_plan(app: tauri::AppHandle, months: i64) -> Result<CashPlanReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let (accs, txs, rec) = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, |s| Ok((store::list_accounts(s)?, store::list_transactions(s)?, store::list_recurring(s)?)))?
        };
        let today = ymd(istanbul_today(unix_now()));
        cashplan::cash_plan(&CashPlanInput { accounts: &accs, transactions: &txs, recurring: &rec, today: &today, months })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn upcoming_obligations(app: tauri::AppHandle, days: i64) -> Result<UpcomingObligations, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let (accs, txs) = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, |s| Ok((store::list_accounts(s)?, store::list_transactions(s)?)))?
        };
        let today = ymd(istanbul_today(unix_now()));
        cashplan::upcoming(&UpcomingInput { accounts: &accs, transactions: &txs, today: &today, days })
    })
    .await
    .map_err(|e| e.to_string())?
}
