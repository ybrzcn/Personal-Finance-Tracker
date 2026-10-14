import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, errorMessage } from "../lib/api";
import type { AccountPnl } from "../lib/types";
import { useData } from "./data";
import { useRates } from "./rates";

interface PnlSummary {
  byAccount: Map<string, AccountPnl>;
  error: string | null;
}

const Ctx = createContext<PnlSummary>({ byAccount: new Map(), error: null });

/** Hesap kartları için tüm zamanlar raporu; veri ya da kurlar değişince Rust'tan yeniden istenir. */
export function PnlProvider({ children }: { children: ReactNode }) {
  const { accounts, transactions } = useData();
  const { rates } = useRates();
  const [state, setState] = useState<PnlSummary>({ byAccount: new Map(), error: null });
  const hasForeign = accounts.some((a) => a.currency && a.currency !== "TRY");
  useEffect(() => {
    if (!hasForeign) return;
    let live = true;
    api
      .pnlReport(null, null)
      .then((r) => live && setState({ byAccount: new Map(r.accounts.map((a) => [a.accountId, a])), error: null }))
      .catch((e) => live && setState({ byAccount: new Map(), error: errorMessage(e) }));
    return () => {
      live = false;
    };
  }, [hasForeign, accounts, transactions, rates]);
  const value = useMemo(() => state, [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const usePnlSummary = () => useContext(Ctx);
