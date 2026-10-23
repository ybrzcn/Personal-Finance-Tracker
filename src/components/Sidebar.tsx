import {
  Activity,
  ChartColumn,
  ArrowLeftRight,
  CalendarRange,
  Coins,
  TrendingUp,
  Landmark,
  LayoutDashboard,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PiggyBank,
  Target,
  Plus,
  Settings,
  Sun,
  Tag as TagIcon,
  Tags,
  Telescope,
  TrendingDown,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";
import { isMac, modKey } from "../lib/platform";
import { useSettings, type ThemePref } from "../state/settings";
import { useUI, type Page } from "../state/ui";
import { t } from "../lib/i18n";

/** `key`: App.tsx'deki kısayol (⌘1–9); kısayolu olmayan sayfada yok */
const NAV: { page: Page; label: string; icon: typeof LayoutDashboard; key?: string }[] = [
  { page: "dashboard", label: t("Genel Bakış"), icon: LayoutDashboard, key: "1" },
  { page: "transactions", label: t("İşlemler"), icon: ArrowLeftRight, key: "2" },
  { page: "accounts", label: t("Hesaplar"), icon: Landmark, key: "3" },
  { page: "rates", label: t("Kurlar"), icon: Coins },
  { page: "pnl", label: t("Kâr/Zarar"), icon: TrendingUp },
  { page: "budget", label: t("Bütçe"), icon: PiggyBank, key: "4" },
  { page: "goals", label: t("Hedefler"), icon: Target },
  { page: "analysis", label: t("Analiz"), icon: Activity, key: "5" },
  { page: "reports", label: t("Raporlar"), icon: ChartColumn },
  { page: "plan", label: t("Ödeme Takvimi"), icon: CalendarRange, key: "6" },
  { page: "debt", label: t("Borç Planı"), icon: TrendingDown, key: "7" },
  { page: "projection", label: t("Uzun Vade"), icon: Telescope },
  { page: "categories", label: t("Kategoriler"), icon: Tags, key: "8" },
  { page: "tags", label: t("Etiketler"), icon: TagIcon },
  { page: "settings", label: t("Ayarlar"), icon: Settings, key: "9" },
];

const THEMES: { value: ThemePref; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: t("Açık") },
  { value: "system", icon: Monitor, label: t("Sistem") },
  { value: "dark", icon: Moon, label: t("Koyu") },
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
        `hidden w-[4.75rem] shrink-0 select-none md:flex lg:w-[13.5rem] pb-4 pl-3 lg:pl-4 ${topInset ? "pt-10" : "pt-4"}`,
      )}
    >
      <div className="flex w-full flex-col rounded-2xl bg-white px-2 py-3.5 lg:px-2.5 dark:bg-zinc-900">
        <div className={lg("mb-3.5 flex justify-center lg:justify-start lg:px-2")}>
          <div className={lg("grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-100 text-indigo-700 lg:hidden dark:bg-indigo-900 dark:text-indigo-200")}>
            <Wallet size={18} />
          </div>
          <div className={lg("hidden lg:block")}>
            <div className="text-[17px] font-bold leading-tight">Finans</div>
            <div className="text-xs text-zinc-500">{t("Kişisel bütçe takibi")}</div>
          </div>
        </div>

        <button
          className={lg("btn-primary mb-3 w-full justify-center px-0 lg:justify-between lg:px-3")}
          onClick={() => openTransactionForm()}
          title={`${t("Yeni İşlem")} (${modKey}N)`}
          aria-label={t("Yeni İşlem")}
        >
          <span className="inline-flex items-center gap-1.5">
            <Plus size={16} /> <span className={lg("hidden lg:inline")}>{t("Yeni İşlem")}</span>
          </span>
          <kbd className={lg("hidden font-sans text-xs font-normal opacity-70 lg:inline")}>{modKey}N</kbd>
        </button>

        <nav className="space-y-0.5">
          {NAV.map(({ page: p, label, icon: Icon, key }) => {
            const active = page === p;
            return (
              <button
                key={p}
                onClick={() => setPage(p)}
                aria-current={active ? "page" : undefined}
                title={label}
                aria-label={label}
                className={lg(
                  `flex min-h-[34px] w-full items-center justify-center gap-3 rounded-[10px] px-3 py-2 text-[13px] transition-colors lg:justify-between lg:py-1.5 ${
                    active
                      ? "bg-indigo-100 font-semibold text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200"
                      : "text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                  }`,
                )}
              >
                {/* Simgeler yalnız dar şeritte; geniş menüde ad ve kısayol */}
                <Icon size={17} className={lg("shrink-0 lg:hidden")} />
                <span className={lg("hidden truncate lg:inline")}>{label}</span>
                {key && (
                  <span
                    className={lg(
                      `hidden text-[11px] font-normal lg:inline ${active ? "text-indigo-500 dark:text-indigo-400" : "text-zinc-400 dark:text-zinc-500"}`,
                    )}
                  >
                    {modKey}
                    {key}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto space-y-1.5 pt-4">
          <button
            type="button"
            onClick={toggle}
            title={`${collapsed ? t("Menüyü genişlet") : t("Menüyü daralt")} (${modKey}B)`}
            aria-label={collapsed ? t("Menüyü genişlet") : t("Menüyü daralt")}
            aria-expanded={!collapsed}
            // Dar pencerede menü zaten simge şeridi; düğme yalnız geniş ekranda
            className={`hidden w-full items-center gap-2 rounded-[10px] px-3 py-2 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 lg:flex dark:hover:bg-zinc-800 dark:hover:text-zinc-100 ${
              collapsed ? "justify-center" : "justify-start"
            }`}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            <span className={lg("hidden lg:inline")}>{t("Menüyü daralt")}</span>
          </button>
          <div className={lg("flex flex-col gap-0.5 rounded-[9px] bg-zinc-100 p-[3px] lg:flex-row dark:bg-zinc-950")} role="group" aria-label={t("Tema")}>
            {THEMES.map(({ value, icon: Icon, label }) => (
              <button
                key={value}
                title={label}
                aria-label={label}
                aria-pressed={settings.theme === value}
                onClick={() => update({ theme: value })}
                className={`flex min-h-[26px] flex-1 items-center justify-center rounded-md text-xs transition ${
                  settings.theme === value
                    ? "bg-white font-semibold text-zinc-900 dark:bg-zinc-700 dark:text-zinc-50"
                    : "font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                <Icon size={14} className={lg("lg:hidden")} />
                <span className={lg("hidden lg:inline")}>{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
