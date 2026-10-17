mod commands;
mod goals;
mod maintenance;
mod networth;
mod pnl;
mod rates;

use finans_core::db;

use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // macOS: standart uygulama menüsü (⌘Q Çık, ⌘W Kapat, ⌘H Gizle, Düzen menüsünde ⌘C/⌘V/⌘Z ...).
    // Windows'ta pencereye menü çubuğu eklenmemesi için yalnızca macOS'ta uygulanır.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(tauri::menu::Menu::default);

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // macOS:   ~/Library/Application Support/com.ybrzcn.finans/finans.db
            // Windows: %APPDATA%\com.ybrzcn.finans\finans.db
            // Linux:   ~/.local/share/com.ybrzcn.finans/finans.db
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let default_db_path = dir.join("finans.db");
            let config_path = dir.join("config.json");
            // Kullanıcı başka bir veritabanı seçtiyse onu aç; açılamazsa varsayılana dön
            let chosen = commands::read_config(&config_path)
                .database_path
                .map(std::path::PathBuf::from)
                .filter(|p| p.exists());
            let configured = commands::read_config(&config_path).database_path;
            let mut fallback_from = configured.clone().filter(|_| chosen.is_none());
            let (conn, db_path) = match chosen.as_ref().map(|p| (db::open(p), p.clone())) {
                Some((Ok(conn), path)) => (conn, path),
                Some((Err(e), path)) => {
                    eprintln!("Seçili veritabanı açılamadı ({}): {e}; varsayılan kullanılıyor", path.display());
                    fallback_from = Some(path.display().to_string());
                    (db::open(&default_db_path)?, default_db_path.clone())
                }
                None => (db::open(&default_db_path)?, default_db_path.clone()),
            };
            // Pencereyi ekrana göre boyutlandırıp ortala; boyut ayarlanana kadar gizli
            // ("maximized" ayarı macOS'ta saydam başlık çubuğuyla ekrandan taşabiliyor). Mobilde tam ekran.
            #[cfg(desktop)]
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = win.current_monitor() {
                    let screen = monitor.size().to_logical::<f64>(monitor.scale_factor());
                    // Büyük ekranlarda da derli toplu açılsın: en fazla 1280×820, küçük ekranlarda ekranın ~%85'i
                    let width = (screen.width * 0.85).clamp(720.0, 1280.0);
                    let height = (screen.height * 0.85).clamp(560.0, 820.0);
                    let _ = win.set_size(tauri::LogicalSize::new(width, height));
                }
                let _ = win.center();
                let _ = win.show();
            }
            app.manage(commands::AppState {
                conn: Mutex::new(conn),
                db_path: Mutex::new(db_path),
                default_db_path,
                config_path,
                fallback_from: Mutex::new(fallback_from),
            });
            app.manage(rates::RatesState(finans_core::fx::live::LiveRates::new()));
            app.manage(pnl::CpiState(Default::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_categories,
            commands::create_category,
            commands::update_category,
            commands::delete_category,
            commands::list_accounts,
            commands::create_account,
            commands::update_account,
            commands::delete_account,
            commands::list_recurring,
            commands::create_recurring,
            commands::update_recurring,
            commands::delete_recurring,
            commands::list_budgets,
            commands::set_budget,
            commands::list_transactions,
            commands::create_transaction,
            commands::update_transaction,
            commands::delete_transaction,
            commands::restore_data,
            commands::get_settings,
            commands::set_setting,
            commands::get_client_config,
            commands::set_client_config,
            commands::data_location,
            commands::backup_database,
            commands::database_info,
            commands::save_database_copy,
            commands::open_database,
            commands::use_default_database,
            maintenance::app_info,
            maintenance::uninstall_plan,
            maintenance::uninstall_app,
            commands::parse_statement_bytes,
            commands::save_export,
            rates::rates_latest,
            rates::rate_at,
            rates::funds_search,
            rates::rate_history,
            pnl::pnl_report,
            networth::networth_report,
            goals::list_goals,
            goals::create_goal,
            goals::update_goal,
            goals::delete_goal,
            goals::goals_report,
            commands::evds_key_set,
            commands::set_evds_key,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri uygulaması başlatılırken hata oluştu");
}
