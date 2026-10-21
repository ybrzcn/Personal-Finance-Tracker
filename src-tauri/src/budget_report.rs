//! Bütçe raporu ve gelir durumu (yerel mod). Hesap finans-core::budget'ta; veri kilit altında okunur, hesap kilit dışında.

use finans_core::budget::{self, BudgetInput, BudgetReport, IncomeStatus, IncomeStatusInput};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::{sqlite, store};
use tauri::Manager;

use crate::commands::AppState;

const NO_DB: &str = "Veritabanı bağlantısı kullanılamıyor.";

#[tauri::command]
pub async fn budget_report(app: tauri::AppHandle, month: String) -> Result<BudgetReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let (accs, txs, rec, buds, cats) = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, |s| {
                Ok((store::list_accounts(s)?, store::list_transactions(s)?, store::list_recurring(s)?, store::list_budgets(s)?, store::list_categories(s)?))
            })?
        };
        budget::report(&BudgetInput { accounts: &accs, transactions: &txs, recurring: &rec, budgets: &buds, categories: &cats, month: &month })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn income_status(app: tauri::AppHandle) -> Result<IncomeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let (txs, rec) = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, |s| Ok((store::list_transactions(s)?, store::list_recurring(s)?)))?
        };
        let today = ymd(istanbul_today(unix_now()));
        Ok(budget::income_status(&IncomeStatusInput { transactions: &txs, recurring: &rec, today: &today }))
    })
    .await
    .map_err(|e| e.to_string())?
}
