import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { useState } from "react";
import type { CategorySlice, MerchantRow } from "../lib/stats";
import { useSettings } from "../state/settings";

type Tab = "category" | "account" | "merchant";

const TABS: { value: Tab; label: string }[] = [
  { value: "category", label: "Kategori" },
  { value: "account", label: "Hesap" },
  { value: "merchant", label: "Harcama yeri" },
];

interface Row {
  id: string;
  name: string;
  color: string;
  value: number;
  /** Önceki dönemdeki tutar (karşılaştırma varsa) */
  before?: number;
  /** Ek bilgi (ör. "3 işlem") */
  meta?: string;
}

/** Önceki döneme göre değişim rozeti: artış kırmızı, azalış yeşil. */
function Delta({ now, before }: { now: number; before: number }) {
  const diff = now - before;
  const up = diff > 0;
  const pct = before > 0 ? Math.round((Math.abs(diff) / before) * 100) : null;
  // Kuruş farkı ya da %1'in altı değişim sayılmaz
  if (Math.abs(diff) < 0.005 || pct === 0) return <span className="w-14 text-right text-xs text-zinc-400">—</span>;
  return (
    <span
      className={`inline-flex w-14 items-center justify-end gap-0.5 text-xs font-medium tabular-nums ${
        up ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"
      }`}
      title={`Önceki dönem: ${before.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`}
    >
      {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
      {pct === null ? "yeni" : `%${pct}`}
    </span>
  );
}

/**
 * Dönemin harcamalarını tek kartta gösterir: kategori, hesap veya harcama yerine göre sıralı liste.
 * Her satırda pay çubuğu, tutar ve (karşılaştırma varsa) önceki döneme göre değişim.
 */
export function SpendingBreakdown({
  categories,
  previous,
  accounts,
  merchants,
  periodLabel,
}: {
  categories: CategorySlice[];
  previous: CategorySlice[] | null;
  accounts: CategorySlice[];
  merchants: MerchantRow[];
  periodLabel: string;
}) {
  const { formatMoney } = useSettings();
  const [tab, setTab] = useState<Tab>("category");
  const [expanded, setExpanded] = useState(false);

  // Önceki dönemde hiç harcama yoksa (ör. takip başlamadan önce) karşılaştırma gösterilmez: her satır "yeni" olurdu
  const hasPrevious = !!previous && previous.some((p) => p.value > 0);
  const prevBy = new Map((hasPrevious ? previous! : []).map((p) => [p.id, p.value]));
  const total = categories.reduce((s, c) => s + c.value, 0);
  const prevTotal = hasPrevious ? previous!.reduce((s, c) => s + c.value, 0) : null;

  const rows: Row[] =
    tab === "category"
      ? // Yalnız bu dönem harcanan kategoriler; önceki dönemle fark satırda ve üstteki toplamda
        categories.map((c) => ({ ...c, before: hasPrevious ? (prevBy.get(c.id) ?? 0) : undefined }))
      : tab === "account"
        ? accounts
        : merchants.map((m) => ({ id: m.key, name: m.name, color: "", value: m.total, meta: `${m.count} işlem` }));
  const max = Math.max(...rows.map((r) => Math.max(r.value, r.before ?? 0)), 0);
  const visible = expanded ? rows : rows.slice(0, 6);

  return (
    <section className="card flex w-full flex-col p-5" aria-labelledby="spend-title">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <h2 id="spend-title" className="text-sm font-semibold">
            Harcama dağılımı · {periodLabel}
          </h2>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span className="text-2xl font-semibold tabular-nums">{formatMoney(total)}</span>
            {prevTotal !== null && prevTotal > 0 && (
              <span className="flex items-center gap-1 text-xs text-zinc-500">
                önceki dönem {formatMoney(prevTotal)} <Delta now={total} before={prevTotal} />
              </span>
            )}
          </div>
        </div>
        <div className="segmented" role="group" aria-label="Gruplama">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              aria-pressed={tab === t.value}
              onClick={() => {
                setTab(t.value);
                setExpanded(false);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-500">Bu dönemde gider yok.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {visible.map((r) => {
            const share = total > 0 ? Math.round((r.value / total) * 100) : 0;
            const barColor = r.color || "rgb(99 102 241)";
            return (
              <li key={r.id}>
                <div className="flex items-baseline gap-2 text-sm">
                  {r.color && <span className="h-2.5 w-2.5 shrink-0 translate-y-px rounded-full" style={{ backgroundColor: r.color }} />}
                  <span className="min-w-0 flex-1 truncate font-medium" title={r.name}>
                    {r.name}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-zinc-500">{r.meta ?? `%${share}`}</span>
                  <span className="w-28 shrink-0 text-right font-semibold tabular-nums">{formatMoney(r.value)}</span>
                  {r.before !== undefined && <Delta now={r.value} before={r.before} />}
                </div>
                {/* Pay çubuğu: dolu kısım bu dönem, ince çizgi önceki dönem */}
                <div className="relative mt-1 h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className="h-full rounded-full" style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%`, backgroundColor: barColor }} />
                  {r.before !== undefined && r.before > 0 && max > 0 && (
                    <div
                      className="absolute top-0 h-full w-0.5 bg-zinc-400 dark:bg-zinc-500"
                      style={{ left: `calc(${(r.before / max) * 100}% - 1px)` }}
                      title="Önceki dönem"
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > 6 && (
        <button className="btn-ghost -ml-2 mt-auto self-start px-2 py-1 pt-3 text-xs" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Daha az göster" : `Tümünü göster (${rows.length})`}
        </button>
      )}
    </section>
  );
}
