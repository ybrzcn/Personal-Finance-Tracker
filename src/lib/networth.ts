import type { RateQuote } from "./types";

export type NetWorthRange = "1y" | "3y" | "all";

/**
 * Seçili dönemin noktaları. Başlangıç, kesim gününden (bugünden 1/3 yıl önce) önceki ya da o günkü son noktadır;
 * böylece "son 1 yılda" değişimi tam dönemi ölçer.
 */
export function rangePoints<T extends { date: string }>(points: T[], range: NetWorthRange): T[] {
  const today = points.at(-1)?.date;
  if (range === "all" || !today) return points;
  const cutoff = `${Number(today.slice(0, 4)) - (range === "1y" ? 1 : 3)}${today.slice(4)}`;
  let start = 0;
  points.forEach((p, i) => {
    if (p.date <= cutoff) start = i;
  });
  return points.slice(start);
}

/** Kurların değer anahtarı: aynı fiyatlarla gelen yeni liste raporu yeniden hesaplatmasın */
export function ratesKey(rates: Map<string, RateQuote>): string {
  return [...rates.values()]
    .map((q) => `${q.code}:${q.buy}`)
    .sort()
    .join(",");
}
