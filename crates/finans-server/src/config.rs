use std::path::PathBuf;

/// Masaüstü/mobil uygulamaların webview kökenleri (Bearer token kullanırlar; çerez gönderilmez).
const TAURI_ORIGINS: &[&str] = &["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

/// İstemci IP'si nereden alınır.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProxyMode {
    /// Doğrudan bağlantı: soket adresi
    None,
    /// Cloudflare (Tunnel dahil): Cloudflare'in her istekte üzerine yazdığı `CF-Connecting-IP` (istemci değiştiremez)
    Cloudflare,
    /// Kendi reverse proxy'n (Caddy/nginx): `X-Forwarded-For`'un son değeri (proxy'nin eklediği)
    ForwardedFor,
}

/// Sunucu ayarları (ortam değişkenlerinden).
#[derive(Debug, Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    pub port: u16,
    pub registration_open: bool,
    /// CORS izinli kökenler; varsayılan masaüstü/mobil uygulamalar, "none" ile kapatılır
    pub allowed_origins: Vec<String>,
    /// Oturum çerezine `Secure` eklenir (HTTPS arkasında); yerel HTTP denemesi için false
    pub secure_cookie: bool,
    /// İstemci IP'sinin kaynağı (deneme sınırları için)
    pub proxy: ProxyMode,
    /// En fazla hesap sayısı (0 = sınırsız)
    pub max_users: u64,
    /// Derlenmiş web arayüzü (`npm run build:web` çıktısı); yoksa yalnız API sunulur
    pub web_dir: Option<PathBuf>,
    /// Varsa Postgres modu
    pub database_url: Option<String>,
    /// Postgres bağlantı havuzu boyutu
    pub db_pool: u32,
    /// TCMB EVDS API anahtarı (TÜFE); yoksa enflasyon karşılaştırması yapılmaz
    pub evds_key: Option<String>,
    /// Kullanıcı başına belge (fiş, fatura) kotası, MB; 0 sınırsız
    pub attachment_quota_mb: u64,
}

impl Config {
    pub fn from_env() -> Self {
        let var = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        Config {
            data_dir: PathBuf::from(var("FINANS_DATA_DIR").unwrap_or_else(|| "./data".into())),
            port: var("PORT").and_then(|p| p.parse().ok()).unwrap_or(8080),
            registration_open: var("FINANS_REGISTRATION").is_none_or(|v| v != "closed"),
            allowed_origins: match var("FINANS_ALLOWED_ORIGINS").as_deref() {
                Some("none") => Vec::new(),
                Some(v) => v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
                None => TAURI_ORIGINS.iter().map(|s| s.to_string()).collect(),
            },
            secure_cookie: var("FINANS_SECURE_COOKIE").is_none_or(|v| v != "false"),
            proxy: match var("FINANS_TRUST_PROXY").as_deref() {
                Some("cloudflare") => ProxyMode::Cloudflare,
                Some("true") | Some("xff") => ProxyMode::ForwardedFor,
                _ => ProxyMode::None,
            },
            max_users: var("FINANS_MAX_USERS").and_then(|v| v.parse().ok()).unwrap_or(0),
            web_dir: var("FINANS_WEB_DIR").map(PathBuf::from).filter(|p| p.join("index.html").is_file()),
            database_url: var("FINANS_DATABASE_URL"),
            db_pool: var("FINANS_DB_POOL").and_then(|v| v.parse().ok()).filter(|n| *n > 0).unwrap_or(8),
            evds_key: var("FINANS_EVDS_KEY"),
            attachment_quota_mb: var("FINANS_ATTACHMENT_QUOTA_MB").and_then(|v| v.parse().ok()).unwrap_or(1024),
        }
    }
}
