#!/usr/bin/env node
// Sürüm hattında: Tauri'nin ürettiği paketleri tanıtım sayfasının bağlandığı sabit adlara kopyalar
// (scripts/release-names.json tek kaynaktır). Taşınabilir zip ve tarball'ı da burada üretir.
// Kullanım: node scripts/rename-artifacts.mjs <matris-id> <çıktı-klasörü>
// Beklenen bir dosya bulunamazsa çıkış kodu 1: o derleme başarısız sayılır, sürüm yayınlanmaz.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const names = JSON.parse(readFileSync(join(root, "scripts/release-names.json"), "utf8"));
const fileFor = Object.fromEntries(
  Object.values(names.platforms).flatMap((p) => [p.primary, ...p.others]).map((d) => [d.id, d.file]),
);

/** Matris işi → üretilecek dosyalar. `bundle`: bundle/<klasör> içinde uzantı (+ isteğe bağlı ad parçası). */
const PLAN = {
  "macos-universal": [{ id: "macos-universal-dmg", bundle: "dmg", ext: ".dmg" }],
  "windows-x64": [
    { id: "windows-x64-setup", bundle: "nsis", ext: "-setup.exe" },
    { id: "windows-x64-msi", bundle: "msi", ext: ".msi", contains: "tr-TR" },
    { id: "windows-x64-portable", portable: "zip" },
  ],
  "windows-x86": [
    { id: "windows-x86-setup", bundle: "nsis", ext: "-setup.exe" },
    { id: "windows-x86-portable", portable: "zip" },
  ],
  "windows-arm64": [
    { id: "windows-arm64-setup", bundle: "nsis", ext: "-setup.exe" },
    { id: "windows-arm64-portable", portable: "zip" },
  ],
  "linux-x86_64": [
    { id: "linux-x86_64-appimage", bundle: "appimage", ext: ".AppImage" },
    { id: "linux-x86_64-deb", bundle: "deb", ext: ".deb" },
    { id: "linux-x86_64-rpm", bundle: "rpm", ext: ".rpm" },
    { id: "linux-x86_64-tar", portable: "tar" },
  ],
  "linux-aarch64": [
    { id: "linux-aarch64-appimage", bundle: "appimage", ext: ".AppImage" },
    { id: "linux-aarch64-deb", bundle: "deb", ext: ".deb" },
    { id: "linux-aarch64-rpm", bundle: "rpm", ext: ".rpm" },
    { id: "linux-aarch64-tar", portable: "tar" },
  ],
};

const [matrixId, outDir] = process.argv.slice(2);
const plan = PLAN[matrixId];
if (!plan || !outDir) {
  console.error(`Kullanım: rename-artifacts.mjs <${Object.keys(PLAN).join("|")}> <çıktı-klasörü>`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// target/release/... ya da target/<hedef>/release/...
const targetDir = join(root, "src-tauri/target");
const releaseDirs = [join(targetDir, "release"), ...readdirSync(targetDir).map((d) => join(targetDir, d, "release"))].filter(
  (d) => existsSync(d) && statSync(d).isDirectory(),
);

function findBundle(folder, ext, contains) {
  for (const rel of releaseDirs) {
    const dir = join(rel, "bundle", folder);
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((f) => f.endsWith(ext) && (!contains || f.includes(contains)));
    if (hit) return join(dir, hit);
  }
  return null;
}

function findBinary() {
  for (const rel of releaseDirs) {
    for (const name of ["finans.exe", "Finans.exe", "finans", "Finans"]) {
      const p = join(rel, name);
      if (existsSync(p) && statSync(p).isFile()) return p;
    }
  }
  return null;
}

let missing = 0;
for (const item of plan) {
  const target = join(outDir, fileFor[item.id]);
  if (item.bundle) {
    const src = findBundle(item.bundle, item.ext, item.contains);
    if (!src) {
      console.error(`EKSİK: ${item.id} (bundle/${item.bundle}/*${item.ext})`);
      missing++;
      continue;
    }
    copyFileSync(src, target);
  } else {
    const bin = findBinary();
    if (!bin) {
      console.error(`EKSİK: ${item.id} (uygulama ikilisi)`);
      missing++;
      continue;
    }
    const stage = mkdtempSync(join(tmpdir(), "finans-"));
    if (item.portable === "zip") {
      // Windows'un kendi bsdtar'ı zip yazabilir (-a: uzantıdan biçim). PATH'teki Git'in GNU tar'ı zip yazamaz,
      // bu yüzden System32'deki açıkça çağrılır; çıktının gerçekten zip olduğu (PK imzası) doğrulanır.
      copyFileSync(bin, join(stage, "Finans.exe"));
      const tarBin = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
      execFileSync(tarBin, ["-a", "-c", "-f", target, "-C", stage, "Finans.exe"]);
      if (readFileSync(target).subarray(0, 2).toString("latin1") !== "PK") {
        console.error(`HATA: ${basename(target)} zip değil`);
        process.exit(1);
      }
    } else {
      const dirName = "Finans";
      mkdirSync(join(stage, dirName));
      copyFileSync(bin, join(stage, dirName, "finans"));
      copyFileSync(join(root, "src-tauri/icons/128x128.png"), join(stage, dirName, "finans.png"));
      writeFileSync(
        join(stage, dirName, "Finans.desktop"),
        // Klasör açılıp doğrudan ./finans ile çalıştırılır; .desktop dosyası menüye eklemek için örnek
        // (~/.local/share/applications'a kopyalayıp Exec/Icon yollarını klasöre göre düzenleyin)
        "[Desktop Entry]\nType=Application\nName=Finans\nComment=Kişisel finans takibi\nExec=finans\nIcon=finans\nCategories=Office;Finance;\n",
      );
      execFileSync("tar", ["-czf", target, "-C", stage, dirName]);
    }
  }
  console.log(`${basename(target)}`);
}
process.exit(missing ? 1 : 0);
