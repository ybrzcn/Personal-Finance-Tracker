import { GoalsSummary } from "../components/GoalsSummary";
import { ArrowRight, CalendarCheck, PieChart, Plus, Receipt } from "lucide-react";
import { useMemo, useState } from "react";
import { dueText, paymentHints } from "../components/AccountCards";
import { SpendingBreakdown } from "../components/Reports";
import { SetupChecklist } from "../components/SetupChecklist";
import { Amount, EmptyState, PageHeader, Segmented, TILE_TONES, txAccountLabel } from "../components/common";
import { DueIncomeBanner } from "../components/DueIncomeBanner";
import { cashIncomeForMonth, plannedRegularIncomeInRange } from "../lib/budget";
import { cardSummary, spreadInstallments } from "../lib/cards";
import { upcomingObligations, type Obligation } from "../lib/plan";
import { formatDate, formatMonthYear, parseISODate, todayISO } from "../lib/format";
import type { Category, Transaction } from "../lib/types";
import {
  byAccount,
  byCategory,
  inRange,
  monthlySeries,
  presetRange,
  previousRange,
  RANGE_LABEL,
  topMerchants,
  totals,
  UNCATEGORIZED,
  type MonthPoint,
  type RangePreset,
} from "../lib/stats";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

type CardPeriod = RangePreset;
const PERIODS: CardPeriod[] = ["thisMonth", "lastMonth", "last30", "thisYear", "all"];

/** Renkli özet kutusu: net bakiye mavi ve geniş, gelir yeşil, gider somon */
function StatCard({
  label,
  value,
  tone,
  hint,
  className = "",
}: {
  label: string;
  value: string;
  tone: "net" | "income" | "expense";
  hint?: string;
  className?: string;
}) {
  const tones = TILE_TONES[tone];
  return (
    <div className={`flex flex-col justify-between gap-2 rounded-2xl px-5 py-[18px] ${tones.box} ${className}`}>
      <span className={`text-[13px] font-semibold ${tones.label}`}>{label}</span>
      <span
        className={`font-bold tabular-nums tracking-tight ${tone === "net" ? "text-4xl leading-none md:text-[44px]" : "text-xl leading-tight sm:text-[26px]"}`}
      >
        {value}
      </span>
      {hint && <span className={`text-[13px] ${tones.hint}`}>{hint}</span>}
    </div>
  );
}

