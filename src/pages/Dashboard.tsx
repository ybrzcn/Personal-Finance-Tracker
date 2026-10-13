import { ArrowRight, CalendarCheck, PieChart, Plus, Receipt, TrendingDown, TrendingUp, Wallet, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { dueText, paymentHints } from "../components/AccountCards";
import { MonthlyChart } from "../components/charts";
import { SpendingBreakdown } from "../components/Reports";
import { SetupChecklist } from "../components/SetupChecklist";
import { EmptyState, PageHeader, Segmented, TransactionItem, txAccountLabel } from "../components/common";
import { DueIncomeBanner } from "../components/DueIncomeBanner";
import { cashIncomeForMonth, plannedRegularIncomeInRange } from "../lib/budget";
import { cardSummary, spreadInstallments } from "../lib/cards";
import { upcomingObligations, type Obligation } from "../lib/plan";
import { formatDate, formatMonthYear, todayISO } from "../lib/format";
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
  type RangePreset,
} from "../lib/stats";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

type CardPeriod = RangePreset;
const PERIODS: CardPeriod[] = ["thisMonth", "lastMonth", "last30", "thisYear", "all"];

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
  hint,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone: "income" | "expense" | "positive" | "negative";
  hint?: string;
}) {
  const tones = {
    income: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400",
    expense: "bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400",
    positive: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400",
    negative: "bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400",
  } as const;
  const valueTone =
    tone === "positive" ? "text-emerald-600 dark:text-emerald-400" : tone === "negative" ? "text-rose-600 dark:text-rose-400" : "";
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{label}</span>
        <span className={`grid h-9 w-9 place-items-center rounded-xl ${tones[tone]}`}>
          <Icon size={18} />
        </span>
      </div>
      <div className={`mt-3 text-2xl font-semibold tracking-tight tabular-nums ${valueTone}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-500">{hint}</div>}
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
    <section className="card mt-4 p-3">
      <div className="flex items-center justify-between px-2 pb-2 pt-2">
        <h2 className="text-sm font-semibold">Yaklaşan Ödemeler · 30 gün</h2>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setPage("plan")}>
          Ödeme takvimi <ArrowRight size={14} />
        </button>
      </div>
      {items.length === 0 ? (
        <EmptyState icon={CalendarCheck} title="Önümüzdeki 30 günde kart veya kredi ödemesi yok" />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {items.map((ob) => {
            const account = accounts.find((a) => a.id === ob.accountId);
            return (
              <li key={ob.key} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
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
                <div className="text-sm font-semibold tabular-nums">{formatMoney(ob.amountCents / 100)}</div>
                {!ob.estimated && (
                  <button className="btn-secondary px-2.5 py-1 text-xs" onClick={() => pay(ob)}>
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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard
          label="Toplam Gelir"
          value={formatMoney(stats.income)}
          icon={TrendingUp}
          tone="income"
          hint={
            stats.planned > 0 ? `${RANGE_LABEL[period]} · ${formatMoney(stats.planned)} düzenli gelir (plan) dahil` : RANGE_LABEL[period]
          }
        />
        <StatCard
          label="Toplam Gider"
          value={formatMoney(stats.expense)}
          icon={TrendingDown}
          tone="expense"
          // Bütçe sayfası kart harcamalarını ödeyecek maaşın ayına yazar; burada harcama tarihi esas alınır
          hint={`${RANGE_LABEL[period]} · harcama tarihine göre`}
        />
        <StatCard
          label="Net Bakiye"
          value={formatMoney(stats.net)}
          icon={Wallet}
          tone={stats.net >= 0 ? "positive" : "negative"}
          hint={savingsRate !== null ? `Tasarruf oranı: %${savingsRate} · ${stats.count} işlem` : `${stats.count} işlem`}
        />
      </div>

      {accounts.some((a) => a.kind === "credit_card" || a.kind === "loan") && <UpcomingPayments />}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Tek kartta kategori / hesap / harcama yeri; hiç işlem yokken kurulum listesi yeterli */}
        {transactions.length > 0 && (
          <div className="flex lg:col-span-3">
            <SpendingBreakdown
              categories={report.categories}
              previous={report.previous}
              accounts={report.accounts}
              merchants={report.merchants}
              periodLabel={periodLabel}
            />
          </div>
        )}
        <section className={`card flex flex-col p-3 ${transactions.length > 0 ? "lg:col-span-2" : "lg:col-span-5"}`}>
          <div className="flex items-center justify-between px-2 pb-2 pt-2">
            <h2 className="text-sm font-semibold">Son İşlemler</h2>
            {transactions.length > 0 && (
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setPage("transactions")}>
                Tümü <ArrowRight size={14} />
              </button>
            )}
          </div>
          {recent.length ? (
            <div className="space-y-0.5">
              {recent.map((t) => (
                <TransactionItem
                  key={t.id}
                  tx={t}
                  category={t.categoryId ? categoryById.get(t.categoryId) : undefined}
                  accountLabel={txAccountLabel(t, accountById)}
                  onClick={() => openTransactionForm(t)}
                />
              ))}
            </div>
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

      <section className="card mt-4 flex flex-col p-5">
        <h2 className="mb-4 text-sm font-semibold">Son 6 Ay · Gelir / Gider</h2>
        {monthly.length ? (
          <MonthlyChart data={monthly} className="h-64" />
        ) : (
          <EmptyState
            icon={PieChart}
            title="Henüz gelir veya gider yok"
            hint="İlk işlemini ya da maaşını ekleyince aylık grafik burada görünür."
          />
        )}
      </section>
    </>
  );
}
