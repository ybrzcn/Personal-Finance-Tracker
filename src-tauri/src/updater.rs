//! Uygulama içi güncelleme (masaüstü): GitHub yayınındaki latest.json denetlenir; imzası doğrulanan paket indirilip
//! kurulur, uygulama yeniden başlar. Kendini güncelleyemeyen kurulumlarda (taşınabilir zip, MSI, deb/rpm) yalnız
//! yeni sürüm bildirilir; arayüz indirme sayfasını açar.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// Yayın notları (varsa)
    pub notes: Option<String>,
    /// Bu kurulum kendini güncelleyebilir mi (.app, NSIS kurulumu, AppImage)
    pub can_install: bool,
}

/// İndirme ilerlemesi: yüzde (sunucu boyut bildirmezse yok)
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
pub enum UpdateProgress {
    Progress { percent: Option<u8> },
    Installing,
}

/// Kendini güncelleyebilen kurulum: macOS .app paketi, Windows NSIS kurulumu, Linux AppImage
fn can_self_update() -> bool {
    use crate::maintenance::AppRemoval;
    matches!(crate::maintenance::app_removal().0, AppRemoval::Bundle | AppRemoval::Uninstaller | AppRemoval::AppImage)
}

/// İndirme/kurulum hatası; imza tutmazsa paket kurulmaz (değiştirilmiş ya da bozuk indirme)
#[cfg(desktop)]
fn install_error(e: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Minisign(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } => {
            "Güncelleme paketi doğrulanamadı (imza tutmuyor); kurulmadı.".into()
        }
        e => format!("Güncelleme kurulamadı: {e}"),
    }
}

/// Yeni sürüm varsa bilgisi; yoksa None. Ağ yoksa hata.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_updater::UpdaterExt;
        let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| format!("Güncelleme denetlenemedi: {e}"))?;
        Ok(update.map(|u| UpdateInfo { version: u.version, current_version: u.current_version, notes: u.body, can_install: can_self_update() }))
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Ok(None)
    }
}

/// Güncellemeyi indirir (ilerleme kanaldan), kurar ve uygulamayı yeniden başlatır. Windows'ta kurulum programı
/// uygulamayı kendisi kapatır.
#[tauri::command]
pub async fn install_update(app: AppHandle, on_event: Channel<UpdateProgress>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_updater::UpdaterExt;
        if !can_self_update() {
            return Err("Bu kurulum kendini güncelleyemiyor; yeni sürümü indirme sayfasından kurun.".into());
        }
        let update = app
            .updater()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| format!("Güncelleme denetlenemedi: {e}"))?
            .ok_or("Yeni sürüm bulunamadı.")?;
        let mut downloaded = 0u64;
        update
            .download_and_install(
                |chunk, total| {
                    downloaded += chunk as u64;
                    let percent = total.filter(|t| *t > 0).map(|t| (downloaded.saturating_mul(100) / t).min(100) as u8);
                    let _ = on_event.send(UpdateProgress::Progress { percent });
                },
                || {
                    let _ = on_event.send(UpdateProgress::Installing);
                },
            )
            .await
            .map_err(install_error)?;
        app.restart();
    }
    #[cfg(mobile)]
    {
        let _ = (app, on_event);
        Err("Mobil uygulama mağazadan güncellenir.".into())
    }
}
