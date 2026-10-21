//! Analiz: abonelikler ve değişken gider tahmini (yerel mod). Hesap finans-core::analysis'te; veri kilit altında okunur, hesap kilit dışında.

use finans_core::analysis::{self, AnalysisInput, AnalysisReport};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::{sqlite, store};
use tauri::Manager;

use crate::commands::AppState;

const NO_DB: &str = "Veritabanı bağlantısı kullanılamıyor.";

#[tauri::command]
pub async fn analysis(app: tauri::AppHandle) -> Result<AnalysisReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let (txs, cats, buds, settings) = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, |s| Ok((store::list_transactions(s)?, store::list_categories(s)?, store::list_budgets(s)?, store::get_settings(s)?)))?
        };
        let today = ymd(istanbul_today(unix_now()));
        Ok(analysis::analysis(&AnalysisInput { transactions: &txs, categories: &cats, budgets: &buds, settings: &settings, today: &today }))
    })
    .await
    .map_err(|e| e.to_string())?
}
