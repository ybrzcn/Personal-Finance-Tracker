import { addDays } from "./format";
import type { Account, Transaction } from "./types";

const pad = (n: number) => String(n).padStart(2, "0");

export const toCents = (n: number) => Math.round(n * 100);

/** Ayın `day`. günü; ayda o gün yoksa ayın son günü. `monthIndex` taşabilir (12 → ertesi yıl Ocak). */
export function clampedDate(year: number, monthIndex: number, day: number): string {
  const first = new Date(year, monthIndex, 1);
  const y = first.getFullYear();
  const m = first.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  return `${y}-${pad(m + 1)}-${pad(Math.min(day, last))}`;
}

const ym = (iso: string) => [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1] as const;

/** `iso` tarihini içeren dönemin kesim tarihi (iso ≤ kesim). */
export function closingOnOrAfter(iso: string, statementDay: number): string {
  const [y, m] = ym(iso);
  const c = clampedDate(y, m, statementDay);
  return c >= iso ? c : clampedDate(y, m + 1, statementDay);
}

/** `iso` tarihinde veya öncesindeki son kesim tarihi. */
export function closingOnOrBefore(iso: string, statementDay: number): string {
  const [y, m] = ym(iso);
  const c = clampedDate(y, m, statementDay);
  return c <= iso ? c : clampedDate(y, m - 1, statementDay);
}

export function shiftClosing(closing: string, months: number, statementDay: number): string {
  const [y, m] = ym(closing);
  return clampedDate(y, m + months, statementDay);
}

/** Kesim tarihinden sonraki ilk `dueDay`. */
export function dueDateFor(closing: string, dueDay: number): string {
  const [y, m] = ym(closing);
  const c = clampedDate(y, m, dueDay);
  return c > closing ? c : clampedDate(y, m + 1, dueDay);
}

/** Eşit taksitler (kuruş); artan kuruşlar ilk taksite. */
export function splitInstallments(totalCents: number, n: number): number[] {
  const base = Math.floor(totalCents / n);
  const parts = Array<number>(n).fill(base);
  parts[0] += totalCents - base * n;
  return parts;
}

/**
 * Bütçe ve istatistikler için taksitli giderleri aylara böler: k. taksit işlem tarihinden k ay sonraya düşer
 * (ör. 26 Eylül'de 3 taksit → Eylül, Ekim, Kasım). Kart borcu hesabı bunu kullanmaz; ekstreleri ayrıca hesaplar.
 */
export function spreadInstallments(txs: Transaction[]): Transaction[] {
  const out: Transaction[] = [];
  for (const t of txs) {
    const n = t.type === "expense" ? t.installments : 1;
    if (n <= 1) {
      out.push(t);
      continue;
    }
    const [y, m, d] = [Number(t.date.slice(0, 4)), Number(t.date.slice(5, 7)) - 1, Number(t.date.slice(8, 10))];
    splitInstallments(Math.round(t.amount * 100), n).forEach((cents, k) =>
      out.push({ ...t, id: `${t.id}#${k + 1}`, date: clampedDate(y, m + k, d), amount: cents / 100, installments: 1 }),
    );
  }
  return out;
}

/** Kart hesabındaki tek hareket. `cents` > 0 borçlandırma, < 0 alacak (iade/ödeme). */
interface Movement {
  date: string;
  /** Borçlandırmanın yazıldığı ekstrenin kesim tarihi */
  closing: string;
  cents: number;
}

/**
 * Takip başlangıcı (`openingDate`) kartın ilk takip edilen ekstresini belirler. Daha önce kesilen
 * ekstreler ödenmiş sayılır: o ekstrelere düşen taksitler ve takip öncesi ödemeler hesaba katılmaz.
 * Böylece eski taksitli alışverişler alış tarihi ve taksit sayısıyla girilebilir.
 */
export function firstTrackedClosing(account: Account): string {
  return closingOnOrAfter(account.openingDate, account.statementDay ?? 1);
}

