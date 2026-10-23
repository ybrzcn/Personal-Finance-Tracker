//! Gelir tarafı: arayüzdeki `budget.ts` kurallarının aynısı (düzenli gelir eşleştirme, bütçe ayı, beklenen gelir).

use std::cmp::Ordering;
use std::collections::HashMap;

use serde::Serialize;

use super::recurring::{amount_at, amount_for_occurrence, exception_for, has_started, month_of, occurrence_in, scheduled_month, shift_month};
use crate::accounts::cards::{clamped_date, js_cents};
use crate::db::{MonthException, RecurringItem, Transaction};

/// İşlem düzenli kaydın karşılığı olabilir mi (TS `matchesRegular`)
pub fn matches_regular(t: &Transaction, r: &RecurringItem) -> bool {
    if !has_started(r, &t.date) {
        return false;
    }
    // O aya özel istisna varsa onunla karşılaştırılır; "yok" (0) olan aya eşleşme olmaz
    let planned = amount_for_occurrence(r, &t.date);
    if planned <= 0.0 {
        return false;
    }
    if let Some(cat) = r.category_id.as_deref().filter(|c| !c.is_empty()) {
        return t.category_id.as_deref() == Some(cat) && t.amount >= planned * 0.5 && t.amount <= planned * 2.0;
    }
    let account_ok = match r.account_id.as_deref() {
        Some(a) if !a.is_empty() => a == t.account_id,
        _ => true,
    };
    account_ok && (t.amount - planned).abs() <= planned * 0.1
}

/// Her işlemi en fazla bir düzenli kayda atar (eşleşenler içinde tutarı en yakın; eşitlikte ilk): işlem kimliği → kayıt kimliği
pub fn assign_regular(txs: &[&Transaction], items: &[&RecurringItem]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for t in txs {
        let mut best: Option<&RecurringItem> = None;
        let mut best_diff = f64::INFINITY;
        for r in items {
            if !matches_regular(t, r) {
                continue;
            }
            let diff = (t.amount - amount_for_occurrence(r, &t.date)).abs();
            if diff < best_diff {
                best = Some(*r);
                best_diff = diff;
            }
        }
        if let Some(b) = best {
            out.insert(t.id.clone(), b.id.clone());
        }
    }
    out
}

pub fn active_incomes(recurring: &[RecurringItem]) -> Vec<&RecurringItem> {
    recurring.iter().filter(|r| r.kind == "income" && r.active).collect()
}

fn month_income_txs<'a>(txs: &'a [Transaction], month: &str) -> Vec<&'a Transaction> {
    txs.iter().filter(|t| t.kind == "income" && month_of(&t.date) == month).collect()
}

/// Gelirin sayılacağı bütçe ayı (TS `incomeBudgetMonth`)
pub fn income_budget_month(t: &Transaction, assigned: Option<&RecurringItem>) -> String {
    if let Some(m) = t.budget_month.as_deref().filter(|m| !m.is_empty()) {
        return m.to_string();
    }
    let m = month_of(&t.date);
    if assigned.is_some_and(|r| r.covers_previous_month) {
        shift_month(m, -1)
    } else {
        m.to_string()
    }
}

struct Indexed<'a> {
    t: &'a Transaction,
    item: Option<&'a RecurringItem>,
    month: String,
}

/// Tüm gelir işlemleri: düzenli kayda atama ve bütçe ayı
fn income_index<'a>(txs: &'a [Transaction], recurring: &'a [RecurringItem]) -> Vec<Indexed<'a>> {
    let items = active_incomes(recurring);
    let incomes: Vec<&Transaction> = txs.iter().filter(|t| t.kind == "income").collect();
    let assigned = assign_regular(&incomes, &items);
    incomes
        .into_iter()
        .map(|t| {
            let item = assigned.get(&t.id).and_then(|id| items.iter().copied().find(|r| r.id == *id));
            Indexed { t, item, month: income_budget_month(t, item) }
        })
        .collect()
}

