//! Borç planı (yerel mod). Hesap finans-core::debt'te; veri kilit altında okunur, hesap kilit dışında.

use finans_core::debt::{self, DebtPlanInput, DebtPlanReport};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::{sqlite, store};
use tauri::Manager;

use crate::commands::AppState;

const NO_DB: &str = "Veritabanı bağlantısı kullanılamıyor.";

#[tauri::command]
pub async fn debt_plan(app: tauri::AppHandle) -> Result<DebtPlanReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let (accs, txs, rec, settings) = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, |s| Ok((store::list_accounts(s)?, store::list_transactions(s)?, store::list_recurring(s)?, store::get_settings(s)?)))?
        };
        let today = ymd(istanbul_today(unix_now()));
        Ok(debt::plan(&DebtPlanInput { accounts: &accs, transactions: &txs, recurring: &rec, settings: &settings, today: &today }))
    })
    .await
    .map_err(|e| e.to_string())?
}
