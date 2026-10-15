import { installmentPostings, spreadInstallments } from "./cards";
import { amountAt, amountForOccurrence, exceptionFor, hasStarted, occurrenceIn, scheduledMonth, shiftMonth } from "./recurring";
import type { Account, RecurringItem, Transaction } from "./types";

/**
 * Bir işlem düzenli kaydın (maaş, kira…) karşılığı olabilir mi?
 * - Kaydın başlangıç tarihinden önceki işlemler eşleşmez.
 * - Kaydın kategorisi varsa: aynı kategori ve tutar planlananın yarısı ile iki katı arasında
 *   ("Diğer Gelir" gibi genel kategorilerde küçük tutarlar yanlışlıkla eşleşmesin; primli maaş eşleşsin).
 * - Kategori yoksa: aynı hesaba yatan ve planlanan tutara %10 yakın işlem.
 */
export function matchesRegular(t: Transaction, r: RecurringItem): boolean {
  if (!hasStarted(r, t.date)) return false;
  // O aya özel istisna (ör. eksik maaş) varsa onunla karşılaştırılır; "yok" (0) olan aya eşleşme olmaz
  const planned = amountForOccurrence(r, t.date);
  if (planned <= 0) return false;
  if (r.categoryId) return t.categoryId === r.categoryId && t.amount >= planned * 0.5 && t.amount <= planned * 2;
  return (!r.accountId || r.accountId === t.accountId) && Math.abs(t.amount - planned) <= planned * 0.1;
}

/**
 * Her işlemi en fazla bir düzenli kayda atar (eşleşenler arasından tutarı en yakın olan).
 * Böylece aynı kategorideki iki düzenli gelir aynı parayı iki kez saymaz.
 */
export function assignRegular(txs: Transaction[], items: RecurringItem[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of txs) {
    let best: RecurringItem | null = null;
    let bestDiff = Infinity;
    for (const r of items) {
      if (!matchesRegular(t, r)) continue;
      const diff = Math.abs(t.amount - amountForOccurrence(r, t.date));
      if (diff < bestDiff) {
        best = r;
        bestDiff = diff;
      }
    }
    if (best) out.set(t.id, best.id);
  }
  return out;
}

const activeIncomes = (recurring: RecurringItem[]) => recurring.filter((r) => r.type === "income" && r.active);
const monthIncomeTxs = (txs: Transaction[], month: string) => txs.filter((t) => t.type === "income" && t.date.slice(0, 7) === month);

export interface MonthIncome {
  /** Düzenli gelirlere (maaş vb.) karşılık gelen ve bu ayın bütçesine sayılan gelir */
  regularCents: number;
  /** Düzenli bir gelirle eşleşmeyen (ek, düzensiz) ve bu ayın bütçesine sayılan gelir işlemleri */
  irregular: Transaction[];
  irregularCents: number;
}

/**
 * Gelir işleminin bütçede sayılacağı ay: elle seçildiyse o ay; seçilmediyse "önceki ayın karşılığı"
 * olan düzenli gelire atanmış işlemde tarihinden bir önceki ay, diğerlerinde işlem tarihinin ayı.
 */
export function incomeBudgetMonth(t: Transaction, assignedTo: RecurringItem | undefined): string {
  if (t.budgetMonth) return t.budgetMonth;
  const m = t.date.slice(0, 7);
  return assignedTo?.coversPreviousMonth ? shiftMonth(m, -1) : m;
}

/** Tüm gelir işlemleri: düzenli kayda atama ve bütçe ayı. */
function incomeIndex(txs: Transaction[], recurring: RecurringItem[]) {
  const items = activeIncomes(recurring);
  const byId = new Map(items.map((r) => [r.id, r]));
  const incomes = txs.filter((t) => t.type === "income");
  const assigned = assignRegular(incomes, items);
  return incomes.map((t) => {
    const item = byId.get(assigned.get(t.id) ?? "");
    return { t, item, month: incomeBudgetMonth(t, item) };
  });
}

/** Ayın bütçesine sayılan gelirleri düzenli / düzensiz olarak ayırır; maaş iki kez sayılmaz. */
export function splitMonthIncome(txs: Transaction[], recurring: RecurringItem[], month: string): MonthIncome {
  const out: MonthIncome = { regularCents: 0, irregular: [], irregularCents: 0 };
  for (const { t, item, month: m } of incomeIndex(txs, recurring)) {
    if (m !== month) continue;
    const cents = Math.round(t.amount * 100);
    if (item) out.regularCents += cents;
    else {
      out.irregular.push(t);
      out.irregularCents += cents;
    }
  }
  out.irregular.sort((a, b) => b.amount - a.amount);
  return out;
}