function cardMovements(account: Account, txs: Transaction[]): Movement[] {
  const sd = account.statementDay ?? 1;
  const first = firstTrackedClosing(account);
  const out: Movement[] = [];
  const opening = toCents(account.openingBalance);
  if (opening !== 0) out.push({ date: account.openingDate, closing: first, cents: opening });
  const charge = (date: string, closing: string, cents: number) => {
    if (closing >= first) out.push({ date, closing, cents });
  };
  const credit = (date: string, cents: number) => {
    if (date >= account.openingDate) out.push({ date, closing: closingOnOrAfter(date, sd), cents: -cents });
  };
  for (const t of txs) {
    const cents = toCents(t.amount);
    const closing0 = closingOnOrAfter(t.date, sd);
    if (t.type === "expense" && t.accountId === account.id) {
      splitInstallments(cents, Math.max(1, t.installments)).forEach((c, k) => charge(t.date, shiftClosing(closing0, k, sd), c));
    } else if (t.type === "income" && t.accountId === account.id) {
      credit(t.date, cents);
    } else if (t.type === "transfer") {
      if (t.toAccountId === account.id) credit(t.date, cents);
      if (t.accountId === account.id) charge(t.date, closing0, cents);
    }
  }
  return out;
}

export interface InstallmentPosting {
  closingDate: string;
  dueDate: string;
  cents: number;
  /** Takip başlangıcından önceki ekstreye düştü (ödenmiş sayılır) */
  settled: boolean;
}

/** Bir kart harcamasının taksitlerinin hangi ekstrelere yazılacağı. */
export function installmentPostings(account: Account, date: string, amount: number, n: number): InstallmentPosting[] {
  const sd = account.statementDay ?? 1;
  const dd = account.dueDay ?? 1;
  const first = firstTrackedClosing(account);
  const closing0 = closingOnOrAfter(date, sd);
  return splitInstallments(toCents(amount), Math.max(1, n)).map((cents, k) => {
    const c = shiftClosing(closing0, k, sd);
    return { closingDate: c, dueDate: dueDateFor(c, dd), cents, settled: c < first };
  });
}

export type StatementStatus = "none" | "paid" | "minPaid" | "pending" | "overdue";

export interface Statement {
  periodStart: string;
  closingDate: string;
  dueDate: string;
  statementCents: number;
  /** Kesimden sonraki kesime kadar yapılan ödemeler (gecikmeli olanlar dahil) */
  paidCents: number;
  remainingCents: number;
  minPaymentCents: number;
  status: StatementStatus;
}

function statementFor(account: Account, movements: Movement[], closing: string, today: string): Statement {
  const sd = account.statementDay ?? 1;
  const due = dueDateFor(closing, account.dueDay ?? 1);
  // Son ödemeden sonra (gecikmeli) yapılan ödemeler de sonraki kesime kadar bu ekstreye sayılır
  const nextClosing = shiftClosing(closing, 1, sd);
  let debt = 0;
  let paid = 0;
  for (const mv of movements) {
    if (mv.cents > 0) {
      if (mv.closing <= closing) debt += mv.cents;
    } else if (mv.date <= closing) debt += mv.cents;
    else if (mv.date <= nextClosing) paid -= mv.cents;
  }
  const statementCents = Math.max(0, debt);
  const remainingCents = Math.max(0, statementCents - paid);
  const rate = account.minPaymentRate ?? 20;
  const minPaymentCents = Math.min(statementCents, Math.round((statementCents * rate) / 100));
  let status: StatementStatus;
  if (statementCents === 0) status = "none";
  else if (remainingCents === 0) status = "paid";
  else if (paid >= minPaymentCents) status = "minPaid";
  else if (today > due) status = "overdue";
  else status = "pending";
  return {
    periodStart: addDays(shiftClosing(closing, -1, sd), 1),
    closingDate: closing,
    dueDate: due,
    statementCents,
    paidCents: paid,
    remainingCents,
    minPaymentCents,
    status,
  };
}

/** Kesilmiş son `count` ekstre, en yeni önce. Açılış tarihinden önceki dönemler dahil edilmez. */
export function cardStatements(account: Account, txs: Transaction[], today: string, count = 6): Statement[] {
  const sd = account.statementDay;
  if (!sd || !account.dueDay) return [];
  const movements = cardMovements(account, txs);
  const first = firstTrackedClosing(account);
  const out: Statement[] = [];
  let c = closingOnOrBefore(today, sd);
  while (out.length < count && c >= first) {
    out.push(statementFor(account, movements, c, today));
    c = shiftClosing(c, -1, sd);
  }
  return out;
}

export interface CardSummary {
  /** Taksitlerin tamamı dahil toplam borç (limit kullanımı) */
  totalDebtCents: number;
  availableCents: number | null;
  lastStatement: Statement | null;
  /** Açık dönemde bir sonraki ekstreye yazılacak borçlandırmalar */
  currentPeriodCents: number;
  /** Sonraki ekstreden sonraki aylara yazılacak taksitler */
  laterInstallmentsCents: number;
  nextClosingDate: string;
  nextDueDate: string;
}

