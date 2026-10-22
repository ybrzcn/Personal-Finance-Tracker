import { invoke } from "@tauri-apps/api/core";
import { httpRequest } from "./httpApi";
import { backend, isMobile, isTauri } from "./platform";
import type { StatementRead } from "./types";

const isAndroid = isMobile && /Android/i.test(navigator.userAgent);
const isIOS = isMobile && !isAndroid;

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** Kaydet penceresi açar ve metni yazar. İptal edilirse false döner. */
export async function saveTextFile(defaultName: string, contents: string, filter: FileFilter): Promise<boolean> {
  if (isAndroid) {
    // Android: sistemin "Farklı kaydet" ekranı (İndirilenler vb.); seçilen content:// adresine fs eklentisi yazar
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: defaultName, filters: [filter] });
    if (!path) return false;
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, contents);
    return true;
  }
  if (isMobile) {
    // iOS webview indirme desteklemez: uygulamanın Belgeler klasörüne yazılır (Dosyalar → Finans)
    await invoke<string>("save_export", { name: defaultName, contents });
    return true;
  }
  if (isTauri) {
    // Yazma fs eklentisiyle ve yalnız kullanıcının kaydet penceresinde seçtiği yola (eklenti kapsamı pencereyle verilir)
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: defaultName, filters: [filter] });
    if (!path) return false;
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, contents);
    return true;
  }
  const ext = filter.extensions[0];
  const mime = ext === "json" ? "application/json" : ext === "csv" ? "text/csv" : "text/plain";
  const url = URL.createObjectURL(new Blob([contents], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Kaydet penceresiyle ikili dosya (belge eki) yazar; web'de indirir. İptal edilirse false. */
export async function saveBinaryFile(defaultName: string, blob: Blob): Promise<boolean> {
  if (isTauri && !isMobile) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: defaultName });
    if (!path) return false;
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return true;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Aç penceresi ile tek bir metin dosyası okur. İptal edilirse null döner. */
export async function openTextFile(filter: FileFilter): Promise<{ name: string; contents: string } | null> {
  if (isTauri && !isMobile) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, directory: false, filters: [filter] });
    if (!path || Array.isArray(path)) return null;
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const contents = await readTextFile(path);
    return { name: path.split(/[\\/]/).pop() ?? path, contents };
  }
  // İptal edilirse null döner (aksi halde çağıran "meşgul" durumda kalırdı)
  const file = await pickFile(filter.extensions);
  return file ? { name: file.name, contents: await file.text() } : null;
}

export async function revealInFolder(path: string) {
  if (!isTauri) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}


export const STATEMENT_EXTENSIONS = ["csv", "txt", "xlsx", "xls", "xlsm", "ods", "pdf"];

/** Banka ekstresi seçtirir ve Rust'ta okur (tablo, başlık, sütunlar, özet). */
export async function openStatementFile(): Promise<{ name: string; file: StatementRead } | null> {
  if (isTauri && !isMobile) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Ekstre (Excel, PDF, CSV)", extensions: STATEMENT_EXTENSIONS }],
    });
    if (!path || Array.isArray(path)) return null;
    // Dosya pencerede seçilen yoldan fs eklentisiyle okunur, baytlar ham IPC ile Rust'ta ayrıştırılır
    const { readFile, stat } = await import("@tauri-apps/plugin-fs");
    if ((await stat(path)).size > MAX_STATEMENT_BYTES) throw "Dosya çok büyük (en fazla 25 MB).";
    const name = path.split(/[\\/]/).pop() ?? path;
    const file = await invoke<StatementRead>("parse_statement_bytes", await readFile(path), {
      headers: { "x-file-name": encodeURIComponent(name) },
    });
    return { name, file };
  }
  if (isMobile) {
    // Mobil: seçilen dosyanın içeriği Rust'ta okunur (Android content:// adresleri yol olarak okunamaz)
    const file = await pickFile(STATEMENT_EXTENSIONS);
    if (!file) return null;
    if (file.size > MAX_STATEMENT_BYTES) throw "Dosya çok büyük (en fazla 25 MB).";
    // Baytlar IPC'ye ham gövde olarak gider (base64/JSON kopyası yok)
    const parsed = await invoke<StatementRead>("parse_statement_bytes", new Uint8Array(await file.arrayBuffer()), {
      headers: { "x-file-name": encodeURIComponent(file.name) },
    });
    return { name: file.name, file: parsed };
  }
  if (backend === "http") {
    // Web: dosya sunucuda okunur (Excel ve PDF dahil)
    const file = await pickFile(STATEMENT_EXTENSIONS);
    if (!file) return null;
    if (file.size > MAX_STATEMENT_BYTES) throw "Dosya çok büyük (en fazla 25 MB).";
    const parsed = await httpRequest<StatementRead>("POST", `/api/statements/parse?name=${encodeURIComponent(file.name)}`, file);
    return { name: file.name, file: parsed };
  }
  return null;
}

/** Dışa aktarılan dosyanın nereye kaydedildiği (mobilde kullanıcıya söylenir). */

export const SAVED_HINT = isIOS ? " Dosyalar uygulamasında Finans klasörüne kaydedildi." : "";

/** Sunucunun kabul ettiği en büyük ekstre dosyası. */
const MAX_STATEMENT_BYTES = 25 * 1024 * 1024;

/** Tarayıcının dosya seçicisi; iptal edilirse null. */
function pickFile(extensions: string[]): Promise<File | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (f: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      resolve(f);
    };
    // "cancel" olayı olmayan tarayıcılarda (iOS < 16.4) iptal, pencereye odak dönüp seçim gelmemesinden anlaşılır
    const onFocus = () => setTimeout(() => done(input.files?.[0] ?? null), 1500);
    const input = document.createElement("input");
    input.type = "file";
    input.accept = extensions.map((e) => `.${e}`).join(",");
    input.onchange = () => done(input.files?.[0] ?? null);
    input.addEventListener("cancel", () => done(null));
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

const DB_FILTER = { name: "Finans veritabanı", extensions: ["db", "sqlite", "sqlite3"] };

/** Veritabanı dosyası için kaydet penceresi (yedek veya yeni veritabanı). İptalde null. */
export async function pickDatabaseSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri) throw "Veritabanı dosyası işlemleri yalnızca masaüstü uygulamasında kullanılabilir.";
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: defaultName, filters: [DB_FILTER] });
  if (!path) return null;
  return /\.(db|sqlite3?)$/i.test(path) ? path : `${path}.db`;
}

/** Var olan veritabanı dosyasını seçtirir. İptalde null. */
export async function pickDatabaseFile(): Promise<string | null> {
  if (!isTauri) throw "Veritabanı dosyası işlemleri yalnızca masaüstü uygulamasında kullanılabilir.";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, directory: false, filters: [DB_FILTER] });
  return !path || Array.isArray(path) ? null : path;
}
