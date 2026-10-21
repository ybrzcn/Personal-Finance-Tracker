import { Channel, invoke } from "@tauri-apps/api/core";
import { REPO_URL } from "./downloads";

/** Rust `updater::UpdateInfo` */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
  /** Bu kurulum kendini güncelleyebilir mi (.app, Windows kurulumu, AppImage); değilse indirme sayfası açılır */
  canInstall: boolean;
}

/** Rust `updater::UpdateProgress` */
export type UpdateProgress = { event: "progress"; percent: number | null } | { event: "installing" };

/** Yeni sürüm varsa bilgisi (masaüstü) */
export const checkUpdate = () => invoke<UpdateInfo | null>("check_update");

/** İndirir, kurar ve uygulamayı yeniden başlatır */
export function installUpdate(onProgress: (p: UpdateProgress) => void): Promise<void> {
  const channel = new Channel<UpdateProgress>();
  channel.onmessage = onProgress;
  return invoke("install_update", { onEvent: channel });
}

export const RELEASES_URL = `${REPO_URL}/releases/latest`;

/** Son sürümün GitHub sayfası (sistem tarayıcısında) */
export async function openReleases(): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(RELEASES_URL);
}
