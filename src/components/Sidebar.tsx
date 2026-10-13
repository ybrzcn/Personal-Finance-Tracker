import {
  Activity,
  ArrowLeftRight,
  CalendarRange,
  Landmark,
  LayoutDashboard,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PiggyBank,
  Plus,
  Settings,
  Sun,
  Tags,
  TrendingDown,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";
import { isMac, modKey } from "../lib/platform";
import { useSettings, type ThemePref } from "../state/settings";
import { useUI, type Page } from "../state/ui";

const NAV: { page: Page; label: string; icon: typeof LayoutDashboard }[] = [
  { page: "dashboard", label: "Genel Bakış", icon: LayoutDashboard },
  { page: "transactions", label: "İşlemler", icon: ArrowLeftRight },
  { page: "accounts", label: "Hesaplar", icon: Landmark },
  { page: "budget", label: "Bütçe", icon: PiggyBank },
  { page: "analysis", label: "Analiz", icon: Activity },
  { page: "plan", label: "Ödeme Takvimi", icon: CalendarRange },
  { page: "debt", label: "Borç Planı", icon: TrendingDown },
  { page: "categories", label: "Kategoriler", icon: Tags },
  { page: "settings", label: "Ayarlar", icon: Settings },
];

const THEMES: { value: ThemePref; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: "Açık" },
  { value: "system", icon: Monitor, label: "Sistem" },
  { value: "dark", icon: Moon, label: "Koyu" },
];

const COLLAPSE_KEY = "finans-sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function Sidebar({ topInset }: { topInset: boolean }) {
  const { page, setPage, openTransactionForm } = useUI();
  const { settings, update } = useSettings();
  // Kapalıyken geniş ekranda da yalnız simge şeridi: "lg:" sınıfları atılır
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const lg = (cls: string) =>
    collapsed
      ? cls
          .split(/\s+/)
          .filter((c) => !c.startsWith("lg:"))
          .join(" ")
      : cls;
  const toggle = () => {
    setCollapsed((v) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, v ? "0" : "1");
      } catch {
        /* yoksay */
      }
      return !v;
    });
  };

  // ⌘B / Ctrl+B ile aç-kapa
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <aside
      // Dar pencerelerde (< 1024 px) yalnız simgelerden oluşan ince bir şerit olur
      className={lg(
        // Telefonda (md altı) gizli; yerine alt sekme çubuğu
        `hidden w-16 shrink-0 select-none flex-col border-r md:flex border-zinc-200 bg-zinc-100/60 px-2 pb-4 lg:w-60 lg:px-3 dark:border-zinc-800 dark:bg-zinc-900/40 ${
          topInset ? "pt-10" : "pt-5"
        }`,
      )}
    >
      <div className={lg("mb-6 flex items-center justify-center gap-2.5 lg:justify-start lg:px-2")}>
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm">
          <Wallet size={18} />
        </div>
        <div className={lg("hidden lg:block")}>
          <div className="text-sm font-semibold leading-tight">Finans</div>
          <div className="text-xs text-zinc-500">Kişisel bütçe takibi</div>
        </div>
      </div>

      <button
        className={lg("btn-primary mb-5 w-full px-0 lg:px-3.5")}
        onClick={() => openTransactionForm()}
        title={`Yeni İşlem (${modKey}N)`}
        aria-label="Yeni İşlem"
      >
        <Plus size={16} /> <span className={lg("hidden lg:inline")}>Yeni İşlem</span>
        <kbd className={lg("ml-auto hidden rounded lg:inline bg-white/20 px-1.5 py-0.5 text-[10px] font-medium")}>{modKey}N</kbd>
      </button>

      <nav className="space-y-0.5">
        {NAV.map(({ page: p, label, icon: Icon }, i) => {
          const active = page === p;
          return (
            <button
              key={p}
              onClick={() => setPage(p)}
              aria-current={active ? "page" : undefined}
              title={label}
              aria-label={label}
              className={lg(
                `group flex w-full items-center justify-center gap-3 rounded-lg px-2.5 py-2.5 text-sm font-medium transition-colors lg:justify-start lg:py-2 ${
                  active
                    ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                    : "text-zinc-600 hover:bg-zinc-200/60 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100"
                }`,
              )}
            >
              <Icon size={17} className={`shrink-0 ${active ? "text-indigo-600 dark:text-indigo-400" : ""}`} />
              <span className={lg("hidden truncate lg:inline")}>{label}</span>
              <span className={lg("ml-auto hidden text-[10px] lg:inline text-zinc-400 opacity-0 transition group-hover:opacity-100")}>
                {modKey}
                {i + 1}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="mt-auto space-y-2">
        <button
          type="button"
          onClick={toggle}
          title={`${collapsed ? "Menüyü genişlet" : "Menüyü daralt"} (${modKey}B)`}
          aria-label={collapsed ? "Menüyü genişlet" : "Menüyü daralt"}
          aria-expanded={!collapsed}
          // Dar pencerede menü zaten simge şeridi; düğme yalnız geniş ekranda
          className={`hidden w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-900 lg:flex dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100 ${
            collapsed ? "justify-center" : "justify-start"
          }`}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          <span className={lg("hidden lg:inline")}>Menüyü daralt</span>
        </button>
        <div className={lg("flex flex-col rounded-lg bg-zinc-200/60 p-0.5 lg:flex-row dark:bg-zinc-800/60")} role="group" aria-label="Tema">
          {THEMES.map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              title={label}
              aria-pressed={settings.theme === value}
              onClick={() => update({ theme: value })}
              className={`flex flex-1 items-center justify-center rounded-md py-1.5 transition ${
                settings.theme === value
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              <Icon size={15} />
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