export function cardSummary(account: Account, txs: Transaction[], today: string): CardSummary {
  const sd = account.statementDay ?? 1;
  const movements = cardMovements(account, txs);
  const totalDebtCents = movements.reduce((s, m) => s + m.cents, 0);
  const nextClosingDate = closingOnOrAfter(addDays(today, 1), sd);
  const currentPeriodCents = movements
    .filter((m) => m.cents > 0 && m.closing === nextClosingDate)
    .reduce((s, m) => s + m.cents, 0);
  const laterInstallmentsCents = movements
    .filter((m) => m.cents > 0 && m.closing > nextClosingDate)
    .reduce((s, m) => s + m.cents, 0);
  return {
    totalDebtCents,
    laterInstallmentsCents,
    availableCents: account.creditLimit !== null ? toCents(account.creditLimit) - totalDebtCents : null,
    lastStatement: cardStatements(account, txs, today, 1)[0] ?? null,
    currentPeriodCents,
    nextClosingDate,
    nextDueDate: dueDateFor(nextClosingDate, account.dueDay ?? 1),
  };
}

export interface UpcomingPayment {
  account: Account;
  statement: Statement;
}

/** Son ekstresinde kalan borcu olan kartlar: önümüzdeki `days` gün içinde son ödemesi gelen veya gecikmiş olanlar. */
export function upcomingPayments(accounts: Account[], txs: Transaction[], today: string, days = 30): UpcomingPayment[] {
  const until = addDays(today, days);
  const out: UpcomingPayment[] = [];
  for (const account of accounts) {
    if (account.kind !== "credit_card") continue;
    const [s] = cardStatements(account, txs, today, 1);
    if (!s || s.remainingCents === 0 || s.dueDate > until) continue;
    if (s.dueDate >= today || s.status === "overdue") out.push({ account, statement: s });
  }
  return out.sort((x, y) => x.statement.dueDate.localeCompare(y.statement.dueDate));
}

export interface CardDue {
  closingDate: string;
  dueDate: string;
  amountCents: number;
  /** Ekstre henüz kesilmediyse true (dönem içi harcama + gelecek taksitler) */
  estimated: boolean;
  status: StatementStatus | null;
}

/**
 * Son kesilmiş ekstrenin kalan borcu (ödenmemişse) ve son ödemesi `until` tarihine kadar düşen
 * gelecek ekstrelerin tahmini tutarları. Tahmin, o ekstreye yazılacak harcama ve taksitlerdir.
 */
export function cardDues(account: Account, txs: Transaction[], today: string, until: string): CardDue[] {
  const sd = account.statementDay;
  const dd = account.dueDay;
  if (!sd || !dd) return [];
  const movements = cardMovements(account, txs);
  const first = firstTrackedClosing(account);
  const out: CardDue[] = [];
  const last = closingOnOrBefore(today, sd);
  if (last >= first) {
    const s = statementFor(account, movements, last, today);
    if (s.remainingCents > 0 && (s.dueDate >= today || s.status === "overdue")) {
      out.push({ closingDate: last, dueDate: s.dueDate, amountCents: s.remainingCents, estimated: false, status: s.status });
    }
  }
  const included = out.reduce((s, d) => s + d.amountCents, 0);
  const estimated: CardDue[] = [];
  for (let c = shiftClosing(last, 1, sd); dueDateFor(c, dd) <= until; c = shiftClosing(c, 1, sd)) {
    const cents = movements.filter((m) => m.cents > 0 && m.closing === c).reduce((s, m) => s + m.cents, 0);
    estimated.push({ closingDate: c, dueDate: dueDateFor(c, dd), amountCents: cents, estimated: true, status: null });
  }
  // Toplam borçla uzlaştır: asgarisi ödenip vadesi geçen ekstrenin devreden kalanı (+) ve açık dönemde yapılan
  // ödeme/iadeler (−) bir sonraki tahmini ekstreye yansır
  const total = movements.reduce((s, m) => s + m.cents, 0);
  const futureCharges = movements.filter((m) => m.cents > 0 && m.closing > last).reduce((s, m) => s + m.cents, 0);
  let adjust = total - included - futureCharges;
  for (const d of estimated) {
    if (adjust === 0) break;
    const next = Math.max(0, d.amountCents + adjust);
    adjust -= next - d.amountCents;
    d.amountCents = next;
    if (adjust > 0) break; // pozitif fark ilk tahmini ekstreye tamamen eklendi
  }
  return [...out, ...estimated.filter((d) => d.amountCents > 0)];
}
