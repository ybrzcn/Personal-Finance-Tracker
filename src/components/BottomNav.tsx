import {
  ArrowLeftRight,
  Activity,
  ChartColumn,
  CalendarRange,
  Coins,
  TrendingUp,
  Landmark,
  LayoutDashboard,
  Menu,
  Monitor,
  Moon,
  PiggyBank,
  Target,
  Plus,
  Settings,
  Sun,
  Tag as TagIcon,
  Tags,
  Telescope,
  TrendingDown,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSettings, type ThemePref } from "../state/settings";
import { useUI, type Page } from "../state/ui";

const TABS: { page: Page; label: string; icon: typeof LayoutDashboard }[] = [
  { page: "dashboard", label: "Genel", icon: LayoutDashboard },
  { page: "transactions", label: "İşlemler", icon: ArrowLeftRight },
  { page: "budget", label: "Bütçe", icon: PiggyBank },
];

const MORE: { page: Page; label: string; icon: typeof LayoutDashboard }[] = [
  { page: "goals", label: "Hedefler", icon: Target },
  { page: "accounts", label: "Hesaplar", icon: Landmark },
  { page: "rates", label: "Kurlar", icon: Coins },
  { page: "pnl", label: "Kâr/Zarar", icon: TrendingUp },
  { page: "analysis", label: "Analiz", icon: Activity },
  { page: "reports", label: "Raporlar", icon: ChartColumn },
  { page: "plan", label: "Ödeme Takvimi", icon: CalendarRange },
  { page: "debt", label: "Borç Planı", icon: TrendingDown },
  { page: "projection", label: "Uzun Vade", icon: Telescope },
  { page: "categories", label: "Kategoriler", icon: Tags },
  { page: "tags", label: "Etiketler", icon: TagIcon },
  { page: "settings", label: "Ayarlar", icon: Settings },
];

const THEMES: { value: ThemePref; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: "Açık" },
  { value: "system", icon: Monitor, label: "Sistem" },
  { value: "dark", icon: Moon, label: "Koyu" },
];

/** Telefon genişliğinde (md altı) kenar çubuğunun yerine alt sekme çubuğu; diğer sayfalar "Daha fazla"da. */
export function BottomNav() {
  const { page, setPage, openTransactionForm } = useUI();
  const { settings, update } = useSettings();
  const [moreOpen, setMoreOpen] = useState(false);
  const inMore = MORE.some((m) => m.page === page);
  const sheetRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);

  // Açılınca ilk sayfaya odaklan, Esc ile kapat, kapanınca odak "Daha fazla"ya döner
  useEffect(() => {
    if (!moreOpen) return;
    sheetRef.current?.querySelector<HTMLElement>("button[aria-current], .grid button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMoreOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    const btn = moreBtnRef.current;
    return () => {
      window.removeEventListener("keydown", onKey);
      btn?.focus();
    };
  }, [moreOpen]);

  const go = (p: Page) => {
    setPage(p);
    setMoreOpen(false);
  };

  const tab = (active: boolean) =>
    `flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
      active ? "text-indigo-600 dark:text-indigo-400" : "text-zinc-500 dark:text-zinc-400"
    }`;

  return (
    <>
      {moreOpen && (
        <div className="fixed inset-0 z-[35] md:hidden" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-zinc-950/40" />
          <div
            ref={sheetRef}
            aria-modal="true"
            className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-zinc-200 bg-white px-4 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-3 dark:border-zinc-800 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Diğer sayfalar"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">Diğer sayfalar</span>
              <button className="icon-btn" aria-label="Kapat" onClick={() => setMoreOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {MORE.map(({ page: p, label, icon: Icon }) => (
                <button
                  key={p}
                  onClick={() => go(p)}
                  aria-current={page === p ? "page" : undefined}
                  className={`flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-xl border text-xs font-medium ${
                    page === p
                      ? "border-indigo-400 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                      : "border-zinc-200 text-zinc-700 dark:border-zinc-800 dark:text-zinc-300"
                  }`}
                >
                  <Icon size={20} />
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-3 flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800/60" role="group" aria-label="Tema">
              {THEMES.map(({ value, icon: Icon, label }) => (
                <button
                  key={value}
                  aria-pressed={settings.theme === value}
                  onClick={() => void update({ theme: value })}
                  className={`flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md text-xs ${
                    settings.theme === value ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100" : "text-zinc-500"
                  }`}
                >
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-zinc-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden dark:border-zinc-800 dark:bg-zinc-900/95"
        aria-label="Sayfalar"
      >
        {TABS.slice(0, 2).map(({ page: p, label, icon: Icon }) => (
          <button key={p} className={tab(page === p && !moreOpen)} onClick={() => go(p)} aria-current={page === p ? "page" : undefined}>
            <Icon size={20} />
            {label}
          </button>
        ))}
        <div className="flex flex-1 items-center justify-center">
          <button
            className="grid h-12 w-12 place-items-center rounded-full bg-indigo-600 text-white shadow-lg active:scale-95"
            onClick={() => {
              setMoreOpen(false);
              openTransactionForm();
            }}
            aria-label="Yeni işlem"
          >
            <Plus size={22} />
          </button>
        </div>
        {TABS.slice(2).map(({ page: p, label, icon: Icon }) => (
          <button key={p} className={tab(page === p && !moreOpen)} onClick={() => go(p)} aria-current={page === p ? "page" : undefined}>
            <Icon size={20} />
            {label}
          </button>
        ))}
        <button ref={moreBtnRef} className={tab(inMore || moreOpen)} onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen}>
          <Menu size={20} />
          Daha fazla
        </button>
      </nav>
    </>
  );
}
