import { addDays, formatMonthShort, todayISO, toISODate } from "./format";
import type { Category, CategoryType, Transaction } from "./types";

export interface DateRange {
  from?: string;
  to?: string;
}

export type RangePreset = "thisMonth" | "lastMonth" | "last30" | "thisYear" | "all";

export const RANGE_LABEL: Record<RangePreset, string> = {
  thisMonth: "Bu Ay",
  lastMonth: "Geçen Ay",
  last30: "Son 30 Gün",
  thisYear: "Bu Yıl",
  all: "Tümü",
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
  for (const t of txs) {
    const c = Math.round(t.amount * 100);
    if (t.type === "income") inc += c;
    else if (t.type === "expense") exp += c;
  }
  return { income: inc / 100, expense: exp / 100, net: (inc - exp) / 100, count: txs.length };
}

export interface CategorySlice {
  id: string;
  name: string;
  color: string;
  value: number;
}

export const UNCATEGORIZED = { name: "Kategorisiz", color: "#94a3b8" };

export function byCategory(
  txs: Transaction[],
  type: CategoryType,
  categoryById: Map<string, Category>,
): CategorySlice[] {
  const sums = new Map<string, number>();
  for (const t of txs) {
    if (t.type !== type) continue;
    const key = t.categoryId && categoryById.has(t.categoryId) ? t.categoryId : "__none__";
    sums.set(key, (sums.get(key) ?? 0) + Math.round(t.amount * 100));
  }
  return [...sums.entries()]
    .map(([id, cents]) => {
      const c = categoryById.get(id);
      return {
        id,
        name: c?.name ?? UNCATEGORIZED.name,
        color: c?.color ?? UNCATEGORIZED.color,
        value: cents / 100,
      };
    })
    .sort((a, b) => b.value - a.value);
}

export interface MonthPoint {
  key: string;
  label: string;
  income: number;
  expense: number;
}

export function monthlySeries(txs: Transaction[], months = 6, now = new Date()): MonthPoint[] {
  const points: MonthPoint[] = [];
  const index = new Map<string, MonthPoint>();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = toISODate(d).slice(0, 7);
    const p = { key, label: formatMonthShort(d), income: 0, expense: 0 };
    points.push(p);
    index.set(key, p);
  }
  for (const t of txs) {
    const p = index.get(t.date.slice(0, 7));
    if (!p) continue;
    if (t.type === "income") p.income += t.amount;
    else if (t.type === "expense") p.expense += t.amount;
  }
  for (const p of points) {
    p.income = Math.round(p.income * 100) / 100;
    p.expense = Math.round(p.expense * 100) / 100;
  }
  return points;
}

export const sortTransactions = (a: Transaction, b: Transaction) =>
  b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt);

/** Bir önceki eşdeğer dönem (karşılaştırma için); "Tümü" için yok. */
export function previousRange(preset: RangePreset, now = new Date()): DateRange | null {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case "thisMonth":
      return { from: toISODate(new Date(y, m - 1, 1)), to: toISODate(new Date(y, m, 0)) };
    case "lastMonth":
      return { from: toISODate(new Date(y, m - 2, 1)), to: toISODate(new Date(y, m - 1, 0)) };
    case "last30": {
      const today = todayISO();
      return { from: addDays(today, -59), to: addDays(today, -30) };
    }
    case "thisYear":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "all":
      return null;
  }
}

/** Hesaplara göre gider dağılımı (kart, banka, nakit). */
export function byAccount(txs: Transaction[], accountById: Map<string, { name: string; color: string }>): CategorySlice[] {
  const sums = new Map<string, number>();
  for (const t of txs) {
    if (t.type !== "expense") continue;
    sums.set(t.accountId, (sums.get(t.accountId) ?? 0) + Math.round(t.amount * 100));
  }
  return [...sums.entries()]
    .map(([id, cents]) => {
      const a = accountById.get(id);
      return { id, name: a?.name ?? "Silinmiş hesap", color: a?.color ?? UNCATEGORIZED.color, value: cents / 100 };
    })
    .sort((a, b) => b.value - a.value);
}

export interface MerchantRow {
  key: string;
  name: string;
  count: number;
  total: number;
}

/** Açıklamadan harcama yeri adı: kod/numara parçaları atılır, ilk iki kelime alınır. */
export function merchantName(description: string): string {
  const words = description
    .trim()
    .split(/\s+/)
    // Sipariş/işlem kodları (harf+rakam karışık uzun parçalar, uzun sayılar) atılır; "A101" gibi adlar kalır
    .filter((w) => w && !/^\d{4,}$/.test(w) && !(w.length >= 6 && /\d/.test(w) && /[a-zçğıöşü]/i.test(w)))
    .map((w) => w.replace(/^[+*#]+/, ""))
    .filter(Boolean);
  // İlk iki kelime: "nakit avans faizi/KKDF/BSMV" gibi kalemler tek yerde toplanır
  return (words.slice(0, 2).join(" ") || description.trim() || "Açıklamasız").replace(/[*\-–]+$/, "").trim();
}

/**
 * Açıklamaya göre en çok harcama yapılan yerler. Açıklamadaki sipariş/işlem numaraları gibi rakam ve
 * kod parçaları birleştirilir ("MUZIK ABONELIK X12AB34CD" → "MUZIK ABONELIK").
 */
export function topMerchants(txs: Transaction[], limit = 30): MerchantRow[] {
  const groups = new Map<string, MerchantRow>();
  for (const t of txs) {
    if (t.type !== "expense") continue;
    const name = merchantName(t.description);
    const key = name.toLocaleUpperCase("tr");
    const row = groups.get(key) ?? { key, name, count: 0, total: 0 };
    row.count++;
    row.total = Math.round((row.total + t.amount) * 100) / 100;
    groups.set(key, row);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}
