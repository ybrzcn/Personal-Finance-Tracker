import { cardSummary, toCents } from "./cards";
import { newId } from "./id";
import { DEFAULT_LOAN_TAX, liabilityBalanceCents } from "./loans";
import { instrumentByCode, isForeign, rateMicros, tlCents, toMinor, TRY } from "./fx";
import type { Account, Category, RateQuote, Transaction, TransactionInput } from "./types";

export const DEFAULT_ACCOUNT_NAME = "Genel Hesap";

export function makeDefaultAccount(openingDate: string): Account {
  return {
    id: newId(),
    name: DEFAULT_ACCOUNT_NAME,
    kind: "bank",
    color: "#6366f1",
    openingBalance: 0,
    openingDate,
    creditLimit: null,
    interestRate: null,
    statementDay: null,
    dueDay: null,
    minPaymentRate: null,
    sortOrder: 0,
    archived: false,
    termMonths: null,
    firstDueDate: null,
    installmentAmount: null,
    taxRate: null,
    fundingIncomeId: null,
    openingPeriodSpending: null,
    openingInstallments: [],
    currency: TRY,
    openingCost: null,
  };
}

export const sortAccounts = (a: Account, b: Account) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "tr");

export const accountUsage = (txs: Transaction[], accountId: string) =>
  txs.filter((t) => t.accountId === accountId || t.toAccountId === accountId).length;

/**
 * Banka/nakit bakiyesi: açılış + gelir − gider + gelen transfer − giden transfer.
 * `asOf` verilirse o tarihten sonraki (ileri tarihli, planlanan) işlemler sayılmaz.
 */
export function bankBalanceCents(account: Account, txs: Transaction[], asOf?: string): number {
  let b = toCents(account.openingBalance);
  for (const t of txs) {
    if (asOf && t.date > asOf) continue;
    const c = toCents(t.amount);
    if (t.accountId === account.id) b += t.type === "income" ? c : -c;
    if (t.type === "transfer" && t.toAccountId === account.id) b += c;
  }
  return b;
}

/** TL dışı hesabın kendi birimindeki bakiyesi (en küçük birim): açılış + miktarlar. */
export function nativeBalanceMinor(account: Account, txs: Transaction[], asOf?: string): number {
  let b = toMinor(account.openingBalance, account.currency);
  for (const t of txs) {
    if (asOf && t.date > asOf) continue;
    if (t.accountId === account.id && t.origAmount != null) b += (t.type === "income" ? 1 : -1) * toMinor(t.origAmount, account.currency);
    if (t.type === "transfer" && t.toAccountId === account.id && t.toOrigAmount != null) b += toMinor(t.toOrigAmount, account.currency);
  }
  return b;
}

/** TL dışı hesabın güncel alış kuruyla TL karşılığı (kuruş); kur yoksa null. */
export function fxValueCents(account: Account, txs: Transaction[], rates: Map<string, RateQuote>, asOf?: string): number | null {
  const q = rates.get(account.currency);
  if (!q) return null;
  const minor = nativeBalanceMinor(account, txs, asOf);
  if (minor === 0) return 0;
  return Math.sign(minor) * tlCents(Math.abs(minor), rateMicros(q.buy), account.currency);
}

export interface BankSummary {
  balanceCents: number;
  overdraftUsedCents: number;
  /** Bakiye + KMH limiti; KMH yoksa null */
  availableCents: number | null;
}

export function bankSummary(account: Account, txs: Transaction[], asOf?: string): BankSummary {
  const balanceCents = bankBalanceCents(account, txs, asOf);
  const isBank = account.kind === "bank";
  const limit = isBank && account.creditLimit !== null ? toCents(account.creditLimit) : null;
  return {
    balanceCents,
    overdraftUsedCents: isBank ? Math.max(0, -balanceCents) : 0,
    availableCents: limit === null ? null : balanceCents + limit,
  };
}

