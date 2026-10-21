import { Plus, Tag as TagIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState, PageHeader } from "../components/common";
import { TagForm } from "../components/TagForm";
import { errorMessage } from "../lib/api";
import { formatDate } from "../lib/format";
import { BUDGET_LABEL, BUDGET_TONE } from "../lib/tags";
import type { Tag, TagStats } from "../lib/types";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useTagsReport } from "../state/tags";
import { useUI } from "../state/ui";

const MONTHS = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];

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
  const active = byReport(tags.filter((t) => !t.archived));
  const archived = byReport(tags.filter((t) => t.archived));

  const run = async (f: () => Promise<unknown>, msg: string) => {
    try {
      await f();
      toast(msg);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const archive = (t: Tag, v: boolean) => run(() => updateTag({ ...t, archived: v }), v ? "Etiket arşivlendi." : "Etiket geri alındı.");
  const remove = async (t: Tag) => {
    const n = transactions.filter((x) => x.tagIds?.includes(t.id)).length;
    const ok = await confirm({
      title: "Etiketi sil",
      message: (
        <p>
          <strong>{t.name}</strong> silinecek{n ? `; ${n} işlemden kaldırılacak` : ""}. İşlemler silinmez.
        </p>
      ),
      confirmLabel: "Sil",
      danger: true,
    });
    if (ok) await run(() => deleteTag(t.id), "Etiket silindi.");
  };
  const add = (
    <button className="btn-primary" onClick={() => setEditing(null)}>
      <Plus size={16} /> Yeni etiket
    </button>
  );

  return (
    <>
      <PageHeader title="Etiketler" subtitle="Kategoriden bağımsız gruplar: harcama ve bütçe" actions={add} />
      <div className="space-y-4">
        {r.error && (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
            <span>{r.report ? `Güncellenemedi; gösterilen değerler eski olabilir. ${r.error}` : `Etiket raporu alınamadı. ${r.error}`}</span>
            <button className="btn-secondary shrink-0" onClick={r.reload}>
              Tekrar dene
            </button>
          </div>
        )}
        {active.length === 0 ? (
          <div className="card">
            <EmptyState icon={TagIcon} title="Henüz etiket yok" hint="Tatil, iş masrafı, tadilat gibi işlemleri gruplamak için etiket oluştur." action={add} />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {active.map((t) => (
              <TagCard
                key={t.id}
                tag={t}
                s={stats.get(t.id)}
                open={open === t.id}
                onToggle={() => setOpen(open === t.id ? null : t.id)}
                onEdit={() => setEditing(t)}
                onArchive={() => archive(t, true)}
                onDelete={() => remove(t)}
              />
            ))}
          </div>
        )}
        {archived.length > 0 && (
          <div>
            <button className="text-sm font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200" onClick={() => setShowArchived((v) => !v)}>
              Arşivlenenler ({archived.length})
            </button>
            {showArchived && (
              <ul className="mt-2 divide-y divide-zinc-100 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-700">
                {archived.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0 truncate">{t.name}</span>
                    <span className="flex shrink-0 gap-2">
                      <button className="btn-secondary" onClick={() => archive(t, false)}>
                        Geri al
                      </button>
                      <button className="btn-secondary" onClick={() => remove(t)}>
                        Sil
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
      <div className="mt-2 text-lg font-semibold tabular-nums">{spent < 0 ? `Net gelir ${formatMoney(-spent)}` : formatMoney(spent)}</div>
      <p className="text-xs text-zinc-500">
        {s?.count ?? 0} işlem{s?.firstDate && s.lastDate ? ` · ${formatDate(s.firstDate)} – ${formatDate(s.lastDate)}` : ""}
      </p>
      {s?.budget != null && (
        <>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, s.percent ?? 0)}%`, backgroundColor: s.budgetStatus === "over" ? "var(--expense)" : tag.color }} />
          </div>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            {formatMoney(Math.max(0, spent))} / {formatMoney(s.budget)} · %{Math.round(s.percent ?? 0)}
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
                      <span className="truncate">{cat?.name ?? "Kategorisiz"}</span>
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
            <div className="flex h-24 items-end gap-1" aria-label="Aylık seyir">
              {s.monthly.map((m) => (
                <div key={m.month} className="flex flex-1 flex-col items-center gap-1" title={`${m.month}: ${formatMoney(m.amount)}`}>
                  <div className="w-full rounded-t" style={{ height: `${(Math.abs(m.amount) / maxMonth) * 72}px`, backgroundColor: tag.color, opacity: m.amount < 0 ? 0.4 : 1 }} />
                  <span className="text-[10px] text-zinc-500">{MONTHS[Number(m.month.slice(5, 7)) - 1]}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" onClick={() => showTagTransactions(tag.id)}>
              İşlemleri gör
            </button>
            <button className="btn-secondary" onClick={onEdit}>
              Düzenle
            </button>
            <button className="btn-secondary" onClick={onArchive}>
              Arşivle
            </button>
            <button className="btn-secondary text-rose-600 dark:text-rose-400" onClick={onDelete}>
              Sil
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
