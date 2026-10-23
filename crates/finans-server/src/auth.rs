//! Hesaplar ve oturumlar: şifre/kurtarma kodu hash'leri, oturum token'ları ve hız sınırı (SQL `AuthStore`'da).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use sha2::{Digest, Sha256};

use crate::auth_store::{AuthStore, StoreResult};

/// Oturum son kullanımdan bu kadar süre sonra geçersiz olur.
pub const SESSION_TTL: i64 = 180 * 24 * 3600;

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
    /// Sayaç pencere içinde `max`'a ulaştı mı (artırmadan). Yalnız başarısız denemeler sayılacaksa
    /// önce buna bakılır, başarısızlıkta `allow` ile sayılır.
    pub fn exceeded(&self, key: &str, max: u32) -> bool {
        let hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        let k: [u8; 32] = Sha256::digest(key.as_bytes()).into();
        hits.get(&k).is_some_and(|(n, start, w)| Instant::now().duration_since(*start) < *w && *n >= max)
    }

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

/// Süresi dolmuş oturumları siler (açılışta).
pub fn sweep_sessions(store: &dyn AuthStore) -> StoreResult<u64> {
    store.sweep_sessions(now() - SESSION_TTL)
}

pub fn create_session(store: &dyn AuthStore, user_id: &str, device: &str) -> StoreResult<String> {
    let token = new_token();
    store.insert_session(&token_hash(&token), user_id, &device.chars().take(120).collect::<String>(), now())?;
    Ok(token)
}

/// Unix saniyeyi "YYYY-AA-GG SS:DD:ss" (UTC) olarak yazar.
fn fmt_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant, civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// `finans-server users`: kullanıcıları listeler.
pub fn cli_users(store: &dyn AuthStore) -> StoreResult<()> {
    let users = store.list_users()?;
    for u in &users {
        println!("{}  {}  {} UTC  {} oturum", u.id, u.email, fmt_unix(u.created_at), u.sessions);
    }
    println!("{} kullanıcı", users.len());
    Ok(())
}

/// `finans-server reset-password <eposta>`: geçici şifre verir, tüm oturumları kapatır. Kullanıcı yoksa false.
pub fn cli_reset_password(store: &dyn AuthStore, email: &str) -> StoreResult<bool> {
    let Some(user) = store.find_user(&email.trim().to_lowercase())? else { return Ok(false) };
    let password = new_temp_password();
    store.set_password(&user.id, &hash_secret(&password))?;
    store.delete_sessions(&user.id, None)?;
    println!("{} için geçici şifre: {password}", user.email);
    println!("Kullanıcı giriş yaptıktan sonra Ayarlar → Hesap'tan şifresini değiştirmeli.");
    Ok(true)
}

/// `finans-server disable-2fa <eposta>`: doğrulama uygulaması kodunu kapatır ve passkey'leri siler (telefonunu ve
/// kurtarma kodunu kaybeden kullanıcı için). Oturumlar kapanmaz. Kullanıcı yoksa false.
pub fn cli_disable_2fa(store: &dyn AuthStore, email: &str) -> StoreResult<bool> {
    let Some(user) = store.find_user(&email.trim().to_lowercase())? else { return Ok(false) };
    store.set_totp(&user.id, None)?;
    let removed = store.delete_passkeys(&user.id)?;
    println!("{}: doğrulama uygulaması kodu kapatıldı, {removed} passkey silindi.", user.email);
    Ok(true)
}
