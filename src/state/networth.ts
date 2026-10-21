import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { ratesKey } from "../lib/networth";
import type { NetWorthReport } from "../lib/types";
import { useData } from "./data";
import { useRates } from "./rates";

/** Net servet raporu (Rust); hesaplar, işlemler ya da kurlar değişince yeniden alınır. */
export function useNetWorth() {
  const { accounts, transactions } = useData();
  const { rates } = useRates();
  // Kur yoklaması aynı fiyatlarla yeni liste getirirse rapor yeniden hesaplanmaz
  const rateKey = useMemo(() => ratesKey(rates), [rates]);
  const [report, setReport] = useState<NetWorthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    api
      .netWorthReport()
      .then((r) => {
        if (n !== seq.current) return;
        setReport(r);
        setError(null);
      })
      .catch((e) => n === seq.current && setError(errorMessage(e)))
      .finally(() => n === seq.current && setLoading(false));
  }, []);
  useEffect(reload, [reload, accounts, transactions, rateKey]);
  return { report, error, loading, reload };
}
