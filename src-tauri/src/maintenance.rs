//! Destek ve bakım: uygulama bilgisi (hata raporu için) ve uygulamayı izsiz kaldırma.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::commands::{AppState, CmdResult};
use finans_core::db;

/// Hata raporuna eklenen teknik bilgiler (finansal veri veya dosya yolu içermez).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    os: String,
    arch: String,
    schema_version: i64,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        schema_version: db::LATEST_VERSION,
    }
}

/// Kaldırmada uygulamanın kendisinin nasıl silineceği.
#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AppRemoval {
    /// macOS: .app paketi silinir
    Bundle,
    /// Windows: kurulumun kendi kaldırıcısı sessizce çalıştırılır
    Uninstaller,
    /// Linux: AppImage dosyası silinir
    AppImage,
    /// Paket yöneticisiyle kurulmuş (deb/rpm/msi): kullanıcı sistemden kaldırmalı
    Manual,
    /// Geliştirme sürümü: program dosyalarına dokunulmaz
    Development,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallPlan {
    /// Silinecek veri klasörleri ve dosyaları (var olanlar)
    data_paths: Vec<String>,
    /// Kullanıcının seçtiği, varsayılan konum dışındaki veritabanı (ve yanındaki otomatik yedekleri)
    custom_database: Vec<String>,
    app_removal: AppRemoval,
    /// Silinecek uygulama dosyası / paketi ya da çalıştırılacak kaldırıcı
    app_path: Option<String>,
}

const IDENTIFIER: &str = "com.ybrzcn.finans";
const BINARY: &str = "finans";

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Uygulamanın kendi oluşturduğu tüm veri, ayar ve önbellek konumları.
fn data_paths(app: &AppHandle) -> Vec<PathBuf> {
    let p = app.path();
    let mut out: Vec<PathBuf> = [p.app_data_dir(), p.app_local_data_dir(), p.app_cache_dir(), p.app_config_dir(), p.app_log_dir()]
        .into_iter()
        .flatten()
        .collect();
    if let Some(h) = home() {
        if cfg!(target_os = "macos") {
            let lib = h.join("Library");
            for name in [IDENTIFIER, BINARY] {
                out.push(lib.join("WebKit").join(name));
                out.push(lib.join("Caches").join(name));
                out.push(lib.join("HTTPStorages").join(name));
            }
            out.push(lib.join("HTTPStorages").join(format!("{IDENTIFIER}.binarycookies")));
            out.push(lib.join("Saved Application State").join(format!("{IDENTIFIER}.savedState")));
            out.push(lib.join("Preferences").join(format!("{IDENTIFIER}.plist")));
        } else if cfg!(target_os = "linux") {
            for name in [IDENTIFIER, BINARY] {
                out.push(h.join(".local/share").join(name));
                out.push(h.join(".cache").join(name));
                out.push(h.join(".config").join(name));
            }
        } else if cfg!(windows) {
            if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
                out.push(local.join(IDENTIFIER));
                out.push(local.join(BINARY));
            }
            if let Some(roaming) = std::env::var_os("APPDATA").map(PathBuf::from) {
                out.push(roaming.join(IDENTIFIER));
            }
        }
    }
    out.sort();
    out.dedup();
    // Birbirinin içindeki yolları tekrar listeleme; yalnız var olanlar
    let existing: Vec<PathBuf> = out.into_iter().filter(|p| p.exists()).collect();
    existing.iter().filter(|p| !existing.iter().any(|q| q != *p && p.starts_with(q))).cloned().collect()
}

/// Varsayılan dışındaki veritabanı ve yanındaki otomatik yedekleri (finans.db.v3.bak, ...).
fn custom_database(state: &AppState, data: &[PathBuf]) -> Vec<PathBuf> {
    let current = state.db_path.lock().map(|p| p.clone()).unwrap_or_default();
    if current == state.default_db_path || data.iter().any(|d| current.starts_with(d)) {
        return vec![];
    }
    let mut out = vec![current.clone()];
    if let (Some(dir), Some(name)) = (current.parent(), current.file_name().and_then(|n| n.to_str())) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let file = e.file_name().to_string_lossy().to_string();
                // Otomatik yedekler ve SQLite yan dosyaları
                if file != name && file.starts_with(name) && (file.ends_with(".bak") || file.ends_with("-journal") || file.ends_with("-wal") || file.ends_with("-shm")) {
                    out.push(e.path());
                }
            }
        }
    }
    out
}

pub(crate) fn app_removal() -> (AppRemoval, Option<PathBuf>) {
    let Ok(exe) = std::env::current_exe() else { return (AppRemoval::Manual, None) };
    let s = exe.to_string_lossy();
    if s.contains("/target/") || s.contains("\\target\\") {
        return (AppRemoval::Development, None);
    }
    if cfg!(target_os = "macos") {
        if let Some(bundle) = exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")) {
            return (AppRemoval::Bundle, Some(bundle.to_path_buf()));
        }
    } else if cfg!(windows) {
        if let Some(dir) = exe.parent() {
            let uninstaller = dir.join("uninstall.exe");
            if uninstaller.exists() {
                return (AppRemoval::Uninstaller, Some(uninstaller));
            }
        }
    } else if let Some(appimage) = std::env::var_os("APPIMAGE").map(PathBuf::from) {
        return (AppRemoval::AppImage, Some(appimage));
    }
    (AppRemoval::Manual, None)
}

