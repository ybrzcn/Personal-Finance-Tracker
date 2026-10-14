import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { sortAccounts } from "../lib/accounts";
import { api, errorMessage, type DataSet } from "../lib/api";
import { sortTransactions } from "../lib/stats";
import type {
  Account,
  AccountInput,
  AppDataSettings,
  AppSettingKey,
  Budget,
  Category,
  CategoryInput,
  RecurringInput,
  RecurringItem,
  Transaction,
  TransactionInput,
} from "../lib/types";
import { DataContext } from "./contexts";

export interface DataCtx {
  loading: boolean;
  loadError: string | null;
  categories: Category[];
  accounts: Account[];
  transactions: Transaction[];
  recurring: RecurringItem[];
  budgets: Budget[];
  /** Veritabanındaki uygulama ayarları (borç planı, analiz); veritabanı değişince yeniden okunur */
  appSettings: Partial<AppDataSettings>;
  /** Ayarı hemen uygular ve veritabanına yazar; yazılamazsa geri alır ve hatayı fırlatır */
  saveSetting<K extends AppSettingKey>(key: K, value: AppDataSettings[K]): Promise<void>;
  categoryById: Map<string, Category>;
  accountById: Map<string, Account>;
  reload(): Promise<void>;
  addTransaction(input: TransactionInput): Promise<Transaction>;
  updateTransaction(t: Transaction): Promise<Transaction>;
  deleteTransaction(id: string): Promise<void>;
  addCategory(input: CategoryInput): Promise<Category>;
  updateCategory(c: Category): Promise<Category>;
  deleteCategory(id: string): Promise<void>;
  addAccount(input: AccountInput): Promise<Account>;
  updateAccount(a: Account): Promise<Account>;
  deleteAccount(id: string): Promise<void>;
  addRecurring(input: RecurringInput): Promise<RecurringItem>;
  updateRecurring(r: RecurringItem): Promise<RecurringItem>;
  deleteRecurring(id: string): Promise<void>;
  setBudget(categoryId: string, amount: number | null): Promise<void>;
  /** Mevcut veri seti (yedek için) */
  snapshot(): DataSet;
  /** Veritabanından/sunucudan taze okunan veri seti: tümünü değiştiren işlemler (içe aktarma) bunun üstüne kurulur,
   * böylece başka sekme/cihazda o arada yapılan değişiklikler silinmez */
  latest(): Promise<DataSet>;
  restore(data: DataSet): Promise<void>;
}


const sortRecurring = (a: RecurringItem, b: RecurringItem) =>
  a.type === b.type ? a.day - b.day || a.sortOrder - b.sortOrder : a.type === "income" ? -1 : 1;

const sortCategories = (a: Category, b: Category) =>
  a.type === b.type ? a.name.localeCompare(b.name, "tr") : a.type === "income" ? -1 : 1;

