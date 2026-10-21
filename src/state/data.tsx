import { useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { api, errorMessage, type DataSet } from "../lib/api";
import type {
  Account,
  AccountInput,
  AppDataSettings,
  AppSettingKey,
  Budget,
  Category,
  CategoryInput,
  Goal,
  GoalInput,
  Tag,
  TagInput,
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
  goals: Goal[];
  tags: Tag[];
  tagById: Map<string, Tag>;
  /** O anki etiket kimlikleri (bileşen kapanmış olsa da güncel; ör. silme bildirimindeki "Geri al") */
  currentTagIds(): Set<string>;
  /** Veritabanındaki uygulama ayarları (borç planı, analiz); veritabanı değişince yeniden okunur */
  appSettings: Partial<AppDataSettings>;
  /** Ayarı hemen uygular ve veritabanına yazar; yazılamazsa geri alır ve hatayı fırlatır */
  saveSetting<K extends AppSettingKey>(key: K, value: AppDataSettings[K]): Promise<void>;
  /** Her ayar yazımı bitince (başarılı ya da geri alınmış) artar; ayarlardan hesaplanan raporlar yeniden alınır */
  settingsRev: number;
  categoryById: Map<string, Category>;
  accountById: Map<string, Account>;
  reload(): Promise<void>;
  /** İşlem listesini sıralı yeniden okur (birden çok işlem yazan akışlar sonda bir kez çağırır) */
  reloadTransactions(): Promise<void>;
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
  /** Ay istisnası (Rust ekler/değiştirir/kaldırır); `amount` null istisnayı kaldırır */
  setRecurringException(id: string, month: string, amount: number | null, note: string): Promise<RecurringItem>;
  deleteRecurring(id: string): Promise<void>;
  setBudget(categoryId: string, amount: number | null): Promise<void>;
  addGoal(input: GoalInput): Promise<Goal>;
  updateGoal(g: Goal): Promise<Goal>;
  deleteGoal(id: string): Promise<void>;
  addTag(input: TagInput): Promise<Tag>;
  updateTag(t: Tag): Promise<Tag>;
  deleteTag(id: string): Promise<void>;
  /** Seçili işlemlere toplu etiket; güncellenen işlem sayısı */
  setTransactionTags(ids: string[], add: string[], remove: string[]): Promise<number>;
  /** Mevcut veri seti (yedek için) */
  snapshot(): DataSet;
  /** Veritabanından/sunucudan taze okunan veri seti: tümünü değiştiren işlemler (içe aktarma) bunun üstüne kurulur,
   * böylece başka sekme/cihazda o arada yapılan değişiklikler silinmez */
  latest(): Promise<DataSet>;
  restore(data: DataSet): Promise<void>;
}


/**
 * Kayıttan sonra liste Rust'tan sıralı yeniden okunur (sıra kuralı Rust'ta). Okunamazsa kayıt yerelde eklenir ya da
 * değiştirilir; sırası bir sonraki okumada düzelir.
 */
async function refreshed<T extends { id: string }>(saved: T, fetch: () => Promise<T[]>, set: Dispatch<SetStateAction<T[]>>): Promise<T> {
  try {
    set(await fetch());
  } catch {
    set((xs) => (xs.some((x) => x.id === saved.id) ? xs.map((x) => (x.id === saved.id ? saved : x)) : [...xs, saved]));
  }
  return saved;
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [recurring, setRecurring] = useState<RecurringItem[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const tagsRef = useRef<Tag[]>([]);
  tagsRef.current = tags;
  const [appSettings, setAppSettings] = useState<Partial<AppDataSettings>>({});
  const [settingsRev, setSettingsRev] = useState(0);
  // Ayar yazımları: anahtar başına son yazımın sırası ve veritabanında doğrulanmış son değer
  // (art arda iki değişiklikte eski yazım başarısız olursa yeni değerin üzerine eski değer dönmesin)
  const settingWrites = useRef<Record<string, number>>({});
  const confirmedSettings = useRef<Partial<AppDataSettings>>({});

  const reload = useCallback(async () => {
    try {
      const [cats, accs, txs, recs, buds, gls, tgs, sets] = await Promise.all([
        api.listCategories(),
        api.listAccounts(),
        api.listTransactions(),
        api.listRecurring(),
        api.listBudgets(),
        api.listGoals(),
        api.listTags(),
        api.getSettings(),
      ]);
      setCategories(cats);
      setAccounts(accs);
      setTransactions(txs);
      setRecurring(recs);
      setBudgets(buds);
      setGoals(gls);
      setTags(tgs);
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
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
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
      goals,
      tags,
      tagById,
      currentTagIds: () => new Set(tagsRef.current.map((t) => t.id)),
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
        } finally {
          setSettingsRev((n) => n + 1);
        }
      },
      settingsRev,
      categoryById,
      accountById,
      reload,
      async reloadTransactions() {
        setTransactions(await api.listTransactions());
      },
      async addTransaction(input) {
        return refreshed(await api.createTransaction(input), api.listTransactions, setTransactions);
      },
      async updateTransaction(tx) {
        return refreshed(await api.updateTransaction(tx), api.listTransactions, setTransactions);
      },
      async deleteTransaction(id) {
        await api.deleteTransaction(id);
        setTransactions((xs) => xs.filter((x) => x.id !== id));
      },
      async addCategory(input) {
        return refreshed(await api.createCategory(input), api.listCategories, setCategories);
      },
      async updateCategory(cat) {
        return refreshed(await api.updateCategory(cat), api.listCategories, setCategories);
      },
      async deleteCategory(id) {
        await api.deleteCategory(id);
        setCategories((xs) => xs.filter((x) => x.id !== id));
        setBudgets((xs) => xs.filter((x) => x.categoryId !== id));
        setRecurring((xs) => xs.map((x) => (x.categoryId === id ? { ...x, categoryId: null } : x)));
        setTransactions((xs) => xs.map((x) => (x.categoryId === id ? { ...x, categoryId: null } : x)));
      },
      async addAccount(input) {
        return refreshed(await api.createAccount(input), api.listAccounts, setAccounts);
      },
      async updateAccount(acc) {
        return refreshed(await api.updateAccount(acc), api.listAccounts, setAccounts);
      },
      async deleteAccount(id) {
        await api.deleteAccount(id);
        setAccounts((xs) => xs.filter((x) => x.id !== id));
        // Veritabanında düzenli kayıtların hesabı boşaltılır (ON DELETE SET NULL); state de aynı olmalı
        setRecurring((xs) => xs.map((r) => (r.accountId === id ? { ...r, accountId: null } : r)));
        // Hedef bağlantısı da düşer (ON DELETE CASCADE)
        setGoals((xs) => xs.map((g) => (g.accountIds.includes(id) ? { ...g, accountIds: g.accountIds.filter((a) => a !== id) } : g)));
      },
      async addRecurring(input) {
        return refreshed(await api.createRecurring(input), api.listRecurring, setRecurring);
      },
      async updateRecurring(item) {
        const r = await refreshed(await api.updateRecurring(item), api.listRecurring, setRecurring);
        if (r.type !== "income")
          setAccounts((xs) => xs.map((a) => (a.fundingIncomeId === r.id ? { ...a, fundingIncomeId: null } : a)));
        return r;
      },
      async setRecurringException(id, month, amount, note) {
        return refreshed(await api.setRecurringException(id, month, amount, note), api.listRecurring, setRecurring);
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
      async addGoal(input) {
        return refreshed(await api.createGoal(input), api.listGoals, setGoals);
      },
      async updateGoal(goal) {
        return refreshed(await api.updateGoal(goal), api.listGoals, setGoals);
      },
      async deleteGoal(id) {
        await api.deleteGoal(id);
        setGoals((xs) => xs.filter((x) => x.id !== id));
      },
      async addTag(input) {
        const t = await api.createTag(input);
        setTags((xs) => [...xs, t]);
        return t;
      },
      async updateTag(tag) {
        const t = await api.updateTag(tag);
        setTags((xs) => xs.map((x) => (x.id === t.id ? t : x)));
        return t;
      },
      async deleteTag(id) {
        await api.deleteTag(id);
        setTags((xs) => xs.filter((x) => x.id !== id));
        setTransactions((xs) => xs.map((t) => (t.tagIds?.includes(id) ? { ...t, tagIds: t.tagIds.filter((x) => x !== id) } : t)));
      },
      async setTransactionTags(ids, add, remove) {
        const updated = await api.setTransactionTags(ids, add, remove);
        const byId = new Map(updated.map((t) => [t.id, t]));
        setTransactions((xs) => xs.map((t) => byId.get(t.id) ?? t));
        return updated.length;
      },
      snapshot: () => ({ categories, accounts, transactions, recurring, budgets, goals, tags }),
      async latest() {
        const [cats, accs, txs, recs, buds, gls, tgs] = await Promise.all([
          api.listCategories(),
          api.listAccounts(),
          api.listTransactions(),
          api.listRecurring(),
          api.listBudgets(),
          api.listGoals(),
          api.listTags(),
        ]);
        return { categories: cats, accounts: accs, transactions: txs, recurring: recs, budgets: buds, goals: gls, tags: tgs };
      },
      async restore(data) {
        await api.restore(data);
        await reload();
      },
    }),
    [loading, loadError, categories, accounts, transactions, recurring, budgets, goals, tags, tagById, appSettings, settingsRev, categoryById, accountById, reload],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData, DataProvider içinde kullanılmalı");
  return ctx;
}
