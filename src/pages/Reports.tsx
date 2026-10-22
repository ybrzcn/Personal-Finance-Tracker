import { ChartColumn } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Rectangle, ResponsiveContainer, Sankey, Tooltip, XAxis, YAxis } from "recharts";
import { CategoryDot, EmptyState, PageHeader, Segmented, SummaryTile, type TileTone } from "../components/common";
import { api, errorMessage } from "../lib/api";
import { formatDate } from "../lib/format";
import type { ReportCompare, ReportGroup, ReportPreset, ReportRow, ReportsQuery, ReportsReport } from "../lib/types";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";

const PRESETS: { value: ReportPreset; label: string }[] = [
  { value: "thisMonth", label: "Bu ay" },
  { value: "lastMonth", label: "Geçen ay" },
  { value: "thisYear", label: "Bu yıl" },
  { value: "lastYear", label: "Geçen yıl" },
  { value: "last12", label: "Son 12 ay" },
  { value: "custom", label: "Özel" },
];
const KINDS: { value: ReportsQuery["kind"]; label: string }[] = [
  { value: "expense", label: "Gider" },
  { value: "income", label: "Gelir" },
];
const GROUPS: { value: ReportGroup; label: string }[] = [
  { value: "category", label: "Kategori" },
  { value: "account", label: "Hesap" },
  { value: "tag", label: "Etiket" },
];
const COMPARES: { value: ReportCompare; label: string }[] = [
  { value: "previous", label: "Önceki dönem" },
  { value: "lastYear", label: "Geçen yıl" },
  { value: "none", label: "Karşılaştırma yok" },
];
const MONTHS = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const GREY = "#94a3b8";
/** Baz puan → "+%12,5" / "−%12,5" (`sign`: artıda da işaret) */
const pct = (bp: number | null, sign = true) =>
  bp === null ? "—" : `${bp < 0 ? "−" : sign && bp > 0 ? "+" : ""}%${(Math.abs(bp) / 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 })}`;

/** Akış diyagramı düğümü: dikdörtgen ve sağında ad ile tutar (sağ kenar payı son sütunun etiketine yer bırakır) */
function FlowNode(props: { x: number; y: number; width: number; height: number; payload: { name: string; color: string; value: number }; money: (v: number) => string }) {
  const { x, y, width, height, payload, money } = props;
  return (
    <g>
      <Rectangle x={x} y={y} width={width} height={height} fill={payload.color} fillOpacity={0.9} />
      <text x={x + width + 6} y={y + height / 2} dominantBaseline="middle" fontSize={11} fill="currentColor">
        {payload.name} · {money(payload.value)}
      </text>
    </g>
  );
}