export interface RegularIncomeLine {
  item: RecurringItem;
  /** Bu ayın bütçesi için yatış günü */
  date: string;
  /** O tarihte geçerli plan tutarı (zamlar dahil) */
  plannedCents: number;
  /** Bu ayın bütçesine sayılan gerçekleşen tutar (işlemlerden) */
  receivedCents: number;
  /** Hesapta kullanılan: yattıysa yatan, yatmadıysa plan */
  usedCents: number;
  /** O aya özel istisna (ör. ücretsiz izin → 0) */
  exception: { amount: number; note: string } | null;
}

/** Her aktif düzenli gelir için ayın bütçesine düşen plan / gerçekleşen tutar. */
export function regularIncomeForMonth(txs: Transaction[], recurring: RecurringItem[], month: string): RegularIncomeLine[] {
  const index = incomeIndex(txs, recurring);
  const lines = activeIncomes(recurring).map((item) => {
    // "Önceki ayın karşılığı" olan maaş (ör. Eylül maaşı 10 Ekim'de) bu ayın bütçesine bir sonraki ay yatar
    const paidMonth = item.coversPreviousMonth ? shiftMonth(month, 1) : month;
    const date = occurrenceIn(item, paidMonth);
    const plannedCents = Math.round(amountForOccurrence(item, date) * 100);
    const receivedCents = index
      .filter((x) => x.item?.id === item.id && x.month === month)
      .reduce((s, x) => s + Math.round(x.t.amount * 100), 0);
    const ex = exceptionFor(item, month);
    return {
      item,
      date,
      plannedCents,
      receivedCents,
      usedCents: receivedCents > 0 ? receivedCents : plannedCents,
      exception: ex ? { amount: ex.amount, note: ex.note } : null,
    };
  });
  // Başlangıç tarihinden önceki aylarda plan yok; yalnızca gerçekten yatan maaş gösterilir
  return lines
    .filter((l) => hasStarted(l.item, l.date) || l.receivedCents > 0)
    .map((l) => (hasStarted(l.item, l.date) ? l : { ...l, plannedCents: 0, usedCents: l.receivedCents }));
}

/** Ayın aktif düzenli giderlerinin (o ay geçerli tutarlarla) toplamı. */
export function regularExpenseForMonth(recurring: RecurringItem[], month: string): number {
  return recurring
    .filter((r) => r.type === "expense" && r.active && hasStarted(r, occurrenceIn(r, month)))
    .reduce((s, r) => s + Math.round(amountForOccurrence(r, occurrenceIn(r, month)) * 100), 0);
}

/**
 * Kart ekstresinin bütçe ayı: son ödeme tarihinden önce (veya o gün) yatan son maaşın ayı — ekstre o maaşla ödenir.
 * Ör. kesim 23 Eylül, son ödeme 2 Ekim, maaş her ayın 10'u → 10 Eylül maaşı öder → Eylül bütçesi.
 * Maaş "önceki ayın karşılığı" ise o maaşın bütçe ayı kullanılır. Düzenli gelir yoksa kesim tarihinin ayı.
 */
export function cardBudgetMonth(closingDate: string, dueDate: string, recurring: RecurringItem[]): string {
  const salary = primarySalary(recurring, dueDate);
  return salary ? salaryMonthFor(salary, dueDate) : closingDate.slice(0, 7);
}

/** Ana maaş: aktif TL düzenli gelirler içinde tutarı en büyük olan (döviz/altın hesabına yatan gelir TL ödemeleri karşılamaz). */
export function primarySalary(recurring: RecurringItem[], date: string): RecurringItem | undefined {
  return activeIncomes(recurring)
    .filter((r) => r.origAmount == null)
    .sort((a, b) => amountAt(b, date) - amountAt(a, date))[0];
}

/** `date` tarihinden önce (veya o gün) yatan son maaşın tarihi. */
export function salaryPaidOnOrBefore(salary: RecurringItem, date: string): string {
  const month = date.slice(0, 7);
  // Gelecek ayın maaşı hafta sonu kuralıyla bu aya kaymış olabilir (1 Kasım Pazar → 30 Ekim)
  return [shiftMonth(month, 1), month, shiftMonth(month, -1), shiftMonth(month, -2)]
    .map((m) => occurrenceIn(salary, m))
    .find((d) => d <= date)!;
}

