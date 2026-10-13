import { AlertTriangle, Coffee, Pencil, Repeat, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { CategoryDot, EmptyState, PageHeader, Segmented, TILE_TONES, type TileTone } from "../components/common";
import { Modal } from "../components/Modal";
import {
  DEFAULT_FORECAST_CATEGORIES,
  detectSubscriptions,
  forecastCategories,
  forecastCategoryIds,
  type CategoryForecast,
  type Subscription,
} from "../lib/analysis";
import { errorMessage } from "../lib/api";
import { norm } from "../lib/csv";
import { formatDateShort, formatMonthShort, parseISODate, todayISO } from "../lib/format";
import { matchesCategoryRule } from "../lib/statementImport";
import type { SubscriptionOverride, SubscriptionPeriod } from "../lib/types";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

const PERIODS: { value: SubscriptionPeriod; label: string }[] = [
  { value: "monthly", label: "Aylık" },
  { value: "yearly", label: "Yıllık" },
];

const monthLabel = (ym: string) => formatMonthShort(parseISODate(`${ym}-01`));

export function AnalysisPage() {
  const { transactions, categories, budgets } = useData();
  const { settings } = useSettings();
  const today = todayISO();

  const subscriptions = useMemo(
    () => detectSubscriptions(transactions, categories, settings.subscriptionOverrides, today),
    [transactions, categories, settings.subscriptionOverrides, today],
  );
  const selectedIds = useMemo(() => forecastCategoryIds(categories, settings.forecastCategoryIds), [categories, settings.forecastCategoryIds]);
  const forecast = useMemo(
    () => forecastCategories(transactions, categories, selectedIds, budgets, today),
    [transactions, categories, selectedIds, budgets, today],
  );

  return (
    <>
      <PageHeader title="Analiz" subtitle="Aboneliklerin ve değişken giderlerin aylık / yıllık maliyeti ve tahmini" />
      <CafeSuggestion />
      <div className="space-y-4">
        <SubscriptionsCard items={subscriptions} />
        <ForecastCard result={forecast} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

/** Kafe kategorisi açıldıktan sonra Restoran'da (veya kategorisiz) kalmış kahve harcamalarını taşımayı önerir. */
function CafeSuggestion() {
  const { transactions, categories, updateTransaction } = useData();
  const { toast } = useUI();
  const [busy, setBusy] = useState(false);
  const cafe = categories.find((c) => c.type === "expense" && norm(c.name) === "kafe");
  const restaurant = categories.find((c) => c.type === "expense" && norm(c.name) === "restoran");
  const candidates = useMemo(
    () =>
      cafe
        ? transactions.filter(
            (t) =>
              t.type === "expense" &&
              (t.categoryId === null || t.categoryId === restaurant?.id) &&
              matchesCategoryRule(t.description, "Kafe"),
          )
        : [],
    [transactions, cafe, restaurant],
  );
  if (!cafe || candidates.length === 0) return null;

  const names = [...new Set(candidates.map((t) => t.description.split(/\s+/)[0]))].slice(0, 3).join(", ");
  const move = async () => {
    setBusy(true);
    try {
      for (const t of candidates) await updateTransaction({ ...t, categoryId: cafe.id });
      toast(`${candidates.length} işlem Kafe kategorisine taşındı.`);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card mb-4 flex flex-wrap items-center gap-3 p-4">
      <Coffee size={18} className="shrink-0 text-amber-700 dark:text-amber-500" />
      <p className="min-w-0 flex-1 text-sm">
        <strong>{candidates.length} işlem</strong> kafe harcamasına benziyor ({names}). Kafe kategorisine taşınsın mı? Sonraki ekstrelerde bu yerler
        otomatik Kafe olarak gelir.
      </p>
      <button className="btn-primary shrink-0" disabled={busy} onClick={() => void move()}>
        Kafe'ye taşı
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SubscriptionsCard({ items }: { items: Subscription[] }) {
  const { formatMoney } = useSettings();
  const { accountById } = useData();
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  const live = items.filter((s) => s.status !== "cancelled");
  const cancelled = items.filter((s) => s.status === "cancelled");
  const monthly = live.reduce((s, x) => s + x.monthlyCost, 0);
  const yearly = live.reduce((s, x) => s + x.yearlyCost, 0);
  const visible = showCancelled ? items : live;

  return (
    <section className="card p-5" aria-labelledby="subs-title">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <h2 id="subs-title" className="text-sm font-semibold">
            Abonelikler {live.length > 0 && <span className="font-normal text-zinc-500">· {live.length} aktif</span>}
          </h2>
          <p className="text-xs text-zinc-500">Abonelikler kategorisindeki ödemelerden bulunur; kaçanları işlemde kategorisini değiştirerek ekleyebilirsin.</p>
        </div>
        {live.length > 0 && (
          <div className="flex gap-2">
            <Stat label="Aylık" value={formatMoney(monthly)} />
            <Stat label="Yıllık" value={formatMoney(yearly)} strong tone="info" />
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="Henüz abonelik yok"
          hint="Netflix, Spotify, iCloud gibi ödemeleri Abonelikler kategorisine aldığında burada yıllık maliyetleriyle listelenir."
        />
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm md:min-w-[640px]">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
                  <th className="py-2 pr-3 font-medium">Abonelik</th>
                  <th className="hidden py-2 pr-3 font-medium md:table-cell">Son ödeme</th>
                  <th className="hidden py-2 pr-3 font-medium md:table-cell">Sonraki</th>
                  <th className="hidden py-2 pr-3 text-right font-medium sm:table-cell">Aylık</th>
                  <th className="py-2 pr-3 text-right font-medium">Yıllık</th>
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
                            {s.period === "yearly" ? "Yıllık" : "Aylık"}
                          </span>
                          {s.status === "late" && (
                            <span
                              className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                              title="Beklenen ödeme uzun süredir görülmedi. İptal ettiysen düzenleyip işaretle."
                            >
                              <AlertTriangle size={11} /> Ödeme görülmedi
                            </span>
                          )}
                          {dim && <span className="text-[11px] text-zinc-500">İptal edildi</span>}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {account?.name ?? "Silinmiş hesap"} · {s.count} ödeme, toplam {formatMoney(s.totalPaid)}
                        </div>
                        {/* Telefonda gizlenen sütunlar */}
                        <div className="text-xs text-zinc-500 md:hidden">
                          Son {formatMoney(s.lastAmount)} {formatDateShort(s.lastDate)}
                          {!dim && ` · sonraki ${formatDateShort(s.nextDate)}`}
                          <span className="sm:hidden"> · ayda {formatMoney(s.monthlyCost)}</span>
                        </div>
                      </td>
                      <td className="hidden py-2.5 pr-3 tabular-nums md:table-cell">
                        {formatMoney(s.lastAmount)} <span className="text-xs text-zinc-500">{formatDateShort(s.lastDate)}</span>
                      </td>
                      <td className="hidden py-2.5 pr-3 text-zinc-600 tabular-nums md:table-cell dark:text-zinc-300">{dim ? "—" : formatDateShort(s.nextDate)}</td>
                      <td className="hidden py-2.5 pr-3 text-right tabular-nums sm:table-cell">{formatMoney(s.monthlyCost)}</td>
                      <td className="py-2.5 pr-3 text-right font-semibold tabular-nums">{formatMoney(s.yearlyCost)}</td>
                      <td className="py-2.5 text-right">
                        <button className="icon-btn" aria-label={`${s.name} aboneliğini düzenle`} title="Düzenle" onClick={() => setEditing(s)}>
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
            <span>Tutarlar son ödemeden hesaplanır; dövizli aboneliklerde kura göre değişir.</span>
            {cancelled.length > 0 && (
              <button className="btn-ghost -my-1 px-2 py-1 text-xs" onClick={() => setShowCancelled((v) => !v)}>
                {showCancelled ? "İptal edilenleri gizle" : `İptal edilenleri göster (${cancelled.length})`}
              </button>
            )}
          </div>
        </>
      )}
      {editing && <SubscriptionEditor sub={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function SubscriptionEditor({ sub, onClose }: { sub: Subscription; onClose(): void }) {
  const { settings, update } = useSettings();
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
    update({ subscriptionOverrides: next })
      .then(() => toast(o ? "Abonelik güncellendi." : "Abonelik otomatik bulunan haline döndü."))
      .catch((e) => toast(`Abonelik kaydedilemedi: ${errorMessage(e)}`, "error"));
  };

  return (
    <Modal
      title="Aboneliği düzenle"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost mr-auto" onClick={() => save(null)}>
            Varsayılana dön
          </button>
          <button className="btn-secondary" onClick={onClose}>
            Vazgeç
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
            Kaydet
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="sub-name">
            Ad
          </label>
          <input id="sub-name" className="input" placeholder={sub.merchant} value={name} onChange={(e) => setName(e.target.value)} />
          <p className="mt-1 text-xs text-zinc-500">Ekstredeki açıklama: {sub.merchant}</p>
        </div>
        <div>
          <span className="label">Ödeme sıklığı</span>
          <Segmented<SubscriptionPeriod> value={period} options={PERIODS} onChange={setPeriod} />
          <p className="mt-1 text-xs text-zinc-500">
            Yıllık abonelikte son ödeme tutarı bir yılın maliyeti sayılır ve aylık maliyeti 12'ye bölünür.
          </p>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={cancelled} onChange={(e) => setCancelled(e.target.checked)} />
          <span>
            İptal ettim
            <span className="block text-xs text-zinc-500">Toplamlara katılmaz; listede soluk görünür.</span>
          </span>
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function ForecastCard({ result }: { result: ReturnType<typeof forecastCategories> }) {
  const { formatMoney } = useSettings();
  const [choosing, setChoosing] = useState(false);
  const basisLabel =
    result.monthsOfData === 0
      ? "Henüz tamamlanmış ay yok; tahmin bu ayın gidişatından hesaplanır ve ay ilerledikçe netleşir."
      : `Son ${result.monthsOfData} tamamlanmış ayın ortalamasına dayanır${result.monthsOfData < 3 ? "; veri arttıkça tahmin iyileşir" : ""}.`;

  return (
    <section className="card p-5" aria-labelledby="fc-title">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <h2 id="fc-title" className="text-sm font-semibold">
            Değişken giderler · tahmin
          </h2>
          <p className="text-xs text-zinc-500">{basisLabel} Harcama tarihine göre hesaplanır.</p>
        </div>
        {result.items.length > 0 && (
          <div className="flex gap-2">
            <Stat label="Aylık tahmin" value={formatMoney(result.monthlyTotal)} />
            <Stat label="Yıllık tahmin" value={formatMoney(result.yearlyTotal)} strong tone="expense" />
          </div>
        )}
        <button className="btn-secondary" onClick={() => setChoosing(true)}>
          <SlidersHorizontal size={15} /> Kategoriler
        </button>
      </div>

      {result.items.length === 0 ? (
        <EmptyState icon={SlidersHorizontal} title="Tahmin edilecek kategori seçilmedi" hint="Kategoriler düğmesinden seç." />
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {result.items.map((f) => (
            <ForecastItem key={f.category.id} f={f} />
          ))}
        </div>
      )}
      {choosing && <ForecastCategoryPicker onClose={() => setChoosing(false)} />}
    </section>
  );
}

function ForecastItem({ f }: { f: CategoryForecast }) {
  const { formatMoney } = useSettings();
  const max = Math.max(...f.history.map((h) => h.total), f.spentThisMonth, f.projectedMonthEnd, 1);
  const overBudget = f.budget !== null && f.projectedMonthEnd > f.budget;

  return (
    <div className="flex flex-col rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-baseline gap-2">
        <CategoryDot color={f.category.color} size={10} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{f.category.name}</h3>
        <span className="text-xs text-zinc-500">yılda</span>
        <span className="text-base font-semibold tabular-nums">{formatMoney(f.yearly)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="tabular-nums">
          ayda ~<strong>{formatMoney(f.monthly)}</strong>
        </span>
        {f.avgTicket !== null && f.perMonthCount !== null && (
          <span className="text-xs text-zinc-500">
            · ayda ~{f.perMonthCount.toLocaleString("tr-TR")} işlem, ortalama {formatMoney(f.avgTicket)}
          </span>
        )}
        {f.fromRunRate && <span className="text-xs text-zinc-500">· bu ayın gidişatından</span>}
      </div>

      {/* Aylık harcama çubukları: tamamlanmış aylar + bu ay (dolu: harcanan, açık: beklenen ay sonu) */}
      <div className="mt-3 flex h-16 items-end gap-1.5" aria-hidden>
        {f.history.map((h) => (
          <div key={h.month} className="flex flex-1 flex-col items-center gap-1" title={`${monthLabel(h.month)}: ${formatMoney(h.total)}`}>
            <div className="w-full rounded-t bg-zinc-300 dark:bg-zinc-600" style={{ height: `${(h.total / max) * 48}px` }} />
            <span className="text-[10px] text-zinc-500">{monthLabel(h.month)}</span>
          </div>
        ))}
        <div className="flex flex-1 flex-col items-center gap-1" title={`Bu ay: ${formatMoney(f.spentThisMonth)}, beklenen ${formatMoney(f.projectedMonthEnd)}`}>
          <div className="relative w-full" style={{ height: `${(f.projectedMonthEnd / max) * 48}px` }}>
            <div className="absolute inset-0 rounded-t border border-dashed opacity-60" style={{ borderColor: f.category.color }} />
            <div
              className="absolute inset-x-0 bottom-0 rounded-t"
              style={{ height: `${f.projectedMonthEnd > 0 ? (f.spentThisMonth / f.projectedMonthEnd) * 100 : 0}%`, backgroundColor: f.category.color }}
            />
          </div>
          <span className="text-[10px] font-medium text-zinc-600 dark:text-zinc-300">Bu ay</span>
        </div>
      </div>

      <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
        Bu ay şimdiye kadar <strong className="tabular-nums">{formatMoney(f.spentThisMonth)}</strong> ({f.countThisMonth} işlem); ay sonu beklentisi{" "}
        <strong className="tabular-nums">{formatMoney(f.projectedMonthEnd)}</strong>
        {f.budget !== null && (
          <>
            {" "}
            · limit {formatMoney(f.budget)}
            {overBudget && <span className="font-medium text-rose-600 dark:text-rose-400"> (aşabilir)</span>}
          </>
        )}
      </p>
      {f.topMerchants.length > 0 && (
        <p className="mt-1 truncate text-xs text-zinc-500" title={f.topMerchants.map((m) => m.name).join(", ")}>
          En çok: {f.topMerchants.map((m) => `${m.name} ${formatMoney(m.total)}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

function ForecastCategoryPicker({ onClose }: { onClose(): void }) {
  const { categories } = useData();
  const { settings, update: saveSettings } = useSettings();
  const { toast } = useUI();
  const update = (patch: Parameters<typeof saveSettings>[0]) =>
    void saveSettings(patch).catch((e) => toast(`Kategoriler kaydedilemedi: ${errorMessage(e)}`, "error"));
  const expense = categories.filter((c) => c.type === "expense");
  const [picked, setPicked] = useState(() => new Set(forecastCategoryIds(categories, settings.forecastCategoryIds)));
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Modal
      title="Tahmin edilecek kategoriler"
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
            Varsayılana dön
          </button>
          <button className="btn-secondary" onClick={onClose}>
            Vazgeç
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              update({ forecastCategoryIds: expense.filter((c) => picked.has(c.id)).map((c) => c.id) });
              onClose();
            }}
          >
            Kaydet
          </button>
        </>
      }
    >
      <p className="mb-3 text-xs text-zinc-500">Varsayılan: {DEFAULT_FORECAST_CATEGORIES.join(", ")}. Abonelikler ayrı bölümde izlenir.</p>
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
