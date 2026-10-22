mod app;
mod auth;
mod auth_sqlite;
mod auth_store;
mod config;
mod data;
mod pg;
mod cpi;
mod rates;
mod routes_accounts_report;
mod routes_budget_report;
mod routes_cashplan;
mod routes_debt;
mod routes_analysis;
mod routes_forms;
mod routes_import;
mod routes_overview;
mod routes_auth;
mod routes_backup;
mod routes_data;
mod routes_goals;
mod routes_networth;
mod routes_projection;
mod routes_reports;
mod routes_attachments;
mod routes_pnl;
mod routes_rates;
mod routes_tags;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::http::{header, HeaderValue, StatusCode};
use axum::routing::{any, get};
use axum::{Json, Router};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::app::AppState;
use crate::auth_sqlite::SqliteAuthStore;
use crate::auth_store::AuthStore;
use crate::config::Config;
use crate::data::{DataBackend, SqliteData};

#[tokio::main]
async fn main() {
    let config = Config::from_env();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("serve") => serve(config).await,
        // Ekstre ayrıştırma alt süreci (sunucu kendini çağırır): kötü niyetli dosya belleği/işlemciyi tüketse bile
        // yalnız bu süreç ölür. Girdi stdin, çıktı stdout'ta JSON.
        Some("parse-statement") => parse_statement_child(args.get(1).map(String::as_str).unwrap_or("")),
        // Fiş/fatura PDF'inden tutar ve tarih önerisi: aynı sınırlı alt süreç
        Some("parse-receipt") => parse_receipt_child(),
        // Docker HEALTHCHECK: /api/health 200 dönerse 0 (imaja curl girmesin)
        Some("health") => {
            use std::io::{Read, Write};
            let ok = (|| -> std::io::Result<bool> {
                let mut s = std::net::TcpStream::connect_timeout(
                    &SocketAddr::from(([127, 0, 0, 1], config.port)),
                    std::time::Duration::from_secs(2),
                )?;
                s.set_read_timeout(Some(std::time::Duration::from_secs(3)))?;
                s.write_all(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")?;
                let mut buf = [0u8; 16];
                let n = s.read(&mut buf)?;
                Ok(buf[..n].starts_with(b"HTTP/1.1 200") || buf[..n].starts_with(b"HTTP/1.0 200"))
            })()
            .unwrap_or(false);
            std::process::exit(if ok { 0 } else { 1 });
        }
        Some("users") => {
            let (auth, data) = stores(&config).await;
            // Postgres istemcisi async bağlamda düşürülemez: depolar iş parçacığında kullanılıp orada bırakılır
            tokio::task::spawn_blocking(move || {
                auth::cli_users(&*auth).expect("kullanıcılar okunamadı");
                drop((auth, data));
            })
            .await
            .unwrap();
            std::process::exit(0);
        }
        Some("reset-password") => {
            let Some(email) = args.get(1).cloned() else {
                eprintln!("Kullanım: finans-server reset-password <eposta>");
                std::process::exit(2);
            };
            let (auth, data) = stores(&config).await;
            let found = tokio::task::spawn_blocking(move || {
                let found = auth::cli_reset_password(&*auth, &email).expect("şifre sıfırlanamadı");
                drop((auth, data));
                found
            })
            .await
            .unwrap();
            if !found {
                eprintln!("Kullanıcı bulunamadı");
            }
            std::process::exit(if found { 0 } else { 1 });
        }
        Some(other) => {
            eprintln!("Bilinmeyen komut: {other}\nKullanım: finans-server [serve | users | reset-password <eposta> | health]");
            std::process::exit(2);
        }
    }
}