export function DataProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [recurring, setRecurring] = useState<RecurringItem[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [appSettings, setAppSettings] = useState<Partial<AppDataSettings>>({});
  // Ayar yazımları: anahtar başına son yazımın sırası ve veritabanında doğrulanmış son değer
  // (art arda iki değişiklikte eski yazım başarısız olursa yeni değerin üzerine eski değer dönmesin)
  const settingWrites = useRef<Record<string, number>>({});
  const confirmedSettings = useRef<Partial<AppDataSettings>>({});

  const reload = useCallback(async () => {
    try {
      const [cats, accs, txs, recs, buds, sets] = await Promise.all([
        api.listCategories(),
        api.listAccounts(),
        api.listTransactions(),
        api.listRecurring(),
        api.listBudgets(),
        api.getSettings(),
      ]);
      setCategories([...cats].sort(sortCategories));
      setAccounts([...accs].sort(sortAccounts));
      setTransactions([...txs].sort(sortTransactions));
      setRecurring([...recs].sort(sortRecurring));
      setBudgets(buds);
      setAppSettings(sets);
      confirmedSettings.current = sets;
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const value = useMemo<DataCtx>(
    () => ({
      loading,
      loadError,
      categories,
      accounts,
      transactions,
      recurring,
      budgets,
      appSettings,
      async saveSetting(key, value) {
        const seq = (settingWrites.current[key] ?? 0) + 1;
        settingWrites.current[key] = seq;
        setAppSettings((s) => ({ ...s, [key]: value }));
        try {
          await api.setSetting(key, value);
          confirmedSettings.current = { ...confirmedSettings.current, [key]: value };
        } catch (e) {
          // Yalnız bu hâlâ son yazımsa geri alınır; yerine veritabanındaki son doğrulanmış değer konur
          // Daha önce hiç kaydedilmemiş anahtar silinir; `undefined` bırakılırsa varsayılanın üzerine yazar
          if (settingWrites.current[key] === seq)
            setAppSettings((s) => {
              const { [key]: _, ...rest } = s;
              const prev = confirmedSettings.current[key];
              return prev === undefined ? rest : { ...rest, [key]: prev };
            });
          throw e;
        }
      },
      categoryById,
      accountById,
      reload,
      async addTransaction(input) {
        const t = await api.createTransaction(input);
        setTransactions((xs) => [...xs, t].sort(sortTransactions));
        return t;
      },
      async updateTransaction(tx) {
        const t = await api.updateTransaction(tx);
        setTransactions((xs) => xs.map((x) => (x.id === t.id ? t : x)).sort(sortTransactions));
        return t;
      },
      async deleteTransaction(id) {
        await api.deleteTransaction(id);
        setTransactions((xs) => xs.filter((x) => x.id !== id));
      },
      async addCategory(input) {
        const c = await api.createCategory(input);
        setCategories((xs) => [...xs, c].sort(sortCategories));
        return c;
      },
      async updateCategory(cat) {
        const c = await api.updateCategory(cat);
        setCategories((xs) => xs.map((x) => (x.id === c.id ? c : x)).sort(sortCategories));
        return c;
      },
      async deleteCategory(id) {
        await api.deleteCategory(id);
        setCategories((xs) => xs.filter((x) => x.id !== id));
        setBudgets((xs) => xs.filter((x) => x.categoryId !== id));
        setRecurring((xs) => xs.map((x) => (x.categoryId === id ? { ...x, categoryId: null } : x)));
        setTransactions((xs) => xs.map((x) => (x.categoryId === id ? { ...x, categoryId: null } : x)));
      },
      async addAccount(input) {
        const a = await api.createAccount(input);
        setAccounts((xs) => [...xs, a].sort(sortAccounts));
        return a;
      },
      async updateAccount(acc) {
        const a = await api.updateAccount(acc);
        setAccounts((xs) => xs.map((x) => (x.id === a.id ? a : x)).sort(sortAccounts));
        return a;
      },
      async deleteAccount(id) {
        await api.deleteAccount(id);
        setAccounts((xs) => xs.filter((x) => x.id !== id));
        // Veritabanında düzenli kayıtların hesabı boşaltılır (ON DELETE SET NULL); state de aynı olmalı
        setRecurring((xs) => xs.map((r) => (r.accountId === id ? { ...r, accountId: null } : r)));
      },
      async addRecurring(input) {
        const r = await api.createRecurring(input);
        setRecurring((xs) => [...xs, r].sort(sortRecurring));
        return r;
      },
      async updateRecurring(item) {
        const r = await api.updateRecurring(item);
        setRecurring((xs) => xs.map((x) => (x.id === r.id ? r : x)).sort(sortRecurring));
        if (r.type !== "income")
          setAccounts((xs) => xs.map((a) => (a.fundingIncomeId === r.id ? { ...a, fundingIncomeId: null } : a)));
        return r;
      },
      async deleteRecurring(id) {
        await api.deleteRecurring(id);
        setRecurring((xs) => xs.filter((x) => x.id !== id));
        setAccounts((xs) => xs.map((a) => (a.fundingIncomeId === id ? { ...a, fundingIncomeId: null } : a)));
      },
      async setBudget(categoryId, amount) {
        await api.setBudget(categoryId, amount);
        setBudgets((xs) => [
          ...xs.filter((b) => b.categoryId !== categoryId),
          ...(amount && amount > 0 ? [{ categoryId, amount: Math.round(amount * 100) / 100 }] : []),
        ]);
      },
      snapshot: () => ({ categories, accounts, transactions, recurring, budgets }),
      async latest() {
        const [cats, accs, txs, recs, buds] = await Promise.all([
          api.listCategories(),
          api.listAccounts(),
          api.listTransactions(),
          api.listRecurring(),
          api.listBudgets(),
        ]);
        return { categories: cats, accounts: accs, transactions: txs, recurring: recs, budgets: buds };
      },
      async restore(data) {
        await api.restore(data);
        await reload();
      },
    }),
    [loading, loadError, categories, accounts, transactions, recurring, budgets, appSettings, categoryById, accountById, reload],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData, DataProvider içinde kullanılmalı");
  return ctx;
}
