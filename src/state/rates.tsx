import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "../lib/api";
import { todayISO } from "../lib/format";
import type { RateQuote } from "../lib/types";

interface RatesCtx {
  rates: Map<string, RateQuote>;
  loading: boolean;
  error: string | null;
  /** Kaynaklardan yenile (dövizli işlem penceresi, Kurlar sayfası) */
  refresh(): Promise<void>;
  /** Bugün için güncel kur, geçmiş tarih için o günün kuru; yoksa null */
  rateAt(code: string, date: string): Promise<RateQuote | null>;
}

const RatesContext = createContext<RatesCtx | null>(null);
const POLL_MS = 15 * 60 * 1000;

export function RatesProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<RateQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef<Promise<void> | null>(null);

  const load = useCallback((refresh: boolean) => {
    // Aynı anda gelen yenilemeler tek isteği paylaşır
    busy.current ??= api
      .latestRates(refresh)
      .then((r) => {
        setList(r);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => {
        setLoading(false);
        busy.current = null;
      });
    return busy.current;
  }, []);

  useEffect(() => {
    void load(false);
    const t = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const rates = useMemo(() => new Map(list.map((q) => [q.code, q])), [list]);
  // refresh ve rateAt kurlar değişince yeniden oluşmaz: bunlara bağlı efektler (sayfa açılışında yenile)
  // her yeni yanıtta tekrar çalışıp sonsuz istek döngüsüne girmesin
  const ratesRef = useRef(rates);
  ratesRef.current = rates;
  const refresh = useCallback(() => load(true), [load]);
  const rateAt = useCallback(
    async (code: string, date: string) => (date >= todayISO() ? (ratesRef.current.get(code) ?? null) : api.rateAt(code, date)),
    [],
  );
  const value = useMemo(() => ({ rates, loading, error, refresh, rateAt }), [rates, loading, error, refresh, rateAt]);
  return <RatesContext.Provider value={value}>{children}</RatesContext.Provider>;
}

export function useRates(): RatesCtx {
  const ctx = useContext(RatesContext);
  if (!ctx) throw new Error("useRates, RatesProvider içinde kullanılmalı");
  return ctx;
}
