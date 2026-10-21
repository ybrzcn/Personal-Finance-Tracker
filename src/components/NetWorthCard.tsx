import { useMemo, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import type { NetWorthRange } from "../lib/networth";
import type { NetWorthPoint, NetWorthReport } from "../lib/types";
import { useSettings } from "../state/settings";
import { Segmented } from "./common";

type Range = NetWorthRange;
type View = "total" | "split" | "kinds";
const RANGES: { value: Range; label: string }[] = [
  { value: "1y", label: "1 yıl" },
  { value: "3y", label: "3 yıl" },
  { value: "all", label: "Tümü" },
];
const VIEWS: { value: View; label: string }[] = [
  { value: "total", label: "Toplam" },
  { value: "split", label: "Varlık ve borç" },
  { value: "kinds", label: "Kırılım" },
];
const KINDS = [
  { key: "tl", name: "TL", color: "var(--income)", sign: 1 },
  { key: "fx", name: "Döviz/altın", color: "#d4a017", sign: 1 },
  { key: "fund", name: "Fon", color: "#0ea5a4", sign: 1 },
  { key: "card", name: "Kart", color: "var(--expense)", sign: -1 },
  { key: "loan", name: "Kredi", color: "#b91c1c", sign: -1 },
  { key: "overdraft", name: "KMH", color: "#f97316", sign: -1 },
] as const;

const MONTHS = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
const label = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`;

function Tip({ active, payload, label: l, total }: TooltipProps<number, string> & { total?: boolean }) {
  const { formatMoney } = useSettings();
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as { net?: number; cost?: number };
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
      <div className="mb-1 font-medium">{l}</div>
      {payload
        .filter((p) => p.dataKey !== "gap")
        .map((p) => (
          <div key={String(p.dataKey)} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
            <span className="text-zinc-500 dark:text-zinc-400">{p.name}</span>
            <span className="ml-auto pl-3 font-semibold tabular-nums">{formatMoney(Number(p.value))}</span>
          </div>
        ))}
      {total && row.net !== undefined && row.cost !== undefined && (
        <div className="mt-1 border-t border-zinc-200 pt-1 text-zinc-500 dark:border-zinc-700">
          Kur/fiyat kazancı <span className="font-semibold tabular-nums">{formatMoney(row.net - row.cost)}</span>
        </div>
      )}
    </div>
  );
}

export function NetWorthCard({ report, error }: { report: NetWorthReport | null; error: string | null }) {
  const { formatMoney, formatCompact } = useSettings();
  const [range, setRange] = useState<Range>("1y");
  const [view, setView] = useState<View>("total");
  const [accountId, setAccountId] = useState("");

  // Dönemin ilk noktası ve değişimi Rust'tan (1 yıl / 3 yıl önceki kesim)
  const summary = report?.ranges[range] ?? null;
  const points: NetWorthPoint[] = useMemo(() => (report && summary ? report.points.slice(summary.start) : []), [report, summary]);

  const data = useMemo(
    () =>
      points.map((p) => {
        const acc = p.accounts.find((a) => a.accountId === accountId);
        return {
          label: label(p.date),
          net: p.netCents / 100,
          cost: p.netCostCents / 100,
          gap: [Math.min(p.netCents, p.netCostCents) / 100, Math.max(p.netCents, p.netCostCents) / 100],
          assets: p.assetsCents / 100,
          debts: -(p.cardDebtCents + p.loanDebtCents + p.overdraftCents) / 100,
          tl: p.byKind.tlCents / 100,
          fx: p.byKind.fxCents / 100,
          fund: p.byKind.fundCents / 100,
          card: -p.byKind.cardCents / 100,
          loan: -p.byKind.loanCents / 100,
          overdraft: -p.byKind.overdraftCents / 100,
          account: acc ? acc.valueCents / 100 : null,
        };
      }),
    [points, accountId],
  );

  if (error && !report) return null; // hata, kutuların yerindeki mesajda
  if (!report) return <section className="card h-72 animate-pulse" aria-label="Net servet yükleniyor" />;
  if (report.points.length === 0) return null;

  const last = points.at(-1)!;
  const change = summary?.changeCents ?? 0;
  const fxGain = summary?.fxGainCents ?? 0;
  const signed = (c: number) => `${c > 0 ? "+" : ""}${formatMoney(c / 100)}`;
  const rangeLabel = RANGES.find((r) => r.value === range)!.label;

  return (
    <section className="card space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Net servet</h2>
          <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight">{formatMoney(last.netCents / 100)}</div>
          {points.length > 1 && (
            <p className="text-xs text-zinc-500">
              {range === "all" ? "Başından beri" : `Son ${rangeLabel}da`} <span className="font-semibold tabular-nums">{signed(change)}</span>
              {fxGain !== 0 && (
                <>
                  {" "}· bunun <span className="font-semibold tabular-nums">{signed(fxGain)}</span> kadarı kur/fiyat kazancı
                </>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2 max-sm:w-full max-sm:items-stretch">
          <Segmented<Range> value={range} options={RANGES} onChange={setRange} />
          <Segmented<View> value={view} options={VIEWS} onChange={setView} />
        </div>
      </div>

      <div className="h-64">
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis dataKey="label" tick={{ fill: "var(--chart-axis)", fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={16} />
            <YAxis tickFormatter={(v) => formatCompact(Number(v))} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} axisLine={false} tickLine={false} width={64} />
            <Tooltip content={<Tip total={view === "total"} />} />
            {view === "total" && (
              <>
                <Area dataKey="gap" name="Kur/fiyat kazancı" stroke="none" fill="var(--income)" fillOpacity={0.12} isAnimationActive={false} />
                <Line dataKey="cost" name="Maliyetle" stroke="var(--chart-axis)" strokeDasharray="5 4" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line dataKey="net" name="Bugünkü fiyatla" stroke="var(--chart-net)" strokeWidth={2.5} dot={points.length === 1} isAnimationActive={false} />
              </>
            )}
            {view === "split" && (
              <>
                <Area dataKey="assets" name="Varlıklar" stroke="var(--income)" fill="var(--income)" fillOpacity={0.18} isAnimationActive={false} />
                <Area dataKey="debts" name="Borçlar" stroke="var(--expense)" fill="var(--expense)" fillOpacity={0.18} isAnimationActive={false} />
                <Line dataKey="net" name="Net servet" stroke="var(--chart-net)" strokeWidth={2.5} dot={points.length === 1} isAnimationActive={false} />
              </>
            )}
            {view === "kinds" && (
              <>
                {KINDS.map((k) => (
                  <Area key={k.key} dataKey={k.key} name={k.name} stackId={k.sign > 0 ? "plus" : "minus"} stroke={k.color} fill={k.color} fillOpacity={0.35} isAnimationActive={false} />
                ))}
                {accountId && <Line dataKey="account" name={report.accounts.find((a) => a.accountId === accountId)?.name ?? "Hesap"} stroke="var(--chart-fg)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />}
              </>
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {view === "kinds" && (
        <div className="max-w-xs">
          <label className="label" htmlFor="nw-account">
            Hesap seç
          </label>
          <select id="nw-account" className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">—</option>
            {report.accounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="space-y-0.5 text-xs text-zinc-500">
        {last.costPartial && <p>Maliyeti bilinmeyen hesaplar maliyet çizgisinde bugünkü değeriyle gösteriliyor.</p>}
        {points.length === 1 && <p>Geçmiş biriktikçe eğri oluşur.</p>}
      </div>
    </section>
  );
}
