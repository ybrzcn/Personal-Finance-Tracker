import type { RateQuote } from "./types";

export type NetWorthRange = "1y" | "3y" | "all";

/** Kurların değer anahtarı: aynı fiyatlarla gelen yeni liste raporu yeniden hesaplatmasın */
export function ratesKey(rates: Map<string, RateQuote>): string {
  return [...rates.values()]
    .map((q) => `${q.code}:${q.buy}`)
    .sort()
    .join(",");
}
