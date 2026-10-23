import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CategoryDonut } from "../components/charts";
import { api, errorMessage } from "../lib/api";
import { formatDate, formatMonthShort, parseISODate, todayISO } from "../lib/format";
import { currencyLabel, formatQty, formatRate } from "../lib/fx";
import type { AccountPnl, AllocationSlice, Category, InvestmentIncome, PnlKind, PnlReport } from "../lib/types";
import { backend } from "../lib/platform";
import { useAuth } from "../state/auth";
import { useData } from "../state/data";
import { useRates } from "../state/rates";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";
import { locale, t, tm } from "../lib/i18n";

type Period = "thisMonth" | "thisYear" | "lastYear" | "all";
const PERIOD_LABEL: Record<Period, string> = { thisMonth: t("Bu ay"), thisYear: t("Bu yıl"), lastYear: t("Geçen yıl"), all: t("Tümü") };
const KIND_LABEL: Record<PnlKind, string> = { all: t("Tümü"), fx: t("Döviz ve altın"), fund: t("Fonlar") };

function periodRange(p: Period): [string | null, string | null] {
  const today = todayISO();
  const y = Number(today.slice(0, 4));
  if (p === "thisMonth") return [`${today.slice(0, 7)}-01`, today];
  if (p === "thisYear") return [`${y}-01-01`, today];
  if (p === "lastYear") return [`${y - 1}-01-01`, `${y - 1}-12-31`];
  return [null, null];
}

