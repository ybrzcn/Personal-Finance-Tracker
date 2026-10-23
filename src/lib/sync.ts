import { invoke } from "@tauri-apps/api/core";

/** Bir eşitleme turunun sonucu (finans-core `sync::engine::Report`). */
export interface SyncReport {
  /** Bu cihazda değişen kayıt sayısı */
  pulled: number;
  /** Sunucuya giden değişiklik sayısı */
  pushed: number;
  /** İki cihazda farklı değiştirilmiş, bu cihazdaki tutulan kayıt sayısı */
  conflicts: number;
  /** İçeriği henüz indirilemeyen belge sayısı */
  missingFiles: number;
  lastSync: string;
}

export interface SyncInfo {
  /** Bu cihazda kullanılamıyorsa nedeni */
  unavailable: string | null;
  linked?: boolean;
  lastSync?: string | null;
}

export interface SyncRemote {
  /** Hesapta eşitleme açık mı */
  enabled: boolean;
  updatedAt: number | null;
  bytes: number;
}

/** Rust'taki `ERR_KEY_CHANGED` (eşitleme başka cihazdan silinmiş/sıfırlanmış) */
export const KEY_CHANGED = "Eşitleme başka bir cihazdan sıfırlanmış ya da kapatılmış; bu cihazı yeniden bağlayın.";
export const MIN_PASSPHRASE = 10;

export const syncApi = {
  status: () => invoke<SyncInfo>("sync_status"),
  remote: () => invoke<SyncRemote>("sync_remote"),
  enable: (passphrase: string) => invoke<SyncReport>("sync_enable", { passphrase }),
  link: (passphrase: string, replace: boolean) => invoke<{ report: SyncReport; backupPath: string | null }>("sync_link", { passphrase, replace }),
  run: () => invoke<SyncReport>("sync_run"),
  changePassphrase: (passphrase: string) => invoke<void>("sync_change_passphrase", { passphrase }),
  unlink: () => invoke<void>("sync_unlink"),
  deleteRemote: (password: string) => invoke<void>("sync_delete_remote", { password }),
};
