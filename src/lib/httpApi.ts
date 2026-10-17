import type { Api } from "./api";
import type { Account, Budget, Category, FundHit, NetWorthReport, PnlReport, RateQuote, RecurringItem, Transaction } from "./types";

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
    deleteRecurring: (x) => r<void>("DELETE", `/api/recurring/${id(x)}`),
    listBudgets: () => r<Budget[]>("GET", "/api/budgets"),
    setBudget: (categoryId, amount) => r<void>("PUT", `/api/budgets/${id(categoryId)}`, { amount }),
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
    netWorthReport: () => r<NetWorthReport>("GET", "/api/networth"),
    fundsSearch: (q) => r<FundHit[]>("GET", `/api/funds/search?q=${id(q)}`),
    evdsKeySet: async () => false,
    setEvdsKey: desktopOnly,
  };
}
