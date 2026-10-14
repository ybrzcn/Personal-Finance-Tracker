import { isForeign } from "./fx";
import { bankBalanceCents } from "./accounts";
import { assignRegular, matchesRegular, primarySalary, salaryMonthFor } from "./budget";
import { cardDues, clampedDate, shiftClosing } from "./cards";
import { addDays } from "./format";
import { loanSummary } from "./loans";
import { amountForOccurrence, coverMonthOf, exceptionFor, hasStarted, occurrenceIn, scheduledMonth, shiftMonth } from "./recurring";
import type { Account, RecurringItem, Transaction } from "./types";

export type ObligationKind = "card" | "loan" | "recurring" | "planned";

export interface Obligation {
  key: string;
  kind: ObligationKind;
  date: string;
  label: string;
  amountCents: number;
  accountId: string | null;
  /** Tutar henüz kesinleşmedi (gelecek ekstre) */
  estimated: boolean;
  overdue: boolean;
  /** Kredi taksiti için faiz/anapara ayrımı */
  loanInterestCents?: number;
  loanPrincipalCents?: number;
  /** Borcun ait olduğu ay (YYYY-MM): kartta harcama döneminin ortası, diğerlerinde ödeme ayı.
   *  "Önceki ayın karşılığı" gelir varsa kart ekstreleri bu aya karşılık gelen gelire yazılır. */
  periodMonth: string;
  /** Karşılayan gelir son ödeme tarihinden sonra yatıyor (ödeme gelirden önce yapılmalı) */
  beforeIncome?: boolean;
}

export interface IncomeEvent {
  key: string;
  itemId: string;
  name: string;
  date: string;
  amountCents: number;
  accountId: string | null;
  /** O aya özel istisna notu (ör. "Ücretsiz izin") */
  note: string | null;
  /** O ay hiç yatmayacak: ödemeler bir önceki gelire yazılır */
  skipped: boolean;
  /** İşlemler'e girilmiş ileri tarihli tek seferlik gelir (düzenli gelir değil) */
  oneTime: boolean;
  /** Gelirin karşılık geldiği ay (YYYY-MM); "önceki ayın karşılığı" gelirlerde yattığı ayın bir öncesi */
  coverMonth: string;
  /** Tek seferlik gelirde bütçe ayı elle seçildi ("Hangi ayın geliri") */
  fixedMonth?: boolean;
  /** İşlemler'e girilmiş ve tarihi bugün/geçmiş: tutarı bugünkü nakitte, ayrıca gelir olarak eklenmez */
  recorded?: boolean;
}

/** Bugünkü nakde henüz girmemiş (ileride yatacak) gelir mi? */
export const isUpcomingIncome = (e: IncomeEvent, today: string) => !e.skipped && (e.recorded ? e.date > today : e.date >= today);

/**
 * Ödeme takviminde bir grup. Maaş tanımlıysa grup bir maaş dönemidir (o maaşın yatışından bir sonrakine kadar;
 * `month` maaşın ait olduğu ay), değilse takvim ayıdır.
 */
export interface PlanMonth {
  /** YYYY-MM */
  month: string;
  /** Maaş dönemi: o maaşın yatışı (yatmayacaksa skipped) ve dönem aralığı */
  salary: { event: IncomeEvent | null; name: string; paidOn: string; nextPaidOn: string } | null;
  incomes: IncomeEvent[];
  obligations: Obligation[];
  incomeCents: number;
  totalCents: number;
  /** Ayın gelirleri − ödemeleri */
  leftCents: number;
  /** Bugünkü nakitten başlayarak ay sonundaki tahmini bakiye */
  balanceCents: number;
}

/** `day`. günün [from, to] aralığındaki aylık tekrarları (ay sonu kısıtlamalı). */
export function monthlyDates(day: number, from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7)) - 1;
  for (let i = 0; i < 400; i++) {
    const d = clampedDate(y, m, day);
    if (d > to) break;
    if (d >= from) out.push(d);
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return out;
}