/// Raporlarda ve Genel Bakış'ta gelirin sayıldığı tarih: bütçe ayı (elle seçilen ay ya da önceki ayı karşılayan düzenli
/// gelir) takvim ayından farklıysa o aya aynı günle taşınır (ay sonuna sıkıştırılarak). İleri tarihli gelir yatana kadar
/// kendi tarihinde kalır (gerçekleşen sayılır, bütçe planı değil). Yalnız taşınanlar: işlem kimliği → tarih
pub fn income_budget_dates<'a>(txs: &'a [Transaction], recurring: &'a [RecurringItem], today: &str) -> HashMap<&'a str, String> {
    let num = |s: &str, r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<i64>().ok()).unwrap_or(1);
    income_index(txs, recurring)
        .into_iter()
        .filter(|x| x.month != month_of(&x.t.date) && x.t.date.as_str() <= today)
        .map(|x| (x.t.id.as_str(), clamped_date(num(&x.month, 0..4), num(&x.month, 5..7) - 1, num(&x.t.date, 8..10))))
        .collect()
}

pub struct MonthIncome<'a> {
    pub regular_cents: i64,
    /// Düzenli bir gelirle eşleşmeyen gelirler, tutar büyükten küçüğe
    pub irregular: Vec<&'a Transaction>,
    pub irregular_cents: i64,
}

/// TS `splitMonthIncome`
pub fn split_month_income<'a>(txs: &'a [Transaction], recurring: &'a [RecurringItem], month: &str) -> MonthIncome<'a> {
    let mut out = MonthIncome { regular_cents: 0, irregular: Vec::new(), irregular_cents: 0 };
    for x in income_index(txs, recurring) {
        if x.month != month {
            continue;
        }
        let cents = js_cents(x.t.amount);
        if x.item.is_some() {
            out.regular_cents += cents;
        } else {
            out.irregular.push(x.t);
            out.irregular_cents += cents;
        }
    }
    out.irregular.sort_by(|a, b| b.amount.partial_cmp(&a.amount).unwrap_or(Ordering::Equal));
    out
}

pub struct RegularIncomeLine<'a> {
    pub item: &'a RecurringItem,
    pub date: String,
    pub planned_cents: i64,
    pub received_cents: i64,
    pub used_cents: i64,
    pub exception: Option<&'a MonthException>,
}

/// TS `regularIncomeForMonth`
pub fn regular_income_for_month<'a>(txs: &'a [Transaction], recurring: &'a [RecurringItem], month: &str) -> Vec<RegularIncomeLine<'a>> {
    let index = income_index(txs, recurring);
    active_incomes(recurring)
        .into_iter()
        .filter_map(|item| {
            // "Önceki ayın karşılığı" olan maaş bu ayın bütçesine bir sonraki ay yatar
            let paid_month = if item.covers_previous_month { shift_month(month, 1) } else { month.to_string() };
            let date = occurrence_in(item, &paid_month);
            let planned = js_cents(amount_for_occurrence(item, &date));
            let received: i64 = index.iter().filter(|x| x.item.is_some_and(|r| r.id == item.id) && x.month == month).map(|x| js_cents(x.t.amount)).sum();
            let started = has_started(item, &date);
            // Başlangıçtan önceki aylarda plan yok; yalnız gerçekten yatan gösterilir
            if !started && received <= 0 {
                return None;
            }
            let (planned_cents, used_cents) = if started { (planned, if received > 0 { received } else { planned }) } else { (0, received) };
            Some(RegularIncomeLine { item, date, planned_cents, received_cents: received, used_cents, exception: exception_for(item, month) })
        })
        .collect()
}

/// TS `regularExpenseForMonth`
pub fn regular_expense_for_month(recurring: &[RecurringItem], month: &str) -> i64 {
    recurring
        .iter()
        .filter(|r| r.kind == "expense" && r.active)
        .filter_map(|r| {
            let d = occurrence_in(r, month);
            has_started(r, &d).then(|| js_cents(amount_for_occurrence(r, &d)))
        })
        .sum()
}

