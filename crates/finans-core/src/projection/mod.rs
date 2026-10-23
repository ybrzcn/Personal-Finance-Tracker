//! Uzun vadeli tahmin: bugünkü net servetten başlayıp aylık nakit akışını yıllarca ileri yürütür.
//! Akış: düzenli gelirler + düzensiz gelir ortalaması − (düzenli giderler + kategori limitleri + düzensiz gider ortalaması)
//! − kredi taksitleri. Ortalamalar son 12 tamamlanmış ayın (yılda bir gelen giderler de girsin; tek seferlikler ayıklanmaz,
//! ayıklanınca tahmin düşük kalır). Gelirler her Ocak zam oranıyla, giderler her ay enflasyonla (aylık bileşik) artar;
//! artı nakit aylık getiri kazanır. Kredi borcu taksit tablosuyla azalır;
//! kart ve KMH borcu başlangıçta nakitten düşülmüş sayılır (net servet aynı). Tutarlar kuruş.

use serde::{Deserialize, Serialize};

use crate::accounts::bank::tl_value;
use crate::accounts::cards::js_cents;
use crate::accounts::loans::{liability_at, loan_schedule};
use crate::budget::expenses::{budget_expenses, month_expenses};
use crate::budget::income::split_month_income;
use crate::budget::recurring::{amount_at, has_started, month_of, occurrence_in, shift_month};
use crate::db::{Account, Budget, RecurringItem, Transaction};

/// Düzensiz gelir ve gider ortalamasının bakıldığı tamamlanmış ay sayısı (yıllık giderler de girsin)
const IRREGULAR_MONTHS: i64 = 12;
pub const MAX_YEARS: i64 = 30;

/// Kullanıcının varsayımları (Uzun Vade sayfası; `projection` ayarında saklanır). Oranlar yüzde, yıllık.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Assumptions {
    pub years: i64,
    /// Gelirlerin yıllık artışı (zam)
    pub income_growth_pct: f64,
    /// Giderlerin yıllık artışı (enflasyon); "bugünün parasıyla" değer de buna göre
    pub expense_growth_pct: f64,
    /// Artı nakdin yıllık getirisi
    pub return_pct: f64,
    /// Senaryo: her ay eklenen (+) ya da çıkan (−) tutar, TL; gelirle birlikte artar
    pub monthly_extra: f64,
}

impl Default for Assumptions {
    fn default() -> Self {
        Assumptions { years: 10, income_growth_pct: 0.0, expense_growth_pct: 0.0, return_pct: 0.0, monthly_extra: 0.0 }
    }
}

impl Assumptions {
    /// Aralık dışı ya da sayı olmayan değerler sınırlanır (bozuk ayar çökertmesin)
    pub fn clamped(&self) -> Assumptions {
        let pct = |v: f64| if v.is_finite() { v.clamp(-50.0, 200.0) } else { 0.0 };
        Assumptions {
            years: self.years.clamp(1, MAX_YEARS),
            income_growth_pct: pct(self.income_growth_pct),
            expense_growth_pct: pct(self.expense_growth_pct),
            return_pct: pct(self.return_pct),
            monthly_extra: if self.monthly_extra.is_finite() { self.monthly_extra.clamp(-1e9, 1e9) } else { 0.0 },
        }
    }
}

pub struct ProjectionInput<'a> {
    pub accounts: &'a [Account],
    pub transactions: &'a [Transaction],
    pub recurring: &'a [RecurringItem],
    pub budgets: &'a [Budget],
    /// Bugünkü net servet (net servet raporunun son noktası)
    pub net_worth_cents: i64,
    pub assumptions: &'a Assumptions,
    /// YYYY-MM-DD
    pub today: &'a str,
}

