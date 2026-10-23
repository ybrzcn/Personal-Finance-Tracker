import { AlertTriangle, CalendarClock, CalendarRange, CalendarX, Check, CreditCard, HandCoins, Plus, Repeat, Undo2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toHints } from "../components/AccountCards";
import { EmptyState, PageHeader, Segmented, SummaryTile, type TileTone } from "../components/common";
import { formatDate, formatDateShort } from "../lib/format";
import { errorMessage } from "../lib/api";
import { locale, t, tm } from "../lib/i18n";
import { rich } from "../lib/rich";
import { incomeName, incomeNote, receivedName, type PlanNames } from "../lib/planLabels";
import { monthName } from "../lib/recurring";
import type { PlanIncomeEvent, PlanObligation, PlanObligationKind, PlanPaidRow } from "../lib/types";
import { useAccountsReport } from "../state/accountsReport";
import { useCashPlan } from "../state/cashPlan";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useToday } from "../state/today";
import { useUI } from "../state/ui";

const ICON: Record<PlanObligationKind, ReactNode> = {
  card: <CreditCard size={15} />,
  loan: <HandCoins size={15} />,
  recurring: <Repeat size={15} />,
  planned: <CalendarClock size={15} />,
};

type Horizon = "1" | "3" | "6";

const monthTitleFmt = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" });
const monthTitle = (ym: string) => monthTitleFmt.format(new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1));

const PAID_TEXT: Record<NonNullable<PlanPaidRow["cardStatus"]>, string> = { paid: t("ödendi"), minPaid: t("asgari ödendi"), partial: t("kısmen ödendi") };

// Ay başlığı büyük harfle başlar; çevrilen cümlenin geri kalanı küçük kalsın diye ayın iki yanı ayrı
const [SALARY_PRE, SALARY_POST] = t("{month} maaşıyla ödenecekler").split("{month}");

