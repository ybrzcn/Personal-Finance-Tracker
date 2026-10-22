//! Kâr/zarar raporu (yerel mod). Hesap finans-core::pnl'de; burada veri, kur ve TÜFE toplanır.

use finans_core::cpi::live::LiveCpi;
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::pnl::{self, PnlInput, PnlReport};
use finans_core::{sqlite, store};
use tauri::Manager;

use crate::commands::{read_config, AppState};
use crate::rates::RatesState;

pub struct CpiState(pub LiveCpi);

#[tauri::command]
pub async fn pnl_report(app: tauri::AppHandle, from: Option<String>, to: Option<String>, kind: Option<String>) -> Result<PnlReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        // Veri kilit altında okunur; kur ve TÜFE (ağ) kilit dışında
        let (accounts, txs, income_categories) = {
            let mut conn = st.conn.lock().map_err(|_| "Veritabanı bağlantısı kullanılamıyor.".to_string())?;
            sqlite::run(&mut conn, |s| {
                let ids = pnl::income_category_ids(&store::get_settings(s)?, &store::list_categories(s)?);
                Ok((store::list_accounts(s)?, store::list_transactions(s)?, ids))
            })?
        };
        let filter = pnl::AssetFilter::parse(kind.as_deref())?;
        let live = &app.state::<RatesState>().0;
        let mut views = live.latest();
        views.extend(live.funds_latest(&pnl::fund_codes(&accounts), false));
        let rates = pnl::current_rates(&views);
        let opening = pnl::opening_rates(&accounts, |code, d| live.at(code, d));
        let key = read_config(&st.config_path).evds_api_key;
        let cpi = app.state::<CpiState>().0.get(key.as_deref());
        let today = ymd(istanbul_today(unix_now()));
        pnl::report(&PnlInput {
            accounts: &accounts,
            transactions: &txs,
            rates: &rates,
            opening_rates: &opening,
            cpi: &cpi,
            today: &today,
            from: from.as_deref().filter(|s| !s.is_empty()),
            to: to.as_deref().filter(|s| !s.is_empty()),
            filter,
            income_categories: Some(income_categories),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
