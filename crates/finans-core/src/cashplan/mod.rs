//! Ödeme takvimi: arayüzdeki `plan.ts` hesaplarının aynısı (tutarlar kuruş) ve dönemin ödendi/yattı satırları.

pub mod incomes;
pub mod labels;
pub mod obligations;
pub mod settled;

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;

use crate::accounts::bank::tl_balance;
use crate::accounts::cards::add_days;
use crate::budget::income::{primary_salary, salary_month_for};
use crate::budget::recurring::{month_of, occurrence_in, shift_month};
use crate::db::{Account, RecurringItem, Transaction};
use crate::CoreResult;
pub use incomes::IncomeEvent;
use incomes::{income_events, with_future_incomes};
pub use labels::{obligation_label, PlanNames};
pub use obligations::{Installment, Obligation};
pub use settled::{PaidRow, ReceivedRow};
use obligations::{add_months, is_cash_account, is_foreign};

pub struct CashPlanInput<'a> {
    pub accounts: &'a [Account],
    pub transactions: &'a [Transaction],
    pub recurring: &'a [RecurringItem],
    pub today: &'a str,
    /// Ufuk (ay)
    pub months: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SalaryInfo {
    pub recurring_id: String,
    pub paid_on: String,
    pub next_paid_on: String,
    /// Dönemin son günü (sonraki maaştan bir gün önce)
    pub period_end: String,
    /// Bu döneme ait maaş yatışı (yatmayacaksa skipped)
    pub event: Option<IncomeEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    /// YYYY-MM: maaş döneminde maaşın ait olduğu ay, yoksa takvim ayı
    pub month: String,
    pub salary: Option<SalaryInfo>,
    pub incomes: Vec<IncomeEvent>,
    pub obligations: Vec<Obligation>,
    /// Dönemin gecikmiş ödemeleri (toplama dahil)
    pub overdue_cents: i64,
    pub income_cents: i64,
    pub total_cents: i64,
    pub left_cents: i64,
    /// Bugünkü nakitten başlayarak dönem sonundaki tahmini bakiye
    pub balance_cents: i64,
    /// Dönemin zaten ödenmiş kalemleri (bakiye tahminine girmez)
    pub paid: Vec<PaidRow>,
    /// Dönemin zaten yatmış tek seferlik gelirleri
    pub received: Vec<ReceivedRow>,
    /// Başlıkta gösterilen: ödendi/yattı dahil
    pub period_income_cents: i64,
    pub period_total_cents: i64,
    pub period_left_cents: i64,
    /// Yalnız ödendi/yattı satırları için gösterilen dönem
    pub settled_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashPlanReport {
    pub months: Vec<Period>,
    /// Bütün dönemlerin gecikmiş ödemeleri, tarihe ve ada göre (takvimde en üstte ayrı kart)
    pub overdue: Vec<Obligation>,
    pub overdue_cents: i64,
    /// TL banka + nakit hesaplarının bugünkü bakiyesi
    pub liquid_cents: i64,
    pub total_income_cents: i64,
    pub total_obligation_cents: i64,
    /// Dönem sonu tahmini: bugünkü nakit + planlanan gelir − planlanan ödemeler
    pub end_cents: i64,
}

#[derive(Debug, Clone, Default)]
struct Slot {
    incomes: Vec<IncomeEvent>,
    obligations: Vec<Obligation>,
    paid: Vec<PaidRow>,
    received: Vec<ReceivedRow>,
    settled_only: bool,
}

/// Dönem anahtarı: ana maaş varsa o tarihte ödenecek borcu karşılayan maaşın ayı, yoksa takvim ayı
fn key_of(salary: Option<&RecurringItem>, date: &str) -> String {
    match salary {
        Some(s) => salary_month_for(s, date),
        None => month_of(date).to_string(),
    }
}

/// Ödeme takvimi (TS `buildCashPlan`): her ödeme son ödemeden önce yatan son gelire yazılır; maaş dönemlerine ya da
/// takvim aylarına gruplanır
pub fn cash_plan(input: &CashPlanInput) -> CoreResult<CashPlanReport> {
    if !(1..=24).contains(&input.months) {
        return Err("Geçersiz süre".into());
    }
    let today = input.today;
    let names = PlanNames::new(input.accounts, input.recurring, input.transactions);
    let until = add_months(today, input.months);
    // TL nakit akışı: döviz/altın hesabına bağlı düzenli kalemler ve o hesaplara gelirler dahil edilmez
    let foreign: HashSet<&str> = input.accounts.iter().filter(|a| is_foreign(&a.currency)).map(|a| a.id.as_str()).collect();
    let recurring: Vec<RecurringItem> =
        input.recurring.iter().filter(|r| r.account_id.as_deref().is_none_or(|id| !foreign.contains(id))).cloned().collect();
    let txs: Vec<Transaction> = input.transactions.iter().filter(|t| t.kind != "income" || !foreign.contains(t.account_id.as_str())).cloned().collect();
    let obs = obligations::obligations(input.accounts, &txs, &recurring, today, &until);
    // Bugünden önceki son gelir de dahil: ilk ödemeler o maaştan karşılanıyor olabilir
    let events = with_future_incomes(income_events(&recurring, &add_months(today, -1), &until), &txs, &recurring, today, &until);
    let funding: HashMap<&str, &str> =
        input.accounts.iter().filter_map(|a| a.funding_income_id.as_deref().filter(|f| !f.is_empty()).map(|f| (a.id.as_str(), f))).collect();

    // "Önceki ayın karşılığı" gelir varsa kart ekstreleri ait oldukları ayın gelirine yazılır
    let month_mode = recurring.iter().any(|r| r.kind == "income" && r.active && r.covers_previous_month);
    let covers_prev: HashSet<&str> = recurring.iter().filter(|r| r.covers_previous_month).map(|r| r.id.as_str()).collect();
    let mut funded: Vec<Obligation> = Vec::with_capacity(obs.len());
    for ob in &obs {
        let preferred = ob.account_id.as_deref().and_then(|id| funding.get(id).copied());
        let mut pick: Option<&IncomeEvent> = None;
        if month_mode && ob.kind == "card" {
            let same: Vec<&IncomeEvent> = events.iter().filter(|e| !e.skipped && !e.one_time && e.cover_month == ob.period_month).collect();
            pick = preferred
                .and_then(|p| same.iter().copied().find(|e| e.recurring_id.as_deref() == Some(p)))
                .or_else(|| same.iter().copied().find(|e| e.recurring_id.as_deref().is_some_and(|id| covers_prev.contains(id))))
                .or_else(|| same.first().copied());
        }
        if pick.is_none() {
            // Son ödemeden önce yatan son gelir; yatmayacak aylar atlanır
            let due = if ob.overdue { today } else { ob.date.as_str() };
            let eligible: Vec<&IncomeEvent> = events.iter().filter(|e| e.date.as_str() <= due && !e.skipped).collect();
            pick = preferred
                .and_then(|p| eligible.iter().rev().copied().find(|e| e.recurring_id.as_deref() == Some(p)))
                .or_else(|| eligible.last().copied());
        }
        funded.push(Obligation { before_income: pick.is_some_and(|p| !ob.overdue && p.date > ob.date), ..ob.clone() });
    }

    // Bugünkü nakit: ileri tarihli işlemler sayılmaz
    let liquid_cents: i64 = input.accounts.iter().filter(|a| is_cash_account(a)).map(|a| tl_balance(a, &txs, today)).sum();

    let salary = primary_salary(&recurring, today);
    let current = key_of(salary, today);
    let mut slots: BTreeMap<String, Slot> = BTreeMap::new();
    let mut removed_current: Option<Slot> = None;
    if let Some(s) = salary {
        // Her ödeme son ödeme gününden önce yatan son maaşın dönemine; düzenli gelirler ve bütçe ayı seçilmiş tek seferlik
        // gelirler ait oldukları aya, diğer gelirler yattıkları döneme
        for ob in &obs {
            let at = if ob.overdue { today } else { ob.date.as_str() };
            slots.entry(key_of(salary, at)).or_default().obligations.push(Obligation { before_income: false, ..ob.clone() });
        }
        for e in &events {
            let key = if !e.one_time || e.fixed_month { e.cover_month.clone() } else { key_of(salary, &e.date) };
            if key < current {
                continue;
            }
            slots.entry(key).or_default().incomes.push(e.clone());
        }
        // Maaşı yatmış ve ödemesi kalmamış dönem ile maaşı ufkun dışında yatacak son dönem gösterilmez
        removed_current = slots.get(&current).cloned();
        slots.retain(|k, v| {
            let paid_on = occurrence_in(s, &if s.covers_previous_month { shift_month(k, 1) } else { k.clone() });
            !((v.obligations.is_empty() && v.incomes.iter().all(|e| e.date.as_str() < today)) || paid_on > until)
        });
    } else {
        // Takvim ayları: gelir yattığı ayda, ödeme son ödeme ayında (gecikmişler bu ayda)
        let this_month = month_of(today).to_string();
        for ob in &funded {
            let key = if ob.overdue { this_month.clone() } else { month_of(&ob.date).to_string() };
            slots.entry(key).or_default().obligations.push(ob.clone());
        }
        for e in &events {
            if month_of(&e.date) < this_month.as_str() {
                continue;
            }
            slots.entry(month_of(&e.date).to_string()).or_default().incomes.push(e.clone());
        }
    }

    // Ödendi/yattı satırları yalnız gösterilen dönemlere; içinde bulunulan dönem gizlendiyse (ileriye dönük kalemi kalmadı)
    // ve maaşı ufuk içinde yatıyorsa yalnız bu satırlar için yeniden gösterilir
    let current_in_horizon =
        salary.is_none_or(|s| occurrence_in(s, &if s.covers_previous_month { shift_month(&current, 1) } else { current.clone() }) <= until);
    let listed: HashSet<&str> = obs.iter().map(|o| o.key.as_str()).collect();
    let st = settled::settled(input.accounts, &txs, &recurring, today, salary, &listed);
    let slot_for = |slots: &mut BTreeMap<String, Slot>, key: &str| -> bool {
        if slots.contains_key(key) {
            return true;
        }
        if key != current || !current_in_horizon {
            return false;
        }
        slots.insert(key.to_string(), Slot { settled_only: true, ..removed_current.clone().unwrap_or_default() });
        true
    };
    for (key, row) in st.paid {
        if slot_for(&mut slots, &key) {
            slots.get_mut(&key).unwrap().paid.push(row);
        }
    }
    for (key, row) in st.received {
        if slot_for(&mut slots, &key) {
            slots.get_mut(&key).unwrap().received.push(row);
        }
    }

    let salary_info = |month: &str| {
        salary.map(|s| {
            let paid_month = if s.covers_previous_month { shift_month(month, 1) } else { month.to_string() };
            SalaryInfo {
                recurring_id: s.id.clone(),
                paid_on: occurrence_in(s, &paid_month),
                next_paid_on: occurrence_in(s, &shift_month(&paid_month, 1)),
                period_end: add_days(&occurrence_in(s, &shift_month(&paid_month, 1)), -1),
                event: events.iter().find(|e| e.recurring_id.as_deref() == Some(s.id.as_str()) && e.cover_month == month).cloned(),
            }
        })
    };
    let mut balance = liquid_cents;
    let mut months = Vec::with_capacity(slots.len());
    for (month, mut v) in slots {
        v.obligations.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.key.cmp(&b.key)));
        v.paid.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.key.cmp(&b.key)));
        labels::label_obligations(&mut v.obligations, &names);
        labels::label_paid(&mut v.paid, &names);
        v.received.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.key.cmp(&b.key)));
        let paid_cents: i64 = v.paid.iter().map(|p| p.amount_cents).sum();
        let received_cents: i64 = v.received.iter().map(|r| r.amount_cents).sum();
        let income_cents: i64 = v.incomes.iter().filter(|e| !e.skipped).map(|e| e.amount_cents).sum();
        // Geçmiş tarihli gelirler zaten bugünkü nakitte
        let future_income: i64 = v.incomes.iter().filter(|e| e.is_upcoming(today)).map(|e| e.amount_cents).sum();
        let total_cents: i64 = v.obligations.iter().map(|o| o.amount_cents).sum();
        let overdue_cents: i64 = v.obligations.iter().filter(|o| o.overdue).map(|o| o.amount_cents).sum();
        balance += future_income - total_cents;
        months.push(Period {
            salary: salary_info(&month),
            income_cents,
            overdue_cents,
            total_cents,
            left_cents: income_cents - total_cents,
            balance_cents: balance,
            period_income_cents: income_cents + received_cents,
            period_total_cents: total_cents + paid_cents,
            period_left_cents: income_cents + received_cents - total_cents - paid_cents,
            paid: v.paid,
            received: v.received,
            settled_only: v.settled_only,
            incomes: v.incomes,
            obligations: v.obligations,
            month,
        });
    }
    let total_income_cents = months.iter().flat_map(|m| &m.incomes).filter(|e| e.is_upcoming(today)).map(|e| e.amount_cents).sum();
    let mut overdue: Vec<Obligation> = months.iter().flat_map(|m| m.obligations.iter().filter(|o| o.overdue).cloned()).collect();
    labels::sort_by_date_label(&mut overdue);
    let overdue_cents = overdue.iter().map(|o| o.amount_cents).sum();
    let total_obligation_cents: i64 = obs.iter().map(|o| o.amount_cents).sum();
    let end_cents = liquid_cents + total_income_cents - total_obligation_cents;
    Ok(CashPlanReport { total_obligation_cents, end_cents, months, overdue, overdue_cents, liquid_cents, total_income_cents })
}

pub struct UpcomingInput<'a> {
    pub accounts: &'a [Account],
    pub transactions: &'a [Transaction],
    pub today: &'a str,
    pub days: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpcomingObligations {
    pub obligations: Vec<Obligation>,
}

/// Genel Bakış: önümüzdeki `days` gündeki (ve gecikmiş) ödemeler, düzenli giderler hariç (TS `upcomingObligations`)
pub fn upcoming(input: &UpcomingInput) -> CoreResult<UpcomingObligations> {
    if !(1..=365).contains(&input.days) {
        return Err("Geçersiz süre".into());
    }
    let until = add_days(input.today, input.days);
    let mut obligations = obligations::obligations(input.accounts, input.transactions, &[], input.today, &until);
    labels::label_obligations(&mut obligations, &PlanNames::new(input.accounts, &[], input.transactions));
    Ok(UpcomingObligations { obligations })
}
