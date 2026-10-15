import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "../lib/api";
import { todayISO } from "../lib/format";
import { isFund } from "../lib/fx";
import type { RateQuote } from "../lib/types";
import { useData } from "./data";

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
  // Süren istekten sonra bir kez daha yüklenecek mi (true: kaynaklardan yenileyerek)
  const again = useRef<boolean | null>(null);
  const busyRefresh = useRef(false);

  const load = useCallback((refresh: boolean, fresh = false): Promise<void> => {
    // Aynı anda gelen yenilemeler tek isteği paylaşır; yeni fon hesabı ya da yenileme isteği süren
    // (eski) isteğin sonucuyla yetinmez, onun ardından bir kez daha yüklenir
    if (busy.current && (fresh || (refresh && !busyRefresh.current))) {
      again.current = (again.current ?? false) || refresh;
      return busy.current.then(() => busy.current ?? undefined);
    }
    if (busy.current) return busy.current;
    busyRefresh.current = refresh;
    busy.current = api
      .latestRates(refresh)
      .then((r) => {
        setList(r);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => {
        setLoading(false);
        busy.current = null;
        const next = again.current;
        again.current = null;
        if (next !== null) void load(next);
      });
    return busy.current;
  }, []);

  useEffect(() => {
    void load(false);
    const t = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Fon hesabı eklenince/silinince fon fiyatları da listeye girsin
  const { accounts } = useData();
  const fundKey = accounts
    .filter((a) => isFund(a.currency))
    .map((a) => a.currency)
    .sort()
    .join(",");
  const firstFundKey = useRef(fundKey);
  useEffect(() => {
    if (firstFundKey.current === fundKey) return;
    firstFundKey.current = fundKey;
    void load(false, true);
  }, [fundKey, load]);

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
