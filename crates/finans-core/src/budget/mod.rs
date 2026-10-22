//! Bütçe: arayüzdeki `budget.ts` ve Bütçe sayfasının hesaplarının aynısı (tutarlar kuruş).

pub mod expenses;
pub mod income;
pub mod recurring;
pub mod rollover;

use std::collections::HashMap;

use serde::Serialize;

use crate::accounts::cards::{js_cents, spread_installments};
use crate::order::cmp_tr;
use crate::db::{Account, Budget, Category, MonthException, RecurringItem, Transaction};
use crate::CoreResult;
use expenses::{budget_expenses, month_expenses};
use income::{due_unrecorded_incomes, expected_income_this_month, regular_expense_for_month, regular_income_for_month, split_month_income, ExpectedIncome};
use rollover::carry_by_category;
use recurring::{amount_at, amount_for_occurrence, cover_date, exception_for, has_started, month_of, occurrence_in, shift_month};

pub struct BudgetInput<'a> {
    pub accounts: &'a [Account],
    pub transactions: &'a [Transaction],
    pub recurring: &'a [RecurringItem],
    pub budgets: &'a [Budget],
    pub categories: &'a [Category],
    /// YYYY-MM
    pub month: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionOut {
    pub amount_cents: i64,
    pub note: String,
}

