import { addDays, todayISO, toISODate } from "./format";
import type { Transaction } from "./types";
import { t } from "./i18n";

export interface DateRange {
  from?: string;
  to?: string;
}

export type RangePreset = "thisMonth" | "lastMonth" | "last30" | "thisYear" | "all";

export const RANGE_LABEL: Record<RangePreset, string> = {
  thisMonth: t("Bu Ay"),
  lastMonth: t("Geçen Ay"),
  last30: t("Son 30 Gün"),
  thisYear: t("Bu Yıl"),
  all: t("Tümü"),
};

export function presetRange(preset: RangePreset, now = new Date()): DateRange {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case "thisMonth":
      return { from: toISODate(new Date(y, m, 1)), to: toISODate(new Date(y, m + 1, 0)) };
    case "lastMonth":
      return { from: toISODate(new Date(y, m - 1, 1)), to: toISODate(new Date(y, m, 0)) };
    case "last30": {
      const today = todayISO();
      return { from: addDays(today, -29), to: today };
    }
    case "thisYear":
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    case "all":
      return {};
  }
}

export const inRange = (date: string, r: DateRange) => (!r.from || date >= r.from) && (!r.to || date <= r.to);

export interface Totals {
  income: number;
  expense: number;
  net: number;
  count: number;
}

/** Kuruş üzerinden toplayarak kayan nokta hatalarını önler. */
export function totals(txs: Transaction[]): Totals {
  let inc = 0;
  let exp = 0;
  for (const tx of txs) {
    const c = Math.round(tx.amount * 100);
    if (tx.type === "income") inc += c;
    else if (tx.type === "expense") exp += c;
  }
  return { income: inc / 100, expense: exp / 100, net: (inc - exp) / 100, count: txs.length };
}

export interface CategorySlice {
  id: string;
  name: string;
  color: string;
  value: number;
}

export const UNCATEGORIZED = { name: t("Kategorisiz"), color: "#94a3b8" };

export interface MonthPoint {
  key: string;
  label: string;
  income: number;
  expense: number;
}

export interface MerchantRow {
  key: string;
  name: string;
  count: number;
  total: number;
}

