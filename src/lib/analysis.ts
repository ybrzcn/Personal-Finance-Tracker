import { norm } from "./csv";
import { daysBetween, parseISODate, toISODate } from "./format";
import { merchantName, topMerchants, type MerchantRow } from "./stats";
import type { AnalysisSettings, Budget, Category, SubscriptionPeriod, Transaction } from "./types";

// ---------------------------------------------------------------------------
// Abonelikler
// ---------------------------------------------------------------------------

export interface Subscription {
  /** Kalıcı anahtar (düzeltmeler bununla saklanır): harcama yeri + ilk ödeme tutarı */
  key: string;
  name: string;
  /** Ekstredeki açıklama (düzenlenmemiş ad) */
  merchant: string;
  period: SubscriptionPeriod;
  /** Ödeme aralığından bulunan dönem (kullanıcı değiştirmediyse geçerli olan) */
  detectedPeriod: SubscriptionPeriod;
  lastAmount: number;
  lastDate: string;
  /** Bir sonraki beklenen ödeme */
  nextDate: string;
  monthlyCost: number;
  yearlyCost: number;
  count: number;
  totalPaid: number;
  accountId: string;
  /** active: düzenli; late: beklenen ödeme uzun süredir görülmedi; cancelled: kullanıcı iptal etti */
  status: "active" | "late" | "cancelled";
}

/** Fiyat değişimi ya da kur farkı bu oranın altındaysa aynı abonelik sayılır (Apple'ın iki ayrı planı ayrılsın). */
const SAME_PLAN_TOLERANCE = 0.07;
/** Beklenen ödemeden bu kadar gün sonra hâlâ görülmediyse "gecikti" (ekstreler geç yüklenebildiği için geniş) */
const LATE_GRACE_DAYS = 40;

export const isSubscriptionCategory = (c: Category) => c.type === "expense" && norm(c.name).startsWith("abonelik");

function addMonths(iso: string, months: number): string {
  const d = parseISODate(iso);
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, last));
  return toISODate(target);
}

/**
 * Ekstre açıklamasından okunur abonelik adı: kod parçaları ve yinelenen kelimeler atılır
 * ("GOOGLE *GOOGLE ONE" → "Google One", "MUZIK ABONELIK X12AB34CD" → "Muzik Abonelik").
 */
function displayName(description: string): string {
  const words = description
    .replace(/\*/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^\d{4,}$/.test(w) && !(w.length >= 6 && /\d/.test(w) && /[a-zçğıöşü]/i.test(w)))
    .filter((w, i, all) => i === 0 || w.toLocaleUpperCase("tr") !== all[i - 1].toLocaleUpperCase("tr"))
    .slice(0, 3);
  // Türkçe harf yoksa (NETFLIX, GITHUB) İngilizce kurallarla küçültülür: "I" → "i", "ı" değil
  const locale = /[ÇĞİÖŞÜçğıöşü]/.test(description) ? "tr" : "en";
  return words
    .map((w) => w.charAt(0).toLocaleUpperCase(locale) + w.slice(1).toLocaleLowerCase(locale))
    .join(" ");
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Abonelikler kategorisindeki giderlerden abonelik listesi. Aynı harcama yerinden farklı tutarlı düzenli ödemeler
 * (ör. iki ayrı Apple planı) ayrı abonelik sayılır; tutarı az oynayanlar (kur farkı) aynı aboneliktir.
 */
export function detectSubscriptions(
  txs: Transaction[],
  categories: Category[],
  overrides: AnalysisSettings["subscriptionOverrides"],
  today: string,
): Subscription[] {
  const subIds = new Set(categories.filter(isSubscriptionCategory).map((c) => c.id));
  const charges = txs
    .filter((t) => t.type === "expense" && t.categoryId && subIds.has(t.categoryId))
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));

  // Harcama yeri → tutarına göre kümeler
  const groups = new Map<string, { merchant: string; description: string; clusters: Transaction[][] }>();
  for (const t of charges) {
    const merchant = merchantName(t.description);
    const mkey = merchant.toLocaleUpperCase("tr");
    const g = groups.get(mkey) ?? { merchant, description: t.description, clusters: [] };
    const cluster = g.clusters.find((c) => {
      const last = c[c.length - 1].amount;
      return Math.abs(t.amount - last) <= last * SAME_PLAN_TOLERANCE;
    });
    if (cluster) cluster.push(t);
    else g.clusters.push([t]);
    groups.set(mkey, g);
  }

  const out: Subscription[] = [];
  for (const [mkey, g] of groups) {
    for (const c of g.clusters) {
      const key = `${mkey}@${Math.round(c[0].amount)}`;
      const o = overrides[key] ?? {};
      const last = c[c.length - 1];
      const gaps = c.slice(1).map((t, i) => daysBetween(c[i].date, t.date));
      const detectedPeriod: SubscriptionPeriod = gaps.length && median(gaps) >= 300 ? "yearly" : "monthly";
      const period = o.period ?? detectedPeriod;
      const nextDate = addMonths(last.date, period === "yearly" ? 12 : 1);
      const yearlyCost = period === "yearly" ? last.amount : last.amount * 12;
      const status = o.cancelled ? "cancelled" : daysBetween(nextDate, today) > LATE_GRACE_DAYS ? "late" : "active";
      out.push({
        key,
        name: o.name || displayName(g.description) || g.merchant,
        merchant: g.description,
        period,
        detectedPeriod,
        lastAmount: last.amount,
        lastDate: last.date,
        nextDate,
        monthlyCost: round2(yearlyCost / 12),
        yearlyCost: round2(yearlyCost),
        count: c.length,
        totalPaid: round2(c.reduce((s, t) => s + t.amount, 0)),
        accountId: last.accountId,
        status,
      });
    }
  }
  const rank = { active: 0, late: 1, cancelled: 2 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.yearlyCost - a.yearlyCost);
}

