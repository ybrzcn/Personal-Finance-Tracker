//! Genel Bakış istatistikleri ve kategori kullanımı (yerel mod). Hesap finans-core::overview'da; veri kilit altında okunur, hesap kilit dışında.

use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::overview::{self, CategoryUsageReport, OverviewInput, OverviewReport, Period};
use finans_core::{sqlite, store};
use tauri::Manager;

use crate::commands::AppState;

const NO_DB: &str = "Veritabanı bağlantısı kullanılamıyor.";

#[tauri::command]
pub async fn overview(app: tauri::AppHandle, period: String) -> Result<OverviewReport, String> {
    let period = Period::parse(&period).ok_or_else(|| "Geçersiz dönem".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let (accs, cats, txs, rec) = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, |s| Ok((store::list_accounts(s)?, store::list_categories(s)?, store::list_transactions(s)?, store::list_recurring(s)?)))?
        };
        let today = ymd(istanbul_today(unix_now()));
        Ok(overview::overview(&OverviewInput { accounts: &accs, categories: &cats, transactions: &txs, recurring: &rec, today: &today, period }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn category_usage(app: tauri::AppHandle) -> Result<CategoryUsageReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let txs = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, store::list_transactions)?
        };
        Ok(overview::category_usage(&txs))
    })
    .await
    .map_err(|e| e.to_string())?
}
