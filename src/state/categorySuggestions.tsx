import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { CategorySuggestions } from "../lib/types";
import { useLiveReport } from "./cashPlan";
import { useData } from "./data";

const fetchSuggestions = () => api.categorySuggestions();

/**
 * Kategorisiz işlemler için öneriler (Rust): işlem → kategori. Veri ve kategori değişikliğine ek olarak ayar kaydında
 * (kategori kuralları) yeniden alınır.
 */
export function useCategorySuggestions(): Map<string, string> {
  const { settingsRev } = useData();
  const live = useLiveReport<CategorySuggestions>(0, fetchSuggestions, true);
  const { retry, report } = live;
  const [seenRev, setSeenRev] = useState(settingsRev);
  useEffect(() => {
    if (settingsRev === seenRev) return;
    setSeenRev(settingsRev);
    retry();
  }, [settingsRev, seenRev, retry]);
  return useMemo(() => new Map((report?.suggestions ?? []).map((s) => [s.transactionId, s.categoryId])), [report]);
}