/// Alt süreç: 1 GiB bellek ve 30 sn işlemci sınırıyla fiş/fatura PDF'inden tutar ve tarih önerisi çıkarır.
fn parse_receipt_child() -> ! {
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
        .take(finans_core::store::ATTACHMENT_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())
        .and_then(|_| finans_core::receipt::parse_pdf(&bytes));
    let out = match result {
        Ok(hint) => serde_json::json!({ "ok": true, "hint": hint }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    let mut stdout = std::io::stdout();
    let _ = serde_json::to_writer(&mut stdout, &out);
    let _ = stdout.flush();
    std::process::exit(0);
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
        .and_then(|_| finans_core::statement::parse(name, &bytes))
        // Tablo, özet ve sütun tahmini de bu sınırlı alt süreçte (güvenilmeyen dosya metni üzerinde düzenli ifadeler)
        .and_then(|file| finans_core::import::read_statement(&file));
    let out = match result {
        Ok(file) => serde_json::json!({ "ok": true, "file": file }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    let mut stdout = std::io::stdout();
    let _ = serde_json::to_writer(&mut stdout, &out);
    let _ = stdout.flush();
    std::process::exit(0);
}

/// Hesap deposu ve veri arka ucu. Postgres istemcisi async bağlamda kullanılamadığı için `spawn_blocking` içinde çağrılır.
fn open_stores(config: &Config) -> Result<(Box<dyn AuthStore>, DataBackend), String> {
    if let Some(url) = &config.database_url {
        let pool = pg::connect(url, config.db_pool)?;
        pg::migrate(&pool)?;
        println!("veritabanı: Postgres");
        // SQLite'tan Postgres'e geçen kurulumda eski veri kendiliğinden taşınmaz: fark edilmeden "kaybolmuş" görünmesin
        if config.data_dir.join("auth.db").exists() {
            eprintln!(
                "UYARI: {} içinde SQLite verisi (auth.db, users/) var ama Postgres modunda KULLANILMIYOR. \
                 O veriyle devam etmek için FINANS_DATABASE_URL'i kaldırın; taşımak için kullanıcılar uygulamadan JSON yedek alıp \
                 yeni hesaplarına geri yükleyebilir.",
                config.data_dir.display()
            );
        }
        return Ok((Box::new(pg::PgAuthStore::new(pool.clone())), DataBackend::Postgres(pg::PgData::new(pool))));
    }
    std::fs::create_dir_all(config.data_dir.join("users")).map_err(|e| format!("veri klasörü oluşturulamadı: {e}"))?;
    let auth = SqliteAuthStore::open(&config.data_dir.join("auth.db")).map_err(|e| format!("auth.db açılamadı: {e}"))?;
    println!("veritabanı: SQLite ({})", config.data_dir.display());
    Ok((Box::new(auth), DataBackend::Sqlite(SqliteData::new(config.data_dir.join("users")))))
}

async fn stores(config: &Config) -> (Box<dyn AuthStore>, DataBackend) {
    let c = config.clone();
    match tokio::task::spawn_blocking(move || open_stores(&c)).await.expect("depo açılamadı") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

async fn serve(config: Config) {
    let port = config.port;
    let cors = cors_layer(&config);
    // Olmayan e-postayla girişte kullanılan sabit hash önceden üretilir (ilk deneme daha uzun sürüp hesap varlığını ele vermesin)
    tokio::task::spawn_blocking(|| auth::dummy_verify("")).await.expect("argon2 hazırlanamadı");
    if std::env::var_os("FINANS_USER_QUOTA_MB").is_some() {
        eprintln!("uyarı: FINANS_USER_QUOTA_MB artık kullanılmıyor (kullanıcı kotası kaldırıldı); yok sayıldı");
    }
    let (auth_store, data) = stores(&config).await;
    let st = tokio::task::spawn_blocking(move || {
        match auth::sweep_sessions(&*auth_store) {
            Ok(n) if n > 0 => println!("{n} süresi dolmuş oturum silindi"),
            Err(e) => eprintln!("oturum temizliği yapılamadı: {e}"),
            _ => {}
        }
        auth_store
    })
    .await
    .expect("oturum temizliği");
    let rates = match &data {
        DataBackend::Postgres(d) => rates::RateService::Stored(rates::StoredRates::new(d.pool())),
        DataBackend::Sqlite(_) => rates::RateService::Live(finans_core::fx::live::LiveRates::new()),
    };
    let cpi = match &data {
        DataBackend::Postgres(d) => cpi::CpiService::Stored(cpi::StoredCpi::new(d.pool(), config.evds_key.clone())),
        DataBackend::Sqlite(_) => cpi::CpiService::Live { live: Default::default(), key: config.evds_key.clone() },
    };
    let state = Arc::new(AppState {
        config,
        auth: st,
        data,
        rates,
        cpi,
        limiter: Default::default(),
        hash_permits: tokio::sync::Semaphore::new(4),
        parse_permits: tokio::sync::Semaphore::new(2),
    });
    let web_dir = state.config.web_dir.clone();
    let not_found = || async { app::ApiError::new(StatusCode::NOT_FOUND, "Bulunamadı.") };
    let router = Router::new()
        .merge(routes_auth::router())
        .merge(routes_backup::router())
        .merge(routes_data::router())
        .merge(routes_rates::router())
        .merge(routes_pnl::router())
        .merge(routes_accounts_report::router())
        .merge(routes_budget_report::router())
        .merge(routes_cashplan::router())
        .merge(routes_debt::router())
        .merge(routes_analysis::router())
        .merge(routes_forms::router())
        .merge(routes_import::router())
        .merge(routes_overview::router())
        .merge(routes_networth::router())
        .merge(routes_projection::router())
        .merge(routes_reports::router())
        .merge(routes_attachments::router())
        .merge(routes_goals::router())
        .merge(routes_tags::router())
        .route("/api/health", get(health))
        // Bilinmeyen API yolları web arayüzüne düşmesin
        .route("/api/{*rest}", any(not_found));
    let router = match &web_dir {
        // Web arayüzü: dosya yoksa index.html (tek sayfalık uygulama)
        Some(dir) => router.fallback_service(ServeDir::new(dir).not_found_service(ServeFile::new(dir.join("index.html")))),
        None => router.fallback(not_found),
    };
    let app = router
        .with_state(state.clone())
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
    if matches!(state.rates, rates::RateService::Stored(_)) {
        let st = state.clone();
        tokio::spawn(async move {
            loop {
                let s = st.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    s.rates.tick();
                    s.cpi.tick();
                })
                .await;
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            }
        });
        println!("kurlar: Postgres'te toplanıyor (Harem 15 dk, TCMB günlük, TEFAS izlenen fonlar günlük)");
    } else {
        println!("kurlar: saklanmıyor (SQLite modu; istekte canlı çekilir)");
    }
    println!("tüfe: {}", if state.config.evds_key.is_some() { "EVDS anahtarı tanımlı" } else { "FINANS_EVDS_KEY yok; enflasyon karşılaştırması kapalı" });
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("port açılamadı");
    println!("finans-server {} dinliyor: http://{addr}", env!("CARGO_PKG_VERSION"));
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("sunucu hatası");
    // Postgres istemcileri async bağlamda düşürülemez: yönlendirici kapanırken son referans `state`'te kalır
    // ve süreç onu düşürmeden biter (havuz kapanırken çökmesin)
    let _keep = state;
    std::process::exit(0);
}

/// Sağlık: hesap deposu ve veri arka ucu yanıt veriyorsa 200, yoksa 503.
async fn health(axum::extract::State(s): axum::extract::State<Arc<AppState>>) -> (StatusCode, Json<serde_json::Value>) {
    let ok = tokio::task::spawn_blocking(move || s.auth.ping().is_ok() && s.data.ping().is_ok()).await.unwrap_or(false);
    let status = if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (status, Json(serde_json::json!({ "ok": ok, "version": env!("CARGO_PKG_VERSION") })))
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

/// Web arayüzü yalnız kendi kökeninden script/istek yükler; başka sitelerde çerçeve içine alınamaz. `blob:` belge
/// önizlemesi için (içerik sunucuda türü doğrulanmış ek).
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src blob:; object-src 'self' blob:; \
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
