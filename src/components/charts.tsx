import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import type { CategorySlice, MonthPoint } from "../lib/stats";
import { useSettings } from "../state/settings";

function TooltipBox({ active, payload, label }: TooltipProps<number, string>) {
  const { formatMoney } = useSettings();
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
      {label && <div className="mb-1 font-medium">{label}</div>}
      {payload.map((p) => (
        <div key={String(p.dataKey) + p.name} className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: (p.payload as { color?: string })?.color ?? p.color }}
          />
          <span className="text-zinc-500 dark:text-zinc-400">{p.name}</span>
          <span className="ml-auto pl-3 font-semibold tabular-nums">{formatMoney(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

/** Halka grafik + yüzdelik dağılım listesi */
export function CategoryDonut({ data }: { data: CategorySlice[] }) {
  const { formatMoney, formatCompact } = useSettings();
  const total = data.reduce((s, d) => s + d.value, 0);
  const top = data.slice(0, 6);

  return (
    // Dar kartta açıklama listesi halkanın altına iner
    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-4">
      <div className="relative h-44 w-44 shrink-0 xl:h-48 xl:w-48">
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="68%"
              outerRadius="100%"
              paddingAngle={data.length > 1 ? 2 : 0}
              stroke="none"
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={d.id} fill={d.color} />
              ))}
            </Pie>
            <Tooltip content={<TooltipBox />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[11px] text-zinc-500">Toplam</span>
          <span className="text-base font-semibold tabular-nums">{formatCompact(total)}</span>
        </div>
      </div>
      <ul className="min-w-[15rem] flex-1 space-y-2">
        {top.map((d) => {
          const pct = total ? (d.value / total) * 100 : 0;
          return (
            <li key={d.id} className="text-sm">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
                <span className="truncate">{d.name}</span>
                <span className="ml-auto whitespace-nowrap tabular-nums text-zinc-500">{pct.toFixed(0)}%</span>
                <span className="min-w-[5.5rem] shrink-0 whitespace-nowrap text-right font-medium tabular-nums">{formatMoney(d.value)}</span>
              </div>
            </li>
          );
        })}
        {data.length > top.length && (
          <li className="text-xs text-zinc-500">+{data.length - top.length} kategori daha</li>
        )}
      </ul>
    </div>
  );
}

/** Kategori bazlı yatay çubuk grafik */
export function CategoryBars({ data }: { data: CategorySlice[] }) {
  const { formatCompact } = useSettings();
  const rows = data.slice(0, 8);
  return (
    <div style={{ height: Math.max(rows.length * 34 + 16, 120) }}>
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
          <XAxis
            type="number"
            tickFormatter={(v) => formatCompact(Number(v))}
            tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={118}
            interval={0}
            // Uzun adlar tek satırda kısaltılır (alt alta kayıp üst üste binmesin); tamamı ipucunda görünür
            tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
            tick={{ fill: "var(--chart-axis)", fontSize: 12, width: 200 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={<TooltipBox />} cursor={{ fill: "var(--chart-cursor)" }} />
          <Bar dataKey="value" name="Harcama" radius={[0, 6, 6, 0]} isAnimationActive={false}>
            {rows.map((d) => (
              <Cell key={d.id} fill={d.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Aylık gelir / gider karşılaştırması */
export function MonthlyChart({ data, className = "h-64" }: { data: MonthPoint[]; className?: string }) {
  const { formatCompact } = useSettings();
  return (
    <div className={className}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={4} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={{ fill: "var(--chart-axis)", fontSize: 12 }} axisLine={false} tickLine={false} />
          <YAxis
            tickFormatter={(v) => formatCompact(Number(v))}
            tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={64}
          />
          <Tooltip content={<TooltipBox />} cursor={{ fill: "var(--chart-cursor)" }} />
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
            formatter={(v) => <span style={{ color: "var(--chart-axis)" }}>{v}</span>}
          />
          <Bar dataKey="income" name="Gelir" fill="var(--income)" radius={[5, 5, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          <Bar dataKey="expense" name="Gider" fill="var(--expense)" radius={[5, 5, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
