export type TxType = "income" | "expense" | "transfer";
export type CategoryType = "income" | "expense";
export type AccountKind = "bank" | "cash" | "credit_card" | "loan";

export interface Category {
  id: string;
  name: string;
  type: CategoryType;
  color: string;
}

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  color: string;
  /** bank/cash: açılış bakiyesi (eksi = KMH kullanımı). credit_card: açılış borcu (pozitif). */
  openingBalance: number;
  /** YYYY-MM-DD */
  openingDate: string;
  /** Kart limiti veya KMH limiti */
  creditLimit: number | null;
  /** Aylık akdi faiz, yüzde (4,25 → 4.25) */
  interestRate: number | null;
  /** Yalnız kart: kesim günü (1-31) */
  statementDay: number | null;
  /** Yalnız kart: son ödeme günü (1-31) */
  dueDay: number | null;
  /** Yalnız kart: asgari ödeme oranı, yüzde */
  minPaymentRate: number | null;
  sortOrder: number;
  archived: boolean;
  /** Yalnız kredi: vade (ay) */
  termMonths: number | null;
  /** Yalnız kredi: ilk taksit tarihi */
  firstDueDate: string | null;
  /** Yalnız kredi: aylık taksit tutarı (boşsa hesaplanır) */
  installmentAmount: number | null;
  /** Yalnız kredi: faize eklenen vergi (KKDF + BSMV), yüzde */
  taxRate: number | null;
  /** Kart/kredi ödemesinin karşılanacağı düzenli gelir; null = otomatik (son ödemeden önceki son gelir) */
  fundingIncomeId: string | null;
  /** Yalnız kart: eklendiği gün açık dönemdeki taksitsiz harcamalar (sonraki ekstreye yazılır) */
  openingPeriodSpending: number | null;
  /** Yalnız kart: eklendiği gün devam eden taksitler */
  openingInstallments: OpeningInstallment[];
}

/** Kart eklenirken girilen, devam eden taksitli harcama. */
export interface OpeningInstallment {
  description: string;
  /** Aylık taksit tutarı */
  amount: number;
  /** Kalan taksit sayısı (bir sonraki ekstre dahil) */
  remaining: number;
}

/** Düzenli gelir (maaş) veya gider (kira, fatura, abonelik). */
export interface RecurringItem {
  id: string;
  name: string;
  type: CategoryType;
  amount: number;
  /** Ayın günü (1-31) */
  day: number;
  accountId: string | null;
  categoryId: string | null;
  active: boolean;
  sortOrder: number;
  /** Tutar değişiklikleri (zam, kira artışı): `from` tarihinden itibaren `amount`; `amount` alanı ilk tutardır */
  history: AmountChange[];
  /** Tek aya özel tutar (0 = o ay yok, ör. ücretsiz izin) */
  exceptions: MonthException[];
  /** Gelir bir önceki ayın karşılığı (ör. 10 Ekim'de yatan maaş Eylül maaşıdır) */
  coversPreviousMonth: boolean;
  /** Başlangıç tarihi (YYYY-MM-DD); öncesindeki aylara uygulanmaz. null = sınırsız */
  startDate: string | null;
  /** Gün hafta sonuna denk gelirse: kaydırılmaz / önceki Cuma / sonraki Pazartesi */
  weekendShift: WeekendShift;
}

export type WeekendShift = "none" | "before" | "after";

export interface MonthException {
  /** YYYY-MM */
  month: string;
  amount: number;
  note: string;
}

export interface AmountChange {
  /** YYYY-MM-DD */
  from: string;
  amount: number;
}

export interface Budget {
  categoryId: string;
  amount: number;
}

