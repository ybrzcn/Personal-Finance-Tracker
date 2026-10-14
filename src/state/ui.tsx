import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { ErrorReportDialog } from "../components/ErrorReportDialog";
import { logError } from "../lib/errorLog";
import { useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AccountForm } from "../components/AccountForm";
import { CategoryForm } from "../components/CategoryForm";
import { LoanPaymentForm } from "../components/LoanPaymentForm";
import { RecurringForm } from "../components/RecurringForm";
import { StatementImportDialog } from "../components/StatementImportDialog";
import { Modal } from "../components/Modal";
import { TransactionForm } from "../components/TransactionForm";
import type { Account, Category, CategoryType, RecurringItem, Transaction, TransactionInput } from "../lib/types";
import { UIContext } from "./contexts";

export type Page = "dashboard" | "transactions" | "accounts" | "rates" | "pnl" | "budget" | "analysis" | "plan" | "debt" | "categories" | "settings";
const PAGES: Page[] = ["dashboard", "transactions", "accounts", "rates", "pnl", "budget", "analysis", "plan", "debt", "categories", "settings"];
type ToastKind = "success" | "error" | "info";

/** İşlem formunda tek tıkla doldurulabilen hazır tutar (ör. kart ödemesi). */
/** Yeni işlem formunun ön değerleri; cashAdvance kart giderini nakit avans olarak açar. */
export type TransactionDefaults = Partial<TransactionInput> & { cashAdvance?: boolean };

export interface AmountHint {
  label: string;
  amount: number;
}

interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

export interface UICtx {
  page: Page;
  setPage(p: Page): void;
  toast(message: string, kind?: ToastKind, action?: ToastAction): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  openTransactionForm(tx?: Transaction, defaults?: TransactionDefaults, hints?: AmountHint[]): void;
  openCategoryForm(cat?: Category, defaultType?: CategoryType): void;
  openAccountForm(account?: Account): void;
  openLoanPayment(account: Account): void;
  openRecurringForm(item?: RecurringItem, defaultType?: CategoryType): void;
  /** Banka/kart ekstresi içe aktarma (hesap verilirse o hesap seçili gelir) */
  openStatementImport(accountId?: string): void;
  /** "Hata bildir" penceresi */
  openErrorReport(): void;
  /** İşlemler sayfasının hesap filtresi: "all" veya hesap id */
  accountFilter: string;
  setAccountFilter(id: string): void;
  showAccountTransactions(accountId: string): void;
  isModalOpen: boolean;
}


/** Bildirimdeki eylem (ör. "Geri al") */
export interface ToastAction {
  label: string;
  run(): void | Promise<void>;
}

interface ToastItem {
  action?: ToastAction;
  id: number;
  message: string;
  kind: ToastKind;
}

type Editor =
  | { kind: "transaction"; tx?: Transaction; defaults?: TransactionDefaults; hints?: AmountHint[] }
  | { kind: "category"; cat?: Category; defaultType?: CategoryType }
  | { kind: "account"; account?: Account }
  | { kind: "loanPayment"; account: Account }
  | { kind: "recurring"; item?: RecurringItem; defaultType?: CategoryType }
  | { kind: "statementImport"; accountId?: string }
  | { kind: "errorReport" }
  | null;

