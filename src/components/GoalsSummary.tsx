import { formatGoalAmount, STATUS_LABEL, STATUS_TONE } from "../lib/goals";
import { useData } from "../state/data";
import { useGoals } from "../state/goals";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

/** En çok 3 etkin, ulaşılmamış hedef; hedef yoksa gösterilmez */
export function GoalsSummary() {
  const { goals } = useData();
  // Etkin hedef yoksa rapor hiç istenmez
  if (goals.every((x) => x.archived)) return null;
  return <Summary />;
}

function Summary() {
  const { goals } = useData();
  const { formatMoney } = useSettings();
  const { setPage } = useUI();
  const g = useGoals();
  const byId = new Map((g.report?.goals ?? []).map((p) => [p.goalId, p]));
  const shown = goals.filter((x) => !x.archived && byId.get(x.id)?.status !== "reached").slice(0, 3);
  return (
    <section className="card col-span-2 px-5 py-4 lg:col-span-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Hedefler</h2>
        <button className="text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200" onClick={() => setPage("goals")}>
          Tümü
        </button>
      </div>
      {g.error && !g.report ? (
        <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">Hedefler hesaplanamadı.</p>
      ) : shown.length === 0 ? (
        <p className="mt-2 text-xs text-zinc-500">Etkin hedeflerin hepsine ulaşıldı.</p>
      ) : (
        <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          {shown.map((x) => {
            const p = byId.get(x.id);
            return (
              <li key={x.id} className="min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{x.name}</span>
                  {p && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[p.status]}`}>{STATUS_LABEL[p.status]}</span>}
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, p?.percent ?? 0))}%`, backgroundColor: x.color }} />
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  {p ? `%${Math.round(p.percent)} · ${formatGoalAmount(p.current, x.currency, formatMoney)}` : "…"}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
