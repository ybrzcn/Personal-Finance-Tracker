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
    /// Doğrulama uygulaması kodu açık mı
    pub totp_enabled: bool,
}

/// Kullanıcının passkey'i; `id` tarayıcının verdiği kimlik (base64url).
pub struct PasskeyRow {
    pub id: String,
    pub user_id: String,
    pub name: String,
    /// Kayıtlı olduğu alan adı
    pub rp_id: String,
    /// COSE algoritması (-7 ES256, -8 EdDSA, -257 RS256)
    pub alg: i64,
    /// SPKI DER
    pub public_key: Vec<u8>,
    pub sign_count: i64,
    pub created_at: i64,
    pub last_used: Option<i64>,
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

/// Uçtan uca şifreli eşitleme: sunucu yalnız şifreli parçaları ve sarılmış anahtarı (anahtarlık) saklar.
pub struct SyncMeta {
    /// İstemcinin anahtarlık JSON'u (sunucu açamaz)
    pub keyring: String,
    pub version: i64,
    pub updated_at: i64,
    pub data_bytes: i64,
    pub files: i64,
    pub files_bytes: i64,
}

pub struct SyncFile {
    pub id: String,
    pub size: i64,
    pub created_at: i64,
}

pub enum SyncPut {
    /// Yeni sürüm (dosyada 0)
    Ok(i64),
    /// Taban sürüm güncel değil
    Conflict,
    /// Eşitleme sıfırlanmış/kapatılmış: istemcinin anahtarı geçersiz
    KeyChanged,
    /// Yazılırsa kullanıcının kotası aşılır
    OverQuota,
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
    /// Kurtarma: yeni şifre ve kurtarma kodu; doğrulama uygulaması kodu da kapatılır (telefon kaybolmuş olabilir)
    fn set_password_and_recovery(&self, user_id: &str, password_hash: &str, recovery_hash: &str) -> StoreResult<()>;
    fn user_email(&self, user_id: &str) -> StoreResult<Option<String>>;
    /// (gizli anahtar, son kullanılan zaman adımı)
    fn totp(&self, user_id: &str) -> StoreResult<(Option<String>, Option<i64>)>;
    /// Açar (Some) ya da kapatır (None); son adım sıfırlanır
    fn set_totp(&self, user_id: &str, secret: Option<&str>) -> StoreResult<()>;
    /// Zaman adımını kullanılmış sayar; daha önce bu ya da sonraki bir adım kullanıldıysa false (kod tekrar kullanılamaz)
    fn use_totp_step(&self, user_id: &str, step: i64) -> StoreResult<bool>;
    fn list_passkeys(&self, user_id: &str) -> StoreResult<Vec<PasskeyRow>>;
    fn passkey(&self, id: &str) -> StoreResult<Option<PasskeyRow>>;
    /// Aynı kimlik kayıtlıysa false
    fn insert_passkey(&self, p: &PasskeyRow) -> StoreResult<bool>;
    /// Girişte sayaç ve son kullanım; sayaç bu arada değiştiyse (eşzamanlı giriş) false
    fn passkey_used(&self, id: &str, old_count: i64, new_count: i64, now: i64) -> StoreResult<bool>;
    fn delete_passkey(&self, user_id: &str, id: &str) -> StoreResult<bool>;
    /// Kullanıcının bütün passkey'leri; silinen sayı
    fn delete_passkeys(&self, user_id: &str) -> StoreResult<u64>;
    fn sync_meta(&self, user_id: &str) -> StoreResult<Option<SyncMeta>>;
    /// İlk kurulumda oluşturur; varsa yalnız aynı anahtarın yeni sarımı kabul edilir (değilse false)
    fn sync_set_keyring(&self, user_id: &str, key_id: &str, keyring: &str, now: i64) -> StoreResult<bool>;
    /// (sürüm, şifreli veri)
    fn sync_data(&self, user_id: &str) -> StoreResult<Option<(i64, Vec<u8>)>>;
    /// Yalnız sunucudaki sürüm `base` ise yazar. `quota`: veri + dosyaların toplam sınırı (bayt); denetim yazmayla aynı işlemde
    fn sync_put_data(&self, user_id: &str, key_id: &str, base: i64, data: &[u8], now: i64, quota: Option<i64>) -> StoreResult<SyncPut>;
    fn sync_files(&self, user_id: &str) -> StoreResult<Vec<SyncFile>>;
    fn sync_file(&self, user_id: &str, id: &str) -> StoreResult<Option<Vec<u8>>>;
    fn sync_put_file(&self, user_id: &str, key_id: &str, id: &str, data: &[u8], now: i64, quota: Option<i64>) -> StoreResult<SyncPut>;
    fn sync_delete_file(&self, user_id: &str, id: &str) -> StoreResult<bool>;
    /// Anahtarlık, veri ve dosyalar
    fn sync_delete(&self, user_id: &str) -> StoreResult<()>;
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
