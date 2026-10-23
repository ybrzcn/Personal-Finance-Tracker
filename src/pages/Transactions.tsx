import { ArrowDown, ArrowUp, Download, Paperclip, Pencil, Plus, Receipt, Search, Sparkles, Trash2, X } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { AccountOptions } from "../components/AccountOptions";
import { PALETTE } from "../components/CategoryForm";
import { Amount, CategoryLabel, EmptyState, PageHeader, Segmented, txAccountLabel } from "../components/common";
import { api, errorMessage } from "../lib/api";
import { SAVED_HINT, saveTextFile } from "../lib/fileio";
import { monthName } from "../lib/recurring";
import { amountToInput, formatDate, formatDateShort, todayISO } from "../lib/format";
import { inRange, presetRange, RANGE_LABEL, totals, type RangePreset } from "../lib/stats";
import { TYPE_LABEL, type Transaction, type TxType } from "../lib/types";
import { useCategorySuggestions } from "../state/categorySuggestions";
import { useAttachmentCounts } from "../state/attachments";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";
import { locale, t } from "../lib/i18n";
import { rich } from "../lib/rich";

type TypeFilter = "all" | TxType;
type SortKey = "date" | "amount";

const PAGE_SIZE = 200;
const PRESETS: RangePreset[] = ["thisMonth", "lastMonth", "last30", "thisYear", "all"];

