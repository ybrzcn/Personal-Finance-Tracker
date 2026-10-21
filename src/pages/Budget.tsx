import { ChevronDown, ChevronLeft, ChevronRight, Pencil, Plus, Repeat } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CategoryDot, EmptyState, PageHeader, SummaryTile, type TileTone } from "../components/common";
import { errorMessage } from "../lib/api";
import { monthName } from "../lib/recurring";
import { amountToInput, formatDateShort, formatMonthYear, parseAmount, todayISO } from "../lib/format";
import type { BudgetRecurringRow, RecurringItem } from "../lib/types";
import { useBudgetReport } from "../state/budgetReport";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

function BudgetInput({ value, onSave }: { value: number | null; onSave(v: number | null): Promise<void> }) {
  const [text, setText] = useState(value ? amountToInput(value) : "");
  const [editing, setEditing] = useState(false);
  const commit = async () => {
    setEditing(false);
    const v = text.trim() ? parseAmount(text) : null;
    if (text.trim() && (v === null || v < 0)) {
      // Hatalı yazım limiti silmesin: eski değere dön
      setText(value ? amountToInput(value) : "");
      return;
    }
    if (v === (value ?? null)) return;
    await onSave(v && v > 0 ? v : null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
    if (e.key === "Escape") {
      e.stopPropagation();
      setText(value ? amountToInput(value) : "");
      setEditing(false);
    }
  };
  return (
    <input
      // Düzenlenebilir olduğu her zaman belli olsun: kalıcı hafif kenarlık
      className={`input w-24 py-1 text-right tabular-nums md:w-32 ${editing ? "" : "border-zinc-200 bg-transparent shadow-none hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"}`}
      inputMode="decimal"
      placeholder="+ Limit koy"
      aria-label="Aylık limit"
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={onKey}
    />
  );
}

function RecurringList({
  type,
  items,
  month,
  rows,
  totalCents,
  placeholder,
}: {
  type: "income" | "expense";
  items: RecurringItem[];
  month: string;
  /** Rapordaki satırlar; rapor yokken null (rakam yerine `placeholder`) */
  rows: Map<string, BudgetRecurringRow> | null;
  totalCents: number | null;
  placeholder: string;
}) {
  const { accountById, categoryById } = useData();
  const { formatMoney } = useSettings();
  const { openRecurringForm } = useUI();
  // Rapor yokken kayıtlar rakamsız listelenir; raporda satırı olmayan (yeni eklenmiş) kayıt rapor gelince görünür
  const withRow = items.map((r) => ({ r, row: rows?.get(r.id) ?? null }));
  const current = rows ? withRow.filter((x) => x.row?.started) : withRow;
  const upcoming = rows ? withRow.filter((x) => x.row?.upcoming) : [];
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
        <div>
          <h2 className="text-sm font-semibold">{type === "income" ? "Düzenli Gelirler" : "Düzenli Giderler"}</h2>
          <p className="text-xs text-zinc-500">
            <span className="capitalize">{monthName(month)}</span> toplamı {totalCents === null ? placeholder : formatMoney(totalCents / 100)}
          </p>
        </div>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => openRecurringForm(undefined, type)}>
          <Plus size={14} /> Ekle
        </button>
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title={type === "income" ? "Maaş gibi düzenli gelir ekleyin" : "Kira, fatura, abonelik ekleyin"}
          hint={type === "income" ? "Ödeme takvimi, kart ve kredi ödemelerini bu gelirlere göre dağıtır." : undefined}
        />
      ) : (
        <>
          {current.length === 0 ? (
            <p className="px-5 py-3 text-sm text-zinc-500">Bu ayda geçerli kayıt yok.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {current.map(({ r, row }) => {
                const exception = row?.exception ?? null;
                const none = exception?.amountCents === 0;
                return (
                  <li key={r.id} className={`group flex items-center gap-3 px-5 py-3 ${r.active ? "" : "[&>div]:opacity-60"}`}>
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-zinc-100 text-xs font-semibold tabular-nums dark:bg-zinc-800">
                      {r.day}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{r.name}</div>
                      <div className="truncate text-xs text-zinc-500">
                        {row ? formatDateShort(row.date) : placeholder}
                        {r.type === "income" && r.coversPreviousMonth && ` · ${monthName(month)} karşılığı`}
                        {r.accountId && accountById.get(r.accountId) && ` · ${accountById.get(r.accountId)!.name}`}
                        {r.categoryId && ` · ${categoryById.get(r.categoryId)?.name ?? ""}`}
                      </div>
                    </div>
                    {!r.active && (
                      <span className="shrink-0 rounded-full bg-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
                        pasif · toplama girmez
                      </span>
                    )}
                    <span className="text-right">
                      <span
                        className={`block font-semibold tabular-nums ${
                          none ? "text-zinc-400 line-through" : type === "income" ? "text-emerald-600 dark:text-emerald-400" : ""
                        }`}
                      >
                        {row ? formatMoney((none ? row.baseAmountCents : row.amountCents) / 100) : placeholder}
                      </span>
                      {exception && (
                        <span className="block text-xs text-indigo-600 dark:text-indigo-400">
                          {none ? "bu ay yok" : "bu aya özel"}
                          {exception.note && exception.note !== "Yatmayacak" ? (
                            ` · ${exception.note}`
                          ) : (
                            <>
                              {" · "}
                              <button className="underline underline-offset-2" onClick={() => openRecurringForm(r)}>
                                sebep ekle
                              </button>
                            </>
                          )}
                        </span>
                      )}
                    </span>
                    <button
                      className="icon-btn opacity-40 transition focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                      title="Düzenle"
                      aria-label={`${r.name} düzenle`}
                      onClick={() => openRecurringForm(r)}
                    >
                      <Pencil size={15} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {upcoming.length > 0 && (
            <p className="border-t border-zinc-100 px-5 py-2 text-xs text-zinc-500 dark:border-zinc-800">
              Sonraki aylarda başlayan:{" "}
              {upcoming.map(({ r }, i) => (
                <span key={r.id}>
                  {i > 0 && ", "}
                  <button className="underline-offset-2 hover:underline" onClick={() => openRecurringForm(r)}>
                    {r.name} ({formatDateShort(r.startDate!)})
                  </button>
                </span>
              ))}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function BudgetPage() {
  const { categories, transactions, accountById, budgets, recurring, setBudget, categoryById } = useData();
  const { formatMoney } = useSettings();
  const { toast } = useUI();
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const { report, error, loading, retry } = useBudgetReport(month);
  // Rapor yokken rakam yerine: "…" bekleniyor, "—" hata/yok (hiçbir yerde yanlış sıfır gösterilmez)
  const ph = loading && !error ? "…" : "—";
  const money = (cents: number | null | undefined) => (cents == null ? ph : formatMoney(cents / 100));
  // Sıfır tutarda eksi işareti gösterilmez
  const minus = (cents: number | null | undefined) => (cents == null ? ph : cents > 0 ? `−${formatMoney(cents / 100)}` : "—");

  const budgetBy = useMemo(() => new Map(budgets.map((b) => [b.categoryId, b.amount])), [budgets]);
  const lineBy = useMemo(() => new Map((report?.categories ?? []).map((l) => [l.categoryId, l])), [report]);
  // Satır sırası rapordan (Rust: bütçeli önce, harcama azalan, ad); raporda olmayan kategori sonda
  const lineRank = useMemo(() => new Map((report?.categories ?? []).map((l, i) => [l.categoryId, i])), [report]);
  const txById = useMemo(() => new Map(transactions.map((t) => [t.id, t])), [transactions]);
  const recurringById = useMemo(() => new Map(recurring.map((r) => [r.id, r])), [recurring]);
  const rowsById = useMemo(() => (report ? new Map(report.recurringRows.map((r) => [r.recurringId, r])) : null), [report]);
  const [showIrregular, setShowIrregular] = useState(false);

  // Kart harcamaları ekstresini ödeyecek maaşın ayına yazılır (Rust)
  const byLimitAndSpent = categories
    .filter((c) => c.type === "expense")
    .map((c) => ({ c, line: lineBy.get(c.id) ?? null, budget: budgetBy.get(c.id) ?? null }))
    .sort((a, b) => (lineRank.get(a.c.id) ?? Number.MAX_SAFE_INTEGER) - (lineRank.get(b.c.id) ?? Number.MAX_SAFE_INTEGER));
  // Rapor beklenirken satırlar son gösterilen sırada kalır (rapor gelince yer değiştirip zıplamasın)
  const lastOrder = useRef<string[]>([]);
  if (report) lastOrder.current = byLimitAndSpent.map((r) => r.c.id);
  const rank = (id: string) => {
    const i = lastOrder.current.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const rows = report ? byLimitAndSpent : [...byLimitAndSpent].sort((a, b) => rank(a.c.id) - rank(b.c.id));
  const incomes = recurring.filter((r) => r.type === "income");
  const expenses = recurring.filter((r) => r.type === "expense");
  const incomeLines = (report?.incomeLines ?? []).flatMap((l) => {
    const item = recurringById.get(l.recurringId);
    return item ? [{ ...l, item }] : [];
  });
  const irregularIncomes = (report?.irregularIncomes ?? []).flatMap((x) => {
    const t = txById.get(x.transactionId);
    return t ? [{ t, cents: x.cents }] : [];
  });
  const irregularByAccount = report?.irregularExpenseByAccount ?? [];

  const save = async (categoryId: string, v: number | null) => {
    try {
      await setBudget(categoryId, v);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const monthDate = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
  const totals = report?.totals ?? null;
  // Genel Bakış harcama tarihine göre sayar; bütçe kart harcamalarını ödeyecek maaşın ayına yazar. Fark açıklanır.
  const diffCents = totals ? totals.spentAllCents - totals.byDateCents : 0;
  const dateDiffHint =
    totals && Math.abs(diffCents) >= 1
      ? `Harcama tarihine göre ${formatMoney(totals.byDateCents / 100)}; ${formatMoney(Math.abs(diffCents) / 100)} kart harcaması ${
          diffCents < 0 ? "ödeyecek maaşın ayı olan başka bir aya" : "başka aylardan bu aya"
        } yazıldı.`
      : null;
  const tiles = [
    { label: "Toplam bütçe", cents: totals?.budgetCents, color: "info" as TileTone },
    { label: "Bütçeli harcama", cents: totals?.spentBudgetedCents, color: "expense" as TileTone },
    // Bütçe aşılınca kalan kutusu da gider rengine döner
    // Rapor yokken nötr ton (yanlışlıkla "yeşil" görünmesin)
    { label: "Kalan", cents: totals?.remainingCents, color: (!totals ? "plain" : totals.remainingCents < 0 ? "expense" : "income") as TileTone },
    { label: "Ayın gideri (bütçe ayına göre)", cents: totals?.spentAllCents, color: "plain" as TileTone, hint: dateDiffHint },
  ];

  return (
    <>
      <PageHeader
        title="Bütçe"
        subtitle="Kategori limitleri, düzenli gelir ve giderler"
        actions={
          <div className="flex items-center gap-1">
            <button className="icon-btn" title="Önceki ay" disabled={!report} onClick={() => report && setMonth(report.prevMonth)}>
              <ChevronLeft size={18} />
            </button>
            <span className="w-36 text-center text-sm font-medium capitalize">{formatMonthYear(monthDate)}</span>
            <button className="icon-btn" title="Sonraki ay" disabled={!report} onClick={() => report && setMonth(report.nextMonth)}>
              <ChevronRight size={18} />
            </button>
          </div>
        }
      />

      {error && (
        <div role="alert" className="card mb-4 flex items-center justify-between gap-3 px-5 py-4 text-sm">
          <span className="text-rose-600 dark:text-rose-400">Bütçe alınamadı: {error}</span>
          <button className="btn-secondary px-3 py-1.5 text-xs" onClick={retry}>
            Tekrar dene
          </button>
        </div>
      )}

      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <SummaryTile key={t.label} label={t.label} value={money(t.cents)} tone={t.color} hint={"hint" in t ? t.hint : undefined} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <section className="card overflow-hidden xl:col-span-3">
          <div className="border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
            <h2 className="text-sm font-semibold">Kategori Bütçeleri</h2>
            <p className="text-xs text-zinc-500">Limiti değiştirmek için tutara tıklayın; boş bırakırsanız limit kaldırılır.</p>
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map(({ c, line, budget }) => {
              const spent = line ? line.spentCents : null;
              const limit = line?.budgetCents ?? null;
              const pct = spent !== null && limit ? Math.min(100, (spent / limit) * 100) : 0;
              const over = spent !== null && limit !== null && spent > limit;
              const tone = over ? "bg-rose-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500";
              return (
                <li key={c.id} className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <CategoryDot color={c.color} size={10} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                    <span className={`text-sm tabular-nums ${over ? "font-semibold text-rose-600 dark:text-rose-400" : "text-zinc-600 dark:text-zinc-300"}`}>
                      {money(spent)}
                    </span>
                    <span className="text-zinc-400">/</span>
                    <BudgetInput key={`${c.id}:${budget}`} value={budget} onSave={(v) => save(c.id, v)} />
                  </div>
                  {spent !== null && limit !== null && (
                    <div className="mt-2 flex items-center gap-3">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className={`w-28 text-right text-xs tabular-nums ${over ? "text-rose-600 dark:text-rose-400" : "text-zinc-500"}`}>
                        {over ? `${formatMoney((spent - limit) / 100)} aşıldı` : `${formatMoney((limit - spent) / 100)} kaldı`}
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
            {report && report.uncategorizedCents !== null && (
              <li className="flex items-center gap-3 px-5 py-3 text-sm text-zinc-500">
                <span className="flex-1 italic">Kategorisiz</span>
                <span className="tabular-nums">{formatMoney(report.uncategorizedCents / 100)}</span>
              </li>
            )}
          </ul>
        </section>

        <div className="space-y-4 xl:col-span-2">
          <section className="card p-5">
            <h2 className="text-sm font-semibold">Aylık Plan Özeti</h2>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-500">Düzenli gelir</span>
                <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">{money(report?.regularIncomeCents)}</span>
              </div>
              {incomeLines.length > 0 && (
                <ul className="space-y-1 rounded-lg bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-800/50">
                  {incomeLines.map((l) => (
                    <li key={l.item.id} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate text-zinc-500">
                        {formatDateShort(l.date)} · {l.item.name}
                        {l.item.coversPreviousMonth && ` (${monthName(month)} karşılığı)`}
                        {l.receivedCents > 0 ? (
                          <span className="text-emerald-600 dark:text-emerald-400"> · yattı</span>
                        ) : l.exception ? (
                          <span className={l.exception.amountCents === 0 ? "text-rose-600 dark:text-rose-400" : "text-indigo-600 dark:text-indigo-400"}>
                            {" · "}
                            {l.exception.amountCents === 0 ? "yok" : "bu aya özel"}
                            {l.exception.note && l.exception.note !== "Yatmayacak" ? ` (${l.exception.note})` : ""}
                          </span>
                        ) : (
                          <span> · plan</span>
                        )}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {formatMoney(l.usedCents / 100)}
                        {l.receivedCents > 0 && l.receivedCents !== l.plannedCents && (
                          <span className="ml-1 text-zinc-400">(plan {formatMoney(l.plannedCents / 100)})</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex justify-between">
                <span className="text-zinc-500">Düzensiz gelir (bu ay)</span>
                <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">{money(report?.irregularIncomeCents)}</span>
              </div>
              {irregularIncomes.length > 0 && (
                <ul className="space-y-1 rounded-lg bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-800/50">
                  {irregularIncomes.slice(0, 6).map(({ t, cents }) => (
                    <li key={t.id} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate text-zinc-500">
                        {formatDateShort(t.date)} · {t.description || (t.categoryId && categoryById.get(t.categoryId)?.name) || "Gelir"}
                      </span>
                      <span className="shrink-0 tabular-nums">{formatMoney(cents / 100)}</span>
                    </li>
                  ))}
                  {irregularIncomes.length > 6 && <li className="text-zinc-400">+{irregularIncomes.length - 6} kayıt daha</li>}
                </ul>
              )}
              <div className="flex justify-between">
                <span className="text-zinc-500">Düzenli gider</span>
                <span className="font-medium tabular-nums">{minus(report?.regularExpenseCents)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">
                  Kategori bütçeleri{report && totals && report.budgetReservedCents > totals.budgetCents ? " (aşım dahil)" : ""}
                </span>
                <span className="font-medium tabular-nums">{minus(report?.budgetReservedCents)}</span>
              </div>
              <div>
                <button
                  type="button"
                  className="flex w-full justify-between text-left"
                  onClick={() => setShowIrregular((v) => !v)}
                  disabled={irregularByAccount.length === 0}
                  title="Hesaplara göre göster"
                >
                  <span className="flex items-center gap-1 text-zinc-500">
                    Düzensiz gider (bütçesiz kategoriler)
                    {irregularByAccount.length > 0 && <ChevronDown size={14} className={`transition ${showIrregular ? "rotate-180" : ""}`} />}
                  </span>
                  <span
                    className={`font-medium tabular-nums ${(report?.irregularExpenseCents ?? 0) > 0 ? "text-rose-600 dark:text-rose-400" : "text-zinc-400"}`}
                  >
                    {minus(report?.irregularExpenseCents)}
                  </span>
                </button>
                {showIrregular && (
                  <div className="mt-1.5 space-y-1 border-l-2 border-zinc-200 pl-3 text-xs dark:border-zinc-800">
                    {irregularByAccount.map(({ accountId, cents }) => {
                      const a = accountById.get(accountId);
                      return (
                        <div key={accountId} className="flex justify-between gap-3">
                          <span className="truncate text-zinc-500">
                            {a?.name ?? "Silinmiş hesap"}
                            {a?.kind === "credit_card" ? " · kart ekstresi" : ""}
                          </span>
                          <span className="tabular-nums text-zinc-600 dark:text-zinc-300">−{formatMoney(cents / 100)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="flex justify-between border-t border-zinc-200 pt-2 dark:border-zinc-800">
                <span className="font-medium">Kalan (kredi taksitleri ve birikim için)</span>
                <span className={`font-semibold tabular-nums ${(report?.leftCents ?? 0) < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>
                  {money(report?.leftCents)}
                </span>
              </div>
            </div>
            <details className="mt-3 text-xs text-zinc-500">
              <summary className="cursor-pointer font-medium">Nasıl hesaplanır?</summary>
              <ul className="mt-1.5 list-disc space-y-1 pl-4">
                <li>Düzensiz gelir/gider: İşlemler'e girilen ve bir düzenli kayıtla eşleşmeyen hareketler.</li>
                <li>Bütçeli kategorilerde limit düşülür (aşıldıysa harcanan); hiçbir tutar iki kez sayılmaz.</li>
                <li>Kart harcamaları, ekstresini ödeyecek maaşın ayına yazılır; taksitler kendi ekstrelerinin ayına düşer.</li>
              </ul>
            </details>
          </section>
          <RecurringList type="income" items={incomes} month={month} rows={rowsById} totalCents={report?.recurringTotals.incomeCents ?? null} placeholder={ph} />
          <RecurringList type="expense" items={expenses} month={month} rows={rowsById} totalCents={report?.recurringTotals.expenseCents ?? null} placeholder={ph} />
        </div>
      </div>
    </>
  );
}
