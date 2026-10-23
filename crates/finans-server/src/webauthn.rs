//! Passkey (WebAuthn) doğrulaması. Kayıtta onay belgesi (attestation) istenmez ("none"); tarayıcının verdiği
//! açık anahtar (SPKI DER) saklanır ve girişte imza bununla doğrulanır.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Desteklenen algoritmalar (COSE): ES256, EdDSA, RS256.
pub const ALGS: [i64; 3] = [-7, -8, -257];

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64(s: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).map_err(|_| "Passkey yanıtı okunamadı.".to_string())
}

pub fn new_challenge() -> String {
    let mut b = [0u8; 32];
    getrandom::getrandom(&mut b).expect("rastgele sayı üretilemedi");
    b64(&b)
}

/// İsteğin geldiği alan adı (port olmadan); passkey bu ada bağlanır. IP adresi ve boş ad kabul edilmez
/// (tarayıcılar da kabul etmez).
pub fn rp_id_from_host(host: &str) -> Result<String, String> {
    let host = host.trim().to_ascii_lowercase();
    let name = if host.starts_with('[') { "" } else { host.rsplit_once(':').map_or(host.as_str(), |(h, _)| h) };
    let ok = !name.is_empty()
        && name.len() <= 253
        && name.parse::<std::net::IpAddr>().is_err()
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.');
    if ok {
        Ok(name.to_string())
    } else {
        Err("Passkey bu adreste kullanılamıyor; sunucuya alan adıyla (ör. https://finans.ornek.com) bağlanın.".into())
    }
}

#[derive(Deserialize)]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
    origin: String,
    #[serde(rename = "crossOrigin", default)]
    cross_origin: bool,
}

/// clientDataJSON: tür, sorgu ve köken (https://<rp_id>[:port]; yerel denemede http://localhost) denetlenir.
fn check_client_data(raw: &[u8], kind: &str, challenge: &str, rp_id: &str) -> Result<(), String> {
    let bad = || "Passkey doğrulanamadı.".to_string();
    let c: ClientData = serde_json::from_slice(raw).map_err(|_| bad())?;
    if c.kind != kind || c.challenge != challenge || c.cross_origin {
        return Err(bad());
    }
    let rest = match c.origin.split_once("://") {
        Some(("https", r)) => r,
        Some(("http", r)) if rp_id == "localhost" => r,
        _ => return Err(bad()),
    };
    let host = rest.rsplit_once(':').map_or(rest, |(h, p)| if p.bytes().all(|b| b.is_ascii_digit()) { h } else { rest });
    if host.to_ascii_lowercase() != rp_id {
        return Err(bad());
    }
    Ok(())
}

pub struct AuthData {
    pub sign_count: u32,
    /// Kayıtta: kimlik bilgisi kimliği
    pub credential_id: Option<Vec<u8>>,
}

const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_AT: u8 = 0x40;

/// authenticatorData: alan adı özeti, kullanıcı varlığı ve doğrulaması (parmak izi/PIN) zorunlu.
fn parse_auth_data(raw: &[u8], rp_id: &str) -> Result<AuthData, String> {
    let bad = || "Passkey doğrulanamadı.".to_string();
    if raw.len() < 37 || raw[..32] != Sha256::digest(rp_id.as_bytes())[..] {
        return Err(bad());
    }
    let flags = raw[32];
    if flags & FLAG_UP == 0 || flags & FLAG_UV == 0 {
        return Err("Passkey kullanıcı doğrulaması (parmak izi, yüz ya da PIN) gerekiyor.".into());
    }
    let sign_count = u32::from_be_bytes([raw[33], raw[34], raw[35], raw[36]]);
    let credential_id = if flags & FLAG_AT != 0 {
        // 16 bayt AAGUID, 2 bayt uzunluk, kimlik
        let len = raw.get(53..55).map(|b| u16::from_be_bytes([b[0], b[1]]) as usize).ok_or_else(bad)?;
        Some(raw.get(55..55 + len).ok_or_else(bad)?.to_vec())
    } else {
        None
    };
    Ok(AuthData { sign_count, credential_id })
}

