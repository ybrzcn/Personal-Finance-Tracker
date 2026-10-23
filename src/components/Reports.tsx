import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import type { CategorySlice, MerchantRow } from "../lib/stats";
import { locale, t } from "../lib/i18n";
import { useSettings } from "../state/settings";

type Tab = "category" | "account" | "merchant";

/** Kapalıyken gösterilen satır sayısı */
const LIMIT = 9;

const TABS: { value: Tab; label: string }[] = [
  { value: "category", label: t("Kategori") },
  { value: "account", label: t("Hesap") },
  { value: "merchant", label: t("Harcama yeri") },
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

/** Önceki döneme göre değişim etiketi: artış kırmızı, azalış yeşil. */
function Delta({ now, before }: { now: number; before: number }) {
  const diff = now - before;
  const up = diff > 0;
  const pct = before > 0 ? Math.round((Math.abs(diff) / before) * 100) : null;
  const base = "inline-flex min-w-[3.25rem] items-center justify-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums";
  // Kuruş farkı ya da %1'in altı değişim sayılmaz
  if (Math.abs(diff) < 0.005 || pct === 0)
    return <span className={`${base} bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500`}>—</span>;
  return (
    <span
      className={`${base} ${
        up ? "bg-rose-50 text-rose-700 dark:bg-rose-900 dark:text-rose-300" : "bg-emerald-50 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"
      }`}
      title={t("Önceki dönem: {amount}", { amount: `${before.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺` })}
    >
      {up ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
      {pct === null ? t("yeni") : t("%{v}", { v: pct })}
    </span>
  );
}

/**
 * Dönemin harcamalarını tek kartta gösterir: kategori, hesap veya harcama yerine göre sıralı liste.
 * Tablo: pay çubuğu, bu dönem, (karşılaştırma varsa) önceki dönem tutarı ve değişim.
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
        : merchants.map((m) => ({ id: m.key, name: m.name, color: "", value: m.total, meta: t("{n} işlem", { n: m.count }) }));
  // Önceki dönem ve fark sütunları yalnız kategori sekmesinde (karşılaştırma varsa)
  const showPrev = tab === "category" && hasPrevious;
  const visible = expanded ? rows : rows.slice(0, LIMIT);

  return (
    <section className="card flex w-full flex-col px-5 py-4" aria-labelledby="spend-title">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id="spend-title" className="min-w-0 flex-1 text-[15px] font-semibold">
          {t("Harcama dağılımı")} · {periodLabel}
        </h2>
        <div className="segmented" role="group" aria-label={t("Gruplama")}>
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
      <div className="mb-2 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500">
        <span className="text-xl font-bold tabular-nums text-zinc-900 dark:text-zinc-50">{formatMoney(total)}</span>
        {prevTotal !== null && prevTotal > 0 && (
          <>
            · {t("önceki dönem {amount}", { amount: formatMoney(prevTotal) })} <Delta now={total} before={prevTotal} />
          </>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-500">{t("Bu dönemde gider yok.")}</p>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full border-collapse text-[13px] tabular-nums">
            <thead>
              <tr className="border-b border-zinc-200 text-right text-[11px] text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                <th className="py-1.5 text-left font-medium">{TABS.find((t) => t.value === tab)!.label}</th>
                <th className="hidden w-32 font-medium sm:table-cell">{tab === "merchant" ? t("İşlem") : t("Pay")}</th>
                <th className="font-medium">{t("Bu dönem")}</th>
                {showPrev && <th className="hidden font-medium sm:table-cell">{t("Önceki")}</th>}
                {showPrev && <th className="w-16 font-medium">{t("Fark")}</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const share = total > 0 ? Math.round((r.value / total) * 100) : 0;
                const barColor = r.color || "rgb(79 122 163)";
                return (
                  <tr key={r.id} className="h-[34px] border-b border-zinc-100 last:border-0 dark:border-zinc-800/70">
                    <td className="pr-2 font-medium">
                      <span className="flex min-w-[7rem] items-center gap-2">
                        {r.color && <span className="h-[9px] w-[9px] shrink-0 rounded-[3px]" style={{ backgroundColor: r.color }} />}
                        <span className="truncate sm:whitespace-nowrap" title={r.name}>
                          {r.name}
                        </span>
                      </span>
                    </td>
                    <td className="hidden text-right sm:table-cell">
                      {r.meta ? (
                        <span className="text-zinc-500">{r.meta}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="inline-block h-[5px] w-16 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                            <span className="block h-full rounded-full" style={{ width: `${Math.max(share, 1)}%`, backgroundColor: barColor }} />
                          </span>
                          <span className="w-8 text-zinc-500">{t("%{v}", { v: share })}</span>
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap pl-2 text-right font-semibold">{formatMoney(r.value)}</td>
                    {showPrev && (
                      <td className="hidden whitespace-nowrap pl-2 text-right text-zinc-400 sm:table-cell dark:text-zinc-500">
                        {r.before !== undefined ? formatMoney(r.before) : ""}
                      </td>
                    )}
                    {showPrev && <td className="pl-2 text-right">{r.before !== undefined && <Delta now={r.value} before={r.before} />}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > LIMIT && (
        <button className="btn-ghost -ml-2 mt-auto self-start px-2 py-1 text-xs" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t("Daha az göster") : t("Tümünü göster ({n})", { n: rows.length })}
        </button>
      )}
    </section>
  );
}
