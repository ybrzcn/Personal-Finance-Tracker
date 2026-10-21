import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { BottomNav } from "./components/BottomNav";
import { Sidebar } from "./components/Sidebar";
import { isMac, isMobile, isTauri } from "./lib/platform";
import { Accounts } from "./pages/Accounts";
import { AnalysisPage } from "./pages/Analysis";
import { BudgetPage } from "./pages/Budget";
import { GoalsPage } from "./pages/Goals";
import { TagsPage } from "./pages/Tags";
import { RatesPage } from "./pages/Rates";
import { PnlPage } from "./pages/Pnl";
import { CashPlanPage } from "./pages/CashPlan";
import { DebtPlannerPage } from "./pages/DebtPlanner";
import { Categories } from "./pages/Categories";
import { Dashboard } from "./pages/Dashboard";
import { SettingsPage } from "./pages/Settings";
import { Transactions } from "./pages/Transactions";
import { api } from "./lib/api";
import { useData } from "./state/data";
import { useUI, type Page } from "./state/ui";

const PAGE_KEYS: Record<string, Page> = {
  "1": "dashboard",
  "2": "transactions",
  "3": "accounts",
  "4": "budget",
  "5": "analysis",
  "6": "plan",
  "7": "debt",
  "8": "categories",
  "9": "settings",
};

/** macOS'ta başlık çubuğu "Overlay" modunda; trafik ışıkları için üstte sürüklenebilir alan bırakılır. */
const macOverlay = isTauri && isMac && !isMobile;

export default function App() {
  const { loading, loadError, reload } = useData();
  const { page, setPage, openTransactionForm, isModalOpen, toast } = useUI();

  // Seçili veritabanı açılamayıp varsayılana dönüldüyse kullanıcı uyarılır (veriler iki dosyaya bölünmesin)
  useEffect(() => {
    if (!isTauri) return;
    api
      .databaseInfo()
      .then((db) => {
        if (db.fallbackFrom) toast(`Seçili veritabanı açılamadı (${db.fallbackFrom}); varsayılan veritabanı kullanılıyor. Ayarlar'a bakın.`, "error");
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global kısayollar: Cmd/Ctrl+N yeni işlem, Cmd/Ctrl+1..9 sayfalar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey || isModalOpen) return;
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        openTransactionForm();
      } else if (PAGE_KEYS[key]) {
        e.preventDefault();
        setPage(PAGE_KEYS[key]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isModalOpen, openTransactionForm, setPage]);

  return (
    <div className="flex h-full">
      {macOverlay && <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-40 h-7" />}
      <Sidebar topInset={macOverlay} />
      {/* Telefonda: çentik için üst güvenli alan, alt sekme çubuğu kadar alt boşluk */}
      <main
        className={`flex-1 overflow-y-auto ${
          macOverlay ? "pt-7" : "pt-[env(safe-area-inset-top)]"
        } pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0`}
      >
        <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-7 2xl:max-w-[1600px]">
          {loading ? (
            <div className="grid h-[60vh] place-items-center text-zinc-400">
              <Loader2 className="animate-spin" />
            </div>
          ) : loadError ? (
            <div className="card mx-auto mt-20 max-w-md p-6 text-center">
              <AlertTriangle className="mx-auto mb-3 text-rose-500" />
              <p className="font-medium">Veriler yüklenemedi</p>
              <p className="mt-1 text-sm text-zinc-500">{loadError}</p>
              <button className="btn-primary mt-4" onClick={() => void reload()}>
                Tekrar dene
              </button>
            </div>
          ) : (
            <>
              {page === "dashboard" && <Dashboard />}
              {page === "transactions" && <Transactions />}
              {page === "accounts" && <Accounts />}
              {page === "rates" && <RatesPage />}
              {page === "pnl" && <PnlPage />}
              {page === "budget" && <BudgetPage />}
              {page === "goals" && <GoalsPage />}
              {page === "analysis" && <AnalysisPage />}
              {page === "plan" && <CashPlanPage />}
              {page === "debt" && <DebtPlannerPage />}
              {page === "categories" && <Categories />}
              {page === "tags" && <TagsPage />}
              {page === "settings" && <SettingsPage />}
            </>
          )}
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
