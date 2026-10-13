import names from "../../scripts/release-names.json";

export type PlatformKey = "macos" | "windows" | "linux";

export interface DownloadItem {
  id: string;
  label: string;
  description: string;
  file: string;
}

export interface Platform {
  name: string;
  primary: DownloadItem;
  others: DownloadItem[];
  /** İmzasız dağıtımda ilk açılış talimatı */
  note: string;
}

export const REPO = names.repo;
export const REPO_URL = `https://github.com/${REPO}`;

/** Her zaman en son sürümün dosyası (dosya adlarında sürüm yok; sürüm hattı aynı adlarla yükler). */
export const downloadUrl = (file: string) => `${REPO_URL}/releases/latest/download/${file}`;

const NOTES: Record<PlatformKey, string> = {
  macos: "Uygulama henüz imzalı değil: ilk açılışta Uygulamalar klasöründe Finans'a sağ tıklayıp Aç'ı seçin.",
  windows: "Uygulama henüz imzalı değil: SmartScreen uyarısında Ek bilgi → Yine de çalıştır.",
  linux: "AppImage'ı çalıştırılabilir yapın: chmod +x Finans-linux-*.AppImage",
};

const NAMES: Record<PlatformKey, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

export const PLATFORMS: Record<PlatformKey, Platform> = Object.fromEntries(
  (Object.keys(NAMES) as PlatformKey[]).map((k) => [
    k,
    { name: NAMES[k], primary: names.platforms[k].primary, others: names.platforms[k].others, note: NOTES[k] },
  ]),
) as Record<PlatformKey, Platform>;

export const PLATFORM_ORDER: PlatformKey[] = ["macos", "windows", "linux"];

/** Ziyaretçinin masaüstü işletim sistemi (telefonda null). */
export function detectPlatform(): PlatformKey | null {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return null;
  if (/Mac/i.test(ua)) return "macos";
  if (/Win/i.test(ua)) return "windows";
  if (/Linux|X11|CrOS/i.test(ua)) return "linux";
  return null;
}
