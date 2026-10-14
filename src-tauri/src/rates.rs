//! Kurlar: masaüstü ve mobil yerel modda kaynaklardan doğrudan çekilir, saklanmaz (bellekte 60 sn).

use finans_core::fx::live::LiveRates;
use finans_core::fx::sources::RateView;
use tauri::Manager;

pub struct RatesState(pub LiveRates);

#[tauri::command]
pub async fn rates_latest(app: tauri::AppHandle) -> Result<Vec<RateView>, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<RatesState>().0.latest())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rate_at(app: tauri::AppHandle, code: String, date: String) -> Result<Option<RateView>, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<RatesState>().0.at(&code, &date))
        .await
        .map_err(|e| e.to_string())?
}
