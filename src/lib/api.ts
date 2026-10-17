import { invoke } from "@tauri-apps/api/core";
import { accountUsage, makeDefaultAccount, normalizeAccount, validateTransaction } from "./accounts";
import { todayISO } from "./format";
import { isForeign } from "./fx";
import { newId } from "./id";
import { createHttpApi } from "./httpApi";
import { backend } from "./platform";
import { APP_SETTING_KEYS } from "./types";
import type {
  Account,
  AccountInput,
  AppDataSettings,
  AppSettingKey,
  Budget,
  Category,
  CategoryInput,
  FundHit,
  Goal,
  GoalInput,
  GoalsReport,
  PnlKind,
  NetWorthReport,
  PnlReport,
  RateQuote,
  RecurringInput,
  RecurringItem,
  Transaction,
  TransactionInput,
} from "./types";

/**
 * Veri erişim katmanı.
 * - Tauri içinde: Rust tarafındaki SQLite veritabanı (uygulama veri klasöründe).
 * - Tarayıcıda (`npm run dev`): localStorage — yalnızca arayüz geliştirme kolaylığı için.
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
  deleteRecurring(id: string): Promise<void>;
  listBudgets(): Promise<Budget[]>;
  /** `amount` null veya 0 ise bütçe kaldırılır. */
  setBudget(categoryId: string, amount: number | null): Promise<void>;
  /** Tüm veriyi atomik olarak verilenle değiştirir. */
  restore(data: DataSet): Promise<void>;
  /** Veritabanında saklanan uygulama ayarları (borç planı, analiz) */
  getSettings(): Promise<Partial<AppDataSettings>>;
  setSetting<K extends AppSettingKey>(key: K, value: AppDataSettings[K]): Promise<void>;
  dataLocation(): Promise<string>;
  /** Sıfırlamadan önce veritabanı dosyasının kopyasını alır (tarayıcı modunda null). */
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
  netWorthReport(): Promise<NetWorthReport>;
  listGoals(): Promise<Goal[]>;
  createGoal(input: GoalInput): Promise<Goal>;
  updateGoal(goal: Goal): Promise<Goal>;
  deleteGoal(id: string): Promise<void>;
  /** Hedeflerin ilerlemesi (Rust'ta hesaplanır) */
  goalsReport(): Promise<GoalsReport>;
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
  deleteRecurring: (id) => invoke<void>("delete_recurring", { id }),
  listBudgets: () => invoke<Budget[]>("list_budgets"),
  setBudget: (categoryId, amount) => invoke<void>("set_budget", { categoryId, amount }),
  restore: ({ categories, accounts, transactions, recurring, budgets, goals }) =>
    invoke<void>("restore_data", { categories, accounts, transactions, recurring, budgets, goals }),
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
  netWorthReport: () => invoke<NetWorthReport>("networth_report"),
  listGoals: () => invoke<Goal[]>("list_goals"),
  createGoal: (input) => invoke<Goal>("create_goal", { input }),
  updateGoal: (goal) => invoke<Goal>("update_goal", { goal }),
  deleteGoal: (id) => invoke<void>("delete_goal", { id }),
  goalsReport: () => invoke<GoalsReport>("goals_report"),
  fundsSearch: (q) => invoke<FundHit[]>("funds_search", { q }),
  evdsKeySet: () => invoke<boolean>("evds_key_set"),
  setEvdsKey: (key) => invoke<void>("set_evds_key", { key }),
  rateHistory: (code, from, to) => invoke<RateQuote[]>("rate_history", { code, from, to }),
};

// ---------------------------------------------------------------------------
// Tarayıcı yedeği (localStorage)
// ---------------------------------------------------------------------------

export const DEFAULT_CATEGORIES: CategoryInput[] = [
  { name: "Maaş", type: "income", color: "#10b981" },
  { name: "Ek Gelir", type: "income", color: "#14b8a6" },
  { name: "Yatırım", type: "income", color: "#06b6d4" },
  { name: "Diğer Gelir", type: "income", color: "#84cc16" },
  { name: "Kira", type: "expense", color: "#f43f5e" },
  { name: "Market", type: "expense", color: "#f97316" },
  { name: "Faturalar", type: "expense", color: "#eab308" },
  { name: "Ulaşım", type: "expense", color: "#3b82f6" },
  { name: "Eğlence", type: "expense", color: "#a855f7" },
  { name: "Sağlık", type: "expense", color: "#ec4899" },
  { name: "Restoran", type: "expense", color: "#92400e" },
  { name: "Kafe", type: "expense", color: "#b45309" },
  { name: "Giyim", type: "expense", color: "#65a30d" },
  { name: "Abonelikler", type: "expense", color: "#0ea5e9" },
  { name: "Nakit Avans", type: "expense", color: "#d946ef" },
  { name: "Diğer Gider", type: "expense", color: "#64748b" },
  { name: "Faiz ve Masraflar", type: "expense", color: "#78716c" },
];

