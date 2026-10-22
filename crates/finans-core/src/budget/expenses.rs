//! Gider tarafı: giderlerin bütçe aylarına dağılımı (TS `budgetExpenses`, `monthExpenses`).

use std::collections::HashMap;

use super::income::{card_budget_month, matches_regular};
use super::recurring::month_of;
use crate::accounts::cards::{installment_postings, js_cents, spread_installments};
use crate::db::{Account, Budget, RecurringItem, Transaction};

/// Bütçe ayına yazılmış gider parçası (taksitliyse bu ayın payı)
#[derive(Debug, Clone)]
pub struct BudgetExpense<'a> {
    pub t: &'a Transaction,
    pub cents: i64,
    pub month: String,
}

/// Kart harcamaları (taksitleri dahil) ekstresini ödeyecek maaşın ayına, diğerleri tarihlerinin ayına
pub fn budget_expenses<'a>(txs: &'a [Transaction], accounts: &[Account], recurring: &[RecurringItem]) -> Vec<BudgetExpense<'a>> {
    let by_id: HashMap<&str, &Account> = accounts.iter().map(|a| (a.id.as_str(), a)).collect();
    let mut out = Vec::new();
    for t in txs.iter().filter(|t| t.kind == "expense") {
        match by_id.get(t.account_id.as_str()) {
            Some(a) if a.kind == "credit_card" => {
                for p in installment_postings(a, &t.date, t.amount, t.installments) {
                    out.push(BudgetExpense { t, cents: p.cents, month: card_budget_month(&p.closing_date, &p.due_date, recurring) });
                }
            }
            _ => {
                for p in spread_installments(t) {
                    out.push(BudgetExpense { t, cents: p.cents, month: month_of(&p.date).to_string() });
                }
            }
        }
    }
    out
}

pub struct MonthExpenses<'a> {
    /// Bütçeli kategoriler: limit, aşıldıysa harcanan (bütün bütçeler); devreden artı tutarla karşılanan harcama bu aydan düşülmez
    pub budget_reserved_cents: i64,
    /// Bütçesiz kategorilerde ve düzenli gidere karşılık gelmeyen harcamalar, kuruş büyükten küçüğe
    pub irregular: Vec<BudgetExpense<'a>>,
    pub irregular_cents: i64,
}

/// TS `monthExpenses` (`all` = `budget_expenses` çıktısı, `carry` = `carry_by_category`)
pub fn month_expenses<'a>(
    all: &[BudgetExpense<'a>],
    recurring: &[RecurringItem],
    budgets: &[Budget],
    carry: &HashMap<String, i64>,
    month: &str,
) -> MonthExpenses<'a> {
    let budget_by: HashMap<&str, i64> = budgets.iter().map(|b| (b.category_id.as_str(), js_cents(b.amount))).collect();
    let regular: Vec<&RecurringItem> = recurring.iter().filter(|r| r.kind == "expense" && r.active).collect();
    let mut spent_by: HashMap<&str, i64> = HashMap::new();
    let mut out = MonthExpenses { budget_reserved_cents: 0, irregular: Vec::new(), irregular_cents: 0 };
    for e in all.iter().filter(|e| e.month == month) {
        if let Some(cat) = e.t.category_id.as_deref().filter(|c| !c.is_empty() && budget_by.contains_key(c)) {
            *spent_by.entry(cat).or_default() += e.cents;
            continue;
        }
        // Kira gibi düzenli gidere karşılık gelen harcama zaten "Düzenli gider" içinde
        if regular.iter().any(|r| matches_regular(e.t, r)) {
            continue;
        }
        out.irregular_cents += e.cents;
        out.irregular.push(e.clone());
    }
    // Artı devir: önceki aylardan artan para o aylarda zaten ayrılmıştı; bu ay yalnız onu aşan harcama yeni para ister.
    // Eksi devir: geçen ayın aşımı o ayın kalanından düştü; bu ay yalnız küçülen pay ayrılır (aşım iki kez sayılmaz).
    out.budget_reserved_cents = budget_by
        .iter()
        .map(|(c, limit)| {
            let spent = spent_by.get(c).copied().unwrap_or(0);
            let carry = carry.get(*c).copied().unwrap_or(0);
            (limit + carry.min(0)).max(spent - carry.max(0))
        })
        .sum();
    out.irregular.sort_by_key(|a| std::cmp::Reverse(a.cents));
    out
}
