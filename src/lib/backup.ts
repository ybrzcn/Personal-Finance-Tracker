import { PALETTE } from "../components/CategoryForm";
import { makeDefaultAccount } from "./accounts";
import type { ParsedCsvRow } from "./csv";
import { todayISO } from "./format";
import { newId } from "./id";
import type { DataSet } from "./api";
import type { Account, AccountKind, AnalysisSettings, Backup, Budget, Category, DebtPlanSettings, RecurringItem, Transaction, TxType } from "./types";

export function createBackup(data: DataSet, debtPlan?: DebtPlanSettings, analysis?: AnalysisSettings): Backup {
  return {
    app: "finans",
    version: 3,
    exportedAt: new Date().toISOString(),
    ...data,
    ...(debtPlan ? { debtPlan } : {}),
    ...(analysis ? { analysis } : {}),
  };
}

/** Yedekteki analiz ayarlarını doğrular; geçersiz girdiler atlanır. */
function parseAnalysis(v: unknown): AnalysisSettings | undefined {
  if (!isObj(v)) return undefined;
  const overrides: AnalysisSettings["subscriptionOverrides"] = {};
  for (const [key, o] of Object.entries(isObj(v.subscriptionOverrides) ? v.subscriptionOverrides : {})) {
    if (!isObj(o)) continue;
    overrides[key] = {
      ...(typeof o.name === "string" && o.name.trim() ? { name: o.name.trim() } : {}),
      ...(o.period === "monthly" || o.period === "yearly" ? { period: o.period } : {}),
      ...(o.cancelled === true ? { cancelled: true } : {}),
    };
  }
  const ids = Array.isArray(v.forecastCategoryIds) ? v.forecastCategoryIds.filter((x): x is string => typeof x === "string") : null;
  return { subscriptionOverrides: overrides, forecastCategoryIds: ids };
}