export interface NetPosition {
  assetsCents: number;
  cardDebtCents: number;
  loanDebtCents: number;
  overdraftCents: number;
  netCents: number;
  /** Kur alınamadığı için toplama katılmayan döviz/altın hesabı sayısı */
  unvaluedCount: number;
}

export function netPosition(accounts: Account[], txs: Transaction[], today: string, rates: Map<string, RateQuote> = new Map()): NetPosition {
  let unvalued = 0;
  let assets = 0;
  let cardDebt = 0;
  let overdraft = 0;
  let loanDebt = 0;
  for (const a of accounts) {
    if (a.kind === "loan") {
      loanDebt += Math.max(0, liabilityBalanceCents(a, txs));
      continue;
    }
    if (a.kind === "credit_card") {
      cardDebt += Math.max(0, cardSummary(a, txs, today).totalDebtCents);
      continue;
    }
    if (isForeign(a.currency)) {
      const v = fxValueCents(a, txs, rates, today);
      if (v === null) unvalued++;
      else assets += v;
      continue;
    }
    const b = bankBalanceCents(a, txs, today);
    if (a.kind === "bank" && b < 0) overdraft += -b;
    else assets += b;
  }
  return {
    assetsCents: assets,
    cardDebtCents: cardDebt,
    loanDebtCents: loanDebt,
    overdraftCents: overdraft,
    netCents: assets - cardDebt - loanDebt - overdraft,
    unvaluedCount: unvalued,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Rust tarafındaki `clean_account` ile aynı kurallar (tarayıcı modu için). Geçersizse mesaj fırlatır. */
export function normalizeAccount(a: Account): Account {
  const name = a.name.trim();
  if (!name) throw "Hesap adı boş olamaz.";
  const currency = a.currency || TRY;
  if (currency !== TRY && !instrumentByCode.has(currency)) throw `Bilinmeyen para birimi: ${currency}`;
  const foreign = currency !== TRY;
  if (foreign && a.kind !== "bank" && a.kind !== "cash") throw "Kredi kartı ve kredi hesapları yalnızca TL olabilir.";
  if ([...name].length > 60) throw "Hesap adı en fazla 60 karakter olabilir.";
  if (!["bank", "cash", "credit_card", "loan"].includes(a.kind)) throw "Geçersiz hesap türü.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.openingDate)) throw `Geçersiz tarih: ${a.openingDate} (YYYY-AA-GG bekleniyor).`;
  if (!Number.isFinite(a.openingBalance)) throw "Geçersiz tutar.";
  const card = a.kind === "credit_card";
  const cash = a.kind === "cash";
  const loan = a.kind === "loan";
  const day = (v: number | null, label: string) => {
    if (v === null || !Number.isInteger(v) || v < 1 || v > 31) throw `${label} 1 ile 31 arasında olmalıdır.`;
    return v;
  };
  const rate = (v: number | null, label: string) => {
    if (v === null) return null;
    if (!Number.isFinite(v) || v < 0 || v > 100) throw `${label} 0 ile 100 arasında olmalıdır.`;
    return round2(v);
  };
  let creditLimit: number | null = null;
  if (loan) {
    if (!Number.isInteger(a.termMonths) || (a.termMonths ?? 0) < 1 || (a.termMonths ?? 0) > 600) throw "Vade 1 ile 600 ay arasında olmalıdır.";
    if (!a.firstDueDate || !/^\d{4}-\d{2}-\d{2}$/.test(a.firstDueDate)) throw "Geçerli bir ilk taksit tarihi girin.";
    if (a.installmentAmount !== null && !(a.installmentAmount > 0)) throw "Taksit tutarı sıfırdan büyük olmalıdır.";
  }
  if (!cash && !loan && !foreign && a.creditLimit !== null) {
    if (!Number.isFinite(a.creditLimit) || a.creditLimit < 0) throw "Limit negatif olamaz.";
    creditLimit = round2(a.creditLimit);
  }
  return {
    ...a,
    name,
    currency,
    openingCost: foreign && a.openingCost != null && a.openingCost > 0 && a.openingBalance > 0 ? round2(a.openingCost) : null,
    openingBalance: foreign ? a.openingBalance : round2(a.openingBalance),
    creditLimit,
    interestRate: cash || foreign ? null : rate(a.interestRate, "Faiz oranı"),
    statementDay: card ? day(a.statementDay, "Kesim günü") : null,
    dueDay: card ? day(a.dueDay, "Son ödeme günü") : null,
    minPaymentRate: card ? rate(a.minPaymentRate ?? 20, "Asgari ödeme oranı") : null,
    sortOrder: Math.trunc(a.sortOrder) || 0,
    archived: !!a.archived,
    termMonths: loan ? a.termMonths : null,
    firstDueDate: loan ? a.firstDueDate : null,
    installmentAmount: loan && a.installmentAmount !== null ? round2(a.installmentAmount) : null,
    taxRate: loan ? rate(a.taxRate ?? DEFAULT_LOAN_TAX, "Vergi oranı") : null,
    fundingIncomeId: card || loan ? a.fundingIncomeId || null : null,
    openingPeriodSpending: card && a.openingPeriodSpending ? round2(a.openingPeriodSpending) : null,
    openingInstallments: card
      ? (a.openingInstallments ?? []).map((it, i) => {
          if (!(it.amount > 0)) throw `${i + 1}. taksit: aylık tutar sıfırdan büyük olmalıdır.`;
          if (!Number.isInteger(it.remaining) || it.remaining < 1 || it.remaining > 36)
            throw `${i + 1}. taksit: kalan taksit 1 ile 36 arasında olmalıdır.`;
          return { description: it.description.trim().slice(0, 100), amount: round2(it.amount), remaining: it.remaining };
        })
      : [],
  };
}

/** Rust tarafındaki `check_transaction` ile aynı kurallar. Geçersizse mesaj fırlatır. */
export function validateTransaction(t: TransactionInput, accounts: Account[], categories: Category[], isNew: boolean): void {
  if (!(t.amount > 0) || !Number.isFinite(t.amount)) throw "Tutar sıfırdan büyük olmalıdır.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) throw "Geçersiz tarih.";
  const find = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    if (!a) throw "Seçilen hesap bulunamadı.";
    if (isNew && a.archived) throw "Arşivlenmiş hesaba yeni işlem eklenemez.";
    return a;
  };
  const account = find(t.accountId);
  if (t.type === "transfer") {
    if (!t.toAccountId) throw "Transfer için hedef hesap seçilmelidir.";
    if (t.toAccountId === t.accountId) throw "Kaynak ve hedef hesap aynı olamaz.";
    // Arşivlenmiş kart/kredinin kalan borcu yine de ödenebilir
    const to = accounts.find((x) => x.id === t.toAccountId);
    if (!(to && to.archived && (to.kind === "credit_card" || to.kind === "loan"))) find(t.toAccountId);
    if (t.categoryId) throw "Transferlere kategori atanamaz.";
  } else {
    if (t.toAccountId) throw "Hedef hesap yalnızca transferde kullanılır.";
    if (t.categoryId) {
      const c = categories.find((x) => x.id === t.categoryId);
      if (!c) throw "Seçilen kategori bulunamadı.";
      if (c.type !== t.type) throw "Kategori türü ile işlem türü uyuşmuyor.";
    }
  }
  if (!Number.isInteger(t.installments) || t.installments < 1 || t.installments > 36)
    throw "Taksit sayısı 1 ile 36 arasında olmalıdır.";
  if (t.installments > 1 && !(t.type === "expense" && account.kind === "credit_card"))
    throw "Taksit yalnızca kredi kartı harcamalarında kullanılabilir.";
}