/** Son 6 ay: tablo ve gelir/gider çubukları */
function MonthlyTable({ data }: { data: MonthPoint[] }) {
  const { formatMoney } = useSettings();
  const max = Math.max(...data.map((p) => Math.max(p.income, p.expense)), 0);
  const pct = (v: number) => `${max > 0 ? (v / max) * 100 : 0}%`;
  return (
    <table className="mt-1 w-full border-collapse text-[13px] tabular-nums">
      <thead>
        <tr className="border-b border-zinc-200 text-right text-[11px] text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
          <th className="py-1.5 text-left font-medium">Ay</th>
          <th className="font-medium">Gelir</th>
          <th className="font-medium">Gider</th>
          <th className="hidden w-[38%] sm:table-cell" />
        </tr>
      </thead>
      <tbody>
        {data.map((p) => (
          <tr key={p.key} className="h-[38px] border-b border-zinc-100 last:border-0 dark:border-zinc-800/70">
            <td className="whitespace-nowrap font-medium">{formatMonthYear(parseISODate(`${p.key}-01`))}</td>
            <td className="whitespace-nowrap pl-2 text-right">{formatMoney(p.income)}</td>
            <td className="whitespace-nowrap pl-2 text-right">{formatMoney(p.expense)}</td>
            <td className="hidden pl-4 sm:table-cell" aria-hidden>
              <span className="block h-[7px] rounded-full bg-[var(--income)]" style={{ width: pct(p.income) }} />
              <span className="mt-[3px] block h-[7px] rounded-full bg-[var(--expense)]" style={{ width: pct(p.expense) }} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Son işlemler tablosu; satıra tıklayınca işlem düzenlenir */
function RecentTable({
  items,
  onOpen,
  categoryOf,
  accountOf,
}: {
  items: Transaction[];
  onOpen(t: Transaction): void;
  categoryOf(t: Transaction): Category | undefined;
  accountOf(t: Transaction): string;
}) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="mt-1 w-full border-collapse text-[13px] tabular-nums">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-[11px] text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
            <th className="py-1.5 font-medium">Tarih</th>
            <th className="font-medium">Açıklama</th>
            <th className="hidden font-medium sm:table-cell">Kategori</th>
            <th className="hidden font-medium md:table-cell">Hesap</th>
            <th className="text-right font-medium">Tutar</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => {
            const transfer = t.type === "transfer";
            const c = categoryOf(t);
            const color = c?.color ?? UNCATEGORIZED.color;
            const name = c?.name ?? UNCATEGORIZED.name;
            return (
              <tr
                key={t.id}
                onClick={() => onOpen(t)}
                className="h-[34px] cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/70 dark:hover:bg-zinc-800/50"
              >
                <td className="whitespace-nowrap pr-3 text-zinc-500">{formatDate(t.date)}</td>
                <td className="max-w-[16rem] pr-3 font-medium">
                  {/* Klavyeyle de açılabilsin diye açıklama bir düğme */}
                  <button type="button" className="block w-full truncate text-left" onClick={(e) => (e.stopPropagation(), onOpen(t))}>
                    {t.description || (transfer ? "Transfer" : name)}
                  </button>
                </td>
                <td className="hidden pr-3 sm:table-cell">
                  {transfer ? (
                    <span className="text-zinc-400">—</span>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs"
                      style={{ backgroundColor: `${color}1f` }}
                    >
                      <span className="h-[7px] w-[7px] rounded-[2px]" style={{ backgroundColor: color }} />
                      <span className={c ? "" : "italic text-zinc-400"}>{name}</span>
                    </span>
                  )}
                </td>
                <td className="hidden truncate pr-3 text-zinc-600 md:table-cell dark:text-zinc-400">{accountOf(t)}</td>
                <td className="text-right">
                  <Amount tx={t} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UpcomingPayments() {
  const { accounts, transactions } = useData();
  const { formatMoney } = useSettings();
  const { openTransactionForm, openLoanPayment, setPage } = useUI();
  const today = todayISO();
  const items = useMemo(() => upcomingObligations(accounts, transactions, today, 30), [accounts, transactions, today]);

  const pay = (ob: Obligation) => {
    const account = accounts.find((a) => a.id === ob.accountId);
    if (!account) return;
    if (ob.kind === "loan") return openLoanPayment(account);
    const s = cardSummary(account, transactions, today);
    const hints = paymentHints(s.lastStatement, s.totalDebtCents);
    openTransactionForm(undefined, { type: "transfer", toAccountId: account.id, amount: ob.amountCents / 100 }, hints);
  };

  return (
    <section className="card col-span-2 px-5 py-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">
          Yaklaşan Ödemeler <span className="font-medium text-zinc-500">· 30 gün</span>
        </h2>
        <button className="btn-ghost -mr-2 px-2 py-1 text-xs" onClick={() => setPage("plan")}>
          Ödeme takvimi <ArrowRight size={14} />
        </button>
      </div>
      {items.length === 0 ? (
        <EmptyState icon={CalendarCheck} title="Önümüzdeki 30 günde kart veya kredi ödemesi yok" />
      ) : (
        <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
          {items.map((ob) => {
            const account = accounts.find((a) => a.id === ob.accountId);
            return (
              <li key={ob.key} className="flex min-h-[50px] flex-wrap items-center gap-3 py-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: account?.color ?? "#94a3b8" }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {ob.label}
                    {ob.estimated && <span className="ml-2 text-xs font-normal text-zinc-500">(tahmini)</span>}
                  </div>
                  <div className={`text-xs ${ob.overdue ? "text-rose-600 dark:text-rose-400" : "text-zinc-500"}`}>
                    Son ödeme {formatDate(ob.date)} · {dueText(today, ob.date)}
                  </div>
                </div>
                <div className="text-base font-bold tabular-nums">{formatMoney(ob.amountCents / 100)}</div>
                {/* Tahmini ekstrede düğme yok; yer tutucu hizayı korur */}
                {ob.estimated ? (
                  <span className="w-[60px]" />
                ) : (
                  <button className="btn-primary min-h-8 w-[60px] px-0 py-1 text-[13px] font-semibold" onClick={() => pay(ob)}>
                    Öde
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function Dashboard() {
  const { transactions, recurring, categoryById, accounts, accountById } = useData();
  const { formatMoney } = useSettings();
  const { openTransactionForm, setPage } = useUI();
  const [period, setPeriod] = useState<CardPeriod>("thisMonth");

  // Takip başlangıcı: en eski hesap açılışı veya işlem; öncesine plan maaşı yazılmaz
  const trackingStart = useMemo(
    () => [...accounts.map((a) => a.openingDate), ...transactions.map((t) => t.date)].filter(Boolean).sort()[0],
    [accounts, transactions],
  );
  // İstatistiklerde taksitli harcamalar aylara bölünür
  const spread = useMemo(() => spreadInstallments(transactions), [transactions]);

  const stats = useMemo(() => {
    const r = presetRange(period);
    const t = totals(spread.filter((x) => inRange(x.date, r)));
    // Maaş gibi düzenli gelirler İşlemler'e girilmese de plan tutarıyla sayılır (ayın sonuna kadar)
    const monthEnd = presetRange("thisMonth").to!;
    const from = r.from ?? [...transactions.map((x) => x.date), ...recurring.map((x) => x.startDate ?? monthEnd)].sort()[0] ?? monthEnd;
    const to = r.to && r.to < monthEnd ? r.to : monthEnd;
    const planned = from <= to ? plannedRegularIncomeInRange(transactions, recurring, from, to, trackingStart) / 100 : 0;
    // Adet olarak gerçek işlemler sayılır (taksit parçaları değil)
    const count = transactions.filter((x) => inRange(x.date, r)).length;
    return { ...t, income: t.income + planned, net: t.net + planned, planned, count };
  }, [spread, transactions, recurring, period, trackingStart]);

  // Raporlar sağ üstteki dönem filtresine göre hesaplanır
  const report = useMemo(() => {
    const r = presetRange(period);
    const inPeriod = spread.filter((t) => inRange(t.date, r));
    const prev = previousRange(period);
    return {
      categories: byCategory(inPeriod, "expense", categoryById),
      accounts: byAccount(inPeriod, accountById),
      merchants: topMerchants(inPeriod),
      previous: prev
        ? byCategory(
            spread.filter((t) => inRange(t.date, prev)),
            "expense",
            categoryById,
          )
        : null,
    };
  }, [spread, period, categoryById, accountById]);
  const periodLabel = RANGE_LABEL[period];

  // Gelir: düzenli gelirler (maaş vb.) yatış tarihlerine göre — işlem olarak girilmediyse plan tutarıyla — ve diğer gelir işlemleri
  const monthly = useMemo(() => {
    const points = monthlySeries(spread, 6).map((p) => ({
      ...p,
      income: cashIncomeForMonth(transactions, recurring, p.key, trackingStart) / 100,
    }));
    // Takip başlamadan önceki boş aylar gösterilmez
    const first = points.findIndex((p) => p.income > 0 || p.expense > 0);
    return first < 0 ? [] : points.slice(first);
  }, [spread, transactions, recurring, trackingStart]);
  // İleri tarihli (planlanan) işlemler "son işlemler"de gösterilmez
  const recent = transactions.filter((t) => t.date <= todayISO()).slice(0, 6);
  const savingsRate = stats.income > 0 ? Math.round((stats.net / stats.income) * 100) : null;

  return (
    <>
      <PageHeader
        title="Genel Bakış"
        subtitle={formatMonthYear(new Date())}
        actions={
          <>
            <Segmented<CardPeriod>
              value={period}
              onChange={setPeriod}
              options={PERIODS.map((v) => ({ value: v, label: RANGE_LABEL[v] }))}
            />
          </>
        }
      />

      <DueIncomeBanner />

      <SetupChecklist />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Net Bakiye"
          value={formatMoney(stats.net)}
          tone="net"
          className="col-span-2"
          hint={savingsRate !== null ? `Tasarruf oranı: %${savingsRate} · ${stats.count} işlem` : `${stats.count} işlem`}
        />
        <StatCard
          label="Toplam Gelir"
          value={formatMoney(stats.income)}
          tone="income"
          hint={
            stats.planned > 0 ? `${RANGE_LABEL[period]} · ${formatMoney(stats.planned)} düzenli gelir (plan) dahil` : RANGE_LABEL[period]
          }
        />
        <StatCard
          label="Toplam Gider"
          value={formatMoney(stats.expense)}
          tone="expense"
          // Bütçe sayfası kart harcamalarını ödeyecek maaşın ayına yazar; burada harcama tarihi esas alınır
          hint={`${RANGE_LABEL[period]} · harcama tarihine göre`}
        />

        {/* Tek kartta kategori / hesap / harcama yeri; hiç işlem yokken kurulum listesi yeterli */}
        {transactions.length > 0 && (
          <div className="col-span-2 flex lg:row-span-2">
            <SpendingBreakdown
              categories={report.categories}
              previous={report.previous}
              accounts={report.accounts}
              merchants={report.merchants}
              periodLabel={periodLabel}
            />
          </div>
        )}

        {accounts.some((a) => a.kind === "credit_card" || a.kind === "loan") && <UpcomingPayments />}

        <GoalsSummary />

        <section className={`card col-span-2 px-5 py-4 ${transactions.length > 0 ? "" : "lg:col-span-4"}`}>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold">Son 6 Ay · Gelir / Gider</h2>
            {monthly.length > 0 && (
              <span className="flex gap-3 text-xs text-zinc-500" aria-hidden>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-[9px] w-[9px] rounded-[3px] bg-[var(--income)]" />
                  Gelir
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-[9px] w-[9px] rounded-[3px] bg-[var(--expense)]" />
                  Gider
                </span>
              </span>
            )}
          </div>
          {monthly.length ? (
            <MonthlyTable data={monthly} />
          ) : (
            <EmptyState
              icon={PieChart}
              title="Henüz gelir veya gider yok"
              hint="İlk işlemini ya da maaşını ekleyince aylık grafik burada görünür."
            />
          )}
        </section>

        <section className="card col-span-2 px-5 py-4 lg:col-span-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">Son İşlemler</h2>
            {transactions.length > 0 && (
              <button className="btn-ghost -mr-2 px-2 py-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400" onClick={() => setPage("transactions")}>
                Tümü <ArrowRight size={14} />
              </button>
            )}
          </div>
          {recent.length ? (
            <RecentTable
              items={recent}
              onOpen={(t) => openTransactionForm(t)}
              categoryOf={(t) => (t.categoryId ? categoryById.get(t.categoryId) : undefined)}
              accountOf={(t) => txAccountLabel(t, accountById)}
            />
          ) : (
            <EmptyState
              icon={Receipt}
              title="Henüz işlem yok"
              hint="İlk gelir veya giderinizi ekleyerek başlayın."
              action={
                <button className="btn-primary" onClick={() => openTransactionForm()}>
                  <Plus size={16} /> İşlem Ekle
                </button>
              }
            />
          )}
        </section>
      </div>
    </>
  );
}
