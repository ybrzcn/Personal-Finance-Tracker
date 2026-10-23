import { useMemo, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import { formatMonthShort, parseISODate } from "../lib/format";
import type { NetWorthRange } from "../lib/networth";
import type { NetWorthPoint, NetWorthReport } from "../lib/types";
import { useSettings } from "../state/settings";
import { Segmented } from "./common";
import { t } from "../lib/i18n";
import { rich } from "../lib/rich";

type Range = NetWorthRange;
type View = "total" | "split" | "kinds";
const RANGES: { value: Range; label: string }[] = [
  { value: "1y", label: t("1 yıl") },
  { value: "3y", label: t("3 yıl") },
  { value: "all", label: t("Tümü") },
];
const VIEWS: { value: View; label: string }[] = [
  { value: "total", label: t("Toplam") },
  { value: "split", label: t("Varlık ve borç") },
  { value: "kinds", label: t("Kırılım") },
];
const KINDS = [
  { key: "tl", name: "TL", color: "var(--income)", sign: 1 },
  { key: "fx", name: t("Döviz/altın"), color: "#d4a017", sign: 1 },
  { key: "fund", name: t("Fon"), color: "#0ea5a4", sign: 1 },
  { key: "saving", name: t("Mevduat, BES, varlık"), color: "#8b5cf6", sign: 1 },
  { key: "card", name: t("Kart"), color: "var(--expense)", sign: -1 },
  { key: "loan", name: t("Kredi"), color: "#b91c1c", sign: -1 },
  { key: "overdraft", name: t("KMH"), color: "#f97316", sign: -1 },
];

const label = (iso: string) => `${formatMonthShort(parseISODate(`${iso.slice(0, 7)}-01`))} ${iso.slice(2, 4)}`;

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
          {t("Kur/fiyat kazancı")} <span className="font-semibold tabular-nums">{formatMoney(row.net - row.cost)}</span>
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
          saving: (p.byKind.savingCents ?? 0) / 100,
          card: -p.byKind.cardCents / 100,
          loan: -p.byKind.loanCents / 100,
          overdraft: -p.byKind.overdraftCents / 100,
          account: acc ? acc.valueCents / 100 : null,
        };
      }),
    [points, accountId],
  );

  if (error && !report) return null; // hata, kutuların yerindeki mesajda
  if (!report) return <section className="card h-72 animate-pulse" aria-label={t("Net servet yükleniyor")} />;
  if (report.points.length === 0) return null;

  const last = points.at(-1)!;
  const change = summary?.changeCents ?? 0;
  const fxGain = summary?.fxGainCents ?? 0;
  const signed = (c: number) => `${c > 0 ? "+" : ""}${formatMoney(c / 100)}`;

  return (
    <section className="card space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t("Net servet")}</h2>
          <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight">{formatMoney(last.netCents / 100)}</div>
          {points.length > 1 && (
            <p className="text-xs text-zinc-500">
              {range === "all" ? t("Başından beri") : range === "1y" ? t("Son 1 yılda") : t("Son 3 yılda")}{" "}
              <span className="font-semibold tabular-nums">{signed(change)}</span>
              {fxGain !== 0 && (
                <>
                  {" "}·{" "}
                  {rich(t("bunun {amount} kadarı kur/fiyat kazancı"), {
                    amount: <span className="font-semibold tabular-nums">{signed(fxGain)}</span>,
                  })}
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
                <Area dataKey="gap" name={t("Kur/fiyat kazancı")} stroke="none" fill="var(--income)" fillOpacity={0.12} isAnimationActive={false} />
                <Line dataKey="cost" name={t("Maliyetle")} stroke="var(--chart-axis)" strokeDasharray="5 4" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line dataKey="net" name={t("Bugünkü fiyatla")} stroke="var(--chart-net)" strokeWidth={2.5} dot={points.length === 1} isAnimationActive={false} />
              </>
            )}
            {view === "split" && (
              <>
                <Area dataKey="assets" name={t("Varlıklar")} stroke="var(--income)" fill="var(--income)" fillOpacity={0.18} isAnimationActive={false} />
                <Area dataKey="debts" name={t("Borçlar")} stroke="var(--expense)" fill="var(--expense)" fillOpacity={0.18} isAnimationActive={false} />
                <Line dataKey="net" name={t("Net servet")} stroke="var(--chart-net)" strokeWidth={2.5} dot={points.length === 1} isAnimationActive={false} />
              </>
            )}
            {view === "kinds" && (
              <>
                {KINDS.map((k) => (
                  <Area key={k.key} dataKey={k.key} name={k.name} stackId={k.sign > 0 ? "plus" : "minus"} stroke={k.color} fill={k.color} fillOpacity={0.35} isAnimationActive={false} />
                ))}
                {accountId && <Line dataKey="account" name={report.accounts.find((a) => a.accountId === accountId)?.name ?? t("Hesap")} stroke="var(--chart-fg)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />}
              </>
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {view === "kinds" && (
        <div className="max-w-xs">
          <label className="label" htmlFor="nw-account">
            {t("Hesap seç")}
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
        {last.costPartial && <p>{t("Maliyeti bilinmeyen hesaplar maliyet çizgisinde bugünkü değeriyle gösteriliyor.")}</p>}
        {points.length === 1 && <p>{t("Geçmiş biriktikçe eğri oluşur.")}</p>}
      </div>
    </section>
  );
}
