//! JSON yedek: oluşturma ve geri yüklemeden önce doğrulama (TS `backup.ts`)

pub mod create;
pub mod parse;

pub use self::create::{backup_json, create_backup, BackupData};
pub use self::parse::{make_default_account, parse_backup};

use crate::data_store::DataStore;
use crate::fx::time::{iso_utc, unix_now};
use crate::{store, CoreResult};

/// Yedeğe giren bütün veri (veritabanı sırasıyla)
pub fn read_backup_data(s: &mut dyn DataStore) -> CoreResult<BackupData> {
    Ok(BackupData {
        categories: store::list_categories(s)?,
        accounts: store::list_accounts(s)?,
        transactions: store::list_transactions(s)?,
        recurring: store::list_recurring(s)?,
        budgets: store::list_budgets(s)?,
        goals: store::list_goals(s)?,
        tags: store::list_tags(s)?,
    })
}

/// Şimdi, JS `new Date().toISOString()` biçiminde ("YYYY-MM-DDTHH:MM:SS.000Z")
pub fn now_iso() -> String {
    iso_utc(unix_now()).replace('Z', ".000Z")
}
