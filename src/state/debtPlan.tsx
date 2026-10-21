import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { AppDataSettings, DebtPlanReport } from "../lib/types";
import { useLiveReport } from "./cashPlan";
import { useData } from "./data";
import { useSettings } from "./settings";

export type DebtSettingsPatch = Partial<Pick<AppDataSettings, "debtBudget" | "debtBudgetOverrides" | "debtRules" | "debtCells">>;

const fetchPlan = () => api.debtPlan();

/**
 * Borç planı (Rust). `save` ayarı yazar; herhangi bir ayar yazımı bitince (bu sayfadan ya da eski ayarların taşınması gibi
 * başka yerden; başarısız olsa da: ayar geri alınmıştır) rapor yeniden alınır.
 * Yazım başlayıp yeni rapor gelene kadar `refreshing`: rakamlar güncel değildir (sayfa soluk gösterir; tabloyu kaldırmaz
 * ki hücreden hücreye geçerken odak kaybolmasın).
 */
export function useDebtPlan() {
  const { update } = useSettings();
  const { settingsRev } = useData();
  const live = useLiveReport<DebtPlanReport>(0, fetchPlan);
  const { retry } = live;
  const [saving, setSaving] = useState(0);
  const [seenRev, setSeenRev] = useState(settingsRev);
  useEffect(() => {
    if (settingsRev === seenRev) return;
    setSeenRev(settingsRev);
    retry();
  }, [settingsRev, seenRev, retry]);
  const save = useCallback(
    async (patch: DebtSettingsPatch) => {
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
