//! Hesaplar ve oturumlar için depolama arayüzü (SQLite: `auth_sqlite.rs`, Postgres: `pg/auth.rs`).
//! Şifre özeti, token ve e-posta kuralları burada değil, `auth.rs`'te.

/// Depolama hatası: veritabanına ulaşılamıyorsa `Unavailable` (503), diğerleri iç hata (500).
#[derive(Debug)]
pub enum StoreError {
    Unavailable(String),
    Other(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Unavailable(m) => write!(f, "veritabanına ulaşılamıyor: {m}"),
            StoreError::Other(m) => f.write_str(m),
        }
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

pub struct UserRow {
    pub id: String,
    pub email: String,
    pub password_hash: String,
    pub recovery_hash: String,
}

pub struct SessionInfo {
    pub user_id: String,
    pub email: String,
    pub last_seen: i64,
}

pub struct UserSummary {
    pub id: String,
    pub email: String,
    /// Unix saniye
    pub created_at: i64,
    pub sessions: i64,
}

pub enum NewUser {
    Created,
    EmailTaken,
}

pub trait AuthStore: Send + Sync {
    fn find_user(&self, email: &str) -> StoreResult<Option<UserRow>>;
    fn password_hash(&self, user_id: &str) -> StoreResult<Option<String>>;
    fn user_exists(&self, user_id: &str) -> StoreResult<bool>;
    fn count_users(&self) -> StoreResult<i64>;
    fn insert_user(&self, id: &str, email: &str, password_hash: &str, recovery_hash: &str, created_at: i64) -> StoreResult<NewUser>;
    /// Kullanıcı satırı (oturumlar ve Postgres'te bütün verisi CASCADE ile)
    fn delete_user(&self, user_id: &str) -> StoreResult<()>;
    fn set_password(&self, user_id: &str, password_hash: &str) -> StoreResult<()>;
    fn set_password_and_recovery(&self, user_id: &str, password_hash: &str, recovery_hash: &str) -> StoreResult<()>;
    fn insert_session(&self, token_hash: &str, user_id: &str, device: &str, now: i64) -> StoreResult<()>;
    fn session(&self, token_hash: &str) -> StoreResult<Option<SessionInfo>>;
    fn touch_session(&self, token_hash: &str, now: i64) -> StoreResult<()>;
    fn delete_session(&self, token_hash: &str) -> StoreResult<()>;
    /// Kullanıcının `keep` dışındaki bütün oturumları (None: hepsi)
    fn delete_sessions(&self, user_id: &str, keep: Option<&str>) -> StoreResult<()>;
    /// `last_seen < older_than` olanlar; silinen sayı
    fn sweep_sessions(&self, older_than: i64) -> StoreResult<u64>;
    fn list_users(&self) -> StoreResult<Vec<UserSummary>>;
    fn ping(&self) -> StoreResult<()>;
}
