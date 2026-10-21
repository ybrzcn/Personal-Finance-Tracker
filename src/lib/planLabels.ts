import type { Category, PlanIncomeEvent, PlanReceivedRow, RecurringItem, Transaction } from "./types";

/** Gelir satırlarının adlarını kurmak için veriler (ödeme satırlarının adı Rust'tan) */
export interface PlanNames {
  recurringById: Map<string, RecurringItem>;
  txById: Map<string, Transaction>;
  categoryById: Map<string, Category>;
}

export function incomeName(e: PlanIncomeEvent, n: PlanNames): string {
  if (e.recurringId) return n.recurringById.get(e.recurringId)?.name ?? "Gelir";
  return (e.transactionId && n.txById.get(e.transactionId)?.description) || "Tek seferlik gelir";
}

/** Gelirin notu: girilen tutar, tek seferlik ya da o aya özel istisna notu */
export function incomeNote(e: PlanIncomeEvent): string | null {
  if (e.entered) return "girilen tutar";
  if (e.oneTime) return "tek seferlik";
  return e.exceptionNote;
}

export function receivedName(r: PlanReceivedRow, n: PlanNames): string {
  const t = n.txById.get(r.transactionId);
  return t?.description || (t?.categoryId && n.categoryById.get(t.categoryId)?.name) || "Gelir";
}