/** İki tarih arasının ortasının ayı (kart ekstresinin "ait olduğu ay"). */
function periodMidMonth(startIso: string, endIso: string): string {
  const a = new Date(Number(startIso.slice(0, 4)), Number(startIso.slice(5, 7)) - 1, Number(startIso.slice(8, 10)));
  const b = new Date(Number(endIso.slice(0, 4)), Number(endIso.slice(5, 7)) - 1, Number(endIso.slice(8, 10)));
  const mid = new Date((a.getTime() + b.getTime()) / 2);
  return `${mid.getFullYear()}-${String(mid.getMonth() + 1).padStart(2, "0")}`;
}

/** Düzenli kaydın [from, to] aralığındaki tarihleri (ay sonu kısıtı ve hafta sonu kaydırması dahil). */
export function occurrencesBetween(item: RecurringItem, from: string, to: string): string[] {
  const out: string[] = [];
  // Kaydırma tarihi komşu aya taşıyabileceği için aralığın bir ay öncesinden başlanır
  for (let m = shiftMonth(from.slice(0, 7), -1); m <= shiftMonth(to.slice(0, 7), 1); m = shiftMonth(m, 1)) {
    const d = occurrenceIn(item, m);
    if (d >= from && d <= to) out.push(d);
  }
  return out;
}

export function addMonthsISO(iso: string, months: number): string {
  return clampedDate(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1 + months, Number(iso.slice(8, 10)));
}