export function ReportsPage() {
  const { categories, categoryById, accountById, tagById, transactions } = useData();
  const { formatMoney, formatCompact } = useSettings();
  const [q, setQ] = useState<ReportsQuery>({ preset: "thisMonth", from: null, to: null, compare: "previous", kind: "expense", group: "category" });
  const [report, setReport] = useState<ReportsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const set = (patch: Partial<ReportsQuery>) => setQ((x) => ({ ...x, ...patch }));

  useEffect(() => {
    const n = ++seq.current;
    // Özel aralıkta iki tarih de girilene kadar istenmez; eski dönemin raporu ekranda kalmasın
    if (q.preset === "custom" && (!q.from || !q.to)) {
      setReport(null);
      setError(null);
      return;
    }
    api
      .reportsReport(q)
      .then((r) => {
        if (n !== seq.current) return;
        setReport(r);
        setError(null);
      })
      .catch((e) => {
        if (n !== seq.current) return;
        setReport(null);
        setError(errorMessage(e));
      });
  }, [q, transactions, categories]);

  const money = (c: number | null | undefined) => (c == null ? "—" : formatMoney(c / 100));
  const nameOf = (key: string | null): { name: string; color: string } => {
    if (key === "other") return { name: "Diğer", color: GREY };
    if (key === null) return { name: q.group === "tag" ? "Etiketsiz" : "Kategorisiz", color: GREY };
    if (q.group === "account") {
      const a = accountById.get(key);
      return { name: a?.name ?? "Silinmiş hesap", color: a?.color ?? GREY };
    }
    if (q.group === "tag") {
      const t = tagById.get(key);
      return { name: t?.name ?? "Silinmiş etiket", color: t?.color ?? GREY };
    }
    const c = categoryById.get(key);
    return { name: c?.name ?? "Silinmiş kategori", color: c?.color ?? GREY };
  };
  const catOf = (key: string | null) => {
    if (key === "other") return { name: "Diğer", color: GREY };
    if (key === null) return { name: "Kategorisiz", color: GREY };
    const c = categoryById.get(key);
    return { name: c?.name ?? "Silinmiş kategori", color: c?.color ?? GREY };
  };

  const t = report?.totals;
  const c = report?.compareTotals ?? null;
  const d = report?.totalsDelta ?? null;
  const delta = (v: number | undefined) =>
    v === undefined ? null : v === 0 ? "karşılaştırmayla aynı" : `${v > 0 ? "+" : "−"}${formatMoney(Math.abs(v) / 100)} karşılaştırmaya göre`;
  const tiles: { label: string; value: string; tone: TileTone; hint: string | null }[] = [
    { label: "Gelir", value: money(t?.incomeCents), tone: "income", hint: delta(d?.incomeCents) },
    { label: "Gider", value: money(t?.expenseCents), tone: "expense", hint: delta(d?.expenseCents) },
    { label: "Net", value: money(t?.netCents), tone: !t ? "plain" : t.netCents < 0 ? "expense" : "income", hint: delta(d?.netCents) },
    {
      label: "Birikim oranı",
      value: t ? pct(t.savingsRateBp, false) : "—",
      tone: "info",
      hint: c ? `karşılaştırma ${pct(c.savingsRateBp, false)}` : null,
    },
  ];

  const sankey = useMemo(() => {
    if (!report) return null;
    const f = report.flow;
    if (f.empty) return null;
    const nodes: { name: string; color: string }[] = [];
    const links: { source: number; target: number; value: number }[] = [];
    for (const x of f.incomes) nodes.push(catOf(x.key));
    if (f.deficitCents > 0) nodes.push({ name: "Açık (birikimden/borçla)", color: "#f43f5e" });
    const hub = nodes.length;
    // Açık varsa orta düğüm gelir değil, harcanan toplam
    nodes.push({ name: f.deficitCents > 0 ? "Kullanılabilir" : "Gelir", color: "#10b981" });
    f.incomes.forEach((x, i) => links.push({ source: i, target: hub, value: x.cents / 100 }));
    if (f.deficitCents > 0) links.push({ source: hub - 1, target: hub, value: f.deficitCents / 100 });
    for (const x of f.expenses) {
      links.push({ source: hub, target: nodes.length, value: x.cents / 100 });
      nodes.push(catOf(x.key));
    }
    if (f.savedCents > 0) {
      links.push({ source: hub, target: nodes.length, value: f.savedCents / 100 });
      nodes.push({ name: "Birikim", color: "#6366f1" });
    }
    return { nodes, links };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, categoryById]);

  const rows = report?.rows ?? [];
  const kindLabel = q.kind === "expense" ? "Gider" : "Gelir";
  const compareLabel = report?.compareRange ? `${formatDate(report.compareRange.from)} – ${formatDate(report.compareRange.to)}` : null;

  return (
    <>
      <PageHeader
        title="Raporlar"
        subtitle={report ? `${formatDate(report.range.from)} – ${formatDate(report.range.to)}${compareLabel ? ` · karşılaştırma ${compareLabel}` : ""}` : "Dönem, kırılım ve karşılaştırma"}
      />
      <section className="card mb-4 space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {/* Dar ekranda düğmeler bölünmez; şerit yatay kayar */}
          <div className="max-w-full overflow-x-auto [&_button]:whitespace-nowrap">
            <Segmented value={q.preset} options={PRESETS} onChange={(preset) => set({ preset })} />
          </div>
          {q.preset === "custom" && (
            <div className="flex items-center gap-2">
              <input type="date" aria-label="Başlangıç" className="input w-40" value={q.from ?? ""} onChange={(e) => set({ from: e.target.value || null })} />
              <span className="text-zinc-400">–</span>
              <input type="date" aria-label="Bitiş" className="input w-40" value={q.to ?? ""} onChange={(e) => set({ to: e.target.value || null })} />
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={q.kind} options={KINDS} onChange={(kind) => set({ kind })} />
          <Segmented value={q.group} options={GROUPS} onChange={(group) => set({ group })} />
          <div className="max-w-full overflow-x-auto [&_button]:whitespace-nowrap">
            <Segmented value={q.compare} options={COMPARES} onChange={(compare) => set({ compare })} />
          </div>
        </div>
      </section>

      {error && <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">{error}</p>}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((x) => (
          <SummaryTile key={x.label} label={x.label} value={x.value} tone={x.tone} hint={x.hint} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <section className="card overflow-x-auto xl:col-span-3">
          <h2 className="border-b border-zinc-200 px-5 py-3 text-sm font-semibold dark:border-zinc-800">
            {kindLabel} · {GROUPS.find((g) => g.value === q.group)!.label.toLocaleLowerCase("tr")} kırılımı
          </h2>
          {rows.length === 0 ? (
            <EmptyState icon={ChartColumn} title={`Bu dönemde ${kindLabel.toLocaleLowerCase("tr")} yok`} />
          ) : (
            <table className="w-full min-w-[520px] text-sm tabular-nums">
              <thead className="text-xs text-zinc-500">
                <tr>
                  <th className="px-5 py-2 text-left font-medium">{GROUPS.find((g) => g.value === q.group)!.label}</th>
                  <th className="px-2 py-2 text-right font-medium">Tutar</th>
                  <th className="px-2 py-2 text-right font-medium">Pay</th>
                  {report?.compareRange && <th className="px-2 py-2 text-right font-medium">Önceki</th>}
                  {report?.compareRange && <th className="px-5 py-2 text-right font-medium">Değişim</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.map((r: ReportRow) => {
                  const n = nameOf(r.key);
                  // Giderde artış kötü (kırmızı), gelirde iyi
                  const up = (r.deltaCents ?? 0) > 0;
                  const bad = q.kind === "expense" ? up : !up && (r.deltaCents ?? 0) !== 0;
                  return (
                    <tr key={r.key ?? "none"}>
                      <td className="px-5 py-2">
                        <span className="flex items-center gap-2">
                          <CategoryDot color={n.color} size={8} />
                          <span className="truncate">{n.name}</span>
                          <span className="text-xs text-zinc-400">{r.count} işlem</span>
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right font-medium">{money(r.cents)}</td>
                      <td className="px-2 py-2 text-right text-zinc-500">%{(r.shareBp / 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 })}</td>
                      {report?.compareRange && <td className="px-2 py-2 text-right text-zinc-500">{money(r.compareCents)}</td>}
                      {report?.compareRange && (
                        <td className={`px-5 py-2 text-right ${r.deltaCents ? (bad ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400") : "text-zinc-400"}`}>
                          {r.deltaCents ? `${r.deltaCents > 0 ? "+" : "−"}${formatMoney(Math.abs(r.deltaCents) / 100)}` : "—"}
                          {r.deltaBp !== null && r.deltaCents !== 0 && <span className="ml-1 text-xs">{pct(r.deltaBp)}</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {q.group === "tag" && rows.length > 0 && (
            <p className="px-5 py-2 text-xs text-zinc-500">Birden çok etiketli işlem her etiketinde sayılır; paylar toplamı %100'ü aşabilir.</p>
          )}
        </section>

        <section className="card p-5 xl:col-span-2">
          <h2 className="text-sm font-semibold">Aylık {kindLabel.toLocaleLowerCase("tr")}</h2>
          {report && report.months.length > 0 ? (
            <div className="mt-3 h-64">
              <ResponsiveContainer>
                <BarChart data={report.months.map((m) => ({ ay: monthLabel(m.month), bu: m.cents / 100, onceki: m.compareCents === null ? undefined : m.compareCents / 100 }))}>
                  <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                  <XAxis dataKey="ay" tick={{ fill: "var(--chart-axis)", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(v) => formatCompact(Number(v))} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
                  <Tooltip formatter={(v: number) => formatMoney(v)} />
                  {report.compareRange && <Legend wrapperStyle={{ fontSize: 12 }} />}
                  <Bar dataKey="bu" name="Bu dönem" fill={q.kind === "expense" ? "var(--expense)" : "var(--income)"} isAnimationActive={false} />
                  {report.compareRange && <Bar dataKey="onceki" name="Karşılaştırma" fill="var(--chart-axis)" fillOpacity={0.45} isAnimationActive={false} />}
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="mt-3 h-64 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
          )}
        </section>
      </div>

      <section className="card mt-4 p-5">
        <h2 className="text-sm font-semibold">Gelir akışı</h2>
        <p className="text-xs text-zinc-500">Gelir kaynaklarından giderlere ve birikime (kategoriye göre; küçük kalemler "Diğer")</p>
        {sankey ? (
          <div className="mt-3 h-[420px] overflow-x-auto text-zinc-700 dark:text-zinc-300">
            <div className="h-full min-w-[640px]">
              <ResponsiveContainer>
                <Sankey
                  data={sankey}
                  nodePadding={18}
                  nodeWidth={10}
                  margin={{ top: 10, right: 150, bottom: 10, left: 10 }}
                  link={{ stroke: "var(--chart-axis)", strokeOpacity: 0.25 }}
                  node={<FlowNode x={0} y={0} width={0} height={0} payload={{ name: "", color: "", value: 0 }} money={(v) => formatMoney(v)} />}
                >
                  <Tooltip formatter={(v: number) => formatMoney(v)} />
                </Sankey>
              </ResponsiveContainer>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">Bu dönemde gelir ya da gider yok.</p>
        )}
      </section>
    </>
  );
}