/** Ortalama maliyet ×1e6 → en çok 4 ondalık (gösterim) */
const avgFmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const pct = (bp: number | null) => (bp === null ? "—" : `${bp >= 0 ? "+" : ""}${(bp / 100).toLocaleString(locale, { maximumFractionDigits: 2 })}%`);
const ALLOCATION: Record<AllocationSlice["key"], { name: string; color: string }> = {
  tl: { name: "TL", color: "#10b981" },
  deposit: { name: t("Vadeli mevduat"), color: "#059669" },
  pension: { name: t("BES"), color: "#8b5cf6" },
  asset: { name: t("Diğer varlık"), color: "#a16207" },
  fx: { name: t("Döviz"), color: "#3b82f6" },
  metal: { name: t("Altın ve gümüş"), color: "#d4a017" },
  fund: { name: t("Fonlar"), color: "#0ea5a4" },
};
const monthLabel = (ym: string) => `${formatMonthShort(parseISODate(`${ym}-01`))} ${ym.slice(2, 4)}`;
const tone = (v: number | null) => (v === null ? "text-zinc-400" : v >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400");

export function PnlPage() {
  const { transactions, accountById, categories, appSettings, settingsRev, saveSetting } = useData();
  const { refresh } = useRates();
  const { formatMoney } = useSettings();
  const { openTransactionForm } = useUI();
  const { mode } = useAuth();
  // Anahtar masaüstünde yerel modda Ayarlar'dan, diğer durumlarda sunucuda verilir
  const localDesktop = backend === "tauri" && mode !== "server";
  const [period, setPeriod] = useState<Period>("thisYear");
  const [kind, setKind] = useState<PnlKind>("all");
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
      setReport(await api.pnlReport(from, to, kind));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
    // Yatırım geliri kategorileri kaydedilince de (yazım bitince artan sayaç; kayıt bitmeden eski ayarla okunmasın)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, kind, transactions, settingsRev]);
  useEffect(() => {
    void refresh().then(load);
  }, [refresh, load]);

  const tot = report?.totals;
  const cpiOk = report?.cpi.status === "ok";
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{t("Kâr/Zarar")}</h1>
        <button className="btn-secondary ml-auto gap-2 px-3 py-1.5 text-xs" onClick={() => void refresh().then(load)} disabled={loading}>
          <RefreshCw size={14} /> {t("Yenile")}
        </button>
      </div>
      <div className="flex rounded-lg bg-zinc-100 p-0.5 text-xs dark:bg-zinc-800/60" role="group" aria-label={t("Varlıklar")}>
        {(Object.keys(KIND_LABEL) as PnlKind[]).map((k) => (
          <button
            key={k}
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={`flex-1 rounded-md px-3 py-1.5 ${kind === k ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100" : "text-zinc-500"}`}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">{error}</p>}
      {report && tot && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Stat label={t("Toplam değer")} value={money(tot.valueCents)} />
            <Stat label={t("Kâğıt üstü kâr/zarar")} value={signed(tot.unrealizedCents)} sub={pct(tot.unrealizedBp)} cls={tone(tot.unrealizedCents)} />
            <Stat label={t("Gerçekleşen ({period})", { period: PERIOD_LABEL[period].toLocaleLowerCase(locale) })} value={signed(tot.realizedCents)} cls={tone(tot.realizedCents)} />
            <Stat label={t("Yatırım geliri ({period})", { period: PERIOD_LABEL[period].toLocaleLowerCase(locale) })}
              value={signed(tot.incomeCents)}
              sub={t("faiz, temettü, fon dağıtımı")} cls={tone(tot.incomeCents)} />
            <Stat
              label={t("Toplam kazanç")}
              value={signed(tot.totalGainCents)}
              sub={
                period === "all"
                  ? t("kâğıt üstü + gerçekleşen + gelir")
                  : t("bugünkü kâğıt üstü + {period} gerçekleşen ve gelir", { period: PERIOD_LABEL[period].toLocaleLowerCase(locale) })
              }
              cls={tone(tot.totalGainCents)}
            />
            {cpiOk && <Stat label={t("Reel getiri / enflasyon")} value={pct(tot.realUnrealizedBp)} sub={t("enflasyon {v}", { v: pct(tot.inflationBp) })} cls={tone(tot.realUnrealizedBp)} />}
          </div>
          {tot.partial && <p className="text-xs text-amber-600 dark:text-amber-400">{t("Bazı hesaplar ya da satışlar (kur alınamadı ya da maliyet bilinmiyor) toplama girmedi.")}</p>}
          {cpiOk && report.cpi.latestMonth && (
            <p className="text-xs text-zinc-500">
              {t("TÜFE verisi {month} ayına kadar (TCMB EVDS); sonraki aylarda son açıklanan ay kullanılır (≈).", { month: report.cpi.latestMonth })}
            </p>
          )}
          {!cpiOk && (
            <p className="text-xs text-zinc-500">
              {report.cpi.status === "noKey"
                ? localDesktop
                  ? t("Enflasyon karşılaştırması için Ayarlar'dan TCMB EVDS API anahtarı girin.")
                  : t("Enflasyon karşılaştırması kapalı: sunucuda FINANS_EVDS_KEY tanımlı değil.")
                : report.cpi.message
                  ? t("Enflasyon verisi alınamadı: {error}", { error: tm(report.cpi.message) })
                  : t("Enflasyon verisi alınamadı.")}
            </p>
          )}
          <Holdings rows={report.accounts} cpiOk={cpiOk} money={money} signed={signed} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {report.income && (
              <IncomeCard
                income={report.income}
                pending={appSettings.investmentIncomeCategoryIds}
                categories={categories}
                periodLabel={PERIOD_LABEL[period].toLocaleLowerCase(locale)}
                money={money}
                onChange={(ids) => void saveSetting("investmentIncomeCategoryIds", ids).catch((e) => setError(errorMessage(e)))}
              />
            )}
            {report.allocation.length > 0 && (
              <section className="card p-4">
                <h2 className="mb-3 text-sm font-semibold">{t("Varlık dağılımı")}</h2>
                <CategoryDonut
                  data={report.allocation.map((a) => ({ id: a.key, name: ALLOCATION[a.key].name, color: ALLOCATION[a.key].color, value: a.valueCents / 100 }))}
                />
                <p className="mt-3 text-xs text-zinc-500">{t("Bugünkü değerle; kredi ve kart borçları düşülmez (net servet için Hesaplar).")}</p>
              </section>
            )}
          </div>
          <section className="card p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">{t("Gerçekleşenler")}</h2>
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
                    <Bar dataKey="tl" name={t("Kâr/zarar")}>
                      {report.months.map((m) => (
                        <Cell key={m.month} fill={m.pnlCents >= 0 ? "#10b981" : "#f43f5e"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {report.realized.length === 0 ? (
              <p className="text-sm text-zinc-500">{t("Bu dönemde satış ya da döviz/altın harcaması yok.")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="mt-3 w-full text-sm tabular-nums">
                  <thead className="text-xs text-zinc-500">
                    <tr>
                      <th className="py-2 text-left font-medium">{t("Tarih")}</th>
                      <th className="py-2 text-left font-medium">{t("Hesap")}</th>
                      <th className="py-2 text-right font-medium">{t("Miktar")}</th>
                      <th className="py-2 text-right font-medium">{t("Tutar")}</th>
                      <th className="py-2 text-right font-medium">{t("Maliyet")}</th>
                      <th className="py-2 text-right font-medium">{t("Kâr/zarar")}</th>
                      {cpiOk && <th className="py-2 text-right font-medium">{t("Reel")}</th>}
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
                          {accountById.get(i.accountId)?.name ?? "—"} <span className="text-xs text-zinc-400">{i.kind === "expense" ? t("gider") : t("satış")}</span>
                        </td>
                        <td className="py-2 text-right">{formatQty(i.qty, i.currency)}</td>
                        <td className="py-2 text-right">{money(i.proceedsCents)}</td>
                        <td className="py-2 text-right">{i.costUnknown ? t("bilinmiyor") : money(i.costCents)}</td>
                        <td className={`py-2 text-right ${tone(i.pnlCents)}`}>{signed(i.pnlCents)}</td>
                        {cpiOk && (
                          <td className={`py-2 text-right ${tone(i.realPnlCents)}`}>
                            {signed(i.realPnlCents)}
                            {i.cpiApprox && <span title={t("TÜFE ayı henüz açıklanmadı; son ay kullanıldı")}>≈</span>}
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

function IncomeCard({
  income,
  pending,
  categories,
  periodLabel,
  money,
  onChange,
}: {
  income: InvestmentIncome;
  /** Kaydedilmekte olan seçim (rapor yenilenene kadar düğmeler bunu gösterir) */
  pending: string[] | null | undefined;
  categories: Category[];
  periodLabel: string;
  money: (c: number | null) => string;
  onChange(ids: string[]): void;
}) {
  const { formatMoney } = useSettings();
  const incomeCats = categories.filter((c) => c.type === "income");
  const chosen = new Set(pending ?? income.categoryIds);
  const nameOf = (id: string) => categories.find((c) => c.id === id)?.name ?? t("Silinmiş kategori");
  const toggle = (id: string) => onChange(incomeCats.filter((c) => (c.id === id ? !chosen.has(c.id) : chosen.has(c.id))).map((c) => c.id));
  return (
    <section className="card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{t("Yatırım geliri")}</h2>
        <span className="text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{money(income.totalCents)}</span>
      </div>
      <p className="text-xs text-zinc-500">{t("Faiz, temettü ve fon dağıtımı ({period}); seçili gelir kategorilerindeki işlemler.", { period: periodLabel })}</p>
      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label={t("Yatırım geliri kategorileri")}>
        {incomeCats.map((c) => (
          <button
            key={c.id}
            aria-pressed={chosen.has(c.id)}
            onClick={() => toggle(c.id)}
            className={`rounded-full border px-2.5 py-1 text-xs ${
              chosen.has(c.id)
                ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                : "border-zinc-200 text-zinc-500 dark:border-zinc-700"
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>
      {income.categoryIds.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">{t("Faiz, temettü ve fon gelirlerinin kaydedildiği gelir kategorisini seçin.")}</p>
      ) : income.months.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">{t("Bu dönemde seçili kategorilerde gelir yok.")}</p>
      ) : (
        <>
          <div className="mt-3 h-40">
            <ResponsiveContainer>
              <BarChart data={income.months.map((m) => ({ ay: monthLabel(m.month), tl: m.cents / 100 }))}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="ay" fontSize={11} />
                <YAxis fontSize={11} width={70} tickFormatter={(v: number) => formatMoney(v)} />
                <Tooltip formatter={(v: number) => formatMoney(v)} />
                <Bar dataKey="tl" name={t("Gelir")} fill="#10b981" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {income.byCategory.length > 1 && (
            <ul className="mt-2 space-y-1 text-xs">
              {income.byCategory.map((c) => (
                <li key={c.categoryId} className="flex justify-between">
                  <span className="text-zinc-500">{nameOf(c.categoryId)}</span>
                  <span className="tabular-nums">{money(c.cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
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
  if (rows.length === 0) return <p className="card p-4 text-sm text-zinc-500">{t("Döviz ya da altın hesabı yok.")}</p>;
  return (
    <section className="card overflow-x-auto p-0">
      <h2 className="border-b border-zinc-100 px-4 py-2 text-sm font-semibold dark:border-zinc-800">{t("Elimdekiler")}</h2>
      <table className="w-full text-sm tabular-nums">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="px-4 py-2 text-left font-medium">{t("Hesap")}</th>
            <th className="px-2 py-2 text-right font-medium">{t("Miktar")}</th>
            <th className="px-2 py-2 text-right font-medium">{t("Ort. maliyet")}</th>
            <th className="px-2 py-2 text-right font-medium">{t("Güncel alış")}</th>
            <th className="px-2 py-2 text-right font-medium">{t("Değer")}</th>
            <th className="px-2 py-2 text-right font-medium">{t("Kâr/zarar")}</th>
            {cpiOk && <th className="px-4 py-2 text-right font-medium">{t("Reel")}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const warn = [
              a.costUnknown && t("Maliyet bilinmiyor: açılış maliyetini hesap formundan girin"),
              a.inconsistentSince && t("Kayıtlar tutarsız: {date} tarihinde eldekinden fazla çıkış", { date: formatDate(a.inconsistentSince) }),
              a.noRate && t("Kur alınamadı"),
              a.rateStale && t("Kur eski"),
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
                <td className="px-2 py-2 text-right">{formatQty(a.qty, a.currency)}</td>
                <td className="px-2 py-2 text-right">{a.avgCostMicros === null ? "—" : avgFmt.format(a.avgCostMicros / 1e6)}</td>
                <td className="px-2 py-2 text-right">{a.rateMicros === null ? "—" : formatRate(a.rateMicros / 1e6)}</td>
                <td className="px-2 py-2 text-right">{money(a.valueCents)}</td>
                <td className={`px-2 py-2 text-right ${tone(a.unrealizedCents)}`}>
                  {signed(a.unrealizedCents)} {a.unrealizedBp !== null && <span className="text-xs">{pct(a.unrealizedBp)}</span>}
                </td>
                {cpiOk && (
                  <td className={`px-4 py-2 text-right ${tone(a.realUnrealizedCents)}`}>
                    {signed(a.realUnrealizedCents)} {a.realUnrealizedBp !== null && <span className="text-xs">{pct(a.realUnrealizedBp)}</span>}
                    {a.cpiApprox && <span title={t("TÜFE ayı henüz açıklanmadı; son ay kullanıldı")}>≈</span>}
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
