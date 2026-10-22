import { invoke } from "@tauri-apps/api/core";
import { createHttpApi } from "./httpApi";
import { backend } from "./platform";
import type {
  Account,
  AccountInput,
  AppDataSettings,
  AppSettingKey,
  Backup,
  Budget,
  CsvMerge,
  CsvParseResult,
  CsvRow,
  Category,
  CategoryInput,
  FundHit,
  Goal,
  GoalInput,
  GoalsReport,
  Tag,
  TagInput,
  TagsReport,
  PnlKind,
  NetWorthReport,
  ProjectionAssumptions,
  ProjectionReport,
  ReportsQuery,
  Attachment,
  ReceiptHint,
  ReportsReport,
  OverviewPeriod,
  OverviewReport,
  AccountsReport,
  BudgetReport,
  CashPlanReport,
  AnalysisReport,
  AutoPostResult,
  AccountDraft,
  AccountPreview,
  RecurringDraft,
  RecurringPreview,
  TransactionDraft,
  TransactionPreview,
  CategoryUsageReport,
  DebtPlanReport,
  IncomeStatus,
  PnlReport,
  RateQuote,
  RecurringInput,
  RecurringItem,
  ResetSeed,
  Transaction,
  UpcomingObligations,
  TransactionInput,
  CategoryRuleDraft,
  CategoryRulePreview,
  CategorySuggestions,
  ImportRows,
  StatementCard,
  StatementCardDraft,
  StatementRowsRequest,
  StatementTotals,
  StatementTotalsDraft,
} from "./types";

/**
 * Veri erişim katmanı.
 * - Tauri içinde: Rust tarafındaki SQLite veritabanı (uygulama veri klasöründe).
 * - Tarayıcıda: finans-server API'si.
 */