fn verify_sig(alg: i64, spki: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    use p256::pkcs8::DecodePublicKey;
    match alg {
        -7 => {
            use p256::ecdsa::signature::Verifier;
            let (Ok(k), Ok(s)) = (p256::ecdsa::VerifyingKey::from_public_key_der(spki), p256::ecdsa::Signature::from_der(sig)) else {
                return false;
            };
            k.verify(msg, &s).is_ok()
        }
        -8 => {
            use ed25519_dalek::Verifier;
            let (Ok(k), Ok(s)) = (ed25519_dalek::VerifyingKey::from_public_key_der(spki), ed25519_dalek::Signature::from_slice(sig)) else {
                return false;
            };
            k.verify(msg, &s).is_ok()
        }
        -257 => {
            use rsa::signature::Verifier;
            let Ok(k) = rsa::RsaPublicKey::from_public_key_der(spki) else { return false };
            let Ok(s) = rsa::pkcs1v15::Signature::try_from(sig) else { return false };
            rsa::pkcs1v15::VerifyingKey::<Sha256>::new(k).verify(msg, &s).is_ok()
        }
        _ => false,
    }
}

/// Açık anahtar bu algoritmayla okunabiliyor mu (kayıtta).
fn key_ok(alg: i64, spki: &[u8]) -> bool {
    use p256::pkcs8::DecodePublicKey;
    match alg {
        -7 => p256::ecdsa::VerifyingKey::from_public_key_der(spki).is_ok(),
        -8 => ed25519_dalek::VerifyingKey::from_public_key_der(spki).is_ok(),
        -257 => rsa::RsaPublicKey::from_public_key_der(spki).is_ok_and(|k| {
            use rsa::traits::PublicKeyParts;
            k.size() >= 256
        }),
        _ => false,
    }
}

/// Kayıt yanıtı (tarayıcının `PublicKeyCredential.toJSON()` alanlarından).
pub struct Registration<'a> {
    pub id: &'a str,
    pub client_data: &'a [u8],
    pub auth_data: &'a [u8],
    pub public_key: &'a [u8],
    pub alg: i64,
}

pub fn verify_registration(r: &Registration, challenge: &str, rp_id: &str) -> Result<u32, String> {
    check_client_data(r.client_data, "webauthn.create", challenge, rp_id)?;
    let ad = parse_auth_data(r.auth_data, rp_id)?;
    if ad.credential_id.as_deref() != Some(&unb64(r.id)?[..]) || r.id.is_empty() || r.id.len() > 1400 {
        return Err("Passkey doğrulanamadı.".into());
    }
    if !ALGS.contains(&r.alg) || !key_ok(r.alg, r.public_key) {
        return Err("Bu passkey türü desteklenmiyor.".into());
    }
    Ok(ad.sign_count)
}

pub struct Assertion<'a> {
    pub client_data: &'a [u8],
    pub auth_data: &'a [u8],
    pub signature: &'a [u8],
}

/// Giriş imzası; geçerliyse cihazın yeni sayacı. Sayaç kullanan cihazlarda geri gitmesi kopyalanmış anahtar demektir.
pub fn verify_assertion(a: &Assertion, challenge: &str, rp_id: &str, alg: i64, public_key: &[u8], stored_count: i64) -> Result<u32, String> {
    check_client_data(a.client_data, "webauthn.get", challenge, rp_id)?;
    let ad = parse_auth_data(a.auth_data, rp_id)?;
    let mut msg = a.auth_data.to_vec();
    msg.extend_from_slice(&Sha256::digest(a.client_data));
    if !verify_sig(alg, public_key, &msg, a.signature) {
        return Err("Passkey doğrulanamadı.".into());
    }
    if (ad.sign_count != 0 || stored_count != 0) && i64::from(ad.sign_count) <= stored_count {
        return Err("Passkey doğrulanamadı (cihaz sayacı geri gitti).".into());
    }
    Ok(ad.sign_count)
}
