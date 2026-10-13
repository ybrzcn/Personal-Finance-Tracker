//! Hesaplar ve oturumlar: auth.db şeması, şifre/kurtarma kodu hash'leri, oturum token'ları ve hız sınırı.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    recovery_hash  TEXT NOT NULL,
    created_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
PRAGMA user_version = 1;
";

/// Oturum son kullanımdan bu kadar süre sonra geçersiz olur.
pub const SESSION_TTL: i64 = 180 * 24 * 3600;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

/// Süresi dolmuş oturumları siler (açılışta).
pub fn sweep_sessions(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM sessions WHERE last_seen < ?1", [now() - SESSION_TTL])
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Gizli değerler
// ---------------------------------------------------------------------------

pub fn hash_secret(secret: &str) -> String {
    let salt = SaltString::encode_b64(&random_bytes::<16>()).expect("tuz üretilemedi");
    Argon2::default()
        .hash_password(secret.as_bytes(), &salt)
        .expect("argon2 hash üretilemedi")
        .to_string()
}

pub fn verify_secret(secret: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| Argon2::default().verify_password(secret.as_bytes(), &h).is_ok())
}

/// Kayıtlı olmayan e-postada da aynı süre harcansın diye sabit bir hash doğrulanır (hesap varlığı sızmasın).
pub fn dummy_verify(secret: &str) {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let h = DUMMY.get_or_init(|| hash_secret("finans-dummy"));
    let _ = verify_secret(secret, h);
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).expect("rastgele sayı üretilemedi");
    b
}

pub fn new_token() -> String {
    hex::encode(random_bytes::<32>())
}

pub fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Karışan karakterler (0/O, 1/I) olmayan alfabe; kurtarma kodu ve geçici şifrede kullanılır.
const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

fn random_code(len: usize) -> String {
    let bytes = random_bytes::<32>();
    // 256, 32'ye tam bölündüğü için modülo sapması yok
    bytes.iter().take(len).map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char).collect()
}

/// 16 karakter, 4'lü gruplar: "ABCD-EFGH-JKLM-NPQR".
pub fn new_recovery_code() -> String {
    group(&random_code(16))
}

/// Geçici şifre (yönetici sıfırlaması).
pub fn new_temp_password() -> String {
    random_code(16)
}

fn group(s: &str) -> String {
    s.as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

/// Kullanıcının yazdığı kodu karşılaştırılabilir biçime getirir (boşluk/küçük harf/tire farkı önemsiz).
pub fn normalize_recovery_code(code: &str) -> String {
    let s: String = code
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    group(&s)
}

pub fn normalize_email(email: &str) -> Result<String, String> {
    let e = email.trim().to_lowercase();
    let ok = e.len() <= 254
        && !e.contains(char::is_whitespace)
        && e.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
        });
    if ok {
        Ok(e)
    } else {
        Err("Geçerli bir e-posta adresi girin.".into())
    }
}

pub fn check_password(p: &str) -> Result<(), String> {
    match p.chars().count() {
        n if n < 8 => Err("Şifre en az 8 karakter olmalıdır.".into()),
        n if n > 128 => Err("Şifre en fazla 128 karakter olabilir.".into()),
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Kullanıcılar ve oturumlar
// ---------------------------------------------------------------------------

pub struct UserRow {
    pub id: String,
    pub email: String,
    pub password_hash: String,
    pub recovery_hash: String,
}

pub fn find_user(conn: &Connection, email: &str) -> rusqlite::Result<Option<UserRow>> {
    conn.query_row(
        "SELECT id, email, password_hash, recovery_hash FROM users WHERE email = ?1",
        [email],
        |r| Ok(UserRow { id: r.get(0)?, email: r.get(1)?, password_hash: r.get(2)?, recovery_hash: r.get(3)? }),
    )
    .optional()
}

pub fn create_session(conn: &Connection, user_id: &str, device: &str) -> rusqlite::Result<String> {
    let token = new_token();
    let t = now();
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, device, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)",
        (token_hash(&token), user_id, device.chars().take(120).collect::<String>(), t),
    )?;
    Ok(token)
}

// ---------------------------------------------------------------------------
// Hız sınırı
// ---------------------------------------------------------------------------

/// Basit sabit pencere sayacı (bellekte; sunucu yeniden başlayınca sıfırlanır).
/// Anahtarlar hash'lenerek saklanır (istemcinin gönderdiği uzun değerler belleği büyütmesin); kayıt sayısı sınırlıdır.
#[derive(Default)]
pub struct RateLimiter {
    hits: Mutex<HashMap<[u8; 32], (u32, Instant, Duration)>>,
}

/// Bu kadar farklı anahtar birikirse süresi dolanlar atılır; yine doluysa yeni anahtarlar reddedilir.
const LIMITER_CAP: usize = 50_000;

impl RateLimiter {
    pub fn allow(&self, key: &str, max: u32, window: Duration) -> bool {
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let k: [u8; 32] = Sha256::digest(key.as_bytes()).into();
        if !hits.contains_key(&k) && hits.len() >= LIMITER_CAP {
            // Her kayıt kendi penceresine göre temizlenir (giriş ve kayıt pencereleri farklı)
            hits.retain(|_, (_, start, w)| now.duration_since(*start) < *w);
            if hits.len() >= LIMITER_CAP {
                // Hâlâ doluysa yeni gelenler reddedilmez (herkes kilitlenirdi); en eski %10 atılır
                let mut starts: Vec<Instant> = hits.values().map(|(_, s, _)| *s).collect();
                starts.sort_unstable();
                let cutoff = starts[starts.len() / 10];
                hits.retain(|_, (_, start, _)| *start > cutoff);
            }
        }
        let entry = hits.entry(k).or_insert((0, now, window));
        if now.duration_since(entry.1) >= entry.2 {
            *entry = (0, now, window);
        }
        entry.0 = entry.0.saturating_add(1);
        entry.0 <= max
    }
}

// ---------------------------------------------------------------------------
// Yönetim komutları (komut satırı)
// ---------------------------------------------------------------------------

/// `finans-server users`: kullanıcıları listeler.
pub fn cli_users(conn: &Connection) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, email, datetime(created_at, 'unixepoch'),
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id)
         FROM users u ORDER BY created_at",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?))
    })?;
    let mut n = 0;
    for row in rows {
        let (id, email, created, sessions) = row?;
        println!("{id}  {email}  {created} UTC  {sessions} oturum");
        n += 1;
    }
    println!("{n} kullanıcı");
    Ok(())
}

/// `finans-server reset-password <eposta>`: geçici şifre verir, tüm oturumları kapatır. Kullanıcı yoksa false.
pub fn cli_reset_password(conn: &Connection, email: &str) -> rusqlite::Result<bool> {
    let Some(user) = find_user(conn, &email.trim().to_lowercase())? else { return Ok(false) };
    let password = new_temp_password();
    conn.execute("UPDATE users SET password_hash = ?2 WHERE id = ?1", (&user.id, hash_secret(&password)))?;
    conn.execute("DELETE FROM sessions WHERE user_id = ?1", [&user.id])?;
    println!("{} için geçici şifre: {password}", user.email);
    println!("Kullanıcı giriş yaptıktan sonra Ayarlar → Hesap'tan şifresini değiştirmeli.");
    Ok(true)
}