export function UIProvider({ children }: { children: ReactNode }) {
  // Geliştirmede açılış sayfası URL'den seçilebilir (#transactions); telefon görünümü denetimleri için
  const [page, setPage] = useState<Page>(() =>
    import.meta.env.DEV && PAGES.includes(location.hash.slice(1) as Page) ? (location.hash.slice(1) as Page) : "dashboard",
  );
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [editor, setEditor] = useState<Editor>(null);
  const [accountFilter, setAccountFilter] = useState("all");
  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { resolve(v: boolean): void }) | null>(null);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (message: string, kind: ToastKind = "success", action?: ToastAction) => {
      const id = nextId.current++;
      // Hata bildirimleri kaydedilir ve "Bildir" ile raporlanabilir
      if (kind === "error") {
        logError(message, "bildirim");
        if (!action) action = { label: "Bildir", run: () => setEditor({ kind: "errorReport" }) };
      }
      setToasts((ts) => [...ts, { id, message, kind, action }]);
      // Geri alma eylemi olan bildirim daha uzun kalır
      setTimeout(() => dismiss(id), action ? 8000 : kind === "error" ? 7000 : 3500);
    },
    [dismiss],
  );

  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve })),
    [],
  );

  const closeConfirm = (result: boolean) => {
    confirmState?.resolve(result);
    setConfirmState(null);
  };

  const value = useMemo<UICtx>(
    () => ({
      page,
      setPage,
      toast,
      confirm,
      openTransactionForm: (tx, defaults, hints) => setEditor({ kind: "transaction", tx, defaults, hints }),
      openCategoryForm: (cat, defaultType) => setEditor({ kind: "category", cat, defaultType }),
      openAccountForm: (account) => setEditor({ kind: "account", account }),
      openLoanPayment: (account) => setEditor({ kind: "loanPayment", account }),
      openRecurringForm: (item, defaultType) => setEditor({ kind: "recurring", item, defaultType }),
      openStatementImport: (accountId) => setEditor({ kind: "statementImport", accountId }),
      openErrorReport: () => setEditor({ kind: "errorReport" }),
      accountFilter,
      setAccountFilter,
      showAccountTransactions: (accountId) => {
        setAccountFilter(accountId);
        setPage("transactions");
      },
      isModalOpen: editor !== null || confirmState !== null,
    }),
    [page, toast, confirm, editor, confirmState, accountFilter],
  );

  return (
    <UIContext.Provider value={value}>
      {children}

      {editor?.kind === "transaction" && (
        <TransactionForm
          transaction={editor.tx}
          defaults={editor.defaults}
          hints={editor.hints}
          onClose={() => setEditor(null)}
          onSaved={(m) => toast(m)}
        />
      )}
      {editor?.kind === "category" && (
        <CategoryForm
          category={editor.cat}
          defaultType={editor.defaultType}
          onClose={() => setEditor(null)}
          onSaved={(m) => toast(m)}
        />
      )}
      {editor?.kind === "account" && (
        <AccountForm account={editor.account} onClose={() => setEditor(null)} onSaved={(m) => toast(m)} />
      )}
      {editor?.kind === "loanPayment" && (
        <LoanPaymentForm account={editor.account} onClose={() => setEditor(null)} onSaved={(m) => toast(m)} />
      )}
      {editor?.kind === "recurring" && (
        <RecurringForm item={editor.item} defaultType={editor.defaultType} onClose={() => setEditor(null)} onSaved={(m) => toast(m)} />
      )}
      {editor?.kind === "errorReport" && <ErrorReportDialog page={page} onClose={() => setEditor(null)} />}
      {editor?.kind === "statementImport" && (
        <StatementImportDialog accountId={editor.accountId} onClose={() => setEditor(null)} onSaved={(m) => toast(m)} />
      )}

      {confirmState && (
        <Modal
          title={confirmState.title}
          onClose={() => closeConfirm(false)}
          footer={
            <>
              {/* Geri alınamaz işlemde odak "Vazgeç"te: Enter yanlışlıkla silmesin */}
              <button className="btn-secondary" data-autofocus={confirmState.danger ? true : undefined} onClick={() => closeConfirm(false)}>
                Vazgeç
              </button>
              <button
                data-autofocus={confirmState.danger ? undefined : true}
                className={confirmState.danger ? "btn-danger" : "btn-primary"}
                onClick={() => closeConfirm(true)}
              >
                {confirmState.confirmLabel ?? "Onayla"}
              </button>
            </>
          }
        >
          <div className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{confirmState.message}</div>
        </Modal>
      )}

      {/* Alt ortada: tablolardaki tutar sütununun üstünü kapatmaz; telefonda alt sekme çubuğunun üstünde */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[60] md:bottom-5 flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className="pointer-events-auto flex max-w-md animate-slide-up items-start gap-2.5 rounded-xl border border-zinc-200 bg-white py-3 pl-4 pr-2 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
          >
            {t.kind === "success" && <CheckCircle2 size={18} className="mt-px shrink-0 text-emerald-500" />}
            {t.kind === "error" && <AlertTriangle size={18} className="mt-px shrink-0 text-rose-500" />}
            {t.kind === "info" && <Info size={18} className="mt-px shrink-0 text-indigo-500" />}
            <span className="flex-1">{t.message}</span>
            {t.action && (
              <button
                className="shrink-0 rounded-md px-2 py-0.5 text-sm font-semibold text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
                onClick={() => {
                  dismiss(t.id);
                  void t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="icon-btn -my-0.5 shrink-0 p-1" aria-label="Bildirimi kapat" onClick={() => dismiss(t.id)}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </UIContext.Provider>
  );
}

export function useUI() {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error("useUI, UIProvider içinde kullanılmalı");
  return ctx;
}