/** Yedekteki borç planı ayarlarını doğrular; geçersiz girdiler atlanır. */
function parseDebtPlan(v: unknown): DebtPlanSettings | undefined {
  if (!isObj(v)) return undefined;
  const numbers = (o: unknown) =>
    Object.fromEntries(
      Object.entries(isObj(o) ? o : {}).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])),
    );
  const modes = ["full", "minimum", "fixed", "none"];
  const rules: DebtPlanSettings["debtRules"] = {};
  for (const [id, r] of Object.entries(isObj(v.debtRules) ? v.debtRules : {})) {
    if (!isObj(r) || !modes.includes(String(r.mode))) continue;
    const amount = num(r.amount);
    rules[id] = { mode: r.mode as DebtPlanSettings["debtRules"][string]["mode"], ...(amount !== null ? { amount } : {}) };
  }
  return {
    debtBudget: Math.max(0, num(v.debtBudget) ?? 0),
    debtBudgetOverrides: numbers(v.debtBudgetOverrides),
    debtRules: rules,
    debtCells: numbers(v.debtCells),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isCategoryType = (v: unknown) => v === "income" || v === "expense";
const isTxType = (v: unknown): v is TxType => v === "income" || v === "expense" || v === "transfer";
const isKind = (v: unknown): v is AccountKind => v === "bank" || v === "cash" || v === "credit_card" || v === "loan";
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** JSON yedeğini ayrıştırır ve temel şema doğrulaması yapar. v1 yedekler "Genel Hesap"a taşınır. */
export function parseBackup(text: string): Backup {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw "Dosya geçerli bir JSON değil.";
  }
  if (!isObj(data) || !Array.isArray(data.categories) || !Array.isArray(data.transactions)) {
    throw "Bu dosya bir Finans yedeği gibi görünmüyor (categories / transactions alanları eksik).";
  }
  const categories: Category[] = data.categories.map((c, i) => {
    if (!isObj(c) || typeof c.id !== "string" || typeof c.name !== "string" || !isCategoryType(c.type))
      throw `Yedekteki ${i + 1}. kategori geçersiz.`;
    return { id: c.id, name: c.name, type: c.type as Category["type"], color: typeof c.color === "string" ? c.color : "#64748b" };
  });

  const isV1 = !Array.isArray(data.accounts);
  const accounts: Account[] = isV1
    ? []
    : (data.accounts as unknown[]).map((a, i) => {
        if (!isObj(a) || typeof a.id !== "string" || typeof a.name !== "string" || !isKind(a.kind) || typeof a.openingDate !== "string")
          throw `Yedekteki ${i + 1}. hesap geçersiz.`;
        return {
          id: a.id,
          name: a.name,
          kind: a.kind,
          color: typeof a.color === "string" ? a.color : "#6366f1",
          openingBalance: num(a.openingBalance) ?? 0,
          openingDate: a.openingDate,
          creditLimit: num(a.creditLimit),
          interestRate: num(a.interestRate),
          statementDay: num(a.statementDay),
          dueDay: num(a.dueDay),
          minPaymentRate: num(a.minPaymentRate),
          sortOrder: num(a.sortOrder) ?? 0,
          archived: a.archived === true,
          termMonths: num(a.termMonths),
          firstDueDate: str(a.firstDueDate),
          installmentAmount: num(a.installmentAmount),
          taxRate: num(a.taxRate),
          fundingIncomeId: str(a.fundingIncomeId),
          openingPeriodSpending: num(a.openingPeriodSpending),
          openingInstallments: (Array.isArray(a.openingInstallments) ? a.openingInstallments : [])
            .filter((it: unknown): it is Record<string, unknown> => isObj(it) && typeof it.amount === "number" && typeof it.remaining === "number")
            .map((it) => ({ description: typeof it.description === "string" ? it.description : "", amount: it.amount as number, remaining: it.remaining as number })),
        };
      });

  let defaultAccount: Account | null = null;
  if (isV1) {
    const dates = data.transactions.map((t) => (isObj(t) && typeof t.date === "string" ? t.date : "")).filter(Boolean);
    defaultAccount = makeDefaultAccount(dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : todayISO());
    accounts.push(defaultAccount);
  }
  const accountIds = new Set(accounts.map((a) => a.id));

  const transactions: Transaction[] = data.transactions.map((t, i) => {
    if (!isObj(t) || typeof t.id !== "string" || typeof t.amount !== "number" || !isTxType(t.type) || typeof t.date !== "string")
      throw `Yedekteki ${i + 1}. işlem geçersiz.`;
    const accountId = defaultAccount ? defaultAccount.id : typeof t.accountId === "string" ? t.accountId : "";
    const toAccountId = typeof t.toAccountId === "string" ? t.toAccountId : null;
    if (!accountIds.has(accountId) || (t.type === "transfer" && (!toAccountId || !accountIds.has(toAccountId))))
      throw `Yedekteki ${i + 1}. işlemin hesabı bulunamadı.`;
    return {
      id: t.id,
      amount: t.amount,
      type: t.type,
      accountId,
      toAccountId: t.type === "transfer" ? toAccountId : null,
      categoryId: t.type !== "transfer" && typeof t.categoryId === "string" ? t.categoryId : null,
      date: t.date,
      description: typeof t.description === "string" ? t.description : "",
      installments: num(t.installments) ?? 1,
      budgetMonth: t.type === "income" && typeof t.budgetMonth === "string" ? t.budgetMonth : null,
      createdAt: typeof t.createdAt === "string" ? t.createdAt : "",
    };
  });
  const recurring: RecurringItem[] = (Array.isArray(data.recurring) ? data.recurring : []).map((r: unknown, i: number) => {
    if (!isObj(r) || typeof r.id !== "string" || typeof r.name !== "string" || !isCategoryType(r.type) || typeof r.amount !== "number")
      throw `Yedekteki ${i + 1}. düzenli kayıt geçersiz.`;
    return {
      id: r.id,
      name: r.name,
      type: r.type as RecurringItem["type"],
      amount: r.amount,
      day: num(r.day) ?? 1,
      accountId: str(r.accountId),
      categoryId: str(r.categoryId),
      active: r.active !== false,
      sortOrder: num(r.sortOrder) ?? 0,
      history: (Array.isArray(r.history) ? r.history : [])
        .filter((h: unknown): h is Record<string, unknown> => isObj(h) && typeof h.from === "string" && typeof h.amount === "number")
        .map((h) => ({ from: h.from as string, amount: h.amount as number })),
      exceptions: (Array.isArray(r.exceptions) ? r.exceptions : [])
        .filter((e: unknown): e is Record<string, unknown> => isObj(e) && typeof e.month === "string" && typeof e.amount === "number")
        .map((e) => ({ month: e.month as string, amount: e.amount as number, note: typeof e.note === "string" ? e.note : "" })),
      coversPreviousMonth: r.coversPreviousMonth === true,
      startDate: str(r.startDate),
      weekendShift: r.weekendShift === "before" || r.weekendShift === "after" ? r.weekendShift : "none",
    };
  });
  const budgets: Budget[] = (Array.isArray(data.budgets) ? data.budgets : [])
    .filter((b: unknown): b is Record<string, unknown> => isObj(b) && typeof b.categoryId === "string" && typeof b.amount === "number")
    .map((b) => ({ categoryId: b.categoryId as string, amount: b.amount as number }));
  const debtPlan = parseDebtPlan(data.debtPlan);
  const analysis = parseAnalysis(data.analysis);
  return {
    app: "finans",
    version: 3,
    exportedAt: String(data.exportedAt ?? ""),
    categories,
    accounts,
    transactions,
    recurring,
    budgets,
    ...(debtPlan ? { debtPlan } : {}),
    ...(analysis ? { analysis } : {}),
  };
}