impl ExceptionOut {
    fn of(e: &MonthException) -> Self {
        ExceptionOut { amount_cents: js_cents(e.amount), note: e.note.clone() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryLine {
    pub category_id: String,
    pub spent_cents: i64,
    pub budget_cents: Option<i64>,
    /// Devri açıksa önceki aylardan gelen (eksi: aşım); kapalıysa None
    pub carry_cents: Option<i64>,
    /// Limiti varsa bu ayın payı: limit + devir (büyük aşım sonrası eksi olabilir)
    pub envelope_cents: Option<i64>,
    /// Pay − harcanan; eksiyse aşım
    pub left_cents: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetTotals {
    /// Gider kategorilerinin limitleri
    pub budget_cents: i64,
    /// Devri açık kategorilerin önceki aylardan gelen toplamı
    pub carry_cents: i64,
    /// Bu ayın payları: limitler + devir
    pub envelope_cents: i64,
    /// Limiti olan gider kategorilerinin harcananı
    pub spent_budgeted_cents: i64,
    pub remaining_cents: i64,
    /// Bu ayın bütün bütçe giderleri (bütçe ayına göre)
    pub spent_all_cents: i64,
    /// Aynı giderler harcama tarihine göre
    pub by_date_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeLine {
    pub recurring_id: String,
    pub date: String,
    pub planned_cents: i64,
    pub received_cents: i64,
    pub used_cents: i64,
    pub exception: Option<ExceptionOut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxCents {
    pub transaction_id: String,
    pub cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCents {
    pub account_id: String,
    pub cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringRow {
    pub recurring_id: String,
    pub date: String,
    pub started: bool,
    pub upcoming: bool,
    pub amount_cents: i64,
    /// İstisnasız tutar ("bu ay yok" satırında üstü çizili gösterilir)
    pub base_amount_cents: i64,
    pub exception: Option<ExceptionOut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringTotals {
    pub income_cents: i64,
    pub expense_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetReport {
    pub month: String,
    /// Sayfadaki önceki / sonraki ay düğmeleri
    pub prev_month: String,
    pub next_month: String,
    pub categories: Vec<CategoryLine>,
    /// Kategorisiz giderler; o ay kategorisiz kayıt yoksa None (tutarı 0 olan kayıt varsa Some(0))
    pub uncategorized_cents: Option<i64>,
    pub totals: BudgetTotals,
    pub income_lines: Vec<IncomeLine>,
    pub regular_income_cents: i64,
    pub irregular_incomes: Vec<TxCents>,
    pub irregular_income_cents: i64,
    pub regular_expense_cents: i64,
    pub budget_reserved_cents: i64,
    pub irregular_expense_by_account: Vec<AccountCents>,
    pub irregular_expense_cents: i64,
    pub left_cents: i64,
    pub recurring_rows: Vec<RecurringRow>,
    pub recurring_totals: RecurringTotals,
}

/// Bütçe sayfasının kategori sırası: bütçesi olanlar önce, bu ay en çok harcanan önce, sonra ad
pub fn sort_category_lines(lines: &mut [CategoryLine], categories: &[Category]) {
    let name: HashMap<&str, &str> = categories.iter().map(|c| (c.id.as_str(), c.name.as_str())).collect();
    let name_of = |l: &CategoryLine| name.get(l.category_id.as_str()).copied().unwrap_or("");
    lines.sort_by(|a, b| {
        b.budget_cents.is_some().cmp(&a.budget_cents.is_some()).then(b.spent_cents.cmp(&a.spent_cents)).then_with(|| cmp_tr(name_of(a), name_of(b)))
    });
}

/// YYYY-MM, ay 01–12
pub fn valid_month(m: &str) -> bool {
    let b = m.as_bytes();
    b.len() == 7 && b[4] == b'-' && b[..4].iter().chain(&b[5..]).all(u8::is_ascii_digit) && (1..=12).contains(&m[5..7].parse::<u32>().unwrap_or(0))
}

pub fn report(input: &BudgetInput) -> CoreResult<BudgetReport> {
    let month = input.month;
    if !valid_month(month) {
        return Err("Geçersiz ay".into());
    }
    let (txs, rec) = (input.transactions, input.recurring);
    let all = budget_expenses(txs, input.accounts, rec);
    let carry = carry_by_category(&all, input.budgets, month);

    // Bu ayın bütçe giderleri kategoriye göre (Bütçe sayfasındaki spentBy; None = kategorisiz)
    let mut spent_by: HashMap<Option<&str>, i64> = HashMap::new();
    for e in all.iter().filter(|e| e.month == month) {
        *spent_by.entry(e.t.category_id.as_deref()).or_default() += e.cents;
    }
    let budget_by: HashMap<&str, f64> = input.budgets.iter().map(|b| (b.category_id.as_str(), b.amount)).collect();
    let mut categories: Vec<CategoryLine> = input
        .categories
        .iter()
        .filter(|c| c.kind == "expense")
        .map(|c| {
            let spent_cents = spent_by.get(&Some(c.id.as_str())).copied().unwrap_or(0);
            let budget_cents = budget_by.get(c.id.as_str()).map(|v| js_cents(*v));
            let carry_cents = carry.get(&c.id).copied();
            let envelope_cents = budget_cents.map(|b| b + carry_cents.unwrap_or(0));
            CategoryLine { category_id: c.id.clone(), spent_cents, budget_cents, carry_cents, envelope_cents, left_cents: envelope_cents.map(|e| e - spent_cents) }
        })
        .collect();
    sort_category_lines(&mut categories, input.categories);
    let budget_cents: i64 = categories.iter().filter_map(|l| l.budget_cents).sum();
    let spent_budgeted_cents: i64 = categories.iter().filter(|l| l.budget_cents.is_some()).map(|l| l.spent_cents).sum();
    let carry_cents: i64 = categories.iter().filter(|l| l.budget_cents.is_some()).filter_map(|l| l.carry_cents).sum();
    let by_date_cents: i64 =
        txs.iter().filter(|t| t.kind == "expense").flat_map(spread_installments).filter(|p| month_of(&p.date) == month).map(|p| p.cents).sum();
    let totals = BudgetTotals {
        budget_cents,
        carry_cents,
        envelope_cents: budget_cents + carry_cents,
        spent_budgeted_cents,
        remaining_cents: budget_cents + carry_cents - spent_budgeted_cents,
        spent_all_cents: spent_by.values().sum(),
        by_date_cents,
    };

    let income_lines: Vec<IncomeLine> = regular_income_for_month(txs, rec, month)
        .into_iter()
        .map(|l| IncomeLine {
            recurring_id: l.item.id.clone(),
            date: l.date,
            planned_cents: l.planned_cents,
            received_cents: l.received_cents,
            used_cents: l.used_cents,
            exception: l.exception.map(ExceptionOut::of),
        })
        .collect();
    let regular_income_cents: i64 = income_lines.iter().map(|l| l.used_cents).sum();
    let mi = split_month_income(txs, rec, month);
    let regular_expense_cents = regular_expense_for_month(rec, month);
    let me = month_expenses(&all, rec, input.budgets, &carry, month);
    // Düzensiz giderler hesaplara göre: ilk görülme sırası, sonra kuruş büyükten küçüğe
    let mut by_account: Vec<AccountCents> = Vec::new();
    for e in &me.irregular {
        match by_account.iter_mut().find(|x| x.account_id == e.t.account_id) {
            Some(x) => x.cents += e.cents,
            None => by_account.push(AccountCents { account_id: e.t.account_id.clone(), cents: e.cents }),
        }
    }
    by_account.sort_by_key(|a| std::cmp::Reverse(a.cents));
    let left_cents = regular_income_cents + mi.irregular_cents - regular_expense_cents - me.budget_reserved_cents - me.irregular_cents;

    let mut recurring_rows = Vec::with_capacity(rec.len());
    let mut recurring_totals = RecurringTotals { income_cents: 0, expense_cents: 0 };
    for r in rec {
        let paid = if r.kind == "income" && r.covers_previous_month { shift_month(month, 1) } else { month.to_string() };
        let date = occurrence_in(r, &paid);
        let started = has_started(r, &date);
        let upcoming = !started && r.start_date.as_deref().is_some_and(|s| !s.is_empty() && s > date.as_str());
        let cover = cover_date(r, &date);
        let amount_cents = js_cents(amount_for_occurrence(r, &date));
        if started && r.active {
            match r.kind.as_str() {
                "income" => recurring_totals.income_cents += amount_cents,
                "expense" => recurring_totals.expense_cents += amount_cents,
                _ => {}
            }
        }
        recurring_rows.push(RecurringRow {
            recurring_id: r.id.clone(),
            base_amount_cents: js_cents(amount_at(r, &cover)),
            exception: exception_for(r, month_of(&cover)).map(ExceptionOut::of),
            date,
            started,
            upcoming,
            amount_cents,
        });
    }

    Ok(BudgetReport {
        month: month.to_string(),
        prev_month: shift_month(month, -1),
        next_month: shift_month(month, 1),
        categories,
        uncategorized_cents: spent_by.get(&None).copied(),
        totals,
        income_lines,
        regular_income_cents,
        irregular_incomes: mi.irregular.iter().map(|t| TxCents { transaction_id: t.id.clone(), cents: js_cents(t.amount) }).collect(),
        irregular_income_cents: mi.irregular_cents,
        regular_expense_cents,
        budget_reserved_cents: me.budget_reserved_cents,
        irregular_expense_by_account: by_account,
        irregular_expense_cents: me.irregular_cents,
        left_cents,
        recurring_rows,
        recurring_totals,
    })
}

pub struct IncomeStatusInput<'a> {
    pub transactions: &'a [Transaction],
    pub recurring: &'a [RecurringItem],
    /// YYYY-MM-DD (Türkiye saati)
    pub today: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueOut {
    pub recurring_id: String,
    pub date: String,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeStatus {
    pub expected: ExpectedIncome,
    pub due: Vec<DueOut>,
}

pub fn income_status(input: &IncomeStatusInput) -> IncomeStatus {
    IncomeStatus {
        expected: expected_income_this_month(input.transactions, input.recurring, input.today),
        due: due_unrecorded_incomes(input.transactions, input.recurring, input.today)
            .into_iter()
            .map(|d| DueOut { recurring_id: d.item.id.clone(), date: d.date, amount_cents: js_cents(d.amount) })
            .collect(),
    }
}
