//! Finans veri katmanı. Tauri'ye bağlı değildir; masaüstü uygulaması ve sunucu ortak kullanır.

pub mod db;
pub mod statement;
pub mod store;

/// Kullanıcıya gösterilecek Türkçe hata mesajı taşıyan sonuç.
pub type CoreResult<T> = Result<T, String>;
