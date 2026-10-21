import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { CashPlanReport, UpcomingObligations } from "../lib/types";
import { useData } from "./data";
import { useToday } from "./today";

/**
 * Bugüne bağlı rapor: `key` (süre) değişince, hesap/işlem/düzenli kayıt (`withCategories` ile kategori) ya da gün değişince
 * yeniden alınır; yalnız son isteğin yanıtı yazılır. Başka sürenin raporu ya da hata varken rapor boştur (eski rakam gösterilmez);
 * aynı anahtarla yeniden alınırken `refreshing` doğrudur (eski rapor güncel değil).
 */
export function useLiveReport<T, K extends string | number = number>(key: K, fetch: (key: K) => Promise<T>, withCategories = false) {
  const { accounts, transactions, recurring, categories } = useData();
  const day = useToday();
  const [state, setState] = useState<{ key: K; report: T } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const retry = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    fetch(key)
      .then((report) => n === seq.current && setState({ key, report }))
      .catch((e) => {
        if (n !== seq.current) return;
        setState(null);
        setError(errorMessage(e));
      })
      .finally(() => n === seq.current && setLoading(false));
  }, [key, fetch]);
  // Kategori yalnız ona bağlı raporlarda izlenir (takvim ve borç planı kategori düzenlemesinde yeniden alınmasın)
  const watchedCategories = withCategories ? categories : null;
  useEffect(retry, [retry, accounts, transactions, recurring, watchedCategories, day]);
  // Yeni süre için istek effect'te başlar; o ana kadar da "bekleniyor" sayılır ("—" yanıp sönmesin)
  const pending = !error && state?.key !== key;
  const current = !error && state?.key === key;
  return { report: current ? state.report : null, error, loading: loading || pending, refreshing: current && loading, retry };
}

const fetchPlan = (months: number) => api.cashPlan(months);
const fetchUpcoming = (days: number) => api.upcomingObligations(days);

/** Ödeme takvimi (Rust) */
export const useCashPlan = (months: number) => useLiveReport<CashPlanReport>(months, fetchPlan);
/** Önümüzdeki `days` günün ödemeleri (Rust) */
export const useUpcomingObligations = (days: number) => useLiveReport<UpcomingObligations>(days, fetchUpcoming);
