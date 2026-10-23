import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { locale, t } from "../lib/i18n";
import { isTauri } from "../lib/platform";
import { APP_SETTING_KEYS, type AppDataSettings, type AppSettingKey } from "../lib/types";
import { SettingsContext } from "./contexts";
import { useData } from "./data";

export type ThemePref = "system" | "light" | "dark";
export type Currency = "TRY" | "USD" | "EUR" | "GBP";

/** Cihaza özel tercihler (localStorage); veritabanına girmez */
interface DeviceSettings {
  theme: ThemePref;
  currency: Currency;
}

export interface Settings extends DeviceSettings, AppDataSettings {}

const KEY = "finans-settings";
const DEVICE_DEFAULTS: DeviceSettings = { theme: "system", currency: "TRY" };
const DATA_DEFAULTS: AppDataSettings = {
  debtBudget: 0,
  debtBudgetOverrides: {},
  debtRules: {},
  debtCells: {},
  subscriptionOverrides: {},
  forecastCategoryIds: null,
  categoryRules: [],
  projection: {},
  investmentIncomeCategoryIds: null,
};

const isAppKey = (k: string): k is AppSettingKey => (APP_SETTING_KEYS as string[]).includes(k);

/** localStorage'daki ham nesne (eski sürümlerde uygulama ayarları da buradaydı). */
function readStored(): Record<string, unknown> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function loadDevice(): DeviceSettings {
  const s = readStored();
  return {
    theme: s.theme === "light" || s.theme === "dark" ? s.theme : DEVICE_DEFAULTS.theme,
    currency: (s.currency as Currency) ?? DEVICE_DEFAULTS.currency,
  };
}

export interface SettingsCtx {
  settings: Settings;
  /** Cihaz tercihleri hemen, uygulama ayarları veritabanına yazılır; yazılamazsa reddedilir (değer geri alınır) */
  update(patch: Partial<Settings>): Promise<void>;
  isDark: boolean;
  formatMoney(n: number): string;
  formatCompact(n: number): string;
}


/** Eski sürümden kalan, henüz veritabanına taşınmamış uygulama ayarları. */
function readLegacy(): Partial<Record<AppSettingKey, unknown>> {
  return Object.fromEntries(Object.entries(readStored()).filter(([k, v]) => isAppKey(k) && v !== undefined));
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { loading, loadError, appSettings, saveSetting } = useData();
  const [device, setDevice] = useState<DeviceSettings>(loadDevice);
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  // Taşınana kadar localStorage'da korunur (taşıma yarıda kalırsa sonraki açılışta yeniden denenir)
  const legacy = useRef<Partial<Record<AppSettingKey, unknown>> | null>(null);
  if (legacy.current === null) legacy.current = readLegacy();

  const persist = useCallback((d: DeviceSettings) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...legacy.current, ...d }));
    } catch {
      /* depolama kullanılamıyorsa tercihler yalnızca bu oturumda geçerli */
    }
  }, []);

  useEffect(() => persist(device), [device, persist]);

  // Tek seferlik taşıma: eski sürümün localStorage'daki borç planı/analiz ayarları veritabanına yazılır.
  // Yalnız veri başarıyla yüklendiyse çalışır; veritabanında zaten olan anahtarın üzerine yazılmaz (veritabanı kazanır).
  // Yerel kopya yalnız veritabanına yazılan (ya da veritabanında zaten olan) anahtarlar için silinir.
  const migrating = useRef(false);
  useEffect(() => {
    const pending = legacy.current ?? {};
    if (loading || loadError || migrating.current || Object.keys(pending).length === 0) return;
    migrating.current = true;
    const keys = Object.keys(pending) as AppSettingKey[];
    void Promise.allSettled(
      keys.map((k) => (appSettings[k] !== undefined ? Promise.resolve() : saveSetting(k, pending[k] as never))),
    ).then((results) => {
      const rest = { ...pending };
      results.forEach((r, i) => {
        if (r.status === "fulfilled") delete rest[keys[i]];
        else console.error("Eski ayar taşınamadı", keys[i], r.reason);
      });
      legacy.current = rest;
      persist(device);
    });
  }, [loading, loadError, appSettings, saveSetting, persist, device]);

  const settings = useMemo<Settings>(() => ({ ...device, ...DATA_DEFAULTS, ...appSettings }), [device, appSettings]);

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const isDark = device.theme === "dark" || (device.theme === "system" && systemDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  // Yerel pencere çerçevesi/başlık çubuğu temasını da eşitle (Windows başlık çubuğu, macOS pencere)
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().setTheme(settings.theme === "system" ? null : settings.theme),
      )
      .catch(() => {});
  }, [settings.theme]);

  const update = useCallback(
    async (patch: Partial<Settings>) => {
      const devicePatch: Partial<DeviceSettings> = {};
      const writes: Promise<void>[] = [];
      for (const [k, v] of Object.entries(patch)) {
        if (isAppKey(k)) writes.push(saveSetting(k, v as never));
        else (devicePatch as Record<string, unknown>)[k] = v;
      }
      if (Object.keys(devicePatch).length) setDevice((d) => ({ ...d, ...devicePatch }));
      await Promise.all(writes);
    },
    [saveSetting],
  );

  const value = useMemo<SettingsCtx>(() => {
    // Uygulama TL ile çalışır (tutarlar çevrilmediği için para birimi seçeneği kaldırıldı)
    const money = new Intl.NumberFormat(locale, { style: "currency", currency: "TRY", currencyDisplay: "narrowSymbol" });
    const one = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    // Grafik eksenleri için kısa biçim: "₺22 bin", "₺1,5 mn" ("B" milyar ile karışmasın)
    const compact = (n: number) => {
      const a = Math.abs(n);
      const sign = n < 0 ? "-" : "";
      if (a >= 1_000_000) return t("{sign}₺{v} mn", { sign, v: one.format(a / 1_000_000) });
      if (a >= 1_000) return t("{sign}₺{v} bin", { sign, v: one.format(a / 1_000) });
      return `${sign}₺${one.format(a)}`;
    };
    return {
      settings,
      update,
      isDark,
      formatMoney: (n) => money.format(n),
      formatCompact: compact,
    };
  }, [settings, update, isDark]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings, SettingsProvider içinde kullanılmalı");
  return ctx;
}
