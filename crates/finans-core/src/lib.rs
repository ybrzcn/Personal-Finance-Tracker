//! Finans veri katmanı. Tauri'ye bağlı değildir; masaüstü uygulaması ve sunucu ortak kullanır.

pub mod accounts;
pub mod analysis;
pub mod backup;
pub mod budget;
pub mod cashplan;
pub mod cpi;
pub mod data_store;
pub mod db;
pub mod debt;
pub mod forms;
pub mod fx;
pub mod goals;
pub mod import;
pub mod networth;
pub mod order;
pub mod overview;
pub mod pnl;
pub mod projection;
pub mod rows;
pub mod rules;
pub mod sqlite;
pub mod statement;
pub mod store;
pub mod tags;

/// Kullanıcıya gösterilecek Türkçe hata mesajı taşıyan sonuç.
pub type CoreResult<T> = Result<T, String>;
