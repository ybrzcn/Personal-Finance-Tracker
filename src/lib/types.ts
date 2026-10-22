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
  /** "TRY" ya da döviz/altın kodu (yalnız banka/nakit TL dışı olabilir); açılış bakiyesi bu birimde */
  currency: string;
  /** Yalnız döviz/altın: açılış bakiyesinin TL maliyeti (kâr/zarar); boşsa açılış günü kuru */
  openingCost: number | null;
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
  /** TL dışı hesapta: hesabın birimindeki miktar (`amount` planlar için TL tahmini) */
  origAmount?: number | null;
  /** Günü gelince plan tutarıyla işlem olarak kendiliğinden kaydedilir (hesap gerekir) */
  autoPost?: boolean;
  /** Otomatik kaydın işlendiği son ay (YYYY-MM); salt okunur */
  autoPostedUntil?: string | null;
}

export type WeekendShift = "none" | "before" | "after";

/** Rust `store::AutoPostResult`: eklenen işlemler ve eklenemeyen düzenli kayıtlar (o ödeme bekler) */
export interface AutoPostResult {
  created: Transaction[];
  failed: { recurringId: string; name: string; error: string }[];
}

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
  /** Devreden bütçe bu aydan (YYYY-MM) itibaren; null kapalı */
  rolloverFrom?: string | null;
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
  /** TL dışı kaynak hesapta: hesabın birimindeki miktar ve kuru (1 birimin TL fiyatı); `amount` TL karşılığıdır */
  origAmount?: number | null;
  fxRate?: number | null;
  /** Transferde TL dışı hedef hesap: hedefin birimindeki miktar ve kuru */
  toOrigAmount?: number | null;
  toFxRate?: number | null;
  /** Etiket kimlikleri */
  tagIds?: string[];
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
  /** Birikim hedefleri; eski yedeklerde yok */
  goals?: Goal[];
  /** İşlem etiketleri; eski yedeklerde yok */
  tags?: Tag[];
}

export type SubscriptionPeriod = "monthly" | "yearly";

/** Kullanıcının otomatik bulunan bir aboneliğe yaptığı düzeltme. */
export interface SubscriptionOverride {
  name?: string;
  period?: SubscriptionPeriod;
  cancelled?: boolean;
}

/** Veritabanında saklanan, cihazlar arasında taşınan uygulama ayarları */
export type AppDataSettings = DebtPlanSettings & AnalysisSettings & CategoryRuleSettings & ProjectionSettings;

/** Uzun Vade varsayımları (oranlar yıllık yüzde); Rust `projection::Assumptions` */
export interface ProjectionAssumptions {
  years: number;
  incomeGrowthPct: number;
  expenseGrowthPct: number;
  returnPct: number;
  /** Her ay eklenen (+) ya da çıkan (−) tutar, TL */
  monthlyExtra: number;
}

export interface ProjectionSettings {
  projection: Partial<ProjectionAssumptions>;
}

export interface ProjectionBase {
  incomeCents: number;
  regularExpenseCents: number;
  budgetCents: number;
  irregularExpenseCents: number;
  irregularMonths: number;
  loanCents: number;
  extraCents: number;
  netCents: number;
}

export interface ProjectionYear {
  year: number;
  endMonth: string;
  incomeCents: number;
  expenseCents: number;
  loanCents: number;
  extraCents: number;
  netFlowCents: number;
  /** Gelir + artı senaryo */
  inflowCents: number;
  /** Gider + taksit + eksi senaryo */
  outflowCents: number;
  returnCents: number;
  cashCents: number;
  debtCents: number;
  netWorthCents: number;
  /** Bugünün parasıyla */
  realNetWorthCents: number;
}

export interface ProjectionPoint {
  month: string;
  netWorthCents: number;
  realNetWorthCents: number;
  debtCents: number;
}

