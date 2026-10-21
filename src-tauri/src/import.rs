//! Ekstre satırları ve kategori önerileri (yerel mod). Hesap finans-core::import ve ::rules'ta; veri kilit altında okunur, hesap kilit dışında.

use finans_core::import::{rows_for, ImportRows, RowsRequest};
use finans_core::rules::{category_suggestions as suggest_all, read_rules, CategorySuggestions};
use finans_core::{sqlite, store};
use tauri::Manager;

use crate::commands::AppState;

const NO_DB: &str = "Veritabanı bağlantısı kullanılamıyor.";

#[tauri::command]
pub async fn statement_rows(app: tauri::AppHandle, request: RowsRequest) -> Result<ImportRows, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let (accounts, txs, cats, settings) = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, |s| Ok((store::list_accounts(s)?, store::list_transactions(s)?, store::list_categories(s)?, store::get_settings(s)?)))?
        };
        rows_for(request, &accounts, &txs, &cats, &read_rules(&settings))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn category_suggestions(app: tauri::AppHandle) -> Result<CategorySuggestions, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let (txs, cats, settings) = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, |s| Ok((store::list_transactions(s)?, store::list_categories(s)?, store::get_settings(s)?)))?
        };
        Ok(suggest_all(&txs, &cats, &read_rules(&settings)))
    })
    .await
    .map_err(|e| e.to_string())?
}
