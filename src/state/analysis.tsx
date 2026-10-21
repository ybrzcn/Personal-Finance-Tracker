import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { AnalysisReport } from "../lib/types";
import { useLiveReport } from "./cashPlan";
import { useData } from "./data";
import { useSettings, type Settings } from "./settings";

const fetchAnalysis = () => api.analysis();

/**
 * Analiz raporu (Rust): abonelikler ve değişken gider tahmini. Veri, kategori ve gün değişikliğine ek olarak
 * bütçe ve ayar kaydında (abonelik düzeltmesi, tahmin kategorileri) yeniden alınır. `save` ile yapılan kayıt sürerken
 * `refreshing` doğrudur: eski rapordan açılan pencere kaydedilmekte olan değişikliğin üstüne yazmasın.
 */
export function useAnalysis() {
  const { settingsRev, budgets } = useData();
  const { update } = useSettings();
  const [saving, setSaving] = useState(0);
  const live = useLiveReport<AnalysisReport>(0, fetchAnalysis, true);
  const { retry } = live;
  const [seenRev, setSeenRev] = useState(settingsRev);
  useEffect(() => {
    if (settingsRev === seenRev) return;
    setSeenRev(settingsRev);
    retry();
  }, [settingsRev, seenRev, retry]);
  // İlk alma useLiveReport'ta; bütçe yalnız değişince
  const seenBudgets = useRef(budgets);
  useEffect(() => {
    if (seenBudgets.current === budgets) return;
    seenBudgets.current = budgets;
    retry();
  }, [budgets, retry]);
  const save = useCallback(
    async (patch: Partial<Settings>) => {
      setSaving((n) => n + 1);
      try {
        await update(patch);
      } finally {
        setSaving((n) => n - 1);
      }
    },
    [update],
  );
  return { ...live, refreshing: live.report !== null && (saving > 0 || live.loading || settingsRev !== seenRev), save };
}