/** `date` tarihinde ödenecek bir borcu karşılayan maaşın ait olduğu ay (bütçe ayı). */
export function salaryMonthFor(salary: RecurringItem, date: string): string {
  const m = scheduledMonth(salary, salaryPaidOnOrBefore(salary, date));
  return salary.type === "income" && salary.coversPreviousMonth ? shiftMonth(m, -1) : m;
}

export interface BudgetExpense {
  /** Kaynak işlem (taksitliyse tutar bu ayın payıdır) */
  t: Transaction;
  cents: number;
  month: string;
}

/**
 * Giderlerin bütçe aylarına dağılımı. Kredi kartı harcamaları (taksitleri dahil) yazıldıkları ekstreyi ödeyecek
 * maaşın ayına, diğer giderler tarihlerinin ayına (taksitliyse her taksit bir sonraki aya) yazılır.
 */
export function budgetExpenses(txs: Transaction[], accounts: Account[], recurring: RecurringItem[]): BudgetExpense[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out: BudgetExpense[] = [];
  for (const t of txs) {
    if (t.type !== "expense") continue;
    const account = byId.get(t.accountId);
    if (account?.kind === "credit_card") {
      for (const p of installmentPostings(account, t.date, t.amount, t.installments))
        out.push({ t, cents: p.cents, month: cardBudgetMonth(p.closingDate, p.dueDate, recurring) });
    } else {
      for (const s of spreadInstallments([t])) out.push({ t, cents: Math.round(s.amount * 100), month: s.date.slice(0, 7) });
    }
  }
  return out;
}

export interface MonthExpenses {
  /** Bütçeli kategoriler: limit, aşıldıysa harcanan */
  budgetReservedCents: number;
  /** Bütçesi olmayan kategorilerdeki ve düzenli gidere karşılık gelmeyen gerçek harcamalar */
  irregular: BudgetExpense[];
  irregularCents: number;
}

/** Ayın gider tarafı: bütçe ayrımları ve plansız (düzensiz) harcamalar. */
export function monthExpenses(
  txs: Transaction[],
  accounts: Account[],
  recurring: RecurringItem[],
  budgets: { categoryId: string; amount: number }[],
  month: string,
): MonthExpenses {
  const budgetBy = new Map(budgets.map((b) => [b.categoryId, Math.round(b.amount * 100)]));
  const regular = recurring.filter((r) => r.type === "expense" && r.active);
  const spentBy = new Map<string, number>();
  const out: MonthExpenses = { budgetReservedCents: 0, irregular: [], irregularCents: 0 };
  // Taksitli harcamanın yalnızca bu aya düşen taksiti; kart harcaması ekstresini ödeyecek maaşın ayında sayılır
  for (const e of budgetExpenses(txs, accounts, recurring)) {
    if (e.month !== month) continue;
    const { t, cents } = e;
    if (t.categoryId && budgetBy.has(t.categoryId)) {
      spentBy.set(t.categoryId, (spentBy.get(t.categoryId) ?? 0) + cents);
      continue;
    }
    // Kira gibi düzenli gidere karşılık gelen harcama zaten "Düzenli gider" içinde
    if (regular.some((r) => matchesRegular(t, r))) continue;
    out.irregular.push(e);
    out.irregularCents += cents;
  }
  for (const [cat, limit] of budgetBy) out.budgetReservedCents += Math.max(limit, spentBy.get(cat) ?? 0);
  out.irregular.sort((a, b) => b.cents - a.cents);
  return out;
}

/**
 * Ayın nakit geliri (o ay hesaba giren): düzenli gelirler o aydaki yatış tarihiyle (yattıysa yatan,
 * yatmadıysa plan; başlangıç, zam ve istisnalar dahil) + düzenli gelirle eşleşmeyen gelir işlemleri.
 */
export function cashIncomeForMonth(txs: Transaction[], recurring: RecurringItem[], month: string, since?: string): number {
  const monthTxs = monthIncomeTxs(txs, month);
  const assigned = assignRegular(monthTxs, activeIncomes(recurring));
  let cents = 0;
  for (const item of activeIncomes(recurring)) {
    const date = occurrenceIn(item, month);
    const received = monthTxs.filter((t) => assigned.get(t.id) === item.id).reduce((s, t) => s + Math.round(t.amount * 100), 0);
    if (received > 0) cents += received;
    else if (hasStarted(item, date) && (!since || date >= since)) cents += Math.round(amountForOccurrence(item, date) * 100);
  }
  // Nakit akışı: düzensiz gelirler bütçe ayına değil, hesaba girdiği tarihe göre sayılır
  for (const t of monthTxs) if (!assigned.has(t.id)) cents += Math.round(t.amount * 100);
  return cents;
}

