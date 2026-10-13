#!/usr/bin/env node
// CI: tanıtım sayfasındaki her indirme (release-names.json) sürüm hattında üretiliyor mu, tersi de.
import { readFileSync } from "node:fs";
const names = JSON.parse(readFileSync(new URL("./release-names.json", import.meta.url), "utf8"));
const ids = Object.values(names.platforms).flatMap((p) => [p.primary, ...p.others]).map((d) => d.id);
const planned = [...readFileSync(new URL("./rename-artifacts.mjs", import.meta.url), "utf8").matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
const missing = ids.filter((i) => !planned.includes(i));
const extra = planned.filter((i) => !ids.includes(i));
if (missing.length || extra.length) {
  console.error({ sayfadaOlupUretilmeyen: missing, uretilipSayfadaOlmayan: extra });
  process.exit(1);
}
console.log(`${ids.length} indirme eşleşiyor`);
