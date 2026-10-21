import { ArrowRight, Pencil, Plus, Tags, Trash2, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { CategoryRuleForm } from "../components/CategoryRuleForm";
import { CategoryDot, CategoryLabel, EmptyState, PageHeader } from "../components/common";
import { errorMessage } from "../lib/api";
import type { Category, CategoryRule, CategoryType } from "../lib/types";
import { useBudgetReport } from "../state/budgetReport";
import { useData } from "../state/data";
import { useCategoryUsage } from "../state/overview";
import { useSettings } from "../state/settings";
import { useToday } from "../state/today";
import { useUI } from "../state/ui";

interface Usage {
  count: number;
  total: number;
}

export function Categories() {
  const { categories, categoryById, budgets, deleteCategory } = useData();
  const { formatMoney, settings, update } = useSettings();
  const { openCategoryForm, confirm, toast, setPage } = useUI();
  // Kural formu: undefined kapalı, null yeni kural
  const [ruleForm, setRuleForm] = useState<CategoryRule | null | undefined>(undefined);
  const limitBy = useMemo(() => new Map(budgets.map((b) => [b.categoryId, b.amount])), [budgets]);
  // Bu ayki harcama: Bütçe raporundan (kart harcaması ödeyecek maaşın ayına) — Bütçe sayfasıyla aynı rakam
  const thisMonth = useToday().slice(0, 7);
  const { report: budget, error: budgetError, retry: retryBudget } = useBudgetReport(thisMonth);
  const monthSpent = useMemo(() => new Map((budget?.categories ?? []).map((l) => [l.categoryId, l.spentCents / 100])), [budget]);
  // İşlem sayısı ve toplam (Rust)
  const { report: usageReport, loading: usageLoading, error: usageError, retry: retryUsage } = useCategoryUsage();
  const loadError = usageError ?? budgetError;
  const usage = useMemo(
    () => new Map<string, Usage>((usageReport?.categories ?? []).map((u) => [u.categoryId, { count: u.count, total: u.totalCents / 100 }])),
    [usageReport],
  );

  const remove = async (c: Category) => {
    // Kullanım raporu yoksa (yerel mod, hata) sayı yerine genel uyarı
    const used = usageReport ? (usage.get(c.id)?.count ?? 0) : null;
    const ok = await confirm({
      title: "Kategoriyi sil",
      message: (
        <>
          <strong>{c.name}</strong> kategorisi silinecek.
          {used === null ? (
            <> Bu kategorideki işlemler silinmez, &quot;Kategorisiz&quot; kalır.</>
          ) : (
            used > 0 && (
              <>
                {" "}
                Bu kategoriye ait <strong>{used} işlem</strong> silinmeyecek, &quot;Kategorisiz&quot; olarak kalacak.
              </>
            )
          )}
        </>
      ),
      confirmLabel: "Sil",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteCategory(c.id);
      toast("Kategori silindi.");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const removeRule = async (r: CategoryRule) => {
    const ok = await confirm({
      title: "Kuralı sil",
      message: (
        <>
          <strong>{r.words.join(", ")}</strong> kuralı silinecek. İşlemlerin kategorisi değişmez.
        </>
      ),
      confirmLabel: "Sil",
      danger: true,
    });
    if (!ok) return;
    try {
      await update({ categoryRules: settings.categoryRules.filter((x) => x.id !== r.id) });
      toast("Kural silindi.");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const Column = ({ type, title }: { type: CategoryType; title: string }) => {
    const list = categories.filter((c) => c.type === type);
    return (
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${type === "income" ? "bg-emerald-500" : "bg-rose-500"}`} />
            <h2 className="text-sm font-semibold">{title}</h2>
            <span className="text-xs text-zinc-500">{list.length}</span>
          </div>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => openCategoryForm(undefined, type)}>
            <Plus size={14} /> Ekle
          </button>
        </div>
        {list.length === 0 ? (
          <EmptyState icon={Tags} title="Kategori yok" />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {list.map((c) => {
              const u = usage.get(c.id);
              return (
                <li key={c.id} className="group flex items-center gap-3 px-5 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                  <CategoryDot color={c.color} size={12} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{c.name}</div>
                    <div className="text-xs text-zinc-500">
                      {u
                        ? `${u.count} işlem · toplam ${formatMoney(u.total)}`
                        : usageReport
                          ? "Henüz kullanılmadı"
                          : usageLoading
                            ? "…"
                            : "—"}
                      {type === "expense" && budget && (monthSpent.get(c.id) || limitBy.has(c.id)) && (
                        <>
                          {" · "}
                          <button className="underline-offset-2 hover:underline" onClick={() => setPage("budget")} title="Bütçe'de aç">
                            bu ay {formatMoney(monthSpent.get(c.id) ?? 0)}
                            {limitBy.has(c.id) ? ` / limit ${formatMoney(limitBy.get(c.id)!)}` : ""}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-0.5 opacity-40 transition group-hover:opacity-100 focus-within:opacity-100">
                    <button className="icon-btn" title="Düzenle" aria-label={`${c.name} düzenle`} onClick={() => openCategoryForm(c)}>
                      <Pencil size={15} />
                    </button>
                    <button className="icon-btn hover:!text-rose-600" title="Sil" aria-label={`${c.name} sil`} onClick={() => remove(c)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  };

  return (
    <>
      <PageHeader title="Kategoriler" subtitle="Gelir ve giderlerinizi gruplandırmak için kategorileri yönetin." />
      {loadError && (
        <div role="alert" className="card mb-4 flex items-center justify-between gap-3 px-5 py-4 text-sm">
          <span className="text-rose-600 dark:text-rose-400">Kategori bilgileri alınamadı: {loadError}</span>
          <button
            className="btn-secondary px-3 py-1.5 text-xs"
            onClick={() => {
              retryUsage();
              retryBudget();
            }}
          >
            Tekrar dene
          </button>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Column type="income" title="Gelir Kategorileri" />
        <Column type="expense" title="Gider Kategorileri" />
      </div>
      <section className="card mt-4 overflow-hidden">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Otomatik kategori kuralları</h2>
              <span className="text-xs text-zinc-500">{settings.categoryRules.length}</span>
            </div>
            <p className="mt-0.5 text-xs text-zinc-500">
              Açıklamada kelime geçerse kategori kendiliğinden seçilir. Kurallarınız geçmişten öğrenilen önerilerden önce gelir.
            </p>
          </div>
          <button className="btn-ghost shrink-0 px-2 py-1 text-xs" onClick={() => setRuleForm(null)}>
            <Plus size={14} /> Kural ekle
          </button>
        </div>
        {settings.categoryRules.length === 0 ? (
          <EmptyState
            icon={Wand2}
            title="Henüz kural yok"
            hint="Örneğin “sinema, konser” geçen giderler Eğlence’ye gitsin. Elle girerken, ekstre aktarırken ve kategorisiz önerilerinde uygulanır."
          />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {settings.categoryRules.map((r) => {
              const cat = categoryById.get(r.categoryId);
              const missing = !cat || cat.type !== r.type;
              return (
                <li key={r.id} className="group flex items-center gap-3 px-5 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${r.type === "income" ? "bg-emerald-500" : "bg-rose-500"}`} title={r.type === "income" ? "Gelir" : "Gider"} />
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="flex min-w-0 flex-wrap gap-1">
                      {r.words.map((w) => (
                        <span key={w} className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs font-medium dark:bg-zinc-800">
                          {w}
                        </span>
                      ))}
                    </span>
                    <ArrowRight size={14} className="shrink-0 text-zinc-400" />
                    {missing ? (
                      <span className="text-sm italic text-rose-600 dark:text-rose-400">Kategori silinmiş, kural uygulanmıyor</span>
                    ) : (
                      <CategoryLabel category={cat} />
                    )}
                  </div>
                  <div className="flex gap-0.5 opacity-40 transition group-hover:opacity-100 focus-within:opacity-100">
                    <button className="icon-btn" title="Düzenle" aria-label="Kuralı düzenle" onClick={() => setRuleForm(r)}>
                      <Pencil size={15} />
                    </button>
                    <button className="icon-btn hover:!text-rose-600" title="Sil" aria-label="Kuralı sil" onClick={() => removeRule(r)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {ruleForm !== undefined && (
        <CategoryRuleForm rule={ruleForm ?? undefined} onClose={() => setRuleForm(undefined)} onSaved={(m) => toast(m)} />
      )}
    </>
  );
}
