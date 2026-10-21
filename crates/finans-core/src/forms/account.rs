//! Hesap formu önizlemesi (TS `AccountForm`): kart kesim/son ödeme tarihleri, yeni kartın açılış tarihi, kredi taksit önerisi

use serde::{Deserialize, Serialize};

use crate::accounts::cards::{add_days, closing_on_or_after, closing_on_or_before, due_date_for, js_cents, shift_closing};
use crate::accounts::loans::{annuity_payment_cents, effective_monthly_rate};

/// Formun taslağı: kart günleri yalnız kartta, kredi alanları yalnız kredide (ayrıştırılmış)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDraft {
    /// Düzenlenen hesap (işlem kaydı var mı)
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub statement_day: Option<i64>,
    #[serde(default)]
    pub due_day: Option<i64>,
    #[serde(default)]
    pub loan: Option<LoanDraft>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoanDraft {
    pub principal: f64,
    pub term: i64,
    pub rate_pct: f64,
    #[serde(default)]
    pub tax_pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastStatement {
    pub last: String,
    pub due: String,
    pub prev: String,
    /// Son ödeme tarihi geçtiyse ekstre ödenmiş varsayılır
    pub default_paid: bool,
    /// Yeni kartın takip başlangıcı: ödendiyse son kesimden, değilse önceki kesimden sonraki gün
    pub opening_if_paid: String,
    pub opening_if_unpaid: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPreview {
    pub next_closing: Option<String>,
    pub next_due: Option<String>,
    pub last_statement: Option<LastStatement>,
    pub suggested_installment_cents: Option<i64>,
    /// Hesabın işlem kaydı var (silinemez, türü değişmez)
    pub used: bool,
}

/// `usage`: düzenlenen hesabın işlem sayısı (`account_usage`)
pub fn account_preview(d: &AccountDraft, usage: i64, today: &str) -> AccountPreview {
    let day = |v: Option<i64>| v.filter(|x| (1..=31).contains(x));
    let (mut next_closing, mut next_due, mut last_statement) = (None, None, None);
    if let (Some(sd), Some(dd)) = (day(d.statement_day), day(d.due_day)) {
        let c = closing_on_or_after(today, sd);
        next_due = Some(due_date_for(&c, dd));
        next_closing = Some(c);
        let last = closing_on_or_before(today, sd);
        let due = due_date_for(&last, dd);
        let prev = shift_closing(&last, -1, sd);
        last_statement = Some(LastStatement {
            default_paid: due.as_str() < today,
            opening_if_paid: add_days(&last, 1),
            opening_if_unpaid: add_days(&prev, 1),
            last,
            due,
            prev,
        });
    }
    let suggested_installment_cents = d
        .loan
        .as_ref()
        .filter(|l| l.principal > 0.0 && l.term >= 1)
        .map(|l| annuity_payment_cents(js_cents(l.principal), effective_monthly_rate(Some(l.rate_pct), Some(l.tax_pct.unwrap_or(0.0))), l.term));
    let used = d.account_id.as_deref().is_some_and(|id| !id.is_empty()) && usage > 0;
    AccountPreview { next_closing, next_due, last_statement, suggested_installment_cents, used }
}
