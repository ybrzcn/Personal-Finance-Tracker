const monthNameFmt = new Intl.DateTimeFormat("tr-TR", { month: "long" });
/** "2026-09" → "Eylül" */
export function monthName(ym: string): string {
  const s = monthNameFmt.format(new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1));
  return s.charAt(0).toLocaleUpperCase("tr") + s.slice(1);
}
