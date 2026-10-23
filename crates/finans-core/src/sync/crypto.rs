//! Şifreleme. Veri anahtarı (32 bayt, rastgele) her cihazda saklanır; sunucuya yalnız eşitleme parolasından
//! Argon2id ile türetilen anahtarla sarılmış hali gider ("anahtarlık"). Veri ve dosyalar XChaCha20-Poly1305 ile
//! şifrelenir; ek veri (AAD) anahtar kimliğini ve parçanın ne olduğunu bağlar (sunucu parçaları birbirinin yerine koyamaz).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};

use crate::CoreResult;

const MAGIC: &[u8; 4] = b"FNS1";
const NONCE: usize = 24;

/// Argon2id: 64 MiB, 3 geçiş (telefonda da bir iki saniye)
const KDF_M: u32 = 64 * 1024;
const KDF_T: u32 = 3;
const KDF_P: u32 = 1;

pub const MIN_PASSPHRASE: usize = 10;

pub type DataKey = [u8; 32];

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).expect("rastgele sayı üretilemedi");
    b
}

pub fn new_key() -> DataKey {
    random()
}

/// Anahtar kimliği: eşitleme sıfırlanınca değişir, eski anahtarlı cihazlar bunu görüp durur.
pub fn new_key_id() -> String {
    random::<16>().iter().map(|b| format!("{b:02x}")).collect()
}

pub fn b64(b: &[u8]) -> String {
    STANDARD.encode(b)
}

pub fn unb64(s: &str) -> CoreResult<Vec<u8>> {
    STANDARD.decode(s).map_err(|_| "Eşitleme verisi okunamadı.".to_string())
}

/// Sunucuda duran sarılmış anahtar. Sunucu içeriğini çözemez.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Keyring {
    pub v: u32,
    pub key_id: String,
    pub kdf: String,
    pub m: u32,
    pub t: u32,
    pub p: u32,
    pub salt: String,
    pub nonce: String,
    pub wrapped: String,
}

fn kek(passphrase: &str, salt: &[u8], m: u32, t: u32, p: u32) -> CoreResult<DataKey> {
    // Aşırı değerli (bozuk ya da kötü niyetli) anahtarlık cihazı kilitlemesin
    if !(8..=256 * 1024).contains(&m) || !(1..=10).contains(&t) || !(1..=4).contains(&p) {
        return Err("Eşitleme anahtarlığı geçersiz.".into());
    }
    let params = argon2::Params::new(m, t, p, Some(32)).map_err(|_| "Eşitleme anahtarlığı geçersiz.".to_string())?;
    let mut out = [0u8; 32];
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|_| "Eşitleme anahtarı türetilemedi.".to_string())?;
    Ok(out)
}

fn wrap_aad(key_id: &str) -> Vec<u8> {
    format!("finans-sync/1/{key_id}/keyring").into_bytes()
}

pub fn check_passphrase(passphrase: &str) -> CoreResult<()> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(format!("Eşitleme parolası en az {MIN_PASSPHRASE} karakter olmalı."));
    }
    Ok(())
}

/// Veri anahtarını parolayla sarar (yeni tuz her seferinde).
pub fn make_keyring(passphrase: &str, key: &DataKey, key_id: &str) -> CoreResult<Keyring> {
    check_passphrase(passphrase)?;
    let salt = random::<16>();
    let nonce = random::<NONCE>();
    let k = kek(passphrase, &salt, KDF_M, KDF_T, KDF_P)?;
    let wrapped = XChaCha20Poly1305::new(&k.into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: key, aad: &wrap_aad(key_id) })
        .map_err(|_| "Şifreleme başarısız.".to_string())?;
    Ok(Keyring {
        v: 1,
        key_id: key_id.to_string(),
        kdf: "argon2id".into(),
        m: KDF_M,
        t: KDF_T,
        p: KDF_P,
        salt: b64(&salt),
        nonce: b64(&nonce),
        wrapped: b64(&wrapped),
    })
}

/// Parolayla veri anahtarını açar; parola yanlışsa anlaşılır hata.
pub fn open_keyring(passphrase: &str, kr: &Keyring) -> CoreResult<DataKey> {
    if kr.v != 1 || kr.kdf != "argon2id" {
        return Err("Bu eşitleme verisi daha yeni bir sürümle oluşturulmuş; uygulamayı güncelleyin.".into());
    }
    let nonce = unb64(&kr.nonce)?;
    if nonce.len() != NONCE {
        return Err("Eşitleme anahtarlığı geçersiz.".into());
    }
    let k = kek(passphrase, &unb64(&kr.salt)?, kr.m, kr.t, kr.p)?;
    let key = XChaCha20Poly1305::new(&k.into())
        .decrypt(XNonce::from_slice(&nonce), Payload { msg: &unb64(&kr.wrapped)?, aad: &wrap_aad(&kr.key_id) })
        .map_err(|_| "Eşitleme parolası hatalı.".to_string())?;
    key.try_into().map_err(|_| "Eşitleme anahtarlığı geçersiz.".to_string())
}

fn aad(key_id: &str, purpose: &str) -> Vec<u8> {
    format!("finans-sync/1/{key_id}/{purpose}").into_bytes()
}

/// "FNS1" ‖ nonce (24) ‖ şifreli metin. `purpose`: "data" ya da "file:<id>".
pub fn seal(key: &DataKey, key_id: &str, purpose: &str, plain: &[u8]) -> Vec<u8> {
    let nonce = random::<NONCE>();
    let ct = XChaCha20Poly1305::new(key.into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plain, aad: &aad(key_id, purpose) })
        .expect("şifreleme");
    let mut out = Vec::with_capacity(4 + NONCE + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

pub fn open(key: &DataKey, key_id: &str, purpose: &str, blob: &[u8]) -> CoreResult<Vec<u8>> {
    let bad = || "Sunucudaki şifreli veri açılamadı (bozuk ya da başka bir anahtarla şifrelenmiş).".to_string();
    if blob.len() < 4 + NONCE + 16 || &blob[..4] != MAGIC {
        return Err(bad());
    }
    XChaCha20Poly1305::new(key.into())
        .decrypt(XNonce::from_slice(&blob[4..4 + NONCE]), Payload { msg: &blob[4 + NONCE..], aad: &aad(key_id, purpose) })
        .map_err(|_| bad())
}

/// Anlık görüntü JSON'u sıkıştırılarak şifrelenir (metin ~10 kat küçülür).
pub fn compress(b: &[u8]) -> Vec<u8> {
    miniz_oxide::deflate::compress_to_vec(b, 6)
}

/// Açılmış veri boyutu sınırı: bozuk veri belleği doldurmasın
const MAX_PLAIN: usize = 512 * 1024 * 1024;

pub fn decompress(b: &[u8]) -> CoreResult<Vec<u8>> {
    miniz_oxide::inflate::decompress_to_vec_with_limit(b, MAX_PLAIN).map_err(|_| "Eşitleme verisi açılamadı.".to_string())
}
