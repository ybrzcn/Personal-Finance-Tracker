import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig(() => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**"] },
    // Web geliştirmede API istekleri yerelde çalışan finans-server'a gider (aynı köken; çerez çalışır). Koşulsuz:
    // Vite yapılandırma değişince sunucuyu yeniden başlatırken modu kaybedip proxy'yi düşürüyordu; diğer modlarda /api çağrısı yok
    proxy: { "/api": "http://localhost:8080" },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Windows: WebView2 (Chromium), macOS: WKWebView (Safari)
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
