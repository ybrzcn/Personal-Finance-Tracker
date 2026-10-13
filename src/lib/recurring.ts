import { clampedDate } from "./cards";
import { addDays, parseISODate } from "./format";
import type { RecurringItem } from "./types";

/** Kayıt `date` tarihinde başlamış mı (başlangıç tarihinden önceki aylara uygulanmaz). */
export function hasStarted(item: RecurringItem, date: string): boolean {
  return !item.startDate || date >= item.startDate;
}

/** `date` (YYYY-MM-DD) tarihinde geçerli tutar: o tarihe kadar başlamış son değişiklik, yoksa ilk tutar. */
export function amountAt(item: RecurringItem, date: string): number {
  let amount = item.amount;
  for (const h of item.history ?? []) if (h.from <= date) amount = h.amount;
  return amount;
}

/**
 * Yatışın karşılık geldiği tarih: "önceki ayın karşılığı" olan gelirde bir ay öncesi (10 Ekim'de yatan → 10 Eylül,
 * yani Eylül maaşı). Zamlar ve "bu aya özel" istisnalar bu tarihe / aya göre girilir ve okunur.
 */
export function coverDate(item: RecurringItem, paidDate: string): string {
  // Hafta sonu kuralıyla komşu aya kaymış yatış, asıl ayının tarihine göre okunur (1 Kasım Pazar → 30 Ekim'de yatan Kasım maaşı)
  const month = scheduledMonth(item, paidDate);
  const base = month === paidDate.slice(0, 7) ? paidDate : clampedDate(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, item.day);
  if (!(item.type === "income" && item.coversPreviousMonth)) return base;
  return clampedDate(Number(base.slice(0, 4)), Number(base.slice(5, 7)) - 2, Number(base.slice(8, 10)));
}

/**
 * Tarihin ait olduğu plan ayı (YYYY-MM). Hafta sonu kuralı tarihi komşu aya taşıdıysa asıl ay döner
 * (1 Kasım Pazar, "önceki Cuma" → 30 Ekim tarihi Kasım'a aittir); düzenli kaydın tarihine denk gelmeyen
 * tarihlerde (ör. başka gün girilmiş işlem) tarihin kendi ayı.
 */
export function scheduledMonth(item: RecurringItem, date: string): string {
  const own = date.slice(0, 7);
  if (!item.weekendShift || item.weekendShift === "none" || occurrenceIn(item, own) === date) return own;
  for (const m of [shiftMonth(own, 1), shiftMonth(own, -1)]) if (occurrenceIn(item, m) === date) return m;
  return own;
}

/** `date` tarihindeki yatış/ödeme için tutar: karşılık geldiği aya özel istisna varsa o, yoksa geçerli tutar. */
export function amountForOccurrence(item: RecurringItem, date: string): number {
  const cover = coverDate(item, date);
  const ex = exceptionFor(item, cover.slice(0, 7));
  return ex ? ex.amount : amountAt(item, cover);
}

export function exceptionFor(item: RecurringItem, month: string) {
  return (item.exceptions ?? []).find((e) => e.month === month) ?? null;
}

/** `month` için istisnayı ekler/değiştirir; `amount` null ise istisnayı kaldırır. */
export function withException(item: RecurringItem, month: string, amount: number | null, note = ""): RecurringItem["exceptions"] {
  const rest = (item.exceptions ?? []).filter((e) => e.month !== month);
  return amount === null ? rest : [...rest, { month, amount, note }].sort((a, b) => a.month.localeCompare(b.month));
}

/** Düzenli kaydın `month` (YYYY-MM) içindeki tarihi (ay sonu kısıtlamalı). */
export function occurrenceIn(item: RecurringItem, month: string): string {
  const date = clampedDate(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, item.day);
  return shiftWeekend(date, item.weekendShift);
}

/** Hafta sonuna denk gelen tarihi kaydırır: "before" önceki Cuma, "after" sonraki Pazartesi. */
export function shiftWeekend(date: string, shift: RecurringItem["weekendShift"] | undefined): string {
  if (!shift || shift === "none") return date;
  const wd = parseISODate(date).getDay(); // 0 Pazar, 6 Cumartesi
  if (wd !== 0 && wd !== 6) return date;
  if (shift === "before") return addDays(date, wd === 6 ? -1 : -2);
  return addDays(date, wd === 6 ? 2 : 1);
}

/** `date`'ten sonra başlayacak ilk tutar değişikliği (gelecekteki zam vb.). */
export function nextChange(item: RecurringItem, date: string) {
  return (item.history ?? []).find((h) => h.from > date) ?? null;
}

/**
 * `from` tarihinden itibaren yeni tutarı uygular: o tarihte veya sonrasında başlayan eski
 * değişiklikler kaldırılır. `from` ilk kayıttan önce/aynıysa geçmiş tamamen yeni tutarla değiştirilir.
 */
export function withAmountFrom(item: RecurringItem, from: string | null, amount: number): Pick<RecurringItem, "amount" | "history"> {
  if (!from) return { amount, history: [] };
  const history = (item.history ?? []).filter((h) => h.from < from);
  return { amount: item.amount, history: [...history, { from, amount }] };
}

/** YYYY-MM ayını `delta` ay kaydırır. */
export function shiftMonth(ym: string, delta: number): string {
  const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Gelirin karşılık geldiği ay: "önceki ayın karşılığı" ise yattığı ayın bir öncesi. */
export function coverMonthOf(item: RecurringItem, paidDate: string): string {
  return coverDate(item, paidDate).slice(0, 7);
}

const monthNameFmt = new Intl.DateTimeFormat("tr-TR", { month: "long" });
/** "2026-09" → "Eylül" */
export function monthName(ym: string): string {
  const s = monthNameFmt.format(new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1));
  return s.charAt(0).toLocaleUpperCase("tr") + s.slice(1);
}
