import { formatQty, TRY } from "./fx";
import type { GoalStatus } from "./types";

/** Hedefe bağlanabilen hesap türleri (döviz/altın/fon hesapları da bu türlerde) */
export const GOAL_ACCOUNT_KINDS = new Set(["bank", "cash"]);

export const STATUS_LABEL: Record<GoalStatus, string> = {
  reached: "Ulaşıldı",
  on_track: "Yolunda",
  behind: "Geride",
  unknown: "Bilinmiyor",
};

export const STATUS_TONE: Record<GoalStatus, string> = {
  reached: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  on_track: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  behind: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  unknown: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

/** TL uygulamanın para biçimiyle; döviz/altın miktar biçimiyle */
export const formatGoalAmount = (v: number, code: string, money: (n: number) => string): string =>
  code === TRY ? money(v) : formatQty(v, code);

const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
export const monthYear = (iso: string): string => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
