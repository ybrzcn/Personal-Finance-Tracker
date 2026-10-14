import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, errorMessage } from "../lib/api";
import { formatDate, todayISO } from "../lib/format";
import { currencyLabel, formatQty, formatRate, unitDivisor } from "../lib/fx";
import type { AccountPnl, PnlReport } from "../lib/types";
import { backend } from "../lib/platform";
import { useAuth } from "../state/auth";
import { useData } from "../state/data";
import { useRates } from "../state/rates";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

type Period = "thisMonth" | "thisYear" | "lastYear" | "all";
const PERIOD_LABEL: Record<Period, string> = { thisMonth: "Bu ay", thisYear: "Bu yıl", lastYear: "Geçen yıl", all: "Tümü" };

function periodRange(p: Period): [string | null, string | null] {
  const t = todayISO();
  const y = Number(t.slice(0, 4));
  if (p === "thisMonth") return [`${t.slice(0, 7)}-01`, t];
  if (p === "thisYear") return [`${y}-01-01`, t];
  if (p === "lastYear") return [`${y - 1}-01-01`, `${y - 1}-12-31`];
  return [null, null];
}

/** Ortalama maliyet ×1e6 → en çok 4 ondalık (gösterim) */
const avgFmt = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const pct = (bp: number | null) => (bp === null ? "—" : `${bp >= 0 ? "+" : ""}${(bp / 100).toLocaleString("tr-TR", { maximumFractionDigits: 2 })}%`);
const tone = (v: number | null) => (v === null ? "text-zinc-400" : v >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400");

export function PnlPage() {
  const { transactions, accountById } = useData();
  const { refresh } = useRates();
  const { formatMoney } = useSettings();
  const { openTransactionForm } = useUI();
  const { mode } = useAuth();
  // Anahtar masaüstünde yerel modda Ayarlar'dan, diğer durumlarda sunucuda verilir
  const localDesktop = backend === "tauri" && mode !== "server";
  const [period, setPeriod] = useState<Period>("thisYear");
  const [report, setReport] = useState<PnlReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const money = (c: number | null) => (c === null ? "—" : formatMoney(c / 100));
  const signed = (c: number | null) => (c === null ? "—" : `${c > 0 ? "+" : ""}${formatMoney(c / 100)}`);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [from, to] = periodRange(period);
      setReport(await api.pnlReport(from, to));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [period, transactions]);
  useEffect(() => {
    void refresh().then(load);
  }, [refresh, load]);

  const t = report?.totals;
  const cpiOk = report?.cpi.status === "ok";
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Kâr/Zarar</h1>
        <button className="btn-secondary ml-auto gap-2 px-3 py-1.5 text-xs" onClick={() => void refresh().then(load)} disabled={loading}>
          <RefreshCw size={14} /> Yenile
        </button>
      </div>
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">{error}</p>}
      {report && t && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Toplam değer" value={money(t.valueCents)} />
            <Stat label="Kâğıt üstü kâr/zarar" value={signed(t.unrealizedCents)} sub={pct(t.unrealizedBp)} cls={tone(t.unrealizedCents)} />
            <Stat label={`Gerçekleşen (${PERIOD_LABEL[period].toLocaleLowerCase("tr")})`} value={signed(t.realizedCents)} cls={tone(t.realizedCents)} />
            {cpiOk && <Stat label="Reel getiri / enflasyon" value={pct(t.realUnrealizedBp)} sub={`enflasyon ${pct(t.inflationBp)}`} cls={tone(t.realUnrealizedBp)} />}
          </div>
          {t.partial && <p className="text-xs text-amber-600 dark:text-amber-400">Bazı hesaplar ya da satışlar (kur alınamadı ya da maliyet bilinmiyor) toplama girmedi.</p>}
          {cpiOk && report.cpi.latestMonth && (
            <p className="text-xs text-zinc-500">TÜFE verisi {report.cpi.latestMonth} ayına kadar (TCMB EVDS); sonraki aylarda son açıklanan ay kullanılır (≈).</p>
          )}
          {!cpiOk && (
            <p className="text-xs text-zinc-500">
              {report.cpi.status === "noKey"
                ? localDesktop
                  ? "Enflasyon karşılaştırması için Ayarlar'dan TCMB EVDS API anahtarı girin."
                  : "Enflasyon karşılaştırması kapalı: sunucuda FINANS_EVDS_KEY tanımlı değil."
                : `Enflasyon verisi alınamadı${report.cpi.message ? `: ${report.cpi.message}` : "."}`}
            </p>
          )}
          <Holdings rows={report.accounts} cpiOk={cpiOk} money={money} signed={signed} />
          <section className="card p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">Gerçekleşenler</h2>
              <div className="ml-auto flex gap-1">
                {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
                  <button key={p} className={p === period ? "btn-primary px-2.5 py-1 text-xs" : "btn-secondary px-2.5 py-1 text-xs"} onClick={() => setPeriod(p)}>
                    {PERIOD_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>
            {report.months.length > 0 && (
              <div className="h-48">
                <ResponsiveContainer>
                  <BarChart data={report.months.map((m) => ({ ay: m.month, tl: m.pnlCents / 100 }))}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="ay" fontSize={11} />
                    <YAxis fontSize={11} width={70} tickFormatter={(v: number) => formatMoney(v)} />
                    <Tooltip formatter={(v: number) => formatMoney(v)} />
                    <Bar dataKey="tl" name="Kâr/zarar">
                      {report.months.map((m) => (
                        <Cell key={m.month} fill={m.pnlCents >= 0 ? "#10b981" : "#f43f5e"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {report.realized.length === 0 ? (
              <p className="text-sm text-zinc-500">Bu dönemde satış ya da döviz/altın harcaması yok.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="mt-3 w-full text-sm tabular-nums">
                  <thead className="text-xs text-zinc-500">
                    <tr>
                      <th className="py-2 text-left font-medium">Tarih</th>
                      <th className="py-2 text-left font-medium">Hesap</th>
                      <th className="py-2 text-right font-medium">Miktar</th>
                      <th className="py-2 text-right font-medium">Tutar</th>
                      <th className="py-2 text-right font-medium">Maliyet</th>
                      <th className="py-2 text-right font-medium">Kâr/zarar</th>
                      {cpiOk && <th className="py-2 text-right font-medium">Reel</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {report.realized.map((i) => (
                      <tr
                        key={i.transactionId}
                        className="cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/40"
                        onClick={() => {
                          const tx = transactions.find((x) => x.id === i.transactionId);
                          if (tx) openTransactionForm(tx);
                        }}
                      >
                        <td className="py-2">{formatDate(i.date)}</td>
                        <td className="py-2">
                          {accountById.get(i.accountId)?.name ?? "—"} <span className="text-xs text-zinc-400">{i.kind === "expense" ? "gider" : "satış"}</span>
                        </td>
                        <td className="py-2 text-right">{formatQty(i.qtyMinor / unitDivisor(i.currency), i.currency)}</td>
                        <td className="py-2 text-right">{money(i.proceedsCents)}</td>
                        <td className="py-2 text-right">{i.costUnknown ? "bilinmiyor" : money(i.costCents)}</td>
                        <td className={`py-2 text-right ${tone(i.pnlCents)}`}>{signed(i.pnlCents)}</td>
                        {cpiOk && (
                          <td className={`py-2 text-right ${tone(i.realPnlCents)}`}>
                            {signed(i.realPnlCents)}
                            {i.cpiApprox && <span title="TÜFE ayı henüz açıklanmadı; son ay kullanıldı">≈</span>}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, cls = "" }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className={`text-xs tabular-nums ${cls || "text-zinc-500"}`}>{sub}</div>}
    </div>
  );
}

function Holdings({ rows, cpiOk, money, signed }: { rows: AccountPnl[]; cpiOk: boolean; money: (c: number | null) => string; signed: (c: number | null) => string }) {
  if (rows.length === 0) return <p className="card p-4 text-sm text-zinc-500">Döviz ya da altın hesabı yok.</p>;
  return (
    <section className="card overflow-x-auto p-0">
      <h2 className="border-b border-zinc-100 px-4 py-2 text-sm font-semibold dark:border-zinc-800">Elimdekiler</h2>
      <table className="w-full text-sm tabular-nums">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Hesap</th>
            <th className="px-2 py-2 text-right font-medium">Miktar</th>
            <th className="px-2 py-2 text-right font-medium">Ort. maliyet</th>
            <th className="px-2 py-2 text-right font-medium">Güncel alış</th>
            <th className="px-2 py-2 text-right font-medium">Değer</th>
            <th className="px-2 py-2 text-right font-medium">Kâr/zarar</th>
            {cpiOk && <th className="px-4 py-2 text-right font-medium">Reel</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const warn = [
              a.costUnknown && "Maliyet bilinmiyor: açılış maliyetini hesap formundan girin",
              a.inconsistentSince && `Kayıtlar tutarsız: ${formatDate(a.inconsistentSince)} tarihinde eldekinden fazla çıkış`,
              a.noRate && "Kur alınamadı",
              a.rateStale && "Kur eski",
            ].filter(Boolean) as string[];
            return (
              <tr key={a.accountId} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-1">
                    {a.name}
                    {warn.length > 0 && (
                      <span title={warn.join(". ")} aria-label={warn.join(". ")}>
                        <AlertTriangle size={12} className="text-amber-500" />
                      </span>
                    )}
                  </span>
                  <div className="text-xs text-zinc-400">{currencyLabel(a.currency)}</div>
                </td>
                <td className="px-2 py-2 text-right">{formatQty(a.qtyMinor / unitDivisor(a.currency), a.currency)}</td>
                <td className="px-2 py-2 text-right">{a.avgCostMicros === null ? "—" : avgFmt.format(a.avgCostMicros / 1e6)}</td>
                <td className="px-2 py-2 text-right">{a.rateMicros === null ? "—" : formatRate(a.rateMicros / 1e6)}</td>
                <td className="px-2 py-2 text-right">{money(a.valueCents)}</td>
                <td className={`px-2 py-2 text-right ${tone(a.unrealizedCents)}`}>
                  {signed(a.unrealizedCents)} {a.unrealizedBp !== null && <span className="text-xs">{pct(a.unrealizedBp)}</span>}
                </td>
                {cpiOk && (
                  <td className={`px-4 py-2 text-right ${tone(a.realUnrealizedCents)}`}>
                    {signed(a.realUnrealizedCents)} {a.realUnrealizedBp !== null && <span className="text-xs">{pct(a.realUnrealizedBp)}</span>}
                    {a.cpiApprox && <span title="TÜFE ayı henüz açıklanmadı; son ay kullanıldı">≈</span>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