/// Bugünkü aylık akış (artışlardan önce)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyBase {
    pub income_cents: i64,
    pub regular_expense_cents: i64,
    pub budget_cents: i64,
    /// Son tamamlanmış ayların (en çok 12) bütçesiz, düzenli kayda uymayan giderlerinin ortalaması
    pub irregular_expense_cents: i64,
    /// Aynı aylarda düzenli gelirle eşleşmeyen gelirlerin ortalaması
    pub irregular_income_cents: i64,
    pub irregular_months: i64,
    /// Önümüzdeki ayın kredi taksitleri
    pub loan_cents: i64,
    pub extra_cents: i64,
    pub net_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearRow {
    pub year: i64,
    /// Yılın tahmindeki son ayı (YYYY-MM)
    pub end_month: String,
    pub income_cents: i64,
    pub expense_cents: i64,
    pub loan_cents: i64,
    pub extra_cents: i64,
    pub net_flow_cents: i64,
    /// Giren: gelir + artı senaryo
    pub inflow_cents: i64,
    /// Çıkan: gider + taksit + eksi senaryo
    pub outflow_cents: i64,
    pub return_cents: i64,
    pub cash_cents: i64,
    pub debt_cents: i64,
    pub net_worth_cents: i64,
    /// Bugünün parasıyla (gider artışı oranıyla indirgenmiş)
    pub real_net_worth_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionPoint {
    pub month: String,
    pub net_worth_cents: i64,
    pub real_net_worth_cents: i64,
    pub debt_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionReport {
    pub assumptions: Assumptions,
    pub start_month: String,
    pub start_net_worth_cents: i64,
    /// Başlangıçta kalan kredi anaparası
    pub start_loan_debt_cents: i64,
    pub base: MonthlyBase,
    /// Ay ay (ilk nokta bugün)
    pub points: Vec<ProjectionPoint>,
    pub years: Vec<YearRow>,
    /// Son kredi taksitinin ayı; kredi yoksa ya da bir kredinin kalan taksit planı yoksa None
    pub debt_free_month: Option<String>,
    /// Borcu kalan ama taksit planı kalmamış kredi var (borcu tahminde sabit kalır)
    pub loan_without_schedule: bool,
    /// Nakdin ilk kez eksiye düştüğü ay; düşmüyorsa None
    pub first_negative_month: Option<String>,
}

struct LoanRow {
    /// Tahminde ödendiği ay: vadesi geçmiş ya da bu ayın kalan günlerine düşen taksit önümüzdeki aya
    month: String,
    /// Taksit tablosundaki asıl ayı
    due_month: String,
    payment_cents: i64,
    /// Bu taksitten sonra kalan anapara
    balance_cents: i64,
}

struct Loan {
    rows: Vec<LoanRow>,
    remaining_cents: i64,
}

/// Borcu kalan krediler (arşivliler dahil, net servet gibi); kalan anapara bugünkü bakiye (ileri tarihli ödemeler sayılmaz)
fn loans(accounts: &[Account], txs: &[Transaction], today: &str) -> Vec<Loan> {
    let next = shift_month(month_of(today), 1);
    accounts
        .iter()
        .filter(|a| a.kind == "loan")
        .filter_map(|a| {
            let remaining_cents = liability_at(a, txs, Some(today)).max(0);
            (remaining_cents > 0).then(|| {
                let schedule = loan_schedule(a);
                // Kalan anaparadan küçük "taksit sonrası bakiye"ye sahip ilk satır sıradaki taksittir
                let paid = schedule.iter().position(|r| r.balance_cents < remaining_cents).unwrap_or(schedule.len());
                let rows = schedule[paid..]
                    .iter()
                    .map(|r| {
                        let due = month_of(&r.date).to_string();
                        LoanRow { month: if due < next { next.clone() } else { due.clone() }, due_month: due, payment_cents: r.payment_cents, balance_cents: r.balance_cents }
                    })
                    .collect();
                Loan { rows, remaining_cents }
            })
        })
        .collect()
}

/// Son tamamlanmış aylarda (bütçe ayına göre) bütçesiz ve düzenli kayda uymayan giderlerin ve düzenli gelirle eşleşmeyen
/// gelirlerin ortalaması: (gider kuruş, gelir kuruş, ay sayısı). Verisi olmayan ay sıfır sayılır.
fn irregular_average(input: &ProjectionInput, today_month: &str) -> (i64, i64, i64) {
    let all = budget_expenses(input.transactions, input.accounts, input.recurring);
    // İlk gider bütçe ayından önceki aylar sayılmaz (kart harcaması sonraki bütçe ayına düşebilir)
    let Some(first) = all.iter().map(|e| e.month.as_str()).min() else {
        return (0, 0, 0);
    };
    let no_carry = Default::default();
    let months: Vec<String> =
        (1..=IRREGULAR_MONTHS).map(|k| shift_month(today_month, -k)).filter(|m| m.as_str() >= first).collect();
    if months.is_empty() {
        return (0, 0, 0);
    }
    let n = months.len() as i64;
    let expense: i64 = months.iter().map(|m| month_expenses(&all, input.recurring, input.budgets, &no_carry, m).irregular_cents).sum();
    let income: i64 = months.iter().map(|m| split_month_income(input.transactions, input.recurring, m).irregular_cents).sum();
    (expense / n, income / n, n)
}

/// Ayın düzenli tutarları (başlamış, etkin kayıtlar; bugünkü tutarla, ay istisnaları uygulanmaz): (gelir, gider)
fn regular_for(recurring: &[RecurringItem], month: &str, today: &str) -> (i64, i64) {
    let (mut income, mut expense) = (0, 0);
    for r in recurring.iter().filter(|r| r.active) {
        if !has_started(r, &occurrence_in(r, month)) {
            continue;
        }
        let cents = js_cents(amount_at(r, today));
        match r.kind.as_str() {
            "income" => income += cents,
            "expense" => expense += cents,
            _ => {}
        }
    }
    (income, expense)
}

fn scale(cents: i64, factor: f64) -> i64 {
    (cents as f64 * factor).round() as i64
}

pub fn report(input: &ProjectionInput) -> ProjectionReport {
    let a = input.assumptions.clamped();
    let today_month = month_of(input.today).to_string();
    let loans = loans(input.accounts, input.transactions, input.today);
    let start_loan: i64 = loans.iter().map(|l| l.remaining_cents).sum();
    let budget_cents: i64 = input.budgets.iter().map(|b| js_cents(b.amount)).sum();
    let (irregular, irregular_income, irregular_months) = irregular_average(input, &today_month);
    let extra = js_cents(a.monthly_extra);

    let loan_in = |m: &str| -> i64 { loans.iter().flat_map(|l| &l.rows).filter(|r| r.month == m).map(|r| r.payment_cents).sum() };
    let debt_after = |m: &str| -> i64 {
        loans
            .iter()
            .map(|l| l.rows.iter().filter(|r| r.month.as_str() <= m).last().map_or(l.remaining_cents, |r| r.balance_cents.max(0)))
            .sum()
    };

    let first = shift_month(&today_month, 1);
    let (inc0, exp0) = regular_for(input.recurring, &first, input.today);
    // Aylık akışta tipik ay: önümüzdeki ayın kendi taksitleri (gecikenler ve bu ayın kalanı tahminin ilk ayında ödenir)
    let base_loan: i64 = loans.iter().flat_map(|l| &l.rows).filter(|r| r.due_month == first).map(|r| r.payment_cents).sum();
    let base = MonthlyBase {
        income_cents: inc0,
        regular_expense_cents: exp0,
        budget_cents,
        irregular_expense_cents: irregular,
        irregular_income_cents: irregular_income,
        irregular_months,
        loan_cents: base_loan,
        extra_cents: extra,
        net_cents: inc0 + irregular_income + extra - exp0 - budget_cents - irregular - base_loan,
    };

    let monthly_return = (1.0 + a.return_pct / 100.0).powf(1.0 / 12.0) - 1.0;
    // Fiyatlar her ay artar: yıllık enflasyonun aylık bileşik karşılığı (12 ayda yıllık orana ulaşır)
    let monthly_inflation = (1.0 + a.expense_growth_pct / 100.0).powf(1.0 / 12.0);
    // Ev, araba gibi varlıklar bugünkü değeriyle sabit taşınır (getiri kazanmaz, nakit sayılmaz)
    let fixed: i64 = input.accounts.iter().filter(|a| a.subtype() == "asset").map(|a| tl_value(a, input.transactions, input.today)).sum();
    // Kart/KMH borcu başlangıçta nakitten düşülür: nakit = net servet + kalan kredi anaparası − sabit varlıklar
    let mut cash = input.net_worth_cents + start_loan - fixed;
    let (mut income_factor, mut expense_factor) = (1.0_f64, 1.0_f64);
    let mut points =
        vec![ProjectionPoint { month: today_month.clone(), net_worth_cents: input.net_worth_cents, real_net_worth_cents: input.net_worth_cents, debt_cents: start_loan }];
    let mut years = Vec::new();
    let mut first_negative = None;
    let mut year = YearRow {
        year: 1,
        end_month: String::new(),
        income_cents: 0,
        expense_cents: 0,
        loan_cents: 0,
        extra_cents: 0,
        net_flow_cents: 0,
        inflow_cents: 0,
        outflow_cents: 0,
        return_cents: 0,
        cash_cents: 0,
        debt_cents: 0,
        net_worth_cents: 0,
        real_net_worth_cents: 0,
    };
    let mut m = first;
    for k in 1..=a.years * 12 {
        // Zam her Ocak'ta (ilk ay Ocak'sa o aydan); enflasyon her ay
        if m.ends_with("-01") {
            income_factor *= 1.0 + a.income_growth_pct / 100.0;
        }
        expense_factor *= monthly_inflation;
        let (inc, exp) = regular_for(input.recurring, &m, input.today);
        let income = scale(inc + irregular_income, income_factor);
        let extra_m = scale(extra, income_factor);
        let expense = scale(exp + budget_cents + irregular, expense_factor);
        let loan = loan_in(&m);
        let earned = if cash > 0 { (cash as f64 * monthly_return).round() as i64 } else { 0 };
        let flow = income.saturating_add(extra_m).saturating_sub(expense).saturating_sub(loan);
        // Uç varsayımlarda (yüksek getiri, 30 yıl) tutar sınırda kalır, taşmaz
        cash = cash.saturating_add(earned).saturating_add(flow);
        if cash < 0 && first_negative.is_none() {
            first_negative = Some(m.clone());
        }
        let debt = debt_after(&m);
        let net = cash.saturating_sub(debt).saturating_add(fixed);
        let real = (net as f64 / expense_factor).round() as i64;
        points.push(ProjectionPoint { month: m.clone(), net_worth_cents: net, real_net_worth_cents: real, debt_cents: debt });

        year.income_cents = year.income_cents.saturating_add(income);
        year.expense_cents = year.expense_cents.saturating_add(expense);
        year.loan_cents += loan;
        year.extra_cents = year.extra_cents.saturating_add(extra_m);
        year.net_flow_cents = year.net_flow_cents.saturating_add(flow);
        year.inflow_cents = year.inflow_cents.saturating_add(income).saturating_add(extra_m.max(0));
        year.outflow_cents = year.outflow_cents.saturating_add(expense).saturating_add(loan).saturating_add((-extra_m).max(0));
        year.return_cents = year.return_cents.saturating_add(earned);
        if k % 12 == 0 {
            year.end_month = m.clone();
            year.cash_cents = cash;
            year.debt_cents = debt;
            year.net_worth_cents = net;
            year.real_net_worth_cents = real;
            let next_year = year.year + 1;
            years.push(std::mem::replace(
                &mut year,
                YearRow { year: next_year, end_month: String::new(), income_cents: 0, expense_cents: 0, loan_cents: 0, extra_cents: 0, net_flow_cents: 0, inflow_cents: 0, outflow_cents: 0, return_cents: 0, cash_cents: 0, debt_cents: 0, net_worth_cents: 0, real_net_worth_cents: 0 },
            ));
        }
        m = shift_month(&m, 1);
    }

    let loan_without_schedule = loans.iter().any(|l| l.rows.is_empty());
    let debt_free_month = if loan_without_schedule { None } else { loans.iter().filter_map(|l| l.rows.last().map(|r| r.month.clone())).max() };
    ProjectionReport {
        assumptions: a,
        start_month: today_month,
        start_net_worth_cents: input.net_worth_cents,
        start_loan_debt_cents: start_loan,
        base,
        points,
        years,
        debt_free_month,
        loan_without_schedule,
        first_negative_month: first_negative,
    }
}
