import { invoke } from "@tauri-apps/api/core";

export type Mode = "local" | "server";

/** Masaüstü istemci durumu (Tauri tarafında config.json'da saklanır). */
export interface ClientConfig {
  serverUrl?: string | null;
  token?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  /** "local": veri bu cihazda; "server": veri sunucuda; boş: henüz seçilmedi */
  mode?: Mode | null;
}

/** Derlemeye gömülen resmi sunucu adresi (boşsa kullanıcı girer). */
export const DEFAULT_SERVER_URL = import.meta.env.VITE_DEFAULT_SERVER_URL ?? "";

export const loadClientConfig = () => invoke<ClientConfig>("get_client_config");
export const saveClientConfig = (config: ClientConfig) => invoke<void>("set_client_config", { config });

/** "finans.ornek.com" → "https://finans.ornek.com"; sondaki "/" atılır. */
export function normalizeServerUrl(input: string): string {
  const raw = input.trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) throw new Error();
    // Şifresiz http yalnız yerel ağda: internette şifre, token ve finans verisi açık metin gitmesin
    if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
      throw "İnternetteki sunucuya yalnız HTTPS ile bağlanılabilir (https://…). Şifresiz http yalnız yerel ağ adresleri için.";
    }
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch (e) {
    if (typeof e === "string") throw e;
    throw "Geçerli bir sunucu adresi girin (ör. https://finans.ornek.com).";
  }
}

/** localhost, özel IP aralıkları (10/8, 172.16/12, 192.168/16, 127/8), Android emülatörü ve .local adları. */
function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || h.endsWith(".local")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
