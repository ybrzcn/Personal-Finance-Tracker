import { api } from "../lib/api";
import type { CategoryUsageReport, OverviewPeriod, OverviewReport } from "../lib/types";
import { useLiveReport } from "./cashPlan";

const fetchOverview = (period: OverviewPeriod) => api.overview(period);
const fetchUsage = () => api.categoryUsage();

/** Genel Bakış istatistikleri (Rust); dönem değişince yeni rapor gelene kadar boş (başka dönemin rakamı gösterilmez) */
export const useOverview = (period: OverviewPeriod) => useLiveReport<OverviewReport, OverviewPeriod>(period, fetchOverview, true);
/** Kategorilerin işlem sayısı ve tutar toplamı (Rust) */
export const useCategoryUsage = () => useLiveReport<CategoryUsageReport>(0, fetchUsage, true);