/// Ana maaş: aktif TL düzenli gelirler içinde tutarı en büyük olan (eşitlikte ilk)
pub fn primary_salary<'a>(recurring: &'a [RecurringItem], date: &str) -> Option<&'a RecurringItem> {
    let mut v: Vec<&RecurringItem> = active_incomes(recurring).into_iter().filter(|r| r.orig_amount.is_none()).collect();
    v.sort_by(|a, b| amount_at(b, date).partial_cmp(&amount_at(a, date)).unwrap_or(Ordering::Equal));
    v.first().copied()
}

/// `date` tarihinden önce (veya o gün) yatan son maaşın tarihi
pub fn salary_paid_on_or_before(salary: &RecurringItem, date: &str) -> String {
    let month = month_of(date);
    let candidates = [shift_month(month, 1), month.to_string(), shift_month(month, -1), shift_month(month, -2)];
    candidates.iter().map(|m| occurrence_in(salary, m)).find(|d| d.as_str() <= date).unwrap_or_else(|| occurrence_in(salary, &candidates[3]))
}

/// `date` tarihinde ödenecek borcu karşılayan maaşın bütçe ayı
pub fn salary_month_for(salary: &RecurringItem, date: &str) -> String {
    let m = scheduled_month(salary, &salary_paid_on_or_before(salary, date));
    if salary.kind == "income" && salary.covers_previous_month {
        shift_month(&m, -1)
    } else {
        m
    }
}

/// Kart ekstresinin bütçe ayı: son ödemeden önce yatan son maaşın ayı; düzenli gelir yoksa kesimin ayı
pub fn card_budget_month(closing: &str, due: &str, recurring: &[RecurringItem]) -> String {
    match primary_salary(recurring, due) {
        Some(s) => salary_month_for(s, due),
        None => month_of(closing).to_string(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedIncome {
    pub regular_cents: i64,
    pub other_cents: i64,
    pub total_cents: i64,
}

/// TS `expectedIncomeThisMonth`
pub fn expected_income_this_month(txs: &[Transaction], recurring: &[RecurringItem], today: &str) -> ExpectedIncome {
    let month = month_of(today);
    let month_txs = month_income_txs(txs, month);
    let items = active_incomes(recurring);
    let assigned = assign_regular(&month_txs, &items);
    let (mut regular, mut other) = (0, 0);
    for item in &items {
        let date = occurrence_in(item, month);
        // Günü gelmiş maaş "beklenen" değil; kaydı istenir
        if date.as_str() <= today || !has_started(item, &date) {
            continue;
        }
        if month_txs.iter().any(|t| assigned.get(&t.id) == Some(&item.id)) {
            continue;
        }
        regular += js_cents(amount_for_occurrence(item, &date));
    }
    for t in &month_txs {
        if t.date.as_str() <= today {
            continue;
        }
        if assigned.contains_key(&t.id) {
            regular += js_cents(t.amount);
        } else {
            other += js_cents(t.amount);
        }
    }
    ExpectedIncome { regular_cents: regular, other_cents: other, total_cents: regular + other }
}

pub struct DueIncome<'a> {
    pub item: &'a RecurringItem,
    pub date: String,
    pub amount: f64,
}

/// TS `dueUnrecordedIncomes`: bu ay yatış günü gelmiş ama girilmemiş düzenli gelirler
pub fn due_unrecorded_incomes<'a>(txs: &[Transaction], recurring: &'a [RecurringItem], today: &str) -> Vec<DueIncome<'a>> {
    let month = month_of(today);
    let month_txs = month_income_txs(txs, month);
    let items = active_incomes(recurring);
    let assigned = assign_regular(&month_txs, &items);
    let mut out = Vec::new();
    for item in items {
        let date = occurrence_in(item, month);
        if date.as_str() > today || month_of(&date) != month || !has_started(item, &date) {
            continue;
        }
        if month_txs.iter().any(|t| assigned.get(&t.id) == Some(&item.id)) {
            continue;
        }
        let amount = amount_for_occurrence(item, &date);
        if amount > 0.0 {
            out.push(DueIncome { item, date, amount });
        }
    }
    out
}
