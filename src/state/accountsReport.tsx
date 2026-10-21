import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "../lib/api";
import { ratesKey } from "../lib/networth";
import type { AccountReport, AccountsReport } from "../lib/types";
import { useData } from "./data";
import { useRates } from "./rates";
import { useToday } from "./today";

interface AccountsReportState {
  report: AccountsReport | null;
  byId: Map<string, AccountReport>;
  error: string | null;
  loading: boolean;
  reload(): void;
}

const Ctx = createContext<AccountsReportState>({ report: null, byId: new Map(), error: null, loading: false, reload: () => {} });

/** Yalnız en son başlatılan isteğin sonucunu `apply`'a verir; geç gelen eski yanıt atılır. */
export function latestOnly<T>(apply: (v: T) => void) {
  let seq = 0;
  return (p: Promise<T>) => {
    const n = ++seq;
    return p.then((v) => {
      if (n === seq) apply(v);
    });
  };
}

/** Hesap özetleri (Rust); hesaplar, işlemler, kurlar ya da gün değişince yeniden alınır. */
export function AccountsReportProvider({ children }: { children: ReactNode }) {
  const { accounts, transactions, categories } = useData();
  const { rates } = useRates();
  // Kur yoklaması aynı fiyatlarla yeni liste getirirse rapor yeniden alınmaz
  const rateKey = useMemo(() => ratesKey(rates), [rates]);
  const [report, setReport] = useState<AccountsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Ekstre durumu ve tarihler güne bağlı: uygulama açık kalırken gün dönünce rapor yenilenir
  const day = useToday();
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    api
      .accountsReport()
      .then((r) => {
        if (n !== seq.current) return;
        setReport(r);
        setError(null);
      })
      .catch((e) => n === seq.current && setError(errorMessage(e)))
      .finally(() => n === seq.current && setLoading(false));
  }, []);
  // Kategoriler: kredi ödemesinin faiz kategorisi (feeCategoryId) rapordan
  useEffect(reload, [reload, accounts, transactions, categories, rateKey, day]);
  const value = useMemo(() => {
    const byId = new Map((report?.accounts ?? []).map((a) => [a.accountId, a]));
    return { report, byId, error, loading, reload };
  }, [report, error, loading, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAccountsReport = () => useContext(Ctx);

/** Tek hesabın özeti; yoksa rakam yerine gösterilecek işaret ("…" bekleniyor, "—" yok/hata). */
export function useAccountReport(id: string): { r: AccountReport | null; placeholder: "…" | "—" } {
  const { byId, loading, error } = useAccountsReport();
  const r = byId.get(id) ?? null;
  return { r, placeholder: !r && loading && !error ? "…" : "—" };
}
