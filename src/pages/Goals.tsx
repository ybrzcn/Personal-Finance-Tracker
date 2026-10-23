import { Plus, Target } from "lucide-react";
import { useMemo, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState, PageHeader } from "../components/common";
import { GoalForm } from "../components/GoalForm";
import { errorMessage } from "../lib/api";
import { formatDate, formatMonthYearShort } from "../lib/format";
import { locale, t, tc } from "../lib/i18n";
import { formatGoalAmount, GOAL_ACCOUNT_KINDS, monthYear, STATUS_LABEL, STATUS_TONE } from "../lib/goals";
import type { Goal, GoalProgress } from "../lib/types";
import { useData } from "../state/data";
import { useGoals } from "../state/goals";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

const short = formatMonthYearShort;
// Grafik ekseni gerçek zaman ölçeğinde (hedef tarihi uzaksa gereken hız çizgisi de uzun çizilir)
const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function GoalsPage() {
  const { goals, accounts, updateGoal, deleteGoal } = useData();
  const { toast, confirm } = useUI();
  const g = useGoals();
  const [editing, setEditing] = useState<Goal | null | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const progress = useMemo(() => new Map((g.report?.goals ?? []).map((p) => [p.goalId, p])), [g.report]);
  const active = goals.filter((x) => !x.archived);
  const archived = goals.filter((x) => x.archived);
  const hasAssets = accounts.some((a) => GOAL_ACCOUNT_KINDS.has(a.kind) && !a.archived);

  const run = async (f: () => Promise<unknown>, msg: string) => {
    try {
      await f();
      toast(msg);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const archive = (x: Goal, v: boolean) => run(() => updateGoal({ ...x, archived: v }), v ? t("Hedef arşivlendi.") : t("Hedef geri alındı."));
  const remove = async (x: Goal) => {
    const [pre, post] = t("{name} hedefi silinecek. Bağlı hesaplar ve işlemler silinmez.").split("{name}");
    const ok = await confirm({
      title: t("Hedefi sil"),
      message: (
        <p>
          {pre}
          <strong>{x.name}</strong>
          {post}
        </p>
      ),
      confirmLabel: t("Sil"),
      danger: true,
    });
    if (ok) await run(() => deleteGoal(x.id), t("Hedef silindi."));
  };

  const add = (
    <button className="btn-primary" onClick={() => setEditing(null)}>
      <Plus size={16} /> {t("Yeni hedef")}
    </button>
  );

  return (
    <>
      <PageHeader title={t("Hedefler")} subtitle={t("Birikim hedefleri ve ilerleme")} actions={add} />
      <div className="space-y-4">
        {g.error && (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
            <span>
              {g.report
                ? t("Güncellenemedi; gösterilen değerler eski olabilir. {error}", { error: g.error })
                : t("Hedefler hesaplanamadı. {error}", { error: g.error })}
            </span>
            <button className="btn-secondary shrink-0" onClick={g.reload}>
              {t("Tekrar dene")}
            </button>
          </div>
        )}
        {active.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={Target}
              title={t("Henüz hedef yok")}
              hint={
                hasAssets
                  ? t("Bir hedef tutarı ve isteğe bağlı tarih koy, biriktirdiğin hesapları bağla.")
                  : t("Önce bir vadesiz, nakit, döviz/altın ya da fon hesabı ekle.")
              }
              action={hasAssets ? add : undefined}
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {active.map((x) => (
              <GoalCard
                key={x.id}
                goal={x}
                p={progress.get(x.id)}
                loading={g.loading && !g.report}
                open={open === x.id}
                onToggle={() => setOpen(open === x.id ? null : x.id)}
                onEdit={() => setEditing(x)}
                onArchive={() => archive(x, true)}
                onDelete={() => remove(x)}
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
                {archived.map((x) => (
                  <li key={x.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0 truncate">{x.name}</span>
                    <span className="flex shrink-0 gap-2">
                      <button className="btn-secondary" onClick={() => archive(x, false)}>
                        {tc("arşiv", "Geri al")}
                      </button>
                      <button className="btn-secondary" onClick={() => remove(x)}>
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
      {editing !== undefined && <GoalForm goal={editing ?? undefined} onClose={() => setEditing(undefined)} onSaved={(m) => toast(m)} />}
    </>
  );
}

interface CardProps {
  goal: Goal;
  p?: GoalProgress;
  loading: boolean;
  open: boolean;
  onToggle(): void;
  onEdit(): void;
  onArchive(): void;
  onDelete(): void;
}

function GoalCard({ goal, p, loading, open, onToggle, onEdit, onArchive, onDelete }: CardProps) {
  const { formatMoney } = useSettings();
  const { accountById } = useData();
  const fmt = (v: number) => formatGoalAmount(v, goal.currency, formatMoney);
  const pct = p ? Math.min(100, Math.max(0, p.percent)) : 0;
  const pace: string[] = [];
  if (p) {
    if (p.dateOverdue) pace.push(t("Tarih geçti"));
    else if (p.requiredPerMonth !== null) pace.push(t("Ayda {amount} gerekiyor", { amount: fmt(p.requiredPerMonth) }));
    if (p.pacePerMonth !== null) pace.push(t("Son 3 ayda ayda {amount}", { amount: fmt(p.pacePerMonth) }));
    else if (p.status === "unknown" && goal.accountIds.length) pace.push(t("Tahmin için en az 1 aylık geçmiş gerekir"));
    if (p.projectedDate) pace.push(t("Bu hızla {date}", { date: monthYear(p.projectedDate) }));
    else if (p.status === "behind" && p.pacePerMonth !== null && p.pacePerMonth <= 0) pace.push(t("Bu hızla ulaşılamıyor"));
  }
  return (
    <article className="card cursor-pointer px-5 py-4" onClick={onToggle}>
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: goal.color }} />
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{goal.name}</h2>
        {p && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[p.status]}`}>{STATUS_LABEL[p.status]}</span>}
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: goal.color }} />
      </div>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        {p ? (
          <span>
            <strong>{fmt(p.current)}</strong> / {fmt(p.target)} · {t("%{v}", { v: Math.round(p.percent) })}
          </span>
        ) : (
          <span className="text-zinc-500">{loading ? t("Hesaplanıyor…") : fmt(goal.target)}</span>
        )}
        {goal.targetDate && <span className="text-xs text-zinc-500">{t("Hedef tarihi {date}", { date: formatDate(goal.targetDate) })}</span>}
      </div>
      {pace.length > 0 && <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{pace.join(" · ")}</p>}
      <p className="mt-1 text-xs text-zinc-500">
        {goal.accountIds.length === 0
          ? t("Bağlı hesap yok")
          : goal.accountIds.map((id) => `${accountById.get(id)?.name ?? "?"}${accountById.get(id)?.archived ? ` ${t("(arşivli)")}` : ""}`).join(", ")}
        {p && p.unvaluedCount > 0 && ` · ${t("{n} hesap değerlenemedi", { n: p.unvaluedCount })}`}
      </p>
      {p?.status === "reached" && !open && (
        <button className="btn-secondary mt-3" onClick={(e) => (e.stopPropagation(), onArchive())}>
          {t("Arşivle")}
        </button>
      )}
      {open && (
        <div className="mt-4" onClick={(e) => e.stopPropagation()}>
          {p && p.series.length > 1 ? <GoalChart goal={goal} p={p} /> : <p className="text-xs text-zinc-500">{t("Geçmiş biriktikçe eğri oluşur.")}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
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

function GoalChart({ goal, p }: { goal: Goal; p: GoalProgress }) {
  const { formatMoney, formatCompact } = useSettings();
  const fmt = (v: number) => formatGoalAmount(v, goal.currency, formatMoney);
  const axis = (v: number) => (goal.currency === "TRY" ? formatCompact(v) : new Intl.NumberFormat(locale, { notation: "compact" }).format(v));
  // Gereken hız çizgisi: bugünden hedef tarihine
  const data: { t: number; value?: number; need?: number }[] = p.series.map((s) => ({ t: toTime(s.date), value: s.value }));
  if (goal.targetDate && !p.dateOverdue && p.status !== "reached") {
    data[data.length - 1].need = p.current;
    data.push({ t: toTime(goal.targetDate), need: p.target });
  }
  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid, #e4e4e7)" vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => short(toIso(t))} tick={{ fontSize: 11 }} minTickGap={24} />
          <YAxis tickFormatter={axis} tick={{ fontSize: 11 }} width={72} />
          <Tooltip formatter={(v: number, n: string) => [fmt(v), n === "need" ? t("Gereken") : t("Birikim")]} labelFormatter={(l: number) => formatDate(toIso(l))} />
          <ReferenceLine y={p.target} stroke={goal.color} strokeDasharray="4 4" />
          <Area type="monotone" dataKey="value" stroke={goal.color} fill={goal.color} fillOpacity={0.15} strokeWidth={2} connectNulls={false} isAnimationActive={false} />
          <Line type="linear" dataKey="need" stroke="var(--chart-fg, #71717a)" strokeDasharray="5 5" dot={false} connectNulls isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
