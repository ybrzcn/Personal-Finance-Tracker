import { AlertTriangle, Telescope } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import { EmptyState, PageHeader, Segmented, SummaryTile, type TileTone } from "../components/common";
import { api, errorMessage } from "../lib/api";
import { locale, t } from "../lib/i18n";
import { amountToInput, decimalToInput, formatMonthYear, formatMonthYearShort, parseAmount, parseDecimal } from "../lib/format";
import type { ProjectionAssumptions, ProjectionReport } from "../lib/types";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

const DEFAULTS: ProjectionAssumptions = { years: 10, incomeGrowthPct: 0, expenseGrowthPct: 0, returnPct: 0, monthlyExtra: 0 };
const YEARS = [5, 10, 20, 30].map((y) => ({ value: String(y), label: t("{n} yıl", { n: y }) }));
const shortMonth = formatMonthYearShort;
const monthDate = (ym: string) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1);

/** Eksi işaretli tutar/oran: "-1.500" → −1500 */
function parseSigned(text: string, pct: boolean): number | null {
  const t = text.trim().replace(/^[−-]\s*/, "");
  const neg = t !== text.trim();
  const v = pct ? parseDecimal(t, 2) : parseAmount(t);
  return v === null ? null : neg ? -v : v;
}
const toText = (v: number, pct: boolean) => (v === 0 ? "" : `${v < 0 ? "-" : ""}${pct ? decimalToInput(Math.abs(v)) : amountToInput(Math.abs(v))}`);

