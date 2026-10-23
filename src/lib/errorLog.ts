/**
 * Son hataların yerel kaydı (hata bildirimi için). Yalnız hata metni, yığın ve hangi sayfada olduğu tutulur;
 * finansal veri tutulmaz. Kayıt bu bilgisayarda kalır, kullanıcı raporu kendisi kopyalar ya da kaydeder.
 */
import { t } from "./i18n";

export interface LoggedError {
  at: string;
  source: string;
  message: string;
  stack?: string;
}

const KEY = "finans-error-log";
const MAX = 30;

export function getErrors(): LoggedError[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function clearErrors() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* yoksay */
  }
}

export function logError(error: unknown, source: string) {
  const e = error instanceof Error ? error : null;
  const entry: LoggedError = {
    at: new Date().toISOString(),
    source,
    message: (e?.message ?? String(error)).slice(0, 1000),
    stack: e?.stack?.slice(0, 3000),
  };
  try {
    const list = [entry, ...getErrors()].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* yoksay */
  }
}

/** Yakalanmamış hataları ve reddedilen promise'leri kayda alır. */
export function installErrorLog() {
  window.addEventListener("error", (e) => logError(e.error ?? e.message, "pencere"));
  window.addEventListener("unhandledrejection", (e) => logError(e.reason, "promise"));
}

export interface ReportInfo {
  version: string;
  os: string;
  arch: string;
  schemaVersion: number | null;
  page: string;
}

/** Kullanıcının ileteceği düz metin rapor. */
export function buildReport(description: string, info: ReportInfo, errors: LoggedError[]): string {
  const lines = [
    t("Finans hata raporu"),
    "==================",
    t("Tarih: {v}", { v: new Date().toISOString() }),
    t("Sürüm: {version} · Şema: {schema}", { version: info.version, schema: info.schemaVersion ?? "-" }),
    t("Sistem: {os} ({arch})", { os: info.os, arch: info.arch }),
    t("Sayfa: {v}", { v: info.page }),
    t("Tarayıcı motoru: {v}", { v: navigator.userAgent }),
    "",
    t("Kullanıcının açıklaması:"),
    description.trim() || t("(açıklama yok)"),
    "",
    t("Son hatalar ({n}):", { n: errors.length }),
  ];
  if (!errors.length) lines.push(t("(kayıtlı hata yok)"));
  errors.slice(0, 10).forEach((e, i) => {
    lines.push("", `${i + 1}. [${e.at}] (${e.source}) ${e.message}`);
    if (e.stack) lines.push(e.stack);
  });
  return lines.join("\n");
}
