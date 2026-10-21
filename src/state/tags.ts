import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { TagsReport } from "../lib/types";
import { useData } from "./data";

/** Etiket raporu (Rust); etiketler ya da işlemler değişince yeniden alınır. */
export function useTagsReport() {
  const { tags, transactions } = useData();
  const [report, setReport] = useState<TagsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    api
      .tagsReport()
      .then((r) => {
        if (n !== seq.current) return;
        setReport(r);
        setError(null);
      })
      .catch((e) => n === seq.current && setError(errorMessage(e)))
      .finally(() => n === seq.current && setLoading(false));
  }, []);
  useEffect(reload, [reload, tags, transactions]);
  return { report, error, loading, reload };
}