// ---------------------------------------------------------------------------
// Değişken gider tahmini
// ---------------------------------------------------------------------------

export const DEFAULT_FORECAST_CATEGORIES = ["Eğlence", "Restoran", "Kafe", "Market"];

export function forecastCategoryIds(categories: Category[], selected: string[] | null): string[] {
  if (selected) return selected.filter((id) => categories.some((c) => c.id === id));
  const wanted = DEFAULT_FORECAST_CATEGORIES.map(norm);
  return categories.filter((c) => c.type === "expense" && wanted.includes(norm(c.name))).map((c) => c.id);
}

export interface MonthTotal {
  /** YYYY-MM */
  month: string;
  total: number;
  count: number;
}

export interface CategoryForecast {
  category: Category;
  /** Tahmine giren tamamlanmış aylar (en fazla son 3) */
  basis: MonthTotal[];
  /** Grafikte gösterilen tamamlanmış aylar (en fazla son 6) */
  history: MonthTotal[];
  /** Aylık tahmin: tamamlanmış ayların ortalaması; geçmiş yoksa bu ayın gidişatı */
  monthly: number;
  yearly: number;
  /** Tahmin bu ayın gidişatından mı (geçmiş ay yok) */
  fromRunRate: boolean;
  spentThisMonth: number;
  countThisMonth: number;
  /** Bu ayın beklenen sonu: harcanan + kalan günler için ortalama günlük harcama */
  projectedMonthEnd: number;
  /** Ortalama işlem tutarı ve ayda işlem sayısı (tahmine giren aylardan) */
  avgTicket: number | null;
  perMonthCount: number | null;
  topMerchants: MerchantRow[];
  budget: number | null;
}

export interface ForecastResult {
  /** Tamamlanmış ay sayısı (tahminin dayandığı veri) */
  monthsOfData: number;
  items: CategoryForecast[];
  monthlyTotal: number;
  yearlyTotal: number;
}

const ym = (iso: string) => iso.slice(0, 7);

function shiftYm(month: string, delta: number): string {
  const d = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Tamamlanmış aylar: takibin başladığı aydan (ilk işlem ayın ilk haftasındaysa o ay da sayılır) geçen aya kadar.
 */
export function completeMonths(txs: Transaction[], today: string): string[] {
  const first = txs.reduce<string | null>((min, t) => (t.type === "expense" && (!min || t.date < min) ? t.date : min), null);
  if (!first) return [];
  let m = Number(first.slice(8, 10)) <= 7 ? ym(first) : shiftYm(ym(first), 1);
  const out: string[] = [];
  const current = ym(today);
  while (m < current) {
    out.push(m);
    m = shiftYm(m, 1);
  }
  return out;
}

/** Seçili kategoriler için aylık/yıllık harcama tahmini (harcama tarihine göre). */
export function forecastCategories(
  txs: Transaction[],
  categories: Category[],
  categoryIds: string[],
  budgets: Budget[],
  today: string,
): ForecastResult {
  const months = completeMonths(txs, today);
  const basisMonths = months.slice(-3);
  const historyMonths = months.slice(-6);
  const current = ym(today);
  const d = parseISODate(today);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const day = d.getDate();

  const items: CategoryForecast[] = [];
  for (const id of categoryIds) {
    const category = categories.find((c) => c.id === id);
    if (!category) continue;
    const own = txs.filter((t) => t.type === "expense" && t.categoryId === id);
    const byMonth = new Map<string, MonthTotal>();
    for (const t of own) {
      const m = ym(t.date);
      const row = byMonth.get(m) ?? { month: m, total: 0, count: 0 };
      row.total = round2(row.total + t.amount);
      row.count++;
      byMonth.set(m, row);
    }
    const pick = (m: string) => byMonth.get(m) ?? { month: m, total: 0, count: 0 };
    const basis = basisMonths.map(pick);
    const history = historyMonths.map(pick);
    const now = pick(current);

    const fromRunRate = basis.length === 0;
    const avg = fromRunRate ? (now.total / day) * daysInMonth : basis.reduce((s, b) => s + b.total, 0) / basis.length;
    const projectedMonthEnd = fromRunRate ? avg : now.total + (avg * (daysInMonth - day)) / daysInMonth;
    const basisCount = basis.reduce((s, b) => s + b.count, 0);
    const basisTotal = basis.reduce((s, b) => s + b.total, 0);

    const recent = new Set([...basisMonths, current]);
    items.push({
      category,
      basis,
      history,
      monthly: round2(avg),
      yearly: round2(avg * 12),
      fromRunRate,
      spentThisMonth: now.total,
      countThisMonth: now.count,
      projectedMonthEnd: round2(projectedMonthEnd),
      avgTicket: basisCount ? round2(basisTotal / basisCount) : null,
      perMonthCount: basis.length ? Math.round((basisCount / basis.length) * 10) / 10 : null,
      topMerchants: topMerchants(own.filter((t) => recent.has(ym(t.date))), 3),
      budget: budgets.find((b) => b.categoryId === id)?.amount ?? null,
    });
  }
  items.sort((a, b) => b.monthly - a.monthly);
  const monthlyTotal = round2(items.reduce((s, i) => s + i.monthly, 0));
  return { monthsOfData: basisMonths.length, items, monthlyTotal, yearlyTotal: round2(monthlyTotal * 12) };
}
