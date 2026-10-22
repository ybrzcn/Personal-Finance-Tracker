import type { Api } from "./api";
import type { Account, AccountPreview, AutoPostResult, Backup, CsvMerge, CsvParseResult, CategoryRulePreview, CategorySuggestions, ImportRows, StatementCard, StatementTotals, AccountsReport, AnalysisReport, Budget, BudgetReport, CashPlanReport, Category, CategoryUsageReport, DebtPlanReport, FundHit, Goal, GoalsReport, IncomeStatus, NetWorthReport, OverviewReport, ProjectionReport, ReportsReport, PnlReport, Attachment, ReceiptHint, RateQuote, RecurringItem, RecurringPreview, ResetSeed, Tag, TagsReport, Transaction, TransactionPreview, UpcomingObligations } from "./types";

/** Oturum düşünce (401) yayınlanır; giriş kapısı giriş ekranına döner. */
export const UNAUTHORIZED_EVENT = "finans:unauthorized";

export interface HttpOptions {
  /** Boş: aynı köken (web). Masaüstü sunucu modunda sunucu adresi. */
  baseUrl?: string;
  /** Masaüstü/mobil: Bearer token. Web'de yok (HttpOnly çerez). */
  getToken?: () => string | null;
}

/** finans-server'a istek; hata mesajı sunucudan geldiği gibi (Türkçe) fırlatılır. */
export async function httpRequest<T>(method: string, path: string, body?: unknown, opts: HttpOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const raw = body instanceof Blob;
  if (body !== undefined && !raw) headers["Content-Type"] = "application/json";
  const token = opts.getToken?.();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl ?? ""}${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : raw ? (body as Blob) : JSON.stringify(body),
    });
  } catch {
    throw "Sunucuya ulaşılamıyor. Bağlantınızı kontrol edin.";
  }
  if (res.status === 401 && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) {
    const msg = await res
      .json()
      .then((d) => (typeof d?.error === "string" ? (d.error as string) : null))
      .catch(() => null);
    throw msg ?? `Sunucu hatası (${res.status}).`;
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const desktopOnly = async (): Promise<never> => {
  throw "Bu işlem yalnızca masaüstü uygulamasında kullanılabilir.";
};

/** `Api` arayüzünün finans-server REST karşılığı. */
export function createHttpApi(opts: HttpOptions = {}): Api {
  const r = <T>(method: string, path: string, body?: unknown) => httpRequest<T>(method, path, body, opts);
  const id = (x: string) => encodeURIComponent(x);
  const server = { path: "Sunucu", isDefault: true };
  return {
    listCategories: () => r<Category[]>("GET", "/api/categories"),
    createCategory: (input) => r<Category>("POST", "/api/categories", input),
    updateCategory: (c) => r<Category>("PUT", `/api/categories/${id(c.id)}`, c),
    deleteCategory: (x) => r<void>("DELETE", `/api/categories/${id(x)}`),
    listAccounts: () => r<Account[]>("GET", "/api/accounts"),
    createAccount: (input) => r<Account>("POST", "/api/accounts", input),
    updateAccount: (a) => r<Account>("PUT", `/api/accounts/${id(a.id)}`, a),
    deleteAccount: (x) => r<void>("DELETE", `/api/accounts/${id(x)}`),
    listTransactions: () => r<Transaction[]>("GET", "/api/transactions"),
    createTransaction: (input) => r<Transaction>("POST", "/api/transactions", input),
    updateTransaction: (t) => r<Transaction>("PUT", `/api/transactions/${id(t.id)}`, t),
    deleteTransaction: (x) => r<void>("DELETE", `/api/transactions/${id(x)}`),
    listRecurring: () => r<RecurringItem[]>("GET", "/api/recurring"),
    createRecurring: (input) => r<RecurringItem>("POST", "/api/recurring", { ...input, id: "" }),
    updateRecurring: (item) => r<RecurringItem>("PUT", `/api/recurring/${id(item.id)}`, item),
    setRecurringException: (x, month, amount, note) => r<RecurringItem>("PUT", `/api/recurring/${id(x)}/exception`, { month, amount, note }),
    deleteRecurring: (x) => r<void>("DELETE", `/api/recurring/${id(x)}`),
    autoPostRecurring: () => r<AutoPostResult>("POST", "/api/recurring/auto-post"),
    depositMature: (x, renew) => r<{ account: Account; transaction: Transaction | null }>("POST", `/api/accounts/${id(x)}/deposit/mature`, { renew }),
    resetSeed: () => r<ResetSeed>("GET", "/api/reset/seed"),
    listBudgets: () => r<Budget[]>("GET", "/api/budgets"),
    setBudget: (categoryId, amount) => r<void>("PUT", `/api/budgets/${id(categoryId)}`, { amount }),
    setBudgetRollover: (categoryId, from) => r<void>("PUT", `/api/budgets/${id(categoryId)}/rollover`, { from }),
    restore: (data) => r<void>("POST", "/api/restore", data),
    getSettings: () => r("GET", "/api/settings"),
    setSetting: (key, value) => r<void>("PUT", `/api/settings/${id(key)}`, value ?? null),
    dataLocation: async () => "Sunucu",
    backupDatabase: async () => null,
    databaseInfo: async () => server,
    saveDatabaseCopy: desktopOnly,
    openDatabase: desktopOnly,
    useDefaultDatabase: async () => server,
    async appInfo() {
      const h = await r<{ version: string }>("GET", "/api/health");
      return { version: `sunucu ${h.version}`, os: navigator.userAgent, arch: "-", schemaVersion: null };
    },
    uninstallPlan: desktopOnly,
    uninstallApp: desktopOnly,
    latestRates: (refresh) => r<RateQuote[]>("GET", `/api/rates/latest${refresh ? "?refresh=1" : ""}`),
    rateAt: (code, date) => r<RateQuote | null>("GET", `/api/rates/at?code=${id(code)}&date=${id(date)}`),
    rateHistory: (code, from, to) => r<RateQuote[]>("GET", `/api/rates/history?code=${id(code)}&from=${id(from)}&to=${id(to)}`),
    pnlReport: (from, to, kind) => r<PnlReport>("GET", `/api/pnl?from=${id(from ?? "")}&to=${id(to ?? "")}&kind=${id(kind ?? "all")}`),
    accountsReport: () => r<AccountsReport>("GET", "/api/accounts/report"),
    budgetReport: (month) => r<BudgetReport>("GET", `/api/budget/report?month=${encodeURIComponent(month)}`),
    incomeStatus: () => r<IncomeStatus>("GET", "/api/income/status"),
    cashPlan: (months) => r<CashPlanReport>("GET", `/api/cashplan?months=${months}`),
    upcomingObligations: (days) => r<UpcomingObligations>("GET", `/api/obligations/upcoming?days=${days}`),
    debtPlan: () => r<DebtPlanReport>("GET", "/api/debt/plan"),
    overview: (period) => r<OverviewReport>("GET", `/api/overview?period=${period}`),
    analysis: () => r<AnalysisReport>("GET", "/api/analysis"),
    previewTransaction: (draft) => r<TransactionPreview>("POST", "/api/preview/transaction", draft),
    previewAccount: (draft) => r<AccountPreview>("POST", "/api/preview/account", draft),
    previewRecurring: (draft) => r<RecurringPreview>("POST", "/api/preview/recurring", draft),
    statementRows: (request) => r<ImportRows>("POST", "/api/statements/rows", request),
    previewStatementCard: (draft) => r<StatementCard>("POST", "/api/preview/statement-card", draft),
    previewStatementTotals: (draft) => r<StatementTotals>("POST", "/api/preview/statement-totals", draft),
    previewCategoryRule: (draft) => r<CategoryRulePreview>("POST", "/api/preview/category-rule", draft),
    categorySuggestions: () => r<CategorySuggestions>("GET", "/api/categories/suggestions"),
    exportCsv: async (transactionIds) => (await r<{ csv: string }>("POST", "/api/export/csv", { transactionIds })).csv,
    exportBackup: async () => (await r<{ json: string }>("GET", "/api/export/backup")).json,
    parseBackup: (text) => r<Backup>("POST", "/api/backup/parse", { text }),
    parseCsv: (text) => r<CsvParseResult>("POST", "/api/csv/parse", { text }),
    mergeCsv: (rows, defaultAccountId) => r<CsvMerge>("POST", "/api/csv/merge", { rows, defaultAccountId }),
    categoryUsage: () => r<CategoryUsageReport>("GET", "/api/categories/usage"),
    netWorthReport: () => r<NetWorthReport>("GET", "/api/networth"),
    addAttachment: (transactionId, file) => r<Attachment>("POST", `/api/transactions/${id(transactionId)}/attachments?name=${encodeURIComponent(file.name)}`, file),
    listAttachments: (transactionId) => r<Attachment[]>("GET", `/api/transactions/${id(transactionId)}/attachments`),
    attachmentCounts: () => r<Record<string, number>>("GET", "/api/attachments/counts"),
    attachmentContent: async (a) => {
      const token = opts.getToken?.();
      const res = await fetch(`${opts.baseUrl ?? ""}/api/attachments/${id(a.id)}`, {
        credentials: "same-origin",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }).catch(() => null);
      if (res?.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      if (!res?.ok) throw "Belge alınamadı.";
      return new Blob([await res.arrayBuffer()], { type: a.mime });
    },
    deleteAttachment: (x) => r<void>("DELETE", `/api/attachments/${id(x)}`),
    parseReceipt: (file) => r<ReceiptHint>("POST", "/api/receipts/parse", file),
    reportsReport: (q) =>
      r<ReportsReport>("GET", `/api/reports?${new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (v == null ? [] : [[k, String(v)]]))).toString()}`),
    projectionReport: (a) =>
      r<ProjectionReport>("GET", `/api/projection?${new URLSearchParams(Object.entries(a).map(([k, v]) => [k, String(v)])).toString()}`),
    listGoals: () => r<Goal[]>("GET", "/api/goals"),
    createGoal: (input) => r<Goal>("POST", "/api/goals", input),
    updateGoal: (g) => r<Goal>("PUT", `/api/goals/${id(g.id)}`, g),
    deleteGoal: (x) => r<void>("DELETE", `/api/goals/${id(x)}`),
    goalsReport: () => r<GoalsReport>("GET", "/api/goals/report"),
    listTags: () => r<Tag[]>("GET", "/api/tags"),
    createTag: (input) => r<Tag>("POST", "/api/tags", input),
    updateTag: (t) => r<Tag>("PUT", `/api/tags/${id(t.id)}`, t),
    deleteTag: (x) => r<void>("DELETE", `/api/tags/${id(x)}`),
    tagsReport: () => r<TagsReport>("GET", "/api/tags/report"),
    setTransactionTags: (transactionIds, add, remove) => r<Transaction[]>("POST", "/api/transactions/tags", { transactionIds, add, remove }),
    fundsSearch: (q) => r<FundHit[]>("GET", `/api/funds/search?q=${id(q)}`),
    evdsKeySet: async () => false,
    setEvdsKey: desktopOnly,
  };
}
