mod app;
mod auth;
mod config;
mod routes_auth;
mod routes_data;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::http::{header, HeaderValue, StatusCode};
use axum::routing::{any, get};
use axum::{Json, Router};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::app::AppState;
use crate::config::Config;

#[tokio::main]
async fn main() {
    let config = Config::from_env();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("serve") => serve(config).await,
        // Ekstre ayrıştırma alt süreci (sunucu kendini çağırır): kötü niyetli dosya belleği/işlemciyi tüketse bile
        // yalnız bu süreç ölür. Girdi stdin, çıktı stdout'ta JSON.
        Some("parse-statement") => parse_statement_child(args.get(1).map(String::as_str).unwrap_or("")),
        // Docker HEALTHCHECK: sunucu portu bağlantı kabul ediyorsa 0 (imaja curl girmesin)
        Some("health") => {
            let ok = std::net::TcpStream::connect_timeout(
                &SocketAddr::from(([127, 0, 0, 1], config.port)),
                std::time::Duration::from_secs(2),
            )
            .is_ok();
            std::process::exit(if ok { 0 } else { 1 });
        }
        Some("users") => {
            let conn = open_auth(&config);
            auth::cli_users(&conn).expect("kullanıcılar okunamadı");
        }
        Some("reset-password") => {
            let Some(email) = args.get(1) else {
                eprintln!("Kullanım: finans-server reset-password <eposta>");
                std::process::exit(2);
            };
            let conn = open_auth(&config);
            if !auth::cli_reset_password(&conn, email).expect("şifre sıfırlanamadı") {
                eprintln!("Kullanıcı bulunamadı: {email}");
                std::process::exit(1);
            }
        }
        Some(other) => {
            eprintln!("Bilinmeyen komut: {other}\nKullanım: finans-server [serve | users | reset-password <eposta> | health]");
            std::process::exit(2);
        }
    }
}

