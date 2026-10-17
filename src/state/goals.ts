import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { ratesKey } from "../lib/networth";
import { backend } from "../lib/platform";
import type { GoalsReport } from "../lib/types";
import { useData } from "./data";
import { useRates } from "./rates";

/** Hedef raporu (Rust); hedefler, hesaplar, işlemler ya da kurlar değişince yeniden alınır. Tarayıcı modunda yok. */
export function useGoals() {
  const { goals, accounts, transactions } = useData();
  const { rates } = useRates();
  // Kur yoklaması aynı fiyatlarla yeni liste getirirse rapor yeniden hesaplanmaz
  const rateKey = useMemo(() => ratesKey(rates), [rates]);
  const [report, setReport] = useState<GoalsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(backend !== "local");
  const seq = useRef(0);
  const reload = useCallback(() => {
    if (backend === "local") return;
    const n = ++seq.current;
    setLoading(true);
    api
      .goalsReport()
      .then((r) => {
        if (n !== seq.current) return;
        setReport(r);
        setError(null);
      })
      .catch((e) => n === seq.current && setError(errorMessage(e)))
      .finally(() => n === seq.current && setLoading(false));
  }, []);
  useEffect(reload, [reload, goals, accounts, transactions, rateKey]);
  return { report, error, loading, reload };
}