export interface Transaction {
  id: string;
  /** Pozitif tutar; yönü `type` belirler. */
  amount: number;
  type: TxType;
  /** Gelir/gider: işlemin hesabı. Transfer: kaynak hesap. */
  accountId: string;
  /** Yalnız transfer: hedef hesap */
  toAccountId: string | null;
  categoryId: string | null;
  /** YYYY-MM-DD (yerel tarih) */
  date: string;
  description: string;
  /** Taksit sayısı; yalnız kredi kartı giderinde > 1 */
  installments: number;
  /** Yalnız gelir: bütçede sayılacağı ay (YYYY-MM); boş = otomatik (işlem tarihinin ayı) */
  budgetMonth?: string | null;
  /** ISO zaman damgası */
  createdAt: string;
}

export type CategoryInput = Omit<Category, "id">;
export type AccountInput = Omit<Account, "id">;
export type TransactionInput = Omit<Transaction, "id" | "createdAt">;
export type RecurringInput = Omit<RecurringItem, "id">;

export interface Backup {
  app: "finans";
  version: 3;
  exportedAt: string;
  categories: Category[];
  accounts: Account[];
  transactions: Transaction[];
  recurring: RecurringItem[];
  budgets: Budget[];
  /** Borç planı ayarları (aylık tutar, aya özel tutarlar, "Kendi planım" kuralları ve hücreleri); eski yedeklerde yok */
  debtPlan?: DebtPlanSettings;
  /** Analiz ayarları (abonelik düzeltmeleri, tahmin edilen kategoriler); eski yedeklerde yok */
  analysis?: AnalysisSettings;
  /** Kullanıcının otomatik kategori kuralları; eski yedeklerde yok */
  categoryRules?: CategoryRule[];
}

export type SubscriptionPeriod = "monthly" | "yearly";

/** Kullanıcının otomatik bulunan bir aboneliğe yaptığı düzeltme. */
export interface SubscriptionOverride {
  name?: string;
  period?: SubscriptionPeriod;
  cancelled?: boolean;
}

/** Veritabanında saklanan, cihazlar arasında taşınan uygulama ayarları */
export type AppDataSettings = DebtPlanSettings & AnalysisSettings & CategoryRuleSettings;
export type AppSettingKey = keyof AppDataSettings;
export const APP_SETTING_KEYS: AppSettingKey[] = [
  "debtBudget",
  "debtBudgetOverrides",
  "debtRules",
  "debtCells",
  "subscriptionOverrides",
  "forecastCategoryIds",
  "categoryRules",
];

/** "Açıklamada şu kelimelerden biri geçerse → bu kategori" kuralı. */
export interface CategoryRule {
  id: string;
  /** Tam kelime ya da kelime grubu olarak aranır (büyük/küçük harf ve Türkçe karakter farkı gözetilmez) */
  words: string[];
  type: CategoryType;
  categoryId: string;
}

export interface CategoryRuleSettings {
  categoryRules: CategoryRule[];
}

export interface AnalysisSettings {
  /** Abonelik anahtarı → düzeltme */
  subscriptionOverrides: Record<string, SubscriptionOverride>;
  /** Tahmini gösterilen kategoriler; null = varsayılan (Eğlence, Restoran, Kafe, Market) */
  forecastCategoryIds: string[] | null;
}

export type DebtRuleMode = "full" | "minimum" | "fixed" | "none";

export interface DebtPlanSettings {
  /** Aylık borçlara ayrılan tutar (TL; 0 = asgari toplamı) */
  debtBudget: number;
  /** Aya özel ayrılan tutarlar (YYYY-MM → TL) */
  debtBudgetOverrides: Record<string, number>;
  /** "Kendi planım": borç başına kural (hesap id → kural) */
  debtRules: Record<string, { mode: DebtRuleMode; amount?: number }>;
  /** "Kendi planım": elle girilen aylık ödemeler ("YYYY-MM:hesapId" → TL; -1 = tamamını öde) */
  debtCells: Record<string, number>;
}

export const TYPE_LABEL: Record<TxType, string> = {
  income: "Gelir",
  expense: "Gider",
  transfer: "Transfer",
};

export const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  bank: "Vadesiz Hesap",
  cash: "Nakit",
  credit_card: "Kredi Kartı",
  loan: "Kredi",
};
