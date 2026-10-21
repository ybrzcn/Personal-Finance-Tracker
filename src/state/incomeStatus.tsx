import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "../lib/api";
import type { IncomeStatus } from "../lib/types";
import { useData } from "./data";
import { useToday } from "./today";

interface IncomeStatusState {
  status: IncomeStatus | null;
  error: string | null;
  loading: boolean;
  reload(): void;
}

const Ctx = createContext<IncomeStatusState>({ status: null, error: null, loading: false, reload: () => {} });

/** Beklenen gelir ve girilmemiş maaş uyarısı (Rust); işlemler, düzenli kayıtlar ya da gün değişince yeniden alınır. */
export function IncomeStatusProvider({ children }: { children: ReactNode }) {
  const { transactions, recurring } = useData();
  const day = useToday();
  const [status, setStatus] = useState<IncomeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    api
      .incomeStatus()
      .then((s) => {
        if (n !== seq.current) return;
        setStatus(s);
        setError(null);
      })
      .catch((e) => {
        if (n !== seq.current) return;
        // Eski durum kalmasın: girilmiş maaş için uyarı yeniden görünmez, beklenen gelir "—" olur
        setStatus(null);
        setError(errorMessage(e));
      })
      .finally(() => n === seq.current && setLoading(false));
  }, []);
  useEffect(reload, [reload, transactions, recurring, day]);
  const value = useMemo(() => ({ status, error, loading, reload }), [status, error, loading, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useIncomeStatus = () => useContext(Ctx);
