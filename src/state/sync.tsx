import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { UNAUTHORIZED_EVENT } from "../lib/httpApi";
import { tm } from "../lib/i18n";
import { isTauri } from "../lib/platform";
import { KEY_CHANGED, syncApi, type SyncInfo, type SyncReport } from "../lib/sync";
import { useAuth } from "./auth";
import { useData } from "./data";

interface SyncCtx {
  /** Bu cihazda eşitleme kullanılabilir mi (masaüstü/mobil, veri bu cihazda, oturum açık) */
  available: boolean;
  info: SyncInfo | null;
  running: boolean;
  error: string | null;
  /** Eşitleme başka cihazdan kapatıldığı için bu cihaz ayrıldı */
  detached: boolean;
  lastReport: SyncReport | null;
  /** Bir tur çalıştırır; sonuç ya da hata durumda görünür */
  syncNow(): Promise<void>;
  /** Bağlama/açma/kapama sonrası yerel durumu yeniler */
  refresh(): Promise<void>;
  /** Bağlama ya da açma turunun sonucu (veri değiştiyse yeniden yüklenir) */
  applied(report: SyncReport): Promise<void>;
}

const Ctx = createContext<SyncCtx>({
  available: false,
  info: null,
  running: false,
  error: null,
  detached: false,
  lastReport: null,
  syncNow: async () => {},
  refresh: async () => {},
  applied: async () => {},
});

export function useSync() {
  return useContext(Ctx);
}

/** Bağlıyken dakikada bir ve pencere öne gelince */
const INTERVAL_MS = 60_000;
const FOCUS_GAP_MS = 15_000;

/** Uçtan uca şifreli eşitleme: bağlı cihazda arka planda düzenli tur atar, gelen değişiklikte veriyi yeniden yükler. */
export function SyncProvider({ children }: { children: ReactNode }) {
  const { mode, user } = useAuth();
  const { reload } = useData();
  const available = isTauri && mode === "local" && !!user;
  const [info, setInfo] = useState<SyncInfo | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detached, setDetached] = useState(false);
  const [lastReport, setLastReport] = useState<SyncReport | null>(null);
  const busy = useRef(false);
  const lastRun = useRef(0);

  const userId = user?.id;
  const refresh = useCallback(async () => {
    if (!available) return;
    try {
      setInfo(await syncApi.status());
    } catch (e) {
      setError(tm(String(e)));
    }
    // Başka hesapla yeniden girişte durum o hesaba göre okunur
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, userId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applied = useCallback(
    async (r: SyncReport) => {
      setLastReport(r);
      setError(null);
      setDetached(false);
      if (r.pulled > 0) await reload();
      await refresh();
    },
    [reload, refresh],
  );

  const syncNow = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    lastRun.current = Date.now();
    setRunning(true);
    try {
      await applied(await syncApi.run());
    } catch (e) {
      const msg = String(e);
      if (msg === KEY_CHANGED) {
        // Sunucudaki eşitleme silinmiş/sıfırlanmış: bu cihaz ayrılır, verisi yerinde kalır
        await syncApi.unlink().catch(() => {});
        setDetached(true);
        setError(null);
        await refresh();
      } else {
        if (msg.startsWith("Oturum sona erdi")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        setError(tm(msg));
      }
    } finally {
      busy.current = false;
      setRunning(false);
    }
  }, [applied, refresh]);

  const linked = available && !!info?.linked;
  useEffect(() => {
    if (!linked) return;
    void syncNow();
    const timer = window.setInterval(() => void syncNow(), INTERVAL_MS);
    const onFocus = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRun.current > FOCUS_GAP_MS) void syncNow();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [linked, syncNow]);

  const value = useMemo(
    () => ({ available, info, running, error, detached, lastReport, syncNow, refresh, applied }),
    [available, info, running, error, detached, lastReport, syncNow, refresh, applied],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
