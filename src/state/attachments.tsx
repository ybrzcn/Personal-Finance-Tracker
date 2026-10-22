import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useData } from "./data";

interface AttachmentCounts {
  /** İşlem kimliği → ek sayısı */
  counts: Record<string, number>;
  reload(): void;
}

const Ctx = createContext<AttachmentCounts>({ counts: {}, reload: () => {} });

/** İşlem listesindeki ataç simgesi için ek sayıları; işlemler değişince ve ek eklenip silinince yeniden okunur */
export function AttachmentsProvider({ children }: { children: ReactNode }) {
  const { transactions, loading } = useData();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const reload = useCallback(() => {
    api
      .attachmentCounts()
      .then(setCounts)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!loading) reload();
  }, [loading, transactions, reload]);
  const value = useMemo(() => ({ counts, reload }), [counts, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAttachmentCounts = () => useContext(Ctx);
