import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, type LucideIcon } from "lucide-react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { formatAmountInput, formatDate } from "../lib/format";
import { UNCATEGORIZED } from "../lib/stats";
import type { Account, Category, Transaction } from "../lib/types";
import { useSettings } from "../state/settings";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Özet kutusu renkleri: net mavi, gelir/olumlu yeşil, gider/borç somon, bilgi açık mavi, düz beyaz kart */
export type TileTone = "plain" | "net" | "income" | "expense" | "info";
export const TILE_TONES: Record<TileTone, { box: string; label: string; hint: string }> = {
  plain: { box: "bg-white dark:bg-zinc-900", label: "text-zinc-500", hint: "text-zinc-500" },
  net: { box: "bg-indigo-700 text-indigo-50 dark:bg-[#35597b]", label: "text-indigo-200", hint: "text-indigo-200" },
  income: { box: "bg-[#e1efe5] dark:bg-emerald-900", label: "text-emerald-800 dark:text-emerald-300", hint: "text-zinc-600 dark:text-zinc-400" },
  expense: { box: "bg-[#ffe3d8] dark:bg-[#4a2327]", label: "text-[#a33a12] dark:text-[#f29a9a]", hint: "text-zinc-600 dark:text-zinc-400" },
  info: { box: "bg-indigo-100 dark:bg-indigo-900", label: "text-indigo-700 dark:text-indigo-200", hint: "text-zinc-600 dark:text-zinc-400" },
};

/** Sayfa üstündeki küçük özet kutusu (Hesaplar, Bütçe, Ödeme Takvimi) */
export function SummaryTile({
  label,
  value,
  tone = "plain",
  hint,
  valueClass = "",
}: {
  label: string;
  value: string;
  tone?: TileTone;
  hint?: string | null;
  valueClass?: string;
}) {
  const t = TILE_TONES[tone];
  return (
    <div className={`min-w-0 rounded-2xl px-5 py-4 ${t.box}`}>
      <div className={`truncate text-[13px] font-semibold ${t.label}`}>{label}</div>
      <div className={`mt-1 whitespace-nowrap text-2xl font-bold tabular-nums tracking-tight ${valueClass}`}>{value}</div>
      {hint && (
        <div className={`mt-0.5 text-xs ${t.hint}`} title={hint}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, hint, action }: { icon: LucideIcon; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-800">
        <Icon size={22} />
      </div>
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-zinc-500">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function CategoryDot({ color, size = 8 }: { color: string; size?: number }) {
  return <span className="inline-block shrink-0 rounded-full" style={{ backgroundColor: color, width: size, height: size }} />;
}

export function CategoryLabel({ category }: { category?: Category }) {
  const c = category ?? { name: UNCATEGORIZED.name, color: UNCATEGORIZED.color };
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <CategoryDot color={c.color} />
      <span className={category ? "" : "italic text-zinc-400"}>{c.name}</span>
    </span>
  );
}

/** "Vadesiz" veya transferde "Vadesiz → Kredi Kartı" */
export function txAccountLabel(t: Pick<Transaction, "type" | "accountId" | "toAccountId">, accountById: Map<string, Account>): string {
  const name = (id: string | null) => (id && accountById.get(id)?.name) || "Silinmiş hesap";
  return t.type === "transfer" ? `${name(t.accountId)} → ${name(t.toAccountId)}` : name(t.accountId);
}

export function Amount({ tx, className = "" }: { tx: Pick<Transaction, "amount" | "type">; className?: string }) {
  const { formatMoney } = useSettings();
  const tone =
    tx.type === "income"
      ? "text-emerald-600 dark:text-emerald-400"
      : tx.type === "expense"
        ? "text-rose-600 dark:text-rose-400"
        : "text-zinc-700 dark:text-zinc-300";
  const sign = tx.type === "income" ? "+" : tx.type === "expense" ? "−" : "";
  return (
    <span className={`whitespace-nowrap font-semibold tabular-nums ${tone} ${className}`}>
      {sign}
      {formatMoney(tx.amount)}
    </span>
  );
}

/** Kompakt işlem satırı (Dashboard'daki son işlemler listesi için). */
export function TransactionItem({
  tx,
  category,
  accountLabel,
  onClick,
}: {
  tx: Transaction;
  category?: Category;
  accountLabel: string;
  onClick?(): void;
}) {
  const transfer = tx.type === "transfer";
  const color = transfer ? "#6366f1" : category?.color ?? UNCATEGORIZED.color;
  const Icon = transfer ? ArrowLeftRight : tx.type === "income" ? ArrowDownLeft : ArrowUpRight;
  const catName = category?.name ?? UNCATEGORIZED.name;
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full" style={{ backgroundColor: `${color}22`, color }}>
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{tx.description || (transfer ? "Transfer" : catName)}</span>
        <span className="block truncate text-xs text-zinc-500">
          {transfer ? "" : `${catName} · `}
          {accountLabel} · {formatDate(tx.date)}
        </span>
      </span>
      <Amount tx={tx} className="text-sm" />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange(v: T): void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Finans terimlerinin kısa açıklamaları (üzerine gelince görünür). */
export const TERMS = {
  KMH: "Kredili Mevduat Hesabı: vadesiz hesabın eksiye düşebildiği limit. Eksi bakiyeye günlük faiz işler.",
  KKDF: "Kaynak Kullanımını Destekleme Fonu: faizin %15'i kadar alınan yasal kesinti.",
  BSMV: "Banka ve Sigorta Muameleleri Vergisi: faizin %15'i kadar alınan vergi.",
  akdi: "Akdi faiz: ekstrenin tamamı ödenmezse kalan borca uygulanan aylık faiz oranı (vergiler hariç).",
  efektif: "Akdi faize KKDF (%15) ve BSMV (%15) eklenmiş, gerçekte ödenen aylık oran.",
  asgari: "Asgari ödeme: gecikmeye düşmemek için son ödeme gününe kadar ödenmesi gereken en az tutar. Kalan borca faiz işler.",
} as const;

/** Noktalı altı çizili terim; üzerine gelince açıklaması görünür. */
export function Term({ children, hint }: { children: ReactNode; hint: string }) {
  return (
    <abbr title={hint} className="cursor-help no-underline decoration-zinc-400 decoration-dotted underline-offset-2 [text-decoration-line:underline]">
      {children}
    </abbr>
  );
}

/**
 * Tutar alanı: solda ₺ öneki, alandan çıkınca binlik ayraçla biçimlenir ("62000" → "62.000,00").
 * Diğer input özellikleri (id, aria-*, className ...) aynen geçer.
 */
export function MoneyInput({
  value,
  onValueChange,
  className = "",
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: string; onValueChange(v: string): void }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-400" aria-hidden>
        ₺
      </span>
      <input
        {...rest}
        inputMode="decimal"
        autoComplete="off"
        className={`input pl-7 tabular-nums ${className}`}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onBlur={(e) => {
          onValueChange(formatAmountInput(value));
          rest.onBlur?.(e);
        }}
      />
    </div>
  );
}
