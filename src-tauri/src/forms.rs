//! Form önizlemeleri (yerel mod). Hesap finans-core::forms'ta; veri kilit altında okunur, hesap kilit dışında.

use finans_core::forms::{self, needs_transactions, wants_suggestion, AccountDraft, AccountPreview, RecurringDraft, RecurringPreview, TransactionDraft, TransactionPreview};
use finans_core::fx::time::{istanbul_today, unix_now, ymd};
use finans_core::import::{card_for, statement_totals, CardDraft, StatementCard, StatementTotals, TotalsDraft};
use finans_core::rules::{read_rules, rule_preview, RuleDraft, RulePreview};
use finans_core::{sqlite, store};
use tauri::Manager;

use crate::commands::AppState;

const NO_DB: &str = "Veritabanı bağlantısı kullanılamıyor.";

fn today() -> String {
    ymd(istanbul_today(unix_now()))
}

#[tauri::command]
pub async fn preview_transaction(app: tauri::AppHandle, draft: TransactionDraft) -> Result<TransactionPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let (accounts, txs, cats, rules) = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, |s| {
                let accounts = store::list_accounts(s)?;
                // İşlemler yalnız nakit eksi denetimi ve kategori önerisi için; kategoriler ve kurallar yalnız öneri için gerekir
                let txs = if needs_transactions(&draft, &accounts) { store::list_transactions(s)? } else { Vec::new() };
                let (cats, rules) = if wants_suggestion(&draft) { (store::list_categories(s)?, read_rules(&store::get_settings(s)?)) } else { (Vec::new(), Vec::new()) };
                Ok((accounts, txs, cats, rules))
            })?
        };
        Ok(forms::transaction_preview(&draft, &accounts, &txs, &cats, &rules, &today()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn preview_account(app: tauri::AppHandle, draft: AccountDraft) -> Result<AccountPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let usage = match draft.account_id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => {
                let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
                sqlite::run(&mut conn, |s| s.account_usage(id))?
            }
            None => 0,
        };
        Ok(forms::account_preview(&draft, usage, &today()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn preview_recurring(draft: RecurringDraft) -> RecurringPreview {
    forms::recurring_preview(&draft, &today())
}

#[tauri::command]
pub async fn preview_statement_card(app: tauri::AppHandle, draft: CardDraft) -> Result<StatementCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let accounts = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, store::list_accounts)?
        };
        Ok(card_for(&draft, &accounts))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn preview_statement_totals(draft: TotalsDraft) -> StatementTotals {
    statement_totals(&draft.rows, draft.period_spending)
}

#[tauri::command]
pub async fn preview_category_rule(app: tauri::AppHandle, draft: RuleDraft) -> Result<RulePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        let txs = {
            let mut conn = st.conn.lock().map_err(|_| NO_DB.to_string())?;
            sqlite::run(&mut conn, store::list_transactions)?
        };
        Ok(rule_preview(&draft, &txs))
    })
    .await
    .map_err(|e| e.to_string())?
}