function ObligationList({
  items,
  money,
  onPay,
}: {
  items: PlanObligation[];
  money(c: number): string;
  onPay(ob: PlanObligation): void;
}) {
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {items.map((ob) => {
        const days = ob.daysLeft;
        return (
          <li key={ob.key} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-800">{ICON[ob.kind]}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {tm(ob.label)}
                {ob.estimated && (
                  <span className="ml-2 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800">{t("tahmini")}</span>
                )}
                {ob.beforeIncome && (
                  <span
                    className="ml-2 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
                    title={t("Son ödeme tarihi bu gelirden önce; ödemeyi gelir yatmadan (ör. KMH'den) yapmanız gerekir")}
                  >
                    {t("gelirden önce")}
                  </span>
                )}
                {ob.overdue && (
                  <span className="ml-2 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:bg-rose-500/10 dark:text-rose-400">
                    {t("gecikti")}
                  </span>
                )}
              </div>
              <div className="text-xs text-zinc-500">
                {formatDate(ob.date)} · {days === 0 ? t("bugün") : days > 0 ? t("{n} gün sonra", { n: days }) : t("{n} gün önce", { n: -days })}
                {ob.loanInterestCents !== null && ` · ${t("faiz {amount}", { amount: money(ob.loanInterestCents) })}`}
              </div>
            </div>
            <span className="font-semibold tabular-nums">{money(ob.amountCents)}</span>
            {(ob.kind === "card" || ob.kind === "loan") && !ob.estimated && (
              <button className="btn-primary min-h-8 px-3 py-1 text-xs font-semibold" onClick={() => onPay(ob)}>
                {t("Öde")}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Dönemin zaten ödenmiş (ya da ileri tarihli ödemesi girilmiş) kalemleri: soluk, düğmesiz */
function PaidList({ items, money }: { items: PlanPaidRow[]; money(c: number): string }) {
  return (
    <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
      {items.map((p) => (
        <li key={p.key} className="flex flex-wrap items-center gap-3 px-5 py-2 opacity-60">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-100 text-emerald-600 dark:bg-zinc-800 dark:text-emerald-400">
            <Check size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {tm(p.label)}
              <span className="ml-2 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                {p.scheduled ? t("ödeme planlandı") : p.cardStatus ? PAID_TEXT[p.cardStatus] : t("ödendi")}
              </span>
            </div>
            <div className="text-xs text-zinc-500">{formatDate(p.date)}</div>
          </div>
          <span className="font-semibold tabular-nums">{money(p.amountCents)}</span>
        </li>
      ))}
    </ul>
  );
}

export function CashPlanPage() {
  const { accounts, transactions, recurring, categories, setRecurringException } = useData();
  const { formatMoney } = useSettings();
  const { openTransactionForm, openLoanPayment, openRecurringForm, confirm, toast } = useUI();
  const { byId } = useAccountsReport();
  const [horizon, setHorizon] = useState<Horizon>("3");
  const today = useToday();
  const { report: plan, error, loading, retry } = useCashPlan(Number(horizon));
  const money = (c: number) => formatMoney(c / 100);
  // Rapor yokken rakam yerine: "…" bekleniyor, "—" hata/yok
  const ph = loading && !error ? "…" : "—";
  const hasIncome = recurring.some((r) => r.type === "income" && r.active);
  const names: PlanNames = useMemo(
    () => ({
      recurringById: new Map(recurring.map((r) => [r.id, r])),
      txById: new Map(transactions.map((t) => [t.id, t])),
      categoryById: new Map(categories.map((c) => [c.id, c])),
    }),
    [recurring, transactions, categories],
  );

  const pay = (ob: PlanObligation) => {
    const account = accounts.find((a) => a.id === ob.accountId);
    if (!account) return;
    if (ob.kind === "loan") return openLoanPayment(account);
    if (ob.kind === "card") {
      const hints = toHints(byId.get(account.id)?.card?.hints ?? []);
      openTransactionForm(undefined, { type: "transfer", toAccountId: account.id, amount: ob.amountCents / 100 }, hints);
    }
  };

  // Tek ay için "yatmayacak" istisnası (ücretsiz izin vb.) ekler veya kaldırır; ay rapordaki karşılık ayıdır
  const toggleSkip = async (e: PlanIncomeEvent) => {
    const item = recurring.find((r) => r.id === e.recurringId);
    if (!item) return;
    const month = e.coverMonth;
    try {
      // Yalnız "yok" (0) istisnası geri alınır; özel tutarlı istisna (ör. ikramiye) "yatmayacak" ile 0'a çevrilir
      if (e.skipException) {
        await setRecurringException(item.id, month, null, "");
        toast(t("{date} {name} yeniden plana alındı.", { date: formatDate(e.date), name: item.name }));
      } else {
        const ok = await confirm({
          title: t("{name} bu ay yatmayacak", { name: item.name }),
          message: (
            <>
              {rich(
                t(
                  "{date} tarihli {name} ({amount}) yatmayacak olarak işaretlenecek (ör. ücretsiz izin). Sebep eklemek veya farklı bir tutar girmek için Bütçe'de düzenli gelir formundaki \"Bu aya özel\" bölümünü kullanın.",
                ),
                {
                  date: <strong>{formatDate(e.date)}</strong>,
                  name: item.name.toLocaleLowerCase(locale),
                  amount: money(e.amountCents),
                },
              )}
            </>
          ),
          confirmLabel: t("Yatmayacak"),
        });
        if (!ok) return;
        await setRecurringException(item.id, month, 0, "");
        toast(t("{date} {name} yatmayacak olarak işaretlendi.", { date: formatDate(e.date), name: item.name }));
      }
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  // Gecikmiş ödemeler ayrı bir kartta en üstte; dönem kutularının toplamlarına yine dahildir
  const months = plan?.months ?? [];
  const overdue = plan?.overdue ?? [];
  const endCents = plan?.endCents ?? null;

  const tiles = [
    {
      label: t("Bugünkü nakit (banka + nakit)"),
      cents: plan?.liquidCents ?? null,
      color: "plain" as TileTone,
      tone: (plan?.liquidCents ?? 0) < 0 ? "text-rose-600 dark:text-rose-400" : "",
    },
    { label: t("Planlanan gelir"), cents: plan?.totalIncomeCents ?? null, color: "income" as TileTone, tone: "" },
    { label: t("Planlanan ödemeler"), cents: plan?.totalObligationCents ?? null, color: "expense" as TileTone, tone: "" },
    {
      label: t("Dönem sonu tahmini"),
      cents: endCents,
      // Eksiye düşecekse uyarı rengi; rapor yokken nötr
      color: (endCents === null ? "plain" : endCents < 0 ? "expense" : "net") as TileTone,
      tone: "",
    },
  ];

  return (
    <>
      <PageHeader
        title={t("Ödeme Takvimi")}
        subtitle={t("Kart, kredi ve düzenli ödemelerin hangi gelirden karşılanacağı")}
        actions={
          <Segmented<Horizon>
            value={horizon}
            onChange={setHorizon}
            options={[
              { value: "1", label: t("{n} ay", { n: 1 }) },
              { value: "3", label: t("{n} ay", { n: 3 }) },
              { value: "6", label: t("{n} ay", { n: 6 }) },
            ]}
          />
        }
      />

      {error && (
        <div role="alert" className="card mb-4 flex items-center justify-between gap-3 px-5 py-4 text-sm">
          <span className="text-rose-600 dark:text-rose-400">{t("Ödeme takvimi alınamadı: {error}", { error })}</span>
          <button className="btn-secondary px-3 py-1.5 text-xs" onClick={retry}>
            {t("Tekrar dene")}
          </button>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tiles.map((t) => (
          <SummaryTile key={t.label} label={t.label} value={t.cents === null ? ph : money(t.cents)} tone={t.color} valueClass={t.tone} />
        ))}
      </div>

      {!hasIncome && (
        <div className="card mb-4 flex flex-wrap items-center gap-3 p-4 text-sm">
          <AlertTriangle size={18} className="text-amber-500" />
          <span className="flex-1">{t("Ödemeleri maaşa göre dağıtmak için önce düzenli gelirinizi (maaş günü ve tutarı) ekleyin.")}</span>
          <button className="btn-primary" onClick={() => openRecurringForm(undefined, "income")}>
            <Plus size={16} /> {t("Maaş ekle")}
          </button>
        </div>
      )}

      {hasIncome && (
        <details className="card mb-4 px-5 py-3 text-sm">
          <summary className="cursor-pointer font-medium">{t("Bu sayfa nasıl okunur?")}</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-600 dark:text-zinc-300">
            <li>{t("Her kutu bir maaş dönemidir: o maaş yattığı günden bir sonraki maaşa kadar son ödemesi gelen her şey o maaşla ödenir.")}</li>
            <li>
              {rich(t("{left}: o dönemin gelirleri eksi ödemeleri. {stay}: bugünkü bakiyenden başlayarak o dönemin sonunda hesaplarında kalacak tahmini para."), {
                left: <strong>{t("Bu maaştan artan")}</strong>,
                stay: <strong>{t("Hesaplarında kalacak")}</strong>,
              })}
            </li>
            <li>{t("\"tahmini\" yazan ekstreler henüz kesilmedi; o döneme yazılan harcama ve taksitlerden hesaplanır.")}</li>
            <li>
              {t(
                "Soluk \"ödendi\" / \"yattı\" satırları dönemin zaten ödenmiş ve yatmış kalemleridir; dönem toplamına dahildir ama bakiyede oldukları için \"Hesaplarında kalacak\" tutarını değiştirmez.",
              )}
            </li>
          </ul>
        </details>
      )}

      {overdue.length > 0 && (
        <section className="card mb-4 overflow-hidden border-rose-300 dark:border-rose-500/40">
          <div className="flex flex-wrap items-baseline gap-x-4 border-b border-rose-200 bg-rose-50/70 px-5 py-3 dark:border-rose-500/30 dark:bg-rose-500/10">
            <h2 className="text-base font-semibold text-rose-700 dark:text-rose-300">{t("Gecikmiş ödemeler")}</h2>
            <span className="ml-auto text-sm text-rose-700 dark:text-rose-300">
              {rich(t("Toplam {amount} · en kısa sürede ödeyin"), { amount: <strong className="tabular-nums">{money(plan?.overdueCents ?? 0)}</strong> })}
            </span>
          </div>
          <ObligationList items={overdue} money={money} onPay={pay} />
        </section>
      )}

      {!plan ? null : months.length === 0 ? (
        <div className="card">
          <EmptyState icon={CalendarRange} title={t("Bu dönemde planlanan ödeme yok")} hint={t("Kart, kredi veya düzenli gider ekledikçe burada görünür.")} />
        </div>
      ) : (
        <div className="space-y-4">
          {months.map((m) => {
            const negative = m.periodLeftCents < 0;
            const salaryName = m.salary ? (names.recurringById.get(m.salary.recurringId)?.name ?? t("Maaş")) : "";
            const salaryNote = m.salary?.event ? incomeNote(m.salary.event) : null;
            const open = m.obligations.filter((o) => !o.overdue);
            return (
              <section key={m.month} className="card overflow-hidden">
                <div className="space-y-2 border-b border-zinc-200 bg-zinc-50/60 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900/60">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <div>
                      <h2 className="text-base font-semibold capitalize">
                        {m.salary && SALARY_PRE && <span className="normal-case">{SALARY_PRE}</span>}
                        {monthTitle(m.month)}
                        {m.salary && SALARY_POST && <span className="normal-case">{SALARY_POST}</span>}
                      </h2>
                      {m.salary && (
                        <p className="text-xs text-zinc-500">
                          {m.salary.event?.skipped ? (
                            <span className="font-medium text-rose-600 dark:text-rose-400">
                              {t("{name} {date} tarihinde yatmayacak", { name: salaryName, date: formatDateShort(m.salary.paidOn) })}
                              {salaryNote ? ` (${tm(salaryNote)})` : ""} · {t("bu dönemin ödemeleri diğer gelirlerden / bakiyeden")}
                            </span>
                          ) : (
                            <>
                              {t(m.salary.paidOn < today ? "{name} {date} yattı" : "{name} {date} yatar", { name: salaryName, date: formatDateShort(m.salary.paidOn) })}
                            </>
                          )}
                          {" · "}
                          {t("{from} – {to} arası ödemeler", { from: formatDateShort(m.salary.paidOn), to: formatDateShort(m.salary.periodEnd) })}
                        </p>
                      )}
                    </div>
                    <span className="ml-auto text-sm text-zinc-500">
                      {t("Gelir")} <strong className="tabular-nums text-emerald-600 dark:text-emerald-400">{money(m.periodIncomeCents)}</strong>
                      {" · "}
                      {t("Ödemeler")} <strong className="tabular-nums text-zinc-900 dark:text-zinc-100">{money(m.periodTotalCents)}</strong>
                      {m.overdueCents > 0 && <span className="text-xs"> {t("(gecikmiş {amount} dahil)", { amount: money(m.overdueCents) })}</span>}
                      {" · "}
                      <span title={t("Bu dönemin gelirlerinden, bu dönemin ödemeleri çıkınca kalan tutar (ödenmiş ve yatmış kalemler dahil)")}>{t("Bu maaştan artan")}</span>{" "}
                      <strong className={`tabular-nums ${negative ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                        {money(m.periodLeftCents)}
                      </strong>
                    </span>
                  </div>
                  {(m.incomes.length > 0 || m.received.length > 0) && (
                    <ul className="flex flex-wrap gap-2">
                      {m.incomes.map((e) => {
                        const note = incomeNote(e);
                        return (
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
                              {incomeName(e, names)}
                              {e.coverMonth !== e.date.slice(0, 7) && (
                                <span className="ml-1 text-xs font-normal text-zinc-500">{t("({month} karşılığı)", { month: monthName(e.coverMonth) })}</span>
                              )}
                            </span>
                            {e.skipped ? (
                              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                                {t("bu ay yok")}
                                {note && note !== "Yatmayacak" ? ` · ${tm(note)}` : ""}
                              </span>
                            ) : (
                              <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
                                +{money(e.amountCents)}
                                {e.oneTime && <span className="ml-1 text-xs text-zinc-500">{t("tek seferlik")}</span>}
                              </span>
                            )}
                            {e.date >= today && !e.oneTime && (
                              // Durum etiketi gibi okunmasın diye çerçeveli küçük bir eylem düğmesi
                              <button
                                className="ml-1 inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 text-xs text-zinc-600 hover:border-zinc-400 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
                                title={e.skipped ? t("Bu ayı yeniden plana al") : t("Ücretsiz izin vb. nedeniyle bu ay yatmayacak olarak işaretle")}
                                onClick={() => void toggleSkip(e)}
                              >
                                {e.skipped ? (
                                  <>
                                    <Undo2 size={12} /> {t("Geri al")}
                                  </>
                                ) : (
                                  <>
                                    <CalendarX size={12} /> {t("Bu ay atla")}
                                  </>
                                )}
                              </button>
                            )}
                          </li>
                        );
                      })}
                      {m.received.map((r) => (
                        <li
                          key={r.key}
                          className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-2.5 py-1 text-sm opacity-60 dark:border-emerald-500/20 dark:bg-emerald-500/5"
                        >
                          <span className="text-xs text-zinc-500">{formatDateShort(r.date)}</span>
                          <span className="font-medium">{receivedName(r, names)}</span>
                          <span className="tabular-nums text-emerald-600 dark:text-emerald-400">+{money(r.amountCents)}</span>
                          <span className="inline-flex items-center gap-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                            <Check size={12} /> {t("yattı")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {open.length === 0 ? (
                  <p className="px-5 py-3 text-sm text-zinc-500">
                    {m.overdueCents > 0
                      ? t("Bu dönemde gecikmiş ödemeler dışında ödeme yok.")
                      : m.salary
                        ? t("Bu döneme planlanmış ödeme yok.")
                        : t("Bu aya planlanmış ödeme yok.")}
                  </p>
                ) : (
                  <ObligationList items={open} money={money} onPay={pay} />
                )}
                {m.paid.length > 0 && <PaidList items={m.paid} money={money} />}
                <div className="flex justify-end border-t border-zinc-100 px-5 py-2 text-xs text-zinc-500 dark:border-zinc-800">
                  <span title={t("Bugünkü banka ve nakit bakiyenizden başlayarak, bu döneme kadarki tüm gelir ve ödemeler sonrası hesaplarınızda kalacak tutar")}>
                    {m.salary ? t("Hesaplarında kalacak (dönem sonu, tahmini):") : t("Hesaplarında kalacak (ay sonu, tahmini):")}
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
