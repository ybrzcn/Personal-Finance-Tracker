import type { BudgetStatus } from "./types";

export const BUDGET_LABEL: Record<BudgetStatus, string> = { ok: "Uygun", near: "Yaklaşıyor", over: "Aşıldı" };
export const BUDGET_TONE: Record<BudgetStatus, string> = {
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  near: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  over: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

/** Türkçe büyük/küçük harf duyarsız anahtar (Rust'taki kuralın aynısı; yalnız öneri araması için) */
export const tagKey = (name: string): string => name.trim().replace(/I/g, "ı").replace(/İ/g, "i").toLocaleLowerCase("tr");
