import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { BudgetReport } from "../lib/types";
import { useData } from "./data";

/**
 * Bütçe sayfasının seçili ay raporu (Rust). Ay ya da bütçeyi etkileyen veri değişince yeniden alınır; yalnız son
 * isteğin yanıtı yazılır. Başka ayın raporu ya da hata varken `report` boştur (eski rakam gösterilmez).
 */
export function useBudgetReport(month: string) {
  const { accounts, transactions, recurring, budgets, categories } = useData();
  const [report, setReport] = useState<BudgetReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const retry = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    api
      .budgetReport(month)
      .then((r) => n === seq.current && setReport(r))
      .catch((e) => {
        if (n !== seq.current) return;
        // Tekrar denenirken veri değişikliğinden önceki rapor yeniden görünmesin
        setReport(null);
        setError(errorMessage(e));
      })
      .finally(() => n === seq.current && setLoading(false));
  }, [month]);
  useEffect(retry, [retry, accounts, transactions, recurring, budgets, categories]);
  // Yeni ay için istek effect'te başlar; o ana kadar da "bekleniyor" sayılır ("—" yanıp sönmesin)
  const pending = !error && report?.month !== month;
  return { report: !error && report?.month === month ? report : null, error, loading: loading || pending, retry };
}