/**
 * CSV satırlarını mevcut verinin üstüne ekler. Eksik kategoriler (ad + tür) otomatik oluşturulur.
 * Hesap adı eşleşmezse `defaultAccountId` kullanılır; hedef hesabı eşleşmeyen transferler atlanır.
 * Sonuç tek seferde (atomik) geri yüklenecek tam veri setidir.
 */
export function mergeCsvRows(
  rows: ParsedCsvRow[],
  data: { categories: Category[]; accounts: Account[]; transactions: Transaction[] },
  defaultAccountId: string,
): { categories: Category[]; transactions: Transaction[]; createdCategories: number; skippedTransfers: number } {
  const cats = [...data.categories];
  const key = (name: string, type: string) => `${type}:${name.trim().toLocaleLowerCase("tr")}`;
  const index = new Map(cats.map((c) => [key(c.name, c.type), c]));
  const accountByName = new Map(data.accounts.map((a) => [a.name.trim().toLocaleLowerCase("tr"), a]));
  const findAccount = (name: string) => (name ? accountByName.get(name.trim().toLocaleLowerCase("tr")) : undefined);
  const kindOf = new Map(data.accounts.map((a) => [a.id, a.kind]));
  let created = 0;
  let skippedTransfers = 0;
  const now = new Date().toISOString();

  const newTxs: Transaction[] = [];
  for (const r of rows) {
    const accountId = findAccount(r.accountName)?.id ?? defaultAccountId;
    if (r.type === "transfer") {
      const to = findAccount(r.toAccountName);
      if (!to || to.id === accountId) {
        skippedTransfers++;
        continue;
      }
      newTxs.push({
        id: newId(), amount: r.amount, type: "transfer", accountId, toAccountId: to.id, categoryId: null,
        date: r.date, description: r.description, installments: 1, createdAt: now,
      });
      continue;
    }
    let categoryId: string | null = null;
    if (r.categoryName) {
      let c = index.get(key(r.categoryName.trim().slice(0, 60), r.type));
      if (!c) {
        c = { id: newId(), name: r.categoryName.trim().slice(0, 60), type: r.type, color: PALETTE[(cats.length + created) % PALETTE.length] };
        cats.push(c);
        index.set(key(c.name, c.type), c);
        created++;
      }
      categoryId = c.id;
    }
    const installments = r.type === "expense" && kindOf.get(accountId) === "credit_card" ? r.installments : 1;
    newTxs.push({
      id: newId(), amount: r.amount, type: r.type, accountId, toAccountId: null, categoryId,
      date: r.date, description: r.description, installments, createdAt: now,
    });
  }

  return { categories: cats, transactions: [...data.transactions, ...newTxs], createdCategories: created, skippedTransfers };
}
