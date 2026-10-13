import { bankSummary } from "./accounts";
import { cardDues, cardSummary } from "./cards";
import { addDays } from "./format";
import { DEFAULT_LOAN_TAX, effectiveMonthlyRate, loanSummary } from "./loans";
import type { Account, AccountKind, Transaction } from "./types";

/** Kredi kartı ve KMH faizine eklenen KKDF (%15) + BSMV (%15). */
export const REVOLVING_TAX = 30;

export interface Debt {
  id: string;
  name: string;
  kind: AccountKind;
  color: string;
  balanceCents: number;
  /** Vergi dahil aylık efektif faiz (oran) */
  monthlyRate: number;
  /** Kart: asgari oran (yüzde); KMH: yalnız faiz; kredi: sabit taksit */
  minRatePct: number | null;
  fixedPaymentCents: number | null;
  order: number;
  /**
   * Kart: borcun planın aylarına göre ödenecek kısımları (kuruş; 0 = 1. ay). Kesilmiş ekstre 1. aya, ileriki
   * ekstreler (taksitler) son ödeme tarihlerinin ayına düşer; henüz ekstreye girmemiş tutar faiz işletmez ve
   * "tamamını öde" yalnızca o aya düşeni öder. null: borcun tamamı ilk aydan ödenebilir (KMH, kredi).
   */
  billing: number[] | null;
}

/** Planın ay numarası (1 = ilk ay): varsayılan son ödeme tarihinin takvim ayı. */
export type DueBucket = (dueDate: string) => number;
const calendarBucket = (today: string): DueBucket => (due) => {
  const months = (Number(due.slice(0, 4)) - Number(today.slice(0, 4))) * 12 + Number(due.slice(5, 7)) - Number(today.slice(5, 7));
  return Math.max(1, months + 1);
};

export function debtsFromAccounts(accounts: Account[], txs: Transaction[], today: string, bucketOf?: DueBucket): Debt[] {
  const bucket = bucketOf ?? calendarBucket(today);
  const out: Debt[] = [];
  for (const a of accounts) {
    const base = { id: a.id, name: a.name, kind: a.kind, color: a.color, order: a.sortOrder, billing: null };
    if (a.kind === "credit_card") {
      const bal = cardSummary(a, txs, today).totalDebtCents;
      if (bal > 0) {
        const billing: number[] = [0];
        for (const due of cardDues(a, txs, today, addDays(today, 3700))) {
          const k = Math.max(1, bucket(due.dueDate)) - 1;
          while (billing.length <= k) billing.push(0);
          billing[k] += due.amountCents;
        }
        // Ekstrelere dağılmayan fark (iade, kesim tarihi eksik vb.) ilk aya
        billing[0] = Math.max(0, billing[0] + bal - billing.reduce((x, y) => x + y, 0));
        out.push({
          ...base,
          balanceCents: bal,
          monthlyRate: effectiveMonthlyRate(a.interestRate, REVOLVING_TAX),
          minRatePct: a.minPaymentRate ?? 20,
          fixedPaymentCents: null,
          billing,
        });
      }
    } else if (a.kind === "bank") {
      const used = bankSummary(a, txs, today).overdraftUsedCents;
      if (used > 0)
        out.push({ ...base, name: `${a.name} (KMH)`, balanceCents: used, monthlyRate: effectiveMonthlyRate(a.interestRate, REVOLVING_TAX), minRatePct: null, fixedPaymentCents: null });
    } else if (a.kind === "loan") {
      const s = loanSummary(a, txs);
      if (s.remainingCents > 0)
        out.push({
          ...base,
          balanceCents: s.remainingCents,
          monthlyRate: effectiveMonthlyRate(a.interestRate, a.taxRate ?? DEFAULT_LOAN_TAX),
          minRatePct: null,
          fixedPaymentCents: s.next?.paymentCents ?? s.remainingCents,
        });
    }
  }
  return out;
}

export type Strategy = "avalanche" | "snowball" | "custom" | "minimum" | "manual";

export const STRATEGY_LABEL: Record<Strategy, string> = {
  avalanche: "En yüksek faizliden başla (Çığ)",
  snowball: "En küçük borçtan başla (Kartopu)",
  custom: "Benim sıramla (hesap sırası)",
  minimum: "Yalnız asgari / taksit",
  manual: "Kendi planım",
};

/** "Kendi planım"da borç başına ödeme kuralı. */
export type DebtRuleMode = "full" | "minimum" | "fixed" | "none";
export interface DebtRule {
  mode: DebtRuleMode;
  /** Yalnız "fixed": aylık tutar (TL) */
  amount?: number;
}

