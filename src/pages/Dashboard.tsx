import { GoalsSummary } from "../components/GoalsSummary";
import { ArrowRight, CalendarCheck, PieChart, Plus, Receipt } from "lucide-react";
import { useState } from "react";
import { dueText, toHints } from "../components/AccountCards";
import { SpendingBreakdown } from "../components/Reports";
import { SetupChecklist } from "../components/SetupChecklist";
import { Amount, EmptyState, PageHeader, Segmented, TILE_TONES, txAccountLabel } from "../components/common";
import { DueIncomeBanner } from "../components/DueIncomeBanner";
import { formatDate, formatMonthShort, formatMonthYear, parseISODate, todayISO } from "../lib/format";
import type { Category, OverviewSlice, PlanObligation, Transaction } from "../lib/types";
import { RANGE_LABEL, UNCATEGORIZED, type CategorySlice, type MerchantRow, type MonthPoint, type RangePreset } from "../lib/stats";
import { useAccountsReport } from "../state/accountsReport";
import { useUpcomingObligations } from "../state/cashPlan";
import { useData } from "../state/data";
import { useOverview } from "../state/overview";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";
import { merchantName, t, tm } from "../lib/i18n";

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
          <th className="py-1.5 text-left font-medium">{t("Ay")}</th>
          <th className="font-medium">{t("Gelir")}</th>
          <th className="font-medium">{t("Gider")}</th>
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
            <th className="py-1.5 font-medium">{t("Tarih")}</th>
            <th className="font-medium">{t("Açıklama")}</th>
            <th className="hidden font-medium sm:table-cell">{t("Kategori")}</th>
            <th className="hidden font-medium md:table-cell">{t("Hesap")}</th>
            <th className="text-right font-medium">{t("Tutar")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((tx) => {
            const transfer = tx.type === "transfer";
            const c = categoryOf(tx);
            const color = c?.color ?? UNCATEGORIZED.color;
            const name = c?.name ?? UNCATEGORIZED.name;
            return (
              <tr
                key={tx.id}
                onClick={() => onOpen(tx)}
                className="h-[34px] cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/70 dark:hover:bg-zinc-800/50"
              >
                <td className="whitespace-nowrap pr-3 text-zinc-500">{formatDate(tx.date)}</td>
                <td className="max-w-[16rem] pr-3 font-medium">
                  {/* Klavyeyle de açılabilsin diye açıklama bir düğme */}
                  <button type="button" className="block w-full truncate text-left" onClick={(e) => (e.stopPropagation(), onOpen(tx))}>
                    {tx.description || (transfer ? t("Transfer") : name)}
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
                <td className="hidden truncate pr-3 text-zinc-600 md:table-cell dark:text-zinc-400">{accountOf(tx)}</td>
                <td className="text-right">
                  <Amount tx={tx} />
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
  const { accounts } = useData();
  const { formatMoney } = useSettings();
  const { openTransactionForm, openLoanPayment, setPage } = useUI();
  const { byId } = useAccountsReport();
  const { report, error, loading, retry } = useUpcomingObligations(30);
  const items = report?.obligations ?? [];

  const pay = (ob: PlanObligation) => {
    const account = accounts.find((a) => a.id === ob.accountId);
    if (!account) return;
    if (ob.kind === "loan") return openLoanPayment(account);
    const hints = toHints(byId.get(account.id)?.card?.hints ?? []);
    openTransactionForm(undefined, { type: "transfer", toAccountId: account.id, amount: ob.amountCents / 100 }, hints);
  };

  return (
    <section className="card col-span-2 px-5 py-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">
          {t("Yaklaşan Ödemeler")} <span className="font-medium text-zinc-500">· {t("30 gün")}</span>
        </h2>
        <button className="btn-ghost -mr-2 px-2 py-1 text-xs" onClick={() => setPage("plan")}>
          {t("Ödeme takvimi")} <ArrowRight size={14} />
        </button>
      </div>
  {error ? (
    <div role="alert" className="flex items-center justify-between gap-3 py-3 text-sm">
      <span className="text-rose-600 dark:text-rose-400">{t("Yaklaşan ödemeler alınamadı: {error}", { error: tm(error) })}</span>
      <button className="btn-secondary px-3 py-1.5 text-xs" onClick={retry}>
        {t("Tekrar dene")}
      </button>
    </div>
  ) : !report ? (
    <p className="py-3 text-sm text-zinc-500">{loading ? "…" : "—"}</p>
  ) : items.length === 0 ? (
        <EmptyState icon={CalendarCheck} title={t("Önümüzdeki 30 günde kart veya kredi ödemesi yok")} />
      ) : (
        <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
          {items.map((ob) => {
            const account = accounts.find((a) => a.id === ob.accountId);
            return (
              <li key={ob.key} className="flex min-h-[50px] flex-wrap items-center gap-3 py-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: account?.color ?? "#94a3b8" }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {tm(ob.label)}
                    {ob.estimated && <span className="ml-2 text-xs font-normal text-zinc-500">{t("(tahmini)")}</span>}
                  </div>
                  <div className={`text-xs ${ob.overdue ? "text-rose-600 dark:text-rose-400" : "text-zinc-500"}`}>
                    {t("Son ödeme {date}", { date: formatDate(ob.date) })} · {dueText(ob.daysLeft)}
                  </div>
                </div>
                <div className="text-base font-bold tabular-nums">{formatMoney(ob.amountCents / 100)}</div>
                {/* Tahmini ekstrede düğme yok; yer tutucu hizayı korur */}
                {ob.estimated ? (
                  <span className="w-[60px]" />
                ) : (
                  <button className="btn-primary min-h-8 w-[60px] px-0 py-1 text-[13px] font-semibold" onClick={() => pay(ob)}>
                    {t("Öde")}
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
  const { transactions, categoryById, accounts, accountById } = useData();
  const { formatMoney } = useSettings();
  const { openTransactionForm, setPage } = useUI();
  const [period, setPeriod] = useState<CardPeriod>("thisMonth");
  const { report: ov, error, loading, refreshing, retry } = useOverview(period);
  // Aynı dönem yeniden alınırken (veri değişti, gün döndü) rakamlar soluk: güncel değiller
  const dim = refreshing ? "opacity-60 transition-opacity" : "transition-opacity";
  // Rapor beklenirken "…", alınamadıysa "—" (başka dönemin rakamı gösterilmez)
  const ph = loading && !error ? "…" : "—";
  const money = (cents: number | undefined) => (cents === undefined ? ph : formatMoney(cents / 100));
  const totals = ov?.totals;
  const periodLabel = RANGE_LABEL[period];

  // Rapor kimlik gönderir; ad ve renk veriden. Veride olmayan kategori (silinmiş ya da başka cihazda eklenmiş) tek
  // "Kategorisiz" satırında birleşir; silinmiş hesap "Silinmiş hesap"
  const categorySlices = (list: OverviewSlice[]): CategorySlice[] => {
    const merged = new Map<string, number>();
    for (const s of list) {
      const id = s.categoryId && categoryById.has(s.categoryId) ? s.categoryId : "__none__";
      merged.set(id, (merged.get(id) ?? 0) + s.cents);
    }
    return [...merged]
      .map(([id, cents]) => {
        const c = categoryById.get(id);
        return { id, name: c?.name ?? UNCATEGORIZED.name, color: c?.color ?? UNCATEGORIZED.color, value: cents / 100 };
      })
      .sort((a, b) => b.value - a.value);
  };
  const breakdown = ov && {
    categories: categorySlices(ov.categories),
    previous: ov.previous ? categorySlices(ov.previous) : null,
    accounts: ov.accounts.map((s): CategorySlice => {
      const a = accountById.get(s.accountId);
      return { id: s.accountId, name: a?.name ?? t("Silinmiş hesap"), color: a?.color ?? UNCATEGORIZED.color, value: s.cents / 100 };
    }),
    merchants: ov.merchants.map((m): MerchantRow => ({ key: m.key, name: merchantName(m.name), count: m.count, total: m.totalCents / 100 })),
  };
  const monthly: MonthPoint[] = (ov?.monthly ?? []).map((m) => ({
    key: m.month,
    label: formatMonthShort(parseISODate(`${m.month}-01`)),
    income: m.incomeCents / 100,
    expense: m.expenseCents / 100,
  }));
  // İleri tarihli (planlanan) işlemler "son işlemler"de gösterilmez
  const recent = transactions.filter((t) => t.date <= todayISO()).slice(0, 6);
  const netHint = totals
    ? totals.savingsRatePct !== null
      ? `${t("Tasarruf oranı: %{v}", { v: totals.savingsRatePct })} · ${t("{n} işlem", { n: totals.count })}`
      : t("{n} işlem", { n: totals.count })
    : undefined;
  const incomeHint =
    totals && totals.plannedCents > 0 ? `${periodLabel} · ${t("{amount} düzenli gelir (plan) dahil", { amount: formatMoney(totals.plannedCents / 100) })}` : periodLabel;

  return (
    <>
      <PageHeader
        title={t("Genel Bakış")}
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

      {error && (
        <div role="alert" className="card mb-4 flex items-center justify-between gap-3 px-5 py-4 text-sm">
          <span className="text-rose-600 dark:text-rose-400">{t("İstatistikler alınamadı: {error}", { error: tm(error) })}</span>
          <button className="btn-secondary px-3 py-1.5 text-xs" onClick={retry}>
            {t("Tekrar dene")}
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t("Net Bakiye")} value={money(totals?.netCents)} tone="net" className={`col-span-2 ${dim}`} hint={netHint} />
        <StatCard label={t("Toplam Gelir")} value={money(totals?.incomeCents)} tone="income" className={dim} hint={incomeHint} />
        <StatCard
          label={t("Toplam Gider")}
          value={money(totals?.expenseCents)}
          tone="expense"
          className={dim}
          // Bütçe sayfası kart harcamalarını ödeyecek maaşın ayına yazar; burada harcama tarihi esas alınır
          hint={`${periodLabel} · ${t("harcama tarihine göre")}`}
        />

        {/* Tek kartta kategori / hesap / harcama yeri; hiç işlem yokken kurulum listesi yeterli */}
        {transactions.length > 0 && (
          <div className={`col-span-2 flex lg:row-span-2 ${dim}`} aria-busy={refreshing}>
            {breakdown ? (
              <SpendingBreakdown {...breakdown} periodLabel={periodLabel} />
            ) : (
              <section className="card flex w-full flex-col px-5 py-4">
                <h2 className="text-[15px] font-semibold">{t("Harcama dağılımı")} · {periodLabel}</h2>
                <p className="mt-6 text-sm text-zinc-500">{ph}</p>
              </section>
            )}
          </div>
        )}

        {accounts.some((a) => a.kind === "credit_card" || a.kind === "loan") && <UpcomingPayments />}

        <GoalsSummary />

        <section className={`card col-span-2 px-5 py-4 ${transactions.length > 0 ? "" : "lg:col-span-4"} ${dim}`} aria-busy={refreshing}>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold">{t("Son 6 Ay · Gelir / Gider")}</h2>
            {monthly.length > 0 && (
              <span className="flex gap-3 text-xs text-zinc-500" aria-hidden>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-[9px] w-[9px] rounded-[3px] bg-[var(--income)]" />
                  {t("Gelir")}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-[9px] w-[9px] rounded-[3px] bg-[var(--expense)]" />
                  {t("Gider")}
                </span>
              </span>
            )}
          </div>
          {monthly.length ? (
            <MonthlyTable data={monthly} />
          ) : ov ? (
            <EmptyState
              icon={PieChart}
              title={t("Henüz gelir veya gider yok")}
              hint={t("İlk işlemini ya da maaşını ekleyince aylık grafik burada görünür.")}
            />
          ) : (
            <p className="py-3 text-sm text-zinc-500">{ph}</p>
          )}
        </section>

        <section className="card col-span-2 px-5 py-4 lg:col-span-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">{t("Son İşlemler")}</h2>
            {transactions.length > 0 && (
              <button className="btn-ghost -mr-2 px-2 py-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400" onClick={() => setPage("transactions")}>
                {t("Tümü")} <ArrowRight size={14} />
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
              title={t("Henüz işlem yok")}
              hint={t("İlk gelir veya giderinizi ekleyerek başlayın.")}
              action={
                <button className="btn-primary" onClick={() => openTransactionForm()}>
                  <Plus size={16} /> {t("İşlem Ekle")}
                </button>
              }
            />
          )}
        </section>
      </div>
    </>
  );
}