/// Kaldırmada nelerin silineceği (onay ekranında gösterilir).
#[tauri::command]
pub fn uninstall_plan(app: AppHandle, state: State<'_, AppState>) -> UninstallPlan {
    let data = data_paths(&app);
    let custom = custom_database(&state, &data);
    let (removal, path) = app_removal();
    let show = |v: &[PathBuf]| v.iter().map(|p| p.display().to_string()).collect();
    UninstallPlan {
        data_paths: show(&data),
        custom_database: show(&custom),
        app_removal: removal,
        app_path: path.map(|p| p.display().to_string()),
    }
}

#[cfg(unix)]
fn quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\'', "'\\''"))
}

/// Uygulamayı kapatır; kapandıktan sonra çalışan bir betik veri klasörlerini, (istenirse) seçili veritabanını ve
/// uygulamanın kendisini siler. Açıkken silinemeyen dosyalar (WebView verisi, açık veritabanı) bu yüzden sonradan silinir.
/// İşletim sisteminin kendi onay penceresi istenir: arayüzde çalışan kod (ör. ileride bir açık) kullanıcıya sormadan
/// uygulamayı silemesin. Pencere ana iş parçacığını bekletmesin diye komut async çalışır.
#[tauri::command(async)]
pub fn uninstall_app(app: AppHandle, state: State<'_, AppState>, include_custom_database: bool) -> CmdResult<()> {
    #[cfg(desktop)]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let confirmed = app
            .dialog()
            .message("Finans ve bu bilgisayardaki tüm verisi kalıcı olarak silinecek. Devam edilsin mi?")
            .title("Finans'ı kaldır")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Kaldır".into(), "Vazgeç".into()))
            .blocking_show();
        if !confirmed {
            return Err("Kaldırma iptal edildi.".into());
        }
    }
    // Mobilde uygulama ve verisi işletim sistemi tarafından kaldırılır
    #[cfg(mobile)]
    {
        let _ = (app, state, include_custom_database);
        return Err("Mobilde uygulamayı telefonun ayarlarından kaldırın.".into());
    }
    let (removal, app_path) = app_removal();
    // Geliştirme sürümü gerçek veritabanını kullanır: yanlışlıkla silinmesin diye kaldırma yalnız dağıtım sürümünde çalışır
    if removal == AppRemoval::Development {
        return Err("Geliştirme sürümünde kaldırma devre dışı (verilerin korunur). Dağıtım sürümünde çalışır.".into());
    }
    let data = data_paths(&app);
    let mut targets = data.clone();
    if include_custom_database {
        targets.extend(custom_database(&state, &data));
    }
    let pid = std::process::id();
    let script_dir = std::env::temp_dir();

    #[cfg(unix)]
    {
        let mut lines = vec![
            "#!/bin/sh".to_string(),
            // Uygulama tamamen kapanana kadar bekle
            format!("while kill -0 {pid} 2>/dev/null; do sleep 0.3; done"),
            "sleep 0.5".to_string(),
        ];
        for t in &targets {
            lines.push(format!("rm -rf {}", quote(t)));
        }
        if matches!(removal, AppRemoval::Bundle | AppRemoval::AppImage) {
            if let Some(p) = &app_path {
                lines.push(format!("rm -rf {}", quote(p)));
            }
        }
        lines.push("rm -f \"$0\"".into());
        // Ortak geçici klasörde (Linux /tmp) başka bir kullanıcı aynı adda dosyayı önceden oluşturup betiği
        // değiştiremesin: tahmin edilmesi zor ad, yalnız yeni dosya (O_EXCL) ve yalnız sahibine açık izin (0700)
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let script = script_dir.join(format!("finans-kaldir-{pid}-{nonce}.sh"));
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o700)
                .open(&script)
                .map_err(|e| format!("Kaldırma hazırlanamadı: {e}"))?;
            f.write_all(lines.join("\n").as_bytes()).map_err(|e| format!("Kaldırma hazırlanamadı: {e}"))?;
        }
        std::process::Command::new("/bin/sh")
            .arg(&script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Kaldırma başlatılamadı: {e}"))?;
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut lines = vec![
            "@echo off".to_string(),
            // Uygulama kapanana kadar bekle
            format!(":bekle\r\ntasklist /FI \"PID eq {pid}\" | find \"{pid}\" >nul && (timeout /t 1 /nobreak >nul & goto bekle)"),
        ];
        // Toplu dosyada % ortam değişkeni olarak genişler: yoldaki % karakterleri %% yazılır
        let esc = |p: &Path| p.display().to_string().replace('%', "%%");
        for t in &targets {
            let p = esc(t);
            lines.push(format!("if exist \"{p}\\*\" (rmdir /s /q \"{p}\") else (del /f /q \"{p}\")"));
        }
        if let (AppRemoval::Uninstaller, Some(u)) = (&removal, &app_path) {
            lines.push(format!("start \"\" /wait \"{}\" /S", esc(u)));
        }
        lines.push("del \"%~f0\"".into());
        let script = script_dir.join(format!("finans-kaldir-{pid}.cmd"));
        std::fs::write(&script, lines.join("\r\n")).map_err(|e| format!("Kaldırma hazırlanamadı: {e}"))?;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        std::process::Command::new("cmd")
            .args(["/C", &script.to_string_lossy()])
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn()
            .map_err(|e| format!("Kaldırma başlatılamadı: {e}"))?;
    }

    // Açık veritabanı bağlantısını bırak, sonra uygulamayı kapat
    if let Ok(mut conn) = state.conn.lock() {
        if let Ok(mem) = rusqlite::Connection::open_in_memory() {
            *conn = mem;
        }
    }
    app.exit(0);
    Ok(())
}