const STORAGE_KEY = "finans-data-v1";

type LocalData = Omit<DataSet, "goals"> & { settings?: Partial<AppDataSettings> };

/** v1 localStorage verisini (hesapsız) v2'ye taşır. */
function upgradeLocal(raw: Partial<LocalData> & { transactions?: Partial<Transaction>[] }): LocalData {
  const categories = raw.categories ?? [];
  const extras = { recurring: (raw.recurring ?? []).map((r) => ({ ...r, history: r.history ?? [], exceptions: r.exceptions ?? [], coversPreviousMonth: !!r.coversPreviousMonth, startDate: r.startDate ?? null, weekendShift: r.weekendShift ?? "none" })), budgets: raw.budgets ?? [] };
  if (raw.accounts) {
    const accounts = raw.accounts.map((a) => ({ ...makeDefaultAccount(a.openingDate), ...a }));
    return { ...(raw as LocalData), accounts, ...extras };
  }
  const txs = raw.transactions ?? [];
  const opening = txs.reduce((min, t) => (t.date && t.date < min ? t.date : min), todayISO());
  const account = makeDefaultAccount(opening);
  return {
    categories,
    accounts: [account],
    transactions: txs.map((t) => ({ ...t, accountId: account.id, toAccountId: null, installments: 1 }) as Transaction),
    ...extras,
  };
}

function readLocal(): LocalData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = upgradeLocal(JSON.parse(raw));
      writeLocal(data);
      return data;
    }
  } catch {
    /* bozuk veri: varsayılanlarla başla */
  }
  const data: LocalData = {
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c, id: newId() })),
    accounts: [makeDefaultAccount(todayISO())],
    transactions: [],
    recurring: [],
    budgets: [],
  };
  writeLocal(data);
  return data;
}

function writeLocal(data: LocalData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function assertUniqueCategory(cats: Category[], c: CategoryInput, exceptId?: string) {
  const name = c.name.trim();
  if (!name) throw "Kategori adı boş olamaz.";
  const dup = cats.some(
    (x) => x.id !== exceptId && x.type === c.type && x.name.toLocaleLowerCase("tr") === name.toLocaleLowerCase("tr"),
  );
  if (dup) throw "Bu isimde ve türde bir kategori zaten mevcut.";
}

function assertUniqueAccount(accounts: Account[], a: Account) {
  if (accounts.some((x) => x.id !== a.id && x.name === a.name)) throw "Bu isimde bir hesap zaten mevcut.";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function assertRecurring(r: RecurringItem, d: LocalData): RecurringItem {
  const name = r.name.trim();
  if (!name) throw "Ad boş olamaz.";
  if (!(r.amount > 0)) throw "Tutar sıfırdan büyük olmalıdır.";
  if (!Number.isInteger(r.day) || r.day < 1 || r.day > 31) throw "Gün 1 ile 31 arasında olmalıdır.";
  if (r.accountId && !d.accounts.some((a) => a.id === r.accountId)) throw "Seçilen hesap bulunamadı.";
  if (r.categoryId) {
    const c = d.categories.find((x) => x.id === r.categoryId);
    if (!c) throw "Seçilen kategori bulunamadı.";
    if (c.type !== r.type) throw "Kategori türü ile işlem türü uyuşmuyor.";
  }
  for (const h of r.history ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h.from)) throw "Geçersiz değişiklik tarihi.";
    if (!(h.amount > 0)) throw "Tutar sıfırdan büyük olmalıdır.";
  }
  const history = [...(r.history ?? [])].map((h) => ({ from: h.from, amount: round2(h.amount) })).sort((a, b) => a.from.localeCompare(b.from));
  const exceptions = [...(r.exceptions ?? [])]
    .map((e) => {
      if (!/^\d{4}-\d{2}$/.test(e.month)) throw "Geçersiz ay.";
      if (!(e.amount >= 0)) throw "Tutar negatif olamaz.";
      return { month: e.month, amount: round2(e.amount), note: e.note.trim().slice(0, 60) };
    })
    .sort((a, b) => a.month.localeCompare(b.month));
  return { ...r, name, amount: round2(r.amount), history, exceptions, coversPreviousMonth: r.type === "income" && !!r.coversPreviousMonth, startDate: r.startDate || null, weekendShift: r.weekendShift ?? "none" };
}

