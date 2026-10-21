/** Uygulama Tauri penceresinde mi çalışıyor (yoksa düz tarayıcıda mı)? */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Tauri mobil uygulaması (iOS/Android): masaüstüne özel işlemler (dosya yolu, kaldırma, kısayollar) yok.
 * iPadOS WKWebView'i "Macintosh" der; dokunmatik nokta sayısıyla ayırt edilir (Mac'te 0). */
export const isMobile =
  isTauri &&
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Kısayol gösterimi için: macOS'ta ⌘, diğerlerinde Ctrl */
export const modKey = isMac ? "⌘" : "Ctrl";

/** Veri arka ucu: masaüstü (Tauri komutları) ya da tarayıcı (finans-server API'si). */
export const backend: "tauri" | "http" = isTauri ? "tauri" : "http";
