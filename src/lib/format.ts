const pad = (n: number) => String(n).padStart(2, "0");

/** Date → YYYY-MM-DD (yerel saat diliminde) */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD → yerel Date (UTC kaymasını önler) */
export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

// Gün başında sıfır yok: "1 Kas 2027" (kısa biçim "1 Kas" ile tutarlı)
const dateFmt = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", year: "numeric" });
const monthFmt = new Intl.DateTimeFormat("tr-TR", { month: "short" });
const monthYearFmt = new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric" });

export const formatDate = (iso: string) => dateFmt.format(parseISODate(iso));
export const formatMonthShort = (d: Date) => monthFmt.format(d);
export const formatMonthYear = (d: Date) => monthYearFmt.format(d);

/**
 * Kullanıcı girdisini sayıya çevirir. Hem "1.234,56" (TR) hem "1,234.56" / "1234.56" biçimlerini kabul eder.
 * Geçersizse null döner.
 */
export function parseAmount(input: string): number | null {
  let s = input.replace(/[\s₺$€£]|TL|TRY/gi, "");
  if (!s) return null;
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Sonda gelen ayırıcı ondalık ayırıcıdır
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) && s.split(",").length > 2 ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (lastDot >= 0 && /^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ""); // 1.250 → binlik ayırıcı
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round((negative ? -n : n) * 100) / 100;
}

const inputFmt = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });

/** Form alanında göstermek için: 1234.5 → "1.234,50" (binlik ayraçlı; parseAmount geri okur) */
export function amountToInput(n: number): string {
  return inputFmt.format(n);
}

/** Yazılan tutarı alandan çıkınca biçimlendirir ("62000" → "62.000,00"); okunamıyorsa olduğu gibi bırakır. */
export function formatAmountInput(text: string): string {
  const v = parseAmount(text);
  return v === null || !text.trim() ? text : amountToInput(v);
}

/** İki YYYY-MM-DD arasındaki gün farkı (to − from). */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseISODate(toIso).getTime() - parseISODate(fromIso).getTime()) / 86_400_000);
}

const shortFmt = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short" });

/** "15 Eyl"; farklı yıldaysa "15 Eyl 2027" (dar alanlar için). */
export function formatDateShort(iso: string): string {
  return iso.slice(0, 4) === String(new Date().getFullYear()) ? shortFmt.format(parseISODate(iso)) : formatDate(iso);
}
