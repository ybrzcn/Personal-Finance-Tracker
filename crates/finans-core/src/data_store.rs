//! Kullanıcı verisinin ilkel okuma/yazma işlemleri. Geçerlilik kararı vermez (o `store.rs`'in işi);
//! SQLite (`sqlite.rs`) ve Postgres (finans-server) uygular. Her çağrı dizisi tek bir veritabanı işleminde çalışır.

use crate::db::{Account, Budget, Category, Goal, RecurringItem, Tag, Transaction};
use crate::rows::{AccountMeta, AccountRow, GoalRow, RecurringRow, TagRow, TransactionRow};
use crate::CoreResult;

pub trait DataStore {
    fn list_categories(&mut self) -> CoreResult<Vec<Category>>;
    fn get_category(&mut self, id: &str) -> CoreResult<Option<Category>>;
    fn insert_category(&mut self, id: &str, name: &str, kind: &str, color: &str) -> CoreResult<()>;
    /// Değişen satır sayısı
    fn update_category(&mut self, id: &str, name: &str, kind: &str, color: &str) -> CoreResult<u64>;
    /// İşlemlerin kategori alanı boşaltılır, sonra kategori silinir (bütçesi silinir, düzenli kayıtlarda boşalır).
    fn delete_category(&mut self, id: &str) -> CoreResult<()>;
    /// (türü `kind` olmayan işlem sayısı, türü `kind` olmayan düzenli kayıt sayısı, bütçe satırı sayısı)
    fn category_conflicts(&mut self, id: &str, kind: &str) -> CoreResult<(i64, i64, i64)>;

    fn list_accounts(&mut self) -> CoreResult<Vec<Account>>;
    fn get_account(&mut self, id: &str) -> CoreResult<Option<Account>>;
    fn account_meta(&mut self, id: &str) -> CoreResult<Option<AccountMeta>>;
    /// Hesabın kaynak ya da hedef olduğu işlem sayısı
    fn account_usage(&mut self, id: &str) -> CoreResult<i64>;
    fn insert_account(&mut self, id: &str, row: &AccountRow) -> CoreResult<()>;
    fn update_account(&mut self, id: &str, row: &AccountRow) -> CoreResult<u64>;
    fn delete_account(&mut self, id: &str) -> CoreResult<()>;

    fn list_transactions(&mut self) -> CoreResult<Vec<Transaction>>;
    fn get_transaction(&mut self, id: &str) -> CoreResult<Option<Transaction>>;
    fn insert_transaction(&mut self, row: &TransactionRow) -> CoreResult<()>;
    fn update_transaction(&mut self, row: &TransactionRow) -> CoreResult<u64>;
    fn delete_transaction(&mut self, id: &str) -> CoreResult<()>;

    fn list_recurring(&mut self) -> CoreResult<Vec<RecurringItem>>;
    fn get_recurring(&mut self, id: &str) -> CoreResult<Option<RecurringItem>>;
    fn insert_recurring(&mut self, id: &str, row: &RecurringRow) -> CoreResult<()>;
    fn update_recurring(&mut self, id: &str, row: &RecurringRow) -> CoreResult<u64>;
    fn delete_recurring(&mut self, id: &str) -> CoreResult<()>;
    /// Bu düzenli kayda bağlı kart/kredi finansman bağlantılarını boşaltır
    fn clear_funding_income(&mut self, recurring_id: &str) -> CoreResult<()>;
    /// Var olmayan ya da gelir olmayan düzenli kayda işaret eden finansman bağlantılarını boşaltır
    fn clear_dangling_funding(&mut self) -> CoreResult<()>;

    fn list_budgets(&mut self) -> CoreResult<Vec<Budget>>;
    fn upsert_budget(&mut self, category_id: &str, amount_cents: i64) -> CoreResult<()>;
    fn delete_budget(&mut self, category_id: &str) -> CoreResult<()>;
    /// Devreden bütçenin başlangıç ayı (None kapatır); değişen satır sayısı (bütçe yoksa 0)
    fn set_budget_rollover(&mut self, category_id: &str, from: Option<&str>) -> CoreResult<u64>;

    /// Hedefler (oluşturma sırasıyla) ve hesap listeleri; `target` hedef biriminde
    fn list_goals(&mut self) -> CoreResult<Vec<Goal>>;
    fn get_goal(&mut self, id: &str) -> CoreResult<Option<Goal>>;
    /// Hedef ve hesap bağlantıları; `created_at` yoksa şimdi
    fn insert_goal(&mut self, id: &str, row: &GoalRow, created_at: Option<&str>) -> CoreResult<()>;
    /// Hedef ve hesap bağlantılarını değiştirir; değişen hedef satırı sayısı
    fn update_goal(&mut self, id: &str, row: &GoalRow) -> CoreResult<u64>;
    fn delete_goal(&mut self, id: &str) -> CoreResult<()>;
    /// Hesabın bağlı olduğu hedef: (id, ad)
    fn goal_of_account(&mut self, account_id: &str) -> CoreResult<Option<(String, String)>>;

    fn list_tags(&mut self) -> CoreResult<Vec<Tag>>;
    fn get_tag(&mut self, id: &str) -> CoreResult<Option<Tag>>;
    fn insert_tag(&mut self, id: &str, row: &TagRow, created_at: Option<&str>) -> CoreResult<()>;
    fn update_tag(&mut self, id: &str, row: &TagRow) -> CoreResult<u64>;
    fn delete_tag(&mut self, id: &str) -> CoreResult<()>;
    /// (işlem, etiket) bağlantılarının tümü
    fn list_tx_tags(&mut self) -> CoreResult<Vec<(String, String)>>;
    fn tags_of_tx(&mut self, transaction_id: &str) -> CoreResult<Vec<String>>;
    /// İşlemin etiket listesini değiştirir (tekrarsız liste verilir)
    fn set_tx_tags(&mut self, transaction_id: &str, tag_ids: &[String]) -> CoreResult<()>;
    /// Varsa bir şey yapmaz
    fn add_tx_tag(&mut self, transaction_id: &str, tag_id: &str) -> CoreResult<()>;
    fn remove_tx_tag(&mut self, transaction_id: &str, tag_id: &str) -> CoreResult<()>;

    /// (anahtar, JSON metni)
    fn list_settings(&mut self) -> CoreResult<Vec<(String, String)>>;
    fn upsert_setting(&mut self, key: &str, json: &str) -> CoreResult<()>;

    /// Geri yükleme öncesi: hedefler, etiketler, bütçeler, düzenli kayıtlar, işlemler, hesaplar ve kategoriler silinir (ayarlar kalır).
    fn clear_all(&mut self) -> CoreResult<()>;
}
