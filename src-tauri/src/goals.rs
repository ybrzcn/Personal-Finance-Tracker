//! Birikim hedefleri (yerel mod). Doğrulama finans-core::store'da, hesap finans-core::goals'ta.

use finans_core::db::{Goal, GoalInput};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::goals::{self, GoalsInput, GoalsReport};
use finans_core::{pnl, sqlite, store};
use tauri::{Manager, State};

use crate::commands::{lock, AppState, CmdResult};
use crate::rates::RatesState;

fn today() -> String {
    ymd(istanbul_today(unix_now()))
}

#[tauri::command]
pub fn list_goals(state: State<'_, AppState>) -> CmdResult<Vec<Goal>> {
    sqlite::run(&mut *lock(&state)?, |s| store::list_goals(s))
}

#[tauri::command]
pub fn create_goal(state: State<'_, AppState>, input: GoalInput) -> CmdResult<Goal> {
    let t = today();
    sqlite::run(&mut *lock(&state)?, |s| store::create_goal(s, input, &t))
}

#[tauri::command]
pub fn update_goal(state: State<'_, AppState>, goal: Goal) -> CmdResult<Goal> {
    let t = today();
    sqlite::run(&mut *lock(&state)?, |s| store::update_goal(s, goal, &t))
}

#[tauri::command]
pub fn delete_goal(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    sqlite::run(&mut *lock(&state)?, |s| store::delete_goal(s, &id))
}

#[tauri::command]
pub async fn goals_report(app: tauri::AppHandle) -> Result<GoalsReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        // Veri kilit altında okunur; kurlar (ağ) kilit dışında
        let (list, accounts, txs) = {
            let mut conn = st.conn.lock().map_err(|_| "Veritabanı bağlantısı kullanılamıyor.".to_string())?;
            sqlite::run(&mut conn, |s| Ok((store::list_goals(s)?, store::list_accounts(s)?, store::list_transactions(s)?)))?
        };
        let live = &app.state::<RatesState>().0;
        let mut views = live.latest();
        views.extend(live.funds_latest(&pnl::fund_codes(&accounts), false));
        let rates = pnl::current_rates(&views);
        let t = today();
        goals::report(&GoalsInput { goals: &list, accounts: &accounts, transactions: &txs, rates: &rates, today: &t })
    })
    .await
    .map_err(|e| e.to_string())?
}
