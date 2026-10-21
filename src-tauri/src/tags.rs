//! Etiketler (yerel mod). Kurallar finans-core::store'da, rapor finans-core::tags'ta.

use finans_core::db::{Tag, TagInput, Transaction};
use finans_core::tags::{self, TagsReport};
use finans_core::{sqlite, store};
use tauri::State;

use crate::commands::{lock, AppState, CmdResult};

#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> CmdResult<Vec<Tag>> {
    sqlite::run(&mut *lock(&state)?, |s| store::list_tags(s))
}

#[tauri::command]
pub fn create_tag(state: State<'_, AppState>, input: TagInput) -> CmdResult<Tag> {
    sqlite::run(&mut *lock(&state)?, |s| store::create_tag(s, input))
}

#[tauri::command]
pub fn update_tag(state: State<'_, AppState>, tag: Tag) -> CmdResult<Tag> {
    sqlite::run(&mut *lock(&state)?, |s| store::update_tag(s, tag))
}

#[tauri::command]
pub fn delete_tag(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    sqlite::run(&mut *lock(&state)?, |s| store::delete_tag(s, &id))
}

#[tauri::command]
pub fn tags_report(state: State<'_, AppState>) -> CmdResult<TagsReport> {
    sqlite::run(&mut *lock(&state)?, |s| {
        let list = store::list_tags(s)?;
        let txs = store::list_transactions(s)?;
        Ok(tags::report(&list, &txs))
    })
}

#[tauri::command]
pub fn set_transaction_tags(state: State<'_, AppState>, transaction_ids: Vec<String>, add: Vec<String>, remove: Vec<String>) -> CmdResult<Vec<Transaction>> {
    sqlite::run(&mut *lock(&state)?, |s| store::set_transaction_tags(s, &transaction_ids, &add, &remove))
}
