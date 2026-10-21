//! CSV dışa/içe aktarma ve JSON yedek (yerel mod). Hesap finans-core::import ve ::backup'ta; veri kilit altında okunur, hesap kilit dışında.

use std::collections::HashMap;

use finans_core::backup::{backup_json, create_backup, now_iso, parse_backup as parse, read_backup_data};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::import::{merge_csv_rows, parse_transactions_csv, transactions_to_csv, CsvMerge, CsvParse, CsvRow};
use finans_core::{sqlite, store};
use serde_json::Value;
use tauri::Manager;

use crate::commands::AppState;

const NO_DB: &str = "Veritabanı bağlantısı kullanılamıyor.";

/// `transaction_ids` null: bütün işlemler (veritabanı sırası); dizi: bu işlemler bu sırayla
#[tauri::command]
pub async fn export_csv(app: tauri::AppHandle, transaction_ids: Option<Vec<String>>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let (txs, cats, accounts) = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, |s| Ok((store::list_transactions(s)?, store::list_categories(s)?, store::list_accounts(s)?)))?
        };
        let txs = match transaction_ids {
            None => txs,
            Some(ids) => {
                let by_id: HashMap<&str, &finans_core::db::Transaction> = txs.iter().map(|t| (t.id.as_str(), t)).collect();
                ids.iter().filter_map(|id| by_id.get(id.as_str()).map(|t| (*t).clone())).collect()
            }
        };
        Ok(transactions_to_csv(&txs, &cats, &accounts))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn export_backup(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let (data, settings) = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, |s| Ok((read_backup_data(s)?, store::get_settings(s)?)))?
        };
        Ok(backup_json(&create_backup(&data, &settings, &now_iso())))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn parse_backup(text: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || parse(&text, &ymd(istanbul_today(unix_now()))))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn parse_csv(text: String) -> Result<CsvParse, String> {
    tauri::async_runtime::spawn_blocking(move || parse_transactions_csv(&text)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn merge_csv(app: tauri::AppHandle, rows: Vec<CsvRow>, default_account_id: String) -> Result<CsvMerge, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let (cats, accounts) = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, |s| Ok((store::list_categories(s)?, store::list_accounts(s)?)))?
        };
        if !accounts.iter().any(|a| a.id == default_account_id) {
            return Err("Bulunamadı.".to_string());
        }
        Ok(merge_csv_rows(&rows, &cats, &accounts, &default_account_id, &now_iso()))
    })
    .await
    .map_err(|e| e.to_string())?
}
