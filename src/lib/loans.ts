import { clampedDate, toCents } from "./cards";
import type { Account, Transaction } from "./types";

/** Tüketici kredilerinde faize eklenen KKDF (%15) + BSMV (%15). */
export const DEFAULT_LOAN_TAX = 30;

/** Vergi dahil aylık efektif faiz (oran, ör. 0.0429). */
export const effectiveMonthlyRate = (ratePct: number | null, taxPct: number | null) =>
  ((ratePct ?? 0) / 100) * (1 + (taxPct ?? 0) / 100);

/** Eşit taksitli (anüite) aylık ödeme, kuruş. */
export function annuityPaymentCents(principalCents: number, monthlyRate: number, n: number): number {
  if (n <= 0) return 0;
  if (monthlyRate === 0) return Math.ceil(principalCents / n);
  return Math.round((principalCents * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -n)));
}

export interface CashAdvancePlan {
  /** Taksit tutarları (son taksit kuruş farkını alır) */
  paymentsCents: number[];
  totalCents: number;
  interestCents: number;
  kkdfCents: number;
  bsmvCents: number;
}

/**
 * Taksitli nakit avans ödeme planı (bankaların kullandığı yöntem): ilk dönemin faizi çekimden ilk taksite kadar
 * geçen gün sayısıyla (gün/30), sonrakiler aylık; KKDF ve BSMV faizin %15'er'i; taksitler eşit, son taksit farkı kapatır.
 */
export function cashAdvancePlan(principalCents: number, monthlyRate: number, n: number, firstPeriodDays = 30): CashAdvancePlan {
  const days = Math.max(0, firstPeriodDays);
  const re = monthlyRate * 1.3;
  const rest = re > 0 ? (1 - Math.pow(1 + re, -(n - 1))) / re : n - 1;
  const pmt = Math.round((principalCents * (1 + (re * days) / 30)) / (1 + rest));
  const plan: CashAdvancePlan = { paymentsCents: [], totalCents: 0, interestCents: 0, kkdfCents: 0, bsmvCents: 0 };
  let balance = principalCents;
  for (let i = 0; i < n; i++) {
    const interest = Math.round(balance * monthlyRate * (i === 0 ? days / 30 : 1));
    const tax = Math.round(interest * 0.15);
    const principal = i === n - 1 ? balance : Math.min(balance, pmt - interest - 2 * tax);
    balance -= principal;
    plan.paymentsCents.push(principal + interest + 2 * tax);
    plan.interestCents += interest;
    plan.kkdfCents += tax;
    plan.bsmvCents += tax;
  }
  plan.totalCents = plan.paymentsCents.reduce((a, b) => a + b, 0);
  return plan;
}

export interface LoanRow {
  /** 1'den başlar */
  index: number;
  date: string;
  paymentCents: number;
  interestCents: number;
  principalCents: number;
  /** Bu taksitten sonra kalan anapara */
  balanceCents: number;
}

/**
 * Ödeme planı. Kredi hesabında açılış tutarı kalan anapara, vade kalan taksit sayısı ve
 * ilk taksit tarihi bir sonraki taksit tarihi olarak girilir.
 */
export function loanSchedule(account: Account): LoanRow[] {
  const n = account.termMonths ?? 0;
  const first = account.firstDueDate;
  if (!n || !first) return [];
  const principal = toCents(account.openingBalance);
  const r = effectiveMonthlyRate(account.interestRate, account.taxRate ?? DEFAULT_LOAN_TAX);
  const pay = account.installmentAmount ? toCents(account.installmentAmount) : annuityPaymentCents(principal, r, n);
  const y = Number(first.slice(0, 4));
  const m = Number(first.slice(5, 7)) - 1;
  const day = Number(first.slice(8, 10));
  const rows: LoanRow[] = [];
  let bal = principal;
  for (let k = 0; k < n && bal > 0; k++) {
    const interest = Math.round(bal * r);
    let principalPart = Math.max(0, pay - interest);
    let payment = pay;
    if (k === n - 1 || principalPart >= bal) {
      principalPart = bal;
      payment = bal + interest;
    }
    bal -= principalPart;
    rows.push({ index: k + 1, date: clampedDate(y, m + k, day), paymentCents: payment, interestCents: interest, principalCents: principalPart, balanceCents: bal });
  }
  return rows;
}

/** Borç hesabı bakiyesi: açılış + giderler + giden transferler − gelirler − gelen transferler (ödemeler). */
export function liabilityBalanceCents(account: Account, txs: Transaction[]): number {
  let b = toCents(account.openingBalance);
  for (const t of txs) {
    const c = toCents(t.amount);
    if (t.accountId === account.id) b += t.type === "income" ? -c : c;
    if (t.type === "transfer" && t.toAccountId === account.id) b -= c;
  }
  return b;
}

export interface LoanSummary {
  schedule: LoanRow[];
  remainingCents: number;
  /** Ödenmiş sayılan taksit sayısı (kalan anaparaya göre) */
  paidCount: number;
  next: LoanRow | null;
  remainingInterestCents: number;
}

export function loanSummary(account: Account, txs: Transaction[]): LoanSummary {
  const schedule = loanSchedule(account);
  const remainingCents = Math.max(0, liabilityBalanceCents(account, txs));
  // Kalan anaparadan küçük "taksit sonrası bakiye"ye sahip ilk satır sıradaki taksittir
  let paidCount = remainingCents === 0 ? schedule.length : schedule.findIndex((row) => row.balanceCents < remainingCents);
  if (paidCount < 0) paidCount = schedule.length;
  const rest = schedule.slice(paidCount);
  return {
    schedule,
    remainingCents,
    paidCount,
    next: rest[0] ?? null,
    remainingInterestCents: rest.reduce((s, r) => s + r.interestCents, 0),
  };
}
