import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, errorMessage } from "../lib/api";
import { addDays, todayISO } from "../lib/format";
import { formatRate, fundCode, GROUP_LABEL, INSTRUMENTS, isFund, type FxGroup } from "../lib/fx";
import type { RateQuote } from "../lib/types";
import { useData } from "../state/data";
import { useRates } from "../state/rates";
import { locale, t } from "../lib/i18n";

const time = (iso: string) => new Date(iso).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function RatesPage() {
  const { rates, loading, error, refresh } = useRates();
  const [open, setOpen] = useState<string | null>(null);
  const { accounts } = useData();
  const funds = [...new Set(accounts.filter((a) => !a.archived && isFund(a.currency)).map((a) => a.currency))].sort();
  const names = new Map(accounts.filter((a) => isFund(a.currency)).map((a) => [a.currency, a.name]));
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{t("Kurlar")}</h1>
        <button className="btn-secondary ml-auto gap-2 px-3 py-1.5 text-xs" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} /> {t("Yenile")}
        </button>
      </div>
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">{error}</p>}
      <p className="text-xs text-zinc-500">
        {t("Döviz: TCMB (iş günü 15:30). Altın ve gümüş: Harem Altın (15 dakikada bir). Fonlar: TEFAS (günde bir; resmî olmayan servis). Değerler 1 birimin TL fiyatıdır.")}
      </p>
      {(["doviz", "altin", "maden"] as FxGroup[]).map((g) => (
        <section key={g} className="card overflow-hidden p-0">
          <h2 className="border-b border-zinc-100 px-4 py-2 text-sm font-semibold dark:border-zinc-800">{GROUP_LABEL[g]}</h2>
          <table className="w-full text-sm tabular-nums">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{t("Ad")}</th>
                <th className="px-2 py-2 text-right font-medium">{t("Alış")}</th>
                <th className="px-2 py-2 text-right font-medium">{t("Satış")}</th>
                <th className="px-2 py-2 text-right font-medium">{t("Günlük")}</th>
                <th className="px-4 py-2 text-right font-medium">{t("Güncelleme")}</th>
              </tr>
            </thead>
            <tbody>
              {INSTRUMENTS.filter((i) => i.group === g).map((i) => {
                const q = rates.get(i.code);
                const change = q?.prevBuy ? ((q.buy - q.prevBuy) / q.prevBuy) * 100 : null;
                return [
                  <tr key={i.code} className="cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/40" onClick={() => setOpen(open === i.code ? null : i.code)}>
                    <td className="px-4 py-2">{i.name}</td>
                    <td className="px-2 py-2 text-right">{q ? formatRate(q.buy) : "—"}</td>
                    <td className="px-2 py-2 text-right">{q ? formatRate(q.sell) : "—"}</td>
                    <td className={`px-2 py-2 text-right ${change === null ? "text-zinc-400" : change >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                      {change === null ? "—" : `${change >= 0 ? "+" : ""}${change.toLocaleString(locale, { maximumFractionDigits: 2 })}%`}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-zinc-500">
                      {q ? (
                        <span className="inline-flex items-center gap-1">
                          {q.stale && <AlertTriangle size={12} className="text-amber-500" aria-label={t("Kur eski")} />}
                          {time(q.observedAt)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>,
                  open === i.code && (
                    <tr key={`${i.code}-h`}>
                      <td colSpan={5} className="px-4 pb-4">
                        <History code={i.code} />
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </section>
      ))}
      {funds.length > 0 && (
        <section className="card overflow-hidden p-0">
          <h2 className="border-b border-zinc-100 px-4 py-2 text-sm font-semibold dark:border-zinc-800">{t("Fonlarım")}</h2>
          <table className="w-full text-sm tabular-nums">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{t("Fon")}</th>
                <th className="px-2 py-2 text-right font-medium">{t("Fiyat")}</th>
                <th className="px-2 py-2 text-right font-medium">{t("Günlük")}</th>
                <th className="px-4 py-2 text-right font-medium">{t("Fiyat günü")}</th>
              </tr>
            </thead>
            <tbody>
              {funds.map((code) => {
                const q = rates.get(code);
                const change = q?.prevBuy ? ((q.buy - q.prevBuy) / q.prevBuy) * 100 : null;
                return [
                  <tr
                    key={code}
                    className="cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/40"
                    onClick={() => setOpen(open === code ? null : code)}
                  >
                    <td className="px-4 py-2">
                      {names.get(code) ?? fundCode(code)}
                    </td>
                    <td className="px-2 py-2 text-right">{q ? formatRate(q.buy) : "—"}</td>
                    <td className={`px-2 py-2 text-right ${change === null ? "text-zinc-400" : change >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                      {change === null ? "—" : `${change >= 0 ? "+" : ""}${change.toLocaleString(locale, { maximumFractionDigits: 2 })}%`}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-zinc-500">
                      {q ? (
                        <span className="inline-flex items-center gap-1">
                          {q.stale && <AlertTriangle size={12} className="text-amber-500" aria-label={t("Fiyat eski")} />}
                          {q.observedAt.slice(0, 10)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>,
                  open === code && (
                    <tr key={`${code}-h`}>
                      <td colSpan={4} className="px-4 pb-4">
                        <History code={code} />
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function History({ code }: { code: string }) {
  const [points, setPoints] = useState<RateQuote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const today = todayISO();
    api
      .rateHistory(code, addDays(today, -90), today)
      .then(setPoints)
      .catch((e) => setError(errorMessage(e)));
  }, [code]);
  if (error) return <p className="text-xs text-zinc-500">{error}</p>;
  if (!points) return <p className="text-xs text-zinc-500">{t("Yükleniyor…")}</p>;
  if (points.length < 2) return <p className="text-xs text-zinc-500">{t("Grafik için henüz yeterli geçmiş yok.")}</p>;
  const data = points.map((p) => ({ t: p.observedAt.slice(0, 10), alis: p.buy }));
  return (
    <div className="h-48">
      <ResponsiveContainer>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis dataKey="t" fontSize={11} />
          <YAxis domain={["auto", "auto"]} fontSize={11} width={70} tickFormatter={(v: number) => formatRate(v)} />
          <Tooltip formatter={(v: number) => formatRate(v)} />
          <Line type="stepAfter" dataKey="alis" name={t("Alış")} stroke="#6366f1" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
