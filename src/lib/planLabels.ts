import type { Category, PlanIncomeEvent, PlanReceivedRow, RecurringItem, Transaction } from "./types";
import { t } from "./i18n";

/** Gelir satırlarının adlarını kurmak için veriler (ödeme satırlarının adı Rust'tan) */
export interface PlanNames {
  recurringById: Map<string, RecurringItem>;
  txById: Map<string, Transaction>;
  categoryById: Map<string, Category>;
}

export function incomeName(e: PlanIncomeEvent, n: PlanNames): string {
  if (e.recurringId) return n.recurringById.get(e.recurringId)?.name ?? t("Gelir");
  return (e.transactionId && n.txById.get(e.transactionId)?.description) || t("Tek seferlik gelir");
}

/** Gelirin notu: girilen tutar, tek seferlik ya da o aya özel istisna notu */
export function incomeNote(e: PlanIncomeEvent): string | null {
  if (e.entered) return t("girilen tutar");
  if (e.oneTime) return t("tek seferlik");
  return e.exceptionNote;
}

export function receivedName(r: PlanReceivedRow, n: PlanNames): string {
  const tx = n.txById.get(r.transactionId);
  return tx?.description || (tx?.categoryId && n.categoryById.get(tx.categoryId)?.name) || t("Gelir");
}