export function Transactions() {
  const { transactions, categories, categoryById, accounts, accountById, addTransaction, deleteTransaction, latest, restore, tags, tagById, setTransactionTags, currentTagIds } = useData();
  const { formatMoney } = useSettings();
  const { openTransactionForm, confirm, toast, accountFilter, setAccountFilter, tagFilter, setTagFilter } = useUI();
  const { counts: attachmentCounts } = useAttachmentCounts();

  const [query, setQuery] = useState("");
  const [type, setType] = useState<TypeFilter>("all");
  const [categoryId, setCategoryId] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "date", dir: "desc" });
  const [limit, setLimit] = useState(PAGE_SIZE);
  const deferredQuery = useDeferredValue(query);

  const activePreset = PRESETS.find((p) => {
    const r = presetRange(p);
    return (r.from ?? "") === from && (r.to ?? "") === to;
  });

  const applyPreset = (p: RangePreset) => {
    const r = presetRange(p);
    setFrom(r.from ?? "");
    setTo(r.to ?? "");
  };

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLocaleLowerCase("tr");
    const range = { from: from || undefined, to: to || undefined };
    const list = transactions.filter((tx) => {
      if (type !== "all" && tx.type !== type) return false;
      if (accountFilter !== "all" && tx.accountId !== accountFilter && tx.toAccountId !== accountFilter) return false;
      // "Kategorisiz": transferler zaten kategorisiz olduğu için dahil edilmez
      if (categoryId === "none" ? tx.categoryId !== null || tx.type === "transfer" : categoryId !== "all" && tx.categoryId !== categoryId)
        return false;
      if (tagFilter === "none" ? (tx.tagIds?.length ?? 0) > 0 : tagFilter !== "all" && !tx.tagIds?.includes(tagFilter)) return false;
      if (!inRange(tx.date, range)) return false;
      if (q) {
        const catName = tx.categoryId ? categoryById.get(tx.categoryId)?.name ?? "" : "";
        const hay = `${tx.description} ${catName} ${txAccountLabel(tx, accountById)} ${tx.amount.toFixed(2)} ${amountToInput(tx.amount)} ${formatMoney(tx.amount)}`.toLocaleLowerCase("tr");
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (sort.key === "amount") list.sort((a, b) => a.amount - b.amount);
    else list.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    if (sort.dir === "desc") list.reverse();
    return list;
  }, [transactions, categoryById, accountById, deferredQuery, type, categoryId, accountFilter, tagFilter, from, to, sort]);

  const sum = useMemo(() => totals(filtered), [filtered]);
  const hasFilters = query || type !== "all" || categoryId !== "all" || accountFilter !== "all" || tagFilter !== "all" || from || to;

  const resetFilters = () => {
    setQuery("");
    setType("all");
    setCategoryId("all");
    setAccountFilter("all");
    setTagFilter("all");
    setFrom("");
    setTo("");
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Toplu işlem yalnız listede görünen seçili işlemlere uygulanır (silinen ya da süzgeç dışına çıkan seçimde kalmaz)
  const liveSelected = useMemo(() => filtered.filter((tx) => selected.has(tx.id)).map((tx) => tx.id), [filtered, selected]);
  const [menu, setMenu] = useState<"add" | "remove" | null>(null);
  useEffect(() => setSelected(new Set()), [deferredQuery, type, categoryId, accountFilter, tagFilter, from, to]);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = filtered.length > 0 && filtered.every((tx) => selected.has(tx.id));
  const selectedTags = useMemo(() => {
    const ids = new Set<string>();
    const live = new Set(liveSelected);
    for (const tx of transactions) if (live.has(tx.id)) for (const g of tx.tagIds ?? []) ids.add(g);
    return tags.filter((tx) => ids.has(tx.id));
  }, [liveSelected, transactions, tags]);
  const applyBulk = async (tagId: string, mode: "add" | "remove") => {
    setMenu(null);
    const ids = liveSelected;
    try {
      const n = await setTransactionTags(ids, mode === "add" ? [tagId] : [], mode === "remove" ? [tagId] : []);
      const name = tagById.get(tagId)?.name ?? "";
      toast(mode === "add" ? t("{n} işleme '{name}' eklendi.", { n, name }) : t("{n} işlemden '{name}' kaldırıldı.", { n, name }));
      setSelected(new Set());
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  const remove = async (tx: Transaction) => {
    const ok = await confirm({
      title: t("İşlemi sil"),
      message: (
        <>
          {rich(t("{date} tarihli {amount} tutarındaki {type} kaydı kalıcı olarak silinecek."), {
            date: <strong>{formatDate(tx.date)}</strong>,
            amount: <strong>{formatMoney(tx.amount)}</strong>,
            type: TYPE_LABEL[tx.type].toLocaleLowerCase(locale),
          })}
          {attachmentCounts[tx.id] > 0 && (
            <> {t('Ekli {n} belge de silinir; "Geri al" işlemi geri getirir, belgeleri getirmez.', { n: attachmentCounts[tx.id] })}</>
          )}
        </>
      ),
      confirmLabel: t("Sil"),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteTransaction(tx.id);
      // Geri al: aynı kayıt yeniden eklenir
      const { id: _id, createdAt: _c, ...input } = tx;
      toast(t("İşlem silindi."), "success", {
        label: t("Geri al"),
        run: async () => {
          try {
            // Yalnız hâlâ var olan etiketler (arşivliler dahil) geri eklenir
            await addTransaction({ ...input, tagIds: (input.tagIds ?? []).filter((id) => currentTagIds().has(id)) });
            toast(t("İşlem geri getirildi."));
          } catch (err) {
            toast(errorMessage(err), "error");
          }
        },
      });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  // Kategorisiz işlemler için öneriler (Rust)
  const suggestions = useCategorySuggestions();

  const autoCategorize = async () => {
    const counts = new Map<string, number>();
    for (const c of suggestions.values()) counts.set(c, (counts.get(c) ?? 0) + 1);
    const ok = await confirm({
      title: t("Otomatik kategorile"),
      message: (
        <>
          <p>
            {rich(t("Kategorisiz {count} açıklamasına göre kategori atanacak:"), {
              count: <strong>{t("{n} işleme", { n: suggestions.size })}</strong>,
            })}
          </p>
          <ul className="mt-2 space-y-0.5">
            {[...counts.entries()].map(([id, n]) => (
              <li key={id}>
                {categoryById.get(id)?.name}: {n}
              </li>
            ))}
          </ul>
        </>
      ),
      confirmLabel: t("Uygula"),
    });
    if (!ok) return;
    try {
      const data = await latest();
      await restore({ ...data, transactions: data.transactions.map((tx) => ({ ...tx, categoryId: tx.categoryId ?? suggestions.get(tx.id) ?? null })) });
      // Geri al: işlemden önceki veri aynen geri yüklenir
      toast(t("{n} işlem kategorilendi.", { n: suggestions.size }), "success", {
        label: t("Geri al"),
        run: async () => {
          try {
            await restore(data);
            toast(t("Kategorileme geri alındı."));
          } catch (err) {
            toast(errorMessage(err), "error");
          }
        },
      });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const exportCsv = async () => {
    try {
      const saved = await saveTextFile(`finans-islemler-${todayISO()}.csv`, await api.exportCsv(filtered.map((tx) => tx.id)), {
        name: "CSV",
        extensions: ["csv"],
      });
      if (saved) toast(`${t("{n} işlem CSV olarak dışa aktarıldı.", { n: filtered.length })}${SAVED_HINT}`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const SortIcon = ({ k }: { k: SortKey }) =>
    sort.key === k ? sort.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null;

  const filteredCategories = categories.filter((c) => type === "all" || c.type === type);

  return (
    <>
      <PageHeader
        title={t("İşlemler")}
        subtitle={
          accountFilter !== "all"
            ? `${accountById.get(accountFilter)?.name ?? t("Hesap")} · ${t("{n} kayıt", { n: filtered.length })}`
            : t("{n} kayıt", { n: transactions.length })
        }
        actions={
          <>
            {suggestions.size > 0 && (
              <button className="btn-secondary" onClick={autoCategorize} title={t("Kategorisiz işlemlere açıklamaya göre kategori öner")}>
                <Sparkles size={16} /> {t("{n} işlemi kategorile", { n: suggestions.size })}
              </button>
            )}
            <button className="btn-secondary" onClick={exportCsv} disabled={!filtered.length}>
              <Download size={16} /> CSV
            </button>
            <button className="btn-primary" onClick={() => openTransactionForm()}>
              <Plus size={16} /> {t("Yeni İşlem")}
            </button>
          </>
        }
      />

      {/* Filtreler */}
      <div className="card mb-4 space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              className="input pl-9"
              placeholder={t("Açıklama, kategori veya tutar ara…")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Segmented<TypeFilter>
            value={type}
            onChange={(v) => {
              setType(v);
              if (v !== "all" && categoryId !== "all" && categoryId !== "none" && categoryById.get(categoryId)?.type !== v)
                setCategoryId("all");
            }}
            options={[
              { value: "all", label: t("Tümü") },
              { value: "income", label: t("Gelir") },
              { value: "expense", label: t("Gider") },
              { value: "transfer", label: t("Transfer") },
            ]}
          />
          <select className="input w-48" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="all">{t("Tüm kategoriler")}</option>
            <option value="none">{t("Kategorisiz")}</option>
            {filteredCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select className="input w-48" value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
            <option value="all">{t("Tüm hesaplar")}</option>
            <AccountOptions accounts={accounts} />
          </select>
          <select className="input w-48" aria-label={t("Etiket süzgeci")} value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
            <option value="all">{t("Tüm etiketler")}</option>
            <option value="none">{t("Etiketsiz")}</option>
            {tags.map((tx) => (
              <option key={tx.id} value={tx.id}>
                {tx.name}
                {tx.archived ? ` (${t("arşivli")})` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <input type="date" className="input w-40" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label={t("Başlangıç tarihi")} />
            <span className="text-zinc-400">–</span>
            <input type="date" className="input w-40" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label={t("Bitiş tarihi")} />
          </div>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => applyPreset(p)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  activePreset === p
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                }`}
              >
                {RANGE_LABEL[p]}
              </button>
            ))}
          </div>
          {hasFilters && (
            <button className="btn-ghost ml-auto px-2 py-1 text-xs" onClick={resetFilters}>
              <X size={14} /> {t("Filtreleri temizle")}
            </button>
          )}
        </div>
      </div>

      {liveSelected.length > 0 && (
        <div className="fixed inset-x-3 bottom-20 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2 shadow-lg md:sticky md:inset-auto md:top-2 md:mb-3 dark:border-zinc-700 dark:bg-zinc-900">
          <span className="text-sm font-medium">{t("{n} işlem seçildi", { n: liveSelected.length })}</span>
          <div className="relative">
            <button className="btn-secondary" onClick={() => setMenu(menu === "add" ? null : "add")}>
              {t("Etiket ekle")} ▾
            </button>
            {menu === "add" && (
              <ul role="listbox" className="absolute bottom-full z-40 mb-1 max-h-60 w-56 md:bottom-auto md:top-full md:mb-0 md:mt-1 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                {tags.filter((tx) => !tx.archived).map((tx) => (
                  <li key={tx.id} role="option" aria-selected={false} className="cursor-pointer rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => applyBulk(tx.id, "add")}>
                    {tx.name}
                  </li>
                ))}
                {tags.every((tx) => tx.archived) && <li className="px-2 py-1.5 text-sm text-zinc-500">{t("Henüz etiket yok; aşağıdan oluştur.")}</li>}
                <li>
                  <TagQuickCreate onCreated={(id) => applyBulk(id, "add")} />
                </li>
              </ul>
            )}
          </div>
          <div className="relative">
            <button className="btn-secondary" disabled={!selectedTags.length} onClick={() => setMenu(menu === "remove" ? null : "remove")}>
              {t("Etiket kaldır")} ▾
            </button>
            {menu === "remove" && (
              <ul role="listbox" className="absolute bottom-full z-40 mb-1 max-h-60 w-56 md:bottom-auto md:top-full md:mb-0 md:mt-1 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                {selectedTags.map((tx) => (
                  <li key={tx.id} role="option" aria-selected={false} className="cursor-pointer rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => applyBulk(tx.id, "remove")}>
                    {tx.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button className="btn-ghost text-xs" onClick={() => setSelected(new Set())}>
            {t("Seçimi kaldır")}
          </button>
        </div>
      )}

      {/* Filtre özeti */}
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 px-1 text-sm">
        <span className="text-zinc-500">
          {rich(t("{count} işlem", { n: sum.count }), {
            count: <strong className="text-zinc-900 dark:text-zinc-100">{sum.count}</strong>,
          })}
        </span>
        <span className="text-zinc-500">
          {t("Gelir")}: <strong className="tabular-nums text-emerald-600 dark:text-emerald-400">{formatMoney(sum.income)}</strong>
        </span>
        <span className="text-zinc-500">
          {t("Gider")}: <strong className="tabular-nums text-rose-600 dark:text-rose-400">{formatMoney(sum.expense)}</strong>
        </span>
        <span className="text-zinc-500">
          {t("Net")}:{" "}
          <strong className={`tabular-nums ${sum.net >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
            {formatMoney(sum.net)}
          </strong>
        </span>
      </div>

      <div className="card overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title={transactions.length ? t("Filtrelere uyan işlem bulunamadı") : t("Henüz işlem yok")}
            hint={transactions.length ? t("Arama veya filtreleri değiştirmeyi deneyin.") : t("İlk gelir veya giderinizi ekleyin.")}
            action={
              transactions.length ? (
                <button className="btn-secondary" onClick={resetFilters}>
                  {t("Filtreleri temizle")}
                </button>
              ) : (
                <button className="btn-primary" onClick={() => openTransactionForm()}>
                  <Plus size={16} /> {t("İşlem Ekle")}
                </button>
              )
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60">
                {/* Telefonda tarih, kategori ve eylem sütunları gizlenir; tarih ve kategori açıklamanın altında */}
                <th className="w-10 px-3 py-2.5">
                  <input type="checkbox" aria-label={t("Tümünü seç")} checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(filtered.map((tx) => tx.id)))} />
                </th>
                <th className="hidden w-32 px-4 py-2.5 md:table-cell">
                  <button className="inline-flex items-center gap-1 uppercase" onClick={() => toggleSort("date")}>
                    {t("Tarih")} <SortIcon k="date" />
                  </button>
                </th>
                <th className="px-4 py-2.5">{t("Açıklama")}</th>
                <th className="hidden w-40 px-4 py-2.5 md:table-cell">{t("Kategori")}</th>
                <th className="hidden w-56 px-4 py-2.5 xl:table-cell">{t("Hesap")}</th>
                <th className="w-32 px-4 py-2.5 text-right md:w-36">
                  <button className="inline-flex items-center gap-1 uppercase" onClick={() => toggleSort("amount")}>
                    <SortIcon k="amount" /> {t("Tutar")}
                  </button>
                </th>
                <th className="hidden w-20 px-4 py-2.5 md:table-cell" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {filtered.slice(0, limit).map((tx) => (
                <tr
                  key={tx.id}
                  tabIndex={0}
                  title={t("Düzenlemek için tıklayın")}
                  className="group cursor-pointer hover:bg-zinc-50 focus-visible:bg-zinc-50 dark:hover:bg-zinc-800/40 dark:focus-visible:bg-zinc-800/40"
                  onClick={() => openTransactionForm(tx)}
                  onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && openTransactionForm(tx)}
                >
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={t("{name} seç", { name: tx.description || t("İşlem") })} checked={selected.has(tx.id)} onChange={() => toggle(tx.id)} />
                  </td>
                  <td className="hidden whitespace-nowrap px-4 py-2.5 tabular-nums text-zinc-600 md:table-cell dark:text-zinc-400">
                    {formatDate(tx.date)}
                  </td>
                  <td className="max-w-0 px-4 py-2" title={tx.description}>
                    <div className="flex items-center gap-2">
                      <span className="truncate">{tx.description || <span className="text-zinc-400">—</span>}</span>
                      {attachmentCounts[tx.id] > 0 && (
                        <span className="flex shrink-0 items-center text-zinc-400" title={t("{n} belge", { n: attachmentCounts[tx.id] })} aria-label={t("{n} belge", { n: attachmentCounts[tx.id] })}>
                          <Paperclip size={13} />
                          {attachmentCounts[tx.id] > 1 && <span className="text-[10px]">{attachmentCounts[tx.id]}</span>}
                        </span>
                      )}
                      {tx.type === "income" && tx.budgetMonth && tx.budgetMonth !== tx.date.slice(0, 7) && (
                        <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium capitalize text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
                          {t("{month} geliri", { month: monthName(tx.budgetMonth) })}
                        </span>
                      )}
                      {tx.installments > 1 && (
                        <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                          {t("{n} taksit", { n: tx.installments })}
                        </span>
                      )}
                      {(tx.tagIds ?? []).map((g) => {
                        const tg = tagById.get(g);
                        return tg ? (
                          <span key={g} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tg.color }} />
                            {tg.name}
                          </span>
                        ) : null;
                      })}
                    </div>
                    <div className="truncate text-xs text-zinc-500 xl:hidden">
                      <span className="md:hidden">
                        {formatDateShort(tx.date)}
                        {tx.type !== "transfer" && ` · ${(tx.categoryId && categoryById.get(tx.categoryId)?.name) || t("Kategorisiz")}`} ·{" "}
                      </span>
                      {txAccountLabel(tx, accountById)}
                    </div>
                  </td>
                  <td className="hidden px-4 py-2.5 md:table-cell">
                    {tx.type === "transfer" ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <CategoryLabel category={tx.categoryId ? categoryById.get(tx.categoryId) : undefined} />
                    )}
                  </td>
                  <td className="hidden max-w-0 px-4 py-2 text-zinc-600 xl:table-cell dark:text-zinc-400" title={txAccountLabel(tx, accountById)}>
                    {tx.type === "transfer" ? (
                      // Transferde nereden ve nereye ayrı satırlarda: hedef hesap kesilmesin
                      <>
                        <div className="truncate">{accountById.get(tx.accountId)?.name ?? "—"}</div>
                        <div className="truncate text-xs text-indigo-600 dark:text-indigo-400">→ {accountById.get(tx.toAccountId ?? "")?.name ?? "—"}</div>
                      </>
                    ) : (
                      <div className="truncate">{txAccountLabel(tx, accountById)}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <Amount tx={tx} />
                  </td>
                  <td className="hidden px-4 py-2.5 md:table-cell">
                    {/* Eylemler hep görünür (soluk), üzerine gelince belirginleşir */}
                    <div className="flex justify-end gap-0.5 opacity-40 transition focus-within:opacity-100 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn" title={t("Düzenle")} aria-label={t("Düzenle")} onClick={() => openTransactionForm(tx)}>
                        <Pencil size={15} />
                      </button>
                      <button className="icon-btn hover:!text-rose-600" title={t("Sil")} aria-label={t("Sil")} onClick={() => remove(tx)}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {filtered.length > limit && (
          <div className="border-t border-zinc-200 p-3 text-center dark:border-zinc-800">
            <button className="btn-ghost text-xs" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
              {t("Daha fazla göster ({n} kaldı)", { n: filtered.length - limit })}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function TagQuickCreate({ onCreated }: { onCreated(id: string): void }) {
  const { tags, addTag } = useData();
  const { toast } = useUI();
  const [name, setName] = useState("");
  return (
    <form
      className="flex gap-1 p-1"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        try {
          const tx = await addTag({ name, color: PALETTE[tags.length % PALETTE.length], budget: null, archived: false });
          onCreated(tx.id);
        } catch (err) {
          toast(errorMessage(err), "error");
        }
      }}
    >
      <input className="input h-8 text-sm" placeholder={t("Yeni etiket")} value={name} onChange={(e) => setName(e.target.value)} aria-label={t("Yeni etiket adı")} />
      <button className="btn-secondary h-8 px-2 text-xs" type="submit">
        {t("Ekle")}
      </button>
    </form>
  );
}
