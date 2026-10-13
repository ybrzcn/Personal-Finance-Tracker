import { AlertTriangle, CalendarClock, CalendarRange, CalendarX, CreditCard, HandCoins, Plus, Repeat, Undo2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { paymentHints } from "../components/AccountCards";
import { EmptyState, PageHeader, Segmented, SummaryTile, type TileTone } from "../components/common";
import { cardSummary } from "../lib/cards";
import { addDays, daysBetween, formatDate, formatDateShort, todayISO } from "../lib/format";
import { errorMessage } from "../lib/api";
import { buildCashPlan, type IncomeEvent, type Obligation, type ObligationKind } from "../lib/plan";
import { coverMonthOf, exceptionFor, monthName, withException } from "../lib/recurring";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

const ICON: Record<ObligationKind, ReactNode> = {
  card: <CreditCard size={15} />,
  loan: <HandCoins size={15} />,
  recurring: <Repeat size={15} />,
  planned: <CalendarClock size={15} />,
};

type Horizon = "1" | "3" | "6";

const monthTitleFmt = new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric" });
const monthTitle = (ym: string) => monthTitleFmt.format(new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1));

function ObligationList({
  items,
  today,
  money,
  onPay,
}: {
  items: Obligation[];
  today: string;
  money(c: number): string;
  onPay(ob: Obligation): void;
}) {
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {items.map((ob) => {
        const days = daysBetween(today, ob.date);
        return (
          <li key={ob.key} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-800">{ICON[ob.kind]}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {ob.label}
                {ob.estimated && (
                  <span className="ml-2 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800">tahmini</span>
                )}
                {ob.beforeIncome && (
                  <span
                    className="ml-2 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
                    title="Son ödeme tarihi bu gelirden önce; ödemeyi gelir yatmadan (ör. KMH'den) yapmanız gerekir"
                  >
                    gelirden önce
                  </span>
                )}
                {ob.overdue && (
                  <span className="ml-2 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:bg-rose-500/10 dark:text-rose-400">
                    gecikti
                  </span>
                )}
              </div>
              <div className="text-xs text-zinc-500">
                {formatDate(ob.date)} · {days === 0 ? "bugün" : days > 0 ? `${days} gün sonra` : `${-days} gün önce`}
                {ob.loanInterestCents !== undefined && ` · faiz ${money(ob.loanInterestCents)}`}
              </div>
            </div>
            <span className="font-semibold tabular-nums">{money(ob.amountCents)}</span>
            {(ob.kind === "card" || ob.kind === "loan") && !ob.estimated && (
              <button className="btn-primary min-h-8 px-3 py-1 text-xs font-semibold" onClick={() => onPay(ob)}>
                Öde
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function CashPlanPage() {
  const { accounts, transactions, recurring, updateRecurring } = useData();
  const { formatMoney } = useSettings();
  const { openTransactionForm, openLoanPayment, openRecurringForm, confirm, toast } = useUI();
  const [horizon, setHorizon] = useState<Horizon>("3");
  const today = todayISO();

  const plan = useMemo(
    () => buildCashPlan(accounts, transactions, recurring, today, Number(horizon)),
    [accounts, transactions, recurring, today, horizon],
  );
  const money = (c: number) => formatMoney(c / 100);
  const hasIncome = recurring.some((r) => r.type === "income" && r.active);

  const pay = (ob: Obligation) => {
    const account = accounts.find((a) => a.id === ob.accountId);
    if (!account) return;
    if (ob.kind === "loan") return openLoanPayment(account);
    if (ob.kind === "card") {
      const s = cardSummary(account, transactions, today);
      const hints = paymentHints(s.lastStatement, s.totalDebtCents);
      openTransactionForm(undefined, { type: "transfer", toAccountId: account.id, amount: ob.amountCents / 100 }, hints);
    }
  };

  // Tek ay için "yatmayacak" istisnası (ücretsiz izin vb.) ekler veya kaldırır
  const toggleSkip = async (e: IncomeEvent) => {
    const item = recurring.find((r) => r.id === e.itemId);
    if (!item) return;
    // İstisna, gelirin karşılık geldiği aya yazılır (10 Kasım'da yatan Ekim maaşı → Ekim)
    const month = coverMonthOf(item, e.date);
    const existing = exceptionFor(item, month);
    try {
      // Yalnız "yok" (0) istisnası geri alınır; özel tutarlı istisna (ör. ikramiye) "yatmayacak" ile 0'a çevrilir
      if (existing && existing.amount === 0) {
        await updateRecurring({ ...item, exceptions: withException(item, month, null) });
        toast(`${formatDate(e.date)} ${item.name} yeniden plana alındı.`);
      } else {
        const ok = await confirm({
          title: `${item.name} bu ay yatmayacak`,
          message: (
            <>
              <strong>{formatDate(e.date)}</strong> tarihli {item.name.toLocaleLowerCase("tr")} ({money(e.amountCents)}) yatmayacak olarak
              işaretlenecek (ör. ücretsiz izin). Sebep eklemek veya farklı bir tutar girmek için Bütçe'de düzenli gelir formundaki "Bu
              aya özel" bölümünü kullanın.
            </>
          ),
          confirmLabel: "Yatmayacak",
        });
        if (!ok) return;
        await updateRecurring({ ...item, exceptions: withException(item, month, 0, "") });
        toast(`${formatDate(e.date)} ${item.name} yatmayacak olarak işaretlendi.`);
      }
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  // Gecikmiş ödemeler ayrı bir kartta en üstte; dönem kutularının toplamlarına yine dahildir
  const overdue = plan.months.flatMap((m) => m.obligations.filter((o) => o.overdue));
  const overdueIn = (m: (typeof plan.months)[number]) => m.obligations.filter((o) => o.overdue).reduce((t, o) => t + o.amountCents, 0);

  const tiles = [
    { label: "Bugünkü nakit (banka + nakit)", cents: plan.liquidCents, color: "plain" as TileTone, tone: plan.liquidCents < 0 ? "text-rose-600 dark:text-rose-400" : "" },
    { label: "Planlanan gelir", cents: plan.totalIncomeCents, color: "income" as TileTone, tone: "" },
    { label: "Planlanan ödemeler", cents: plan.totalObligationCents, color: "expense" as TileTone, tone: "" },
    {
      label: "Dönem sonu tahmini",
      cents: plan.liquidCents + plan.totalIncomeCents - plan.totalObligationCents,
      // Eksiye düşecekse uyarı rengi
      color: (plan.liquidCents + plan.totalIncomeCents - plan.totalObligationCents < 0 ? "expense" : "net") as TileTone,
      tone: "",
    },
  ];

  return (
    <>
      <PageHeader
        title="Ödeme Takvimi"
        subtitle="Kart, kredi ve düzenli ödemelerin hangi gelirden karşılanacağı"
        actions={
          <Segmented<Horizon>
            value={horizon}
            onChange={setHorizon}
            options={[
              { value: "1", label: "1 ay" },
              { value: "3", label: "3 ay" },
              { value: "6", label: "6 ay" },
            ]}
          />
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tiles.map((t) => (
          <SummaryTile key={t.label} label={t.label} value={money(t.cents)} tone={t.color} valueClass={t.tone} />
        ))}
      </div>

      {!hasIncome && (
        <div className="card mb-4 flex flex-wrap items-center gap-3 p-4 text-sm">
          <AlertTriangle size={18} className="text-amber-500" />
          <span className="flex-1">Ödemeleri maaşa göre dağıtmak için önce düzenli gelirinizi (maaş günü ve tutarı) ekleyin.</span>
          <button className="btn-primary" onClick={() => openRecurringForm(undefined, "income")}>
            <Plus size={16} /> Maaş ekle
          </button>
        </div>
      )}

      {hasIncome && (
        <details className="card mb-4 px-5 py-3 text-sm">
          <summary className="cursor-pointer font-medium">Bu sayfa nasıl okunur?</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-600 dark:text-zinc-300">
            <li>Her kutu bir maaş dönemidir: o maaş yattığı günden bir sonraki maaşa kadar son ödemesi gelen her şey o maaşla ödenir.</li>
            <li>
              <strong>Bu maaştan artan</strong>: o dönemin gelirleri eksi ödemeleri. <strong>Hesaplarında kalacak</strong>: bugünkü bakiyenden
              başlayarak o dönemin sonunda hesaplarında kalacak tahmini para.
            </li>
            <li>"tahmini" yazan ekstreler henüz kesilmedi; o döneme yazılan harcama ve taksitlerden hesaplanır.</li>
          </ul>
        </details>
      )}

      {overdue.length > 0 && (
        <section className="card mb-4 overflow-hidden border-rose-300 dark:border-rose-500/40">
          <div className="flex flex-wrap items-baseline gap-x-4 border-b border-rose-200 bg-rose-50/70 px-5 py-3 dark:border-rose-500/30 dark:bg-rose-500/10">
            <h2 className="text-base font-semibold text-rose-700 dark:text-rose-300">Gecikmiş ödemeler</h2>
            <span className="ml-auto text-sm text-rose-700 dark:text-rose-300">
              Toplam <strong className="tabular-nums">{money(overdue.reduce((t, o) => t + o.amountCents, 0))}</strong> · en kısa sürede ödeyin
            </span>
          </div>
          <ObligationList items={overdue} today={today} money={money} onPay={pay} />
        </section>
      )}

      {plan.months.length === 0 ? (
        <div className="card">
          <EmptyState icon={CalendarRange} title="Bu dönemde planlanan ödeme yok" hint="Kart, kredi veya düzenli gider ekledikçe burada görünür." />
        </div>
      ) : (
        <div className="space-y-4">
          {plan.months.map((m) => {
            const negative = m.leftCents < 0;
            return (
              <section key={m.month} className="card overflow-hidden">
                <div className="space-y-2 border-b border-zinc-200 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <div>
                      <h2 className="text-base font-semibold capitalize">
                        {monthTitle(m.month)}
                        {m.salary && <span className="normal-case"> maaşıyla ödenecekler</span>}
                      </h2>
                      {m.salary && (
                        <p className="text-xs text-zinc-500">
                          {m.salary.event?.skipped ? (
                            <span className="font-medium text-rose-600 dark:text-rose-400">
                              {m.salary.name} {formatDateShort(m.salary.paidOn)} tarihinde yatmayacak
                              {m.salary.event.note ? ` (${m.salary.event.note})` : ""} · bu dönemin ödemeleri diğer gelirlerden / bakiyeden
                            </span>
                          ) : (
                            <>
                              {m.salary.name} {formatDateShort(m.salary.paidOn)} {m.salary.paidOn < today ? "yattı" : "yatar"}
                            </>
                          )}
                          {" · "}
                          {formatDateShort(m.salary.paidOn)} – {formatDateShort(addDays(m.salary.nextPaidOn, -1))} arası ödemeler
                        </p>
                      )}
                    </div>
                    <span className="ml-auto text-sm text-zinc-500">
                      Gelir <strong className="tabular-nums text-emerald-600 dark:text-emerald-400">{money(m.incomeCents)}</strong>
                      {" · "}Ödemeler <strong className="tabular-nums text-zinc-900 dark:text-zinc-100">{money(m.totalCents)}</strong>
                      {overdueIn(m) > 0 && <span className="text-xs"> (gecikmiş {money(overdueIn(m))} dahil)</span>}
                      {" · "}
                      <span title="Bu dönemin gelirlerinden, bu dönemin ödemeleri çıkınca kalan tutar">Bu maaştan artan</span>{" "}
                      <strong className={`tabular-nums ${negative ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                        {money(m.leftCents)}
                      </strong>
                    </span>
                  </div>
                  {m.incomes.length > 0 && (
                    <ul className="flex flex-wrap gap-2">
                      {m.incomes.map((e) => (
                        <li
                          key={e.key}
                          className={`flex items-center gap-2 rounded-lg border px-2.5 py-1 text-sm ${
                            e.skipped
                              ? "border-rose-200 bg-rose-50/60 dark:border-rose-500/20 dark:bg-rose-500/5"
                              : "border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/20 dark:bg-emerald-500/5"
                          }`}
                        >
                          <span className="text-xs text-zinc-500">{formatDateShort(e.date)}</span>
                          <span className="font-medium">
                            {e.name}
                            {e.coverMonth !== e.date.slice(0, 7) && (
                              <span className="ml-1 text-xs font-normal text-zinc-500">({monthName(e.coverMonth)} karşılığı)</span>
                            )}
                          </span>
                          {e.skipped ? (
                            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                              bu ay yok{e.note && e.note !== "Yatmayacak" ? ` · ${e.note}` : ""}
                            </span>
                          ) : (
                            <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
                              +{money(e.amountCents)}
                              {e.oneTime && <span className="ml-1 text-xs text-zinc-500">tek seferlik</span>}
                            </span>
                          )}
                          {e.date >= today && !e.oneTime && (
                            // Durum etiketi gibi okunmasın diye çerçeveli küçük bir eylem düğmesi
                            <button
                              className="ml-1 inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 text-xs text-zinc-600 hover:border-zinc-400 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
                              title={e.skipped ? "Bu ayı yeniden plana al" : "Ücretsiz izin vb. nedeniyle bu ay yatmayacak olarak işaretle"}
                              onClick={() => void toggleSkip(e)}
                            >
                              {e.skipped ? (
                                <>
                                  <Undo2 size={12} /> Geri al
                                </>
                              ) : (
                                <>
                                  <CalendarX size={12} /> Bu ay atla
                                </>
                              )}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {m.obligations.filter((o) => !o.overdue).length === 0 ? (
                  <p className="px-5 py-3 text-sm text-zinc-500">
                    {overdueIn(m) > 0 ? "Bu dönemde gecikmiş ödemeler dışında ödeme yok." : `${m.salary ? "Bu döneme" : "Bu aya"} planlanmış ödeme yok.`}
                  </p>
                ) : (
                  <ObligationList items={m.obligations.filter((o) => !o.overdue)} today={today} money={money} onPay={pay} />
                )}
                <div className="flex justify-end border-t border-zinc-100 px-5 py-2 text-xs text-zinc-500 dark:border-zinc-800">
                  <span title="Bugünkü banka ve nakit bakiyenizden başlayarak, bu döneme kadarki tüm gelir ve ödemeler sonrası hesaplarınızda kalacak tutar">
                    Hesaplarında kalacak ({m.salary ? "dönem sonu" : "ay sonu"}, tahmini):
                  </span>{" "}
                  <strong className={`ml-1 tabular-nums ${m.balanceCents < 0 ? "text-rose-600 dark:text-rose-400" : "text-zinc-900 dark:text-zinc-100"}`}>
                    {money(m.balanceCents)}
                  </strong>
                </div>
              </section>
            );
          })}
        </div>
      )}


    </>
  );
}
