//! Kurlar: masaüstü ve mobil yerel modda kaynaklardan doğrudan çekilir, saklanmaz (bellekte 60 sn).

use finans_core::fx::funds::FundHit;
use finans_core::fx::live::LiveRates;
use finans_core::fx::sources::RateView;
use finans_core::{pnl, sqlite, store};
use tauri::Manager;

use crate::commands::AppState;

pub struct RatesState(pub LiveRates);

/// Döviz/altın ve kullanıcının fon hesaplarındaki fonlar
#[tauri::command]
pub async fn rates_latest(app: tauri::AppHandle, refresh: Option<bool>) -> Result<Vec<RateView>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let codes = {
            let mut conn = st.conn.lock().map_err(|_| "Veritabanı bağlantısı kullanılamıyor.".to_string())?;
            sqlite::run(&mut conn, |s| Ok(pnl::fund_codes(&store::list_accounts(s)?)))?
        };
        let live = &app.state::<RatesState>().0;
        let mut v = live.latest();
        v.extend(live.funds_latest(&codes, refresh.unwrap_or(false)));
        Ok(v)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn funds_search(app: tauri::AppHandle, q: String) -> Result<Vec<FundHit>, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<RatesState>().0.funds_search(&q)).await.map_err(|e| e.to_string())?
}

/// Fon fiyat geçmişi (döviz/altın geçmişi yalnız Postgres'li sunucuda)
#[tauri::command]
pub async fn rate_history(app: tauri::AppHandle, code: String, from: String, to: String) -> Result<Vec<RateView>, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<RatesState>().0.history(&code, &from, &to))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rate_at(app: tauri::AppHandle, code: String, date: String) -> Result<Option<RateView>, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<RatesState>().0.at(&code, &date))
        .await
        .map_err(|e| e.to_string())?
}