export interface Api {
  listCategories(): Promise<Category[]>;
  createCategory(input: CategoryInput): Promise<Category>;
  updateCategory(category: Category): Promise<Category>;
  deleteCategory(id: string): Promise<void>;
  listAccounts(): Promise<Account[]>;
  createAccount(input: AccountInput): Promise<Account>;
  updateAccount(account: Account): Promise<Account>;
  deleteAccount(id: string): Promise<void>;
  listTransactions(): Promise<Transaction[]>;
  createTransaction(input: TransactionInput): Promise<Transaction>;
  updateTransaction(transaction: Transaction): Promise<Transaction>;
  deleteTransaction(id: string): Promise<void>;
  listRecurring(): Promise<RecurringItem[]>;
  createRecurring(input: RecurringInput): Promise<RecurringItem>;
  updateRecurring(item: RecurringItem): Promise<RecurringItem>;
  /** Ay istisnası (Ödeme Takvimi "bu ay yatmayacak"); `amount` null istisnayı kaldırır */
  setRecurringException(id: string, month: string, amount: number | null, note: string): Promise<RecurringItem>;
  deleteRecurring(id: string): Promise<void>;
  /** Vadesi dolan mevduatın net faizini kaydeder; `renew` aynı süreyle yeniler, değilse vadesize çevirir */
  depositMature(id: string, renew: boolean): Promise<{ account: Account; transaction: Transaction | null }>;
  /** Otomatik kaydı açık düzenli kayıtların günü gelmiş ödemelerini işlem olarak ekler */
  autoPostRecurring(): Promise<AutoPostResult>;
  /** "Verileri sıfırla" sonrası başlangıç verisi (varsayılan kategoriler ve "Genel Hesap") */
  resetSeed(): Promise<ResetSeed>;
  listBudgets(): Promise<Budget[]>;
  /** `amount` null veya 0 ise bütçe kaldırılır. */
  setBudget(categoryId: string, amount: number | null): Promise<void>;
  /** Devreden bütçeyi `from` ayından (YYYY-MM) açar; null kapatır */
  setBudgetRollover(categoryId: string, from: string | null): Promise<void>;
  /** Tüm veriyi atomik olarak verilenle değiştirir. */
  restore(data: DataSet): Promise<void>;
  /** Veritabanında saklanan uygulama ayarları (borç planı, analiz) */
  getSettings(): Promise<Partial<AppDataSettings>>;
  setSetting<K extends AppSettingKey>(key: K, value: AppDataSettings[K]): Promise<void>;
  dataLocation(): Promise<string>;
  /** Sıfırlamadan önce veritabanı dosyasının kopyasını alır (web'de null). */
  backupDatabase(): Promise<string | null>;
  databaseInfo(): Promise<DatabaseInfo>;
  /** Veritabanının kopyasını seçilen yola kaydeder. */
  saveDatabaseCopy(path: string): Promise<void>;
  /** Var olan (create=false) ya da yeni (create=true) veritabanına geçer. */
  openDatabase(path: string, create: boolean): Promise<DatabaseInfo>;
  useDefaultDatabase(): Promise<DatabaseInfo>;
  /** Hata raporu için sürüm ve sistem bilgisi */
  appInfo(): Promise<AppInfo>;
  /** Kaldırmada silinecekler */
  uninstallPlan(): Promise<UninstallPlan>;
  /** Uygulamayı kapatır ve tüm verisiyle birlikte siler */
  uninstallApp(includeCustomDatabase: boolean): Promise<void>;
  /** Güncel kurlar; `refresh` kaynaklardan yenilemeyi ister (en çok dakikada bir) */
  latestRates(refresh: boolean): Promise<RateQuote[]>;
  /** Bir günün kuru; yoksa null */
  rateAt(code: string, date: string): Promise<RateQuote | null>;
  /** Kur geçmişi (Postgres'li sunucu; masaüstünde yalnız fonlar) */
  rateHistory(code: string, from: string, to: string): Promise<RateQuote[]>;
  /** Kâr/zarar raporu; `from`/`to` gerçekleşenleri, `kind` varlıkları sınırlar (Rust'ta hesaplanır) */
  pnlReport(from: string | null, to: string | null, kind?: PnlKind): Promise<PnlReport>;
  accountsReport(): Promise<AccountsReport>;
  /** Bütçe sayfasının seçili ay raporu (Rust'ta hesaplanır) */
  budgetReport(month: string): Promise<BudgetReport>;
  /** Beklenen gelir ve yatış günü gelmiş ama girilmemiş gelirler (Rust) */
  incomeStatus(): Promise<IncomeStatus>;
  /** Ödeme takvimi (Rust'ta hesaplanır) */
  cashPlan(months: number): Promise<CashPlanReport>;
  /** Önümüzdeki günlerin kart/kredi ve planlı ödemeleri (Rust) */
  upcomingObligations(days: number): Promise<UpcomingObligations>;
  /** Borç planı (Rust); borç ayarları veritabanından okunur */
  debtPlan(): Promise<DebtPlanReport>;
  /** Genel Bakış istatistikleri (Rust) */
  overview(period: OverviewPeriod): Promise<OverviewReport>;
  /** Kategorilerin işlem sayısı ve toplamı (Rust) */
  categoryUsage(): Promise<CategoryUsageReport>;
  analysis(): Promise<AnalysisReport>;
  /** Form önizlemeleri (Rust) */
  previewTransaction(draft: TransactionDraft): Promise<TransactionPreview>;
  previewAccount(draft: AccountDraft): Promise<AccountPreview>;
  previewRecurring(draft: RecurringDraft): Promise<RecurringPreview>;
  /** Ekstre satırları (Rust) */
  statementRows(request: StatementRowsRequest): Promise<ImportRows>;
  previewStatementCard(draft: StatementCardDraft): Promise<StatementCard>;
  previewStatementTotals(draft: StatementTotalsDraft): Promise<StatementTotals>;
  /** Kategori kuralları ve önerileri (Rust) */
  previewCategoryRule(draft: CategoryRuleDraft): Promise<CategoryRulePreview>;
  categorySuggestions(): Promise<CategorySuggestions>;
  /** CSV dışa aktarma (null: bütün işlemler; dizi: bu işlemler bu sırayla) ve yedek metni (Rust) */
  exportCsv(transactionIds: string[] | null): Promise<string>;
  exportBackup(): Promise<string>;
  /** Yedeği ve CSV'yi doğrulama, CSV satırlarını birleştirme (Rust) */
  parseBackup(text: string): Promise<Backup>;
  parseCsv(text: string): Promise<CsvParseResult>;
  mergeCsv(rows: CsvRow[], defaultAccountId: string): Promise<CsvMerge>;
  netWorthReport(): Promise<NetWorthReport>;
  /** İşleme belge ekler (fotoğraf ya da PDF, en çok 10 MB) */
  addAttachment(transactionId: string, file: File): Promise<Attachment>;
  listAttachments(transactionId: string): Promise<Attachment[]>;
  /** İşlem kimliği → ek sayısı */
  attachmentCounts(): Promise<Record<string, number>>;
  attachmentContent(a: Attachment): Promise<Blob>;
  deleteAttachment(id: string): Promise<void>;
  /** PDF fişten tutar ve tarih önerisi */
  parseReceipt(file: File): Promise<ReceiptHint>;
  /** Dönemsel raporlar: dönem, karşılaştırma, kırılım, gelir akışı */
  reportsReport(q: ReportsQuery): Promise<ReportsReport>;
  /** Uzun vadeli tahmin (bugünkü net servetten) */
  projectionReport(assumptions: ProjectionAssumptions): Promise<ProjectionReport>;
  listGoals(): Promise<Goal[]>;
  createGoal(input: GoalInput): Promise<Goal>;
  updateGoal(goal: Goal): Promise<Goal>;
  deleteGoal(id: string): Promise<void>;
  /** Hedeflerin ilerlemesi (Rust'ta hesaplanır) */
  goalsReport(): Promise<GoalsReport>;
  listTags(): Promise<Tag[]>;
  createTag(input: TagInput): Promise<Tag>;
  updateTag(tag: Tag): Promise<Tag>;
  deleteTag(id: string): Promise<void>;
  /** Etiket başına harcama ve bütçe (Rust'ta hesaplanır) */
  tagsReport(): Promise<TagsReport>;
  /** Seçili işlemlere toplu etiket ekler/kaldırır; güncellenen işlemleri döner */
  setTransactionTags(transactionIds: string[], add: string[], remove: string[]): Promise<Transaction[]>;
  /** TEFAS fon arama (kod ya da ad; Rust'ta) */
  fundsSearch(q: string): Promise<FundHit[]>;
  /** Masaüstü yerel mod: EVDS anahtarı girilmiş mi */
  evdsKeySet(): Promise<boolean>;
  setEvdsKey(key: string | null): Promise<void>;
}

