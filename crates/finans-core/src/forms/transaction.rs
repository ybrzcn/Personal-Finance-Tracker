//! İşlem formu önizlemesi (TS `TransactionForm`): TL karşılığı, kur tarafı, nakit avans planı, taksit ekstreleri, nakit eksi denetimi

use serde::{Deserialize, Serialize};

use super::{is_foreign, qty_decimals, tl_cents_of, unit};
use crate::accounts::bank::{qty_at, tl_balance};
use crate::accounts::cards::{first_tracked_closing, installment_postings, js_round};
use crate::fx::time::days_between;
use crate::budget::recurring::shift_month;
use crate::db::{Account, Category, Transaction};
use crate::rules::{build_history, suggest_category, CategoryRule};

fn one() -> i64 {
    1
}

/// Formun taslağı; sayılar formda ayrıştırılmış hâlde (geçersizse null)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionDraft {
    #[serde(rename = "type")]
    pub kind: String,
    pub account_id: String,
    #[serde(default)]
    pub to_account_id: Option<String>,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default = "one")]
    pub installments: i64,
    #[serde(default)]
    pub qty: Option<f64>,
    #[serde(default)]
    pub rate: Option<f64>,
    #[serde(default)]
    pub to_qty: Option<f64>,
    #[serde(default)]
    pub to_rate: Option<f64>,
    /// Düzenlenen kayıt (nakit eksi denetiminde bakiyeden çıkarılır)
    #[serde(default)]
    pub editing_id: Option<String>,
    #[serde(default)]
    pub budget_month: Option<String>,
    /// Yalnız yeni kayıtta nakit avans açıksa
    #[serde(default)]
    pub cash_advance: Option<CashAdvanceDraft>,
    /// Kategori önerisi için açıklama
    #[serde(default)]
    pub description: String,
}

/// Nakit avans alanları; elle yazılmayan alan null
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashAdvanceDraft {
    pub fee_rate_pct: f64,
    #[serde(default)]
    pub fee: Option<f64>,
    pub rate_pct: f64,
    #[serde(default)]
    pub installment: Option<f64>,
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub parts: Option<AdvanceParts>,
}