/// Alt süreç: 1 GiB bellek ve 30 sn işlemci sınırıyla ekstreyi ayrıştırır.
fn parse_statement_child(name: &str) -> ! {
    use std::io::{Read, Write};
    #[cfg(unix)]
    unsafe {
        let mem = libc::rlimit { rlim_cur: 1 << 30, rlim_max: 1 << 30 };
        libc::setrlimit(libc::RLIMIT_AS, &mem);
        let cpu = libc::rlimit { rlim_cur: 30, rlim_max: 30 };
        libc::setrlimit(libc::RLIMIT_CPU, &cpu);
    }
    let mut bytes = Vec::new();
    let result = std::io::stdin()
        .take(25 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())
        .and_then(|_| finans_core::statement::parse(name, &bytes));
    let out = match result {
        Ok(file) => serde_json::json!({ "ok": true, "file": file }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    let mut stdout = std::io::stdout();
    let _ = serde_json::to_writer(&mut stdout, &out);
    let _ = stdout.flush();
    std::process::exit(0);
}

fn open_auth(config: &Config) -> rusqlite::Connection {
    std::fs::create_dir_all(&config.data_dir).expect("veri klasörü oluşturulamadı");
    auth::open(&config.data_dir.join("auth.db")).expect("auth.db açılamadı")
}

async fn serve(config: Config) {
    std::fs::create_dir_all(config.data_dir.join("users")).expect("veri klasörü oluşturulamadı");
    let port = config.port;
    let cors = cors_layer(&config);
    // Olmayan e-postayla girişte kullanılan sabit hash önceden üretilir (ilk deneme daha uzun sürüp hesap varlığını ele vermesin)
    tokio::task::spawn_blocking(|| auth::dummy_verify("")).await.expect("argon2 hazırlanamadı");
    let auth_db = open_auth(&config);
    match auth::sweep_sessions(&auth_db) {
        Ok(n) if n > 0 => println!("{n} süresi dolmuş oturum silindi"),
        Err(e) => eprintln!("oturum temizliği yapılamadı: {e}"),
        _ => {}
    }
    let state = Arc::new(AppState { config, auth: Mutex::new(auth_db), limiter: Default::default(), user_dbs: Default::default(), open_lock: Default::default(), hash_permits: tokio::sync::Semaphore::new(4), parse_permits: tokio::sync::Semaphore::new(2) });
    let web_dir = state.config.web_dir.clone();
    let not_found = || async { app::ApiError::new(StatusCode::NOT_FOUND, "Bulunamadı.") };
    let router = Router::new()
        .merge(routes_auth::router())
        .merge(routes_data::router())
        .route(
            "/api/health",
            get(|| async { Json(serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") })) }),
        )
        // Bilinmeyen API yolları web arayüzüne düşmesin
        .route("/api/{*rest}", any(not_found));
    let router = match &web_dir {
        // Web arayüzü: dosya yoksa index.html (tek sayfalık uygulama)
        Some(dir) => router.fallback_service(ServeDir::new(dir).not_found_service(ServeFile::new(dir.join("index.html")))),
        None => router.fallback(not_found),
    };
    let app = router
        .with_state(state)
        .layer(axum::middleware::from_fn(cache_headers))
        .layer(axum::middleware::from_fn(same_origin_guard))
        .layer(SetResponseHeaderLayer::if_not_present(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP)))
        .layer(SetResponseHeaderLayer::if_not_present(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::if_not_present(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")));
    let app = match cors {
        Some(cors) => app.layer(cors),
        None => app,
    };
    match &web_dir {
        Some(dir) => println!("web arayüzü: {}", dir.display()),
        None => println!("web arayüzü yok (FINANS_WEB_DIR ayarlanmadı); yalnız API"),
    }
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("port açılamadı");
    println!("finans-server {} dinliyor: http://{addr}", env!("CARGO_PKG_VERSION"));
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("sunucu hatası");
}

/// Çerezle (web) gelen veri değiştiren isteklerde `Origin` aynı site olmalı (CSRF). JSON gövdeli uç noktalar zaten
/// çapraz siteden gönderilemez; bu kontrol gövdesiz ya da ham gövdeli olanları (çıkış, ekstre okuma) da kapsar.
/// Bearer token'lı istemciler (masaüstü/mobil) çerez kullanmadığı için etkilenmez.
async fn same_origin_guard(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::Method;
    use axum::response::IntoResponse;
    let h = req.headers();
    let unsafe_method = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let cookie_auth = h.get(header::AUTHORIZATION).is_none()
        && h.get_all(header::COOKIE).iter().any(|v| v.to_str().is_ok_and(|v| v.contains(app::COOKIE)));
    if unsafe_method && cookie_auth && req.uri().path().starts_with("/api/") {
        // Yalnız gerçek Host başlığı (Cloudflare/cloudflared ve Caddy korur); istemcinin yazabildiği X-Forwarded-Host kullanılmaz
        let host = h.get(header::HOST).and_then(|v| v.to_str().ok()).map(str::to_ascii_lowercase);
        let origin = h
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .and_then(|o| o.split_once("://").map(|(_, rest)| rest.to_ascii_lowercase()));
        if origin.is_none() || origin != host {
            return app::ApiError::new(StatusCode::FORBIDDEN, "Geçersiz istek kaynağı.").into_response();
        }
    }
    next.run(req).await
}

/// Önbellek: adı içerik hash'i taşıyan `/assets/*` uzun süre; `index.html` ve diğerleri her açılışta doğrulanır
/// (güncellemeden sonra eski index.html artık olmayan dosyaları istemesin); API yanıtları hiç saklanmaz.
async fn cache_headers(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    let path = req.uri().path().to_owned();
    let mut res = next.run(req).await;
    let value = if path.starts_with("/api/") {
        "no-store"
    } else if path.starts_with("/assets/") && res.status().is_success() {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    res
}

/// Web arayüzü yalnız kendi kökeninden script/istek yükler; başka sitelerde çerçeve içine alınamaz.
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; \
                   font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/// Tauri webview kökenleri için CORS; çerez gönderilmez (istemciler Bearer token kullanır).
fn cors_layer(config: &Config) -> Option<tower_http::cors::CorsLayer> {
    use axum::http::{header, HeaderValue, Method};
    if config.allowed_origins.is_empty() {
        return None;
    }
    let origins: Vec<HeaderValue> = config.allowed_origins.iter().filter_map(|o| o.parse().ok()).collect();
    Some(
        tower_http::cors::CorsLayer::new()
            .allow_origin(origins)
            .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
            .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
    )
}

/// Ctrl+C veya SIGTERM (docker stop) ile düzgün kapanır.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}