/** Bugünden `until` tarihine kadar düşen kart, kredi ve düzenli gider ödemeleri (gecikmişler dahil). */
export function obligations(
  accounts: Account[],
  txs: Transaction[],
  recurring: RecurringItem[],
  today: string,
  until: string,
): Obligation[] {
  const out: Obligation[] = [];
  for (const a of accounts) {
    if (a.kind === "credit_card") {
      for (const d of cardDues(a, txs, today, until)) {
        out.push({
          key: `card:${a.id}:${d.closingDate}`,
          kind: "card",
          date: d.dueDate,
          label: `${a.name} ekstresi`,
          amountCents: d.amountCents,
          accountId: a.id,
          estimated: d.estimated,
          overdue: d.dueDate < today,
          periodMonth: periodMidMonth(addDays(shiftClosing(d.closingDate, -1, a.statementDay ?? 1), 1), d.closingDate),
        });
      }
    } else if (a.kind === "loan") {
      const s = loanSummary(a, txs);
      for (const row of s.schedule.slice(s.paidCount)) {
        if (row.date > until) break;
        out.push({
          key: `loan:${a.id}:${row.index}`,
          kind: "loan",
          date: row.date,
          label: `${a.name} · ${row.index}/${s.schedule.length}. taksit`,
          amountCents: row.paymentCents,
          accountId: a.id,
          estimated: false,
          overdue: row.date < today,
          loanInterestCents: row.interestCents,
          loanPrincipalCents: row.principalCents,
          periodMonth: row.date.slice(0, 7),
        });
      }
    }
  }
  // İşlemler'e girilmiş ileri tarihli banka/nakit giderleri (kart giderleri zaten ekstreye yazılır)
  // Ödeme takvimi TL nakit akışıdır: döviz/altın hesapları dahil edilmez
  const cashAccounts = new Set(accounts.filter((a) => (a.kind === "bank" || a.kind === "cash") && !isForeign(a.currency)).map((a) => a.id));
  const planned = txs.filter((t) => t.type === "expense" && cashAccounts.has(t.accountId) && t.date > today && t.date <= until);
  const replaced = new Set<string>();
  // Bu ay zaten ödenmiş düzenli gider (ör. kira 11'inde ödendi, günü 15) bu ayın planından düşer
  const monthStart = `${today.slice(0, 7)}-01`;
  for (const t of txs) {
    if (t.type !== "expense" || t.date < monthStart || t.date > today) continue;
    const r = recurring.find((x) => x.active && x.type === "expense" && matchesRegular(t, x));
    if (r) replaced.add(`${r.id}:${t.date.slice(0, 7)}`);
  }
  for (const t of planned) {
    // Düzenli bir gidere karşılık geliyorsa (ör. ileri tarihli kira) o ayın düzenli kaydının yerine geçer
    const r = recurring.find((x) => x.active && x.type === "expense" && matchesRegular(t, x));
    if (r) replaced.add(`${r.id}:${t.date.slice(0, 7)}`);
    out.push({
      key: `tx:${t.id}`,
      kind: "planned",
      date: t.date,
      label: t.description || "Planlı gider",
      amountCents: Math.round(t.amount * 100),
      accountId: t.accountId,
      estimated: false,
      overdue: false,
      periodMonth: t.date.slice(0, 7),
    });
  }
  for (const r of recurring) {
    if (!r.active || r.type !== "expense") continue;
    for (const date of occurrencesBetween(r, today, until)) {
      if (!hasStarted(r, date) || replaced.has(`${r.id}:${date.slice(0, 7)}`)) continue;
      out.push({
        key: `rec:${r.id}:${date}`,
        kind: "recurring",
        date,
        label: r.name,
        amountCents: Math.round(amountForOccurrence(r, date) * 100),
        accountId: r.accountId,
        estimated: false,
        overdue: false,
        periodMonth: date.slice(0, 7),
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label, "tr"));
}

export function incomeEvents(recurring: RecurringItem[], from: string, until: string): IncomeEvent[] {
  const out: IncomeEvent[] = [];
  for (const r of recurring) {
    if (!r.active || r.type !== "income") continue;
    for (const date of occurrencesBetween(r, from, until)) {
      if (!hasStarted(r, date)) continue;
      const ex = exceptionFor(r, coverMonthOf(r, date));
      const amountCents = Math.round(amountForOccurrence(r, date) * 100);
      out.push({
        key: `inc:${r.id}:${date}`,
        itemId: r.id,
        name: r.name,
        date,
        amountCents,
        accountId: r.accountId,
        note: ex ? ex.note || null : null,
        skipped: amountCents === 0,
        oneTime: false,
        coverMonth: coverMonthOf(r, date),
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * İşlemler'e girilmiş ileri tarihli gelirleri takvime ekler. Düzenli bir gelire karşılık gelenler
 * (ör. ileriye girilmiş maaş) o ayın planlanan tutarının yerine geçer; diğerleri tek seferlik gelir olur.
 */
function withFutureIncomes(
  events: IncomeEvent[],
  txs: Transaction[],
  recurring: RecurringItem[],
  today: string,
  until: string,
): IncomeEvent[] {
  const future = txs.filter((t) => t.type === "income" && t.date > today && t.date <= until);
  // Bu ayın erken/bugün girilmiş maaşı da planın yerine geçer (yoksa hem bakiyede hem gelecek gelirde sayılır)
  const monthStart = `${today.slice(0, 7)}-01`;
  const candidates = txs.filter((t) => t.type === "income" && t.date >= monthStart && t.date <= until);
  const regular = recurring.filter((r) => r.type === "income" && r.active);
  const assigned = assignRegular(candidates, regular);
  const used = new Set<string>();
  const out = events.map((e) => {
    if (e.date < today) return e;
    const item = regular.find((r) => r.id === e.itemId);
    if (!item) return e;
    // Aynı ayın maaşı: hafta sonu kuralıyla önceki aya kaymış yatış da asıl ayıyla karşılaştırılır
    const month = scheduledMonth(item, e.date);
    const matched = candidates.filter((t) => assigned.get(t.id) === item.id && scheduledMonth(item, t.date) === month);
    if (!matched.length) return e;
    matched.forEach((t) => used.add(t.id));
    const amountCents = matched.reduce((s, t) => s + Math.round(t.amount * 100), 0);
    const recorded = matched.every((t) => t.date <= today);
    return { ...e, date: matched[0].date, amountCents, note: "girilen tutar", skipped: amountCents === 0, recorded };
  });
  for (const t of future) {
    if (used.has(t.id)) continue;
    out.push({
      key: `tx:${t.id}`,
      itemId: `tx:${t.id}`,
      name: t.description || "Tek seferlik gelir",
      date: t.date,
      amountCents: Math.round(t.amount * 100),
      accountId: t.accountId,
      note: "tek seferlik",
      skipped: false,
      oneTime: true,
      coverMonth: t.budgetMonth ?? t.date.slice(0, 7),
      fixedMonth: !!t.budgetMonth,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export interface CashPlan {
  months: PlanMonth[];
  /** Banka + nakit hesaplarının bugünkü toplam bakiyesi (KMH eksisi dahil) */
  liquidCents: number;
  totalIncomeCents: number;
  totalObligationCents: number;
}

/**
 * Her ödeme, son ödeme tarihinden önce (veya aynı gün) yatan son gelire yazılır. Hesapta
 * `fundingIncomeId` seçiliyse o gelirin son ödeme tarihinden önceki son yatışı kullanılır.
 */
export function buildCashPlan(
  accounts: Account[],
  txs: Transaction[],
  recurring: RecurringItem[],
  today: string,
  months: number,
): CashPlan {
  const until = addMonthsISO(today, months);
  const obs = obligations(accounts, txs, recurring, today, until);
  // Bugünden önceki son gelir de dahil: ilk ödemeler o maaştan karşılanıyor olabilir
  const events = withFutureIncomes(incomeEvents(recurring, addMonthsISO(today, -1), until), txs, recurring, today, until);
  const funding = new Map(accounts.map((a) => [a.id, a.fundingIncomeId]));

  const byEvent = new Map<string, Obligation[]>();
  const unfunded: Obligation[] = [];
  // Bir önceki ayın karşılığı olan gelir varsa (ör. Eylül maaşı 10 Ekim'de) borçlar ait oldukları ayın gelirine yazılır
  const monthMode = recurring.some((r) => r.type === "income" && r.active && r.coversPreviousMonth);
  const coversPrev = new Set(recurring.filter((r) => r.coversPreviousMonth).map((r) => r.id));
  for (const ob of obs) {
    const preferred = ob.accountId ? funding.get(ob.accountId) : null;
    let pick: IncomeEvent | undefined;
    // Ay eşleştirmesi yalnızca kart ekstrelerine uygulanır ("Eylül harcamaları Eylül maaşından");
    // kira, taksit gibi sabit ödemeler ödeme gününden önce eldeki son gelirden karşılanır
    if (monthMode && ob.kind === "card") {
      const same = events.filter((e) => !e.skipped && !e.oneTime && e.coverMonth === ob.periodMonth);
      pick = (preferred && same.find((e) => e.itemId === preferred)) || same.find((e) => coversPrev.has(e.itemId)) || same[0];
    }
    if (!pick) {
      // Son ödeme tarihinden önce yatan son gelir; yatmayacak aylar atlanır, ödeme bir önceki gelire düşer
      const due = ob.overdue ? today : ob.date;
      const eligible = events.filter((e) => e.date <= due && !e.skipped);
      pick = (preferred && [...eligible].reverse().find((e) => e.itemId === preferred)) || eligible[eligible.length - 1];
    }
    if (!pick) unfunded.push(ob);
    else byEvent.set(pick.key, [...(byEvent.get(pick.key) ?? []), { ...ob, beforeIncome: !ob.overdue && pick.date > ob.date }]);
  }

  const sum = (xs: Obligation[]) => xs.reduce((s, o) => s + o.amountCents, 0);
  // Bugünkü nakit: ileri tarihli (planlanan) işlemler henüz gerçekleşmediği için sayılmaz
  const liquidCents = accounts
    .filter((a) => (a.kind === "bank" || a.kind === "cash") && !isForeign(a.currency))
    .reduce((s, a) => s + bankBalanceCents(a, txs, today), 0);

  const byMonth = new Map<string, { incomes: IncomeEvent[]; obligations: Obligation[] }>();
  const slot = (m: string) => {
    if (!byMonth.has(m)) byMonth.set(m, { incomes: [], obligations: [] });
    return byMonth.get(m)!;
  };
  const salary = primarySalary(recurring, today);
  if (salary) {
    // Maaş dönemlerine grupla: her ödeme son ödeme gününden önce yatan son maaşın dönemine (bütçe ile aynı kural);
    // maaş ait olduğu aya, bütçe ayı seçilmiş tek seferlik gelir o aya, diğer gelirler yattıkları döneme
    const keyOf = (date: string) => salaryMonthFor(salary, date);
    const current = keyOf(today);
    for (const ob of obs) slot(keyOf(ob.overdue ? today : ob.date)).obligations.push({ ...ob, beforeIncome: false });
    for (const e of events) {
      // Düzenli gelirler ve bütçe ayı seçilmiş tek seferlik gelirler ait oldukları ayın grubunda (ör. 10 Aralık'ta yatan burs → Aralık)
      const key = !e.oneTime || e.fixedMonth ? e.coverMonth : keyOf(e.date);
      if (key < current) continue;
      slot(key).incomes.push(e);
    }
    // Maaşı yatmış ve ödemesi kalmamış dönem gösterilmez (geliri bugünkü nakitte); maaşı seçilen sürenin
    // dışında yatacak son dönem de yarım kalacağı için gösterilmez
    for (const [k, v] of byMonth) {
      const paidOn = occurrenceIn(salary, salary.coversPreviousMonth ? shiftMonth(k, 1) : k);
      if ((!v.obligations.length && v.incomes.every((e) => e.date < today)) || paidOn > until) byMonth.delete(k);
    }
  } else {
    // Takvim aylarına grupla: gelir yattığı ayda, ödeme son ödeme tarihinin ayında (gecikmişler bu ayda)
    const thisMonth = today.slice(0, 7);
    // Atama yalnızca "gelirden önce" uyarısı için kullanılır
    const assigned = [...unfunded, ...[...byEvent.values()].flat()];
    for (const ob of assigned) slot(ob.overdue ? thisMonth : ob.date.slice(0, 7)).obligations.push(ob);
    for (const e of events) {
      // Geçmiş aylardaki gelirler gösterilmez (bugünkü nakitte zaten var)
      if (e.date.slice(0, 7) < thisMonth) continue;
      slot(e.date.slice(0, 7)).incomes.push(e);
    }
  }
  // Maaş döneminin bilgisi: ait olduğu ay → yatış tarihi ve bir sonraki yatış
  const salaryInfo = (month: string): PlanMonth["salary"] => {
    if (!salary) return null;
    const paidMonth = salary.coversPreviousMonth ? shiftMonth(month, 1) : month;
    const paidOn = occurrenceIn(salary, paidMonth);
    const event = events.find((e) => e.itemId === salary.id && e.coverMonth === month) ?? null;
    return { event, name: salary.name, paidOn, nextPaidOn: occurrenceIn(salary, shiftMonth(paidMonth, 1)) };
  };
  let balance = liquidCents;
  const planMonths: PlanMonth[] = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => {
      const obligations = [...v.obligations].sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label, "tr"));
      const incomeCents = v.incomes.filter((e) => !e.skipped).reduce((s, e) => s + e.amountCents, 0);
      // Geçmiş tarihli gelirler zaten bugünkü nakitte
      const futureIncome = v.incomes.filter((e) => isUpcomingIncome(e, today)).reduce((s, e) => s + e.amountCents, 0);
      const totalCents = sum(obligations);
      balance += futureIncome - totalCents;
      return {
        month,
        salary: salaryInfo(month),
        incomes: v.incomes,
        obligations,
        incomeCents,
        totalCents,
        leftCents: incomeCents - totalCents,
        balanceCents: balance,
      };
    });

  return {
    months: planMonths,
    liquidCents,
    // Yalnız gösterilen dönemlerin gelirleri (yarım kalan son dönem hariç)
    totalIncomeCents: planMonths.flatMap((m) => m.incomes).filter((e) => isUpcomingIncome(e, today)).reduce((s, e) => s + e.amountCents, 0),
    totalObligationCents: sum(obs),
  };
}

/** Genel Bakış için: önümüzdeki `days` gündeki (ve gecikmiş) kart ve kredi ödemeleri. */
export function upcomingObligations(accounts: Account[], txs: Transaction[], today: string, days = 30): Obligation[] {
  return obligations(accounts, txs, [], today, addDays(today, days));
}