const NEEDS_BACKEND = "Bu özellik sunucu ya da masaüstü uygulaması gerektirir.";

const localApi: Api = {
  async listCategories() {
    return readLocal().categories;
  },
  async createCategory(input) {
    const d = readLocal();
    assertUniqueCategory(d.categories, input);
    const c: Category = { ...input, name: input.name.trim(), id: newId() };
    d.categories.push(c);
    writeLocal(d);
    return c;
  },
  async updateCategory(category) {
    const d = readLocal();
    assertUniqueCategory(d.categories, category, category.id);
    const used = d.transactions.filter((t) => t.categoryId === category.id && t.type !== category.type).length;
    if (used) throw `Bu kategori ${used} işlemde kullanıldığı için türü değiştirilemez.`;
    const updated = { ...category, name: category.name.trim() };
    d.categories = d.categories.map((c) => (c.id === category.id ? updated : c));
    writeLocal(d);
    return updated;
  },
  async deleteCategory(id) {
    const d = readLocal();
    d.categories = d.categories.filter((c) => c.id !== id);
    d.budgets = d.budgets.filter((b) => b.categoryId !== id);
    d.recurring = d.recurring.map((r) => (r.categoryId === id ? { ...r, categoryId: null } : r));
    d.transactions = d.transactions.map((t) => (t.categoryId === id ? { ...t, categoryId: null } : t));
    writeLocal(d);
  },
  async listAccounts() {
    return readLocal().accounts;
  },
  async createAccount(input) {
    const d = readLocal();
    const a = normalizeAccount({ ...input, id: newId() });
    // Döviz kuralları (miktar, kur, kâr/zarar) yalnız Rust'ta: tarayıcı modunda döviz/altın hesabı açılmaz
    if (isForeign(a.currency)) throw NEEDS_BACKEND;
    assertUniqueAccount(d.accounts, a);
    d.accounts.push(a);
    writeLocal(d);
    return a;
  },
  async updateAccount(account) {
    const d = readLocal();
    const a = normalizeAccount(account);
    assertUniqueAccount(d.accounts, a);
    const prev = d.accounts.find((x) => x.id === a.id);
    if (!prev) throw "Hesap bulunamadı.";
    if (isForeign(a.currency) && a.currency !== prev.currency) throw NEEDS_BACKEND;
    if (prev.kind !== a.kind && accountUsage(d.transactions, a.id) > 0)
      throw "Bu hesapta işlem bulunduğu için türü değiştirilemez.";
    d.accounts = d.accounts.map((x) => (x.id === a.id ? a : x));
    writeLocal(d);
    return a;
  },
  async deleteAccount(id) {
    const d = readLocal();
    const used = accountUsage(d.transactions, id);
    if (used) throw `Bu hesapta ${used} işlem var; silmek yerine arşivleyin.`;
    d.accounts = d.accounts.filter((a) => a.id !== id);
    writeLocal(d);
  },
  async listTransactions() {
    return readLocal().transactions;
  },
  async createTransaction(input) {
    const d = readLocal();
    validateTransaction(input, d.accounts, d.categories, true);
    const t: Transaction = {
      ...input,
      amount: round2(input.amount),
      description: input.description.trim(),
      id: newId(),
      createdAt: new Date().toISOString(),
    };
    d.transactions.push(t);
    writeLocal(d);
    return t;
  },
  async updateTransaction(transaction) {
    const d = readLocal();
    validateTransaction(transaction, d.accounts, d.categories, false);
    const updated = { ...transaction, amount: round2(transaction.amount), description: transaction.description.trim() };
    d.transactions = d.transactions.map((t) => (t.id === transaction.id ? updated : t));
    writeLocal(d);
    return updated;
  },
  async deleteTransaction(id) {
    const d = readLocal();
    d.transactions = d.transactions.filter((t) => t.id !== id);
    writeLocal(d);
  },
  async listRecurring() {
    return readLocal().recurring;
  },
  async createRecurring(input) {
    const d = readLocal();
    const r = assertRecurring({ ...input, id: newId() }, d);
    d.recurring.push(r);
    writeLocal(d);
    return r;
  },
  async updateRecurring(item) {
    const d = readLocal();
    const r = assertRecurring(item, d);
    d.recurring = d.recurring.map((x) => (x.id === r.id ? r : x));
    if (r.type !== "income") d.accounts = d.accounts.map((a) => (a.fundingIncomeId === r.id ? { ...a, fundingIncomeId: null } : a));
    writeLocal(d);
    return r;
  },
  async deleteRecurring(id) {
    const d = readLocal();
    d.recurring = d.recurring.filter((x) => x.id !== id);
    d.accounts = d.accounts.map((a) => (a.fundingIncomeId === id ? { ...a, fundingIncomeId: null } : a));
    writeLocal(d);
  },
  async listBudgets() {
    return readLocal().budgets;
  },
  async setBudget(categoryId, amount) {
    const d = readLocal();
    d.budgets = d.budgets.filter((b) => b.categoryId !== categoryId);
    if (amount && amount > 0) {
      const c = d.categories.find((x) => x.id === categoryId);
      if (!c) throw "Kategori bulunamadı.";
      if (c.type !== "expense") throw "Bütçe yalnızca gider kategorilerine tanımlanabilir.";
      d.budgets.push({ categoryId, amount: round2(amount) });
    }
    writeLocal(d);
  },
  async restore({ categories, accounts, transactions, recurring, budgets }) {
    const normalized = accounts.map(normalizeAccount);
    const ids = new Set(categories.map((c) => c.id));
    const txs = transactions.map((t) => ({
      ...t,
      categoryId: t.type !== "transfer" && t.categoryId && ids.has(t.categoryId) ? t.categoryId : null,
    }));
    txs.forEach((t, i) => {
      try {
        validateTransaction(t, normalized, categories, false);
      } catch (e) {
        throw `${i + 1}. işlem: ${String(e)}`;
      }
    });
    const catIds = new Set(categories.filter((c) => c.type === "expense").map((c) => c.id));
    writeLocal({
      // Ayarlar veriyle birlikte değişmez (masaüstündeki settings tablosu gibi)
      settings: readLocal().settings,
      categories,
      accounts: normalized,
      transactions: txs,
      recurring,
      budgets: budgets.filter((b) => catIds.has(b.categoryId)),
    });
  },
  async getSettings() {
    return readLocal().settings ?? {};
  },
  async setSetting(key, value) {
    if (!APP_SETTING_KEYS.includes(key)) throw `Bilinmeyen ayar: ${key}`;
    const d = readLocal();
    d.settings = { ...d.settings, [key]: value };
    writeLocal(d);
  },
  async dataLocation() {
    return "Tarayıcı localStorage (geliştirme modu)";
  },
  async backupDatabase() {
    return null;
  },
  async databaseInfo() {
    return { path: "Tarayıcı localStorage (geliştirme modu)", isDefault: true };
  },
  async saveDatabaseCopy() {
    throw "Veritabanı dosyası işlemleri yalnızca masaüstü uygulamasında kullanılabilir.";
  },
  async openDatabase() {
    throw "Veritabanı dosyası işlemleri yalnızca masaüstü uygulamasında kullanılabilir.";
  },
  async useDefaultDatabase() {
    return { path: "Tarayıcı localStorage (geliştirme modu)", isDefault: true };
  },
  async appInfo() {
    return { version: "geliştirme (tarayıcı)", os: navigator.platform, arch: "-", schemaVersion: null };
  },
  async uninstallPlan() {
    return { dataPaths: ["Tarayıcı localStorage"], customDatabase: [], appRemoval: "development" as const, appPath: null };
  },
  async uninstallApp() {
    // Tarayıcı modunda yalnız yerel veriler silinir
    localStorage.clear();
    location.reload();
  },
  async latestRates() {
    return [];
  },
  async rateAt() {
    return null;
  },
  async rateHistory() {
    throw "Kur geçmişi yalnızca sunucuya bağlıyken görülebilir.";
  },
  async pnlReport() {
    throw NEEDS_BACKEND;
  },
  async netWorthReport() {
    throw NEEDS_BACKEND;
  },
  async listGoals() {
    return [];
  },
  async createGoal() {
    throw NEEDS_BACKEND;
  },
  async updateGoal() {
    throw NEEDS_BACKEND;
  },
  async deleteGoal() {
    throw NEEDS_BACKEND;
  },
  async goalsReport() {
    throw NEEDS_BACKEND;
  },
  async fundsSearch() {
    throw NEEDS_BACKEND;
  },
  async evdsKeySet() {
    return false;
  },
  async setEvdsKey() {
    throw "Bu özellik yalnız masaüstü uygulamasında.";
  },
};

let current: Api = backend === "tauri" ? tauriApi : backend === "http" ? createHttpApi() : localApi;

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
