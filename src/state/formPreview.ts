import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Form önizlemesi (Rust): taslak her değiştiğinde hemen sorulur; yalnız en son isteğin cevabı uygulanır, yeni cevap
 * gelene kadar öncekisi kalır (gösterge yok). Alınamazsa `preview` null, `failed` true.
 * `latest` kayıtta son taslağın taze hesabını alır (eski girdinin sonucu kaydedilmesin). `source` önizlemenin taslağıdır.
 */
export function useFormPreview<D, P>(draft: D | null, fetch: (d: D) => Promise<P>) {
  const [state, setState] = useState<{ preview: P; source: D } | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const key = draft === null ? null : JSON.stringify(draft);
  useEffect(() => {
    const n = ++seq.current;
    if (key === null) {
      setState(null);
      return;
    }
    const source = JSON.parse(key) as D;
    fetchRef.current(source).then(
      (preview) => {
        if (n !== seq.current) return;
        setState({ preview, source });
        setFailed(false);
      },
      () => {
        if (n !== seq.current) return;
        setState(null);
        setFailed(true);
      },
    );
  }, [key]);
  const latest = useCallback((d: D) => fetchRef.current(d), []);
  return { preview: state?.preview ?? null, source: state?.source ?? null, failed, latest };
}
