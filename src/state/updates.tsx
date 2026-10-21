import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../lib/api";
import { isMobile, isTauri } from "../lib/platform";
import { checkUpdate, installUpdate, type UpdateInfo } from "../lib/updater";

/** Masaüstünde uygulama içi güncelleme; mobil ve web'de kapalı */
export const updatesEnabled = isTauri && !isMobile;

/** Açılıştan sonra ilk denetim (açılışı yavaşlatmasın) ve sonraki denetimlerin aralığı */
const FIRST_CHECK_MS = 5_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** "Sonra" denen sürüm: aynı sürüm için uyarı yeniden çıkmaz (cihaz tercihi) */
const DISMISS_KEY = "finans-update-dismissed";

type Phase = "idle" | "checking" | "downloading" | "installing";

interface UpdatesCtx {
  update: UpdateInfo | null;
  phase: Phase;
  /** İndirme yüzdesi (boyut bilinmiyorsa null) */
  percent: number | null;
  error: string | null;
  /** Elle denetim (Ayarlar): sonuç "güncel" ya da yeni sürüm */
  lastChecked: Date | null;
  dismissed: boolean;
  check(): Promise<void>;
  install(): Promise<void>;
  dismiss(): void;
}

const Ctx = createContext<UpdatesCtx | null>(null);

const readDismissed = () => {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
};

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(readDismissed);
  const busy = useRef(false);

  const check = useCallback(async () => {
    if (!updatesEnabled || busy.current) return;
    busy.current = true;
    setPhase("checking");
    setError(null);
    try {
      setUpdate(await checkUpdate());
      setLastChecked(new Date());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
      setPhase("idle");
    }
  }, []);

  const install = useCallback(async () => {
    if (!update?.canInstall || busy.current) return;
    busy.current = true;
    setError(null);
    setPercent(null);
    setPhase("downloading");
    try {
      // Başarılı olursa uygulama yeniden başlar; buraya dönülmez
      await installUpdate((p) => {
        if (p.event === "installing") setPhase("installing");
        else setPercent(p.percent);
      });
    } catch (e) {
      setError(errorMessage(e));
      setPhase("idle");
    } finally {
      busy.current = false;
    }
  }, [update]);

  const dismiss = useCallback(() => {
    if (!update) return;
    setDismissedVersion(update.version);
    try {
      localStorage.setItem(DISMISS_KEY, update.version);
    } catch {
      /* tercih kaydedilemezse yalnız bu oturumda gizlenir */
    }
  }, [update]);

  useEffect(() => {
    if (!updatesEnabled) return;
    const first = window.setTimeout(() => void check(), FIRST_CHECK_MS);
    const every = window.setInterval(() => void check(), CHECK_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [check]);

  const value = useMemo<UpdatesCtx>(
    () => ({ update, phase, percent, error, lastChecked, dismissed: !!update && update.version === dismissedVersion, check, install, dismiss }),
    [update, phase, percent, error, lastChecked, dismissedVersion, check, install, dismiss],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUpdates(): UpdatesCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("UpdateProvider eksik");
  return v;
}
