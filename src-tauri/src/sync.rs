//! Uçtan uca şifreli eşitleme komutları (finans-core/sync; burada yalnız yapılandırma + çağrı).
//! Yalnız "Bu cihazda" veri yerinde ve oturum açıkken kullanılır. Ağ işi arka planda (arayüz donmasın).

use finans_core::sync::engine::{self, Ctx, Report, Status};
use finans_core::sync::remote::Remote;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::commands::{read_config, AppState, CmdResult};

struct Conf {
    dir: std::path::PathBuf,
    db_path: String,
    user_id: String,
    server_url: String,
    token: String,
}

fn conf(app: &AppHandle) -> CmdResult<Conf> {
    let state = app.state::<AppState>();
    let c = read_config(&state.config_path).client;
    if c.mode.as_deref() != Some("local") {
        return Err("Şifreli eşitleme yalnız veri bu cihazdayken kullanılabilir.".into());
    }
    let (Some(server_url), Some(token), Some(user_id)) = (c.server_url, c.token, c.user_id) else {
        return Err("Şifreli eşitleme için hesaba giriş yapın.".into());
    };
    let db_path = state.db_path.lock().map(|p| p.clone()).unwrap_or_else(|_| state.default_db_path.clone());
    let dir = state.config_path.parent().map(|p| p.to_path_buf()).ok_or("Uygulama klasörü bulunamadı.")?;
    Ok(Conf { dir, db_path: db_path.display().to_string(), user_id, server_url, token })
}

/// `f`'i arka planda çalıştırır; `exclusive` ise eşitleme kilidiyle (aynı anda tek tur, bu sırada veritabanı değiştirilemez).
/// Yapılandırma kilit alındıktan sonra okunur: beklerken veritabanı dosyası değişmiş olabilir.
async fn run_ctx<T: Send + 'static>(app: AppHandle, exclusive: bool, f: impl FnOnce(&Ctx) -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _guard = exclusive.then(|| state.sync_lock.lock().unwrap_or_else(|e| e.into_inner()));
        let c = conf(&app)?;
        let ctx = Ctx {
            conn: &state.conn,
            dir: &c.dir,
            db_path: &c.db_path,
            user_id: &c.user_id,
            server_url: &c.server_url,
            token: &c.token,
        };
        f(&ctx)
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn with_ctx<T: Send + 'static>(app: AppHandle, f: impl FnOnce(&Ctx) -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    run_ctx(app, true, f).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    /// Bu cihazda kullanılabilir mi (yerel veri + oturum); değilse nedeni
    unavailable: Option<String>,
    #[serde(flatten)]
    status: Option<Status>,
}

/// Yalnız yerel bilgi (ağ yok)
#[tauri::command]
pub async fn sync_status(app: AppHandle) -> CmdResult<SyncInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(match conf(&app) {
            Err(e) => SyncInfo { unavailable: Some(e), status: None },
            Ok(c) => {
                let state = app.state::<AppState>();
                let ctx = Ctx { conn: &state.conn, dir: &c.dir, db_path: &c.db_path, user_id: &c.user_id, server_url: &c.server_url, token: &c.token };
                SyncInfo { unavailable: None, status: Some(engine::status(&ctx)) }
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    /// Hesapta eşitleme açık mı (sunucuda anahtarlık var)
    enabled: bool,
    updated_at: Option<i64>,
    bytes: i64,
}

#[tauri::command]
pub async fn sync_remote(app: AppHandle) -> CmdResult<RemoteInfo> {
    // Yalnız okuma: süren turu beklemez
    run_ctx(app, false, |ctx| {
        let m = Remote::new(ctx.server_url, ctx.token).meta()?;
        Ok(RemoteInfo { enabled: m.keyring.is_some(), updated_at: m.updated_at, bytes: m.data_bytes + m.files_bytes })
    })
    .await
}

#[tauri::command]
pub async fn sync_enable(app: AppHandle, passphrase: String) -> CmdResult<Report> {
    with_ctx(app, move |ctx| engine::enable(ctx, &passphrase)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkResult {
    report: Report,
    /// "İndir" seçildiyse önce alınan yerel yedek
    backup_path: Option<String>,
}

/// `replace`: bu cihazın verisi sunucudakiyle değiştirilir (önce yerel yedek alınır)
#[tauri::command]
pub async fn sync_link(app: AppHandle, passphrase: String, replace: bool) -> CmdResult<LinkResult> {
    let a = app.clone();
    with_ctx(app, move |ctx| {
        let mut backup_path = None;
        let report = engine::link(ctx, &passphrase, replace, || {
            if replace {
                backup_path = Some(crate::commands::backup_database(a.state::<AppState>())?);
            }
            Ok(())
        })?;
        Ok(LinkResult { report, backup_path })
    })
    .await
}

#[tauri::command]
pub async fn sync_run(app: AppHandle) -> CmdResult<Report> {
    with_ctx(app, engine::run).await
}

#[tauri::command]
pub async fn sync_change_passphrase(app: AppHandle, passphrase: String) -> CmdResult<()> {
    with_ctx(app, move |ctx| engine::change_passphrase(ctx, &passphrase)).await
}

/// Bu cihaz eşitlemeden ayrılır (veri ve sunucu değişmez)
#[tauri::command]
pub async fn sync_unlink(app: AppHandle) -> CmdResult<()> {
    with_ctx(app, |ctx| {
        engine::unlink(ctx.dir);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn sync_delete_remote(app: AppHandle, password: String) -> CmdResult<()> {
    with_ctx(app, move |ctx| engine::delete_remote(ctx, &password)).await
}