function NumberField({
  label,
  hint,
  value,
  pct,
  onCommit,
}: {
  label: string;
  hint: string;
  value: number;
  pct: boolean;
  onCommit(v: number): void;
}) {
  const [text, setText] = useState(toText(value, pct));
  useEffect(() => setText(toText(value, pct)), [value, pct]);
  const commit = () => {
    const v = text.trim() ? parseSigned(text, pct) : 0;
    // Hatalı yazım eski değere döner
    if (v === null) return setText(toText(value, pct));
    if (v !== value) onCommit(v);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && (e.target as HTMLInputElement).blur();
  return (
    <label className="block">
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{label}</span>
      <div className="relative mt-1">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-400" aria-hidden>
          {pct ? "%" : "₺"}
        </span>
        <input
          className="input pl-7 tabular-nums"
          inputMode="decimal"
          placeholder="0"
          aria-label={label}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
        />
      </div>
      <span className="mt-1 block text-[11px] text-zinc-500">{hint}</span>
    </label>
  );
}

function Tip({ active, payload, label }: TooltipProps<number, string>) {
  const { formatMoney } = useSettings();
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
      <div className="mb-1 font-medium">{label}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-zinc-500 dark:text-zinc-400">{p.name}</span>
          {/* Borç alanı grafikte eksi çizilir; tutarı artı gösterilir */}
          <span className="ml-auto pl-3 font-semibold tabular-nums">{formatMoney(p.dataKey === "debt" ? -Number(p.value) : Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

export function ProjectionPage() {
  const { accounts, transactions, recurring, budgets, appSettings, saveSetting } = useData();
  const { formatMoney, formatCompact } = useSettings();
  const { toast } = useUI();
  // Kayıtlı ayardaki sayı olmayan değer (bozuk ya da elle düzenlenmiş yedek) varsayılana döner; aralık Rust'ta sınırlanır
  const assumptions: ProjectionAssumptions = useMemo(() => {
    const saved = appSettings.projection ?? {};
    const pick = (k: keyof ProjectionAssumptions) => (typeof saved[k] === "number" && Number.isFinite(saved[k]) ? (saved[k] as number) : DEFAULTS[k]);
    return {
      years: Math.round(pick("years")),
      incomeGrowthPct: pick("incomeGrowthPct"),
      expenseGrowthPct: pick("expenseGrowthPct"),
      returnPct: pick("returnPct"),
      monthlyExtra: pick("monthlyExtra"),
    };
  }, [appSettings.projection]);
  const [report, setReport] = useState<ProjectionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const load = () => {
    const n = ++seq.current;
    setLoading(true);
    api
      .projectionReport(assumptions)
      .then((r) => {
        if (n !== seq.current) return;
        setReport(r);
        setError(null);
      })
      .catch((e) => n === seq.current && setError(errorMessage(e)))
      .finally(() => n === seq.current && setLoading(false));
  };
  // Varsayım ya da veri değişince yeniden hesaplanır
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [assumptions, accounts, transactions, recurring, budgets]);

  const set = (patch: Partial<ProjectionAssumptions>) => {
    saveSetting("projection", { ...assumptions, ...patch }).catch((e) => toast(errorMessage(e), "error"));
  };

  const data = useMemo(
    () =>
      (report?.points ?? []).map((p) => ({
        label: shortMonth(p.month),
        net: p.netWorthCents / 100,
        real: p.realNetWorthCents / 100,
        debt: -p.debtCents / 100,
      })),
    [report],
  );

  // Gösterilen varsayımlar hesapta kullanılanlar (Rust sınırlar: yıl 1–30, oran −50…200)
  const used = report?.assumptions ?? assumptions;
  const money = (c: number | undefined) => (c === undefined ? (loading && !error ? "…" : "—") : formatMoney(c / 100));
  const last = report?.years.at(-1);
  const inflation = used.expenseGrowthPct !== 0;
  const tiles: { label: string; value: string; tone: TileTone; hint?: string | null }[] = [
    { label: t("Bugün"), value: money(report?.startNetWorthCents), tone: "plain", hint: t("Net servet") },
    {
      label: t("{n}. yılın sonunda", { n: used.years }),
      value: money(last?.netWorthCents),
      tone: !last ? "plain" : last.netWorthCents < 0 ? "expense" : "income",
      hint: last ? formatMonthYear(monthDate(last.endMonth)) : null,
    },
    {
      label: t("Bugünün parasıyla"),
      value: money(last?.realNetWorthCents),
      tone: "info",
      hint: inflation
        ? t("Yıllık %{v} enflasyonla indirgenmiş", { v: used.expenseGrowthPct.toLocaleString(locale) })
        : t("Enflasyon girilmedi; tutarlar aynı"),
    },
    {
      label: t("Kredi borcu bitişi"),
      value: report
        ? report.debtFreeMonth
          ? formatMonthYear(monthDate(report.debtFreeMonth))
          : report.loanWithoutSchedule
            ? t("Taksit planı yok")
            : t("Kredi yok")
        : money(undefined),
      tone: "plain",
      hint: report && report.startLoanDebtCents > 0 ? t("Kalan anapara {amount}", { amount: formatMoney(report.startLoanDebtCents / 100) }) : null,
    },
  ];

  const base = report?.base;
  const flow: { label: string; cents: number | undefined; sign: 1 | -1; note?: string }[] = [
    { label: t("Düzenli gelir"), cents: base?.incomeCents, sign: 1 },
    { label: t("Düzenli gider"), cents: base?.regularExpenseCents, sign: -1 },
    { label: t("Kategori limitleri"), cents: base?.budgetCents, sign: -1 },
    {
      label: t("Düzensiz gider"),
      cents: base?.irregularExpenseCents,
      sign: -1,
      note: base ? (base.irregularMonths > 0 ? t("son {n} ayın ortalaması", { n: base.irregularMonths }) : t("geçmiş yok")) : undefined,
    },
    { label: t("Kredi taksitleri"), cents: base?.loanCents, sign: -1, note: t("önümüzdeki ay") },
  ];
  if (base && base.extraCents !== 0) flow.push({ label: t("Senaryo"), cents: Math.abs(base.extraCents), sign: base.extraCents > 0 ? 1 : -1 });

  return (
    <>
      <PageHeader
        title={t("Uzun Vade")}
        subtitle={t("Bugünkü net servetten yıllar sonrasına tahmin")}
        actions={<Segmented value={String(used.years)} options={YEARS} onChange={(v) => set({ years: Number(v) })} />}
      />

      {error && (
        <div role="alert" className="card mb-4 flex items-center justify-between gap-3 px-5 py-4 text-sm">
          <span className="text-rose-600 dark:text-rose-400">{t("Tahmin alınamadı: {error}", { error })}</span>
          <button className="btn-secondary px-3 py-1.5 text-xs" onClick={load}>
            {t("Tekrar dene")}
          </button>
        </div>
      )}

      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <SummaryTile key={t.label} label={t.label} value={t.value} tone={t.tone} hint={t.hint} />
        ))}
      </div>

      {report?.firstNegativeMonth && (
        <div role="status" className="card mb-3 flex items-start gap-3 px-5 py-3 text-sm">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
          <span>
            {(() => {
              const [pre, post] = t("Bu varsayımlarla nakit {month} ayında eksiye düşüyor: gider ve taksitler geliri aşıyor.").split("{month}");
              return (
                <>
                  {pre}
                  <span className="font-semibold">{formatMonthYear(monthDate(report.firstNegativeMonth))}</span>
                  {post}
                </>
              );
            })()}
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="card p-5 xl:col-span-2">
          <h2 className="text-sm font-semibold">{t("Net servet")}</h2>
          <p className="text-xs text-zinc-500">{t("Aylık tahmin; kesikli çizgi bugünün parasıyla, kırmızı alan kalan kredi borcu")}</p>
          {report && report.points.length > 1 ? (
            <div className="mt-3 h-72">
              <ResponsiveContainer>
                <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                  <XAxis dataKey="label" tick={{ fill: "var(--chart-axis)", fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={24} />
                  <YAxis tickFormatter={(v) => formatCompact(Number(v))} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} axisLine={false} tickLine={false} width={64} />
                  <Tooltip content={<Tip />} />
                  {report.startLoanDebtCents > 0 && (
                    <Area dataKey="debt" name={t("Kredi borcu")} stroke="var(--expense)" fill="var(--expense)" fillOpacity={0.15} isAnimationActive={false} />
                  )}
                  {inflation && (
                    <Line dataKey="real" name={t("Bugünün parasıyla")} stroke="var(--chart-axis)" strokeDasharray="5 4" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  )}
                  <Line dataKey="net" name={t("Net servet")} stroke="var(--chart-net)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : !report ? (
            <div className="mt-3 h-72 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" aria-label={t("Tahmin yükleniyor")} />
          ) : (
            <EmptyState icon={Telescope} title={t("Tahmin için veri yok")} />
          )}
        </section>

        <div className="space-y-4">
          <section className="card space-y-3 p-5">
            <h2 className="text-sm font-semibold">{t("Varsayımlar")}</h2>
            <div className="grid grid-cols-2 gap-3">
              <NumberField label={t("Yıllık zam")} hint={t("Gelirler her Ocak artar")} value={used.incomeGrowthPct} pct onCommit={(v) => set({ incomeGrowthPct: v })} />
              <NumberField
                label={t("Yıllık enflasyon")}
                hint={t("Giderler her Ocak artar")}
                value={used.expenseGrowthPct}
                pct
                onCommit={(v) => set({ expenseGrowthPct: v })}
              />
              <NumberField label={t("Yıllık getiri")} hint={t("Birikmiş nakde")} value={used.returnPct} pct onCommit={(v) => set({ returnPct: v })} />
              <NumberField
                label={t("Aylık ek")}
                hint={t("Eksi: ek gider")}
                value={used.monthlyExtra}
                pct={false}
                onCommit={(v) => set({ monthlyExtra: v })}
              />
            </div>
          </section>

          <section className="card p-5">
            <h2 className="text-sm font-semibold">{t("Bugünkü aylık akış")}</h2>
            <div className="mt-3 space-y-2 text-sm">
              {flow.map((f) => (
                <div key={f.label} className="flex justify-between gap-3">
                  <span className="text-zinc-500">
                    {f.label}
                    {f.note && <span className="text-xs"> · {f.note}</span>}
                  </span>
                  <span className={`font-medium tabular-nums ${f.sign > 0 ? "text-emerald-600 dark:text-emerald-400" : ""}`}>
                    {f.cents === undefined ? money(undefined) : f.sign < 0 && f.cents > 0 ? `−${formatMoney(f.cents / 100)}` : formatMoney(f.cents / 100)}
                  </span>
                </div>
              ))}
              <div className="flex justify-between border-t border-zinc-200 pt-2 dark:border-zinc-800">
                <span className="font-medium">{t("Aylık birikim")}</span>
                <span className={`font-semibold tabular-nums ${(base?.netCents ?? 0) < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>{money(base?.netCents)}</span>
              </div>
            </div>
            <details className="mt-3 text-xs text-zinc-500">
              <summary className="cursor-pointer font-medium">{t("Nasıl hesaplanır?")}</summary>
              <ul className="mt-1.5 list-disc space-y-1 pl-4">
                <li>{t("Başlangıç bugünkü net servet. Kart ve KMH borcu ilk ay nakitten ödenmiş sayılır; kredi borcu taksit tablosuyla azalır.")}</li>
                <li>{t("Düzenli gelir ve giderler bugünkü tutarlarıyla, başlangıç tarihleri gelince girer; aya özel istisnalar sayılmaz.")}</li>
                <li>{t("Kategori limitleri ve son ayların düzensiz gider ortalaması her ay harcanmış sayılır; düzensiz gelir sayılmaz.")}</li>
                <li>{t("Zam ve enflasyon her Ocak uygulanır; getiri yalnız artıdaki nakde aylık işler. Kredi taksitleri artmaz.")}</li>
                <li>{t("Ev, araba gibi varlıklar bugünkü değeriyle sabit kalır; getiri ve nakit hesabına girmez.")}</li>
                <li>{t("Bir krediyi ayrıca düzenli gider olarak da girdiyseniz iki kez düşülür.")}</li>
              </ul>
            </details>
          </section>
        </div>
      </div>

      {report && report.years.length > 0 && (
        <section className="card mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
                <th className="px-5 py-2.5 font-medium">{t("Yıl")}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t("Gelir")}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t("Gider ve taksit")}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t("Getiri")}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t("Kredi borcu")}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t("Net servet")}</th>
                {inflation && <th className="px-5 py-2.5 text-right font-medium">{t("Bugünün parasıyla")}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {report.years.map((y) => (
                <tr key={y.year}>
                  <td className="px-5 py-2.5">
                    <span className="font-medium">{t("{n}. yıl", { n: y.year })}</span>
                    <span className="ml-1.5 text-xs text-zinc-500">{shortMonth(y.endMonth)}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{formatMoney(y.inflowCents / 100)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">−{formatMoney(y.outflowCents / 100)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{y.returnCents ? formatMoney(y.returnCents / 100) : "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{y.debtCents ? formatMoney(y.debtCents / 100) : "—"}</td>
                  <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${y.netWorthCents < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>
                    {formatMoney(y.netWorthCents / 100)}
                  </td>
                  {inflation && <td className="px-5 py-2.5 text-right tabular-nums text-zinc-500">{formatMoney(y.realNetWorthCents / 100)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