export const DEBT_RULE_LABEL: Record<DebtRuleMode, string> = {
  full: "Tam öde",
  minimum: "Asgari",
  fixed: "Sabit tutar",
  none: "Ödeme yok",
};

/** Varsayılan kural: kartlar her ay tam, KMH ve krediler asgari/taksit. */
// "Kendi planım" boş başlar: kural seçilmeyen ve hücresine tutar yazılmayan borca ödeme yapılmaz
export const defaultDebtRule = (_d: Debt): DebtRule => ({ mode: "none" });

export interface MonthPlan {
  month: number;
  payments: Record<string, number>;
  interest: Record<string, number>;
  balances: Record<string, number>;
}

export interface SimResult {
  strategy: Strategy;
  /** Tüm borçların kapandığı ay sayısı; kapanmadıysa null */
  months: number | null;
  totalInterestCents: number;
  totalPaidCents: number;
  payoffMonth: Record<string, number | null>;
  timeline: MonthPlan[];
  /** Asgari ödemeler bütçeyi aştı */
  budgetShort: boolean;
}

/**
 * Simülasyon defteri: `billed` ödenmesi gelmiş (faiz işleyen) bakiye, `future` ileriki aylara düşecek kısımlar.
 * Her ayın başında o aya düşen kısım ödenecek bakiyeye eklenir.
 */
function ledger(debts: Debt[]) {
  const billed: Record<string, number> = {};
  const future: Record<string, number[]> = {};
  for (const d of debts) {
    billed[d.id] = d.billing ? (d.billing[0] ?? 0) : d.balanceCents;
    future[d.id] = d.billing ? d.billing.slice(1) : [];
  }
  const total = (id: string) => billed[id] + future[id].reduce((a, b) => a + b, 0);
  return {
    billed,
    total,
    advance(month: number) {
      if (month > 1) for (const d of debts) billed[d.id] += future[d.id].shift() ?? 0;
    },
    balances: () => Object.fromEntries(debts.map((d) => [d.id, total(d.id)])),
  };
}

function minimumDue(d: Debt, balance: number, interest: number): number {
  if (d.fixedPaymentCents !== null) return Math.min(balance, d.fixedPaymentCents);
  // Bankalar küçük bakiyelerde tamamını ister; 100 TL taban, yuvarlama yüzünden borcun hiç bitmemesini önler
  if (d.minRatePct !== null) return Math.min(balance, Math.max(Math.round((balance * d.minRatePct) / 100), interest + 1, 10000));
  return Math.min(balance, interest); // KMH: en az faiz
}

/**
 * Aylık simülasyon: önce faiz eklenir, sonra her borca asgari/taksit ödenir, bütçeden artan
 * tutar stratejinin sırasıyla borçlara aktarılır. Krediler (erken kapama masrafı nedeniyle)
 * ek ödeme sırasında en sona bırakılır.
 */
export function simulate(
  debts: Debt[],
  /** Sabit aylık tutar veya ay numarasına (1 = bu ay) göre tutar */
  monthlyBudget: number | ((month: number) => number),
  strategy: Strategy,
  maxMonths = 360,
): SimResult {
  const budgetFor = typeof monthlyBudget === "function" ? monthlyBudget : () => monthlyBudget;
  const book = ledger(debts);
  const bal = book.billed;
  const payoffMonth: Record<string, number | null> = Object.fromEntries(debts.map((d) => [d.id, d.balanceCents > 0 ? null : 0]));
  const timeline: MonthPlan[] = [];
  let totalInterest = 0;
  let totalPaid = 0;
  let budgetShort = false;

  const priority = (d: Debt) => (d.kind === "loan" ? 1 : 0);
  const order = [...debts].sort((a, b) => {
    if (priority(a) !== priority(b)) return priority(a) - priority(b);
    if (strategy === "avalanche") return b.monthlyRate - a.monthlyRate || bal[a.id] - bal[b.id];
    if (strategy === "snowball") return bal[a.id] - bal[b.id] || b.monthlyRate - a.monthlyRate;
    return a.order - b.order;
  });

  for (let month = 1; month <= maxMonths; month++) {
    book.advance(month);
    const live = debts.filter((d) => book.total(d.id) > 0);
    if (!live.length) return { strategy, months: month - 1, totalInterestCents: totalInterest, totalPaidCents: totalPaid, payoffMonth, timeline, budgetShort };
    const payments: Record<string, number> = {};
    const interest: Record<string, number> = {};
    for (const d of live) {
      const i = Math.round(bal[d.id] * d.monthlyRate);
      interest[d.id] = i;
      bal[d.id] += i;
      totalInterest += i;
    }
    let spent = 0;
    for (const d of live) {
      const p = minimumDue(d, bal[d.id], interest[d.id]);
      payments[d.id] = p;
      bal[d.id] -= p;
      spent += p;
    }
    if (strategy !== "minimum") {
      const monthlyBudgetCents = budgetFor(month);
      if (spent > monthlyBudgetCents) budgetShort = true;
      let extra = Math.max(0, monthlyBudgetCents - spent);
      for (const d of order) {
        if (extra <= 0) break;
        const p = Math.min(extra, bal[d.id]);
        if (p <= 0) continue;
        payments[d.id] = (payments[d.id] ?? 0) + p;
        bal[d.id] -= p;
        extra -= p;
        spent += p;
      }
    }
    // Ödenmesi gelen bakiyesi bu ay tamamen kapanan borca faiz işlemez ("Kendi planım" ile aynı kural)
    for (const d of live) {
      const i = interest[d.id];
      if (i > 0 && bal[d.id] === 0 && (payments[d.id] ?? 0) >= i) {
        payments[d.id] -= i;
        spent -= i;
        totalInterest -= i;
        interest[d.id] = 0;
      }
    }
    totalPaid += spent;
    for (const d of live) if (book.total(d.id) === 0 && payoffMonth[d.id] === null) payoffMonth[d.id] = month;
    if (timeline.length < 60) timeline.push({ month, payments, interest, balances: book.balances() });
  }
  const done = debts.every((d) => book.total(d.id) === 0);
  return { strategy, months: done ? maxMonths : null, totalInterestCents: totalInterest, totalPaidCents: totalPaid, payoffMonth, timeline, budgetShort };
}

