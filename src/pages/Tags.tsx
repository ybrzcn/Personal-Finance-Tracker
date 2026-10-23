import { Plus, Tag as TagIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState, PageHeader } from "../components/common";
import { TagForm } from "../components/TagForm";
import { errorMessage } from "../lib/api";
import { formatDate, formatMonthShort, parseISODate } from "../lib/format";
import { BUDGET_LABEL, BUDGET_TONE } from "../lib/tags";
import type { Tag, TagStats } from "../lib/types";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useTagsReport } from "../state/tags";
import { useUI } from "../state/ui";

import { t, tc } from "../lib/i18n";
import { rich } from "../lib/rich";

export function TagsPage() {
  const { tags, transactions, updateTag, deleteTag } = useData();
  const { toast, confirm } = useUI();
  const r = useTagsReport();
  const [editing, setEditing] = useState<Tag | null | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const stats = useMemo(() => new Map((r.report?.tags ?? []).map((s) => [s.tagId, s])), [r.report]);
  // Sıra rapordan (Rust); raporda henüz olmayan etiket sonda, listedeki sırasıyla
  const rank = new Map((r.report?.tags ?? []).map((s, i) => [s.tagId, i]));
  const byReport = (xs: Tag[]) => [...xs].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  const active = byReport(tags.filter((tg) => !tg.archived));
  const archived = byReport(tags.filter((tg) => tg.archived));

  const run = async (f: () => Promise<unknown>, msg: string) => {
    try {
      await f();
      toast(msg);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const archive = (tg: Tag, v: boolean) => run(() => updateTag({ ...tg, archived: v }), v ? t("Etiket arşivlendi.") : t("Etiket geri alındı."));
  const remove = async (tg: Tag) => {
    const n = transactions.filter((x) => x.tagIds?.includes(tg.id)).length;
    const ok = await confirm({
      title: t("Etiketi sil"),
      message: (
        <p>
          {rich(n ? t("{name} silinecek; {n} işlemden kaldırılacak. İşlemler silinmez.", { n }) : t("{name} silinecek. İşlemler silinmez."), {
            name: <strong>{tg.name}</strong>,
          })}
        </p>
      ),
      confirmLabel: t("Sil"),
      danger: true,
    });
    if (ok) await run(() => deleteTag(tg.id), t("Etiket silindi."));
  };
  const add = (
    <button className="btn-primary" onClick={() => setEditing(null)}>
      <Plus size={16} /> {t("Yeni etiket")}
    </button>
  );

  return (
    <>
      <PageHeader title={t("Etiketler")} subtitle={t("Kategoriden bağımsız gruplar: harcama ve bütçe")} actions={add} />
      <div className="space-y-4">
        {r.error && (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
            <span>{r.report
                ? t("Güncellenemedi; gösterilen değerler eski olabilir. {error}", { error: r.error })
                : t("Etiket raporu alınamadı. {error}", { error: r.error })}</span>
            <button className="btn-secondary shrink-0" onClick={r.reload}>
              {t("Tekrar dene")}
            </button>
          </div>
        )}
        {active.length === 0 ? (
          <div className="card">
            <EmptyState icon={TagIcon} title={t("Henüz etiket yok")} hint={t("Tatil, iş masrafı, tadilat gibi işlemleri gruplamak için etiket oluştur.")} action={add} />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {active.map((tg) => (
              <TagCard
                key={tg.id}
                tag={tg}
                s={stats.get(tg.id)}
                open={open === tg.id}
                onToggle={() => setOpen(open === tg.id ? null : tg.id)}
                onEdit={() => setEditing(tg)}
                onArchive={() => archive(tg, true)}
                onDelete={() => remove(tg)}
              />
            ))}
          </div>
        )}
        {archived.length > 0 && (
          <div>
            <button className="text-sm font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200" onClick={() => setShowArchived((v) => !v)}>
              {t("Arşivlenenler ({n})", { n: archived.length })}
            </button>
            {showArchived && (
              <ul className="mt-2 divide-y divide-zinc-100 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-700">
                {archived.map((tg) => (
                  <li key={tg.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0 truncate">{tg.name}</span>
                    <span className="flex shrink-0 gap-2">
                      <button className="btn-secondary" onClick={() => archive(tg, false)}>
                        {tc("arşiv", "Geri al")}
                      </button>
                      <button className="btn-secondary" onClick={() => remove(tg)}>
                        {t("Sil")}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {editing !== undefined && <TagForm tag={editing ?? undefined} onClose={() => setEditing(undefined)} onSaved={(m) => toast(m)} />}
    </>
  );
}

function TagCard({ tag, s, open, onToggle, onEdit, onArchive, onDelete }: { tag: Tag; s?: TagStats; open: boolean; onToggle(): void; onEdit(): void; onArchive(): void; onDelete(): void }) {
  const { formatMoney } = useSettings();
  const { categoryById } = useData();
  const { showTagTransactions } = useUI();
  const spent = s?.spent ?? 0;
  const maxCat = Math.max(1, ...(s?.byCategory ?? []).map((c) => Math.abs(c.amount)));
  const maxMonth = Math.max(1, ...(s?.monthly ?? []).map((m) => Math.abs(m.amount)));
  return (
    <article className="card cursor-pointer px-5 py-4" onClick={onToggle}>
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{tag.name}</h2>
        {s?.budgetStatus && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${BUDGET_TONE[s.budgetStatus]}`}>{BUDGET_LABEL[s.budgetStatus]}</span>}
      </div>
      <div className="mt-2 text-lg font-semibold tabular-nums">{spent < 0 ? t("Net gelir {amount}", { amount: formatMoney(-spent) }) : formatMoney(spent)}</div>
      <p className="text-xs text-zinc-500">
        {t("{n} işlem", { n: s?.count ?? 0 })}
        {s?.firstDate && s.lastDate ? ` · ${formatDate(s.firstDate)} – ${formatDate(s.lastDate)}` : ""}
      </p>
      {s?.budget != null && (
        <>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, s.percent ?? 0)}%`, backgroundColor: s.budgetStatus === "over" ? "var(--expense)" : tag.color }} />
          </div>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            {formatMoney(Math.max(0, spent))} / {formatMoney(s.budget)} · {t("%{v}", { v: Math.round(s.percent ?? 0) })}
          </p>
        </>
      )}
      {open && (
        <div className="mt-4 space-y-4" onClick={(e) => e.stopPropagation()}>
          {s && s.byCategory.length > 0 && (
            <ul className="space-y-1.5">
              {s.byCategory.map((c) => {
                const cat = c.categoryId ? categoryById.get(c.categoryId) : undefined;
                return (
                  <li key={c.categoryId ?? "none"} className="text-sm">
                    <div className="flex justify-between gap-3">
                      <span className="truncate">{cat?.name ?? t("Kategorisiz")}</span>
                      <span className="tabular-nums">{formatMoney(c.amount)}</span>
                    </div>
                    <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                      <div className="h-full rounded-full" style={{ width: `${(Math.abs(c.amount) / maxCat) * 100}%`, backgroundColor: cat?.color ?? "#94a3b8" }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {s && s.monthly.length > 1 && (
            <div className="flex h-24 items-end gap-1" aria-label={t("Aylık seyir")}>
              {s.monthly.map((m) => (
                <div key={m.month} className="flex flex-1 flex-col items-center gap-1" title={`${m.month}: ${formatMoney(m.amount)}`}>
                  <div className="w-full rounded-t" style={{ height: `${(Math.abs(m.amount) / maxMonth) * 72}px`, backgroundColor: tag.color, opacity: m.amount < 0 ? 0.4 : 1 }} />
                  <span className="text-[10px] text-zinc-500">{formatMonthShort(parseISODate(`${m.month}-01`))}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" onClick={() => showTagTransactions(tag.id)}>
              {t("İşlemleri gör")}
            </button>
            <button className="btn-secondary" onClick={onEdit}>
              {t("Düzenle")}
            </button>
            <button className="btn-secondary" onClick={onArchive}>
              {t("Arşivle")}
            </button>
            <button className="btn-secondary text-rose-600 dark:text-rose-400" onClick={onDelete}>
              {t("Sil")}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
