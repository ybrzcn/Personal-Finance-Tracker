import { AlertTriangle, Coffee, Pencil, Repeat, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { CategoryDot, EmptyState, PageHeader, Segmented, TILE_TONES, type TileTone } from "../components/common";
import { Modal } from "../components/Modal";
import { api, errorMessage } from "../lib/api";
import { formatDateShort, formatMonthShort, parseISODate } from "../lib/format";
import type { AnalysisReport, CafeSuggestion as CafeSuggestionReport, Category, ForecastItem as ForecastRow, SubscriptionOverride, SubscriptionPeriod, SubscriptionRow } from "../lib/types";
import { useAnalysis } from "../state/analysis";
import { useData } from "../state/data";
import { useSettings, type Settings } from "../state/settings";
import { useUI } from "../state/ui";
import { locale, merchantName, t, tc, tm } from "../lib/i18n";
import { rich } from "../lib/rich";

const PERIODS: { value: SubscriptionPeriod; label: string }[] = [
  { value: "monthly", label: t("Aylık") },
  { value: "yearly", label: t("Yıllık") },
];

const monthLabel = (ym: string) => formatMonthShort(parseISODate(`${ym}-01`));

/** Tahmin seçicide gösterilen varsayılan kategori adları (seçim Rust'ta: `finans-core::analysis::forecast`) */
const DEFAULT_FORECAST_CATEGORIES = ["Eğlence", "Restoran", "Kafe", "Market"];

const MISSING_CATEGORY = { name: t("Kategori"), color: "#94a3b8" };

export function AnalysisPage() {
  const { report, error, refreshing, retry, save } = useAnalysis();
  const dim = refreshing ? "opacity-60 transition-opacity" : "transition-opacity";

  return (
    <>
      <PageHeader title={t("Analiz")} subtitle={t("Aboneliklerin ve değişken giderlerin aylık / yıllık maliyeti ve tahmini")} />
      {report?.cafeSuggestion && <CafeSuggestion suggestion={report.cafeSuggestion} />}
      {error ? (
        <div role="alert" className="card flex items-center justify-between gap-3 px-5 py-4 text-sm">
          <span className="text-rose-600 dark:text-rose-400">{t("Analiz alınamadı: {error}", { error: tm(error) })}</span>
          <button className="btn-secondary px-3 py-1.5 text-xs" onClick={retry}>
            {t("Tekrar dene")}
          </button>
        </div>
      ) : (
        <div className={`space-y-4 ${dim}`} aria-busy={refreshing}>
          <SubscriptionsCard report={report} busy={refreshing} save={save} />
          <ForecastCard report={report} busy={refreshing} save={save} />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/** Kafe kategorisi açıldıktan sonra Restoran'da (veya kategorisiz) kalmış kahve harcamalarını taşımayı önerir (hesap Rust'ta) */
function CafeSuggestion({ suggestion }: { suggestion: CafeSuggestionReport }) {
  const { transactions, reloadTransactions } = useData();
  const { toast } = useUI();
  const [busy, setBusy] = useState(false);
  const candidates = useMemo(() => {
    const ids = new Set(suggestion.transactionIds);
    return transactions.filter((t) => ids.has(t.id));
  }, [transactions, suggestion]);
  if (candidates.length === 0) return null;
  const cafe = { id: suggestion.categoryId };

  const names = suggestion.merchants.join(", ");
  const move = async () => {
    setBusy(true);
    try {
      for (const t of candidates) await api.updateTransaction({ ...t, categoryId: cafe.id });
      toast(t("{n} işlem Kafe kategorisine taşındı.", { n: candidates.length }));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      // Liste sonda bir kez (yarıda kalsa da) yeniden okunur
      await reloadTransactions().catch(() => {});
      setBusy(false);
    }
  };

  return (
    <div className="card mb-4 flex flex-wrap items-center gap-3 p-4">
      <Coffee size={18} className="shrink-0 text-amber-700 dark:text-amber-500" />
      <p className="min-w-0 flex-1 text-sm">
        <strong>{t("{n} işlem", { n: candidates.length })}</strong>{" "}
        {t("kafe harcamasına benziyor ({names}). Kafe kategorisine taşınsın mı? Sonraki ekstrelerde bu yerler otomatik Kafe olarak gelir.", {
          n: candidates.length,
          names,
        })}
      </p>
      <button className="btn-primary shrink-0" disabled={busy} onClick={() => void move()}>
        {t("Kafe'ye taşı")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Ayar kaydı (rapor yeniden alınana kadar kartlar meşgul) */
type SaveSettings = (patch: Partial<Settings>) => Promise<void>;

function SubscriptionsCard({ report, busy, save }: { report: AnalysisReport | null; busy: boolean; save: SaveSettings }) {
  const { formatMoney: fmt } = useSettings();
  const formatMoney = (cents: number) => fmt(cents / 100);
  const { accountById } = useData();
  const [editing, setEditing] = useState<SubscriptionRow | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  const subs = report?.subscriptions;
  const items = subs?.items ?? [];
  const live = items.filter((s) => s.status !== "cancelled");
  const cancelled = items.filter((s) => s.status === "cancelled");
  const visible = showCancelled ? items : live;

  return (
    <section className="card p-5" aria-labelledby="subs-title">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <h2 id="subs-title" className="text-sm font-semibold">
            {t("Abonelikler")}{" "}
            {subs && subs.activeCount > 0 && <span className="font-normal text-zinc-500">· {t("{n} aktif", { n: subs.activeCount })}</span>}
          </h2>
          <p className="text-xs text-zinc-500">{t("Abonelikler kategorisindeki ödemelerden bulunur; kaçanları işlemde kategorisini değiştirerek ekleyebilirsin.")}</p>
        </div>
        {!subs ? (
          <div className="flex gap-2">
            <Stat label={t("Aylık")} value="…" />
            <Stat label={t("Yıllık")} value="…" strong tone="info" />
          </div>
        ) : (
          subs.activeCount > 0 && (
            <div className="flex gap-2">
              <Stat label={t("Aylık")} value={formatMoney(subs.monthlyCents)} />
              <Stat label={t("Yıllık")} value={formatMoney(subs.yearlyCents)} strong tone="info" />
            </div>
          )
        )}
      </div>

      {!subs ? null : items.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title={t("Henüz abonelik yok")}
          hint={t("Netflix, Spotify, iCloud gibi ödemeleri Abonelikler kategorisine aldığında burada yıllık maliyetleriyle listelenir.")}
        />
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm md:min-w-[640px]">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
                  <th className="py-2 pr-3 font-medium">{t("Abonelik")}</th>
                  <th className="hidden py-2 pr-3 font-medium md:table-cell">{tc("abonelik", "Son ödeme")}</th>
                  <th className="hidden py-2 pr-3 font-medium md:table-cell">{t("Sonraki")}</th>
                  <th className="hidden py-2 pr-3 text-right font-medium sm:table-cell">{t("Aylık")}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("Yıllık")}</th>
                  <th className="w-10 py-2" />
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => {
                  const account = accountById.get(s.accountId);
                  const dim = s.status === "cancelled";
                  return (
                    <tr key={s.key} className={`border-b border-zinc-100 last:border-0 dark:border-zinc-800/60 ${dim ? "opacity-50" : ""}`}>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 truncate font-medium">{s.name}</span>
                          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                            {s.period === "yearly" ? t("Yıllık") : t("Aylık")}
                          </span>
                          {s.status === "late" && (
                            <span
                              className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                              title={t("Beklenen ödeme uzun süredir görülmedi. İptal ettiysen düzenleyip işaretle.")}
                            >
                              <AlertTriangle size={11} /> {t("Ödeme görülmedi")}
                            </span>
                          )}
                          {dim && <span className="text-[11px] text-zinc-500">{t("İptal edildi")}</span>}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {account?.name ?? t("Silinmiş hesap")} · {t("{n} ödeme, toplam {total}", { n: s.count, total: formatMoney(s.totalPaidCents) })}
                        </div>
                        {/* Telefonda gizlenen sütunlar */}
                        <div className="text-xs text-zinc-500 md:hidden">
                          {t("Son {amount} {date}", { amount: formatMoney(s.lastAmountCents), date: formatDateShort(s.lastDate) })}
                          {!dim && ` · ${t("sonraki {date}", { date: formatDateShort(s.nextDate) })}`}
                          <span className="sm:hidden"> · {t("ayda {amount}", { amount: formatMoney(s.monthlyCents) })}</span>
                        </div>
                      </td>
                      <td className="hidden py-2.5 pr-3 tabular-nums md:table-cell">
                        {formatMoney(s.lastAmountCents)} <span className="text-xs text-zinc-500">{formatDateShort(s.lastDate)}</span>
                      </td>
                      <td className="hidden py-2.5 pr-3 text-zinc-600 tabular-nums md:table-cell dark:text-zinc-300">{dim ? "—" : formatDateShort(s.nextDate)}</td>
                      <td className="hidden py-2.5 pr-3 text-right tabular-nums sm:table-cell">{formatMoney(s.monthlyCents)}</td>
                      <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">{formatMoney(s.yearlyCents)}</td>
                      <td className="py-2.5 text-right">
                        <button className="icon-btn" aria-label={t("{name} aboneliğini düzenle", { name: s.name })} title={t("Düzenle")} disabled={busy} onClick={() => setEditing(s)}>
                          <Pencil size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
            <span>{t("Tutarlar son ödemeden hesaplanır; dövizli aboneliklerde kura göre değişir.")}</span>
            {cancelled.length > 0 && (
              <button className="btn-ghost -my-1 px-2 py-1 text-xs" onClick={() => setShowCancelled((v) => !v)}>
                {showCancelled ? t("İptal edilenleri gizle") : t("İptal edilenleri göster ({n})", { n: cancelled.length })}
              </button>
            )}
          </div>
        </>
      )}
      {editing && <SubscriptionEditor sub={editing} save={save} onClose={() => setEditing(null)} />}
    </section>
  );
}

function SubscriptionEditor({ sub, save: saveSettings, onClose }: { sub: SubscriptionRow; save: SaveSettings; onClose(): void }) {
  const { settings } = useSettings();
  const { toast } = useUI();
  const current = settings.subscriptionOverrides[sub.key] ?? {};
  const [name, setName] = useState(current.name ?? "");
  const [period, setPeriod] = useState<SubscriptionPeriod>(sub.period);
  const [cancelled, setCancelled] = useState(sub.status === "cancelled");

  const save = (o: SubscriptionOverride | null) => {
    const next = { ...settings.subscriptionOverrides };
    if (o && (o.name || o.period || o.cancelled)) next[sub.key] = o;
    else delete next[sub.key];
    onClose();
    saveSettings({ subscriptionOverrides: next })
      .then(() => toast(o ? t("Abonelik güncellendi.") : t("Abonelik otomatik bulunan haline döndü.")))
      .catch((e) => toast(t("Abonelik kaydedilemedi: {error}", { error: errorMessage(e) }), "error"));
  };

  return (
    <Modal
      title={t("Aboneliği düzenle")}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost mr-auto" onClick={() => save(null)}>
            {t("Varsayılana dön")}
          </button>
          <button className="btn-secondary" onClick={onClose}>
            {t("Vazgeç")}
          </button>
          <button
            className="btn-primary"
            onClick={() =>
              save({
                ...(name.trim() ? { name: name.trim() } : {}),
                ...(period !== sub.detectedPeriod ? { period } : {}),
                ...(cancelled ? { cancelled: true } : {}),
              })
            }
          >
            {t("Kaydet")}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="sub-name">
            {t("Ad")}
          </label>
          <input id="sub-name" className="input" placeholder={sub.merchant} value={name} onChange={(e) => setName(e.target.value)} />
          <p className="mt-1 text-xs text-zinc-500">{t("Ekstredeki açıklama: {merchant}", { merchant: sub.merchant })}</p>
        </div>
        <div>
          <span className="label">{t("Ödeme sıklığı")}</span>
          <Segmented<SubscriptionPeriod> value={period} options={PERIODS} onChange={setPeriod} />
          <p className="mt-1 text-xs text-zinc-500">
            {t("Yıllık abonelikte son ödeme tutarı bir yılın maliyeti sayılır ve aylık maliyeti 12'ye bölünür.")}
          </p>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={cancelled} onChange={(e) => setCancelled(e.target.checked)} />
          <span>
            {t("İptal ettim")}
            <span className="block text-xs text-zinc-500">{t("Toplamlara katılmaz; listede soluk görünür.")}</span>
          </span>
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function ForecastCard({ report, busy, save }: { report: AnalysisReport | null; busy: boolean; save: SaveSettings }) {
  const { formatMoney: fmt } = useSettings();
  const formatMoney = (cents: number) => fmt(cents / 100);
  const { categories } = useData();
  const [choosing, setChoosing] = useState(false);
  const result = report?.forecast;
  // Raporda olup listede henüz olmayan kategori (liste yenilenene kadar) gizlenmez: kartlar başlıktaki toplamla tutarlı kalsın
  const items = (result?.items ?? []).map((f) => ({ f, category: categories.find((c) => c.id === f.categoryId) ?? MISSING_CATEGORY }));
  const basisLabel = !result
    ? "…"
    : result.monthsOfData === 0
      ? t("Henüz tamamlanmış ay yok; tahmin bu ayın gidişatından hesaplanır ve ay ilerledikçe netleşir.")
      : result.monthsOfData < 3
        ? t("Son {n} tamamlanmış ayın ortalamasına dayanır; veri arttıkça tahmin iyileşir.", { n: result.monthsOfData })
        : t("Son {n} tamamlanmış ayın ortalamasına dayanır.", { n: result.monthsOfData });

  return (
    <section className="card p-5" aria-labelledby="fc-title">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <h2 id="fc-title" className="text-sm font-semibold">
            {t("Değişken giderler · tahmin")}
          </h2>
          <p className="text-xs text-zinc-500">{basisLabel} {t("Harcama tarihine göre hesaplanır.")}</p>
        </div>
        {!result ? (
          <div className="flex gap-2">
            <Stat label={t("Aylık tahmin")} value="…" />
            <Stat label={t("Yıllık tahmin")} value="…" strong tone="expense" />
          </div>
        ) : (
          result.items.length > 0 && (
            <div className="flex gap-2">
              <Stat label={t("Aylık tahmin")} value={formatMoney(result.monthlyCents)} />
              <Stat label={t("Yıllık tahmin")} value={formatMoney(result.yearlyCents)} strong tone="expense" />
            </div>
          )
        )}
        <button className="btn-secondary" disabled={!result || busy} onClick={() => setChoosing(true)}>
          <SlidersHorizontal size={15} /> {t("Kategoriler")}
        </button>
      </div>

      {!result ? null : result.items.length === 0 ? (
        <EmptyState icon={SlidersHorizontal} title={t("Tahmin edilecek kategori seçilmedi")} hint={t("Kategoriler düğmesinden seç.")} />
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {items.map(({ f, category }) => (
            <ForecastItem key={f.categoryId} f={f} category={category} />
          ))}
        </div>
      )}
      {choosing && result && <ForecastCategoryPicker selected={result.selectedCategoryIds} save={save} onClose={() => setChoosing(false)} />}
    </section>
  );
}

function ForecastItem({ f, category }: { f: ForecastRow; category: Pick<Category, "name" | "color"> }) {
  const { formatMoney: fmt } = useSettings();
  const formatMoney = (cents: number) => fmt(cents / 100);
  // Çubuk ölçeği (yalnız gösterim)
  const max = Math.max(...f.history.map((h) => h.totalCents), f.spentThisMonthCents, f.projectedMonthEndCents, 1);

  return (
    <div className="flex flex-col rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-baseline gap-2">
        <CategoryDot color={category.color} size={10} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{category.name}</h3>
        <span className="text-xs text-zinc-500">{t("yılda")}</span>
        <span className="text-base font-semibold tabular-nums">{formatMoney(f.yearlyCents)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="tabular-nums">
          {rich(t("ayda ~{amount}"), { amount: <strong>{formatMoney(f.monthlyCents)}</strong> })}
        </span>
        {f.avgTicketCents !== null && f.perMonthCount !== null && (
          <span className="text-xs text-zinc-500">
            · {t("ayda ~{count} işlem, ortalama {avg}", { count: f.perMonthCount.toLocaleString(locale), avg: formatMoney(f.avgTicketCents) })}
          </span>
        )}
        {f.fromRunRate && <span className="text-xs text-zinc-500">· {t("bu ayın gidişatından")}</span>}
      </div>

      {/* Aylık harcama çubukları: tamamlanmış aylar + bu ay (dolu: harcanan, açık: beklenen ay sonu) */}
      <div className="mt-3 flex h-16 items-end gap-1.5" aria-hidden>
        {f.history.map((h) => (
          <div key={h.month} className="flex flex-1 flex-col items-center gap-1" title={`${monthLabel(h.month)}: ${formatMoney(h.totalCents)}`}>
            <div className="w-full rounded-t bg-zinc-300 dark:bg-zinc-600" style={{ height: `${(h.totalCents / max) * 48}px` }} />
            <span className="text-[10px] text-zinc-500">{monthLabel(h.month)}</span>
          </div>
        ))}
        <div className="flex flex-1 flex-col items-center gap-1" title={t("Bu ay: {spent}, beklenen {projected}", { spent: formatMoney(f.spentThisMonthCents), projected: formatMoney(f.projectedMonthEndCents) })}>
          <div className="relative w-full" style={{ height: `${(f.projectedMonthEndCents / max) * 48}px` }}>
            <div className="absolute inset-0 rounded-t border border-dashed opacity-60" style={{ borderColor: category.color }} />
            <div
              className="absolute inset-x-0 bottom-0 rounded-t"
              style={{ height: `${f.projectedMonthEndCents > 0 ? (f.spentThisMonthCents / f.projectedMonthEndCents) * 100 : 0}%`, backgroundColor: category.color }}
            />
          </div>
          <span className="text-[10px] font-medium text-zinc-600 dark:text-zinc-300">{t("Bu ay")}</span>
        </div>
      </div>

      <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
        {rich(t("Bu ay şimdiye kadar {spent} ({count}); ay sonu beklentisi {projected}"), {
          spent: <strong className="tabular-nums">{formatMoney(f.spentThisMonthCents)}</strong>,
          count: t("{n} işlem", { n: f.countThisMonth }),
          projected: <strong className="tabular-nums">{formatMoney(f.projectedMonthEndCents)}</strong>,
        })}
        {f.budgetCents !== null && (
          <>
            {" "}
            · {t("limit {amount}", { amount: formatMoney(f.budgetCents) })}
            {f.overBudget && <span className="font-medium text-rose-600 dark:text-rose-400"> ({t("aşabilir")})</span>}
          </>
        )}
      </p>
      {f.topMerchants.length > 0 && (
        <p className="mt-1 truncate text-xs text-zinc-500" title={f.topMerchants.map((m) => merchantName(m.name)).join(", ")}>
          {t("En çok:")} {f.topMerchants.map((m) => `${merchantName(m.name)} ${formatMoney(m.totalCents)}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

function ForecastCategoryPicker({ selected, save: saveSettings, onClose }: { selected: string[]; save: SaveSettings; onClose(): void }) {
  const { categories } = useData();
  const { toast } = useUI();
  const update = (patch: Partial<Settings>) =>
    void saveSettings(patch).catch((e) => toast(t("Kategoriler kaydedilemedi: {error}", { error: errorMessage(e) }), "error"));
  const expense = categories.filter((c) => c.type === "expense");
  const [picked, setPicked] = useState(() => new Set(selected));
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Modal
      title={t("Tahmin edilecek kategoriler")}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn-ghost mr-auto"
            onClick={() => {
              update({ forecastCategoryIds: null });
              onClose();
            }}
          >
            {t("Varsayılana dön")}
          </button>
          <button className="btn-secondary" onClick={onClose}>
            {t("Vazgeç")}
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              update({ forecastCategoryIds: expense.filter((c) => picked.has(c.id)).map((c) => c.id) });
              onClose();
            }}
          >
            {t("Kaydet")}
          </button>
        </>
      }
    >
      <p className="mb-3 text-xs text-zinc-500">{t("Varsayılan: {names}. Abonelikler ayrı bölümde izlenir.", { names: DEFAULT_FORECAST_CATEGORIES.join(", ") })}</p>
      <ul className="grid grid-cols-2 gap-1">
        {expense.map((c) => (
          <li key={c.id}>
            <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
              <CategoryDot color={c.color} />
              {c.name}
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function Stat({ label, value, strong, tone = "plain" }: { label: string; value: string; strong?: boolean; tone?: TileTone }) {
  const t = TILE_TONES[tone];
  // Düz kutu, kartın içinde zemin renginde durur
  const box = tone === "plain" ? "bg-zinc-50 dark:bg-zinc-950" : t.box;
  return (
    <div className={`rounded-xl px-3.5 py-2 text-right ${box}`}>
      <div className={`text-xs font-medium ${t.label}`}>{label}</div>
      <div className={`tabular-nums ${strong ? "text-xl font-bold" : "text-lg font-semibold"}`}>{value}</div>
    </div>
  );
}