export interface AppInfo {
  version: string;
  os: string;
  arch: string;
  schemaVersion: number | null;
}

export interface UninstallPlan {
  dataPaths: string[];
  customDatabase: string[];
  appRemoval: "bundle" | "uninstaller" | "appImage" | "manual" | "development";
  appPath: string | null;
}

export interface DatabaseInfo {
  path: string;
  isDefault: boolean;
  /** Seçili veritabanı açılışta açılamadığı için varsayılan kullanılıyorsa seçili olan yol */
  fallbackFrom?: string | null;
}

export interface DataSet {
  categories: Category[];
  accounts: Account[];
  transactions: Transaction[];
  recurring: RecurringItem[];
  budgets: Budget[];
  goals: Goal[];
  tags: Tag[];
}

const tauriApi: Api = {
  listCategories: () => invoke<Category[]>("list_categories"),
  createCategory: (input) => invoke<Category>("create_category", { input }),
  updateCategory: (category) => invoke<Category>("update_category", { category }),
  deleteCategory: (id) => invoke<void>("delete_category", { id }),
  listAccounts: () => invoke<Account[]>("list_accounts"),
  createAccount: (input) => invoke<Account>("create_account", { input }),
  updateAccount: (account) => invoke<Account>("update_account", { account }),
  deleteAccount: (id) => invoke<void>("delete_account", { id }),
  listTransactions: () => invoke<Transaction[]>("list_transactions"),
  createTransaction: (input) => invoke<Transaction>("create_transaction", { input }),
  updateTransaction: (transaction) => invoke<Transaction>("update_transaction", { transaction }),
  deleteTransaction: (id) => invoke<void>("delete_transaction", { id }),
  listRecurring: () => invoke<RecurringItem[]>("list_recurring"),
  createRecurring: (input) => invoke<RecurringItem>("create_recurring", { item: { ...input, id: "" } }),
  updateRecurring: (item) => invoke<RecurringItem>("update_recurring", { item }),
  setRecurringException: (id, month, amount, note) => invoke<RecurringItem>("set_recurring_exception", { id, month, amount, note }),
  deleteRecurring: (id) => invoke<void>("delete_recurring", { id }),
  autoPostRecurring: () => invoke<AutoPostResult>("auto_post_recurring"),
  depositMature: (id, renew) => invoke<{ account: Account; transaction: Transaction | null }>("deposit_mature", { id, renew }),
  resetSeed: () => invoke<ResetSeed>("reset_seed"),
  listBudgets: () => invoke<Budget[]>("list_budgets"),
  setBudget: (categoryId, amount) => invoke<void>("set_budget", { categoryId, amount }),
  setBudgetRollover: (categoryId, from) => invoke<void>("set_budget_rollover", { categoryId, from }),
  restore: ({ categories, accounts, transactions, recurring, budgets, goals, tags }) =>
    invoke<void>("restore_data", { categories, accounts, transactions, recurring, budgets, goals, tags }),
  getSettings: () => invoke<Partial<AppDataSettings>>("get_settings"),
  setSetting: (key, value) => invoke<void>("set_setting", { key, value }),
  dataLocation: () => invoke<string>("data_location"),
  backupDatabase: () => invoke<string>("backup_database"),
  databaseInfo: () => invoke<DatabaseInfo>("database_info"),
  saveDatabaseCopy: (path) => invoke<void>("save_database_copy", { path }),
  openDatabase: (path, create) => invoke<DatabaseInfo>("open_database", { path, create }),
  useDefaultDatabase: () => invoke<DatabaseInfo>("use_default_database"),
  appInfo: () => invoke<AppInfo>("app_info"),
  uninstallPlan: () => invoke<UninstallPlan>("uninstall_plan"),
  uninstallApp: (includeCustomDatabase) => invoke<void>("uninstall_app", { includeCustomDatabase }),
  latestRates: (refresh) => invoke<RateQuote[]>("rates_latest", { refresh }),
  rateAt: (code, date) => invoke<RateQuote | null>("rate_at", { code, date }),
  pnlReport: (from, to, kind) => invoke<PnlReport>("pnl_report", { from, to, kind: kind ?? null }),
  accountsReport: () => invoke<AccountsReport>("accounts_report"),
  budgetReport: (month) => invoke<BudgetReport>("budget_report", { month }),
  incomeStatus: () => invoke<IncomeStatus>("income_status"),
  cashPlan: (months) => invoke<CashPlanReport>("cash_plan", { months }),
  upcomingObligations: (days) => invoke<UpcomingObligations>("upcoming_obligations", { days }),
  debtPlan: () => invoke<DebtPlanReport>("debt_plan"),
  overview: (period) => invoke<OverviewReport>("overview", { period }),
  categoryUsage: () => invoke<CategoryUsageReport>("category_usage"),
  analysis: () => invoke<AnalysisReport>("analysis"),
  previewTransaction: (draft) => invoke<TransactionPreview>("preview_transaction", { draft }),
  previewAccount: (draft) => invoke<AccountPreview>("preview_account", { draft }),
  previewRecurring: (draft) => invoke<RecurringPreview>("preview_recurring", { draft }),
  statementRows: (request) => invoke<ImportRows>("statement_rows", { request }),
  previewStatementCard: (draft) => invoke<StatementCard>("preview_statement_card", { draft }),
  previewStatementTotals: (draft) => invoke<StatementTotals>("preview_statement_totals", { draft }),
  previewCategoryRule: (draft) => invoke<CategoryRulePreview>("preview_category_rule", { draft }),
  categorySuggestions: () => invoke<CategorySuggestions>("category_suggestions"),
  exportCsv: (transactionIds) => invoke<string>("export_csv", { transactionIds }),
  exportBackup: () => invoke<string>("export_backup"),
  parseBackup: (text) => invoke<Backup>("parse_backup", { text }),
  parseCsv: (text) => invoke<CsvParseResult>("parse_csv", { text }),
  mergeCsv: (rows, defaultAccountId) => invoke<CsvMerge>("merge_csv", { rows, defaultAccountId }),
  netWorthReport: () => invoke<NetWorthReport>("networth_report"),
  projectionReport: (assumptions) => invoke<ProjectionReport>("projection_report", { assumptions }),
  reportsReport: (q) => invoke<ReportsReport>("reports_report", { ...q }),
  addAttachment: async (transactionId, file) =>
    invoke<Attachment>("attachment_add", new Uint8Array(await file.arrayBuffer()), {
      headers: { "x-transaction-id": transactionId, "x-name": encodeURIComponent(file.name) },
    }),
  listAttachments: (transactionId) => invoke<Attachment[]>("attachment_list", { transactionId }),
  attachmentCounts: () => invoke<Record<string, number>>("attachment_counts"),
  attachmentContent: async (a) => new Blob([await invoke<ArrayBuffer>("attachment_content", { id: a.id })], { type: a.mime }),
  deleteAttachment: (id) => invoke<void>("attachment_delete", { id }),
  parseReceipt: async (file) => invoke<ReceiptHint>("receipt_parse", new Uint8Array(await file.arrayBuffer())),
  listGoals: () => invoke<Goal[]>("list_goals"),
  createGoal: (input) => invoke<Goal>("create_goal", { input }),
  updateGoal: (goal) => invoke<Goal>("update_goal", { goal }),
  deleteGoal: (id) => invoke<void>("delete_goal", { id }),
  goalsReport: () => invoke<GoalsReport>("goals_report"),
  listTags: () => invoke<Tag[]>("list_tags"),
  createTag: (input) => invoke<Tag>("create_tag", { input }),
  updateTag: (tag) => invoke<Tag>("update_tag", { tag }),
  deleteTag: (id) => invoke<void>("delete_tag", { id }),
  tagsReport: () => invoke<TagsReport>("tags_report"),
  setTransactionTags: (transactionIds, add, remove) => invoke<Transaction[]>("set_transaction_tags", { transactionIds, add, remove }),
  fundsSearch: (q) => invoke<FundHit[]>("funds_search", { q }),
  evdsKeySet: () => invoke<boolean>("evds_key_set"),
  setEvdsKey: (key) => invoke<void>("set_evds_key", { key }),
  rateHistory: (code, from, to) => invoke<RateQuote[]>("rate_history", { code, from, to }),
};

let current: Api = backend === "tauri" ? tauriApi : createHttpApi();

/** Masaüstünde veri yeri değişince (yerel ↔ sunucu) veri katmanı değiştirilir. */
export function setApi(impl: Api) {
  current = impl;
}

/** Etkin veri katmanı (her çağrı o anki uygulamaya gider). */
export const api: Api = new Proxy({} as Api, { get: (_target, key) => current[key as keyof Api] });

/** Yerel SQLite (masaüstü); sunucu modunda da taşıma/indirme için doğrudan kullanılır. */
export { tauriApi };

/** Tauri hataları string olarak gelir; tek tip mesaja çevir. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Beklenmeyen bir hata oluştu.";
}