/// Ödeme planındaki toplam faiz / KKDF / BSMV (TL, elle yazılan)
#[derive(Debug, Clone, Deserialize)]
pub struct AdvanceParts {
    pub faiz: f64,
    pub kkdf: f64,
    pub bsmv: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashAdvancePreview {
    /// TL (TS gibi kuruştan ince olabilir)
    pub fee: f64,
    /// TL
    pub installment: f64,
    /// TL
    pub total: f64,
    pub interest_cents: i64,
    pub faiz_cents: i64,
    pub kkdf_cents: i64,
    pub bsmv_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostingRow {
    pub closing_date: String,
    pub due_date: String,
    pub cents: i64,
    /// Takip başlangıcından önceki ekstreye düştü (ödenmiş sayılır)
    pub settled: bool,
}

/// Kayıt sonrası nakit bakiyesi: `minor / divisor` hesabın biriminde
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashAfter {
    pub minor: i64,
    pub divisor: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionPreview {
    /// Kaynak ya da hedef TL dışıysa TL karşılığı (kaydedilen tutar)
    pub tl_cents: Option<i64>,
    /// Dövizden dövize transferde hedef miktar önerisi
    pub to_qty_suggestion: Option<f64>,
    pub from_side: Option<&'static str>,
    pub to_side: Option<&'static str>,
    /// Nakit avansın ilk son ödeme tarihi
    pub first_due: Option<String>,
    /// Çekimden ilk son ödemeye kadar geçen gün (ilk taksitin faiz günü)
    pub first_period_days: Option<i64>,
    pub advance: Option<CashAdvancePreview>,
    /// Kart taksitinde aylık tutar (TL)
    pub per_installment: Option<f64>,
    pub postings: Option<Vec<PostingRow>>,
    pub cash_after: Option<CashAfter>,
    pub budget_month_options: Vec<String>,
    /// Açıklamaya göre önerilen kategori (transfer ve boş açıklamada null)
    pub suggested_category_id: Option<String>,
}

/// TS `defaultSide`: TL'den TL dışına satış kuru, diğerleri alış
fn default_side(from: &str, to: Option<&str>) -> &'static str {
    if to.is_some_and(is_foreign) && !is_foreign(from) {
        "sell"
    } else {
        "buy"
    }
}

struct Plan {
    first_payment: i64,
    total: i64,
    interest: i64,
    kkdf: i64,
    bsmv: i64,
}

/// TS `cashAdvancePlan`: ilk dönem faizi gün/30, sonrakiler aylık; KKDF ve BSMV faizin %15'er'i; son taksit farkı kapatır
fn cash_advance_plan(principal: i64, r: f64, n: i64, first_period_days: i64) -> Plan {
    let days = first_period_days.max(0) as f64;
    let re = r * 1.3;
    let rest = if re > 0.0 { (1.0 - (1.0 + re).powf(-((n - 1) as f64))) / re } else { (n - 1) as f64 };
    let pmt = js_round((principal as f64 * (1.0 + (re * days) / 30.0)) / (1.0 + rest));
    let mut plan = Plan { first_payment: 0, total: 0, interest: 0, kkdf: 0, bsmv: 0 };
    let mut balance = principal;
    for i in 0..n {
        let interest = js_round(balance as f64 * r * if i == 0 { days / 30.0 } else { 1.0 });
        let tax = js_round(interest as f64 * 0.15);
        let p = if i == n - 1 { balance } else { balance.min(pmt - interest - 2 * tax) };
        balance -= p;
        let payment = p + interest + 2 * tax;
        if i == 0 {
            plan.first_payment = payment;
        }
        plan.total += payment;
        plan.interest += interest;
        plan.kkdf += tax;
        plan.bsmv += tax;
    }
    plan
}

fn advance(ca: &CashAdvanceDraft, parsed: f64, n: i64, date: &str, first_due: Option<&str>) -> CashAdvancePreview {
    let principal = js_round(parsed * 100.0);
    let fee = ca.fee.unwrap_or_else(|| js_round(principal as f64 * ca.fee_rate_pct) as f64 / 10000.0);
    let mut installment = parsed;
    let days = first_due.map_or(30, |d| days_between(date, d));
    let auto = (n > 1).then(|| cash_advance_plan(principal, ca.rate_pct / 100.0, n, days));
    if let Some(a) = &auto {
        installment = ca.installment.unwrap_or(a.first_payment as f64 / 100.0);
    }
    let cents = |v: f64| js_round(v * 100.0);
    let mut total_cents = match &auto {
        Some(a) if ca.installment.is_none() => a.total,
        _ => js_round(installment * n as f64 * 100.0),
    };
    if n > 1 {
        if let Some(p) = &ca.parts {
            total_cents = principal + cents(p.faiz) + cents(p.kkdf) + cents(p.bsmv);
        } else if let Some(t) = ca.total {
            total_cents = cents(t);
        }
    }
    let total = if n > 1 { total_cents as f64 / 100.0 } else { parsed };
    if n > 1 && (ca.parts.is_some() || ca.total.is_some()) {
        installment = js_round(total_cents as f64 / n as f64) as f64 / 100.0;
    }
    let interest = (if n > 1 { total_cents - principal } else { 0 }).max(0);
    let mut faiz = js_round(interest as f64 / 1.3);
    let mut kkdf = js_round(faiz as f64 * 0.15);
    let mut bsmv = interest - faiz - kkdf;
    if let Some(a) = auto.as_ref().filter(|a| a.total == total_cents) {
        (faiz, kkdf, bsmv) = (a.interest, a.kkdf, a.bsmv);
    }
    if let Some(p) = &ca.parts {
        (faiz, kkdf, bsmv) = (cents(p.faiz), cents(p.kkdf), cents(p.bsmv));
    }
    CashAdvancePreview { fee, installment, total, interest_cents: interest, faiz_cents: faiz, kkdf_cents: kkdf, bsmv_cents: bsmv }
}

/// Önizleme işlem listesini yalnız nakit eksi denetiminde kullanır (kaynak nakit hesap, gider ya da transfer)
pub fn needs_transactions(d: &TransactionDraft, accounts: &[Account]) -> bool {
    wants_suggestion(d) || d.kind != "income" && accounts.iter().any(|a| a.id == d.account_id && a.kind == "cash")
}

/// Kategori önerisi yalnız transfer dışında ve açıklama doluyken (TS `onDescription`); kategoriler ve kurallar o zaman gerekir
pub fn wants_suggestion(d: &TransactionDraft) -> bool {
    d.kind != "transfer" && !crate::import::js_trim(&d.description).is_empty()
}

/// İşlem formunun bütün önizleme hesapları (TS `TransactionForm`)
pub fn transaction_preview(d: &TransactionDraft, accounts: &[Account], txs: &[Transaction], categories: &[Category], rules: &[CategoryRule], today: &str) -> TransactionPreview {
    let account = accounts.iter().find(|a| a.id == d.account_id);
    let to_account = if d.kind == "transfer" { d.to_account_id.as_deref().and_then(|id| accounts.iter().find(|a| a.id == id)) } else { None };
    let from_cur = account.map_or("TRY", |a| a.currency.as_str());
    let to_cur = to_account.map_or("TRY", |a| a.currency.as_str());
    let from_fx = is_foreign(from_cur);
    let to_fx = d.kind == "transfer" && is_foreign(to_cur);
    let can_install = d.kind == "expense" && account.is_some_and(|a| a.kind == "credit_card");
    // Kayıt 1–36 taksit kabul eder; bozuk taslak sunucuyu yormasın
    let n = if can_install { d.installments.clamp(1, 36) } else { 1 };
    let parsed = d.amount.filter(|v| *v > 0.0);
    let pos = |v: Option<f64>| v.filter(|x| *x > 0.0);
    let qty = if from_fx { pos(d.qty) } else { None };

    let tl_cents = if from_fx {
        qty.zip(pos(d.rate)).map(|(q, r)| tl_cents_of(q, r, from_cur))
    } else if to_fx {
        pos(d.to_qty).zip(pos(d.to_rate)).map(|(q, r)| tl_cents_of(q, r, to_cur))
    } else {
        None
    };
    let tl_value = if from_fx || to_fx { tl_cents.map(|c| c as f64 / 100.0) } else { d.amount };
    let to_qty_suggestion = match (tl_value, d.to_rate) {
        (Some(tl), Some(r)) if from_fx && to_fx && tl != 0.0 && r != 0.0 => {
            let p = 10f64.powi(qty_decimals(to_cur));
            Some(js_round((tl / r) * p) as f64 / p)
        }
        _ => None,
    };

    let is_advance = can_install && d.cash_advance.is_some();
    let first_due = match account {
        Some(a) if is_advance && !d.date.is_empty() => installment_postings(a, &d.date, 1.0, 1).into_iter().next().map(|p| p.due_date),
        _ => None,
    };
    let advance = match (&d.cash_advance, parsed) {
        (Some(ca), Some(p)) if is_advance => Some(advance(ca, p, n, &d.date, first_due.as_deref())),
        _ => None,
    };

    let postings = match (account, parsed) {
        (Some(a), Some(p)) if d.kind == "expense" && a.kind == "credit_card" && !d.date.is_empty() => {
            let first = first_tracked_closing(a);
            Some(
                installment_postings(a, &d.date, p, n)
                    .into_iter()
                    .map(|x| PostingRow { settled: x.closing_date < first, closing_date: x.closing_date, due_date: x.due_date, cents: x.cents })
                    .collect(),
            )
        }
        _ => None,
    };

    // Nakit eksiye düşecek mi: düzenlenen kayıt hariç, tarih sınırı olmadan bütün işlemler
    let cash_after = match (account, tl_value) {
        (Some(a), Some(tl)) if a.kind == "cash" && d.kind != "income" && tl > 0.0 && (!from_fx || qty.is_some()) => {
            let others: Vec<Transaction> = txs.iter().filter(|t| d.editing_id.as_deref() != Some(t.id.as_str())).cloned().collect();
            let all = "9999-12-31";
            let (before, spent, divisor) = match qty {
                Some(q) => {
                    let u = unit(from_cur);
                    (qty_at(a, u, &others, all), js_round(q * u.divisor() as f64), u.divisor())
                }
                None => (tl_balance(a, &others, all), js_round(tl * 100.0), 100),
            };
            Some(CashAfter { minor: before - spent, divisor })
        }
        _ => None,
    };

    let base = if d.date.is_empty() { today } else { d.date.as_str() };
    let base = base.get(..7).unwrap_or(base);
    let mut budget_month_options: Vec<String> = [-3, -2, -1, 0, 1].iter().map(|k| shift_month(base, *k)).collect();
    if let Some(m) = d.budget_month.as_deref().filter(|m| !m.is_empty() && !budget_month_options.iter().any(|o| o == m)) {
        budget_month_options.insert(0, m.to_string());
    }

    TransactionPreview {
        tl_cents,
        to_qty_suggestion,
        from_side: from_fx.then(|| default_side(from_cur, to_fx.then_some(to_cur))),
        to_side: to_fx.then(|| default_side(from_cur, Some(to_cur))),
        first_period_days: first_due.as_deref().map(|f| days_between(&d.date, f)),
        first_due,
        advance,
        per_installment: match parsed {
            Some(p) if n > 1 => Some(p / n as f64),
            _ => None,
        },
        postings,
        cash_after,
        budget_month_options,
        suggested_category_id: if wants_suggestion(d) { suggest_category(&d.description, &d.kind, &build_history(txs), categories, rules) } else { None },
    }
}