/** Rust `projection::ProjectionReport` */
export interface ProjectionReport {
  assumptions: ProjectionAssumptions;
  startMonth: string;
  startNetWorthCents: number;
  startLoanDebtCents: number;
  base: ProjectionBase;
  points: ProjectionPoint[];
  years: ProjectionYear[];
  debtFreeMonth: string | null;
  /** Borcu kalan ama taksit planı kalmamış kredi var */
  loanWithoutSchedule: boolean;
  firstNegativeMonth: string | null;
}
export type AppSettingKey = keyof AppDataSettings;
export const APP_SETTING_KEYS: AppSettingKey[] = [
  "debtBudget",
  "debtBudgetOverrides",
  "debtRules",
  "debtCells",
  "subscriptionOverrides",
  "forecastCategoryIds",
  "categoryRules",
  "projection",
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

/** Kur: 1 birimin TL fiyatı */
export interface RateQuote {
  code: string;
  source: "tcmb" | "harem" | "tefas";
  /** ISO zaman (UTC) */
  observedAt: string;
  buy: number;
  sell: number;
  /** Bir önceki günün son alışı (yalnız Postgres'li sunucuda) */
  prevBuy?: number | null;
  /** Fiyat eski (kaynağa ulaşılamıyor olabilir) */
  stale: boolean;
}

/** Kâr/zarar raporu (Rust finans-core::pnl). Tutarlar kuruş, kurlar ×1e6, yüzdeler baz puan, miktar en küçük birim. */
export interface AccountPnl {
  accountId: string;
  name: string;
  currency: string;
  qtyMinor: number;
  /** Gösterim miktarı (Rust) */
  qty: number;
  costCents: number | null;
  avgCostMicros: number | null;
  rateMicros: number | null;
  rateObservedAt: string | null;
  valueCents: number | null;
  unrealizedCents: number | null;
  unrealizedBp: number | null;
  realCostCents: number | null;
  realUnrealizedCents: number | null;
  realUnrealizedBp: number | null;
  inflationBp: number | null;
  costUnknown: boolean;
  inconsistentSince: string | null;
  rateStale: boolean;
  noRate: boolean;
  cpiApprox: boolean;
}
export interface RealizedItem {
  transactionId: string;
  date: string;
  accountId: string;
  kind: "expense" | "transfer";
  qtyMinor: number;
  /** Gösterim miktarı (Rust) */
  qty: number;
  currency: string;
  proceedsCents: number;
  costCents: number | null;
  pnlCents: number | null;
  realPnlCents: number | null;
  costUnknown: boolean;
  cpiApprox: boolean;
}
export interface MonthTotal {
  month: string;
  pnlCents: number;
  realPnlCents: number | null;
  /** Maliyeti bilinmeyen satış toplama girmedi */
  partial: boolean;
}
export interface PnlTotals {
  costCents: number;
  valueCents: number;
  unrealizedCents: number;
  unrealizedBp: number | null;
  realUnrealizedCents: number | null;
  realUnrealizedBp: number | null;
  inflationBp: number | null;
  realizedCents: number;
  realRealizedCents: number | null;
  partial: boolean;
}
export interface CpiInfo {
  status: "ok" | "noKey" | "unavailable";
  latestMonth: string | null;
  message: string | null;
}
export interface PnlReport {
  accounts: AccountPnl[];
  realized: RealizedItem[];
  months: MonthTotal[];
  totals: PnlTotals;
  cpi: CpiInfo;
}

/** TEFAS fon arama sonucu (Rust `fx::funds::FundHit`) */
export interface FundHit {
  /** TEFAS kodu (öneksiz) */
  code: string;
  name: string;
  kind: "YAT" | "BYF";
  kindLabel: string;
  /** Son fiyat (1 pay, TL) */
  price: number;
  /** Fiyat günü YYYY-MM-DD */
  date: string;
}

/** Kâr/zarar süzgeci */
export type PnlKind = "all" | "fx" | "fund";

/** Net servet geçmişi (Rust: networth) */
export interface NetWorthByKind {
  tlCents: number;
  fxCents: number;
  fundCents: number;
  cardCents: number;
  loanCents: number;
  overdraftCents: number;
}

export interface NetWorthPoint {
  date: string;
  assetsCents: number;
  cardDebtCents: number;
  loanDebtCents: number;
  overdraftCents: number;
  /** Bugünkü fiyatla */
  netCents: number;
  /** Döviz/altın/fon maliyetle */
  netCostCents: number;
  byKind: NetWorthByKind;
  accounts: { accountId: string; valueCents: number }[];
  unvaluedCount: number;
  costPartial: boolean;
}

export interface NetWorthAccount {
  accountId: string;
  name: string;
  kind: AccountKind;
  currency: string;
}

export interface NetWorthReport {
  points: NetWorthPoint[];
  accounts: NetWorthAccount[];
  /** 1 yıl / 3 yıl / Tümü görünümleri (Rust) */
  ranges: Record<"1y" | "3y" | "all", NetWorthRangeSummary>;
}

export interface NetWorthRangeSummary {
  /** Görünümün ilk noktası (`points` dizini) */
  start: number;
  /** Dönemdeki net servet değişimi (bugünkü fiyatla) */
  changeCents: number;
  /** Değişimin kur/fiyat kazancından gelen kısmı */
  fxGainCents: number;
}

/** Birikim hedefi; `target` hedef biriminde (TL, döviz ya da altın miktarı) */
export interface Goal {
  id: string;
  name: string;
  currency: string;
  target: number;
  targetDate: string | null;
  color: string;
  archived: boolean;
  accountIds: string[];
  createdAt: string;
}
export type GoalInput = Omit<Goal, "id" | "createdAt">;
export type GoalStatus = "reached" | "on_track" | "behind" | "unknown";
export interface GoalAccountValue {
  accountId: string;
  /** Bugünkü değer hedef biriminde; kur yoksa null */
  value: number | null;
  archived: boolean;
}
export interface GoalProgress {
  goalId: string;
  current: number;
  target: number;
  percent: number;
  remaining: number;
  requiredPerMonth: number | null;
  pacePerMonth: number | null;
  projectedDate: string | null;
  status: GoalStatus;
  dateOverdue: boolean;
  unvaluedCount: number;
  accounts: GoalAccountValue[];
  series: { date: string; value: number }[];
}
export interface GoalsReport {
  goals: GoalProgress[];
}

/** İşlem etiketi; `budget` isteğe bağlı toplam sınır (TL) */
export interface Tag {
  id: string;
  name: string;
  color: string;
  budget: number | null;
  archived: boolean;
  createdAt: string;
}
export type TagInput = Omit<Tag, "id" | "createdAt">;
export type BudgetStatus = "ok" | "near" | "over";
export interface TagStats {
  tagId: string;
  /** TL; eksi = net gelir */
  spent: number;
  count: number;
  firstDate: string | null;
  lastDate: string | null;
  byCategory: { categoryId: string | null; amount: number }[];
  monthly: { month: string; amount: number }[];
  budget: number | null;
  remaining: number | null;
  percent: number | null;
  budgetStatus: BudgetStatus | null;
}
export interface TagsReport {
  tags: TagStats[];
}

/** Hesap özetleri (Rust accounts::report) */
export type CardStatementStatus = "none" | "paid" | "minPaid" | "pending" | "overdue";

export interface CardStatement {
  periodStart: string;
  closingDate: string;
  dueDate: string;
  statementCents: number;
  paidCents: number;
  remainingCents: number;
  minPaymentCents: number;
  status: CardStatementStatus;
  /** Bugünden son ödemeye gün (eksi: gecikti) */
  dueInDays: number;
}

export interface AmountHintCents {
  label: string;
  amountCents: number;
}

export interface CardReport {
  totalDebtCents: number;
  availableCents: number | null;
  currentPeriodCents: number;
  laterInstallmentsCents: number;
  nextClosingDate: string;
  nextDueDate: string;
  /** Kesilmiş son 6 ekstre, en yeni önce */
  statements: CardStatement[];
  hints: AmountHintCents[];
}

export interface LoanRow {
  index: number;
  date: string;
  paymentCents: number;
  interestCents: number;
  principalCents: number;
  balanceCents: number;
}

export interface LoanSummary {
  schedule: LoanRow[];
  remainingCents: number;
  paidCount: number;
  next: LoanRow | null;
  remainingInterestCents: number;
  /** Bugünden sonraki taksite gün (eksi: gecikti) */
  nextDueInDays: number | null;
}

export interface BankSummary {
  balanceCents: number;
  overdraftUsedCents: number;
  availableCents: number | null;
}

export interface FxSummary {
  qtyMinor: number;
  /** Gösterim miktarı (Rust) */
  qty: number;
  /** Kur yoksa null */
  valueCents: number | null;
}

export interface AccountReport {
  accountId: string;
  kind: "bank" | "cash" | "fx" | "card" | "loan";
  bank: BankSummary | null;
  fx: FxSummary | null;
  card: CardReport | null;
  loan: LoanSummary | null;
}

export interface AccountsReport {
  accounts: AccountReport[];
  /** Kredi taksit ödemesinde faizin yazılacağı "Faiz ve Masraflar" gider kategorisi */
  feeCategoryId: string | null;
}

/** "Verileri sıfırla" sonrası başlangıç verisi (Rust) */
export interface ResetSeed {
  categories: Category[];
  accounts: Account[];
}

/** Bütçe raporu (Rust); tutarlar kuruş */
export interface BudgetException {
  amountCents: number;
  note: string;
}

export interface BudgetCategoryLine {
  categoryId: string;
  spentCents: number;
  budgetCents: number | null;
  /** Devri açıksa önceki aylardan gelen (eksi: aşım) */
  carryCents: number | null;
  /** Limiti varsa bu ayın payı: limit + devir (büyük aşım sonrası eksi olabilir) */
  envelopeCents: number | null;
  /** Pay − harcanan; eksiyse aşım */
  leftCents: number | null;
}

export interface BudgetTotals {
  budgetCents: number;
  /** Devri açık kategorilerin önceki aylardan gelen toplamı */
  carryCents: number;
  /** Bu ayın payları: limitler + devir */
  envelopeCents: number;
  spentBudgetedCents: number;
  remainingCents: number;
  /** Bu ayın bütün bütçe giderleri (bütçe ayına göre) */
  spentAllCents: number;
  /** Aynı giderler harcama tarihine göre */
  byDateCents: number;
}

export interface BudgetIncomeLine {
  recurringId: string;
  date: string;
  plannedCents: number;
  receivedCents: number;
  usedCents: number;
  exception: BudgetException | null;
}

export interface BudgetRecurringRow {
  recurringId: string;
  date: string;
  started: boolean;
  upcoming: boolean;
  amountCents: number;
  /** İstisnasız tutar ("bu ay yok" satırında üstü çizili) */
  baseAmountCents: number;
  exception: BudgetException | null;
}

export interface BudgetReport {
  month: string;
  prevMonth: string;
  nextMonth: string;
  categories: BudgetCategoryLine[];
  /** Kategorisiz giderler; o ay kategorisiz kayıt yoksa null */
  uncategorizedCents: number | null;
  totals: BudgetTotals;
  incomeLines: BudgetIncomeLine[];
  regularIncomeCents: number;
  irregularIncomes: { transactionId: string; cents: number }[];
  irregularIncomeCents: number;
  regularExpenseCents: number;
  budgetReservedCents: number;
  irregularExpenseByAccount: { accountId: string; cents: number }[];
  irregularExpenseCents: number;
  leftCents: number;
  recurringRows: BudgetRecurringRow[];
  recurringTotals: { incomeCents: number; expenseCents: number };
}

export interface ExpectedIncomeCents {
  regularCents: number;
  otherCents: number;
  totalCents: number;
}

export interface DueIncomeCents {
  recurringId: string;
  date: string;
  amountCents: number;
}

/** Bugüne bağlı gelir durumu (Rust) */
export interface IncomeStatus {
  expected: ExpectedIncomeCents;
  due: DueIncomeCents[];
}

/** Ödeme takvimi (Rust); tutarlar kuruş */
export type PlanObligationKind = "card" | "loan" | "recurring" | "planned";

export interface PlanInstallment {
  index: number;
  count: number;
}

export interface PlanObligation {
  key: string;
  kind: PlanObligationKind;
  date: string;
  amountCents: number;
  accountId: string | null;
  recurringId: string | null;
  transactionId: string | null;
  installment: PlanInstallment | null;
  /** Satır adı (Rust): "… ekstresi", "… · 3/12. taksit" */
  label: string;
  /** Tutar henüz kesinleşmedi (gelecek ekstre) */
  estimated: boolean;
  overdue: boolean;
  /** Son ödeme tarihi karşılayan gelirden önce */
  beforeIncome: boolean;
  /** Bugünden ödeme tarihine gün (eksi: gecikti) */
  daysLeft: number;
  periodMonth: string;
  loanInterestCents: number | null;
  loanPrincipalCents: number | null;
}

export interface PlanIncomeEvent {
  key: string;
  recurringId: string | null;
  transactionId: string | null;
  date: string;
  amountCents: number;
  accountId: string | null;
  exceptionNote: string | null;
  /** İşlemler'e girilmiş tutarla değiştirildi */
  entered: boolean;
  skipped: boolean;
  /** Karşılık gelinen ay için tutarı 0 olan istisna var ("yatmayacak" işaretli; geri alınabilir) */
  skipException: boolean;
  oneTime: boolean;
  coverMonth: string;
  fixedMonth: boolean;
  recorded: boolean;
}

export interface PlanPaidRow {
  key: string;
  kind: "card" | "loan" | "recurring";
  date: string;
  amountCents: number;
  accountId: string | null;
  recurringId: string | null;
  transactionId: string | null;
  installment: PlanInstallment | null;
  cardStatus: "paid" | "minPaid" | "partial" | null;
  /** İleri tarihli (henüz yapılmamış) ödeme */
  scheduled: boolean;
  /** Satır adı (Rust) */
  label: string;
}

export interface PlanReceivedRow {
  key: string;
  transactionId: string;
  date: string;
  amountCents: number;
  accountId: string;
}

export interface PlanSalaryInfo {
  recurringId: string;
  paidOn: string;
  nextPaidOn: string;
  /** Dönemin son günü (sonraki maaştan bir gün önce) */
  periodEnd: string;
  event: PlanIncomeEvent | null;
}

export interface PlanPeriod {
  month: string;
  salary: PlanSalaryInfo | null;
  incomes: PlanIncomeEvent[];
  obligations: PlanObligation[];
  /** Dönemin gecikmiş ödemeleri (toplama dahil) */
  overdueCents: number;
  incomeCents: number;
  totalCents: number;
  leftCents: number;
  /** Bugünkü nakitten başlayarak dönem sonundaki tahmini bakiye */
  balanceCents: number;
  paid: PlanPaidRow[];
  received: PlanReceivedRow[];
  /** Başlıkta gösterilen: ödendi/yattı dahil */
  periodIncomeCents: number;
  periodTotalCents: number;
  periodLeftCents: number;
  settledOnly: boolean;
}

export interface CashPlanReport {
  months: PlanPeriod[];
  /** Bütün dönemlerin gecikmiş ödemeleri, tarihe ve ada göre */
  overdue: PlanObligation[];
  overdueCents: number;
  /** Dönem sonu tahmini (bugünkü nakit + planlanan gelir − planlanan ödemeler) */
  endCents: number;
  liquidCents: number;
  totalIncomeCents: number;
  totalObligationCents: number;
}

export interface UpcomingObligations {
  obligations: PlanObligation[];
}

export type DebtStrategy = "avalanche" | "snowball" | "custom" | "minimum" | "manual";

/** Borç planındaki borç (ad ve renk hesaptan) */
export interface DebtPlanDebt {
  id: string;
  kind: AccountKind;
  balanceCents: number;
  /** Kart: ilk aya düşen kısım (kalanı ileriki ekstreler); KMH ve kredide null */
  firstMonthCents: number | null;
  /** Vergi dahil aylık efektif faiz (oran) */
  monthlyRate: number;
  /** İlk ayın faizi */
  interestCents: number;
  /** İlk ayın asgari ödemesi / taksiti */
  minimumCents: number;
}

export interface DebtPlanRow {
  /** Plan ayı (1 = bu ay) */
  month: number;
  monthKey: string;
  /** Satırın ödemelerini karşılayan maaşın ayı (maaş yoksa takvim ayı) */
  salaryMonth: string;
  incomeCents: number;
  fixedCents: number;
  /** Borçlara ayrılan (aya özel tutar ya da varsayılan) */
  allottedCents: number;
  overridden: boolean;
  /** Gelirden (düzenli giderler düşülünce) fazlası ayrılıyor */
  overIncome: boolean;
  /** Hesap id → ödeme (yalnız sıfırdan farklılar) */
  payments: Record<string, number>;
  /** Hesap id → ay sonu kalan borç */
  balances: Record<string, number>;
  totalCents: number;
  leftCents: number;
  /** Gelir − düzenli gider − bu ayki borç ödemeleri */
  freeCents: number;
}

export interface DebtPlanResult {
  strategy: DebtStrategy;
  /** Tüm borçların kapandığı ay sayısı; 30 yılda kapanmıyorsa null */
  months: number | null;
  payoffDate: string | null;
  totalInterestCents: number;
  totalPaidCents: number;
  /** En az faizli plana göre fazla faiz (bu plan en iyiyse ya da en iyi yoksa null) */
  extraInterestCents: number | null;
  /** Bazı aylarda asgari ödemeler bütçeyi aşıyor */
  budgetShort: boolean;
  /** Kapanış ayına göre sıralı */
  payoffs: { id: string; month: number; monthKey: string }[];
  /** İlk 24 ay */
  rows: DebtPlanRow[];
  incomeSame: boolean;
  fixedSame: boolean;
  /** Plan 24 aydan uzun */
  hasMore: boolean;
}

export interface DebtPlanReport {
  today: string;
  debts: DebtPlanDebt[];
  /** İlk ayın asgari/taksit toplamı */
  minimumCents: number;
  budgetCents: number;
  /** Aylık tutar girilmemiş: asgari toplamı kullanılıyor */
  budgetIsDefault: boolean;
  best: DebtStrategy | null;
  /** "Kendi planım"da kural ve hücre yok */
  manualEmpty: boolean;
  /** Sıra: avalanche, snowball, custom, minimum, manual */
  plans: DebtPlanResult[];
}

export type OverviewPeriod = "thisMonth" | "lastMonth" | "last30" | "thisYear" | "all";

/** Genel Bakış kategori dağılımı satırı; `categoryId` null = Kategorisiz (kategorisi olmayan ya da silinmiş) */
export interface OverviewSlice {
  categoryId: string | null;
  cents: number;
}

export interface OverviewReport {
  period: OverviewPeriod;
  /** Dönemin ilk/son günü; "Tümü"nde null */
  from: string | null;
  to: string | null;
  totals: {
    /** Plan maaşı dahil */
    incomeCents: number;
    expenseCents: number;
    /** Plan maaşı dahil */
    netCents: number;
    /** İşlem olarak girilmemiş düzenli gelirlerin plan tutarı */
    plannedCents: number;
    /** Dönemdeki gerçek işlemler (taksit parçaları değil) */
    count: number;
    savingsRatePct: number | null;
  };
  /** Gider kategorileri, büyükten küçüğe */
  categories: OverviewSlice[];
  /** Önceki eşdeğer dönem; "Tümü"nde null */
  previous: OverviewSlice[] | null;
  accounts: { accountId: string; cents: number }[];
  /** En çok harcama yapılan yerler (en fazla 30) */
  merchants: MerchantTotal[];
  /** Son 6 ay (takip başlamadan önceki boş aylar yok) */
  monthly: { month: string; incomeCents: number; expenseCents: number }[];
}

export interface CategoryUsageReport {
  categories: { categoryId: string; count: number; totalCents: number }[];
}

/** Analiz (Rust `finans-core::analysis`); tutarlar kuruş */
export interface SubscriptionRow {
  /** Kalıcı anahtar (düzeltmeler bununla saklanır): harcama yeri + ilk ödeme tutarı */
  key: string;
  name: string;
  /** Ekstredeki açıklama (düzenlenmemiş ad) */
  merchant: string;
  period: SubscriptionPeriod;
  /** Ödeme aralığından bulunan dönem */
  detectedPeriod: SubscriptionPeriod;
  lastAmountCents: number;
  lastDate: string;
  nextDate: string;
  monthlyCents: number;
  yearlyCents: number;
  count: number;
  totalPaidCents: number;
  accountId: string;
  /** active: düzenli; late: beklenen ödeme uzun süredir görülmedi; cancelled: kullanıcı iptal etti */
  status: "active" | "late" | "cancelled";
}

export interface MonthTotal {
  /** YYYY-MM */
  month: string;
  totalCents: number;
  count: number;
}

/** En çok harcanan yer (Rust `MerchantRow`) */
export interface MerchantTotal {
  key: string;
  name: string;
  count: number;
  totalCents: number;
}

export interface ForecastItem {
  categoryId: string;
  /** Tahmine giren tamamlanmış aylar (en fazla son 3) */
  basis: MonthTotal[];
  /** Grafikte gösterilen tamamlanmış aylar (en fazla son 6) */
  history: MonthTotal[];
  monthlyCents: number;
  yearlyCents: number;
  /** Tahmin bu ayın gidişatından mı (geçmiş ay yok) */
  fromRunRate: boolean;
  spentThisMonthCents: number;
  countThisMonth: number;
  projectedMonthEndCents: number;
  avgTicketCents: number | null;
  perMonthCount: number | null;
  topMerchants: MerchantTotal[];
  budgetCents: number | null;
  overBudget: boolean;
}

export interface AnalysisReport {
  subscriptions: {
    items: SubscriptionRow[];
    /** İptal edilmeyenler (aktif ve geciken) */
    activeCount: number;
    monthlyCents: number;
    yearlyCents: number;
  };
  forecast: {
    /** Tahmini gösterilen kategoriler (seçim ya da varsayılan) */
    selectedCategoryIds: string[];
    /** Tamamlanmış ay sayısı (tahminin dayandığı veri) */
    monthsOfData: number;
    items: ForecastItem[];
    monthlyCents: number;
    yearlyCents: number;
  };
  /** Kafe kategorisine taşınması önerilen harcamalar */
  cafeSuggestion: CafeSuggestion | null;
}

/** İşlem formunun taslağı (sayılar ayrıştırılmış; geçersizse null) */
export interface TransactionDraft {
  type: TxType;
  accountId: string;
  toAccountId?: string | null;
  date: string;
  amount: number | null;
  installments: number;
  qty?: number | null;
  rate?: number | null;
  toQty?: number | null;
  toRate?: number | null;
  /** Düzenlenen kayıt (nakit eksi denetiminde bakiyeden çıkarılır) */
  editingId?: string | null;
  budgetMonth?: string | null;
  /** Yalnız yeni kayıtta nakit avans açıksa */
  cashAdvance?: CashAdvanceDraft | null;
  /** Kategori önerisi için açıklama */
  description?: string;
}

/** Nakit avans alanları; elle yazılmayan alan null */
export interface CashAdvanceDraft {
  feeRatePct: number;
  fee: number | null;
  ratePct: number;
  installment: number | null;
  total: number | null;
  /** Ödeme planındaki toplam faiz / KKDF / BSMV (TL) */
  parts: { faiz: number; kkdf: number; bsmv: number } | null;
}

export interface CashAdvancePreview {
  /** TL */
  fee: number;
  /** TL */
  installment: number;
  /** TL */
  total: number;
  interestCents: number;
  faizCents: number;
  kkdfCents: number;
  bsmvCents: number;
}

export interface PostingRow {
  closingDate: string;
  dueDate: string;
  cents: number;
  /** Takip başlangıcından önceki ekstreye düştü (ödenmiş sayılır) */
  settled: boolean;
}

/** İşlem formu önizlemesi (Rust `forms::transaction_preview`) */
export interface TransactionPreview {
  /** Kaynak ya da hedef TL dışıysa TL karşılığı (kaydedilen tutar) */
  tlCents: number | null;
  /** Dövizden dövize transferde hedef miktar önerisi */
  toQtySuggestion: number | null;
  fromSide: "buy" | "sell" | null;
  toSide: "buy" | "sell" | null;
  firstDue: string | null;
  /** Çekimden ilk son ödemeye kadar geçen gün (ilk taksitin faiz günü) */
  firstPeriodDays: number | null;
  advance: CashAdvancePreview | null;
  /** Kart taksitinde aylık tutar (TL) */
  perInstallment: number | null;
  postings: PostingRow[] | null;
  /** Kayıt sonrası nakit bakiyesi: minor / divisor hesabın biriminde */
  cashAfter: { minor: number; divisor: number } | null;
  budgetMonthOptions: string[];
  /** Açıklamaya göre önerilen kategori (transfer ve boş açıklamada null) */
  suggestedCategoryId: string | null;
}

/** Hesap formunun taslağı: kart günleri yalnız kartta, kredi alanları yalnız kredide */
export interface AccountDraft {
  accountId?: string | null;
  statementDay?: number | null;
  dueDay?: number | null;
  loan?: { principal: number; term: number; ratePct: number; taxPct: number | null } | null;
}

/** Hesap formu önizlemesi (Rust `forms::account_preview`) */
export interface AccountPreview {
  nextClosing: string | null;
  nextDue: string | null;
  lastStatement: {
    last: string;
    due: string;
    prev: string;
    defaultPaid: boolean;
    openingIfPaid: string;
    openingIfUnpaid: string;
  } | null;
  suggestedInstallmentCents: number | null;
  /** Hesabın işlem kaydı var (silinemez, türü değişmez) */
  used: boolean;
}

/** Düzenli kayıt formunun taslağı */
export interface RecurringDraft {
  /** Düzenlenen kayıt: saklı tutar, gün ve kaydırma; history formdaki hâli */
  item: { amount: number; day: number; weekendShift: WeekendShift; history: AmountChange[] } | null;
  day: number | null;
  weekendShift: WeekendShift;
  currency: string | null;
  qty: number | null;
  /** Hesap biriminin güncel alış kuru */
  buyRate: number | null;
  amount: number | null;
  changeMode: "from" | "all";
  changeFrom: string | null;
}

/** Düzenli kayıt formu önizlemesi (Rust `forms::recurring_preview`) */
export interface RecurringPreview {
  currentAmount: number | null;
  changeFromDefault: string | null;
  weekendMoves: { from: string; to: string }[] | null;
  qtyAmount: number | null;
  amountChanged: boolean;
  /** Kayıtta yazılacak tutar ve geçmiş */
  amounts: { amount: number; history: AmountChange[] } | null;
}

/** Kafe kategorisine taşınması önerilen harcamalar (Rust `rules::cafe_suggestion`) */
export interface CafeSuggestion {
  categoryId: string;
  transactionIds: string[];
  /** Açıklamanın ilk kelimesi, tekrarsız ilk üçü */
  merchants: string[];
}

/** Ekstre sütunları; -1 = yok */
export interface ColumnMap {
  date: number;
  description: number;
  /** Tek, işaretli tutar sütunu */
  amount: number;
  /** Ayrı borç/çıkan sütunu */
  debit: number;
  /** Ayrı alacak/giren sütunu */
  credit: number;
  installments: number;
}

/** Tek tutar sütununda harcamanın işareti. Kart ekstrelerinde harcama genelde artı, banka hareketlerinde eksidir. */
export type SignMode = "negativeIsExpense" | "positiveIsExpense";

export interface StatementSummary {
  closingDate: string | null;
  dueDate: string | null;
  /** Dönem borcu (ödenmesi gereken toplam) */
  periodDebt: number | null;
  /** Dönem içi harcamalar */
  periodSpending: number | null;
  minPaymentRate: number | null;
  creditLimit: number | null;
  interestRate: number | null;
}

/** Okunan ekstre (Rust `import::read_statement`) */
export interface StatementRead {
  table: string[][];
  headerRow: number;
  columns: ColumnMap;
  summary: StatementSummary | null;
}

export interface ImportRow {
  line: number;
  date: string;
  description: string;
  amount: number;
  /** "transfer" seçilirse `toAccountId` hedef hesaptır */
  type: "income" | "expense" | "transfer";
  toAccountId: string | null;
  categoryId: string | null;
  installments: number;
  include: boolean;
  /** Kullanıcıya gösterilecek not (mükerrer, kart ödemesi vb.) */
  note: string;
}

/** Ekstre satırları isteği; `columns` boşsa başlık satırından, `signMode` boşsa hesaptan tahmin edilir */
export interface StatementRowsRequest {
  table: string[][];
  headerRow: number;
  columns: ColumnMap | null;
  signMode: SignMode | null;
  accountId: string;
  closingDate: string | null;
}

/** Ekstre satırları (Rust `import::build_import_rows`) */
export interface ImportRows {
  rows: ImportRow[];
  skipped: number;
  signMode: SignMode;
  columns: ColumnMap;
}

/** Kart farkı önizlemesi: kartın şimdiki ayarları yalnız yenileme anahtarıdır */
export interface StatementCardDraft {
  accountId: string;
  summary: StatementSummary | null;
  statementDay: number | null;
  dueDay: number | null;
  creditLimit: number | null;
  interestRate: number | null;
  minPaymentRate: number | null;
  openingDate: string;
}

export interface StatementCard {
  cardFix: {
    patch: { statementDay: number | null; dueDay: number | null; creditLimit: number | null; interestRate: number | null; minPaymentRate: number | null };
    differs: ("statementDay" | "dueDay" | "creditLimit" | "interestRate" | "minPaymentRate")[];
  } | null;
  /** Ekstre kartın takip başlangıcından önce mi */
  beforeTracking: boolean;
}

export interface StatementTotalsDraft {
  rows: { amount: number; type: ImportRow["type"] }[];
  periodSpending: number | null;
}

/** Seçili satırların toplamı (TL) ve özetteki dönem içi harcamayla uyumu */
export interface StatementTotals {
  expense: number;
  income: number;
  /** Gider − gelir */
  net: number;
  /** |gider − gelir − dönem içi harcama|; özette yoksa null */
  difference: number | null;
  matchesSummary: boolean | null;
}

export interface CategoryRuleDraft {
  wordsText: string;
  type: CategoryType;
}

/** Kural formu önizlemesi: kaydedilecek kelimeler ve eşleşen işlemler (yeniden eskiye) */
export interface CategoryRulePreview {
  words: string[];
  matchingTransactionIds: string[];
}

/** Kategorisiz işlemler için öneriler */
export interface CategorySuggestions {
  suggestions: { transactionId: string; categoryId: string }[];
}

/** CSV'den okunan işlem satırı (Rust `CsvRow`) */
export interface CsvRow {
  date: string;
  type: TxType;
  categoryName: string;
  amount: number;
  description: string;
  accountName: string;
  toAccountName: string;
  installments: number;
  /** Döviz/altın tarafı: birim, kendi birimindeki miktar ve kur (yoksa boş/null) */
  fxCurrency: string;
  origAmount: number | null;
  fxRate: number | null;
  /** İki tarafı da döviz olan transferde hedef tarafı (yoksa boş/null) */
  toFxCurrency: string;
  toOrigAmount: number | null;
  toFxRate: number | null;
}

export interface CsvParseResult {
  rows: CsvRow[];
  skipped: { line: number; reason: string }[];
  /** Dosyada "Hesap" sütunu var mı */
  hasAccountColumn: boolean;
}

/** CSV birleştirmesi: mevcutlara eklenecek yeni kategoriler ve işlemler, sayaçlar */
export interface CsvMerge {
  newCategories: Category[];
  newTransactions: Transaction[];
  createdCategories: number;
  skippedTransfers: number;
  skippedFx: number;
}
