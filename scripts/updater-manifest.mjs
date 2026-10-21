#!/usr/bin/env node
// Sürüm hattında (yayınlamadan önce): uygulama içi güncellemenin okuduğu latest.json'ı üretir. İmzalar (.sig) yayına
// yüklenmiş dosyalardan okunur; her platform o sürümün sabit adlı paketine bağlanır.
// Kullanım: node scripts/updater-manifest.mjs <etiket> <sig-klasörü> <çıktı-dosyası>
// Bir imza eksikse çıkış kodu 1: sürüm yayınlanmaz (güncelleme yarım kalmasın).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { repo } = JSON.parse(readFileSync(join(root, "scripts/release-names.json"), "utf8"));

/** Tauri güncelleme platform anahtarı → paket (rename-artifacts.mjs'in ürettiği adlar) */
const PLATFORMS = {
  "darwin-aarch64": "Finans-macos-universal.app.tar.gz",
  "darwin-x86_64": "Finans-macos-universal.app.tar.gz",
  "windows-x86_64": "Finans-windows-x64-setup.exe",
  "windows-i686": "Finans-windows-x86-setup.exe",
  "windows-aarch64": "Finans-windows-arm64-setup.exe",
  "linux-x86_64": "Finans-linux-x86_64.AppImage",
  "linux-aarch64": "Finans-linux-aarch64.AppImage",
};

const [tag, sigDir, out] = process.argv.slice(2);
if (!tag || !sigDir || !out) {
  console.error("Kullanım: updater-manifest.mjs <etiket> <sig-klasörü> <çıktı-dosyası>");
  process.exit(2);
}

const platforms = {};
let missing = 0;
for (const [key, file] of Object.entries(PLATFORMS)) {
  const sig = join(sigDir, `${file}.sig`);
  if (!existsSync(sig)) {
    console.error(`EKSİK: ${file}.sig (${key})`);
    missing++;
    continue;
  }
  platforms[key] = {
    signature: readFileSync(sig, "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${file}`,
  };
}
if (missing) process.exit(1);

const manifest = {
  version: tag.replace(/^v/, ""),
  notes: `Finans ${tag}: https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`${out}: ${Object.keys(platforms).length} platform`);