/**
 * "Kendi planım": her borç kendi kuralıyla ödenir (tam / asgari / sabit / hiç); `cell` ile belirli bir
 * ayın belirli borcuna elle tutar girilebilir (kuruş). Faiz her ay ödemeden önce eklenir.
 */
export function simulateManual(
  debts: Debt[],
  rules: Record<string, DebtRule>,
  cell: (month: number, debtId: string) => number | undefined,
  maxMonths = 360,
): SimResult {
  const book = ledger(debts);
  const bal = book.billed;
  const payoffMonth: Record<string, number | null> = Object.fromEntries(debts.map((d) => [d.id, d.balanceCents > 0 ? null : 0]));
  const timeline: MonthPlan[] = [];
  let totalInterest = 0;
  let totalPaid = 0;
  for (let month = 1; month <= maxMonths; month++) {
    book.advance(month);
    const live = debts.filter((d) => book.total(d.id) > 0);
    if (!live.length) return { strategy: "manual", months: month - 1, totalInterestCents: totalInterest, totalPaidCents: totalPaid, payoffMonth, timeline, budgetShort: false };
    const payments: Record<string, number> = {};
    const interest: Record<string, number> = {};
    for (const d of live) {
      const manual = cell(month, d.id);
      const rule = rules[d.id] ?? defaultDebtRule(d);
      // Borcun tamamı ödenirse (ör. kart ekstresi son ödemeye kadar tam) faiz işlemez
      const paysInFull = manual !== undefined ? manual >= bal[d.id] : rule.mode === "full";
      const i = paysInFull ? 0 : Math.round(bal[d.id] * d.monthlyRate);
      interest[d.id] = i;
      bal[d.id] += i;
      totalInterest += i;
      let p: number;
      if (manual !== undefined) p = manual;
      else if (rule.mode === "full") p = bal[d.id];
      else if (rule.mode === "fixed") p = Math.round((rule.amount ?? 0) * 100);
      else if (rule.mode === "none") p = 0;
      else p = minimumDue(d, bal[d.id], i);
      p = Math.max(0, Math.min(p, bal[d.id]));
      payments[d.id] = p;
      bal[d.id] -= p;
      totalPaid += p;
      if (book.total(d.id) === 0 && payoffMonth[d.id] === null) payoffMonth[d.id] = month;
    }
    if (timeline.length < 60) timeline.push({ month, payments, interest, balances: book.balances() });
  }
  const done = debts.every((d) => book.total(d.id) === 0);
  return { strategy: "manual", months: done ? maxMonths : null, totalInterestCents: totalInterest, totalPaidCents: totalPaid, payoffMonth, timeline, budgetShort: false };
}

/** Bütün borçlar için asgari/taksit toplamı (ilk ay). */
export function minimumMonthlyCents(debts: Debt[]): number {
  return debts.reduce((s, d) => {
    const due = d.billing ? (d.billing[0] ?? 0) : d.balanceCents;
    const i = Math.round(due * d.monthlyRate);
    return s + minimumDue(d, due + i, i);
  }, 0);
}
