import { lang, locale } from "./i18n";

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

const istanbulDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" });

/** Bugün (YYYY-MM-DD), Türkiye saatiyle: sunucu ve masaüstü raporlarıyla aynı gün */
export function todayISO(): string {
  return istanbulDay.format(new Date());
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

// Gün başında sıfır yok: "1 Kas 2027" (kısa biçim "1 Kas" ile tutarlı)
const dateFmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
const monthFmt = new Intl.DateTimeFormat(locale, { month: "short" });
const monthYearFmt = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" });

export const formatDate = (iso: string) => dateFmt.format(parseISODate(iso));
export const formatMonthShort = (d: Date) => monthFmt.format(d);
export const formatMonthYear = (d: Date) => monthYearFmt.format(d);
/** "YYYY-MM" (ya da tarih) → kısa ay ve iki haneli yıl: "Eki 26" / "Oct 26" */
export const formatMonthYearShort = (ym: string) => `${formatMonthShort(parseISODate(`${ym.slice(0, 7)}-01`))} ${ym.slice(2, 4)}`;

/**
 * Kullanıcı girdisini sayıya çevirir (en çok `decimals` hane). Hem "1.234,56" (TR) hem "1,234.56" / "1234.56" kabul edilir;
 * tek ayırıcı arayüz diline göre okunur ("1.250" Türkçede 1250, İngilizcede 1,25).
 * Geçersizse null döner.
 */
export function parseDecimal(input: string, decimals: number, strict = false): number | null {
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
    // İngilizcede virgül binlik ayırıcıdır ("12,000"); Türkçede tek virgül ondalıktır
    const grouped = /^\d{1,3}(,\d{3})+$/.test(s) && (lang === "en" || s.split(",").length > 2);
    s = grouped ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (lastDot >= 0 && lang !== "en" && /^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ""); // 1.250 → binlik ayırıcı (İngilizcede nokta ondalıktır)
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  // Katı: izin verilenden fazla ondalık yuvarlanmaz, geçersiz sayılır (2,5 çeyrek → 3 olmasın)
  if (strict && (s.split(".")[1]?.length ?? 0) > decimals) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round((negative ? -n : n) * f) / f;
}

export const parseAmount = (input: string): number | null => parseDecimal(input, 2);

/** Döviz/altın miktarı: en çok `decimals` hane; fazlası geçersiz. */
export const parseQuantity = (input: string, decimals: number): number | null => parseDecimal(input, decimals, true);

const inputFmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });

/** Form alanında göstermek için: 1234.5 → "1.234,50" (binlik ayraçlı; parseAmount geri okur) */
export function amountToInput(n: number): string {
  return inputFmt.format(n);
}

/** Binlik ayraçsız ondalık sayı alanı için (oran, miktar): Türkçede "2,5", İngilizcede "2.5" */
export const decimalToInput = (n: number) => (lang === "en" ? String(n) : String(n).replace(".", ","));

/** Tutar alanı yer tutucusu ("0,00" / "0.00") */
export const ZERO_AMOUNT = amountToInput(0);

/** Yazılan tutarı alandan çıkınca biçimlendirir ("62000" → "62.000,00"); okunamıyorsa olduğu gibi bırakır. */
export function formatAmountInput(text: string): string {
  const v = parseAmount(text);
  return v === null || !text.trim() ? text : amountToInput(v);
}

const shortFmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });

/** "15 Eyl"; farklı yıldaysa "15 Eyl 2027" (dar alanlar için). */
export function formatDateShort(iso: string): string {
  return iso.slice(0, 4) === String(new Date().getFullYear()) ? shortFmt.format(parseISODate(iso)) : formatDate(iso);
}
