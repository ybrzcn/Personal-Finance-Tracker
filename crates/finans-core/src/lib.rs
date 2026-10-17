//! Finans veri katmanı. Tauri'ye bağlı değildir; masaüstü uygulaması ve sunucu ortak kullanır.

pub mod cpi;
pub mod data_store;
pub mod db;
pub mod fx;
pub mod goals;
pub mod networth;
pub mod pnl;
pub mod rows;
pub mod sqlite;
pub mod statement;
pub mod store;

/// Kullanıcıya gösterilecek Türkçe hata mesajı taşıyan sonuç.
pub type CoreResult<T> = Result<T, String>;
