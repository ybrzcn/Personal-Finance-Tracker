//! İki aşamalı doğrulama: TOTP (doğrulama uygulaması kodu, RFC 6238) ve giriş/kurulum adımları arasındaki
//! kısa ömürlü biletler (bellekte; sunucu yeniden başlayınca düşer, kullanıcı adımı baştan yapar).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use sha1::Sha1;

/// Kod 30 saniyede bir değişir; saat kaymasına karşı bir önceki ve sonraki adım da kabul edilir.
const STEP: i64 = 30;
const SKEW: i64 = 1;

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    let (mut buf, mut bits) = (0u32, 0u32);
    for &b in bytes {
        buf = (buf << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32[((buf >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.chars().filter(|c| *c != '=' && !c.is_whitespace()) {
        let v = B32.iter().position(|b| *b as char == c.to_ascii_uppercase())? as u32;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

/// 160 bit rastgele gizli anahtar (base32, uygulamalara elle de girilebilir).
pub fn new_totp_secret() -> String {
    let mut b = [0u8; 20];
    getrandom::getrandom(&mut b).expect("rastgele sayı üretilemedi");
    base32_encode(&b)
}

fn code_at(key: &[u8], step: i64) -> u32 {
    let mut mac = Hmac::<Sha1>::new_from_slice(key).expect("HMAC her uzunlukta anahtar alır");
    mac.update(&step.to_be_bytes());
    let h = mac.finalize().into_bytes();
    let off = (h[19] & 0x0f) as usize;
    let bin = u32::from_be_bytes([h[off] & 0x7f, h[off + 1], h[off + 2], h[off + 3]]);
    bin % 1_000_000
}

/// Kod doğruysa eşleşen zaman adımı. `last_step` ve öncesi kabul edilmez (aynı kod ikinci kez kullanılamasın).
pub fn verify_totp(secret: &str, code: &str, now: i64, last_step: Option<i64>) -> Option<i64> {
    let code: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let want: u32 = code.parse().ok()?;
    let key = base32_decode(secret)?;
    let now_step = now.div_euclid(STEP);
    (now_step - SKEW..=now_step + SKEW)
        .filter(|s| last_step.is_none_or(|l| *s > l))
        .find(|s| code_at(&key, *s) == want)
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Doğrulama uygulamasının okuduğu adres (QR kodunun içeriği).
pub fn otpauth_uri(email: &str, secret: &str) -> String {
    format!("otpauth://totp/Finans:{}?secret={secret}&issuer=Finans&algorithm=SHA1&digits=6&period=30", url_encode(email))
}

/// QR kodu (SVG); arayüz `data:` adresi olarak gösterir.
pub fn qr_svg(text: &str) -> String {
    match qrcode::QrCode::new(text.as_bytes()) {
        Ok(q) => q.render::<qrcode::render::svg::Color>().min_dimensions(200, 200).quiet_zone(true).build(),
        Err(_) => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Biletler
// ---------------------------------------------------------------------------

/// Bir adımdan sonrakine taşınan durum.
#[derive(Clone)]
pub enum Ticket {
    /// Şifre doğru, TOTP kodu bekleniyor
    LoginTotp { user_id: String, device: String },
    /// TOTP kurulumu: anahtar uygulamaya eklendi, ilk kodla onay bekleniyor
    TotpSetup { user_id: String, secret: String },
    /// Passkey ekleme: tarayıcıdan imzalı yanıt bekleniyor
    PasskeyRegister { user_id: String, challenge: String, rp_id: String },
    /// Passkey ile giriş
    PasskeyLogin { challenge: String, rp_id: String },
}

struct Entry {
    ticket: Ticket,
    expires: Instant,
    attempts: u32,
}

/// Bilet başına en çok bu kadar yanlış kod; sonra bilet düşer ve giriş baştan yapılır.
const MAX_ATTEMPTS: u32 = 5;
const CAP: usize = 20_000;

#[derive(Default)]
pub struct Tickets {
    map: Mutex<HashMap<[u8; 32], Entry>>,
}

fn key(token: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(token.as_bytes()).into()
}

impl Tickets {
    /// Yeni bilet; dönen değer istemciye verilir. Dolu ise süresi geçenler atılır, yine doluysa en eski atılır.
    pub fn issue(&self, ticket: Ticket, ttl: Duration) -> String {
        let token = crate::auth::new_token();
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if map.len() >= CAP {
            map.retain(|_, e| e.expires > now);
            if map.len() >= CAP {
                if let Some(k) = map.iter().min_by_key(|(_, e)| e.expires).map(|(k, _)| *k) {
                    map.remove(&k);
                }
            }
        }
        map.insert(key(&token), Entry { ticket, expires: now + ttl, attempts: 0 });
        token
    }

    /// Kod denemesi: deneme sayısı doğrulamadan önce kilit altında artırılır (eşzamanlı isteklerle sınır aşılamasın).
    /// Bilet ve bunun son deneme olup olmadığı döner; kod doğruysa `take`, son deneme yanlışsa da `take` ile düşürülür.
    pub fn attempt(&self, token: &str) -> Option<(Ticket, bool)> {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let k = key(token);
        let e = map.get_mut(&k)?;
        if e.expires <= Instant::now() || e.attempts >= MAX_ATTEMPTS {
            map.remove(&k);
            return None;
        }
        e.attempts += 1;
        Some((e.ticket.clone(), e.attempts >= MAX_ATTEMPTS))
    }

    /// Bileti tüketmeden okur.
    pub fn peek(&self, token: &str) -> Option<Ticket> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&key(token)).filter(|e| e.expires > Instant::now()).map(|e| e.ticket.clone())
    }

    /// Bileti tüketir (tek kullanımlık).
    pub fn take(&self, token: &str) -> Option<Ticket> {
        self.take_if(token, |_| true)
    }

    /// Bileti yalnız beklenen türdeyse tüketir (başka adımın bileti yanlış uç noktaya gönderilince düşmesin).
    pub fn take_if(&self, token: &str, kind: impl Fn(&Ticket) -> bool) -> Option<Ticket> {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let k = key(token);
        if !kind(&map.get(&k)?.ticket) {
            return None;
        }
        map.remove(&k).filter(|e| e.expires > Instant::now()).map(|e| e.ticket)
    }

    /// Kullanıcının bekleyen tüm biletleri düşer (şifre değişince eski şifreyle başlamış giriş tamamlanamasın).
    pub fn revoke_user(&self, user_id: &str) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, e| match &e.ticket {
            Ticket::LoginTotp { user_id: u, .. } | Ticket::TotpSetup { user_id: u, .. } | Ticket::PasskeyRegister { user_id: u, .. } => u != user_id,
            Ticket::PasskeyLogin { .. } => true,
        });
    }
}
