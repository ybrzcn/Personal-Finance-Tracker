import { ArrowDown, ArrowUp, Download, Pencil, Plus, Receipt, Search, Sparkles, Trash2, X } from "lucide-react";
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
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

type TypeFilter = "all" | TxType;
type SortKey = "date" | "amount";

const PAGE_SIZE = 200;
const PRESETS: RangePreset[] = ["thisMonth", "lastMonth", "last30", "thisYear", "all"];


export function Transactions() {
  const { transactions, categories, categoryById, accounts, accountById, addTransaction, deleteTransaction, latest, restore, tags, tagById, setTransactionTags, currentTagIds } = useData();
  const { formatMoney } = useSettings();
  const { openTransactionForm, confirm, toast, accountFilter, setAccountFilter, tagFilter, setTagFilter } = useUI();

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
    const list = transactions.filter((t) => {
      if (type !== "all" && t.type !== type) return false;
      if (accountFilter !== "all" && t.accountId !== accountFilter && t.toAccountId !== accountFilter) return false;
      // "Kategorisiz": transferler zaten kategorisiz olduğu için dahil edilmez
      if (categoryId === "none" ? t.categoryId !== null || t.type === "transfer" : categoryId !== "all" && t.categoryId !== categoryId)
        return false;
      if (tagFilter === "none" ? (t.tagIds?.length ?? 0) > 0 : tagFilter !== "all" && !t.tagIds?.includes(tagFilter)) return false;
      if (!inRange(t.date, range)) return false;
      if (q) {
        const catName = t.categoryId ? categoryById.get(t.categoryId)?.name ?? "" : "";
        const hay = `${t.description} ${catName} ${txAccountLabel(t, accountById)} ${t.amount.toFixed(2)} ${amountToInput(t.amount)} ${formatMoney(t.amount)}`.toLocaleLowerCase("tr");
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
  const liveSelected = useMemo(() => filtered.filter((t) => selected.has(t.id)).map((t) => t.id), [filtered, selected]);
  const [menu, setMenu] = useState<"add" | "remove" | null>(null);
  useEffect(() => setSelected(new Set()), [deferredQuery, type, categoryId, accountFilter, tagFilter, from, to]);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = filtered.length > 0 && filtered.every((t) => selected.has(t.id));
  const selectedTags = useMemo(() => {
    const ids = new Set<string>();
    const live = new Set(liveSelected);
    for (const t of transactions) if (live.has(t.id)) for (const g of t.tagIds ?? []) ids.add(g);
    return tags.filter((t) => ids.has(t.id));
  }, [liveSelected, transactions, tags]);
  const applyBulk = async (tagId: string, mode: "add" | "remove") => {
    setMenu(null);
    const ids = liveSelected;
    try {
      const n = await setTransactionTags(ids, mode === "add" ? [tagId] : [], mode === "remove" ? [tagId] : []);
      const name = tagById.get(tagId)?.name ?? "";
      toast(mode === "add" ? `${n} işleme '${name}' eklendi.` : `${n} işlemden '${name}' kaldırıldı.`);
      setSelected(new Set());
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  const remove = async (t: Transaction) => {
    const ok = await confirm({
      title: "İşlemi sil",
      message: (
        <>
          <strong>{formatDate(t.date)}</strong> tarihli <strong>{formatMoney(t.amount)}</strong> tutarındaki{" "}
          {TYPE_LABEL[t.type].toLocaleLowerCase("tr")} kaydı kalıcı olarak silinecek.
        </>
      ),
      confirmLabel: "Sil",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteTransaction(t.id);
      // Geri al: aynı kayıt yeniden eklenir
      const { id: _id, createdAt: _c, ...input } = t;
      toast("İşlem silindi.", "success", {
        label: "Geri al",
        run: async () => {
          try {
            // Yalnız hâlâ var olan etiketler (arşivliler dahil) geri eklenir
            await addTransaction({ ...input, tagIds: (input.tagIds ?? []).filter((id) => currentTagIds().has(id)) });
            toast("İşlem geri getirildi.");
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
      title: "Otomatik kategorile",
      message: (
        <>
          <p>
            Kategorisiz <strong>{suggestions.size} işleme</strong> açıklamasına göre kategori atanacak:
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
      confirmLabel: "Uygula",
    });
    if (!ok) return;
    try {
      const data = await latest();
      await restore({ ...data, transactions: data.transactions.map((t) => ({ ...t, categoryId: t.categoryId ?? suggestions.get(t.id) ?? null })) });
      // Geri al: işlemden önceki veri aynen geri yüklenir
      toast(`${suggestions.size} işlem kategorilendi.`, "success", {
        label: "Geri al",
        run: async () => {
          try {
            await restore(data);
            toast("Kategorileme geri alındı.");
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
      const saved = await saveTextFile(`finans-islemler-${todayISO()}.csv`, await api.exportCsv(filtered.map((t) => t.id)), {
        name: "CSV",
        extensions: ["csv"],
      });
      if (saved) toast(`${filtered.length} işlem CSV olarak dışa aktarıldı.${SAVED_HINT}`);
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
        title="İşlemler"
        subtitle={
          accountFilter !== "all"
            ? `${accountById.get(accountFilter)?.name ?? "Hesap"} · ${filtered.length} kayıt`
            : `${transactions.length} kayıt`
        }
        actions={
          <>
            {suggestions.size > 0 && (
              <button className="btn-secondary" onClick={autoCategorize} title="Kategorisiz işlemlere açıklamaya göre kategori öner">
                <Sparkles size={16} /> {suggestions.size} işlemi kategorile
              </button>
            )}
            <button className="btn-secondary" onClick={exportCsv} disabled={!filtered.length}>
              <Download size={16} /> CSV
            </button>
            <button className="btn-primary" onClick={() => openTransactionForm()}>
              <Plus size={16} /> Yeni İşlem
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
              placeholder="Açıklama, kategori veya tutar ara…"
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
              { value: "all", label: "Tümü" },
              { value: "income", label: "Gelir" },
              { value: "expense", label: "Gider" },
              { value: "transfer", label: "Transfer" },
            ]}
          />
          <select className="input w-48" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="all">Tüm kategoriler</option>
            <option value="none">Kategorisiz</option>
            {filteredCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select className="input w-48" value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
            <option value="all">Tüm hesaplar</option>
            <AccountOptions accounts={accounts} />
          </select>
          <select className="input w-48" aria-label="Etiket süzgeci" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
            <option value="all">Tüm etiketler</option>
            <option value="none">Etiketsiz</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.archived ? " (arşivli)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <input type="date" className="input w-40" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="Başlangıç tarihi" />
            <span className="text-zinc-400">–</span>
            <input type="date" className="input w-40" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="Bitiş tarihi" />
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
              <X size={14} /> Filtreleri temizle
            </button>
          )}
        </div>
      </div>

      {liveSelected.length > 0 && (
        <div className="fixed inset-x-3 bottom-20 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2 shadow-lg md:sticky md:inset-auto md:top-2 md:mb-3 dark:border-zinc-700 dark:bg-zinc-900">
          <span className="text-sm font-medium">{liveSelected.length} işlem seçildi</span>
          <div className="relative">
            <button className="btn-secondary" onClick={() => setMenu(menu === "add" ? null : "add")}>
              Etiket ekle ▾
            </button>
            {menu === "add" && (
              <ul role="listbox" className="absolute bottom-full z-40 mb-1 max-h-60 w-56 md:bottom-auto md:top-full md:mb-0 md:mt-1 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                {tags.filter((t) => !t.archived).map((t) => (
                  <li key={t.id} role="option" aria-selected={false} className="cursor-pointer rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => applyBulk(t.id, "add")}>
                    {t.name}
                  </li>
                ))}
                {tags.every((t) => t.archived) && <li className="px-2 py-1.5 text-sm text-zinc-500">Henüz etiket yok; aşağıdan oluştur.</li>}
                <li>
                  <TagQuickCreate onCreated={(id) => applyBulk(id, "add")} />
                </li>
              </ul>
            )}
          </div>
          <div className="relative">
            <button className="btn-secondary" disabled={!selectedTags.length} onClick={() => setMenu(menu === "remove" ? null : "remove")}>
              Etiket kaldır ▾
            </button>
            {menu === "remove" && (
              <ul role="listbox" className="absolute bottom-full z-40 mb-1 max-h-60 w-56 md:bottom-auto md:top-full md:mb-0 md:mt-1 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                {selectedTags.map((t) => (
                  <li key={t.id} role="option" aria-selected={false} className="cursor-pointer rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => applyBulk(t.id, "remove")}>
                    {t.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button className="btn-ghost text-xs" onClick={() => setSelected(new Set())}>
            Seçimi kaldır
          </button>
        </div>
      )}

      {/* Filtre özeti */}
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 px-1 text-sm">
        <span className="text-zinc-500">
          <strong className="text-zinc-900 dark:text-zinc-100">{sum.count}</strong> işlem
        </span>
        <span className="text-zinc-500">
          Gelir: <strong className="tabular-nums text-emerald-600 dark:text-emerald-400">{formatMoney(sum.income)}</strong>
        </span>
        <span className="text-zinc-500">
          Gider: <strong className="tabular-nums text-rose-600 dark:text-rose-400">{formatMoney(sum.expense)}</strong>
        </span>
        <span className="text-zinc-500">
          Net:{" "}
          <strong className={`tabular-nums ${sum.net >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
            {formatMoney(sum.net)}
          </strong>
        </span>
      </div>

      <div className="card overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title={transactions.length ? "Filtrelere uyan işlem bulunamadı" : "Henüz işlem yok"}
            hint={transactions.length ? "Arama veya filtreleri değiştirmeyi deneyin." : "İlk gelir veya giderinizi ekleyin."}
            action={
              transactions.length ? (
                <button className="btn-secondary" onClick={resetFilters}>
                  Filtreleri temizle
                </button>
              ) : (
                <button className="btn-primary" onClick={() => openTransactionForm()}>
                  <Plus size={16} /> İşlem Ekle
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
                  <input type="checkbox" aria-label="Tümünü seç" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(filtered.map((t) => t.id)))} />
                </th>
                <th className="hidden w-32 px-4 py-2.5 md:table-cell">
                  <button className="inline-flex items-center gap-1 uppercase" onClick={() => toggleSort("date")}>
                    Tarih <SortIcon k="date" />
                  </button>
                </th>
                <th className="px-4 py-2.5">Açıklama</th>
                <th className="hidden w-40 px-4 py-2.5 md:table-cell">Kategori</th>
                <th className="hidden w-56 px-4 py-2.5 xl:table-cell">Hesap</th>
                <th className="w-32 px-4 py-2.5 text-right md:w-36">
                  <button className="inline-flex items-center gap-1 uppercase" onClick={() => toggleSort("amount")}>
                    <SortIcon k="amount" /> Tutar
                  </button>
                </th>
                <th className="hidden w-20 px-4 py-2.5 md:table-cell" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {filtered.slice(0, limit).map((t) => (
                <tr
                  key={t.id}
                  tabIndex={0}
                  title="Düzenlemek için tıklayın"
                  className="group cursor-pointer hover:bg-zinc-50 focus-visible:bg-zinc-50 dark:hover:bg-zinc-800/40 dark:focus-visible:bg-zinc-800/40"
                  onClick={() => openTransactionForm(t)}
                  onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && openTransactionForm(t)}
                >
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`${t.description || "İşlem"} seç`} checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                  </td>
                  <td className="hidden whitespace-nowrap px-4 py-2.5 tabular-nums text-zinc-600 md:table-cell dark:text-zinc-400">
                    {formatDate(t.date)}
                  </td>
                  <td className="max-w-0 px-4 py-2" title={t.description}>
                    <div className="flex items-center gap-2">
                      <span className="truncate">{t.description || <span className="text-zinc-400">—</span>}</span>
                      {t.type === "income" && t.budgetMonth && t.budgetMonth !== t.date.slice(0, 7) && (
                        <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium capitalize text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
                          {monthName(t.budgetMonth)} geliri
                        </span>
                      )}
                      {t.installments > 1 && (
                        <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                          {t.installments} taksit
                        </span>
                      )}
                      {(t.tagIds ?? []).map((g) => {
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
                        {formatDateShort(t.date)}
                        {t.type !== "transfer" && ` · ${(t.categoryId && categoryById.get(t.categoryId)?.name) || "Kategorisiz"}`} ·{" "}
                      </span>
                      {txAccountLabel(t, accountById)}
                    </div>
                  </td>
                  <td className="hidden px-4 py-2.5 md:table-cell">
                    {t.type === "transfer" ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <CategoryLabel category={t.categoryId ? categoryById.get(t.categoryId) : undefined} />
                    )}
                  </td>
                  <td className="hidden max-w-0 px-4 py-2 text-zinc-600 xl:table-cell dark:text-zinc-400" title={txAccountLabel(t, accountById)}>
                    {t.type === "transfer" ? (
                      // Transferde nereden ve nereye ayrı satırlarda: hedef hesap kesilmesin
                      <>
                        <div className="truncate">{accountById.get(t.accountId)?.name ?? "—"}</div>
                        <div className="truncate text-xs text-indigo-600 dark:text-indigo-400">→ {accountById.get(t.toAccountId ?? "")?.name ?? "—"}</div>
                      </>
                    ) : (
                      <div className="truncate">{txAccountLabel(t, accountById)}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <Amount tx={t} />
                  </td>
                  <td className="hidden px-4 py-2.5 md:table-cell">
                    {/* Eylemler hep görünür (soluk), üzerine gelince belirginleşir */}
                    <div className="flex justify-end gap-0.5 opacity-40 transition focus-within:opacity-100 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn" title="Düzenle" aria-label="Düzenle" onClick={() => openTransactionForm(t)}>
                        <Pencil size={15} />
                      </button>
                      <button className="icon-btn hover:!text-rose-600" title="Sil" aria-label="Sil" onClick={() => remove(t)}>
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
              Daha fazla göster ({filtered.length - limit} kaldı)
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
          const t = await addTag({ name, color: PALETTE[tags.length % PALETTE.length], budget: null, archived: false });
          onCreated(t.id);
        } catch (err) {
          toast(errorMessage(err), "error");
        }
      }}
    >
      <input className="input h-8 text-sm" placeholder="Yeni etiket" value={name} onChange={(e) => setName(e.target.value)} aria-label="Yeni etiket adı" />
      <button className="btn-secondary h-8 px-2 text-xs" type="submit">
        Ekle
      </button>
    </form>
  );
}
