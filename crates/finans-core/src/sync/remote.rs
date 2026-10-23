//! Sunucunun eşitleme uç noktaları (`/api/sync`). Sunucu yalnız şifreli parçaları saklar.

use std::io::Read;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use super::crypto::Keyring;
use crate::CoreResult;

/// Sunucudaki veri parçasının sınırı (sunucuyla aynı)
pub const MAX_DATA: u64 = 64 * 1024 * 1024;
pub const MAX_FILE: u64 = 12 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub keyring: Option<Keyring>,
    pub version: i64,
    /// Son yazma (unix sn)
    #[serde(default)]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub data_bytes: i64,
    #[serde(default)]
    pub files: i64,
    #[serde(default)]
    pub files_bytes: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub id: String,
    /// Yüklenme zamanı (unix sn)
    pub created_at: i64,
}

pub enum Put {
    Ok(i64),
    /// Sunucudaki sürüm bu arada değişti
    Conflict,
}

pub struct Remote {
    base: String,
    token: String,
    agent: ureq::Agent,
}

/// Yanıt gövdesi JSON (ureq "json" özelliği olmadan)
fn json_of<T: serde::de::DeserializeOwned>(resp: ureq::Response) -> CoreResult<T> {
    let mut body = String::new();
    resp.into_reader().take(1024 * 1024).read_to_string(&mut body).map_err(|e| format!("Sunucu yanıtı okunamadı: {e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("Sunucu yanıtı okunamadı: {e}"))
}

fn send_json(req: ureq::Request, v: serde_json::Value) -> Result<ureq::Response, ureq::Error> {
    req.set("Content-Type", "application/json").send_string(&v.to_string())
}

fn status_error(code: u16, resp: ureq::Response) -> String {
    let msg = json_of::<serde_json::Value>(resp).ok().and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
    match (code, msg) {
        (401, _) => "Oturum sona erdi; tekrar giriş yapın.".into(),
        (_, Some(m)) => m,
        (c, None) => format!("Sunucu hatası ({c})."),
    }
}

impl Remote {
    pub fn new(server_url: &str, token: &str) -> Remote {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .user_agent("finans")
            .build();
        Remote { base: server_url.trim_end_matches('/').to_string(), token: token.to_string(), agent }
    }

    fn req(&self, method: &str, path: &str) -> ureq::Request {
        self.agent.request(method, &format!("{}{path}", self.base)).set("Authorization", &format!("Bearer {}", self.token))
    }

    fn call(r: Result<ureq::Response, ureq::Error>) -> CoreResult<ureq::Response> {
        match r {
            Ok(resp) => Ok(resp),
            Err(ureq::Error::Status(code, resp)) => Err(status_error(code, resp)),
            Err(ureq::Error::Transport(t)) => Err(format!("Sunucuya ulaşılamıyor: {t}")),
        }
    }

    fn bytes(resp: ureq::Response, limit: u64) -> CoreResult<Vec<u8>> {
        let mut out = Vec::new();
        resp.into_reader().take(limit + 1).read_to_end(&mut out).map_err(|e| format!("Sunucudan okunamadı: {e}"))?;
        if out.len() as u64 > limit {
            return Err("Sunucudaki eşitleme verisi çok büyük.".into());
        }
        Ok(out)
    }

    pub fn meta(&self) -> CoreResult<Meta> {
        json_of(Self::call(self.req("GET", "/api/sync").call())?)
    }

    /// Anahtarlık: ilk kurulum ya da parola değişimi (aynı anahtar). Başka anahtar ancak sunucudaki veri silinince.
    pub fn put_keyring(&self, keyring: &Keyring) -> CoreResult<()> {
        Self::call(send_json(self.req("PUT", "/api/sync/keyring"), json!({ "keyring": keyring })))?;
        Ok(())
    }

    /// (sürüm, şifreli veri); sunucuda veri yoksa None
    pub fn get_data(&self) -> CoreResult<Option<(i64, Vec<u8>)>> {
        match self.req("GET", "/api/sync/data").call() {
            Err(ureq::Error::Status(404, _)) => Ok(None),
            r => {
                let resp = Self::call(r)?;
                let v = resp.header("x-sync-version").and_then(|v| v.parse().ok()).ok_or("Sunucu yanıtı okunamadı.")?;
                Ok(Some((v, Self::bytes(resp, MAX_DATA)?)))
            }
        }
    }

    pub fn put_data(&self, key_id: &str, base: i64, blob: &[u8]) -> CoreResult<Put> {
        let r = self
            .req("PUT", "/api/sync/data")
            .set("x-sync-key", key_id)
            .set("x-sync-base", &base.to_string())
            .set("Content-Type", "application/octet-stream")
            .send_bytes(blob);
        match r {
            Err(ureq::Error::Status(409, resp)) => {
                // Sürüm çakışması yeniden denenir; anahtar değişmişse hata
                let v: serde_json::Value = json_of(resp).unwrap_or_default();
                if v.get("code").and_then(|c| c.as_str()) == Some("conflict") {
                    Ok(Put::Conflict)
                } else {
                    Err(v.get("error").and_then(|e| e.as_str()).unwrap_or("Eşitleme anahtarı değişmiş.").to_string())
                }
            }
            r => {
                let v: serde_json::Value = json_of(Self::call(r)?)?;
                v.get("version").and_then(|v| v.as_i64()).map(Put::Ok).ok_or_else(|| "Sunucu yanıtı okunamadı.".into())
            }
        }
    }

    pub fn list_files(&self) -> CoreResult<Vec<RemoteFile>> {
        #[derive(Deserialize)]
        struct L {
            files: Vec<RemoteFile>,
        }
        let l: L = json_of(Self::call(self.req("GET", "/api/sync/files").call())?)?;
        Ok(l.files)
    }

    pub fn put_file(&self, key_id: &str, id: &str, blob: &[u8]) -> CoreResult<()> {
        Self::call(
            self.req("PUT", &format!("/api/sync/files/{id}"))
                .set("x-sync-key", key_id)
                .set("Content-Type", "application/octet-stream")
                .send_bytes(blob),
        )?;
        Ok(())
    }

    /// Sunucuda yoksa None
    pub fn get_file(&self, id: &str) -> CoreResult<Option<Vec<u8>>> {
        match self.req("GET", &format!("/api/sync/files/{id}")).call() {
            Err(ureq::Error::Status(404, _)) => Ok(None),
            r => Ok(Some(Self::bytes(Self::call(r)?, MAX_FILE)?)),
        }
    }

    pub fn delete_file(&self, id: &str) -> CoreResult<()> {
        match self.req("DELETE", &format!("/api/sync/files/{id}")).call() {
            Err(ureq::Error::Status(404, _)) => Ok(()),
            r => Self::call(r).map(|_| ()),
        }
    }

    /// Sunucudaki bütün eşitleme verisi silinir (şifre gerekir).
    pub fn delete_all(&self, password: &str) -> CoreResult<()> {
        Self::call(send_json(self.req("DELETE", "/api/sync"), json!({ "password": password })))?;
        Ok(())
    }
}