/**
 * [from, to] aralığındaki düzenli gelir yatışları (maaş vb.): o ayki karşılığı İşlemler'e girilmediyse plan tutarı.
 * Girilmiş olanlar zaten gelir işlemi olarak sayıldığı için eklenmez. Başlangıç, zam ve istisnalar dahil.
 */
export function plannedRegularIncomeInRange(
  txs: Transaction[],
  recurring: RecurringItem[],
  from: string,
  to: string,
  /** Takip başlangıcı: bundan önceki aylara plan tutarı yazılmaz (başlangıç tarihi girilmemiş maaş için) */
  since?: string,
): number {
  if (since && since > from) from = since;
  let cents = 0;
  for (let month = from.slice(0, 7); month <= to.slice(0, 7); month = shiftMonth(month, 1)) {
    const monthTxs = monthIncomeTxs(txs, month);
    const assigned = assignRegular(monthTxs, activeIncomes(recurring));
    for (const item of activeIncomes(recurring)) {
      const date = occurrenceIn(item, month);
      if (date < from || date > to || !hasStarted(item, date)) continue;
      if (monthTxs.some((t) => assigned.get(t.id) === item.id)) continue;
      cents += Math.round(amountForOccurrence(item, date) * 100);
    }
  }
  return cents;
}

export interface DueIncome {
  item: RecurringItem;
  /** Yatış tarihi (hafta sonu kaydırması dahil) */
  date: string;
  /** Plan tutarı (zam ve istisnalar dahil) */
  amount: number;
}

/**
 * Bu ay yatış günü gelmiş (bugün veya önce) ama İşlemler'e girilmemiş düzenli gelirler. Bunlar ne "beklenen"
 * ne de bakiyede: kullanıcıdan yattığını onaylaması istenir.
 */
export function dueUnrecordedIncomes(txs: Transaction[], recurring: RecurringItem[], today: string): DueIncome[] {
  const month = today.slice(0, 7);
  const monthTxs = monthIncomeTxs(txs, month);
  const items = activeIncomes(recurring);
  const assigned = assignRegular(monthTxs, items);
  const out: DueIncome[] = [];
  for (const item of items) {
    const date = occurrenceIn(item, month);
    if (date > today || date.slice(0, 7) !== month || !hasStarted(item, date)) continue;
    if (monthTxs.some((t) => assigned.get(t.id) === item.id)) continue;
    const amount = amountForOccurrence(item, date);
    if (amount > 0) out.push({ item, date, amount });
  }
  return out;
}

export interface ExpectedIncome {
  /** Bu ay henüz yatmamış düzenli gelirler (maaş vb.) */
  regularCents: number;
  /** Bu ayın kalan günlerine tarihlenmiş diğer gelir işlemleri */
  otherCents: number;
  totalCents: number;
}

/**
 * İçinde bulunulan ayda henüz hesaba girmemiş gelir: yatış günü gelmemiş ve işlemi girilmemiş
 * düzenli gelirlerin planı + bugünden sonraki, ay içindeki ileri tarihli gelir işlemleri.
 */
export function expectedIncomeThisMonth(txs: Transaction[], recurring: RecurringItem[], today: string): ExpectedIncome {
  const month = today.slice(0, 7);
  const monthTxs = monthIncomeTxs(txs, month);
  const items = activeIncomes(recurring);
  const assigned = assignRegular(monthTxs, items);
  let regular = 0;
  let other = 0;
  for (const item of items) {
    const date = occurrenceIn(item, month);
    // Günü gelmiş (bugün dahil) maaş "beklenen" değil; kaydı istenir (dueUnrecordedIncomes)
    if (date <= today || !hasStarted(item, date)) continue;
    // Bu ayki karşılığı İşlemler'e girildiyse aşağıda işlem olarak sayılır
    if (monthTxs.some((t) => assigned.get(t.id) === item.id)) continue;
    regular += Math.round(amountForOccurrence(item, date) * 100);
  }
  for (const t of monthTxs) {
    if (t.date <= today) continue;
    if (assigned.has(t.id)) regular += Math.round(t.amount * 100);
    else other += Math.round(t.amount * 100);
  }
  return { regularCents: regular, otherCents: other, totalCents: regular + other };
}
