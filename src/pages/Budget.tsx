import { ChevronDown, ChevronLeft, ChevronRight, Pencil, Plus, Repeat } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";
import { CategoryDot, EmptyState, PageHeader } from "../components/common";
import { errorMessage } from "../lib/api";
import { spreadInstallments } from "../lib/cards";
import { budgetExpenses, monthExpenses, regularExpenseForMonth, regularIncomeForMonth, splitMonthIncome } from "../lib/budget";
import { amountAt, amountForOccurrence, coverDate, coverMonthOf, exceptionFor, hasStarted, monthName, occurrenceIn, shiftMonth as shiftYm } from "../lib/recurring";
import { amountToInput, formatDateShort, formatMonthYear, parseAmount, todayISO } from "../lib/format";
import type { RecurringItem } from "../lib/types";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

function shiftMonth(ym: string, delta: number): string {
  const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

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

function RecurringList({ type, items, month }: { type: "income" | "expense"; items: RecurringItem[]; month: string }) {
  const { accountById, categoryById } = useData();
  const { formatMoney } = useSettings();
  const { openRecurringForm } = useUI();
  // Seçili ay için: o ayki yatış/ödeme tarihi (önceki ayın karşılığı olan gelirde bir sonraki ay) ve tutar
  const rows = items.map((r) => {
    const date = occurrenceIn(r, r.type === "income" && r.coversPreviousMonth ? shiftYm(month, 1) : month);
    return { r, date, started: hasStarted(r, date), amount: amountForOccurrence(r, date), exception: exceptionFor(r, coverMonthOf(r, date)) };
  });
  const current = rows.filter((x) => x.started);
  const upcoming = rows.filter((x) => !x.started && x.r.startDate && x.r.startDate > x.date);
  const total = current.filter((x) => x.r.active).reduce((s, x) => s + x.amount, 0);
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
        <div>
          <h2 className="text-sm font-semibold">{type === "income" ? "Düzenli Gelirler" : "Düzenli Giderler"}</h2>
          <p className="text-xs text-zinc-500">
            <span className="capitalize">{monthName(month)}</span> toplamı {formatMoney(total)}
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
              {current.map(({ r, date, amount, exception }) => (
                <li key={r.id} className={`group flex items-center gap-3 px-5 py-3 ${r.active ? "" : "[&>div]:opacity-60"}`}>
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-zinc-100 text-xs font-semibold tabular-nums dark:bg-zinc-800">
                    {r.day}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{r.name}</div>
                    <div className="truncate text-xs text-zinc-500">
                      {formatDateShort(date)}
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
                        exception && exception.amount === 0 ? "text-zinc-400 line-through" : type === "income" ? "text-emerald-600 dark:text-emerald-400" : ""
                      }`}
                    >
                      {formatMoney(exception && exception.amount === 0 ? amountAt(r, coverDate(r, date)) : amount)}
                    </span>
                    {exception && (
                      <span className="block text-xs text-indigo-600 dark:text-indigo-400">
                        {exception.amount === 0 ? "bu ay yok" : "bu aya özel"}
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
              ))}
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
  const { categories, transactions, accounts, accountById, budgets, recurring, setBudget, categoryById } = useData();
  const { formatMoney } = useSettings();
  const { toast } = useUI();
  const [month, setMonth] = useState(todayISO().slice(0, 7));

  const budgetBy = useMemo(() => new Map(budgets.map((b) => [b.categoryId, b.amount])), [budgets]);
  const spentBy = useMemo(() => {
    const m = new Map<string, number>();
    // Kart harcamaları ekstresini ödeyecek maaşın ayına yazılır
    for (const { t, cents, month: m2 } of budgetExpenses(transactions, accounts, recurring)) {
      if (m2 !== month) continue;
      const key = t.categoryId ?? "__none__";
      m.set(key, (m.get(key) ?? 0) + cents);
    }
    return m;
  }, [transactions, accounts, recurring, month]);
  const [showIrregular, setShowIrregular] = useState(false);

  const rows = categories
    .filter((c) => c.type === "expense")
    .map((c) => ({ c, spent: (spentBy.get(c.id) ?? 0) / 100, budget: budgetBy.get(c.id) ?? null }))
    .sort((a, b) => Number(b.budget !== null) - Number(a.budget !== null) || b.spent - a.spent || a.c.name.localeCompare(b.c.name, "tr"));

  const totalBudget = rows.reduce((s, r) => s + (r.budget ?? 0), 0);
  const spentBudgeted = rows.reduce((s, r) => s + (r.budget !== null ? r.spent : 0), 0);
  const spentAll = [...spentBy.values()].reduce((s, v) => s + v, 0) / 100;
  const incomes = recurring.filter((r) => r.type === "income");
  const expenses = recurring.filter((r) => r.type === "expense");
  const incomeLines = useMemo(() => regularIncomeForMonth(transactions, recurring, month), [transactions, recurring, month]);
  // Yattıysa yatan tutar, yatmadıysa o ay geçerli plan tutarı (zamlar dahil)
  const plannedIncome = incomeLines.reduce((s, l) => s + l.usedCents, 0) / 100;
  const plannedFixed = regularExpenseForMonth(recurring, month) / 100;
  const monthIncome = useMemo(() => splitMonthIncome(transactions, recurring, month), [transactions, recurring, month]);
  const irregularIncome = monthIncome.irregularCents / 100;
  const expenses2 = useMemo(
    () => monthExpenses(transactions, accounts, recurring, budgets, month),
    [transactions, accounts, recurring, budgets, month],
  );
  // Düzensiz giderlerin hesaplara göre dağılımı
  const irregularByAccount = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of expenses2.irregular) m.set(e.t.accountId, (m.get(e.t.accountId) ?? 0) + e.cents);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [expenses2]);
  const budgetReserved = expenses2.budgetReservedCents / 100;
  const irregularExpense = expenses2.irregularCents / 100;
  const left = plannedIncome + irregularIncome - plannedFixed - budgetReserved - irregularExpense;

  const save = async (categoryId: string, v: number | null) => {
    try {
      await setBudget(categoryId, v);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const monthDate = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
  // Sıfır tutarda eksi işareti gösterilmez
  const minus = (v: number) => (v > 0 ? `−${formatMoney(v)}` : "—");
  // Genel Bakış harcama tarihine göre sayar; bütçe kart harcamalarını ödeyecek maaşın ayına yazar. Fark açıklanır.
  const byDateCents = useMemo(
    () =>
      spreadInstallments(transactions)
        .filter((t) => t.type === "expense" && t.date.slice(0, 7) === month)
        .reduce((s, t) => s + Math.round(t.amount * 100), 0),
    [transactions, month],
  );
  const diffCents = Math.round(spentAll * 100) - byDateCents;
  const dateDiffHint =
    Math.abs(diffCents) >= 1
      ? `Harcama tarihine göre ${formatMoney(byDateCents / 100)}; ${formatMoney(Math.abs(diffCents) / 100)} kart harcaması ${
          diffCents < 0 ? "ödeyecek maaşın ayı olan başka bir aya" : "başka aylardan bu aya"
        } yazıldı.`
      : null;
  const tiles = [
    { label: "Toplam bütçe", value: totalBudget, tone: "" },
    { label: "Bütçeli harcama", value: spentBudgeted, tone: spentBudgeted > totalBudget && totalBudget > 0 ? "text-rose-600 dark:text-rose-400" : "" },
    { label: "Kalan", value: totalBudget - spentBudgeted, tone: totalBudget - spentBudgeted < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400" },
    { label: "Ayın gideri (bütçe ayına göre)", value: spentAll, tone: "", hint: dateDiffHint },
  ];

  return (
    <>
      <PageHeader
        title="Bütçe"
        subtitle="Kategori limitleri, düzenli gelir ve giderler"
        actions={
          <div className="flex items-center gap-1">
            <button className="icon-btn" title="Önceki ay" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
              <ChevronLeft size={18} />
            </button>
            <span className="w-36 text-center text-sm font-medium capitalize">{formatMonthYear(monthDate)}</span>
            <button className="icon-btn" title="Sonraki ay" onClick={() => setMonth((m) => shiftMonth(m, 1))}>
              <ChevronRight size={18} />
            </button>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="card p-4">
            <div className="text-xs text-zinc-500">{t.label}</div>
            <div className={`mt-1 text-xl font-semibold tabular-nums ${t.tone}`}>{formatMoney(t.value)}</div>
            {"hint" in t && t.hint && <div className="mt-1 text-xs text-zinc-500">{t.hint}</div>}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <section className="card overflow-hidden xl:col-span-3">
          <div className="border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
            <h2 className="text-sm font-semibold">Kategori Bütçeleri</h2>
            <p className="text-xs text-zinc-500">Limiti değiştirmek için tutara tıklayın; boş bırakırsanız limit kaldırılır.</p>
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map(({ c, spent, budget }) => {
              const pct = budget ? Math.min(100, (spent / budget) * 100) : 0;
              const over = budget !== null && spent > budget;
              const tone = over ? "bg-rose-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500";
              return (
                <li key={c.id} className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <CategoryDot color={c.color} size={10} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                    <span className={`text-sm tabular-nums ${over ? "font-semibold text-rose-600 dark:text-rose-400" : "text-zinc-600 dark:text-zinc-300"}`}>
                      {formatMoney(spent)}
                    </span>
                    <span className="text-zinc-400">/</span>
                    <BudgetInput key={`${c.id}:${budget}`} value={budget} onSave={(v) => save(c.id, v)} />
                  </div>
                  {budget !== null && (
                    <div className="mt-2 flex items-center gap-3">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className={`w-28 text-right text-xs tabular-nums ${over ? "text-rose-600 dark:text-rose-400" : "text-zinc-500"}`}>
                        {over ? `${formatMoney(spent - budget)} aşıldı` : `${formatMoney(budget - spent)} kaldı`}
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
            {spentBy.has("__none__") && (
              <li className="flex items-center gap-3 px-5 py-3 text-sm text-zinc-500">
                <span className="flex-1 italic">Kategorisiz</span>
                <span className="tabular-nums">{formatMoney((spentBy.get("__none__") ?? 0) / 100)}</span>
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
                <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">{formatMoney(plannedIncome)}</span>
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
                          <span className={l.exception.amount === 0 ? "text-rose-600 dark:text-rose-400" : "text-indigo-600 dark:text-indigo-400"}>
                            {" · "}
                            {l.exception.amount === 0 ? "yok" : "bu aya özel"}
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
                <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">{formatMoney(irregularIncome)}</span>
              </div>
              {monthIncome.irregular.length > 0 && (
                <ul className="space-y-1 rounded-lg bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-800/50">
                  {monthIncome.irregular.slice(0, 6).map((t) => (
                    <li key={t.id} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate text-zinc-500">
                        {formatDateShort(t.date)} · {t.description || (t.categoryId && categoryById.get(t.categoryId)?.name) || "Gelir"}
                      </span>
                      <span className="shrink-0 tabular-nums">{formatMoney(t.amount)}</span>
                    </li>
                  ))}
                  {monthIncome.irregular.length > 6 && <li className="text-zinc-400">+{monthIncome.irregular.length - 6} kayıt daha</li>}
                </ul>
              )}
              <div className="flex justify-between">
                <span className="text-zinc-500">Düzenli gider</span>
                <span className="font-medium tabular-nums">{minus(plannedFixed)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Kategori bütçeleri{budgetReserved > totalBudget ? " (aşım dahil)" : ""}</span>
                <span className="font-medium tabular-nums">{minus(budgetReserved)}</span>
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
                    {irregularByAccount.length > 0 && (
                      <ChevronDown size={14} className={`transition ${showIrregular ? "rotate-180" : ""}`} />
                    )}
                  </span>
                  <span className={`font-medium tabular-nums ${irregularExpense > 0 ? "text-rose-600 dark:text-rose-400" : "text-zinc-400"}`}>
                    {minus(irregularExpense)}
                  </span>
                </button>
                {showIrregular && (
                  <div className="mt-1.5 space-y-1 border-l-2 border-zinc-200 pl-3 text-xs dark:border-zinc-800">
                    {irregularByAccount.map(([id, cents]) => {
                      const a = accountById.get(id);
                      return (
                        <div key={id} className="flex justify-between gap-3">
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
                <span className={`font-semibold tabular-nums ${left < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>{formatMoney(left)}</span>
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
          <RecurringList type="income" items={incomes} month={month} />
          <RecurringList type="expense" items={expenses} month={month} />
        </div>
      </div>
    </>
  );
}
