//! Düzenli kayıt formu önizlemesi (TS `RecurringForm`): bugünkü tutar, değişiklik tarihi, hafta sonu kaymaları, kayıtta tutar geçmişi

use serde::{Deserialize, Serialize};

use super::tl_cents_of;
use crate::accounts::cards::clamped_date;
use crate::budget::recurring::{amount_at, occurrence_in, shift_month, shift_weekend};
use crate::db::{AmountChange, RecurringItem};

/// Düzenlenen kayıt: saklı tutar, gün ve kaydırma; `history` formdaki hâli
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringBase {
    pub amount: f64,
    pub day: i64,
    #[serde(default)]
    pub weekend_shift: String,
    #[serde(default)]
    pub history: Vec<AmountChange>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringDraft {
    #[serde(default)]
    pub item: Option<RecurringBase>,
    /// Formdaki gün (`parseInt`; geçersizse null)
    #[serde(default)]
    pub day: Option<i64>,
    #[serde(default)]
    pub weekend_shift: String,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub qty: Option<f64>,
    /// Hesap biriminin güncel alış kuru
    #[serde(default)]
    pub buy_rate: Option<f64>,
    #[serde(default)]
    pub amount: Option<f64>,
    /// "from": `change_from` tarihinden itibaren; "all": tüm aylar
    #[serde(default)]
    pub change_mode: String,
    #[serde(default)]
    pub change_from: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeekendMove {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringAmounts {
    pub amount: f64,
    pub history: Vec<AmountChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringPreview {
    /// Bugün geçerli tutar (düzenlenen kayıtta)
    pub current_amount: Option<f64>,
    /// Tutar değişikliğinin varsayılan başlangıcı: bu ayın tarihi geçtiyse sonraki ayınki
    pub change_from_default: Option<String>,
    /// Önümüzdeki 6 ayda hafta sonu nedeniyle kayan tarihler (gün geçersizse null)
    pub weekend_moves: Option<Vec<WeekendMove>>,
    /// Miktarın güncel alış kuruyla TL karşılığı
    pub qty_amount: Option<f64>,
    pub amount_changed: bool,
    /// Kayıtta yazılacak tutar ve geçmiş
    pub amounts: Option<RecurringAmounts>,
}

fn as_item(b: &RecurringBase) -> RecurringItem {
    RecurringItem {
        id: String::new(),
        name: String::new(),
        kind: String::new(),
        amount: b.amount,
        day: b.day,
        account_id: None,
        category_id: None,
        active: true,
        sort_order: 0,
        history: b.history.clone(),
        exceptions: Vec::new(),
        covers_previous_month: false,
        start_date: None,
        weekend_shift: b.weekend_shift.clone(),
        orig_amount: None,
    }
}

/// TS `withAmountFrom`: `from` ve sonrasında başlayan eski değişiklikler kalkar; `from` yoksa geçmiş tümüyle yeni tutar
fn with_amount_from(item: &RecurringItem, from: Option<&str>, amount: f64) -> RecurringAmounts {
    let Some(from) = from.filter(|f| !f.is_empty()) else {
        return RecurringAmounts { amount, history: Vec::new() };
    };
    let mut history: Vec<AmountChange> = item.history.iter().filter(|h| h.from.as_str() < from).cloned().collect();
    history.push(AmountChange { from: from.to_string(), amount });
    RecurringAmounts { amount: item.amount, history }
}

pub fn recurring_preview(d: &RecurringDraft, today: &str) -> RecurringPreview {
    let month = today.get(..7).unwrap_or(today);
    let item = d.item.as_ref().map(as_item);
    let current_amount = item.as_ref().map(|i| amount_at(i, today));
    let change_from_default = item.as_ref().map(|i| {
        let this = occurrence_in(i, month);
        if this.as_str() >= today { this } else { occurrence_in(i, &shift_month(month, 1)) }
    });
    let weekend_moves = d.day.filter(|x| (1..=31).contains(x)).map(|day| {
        (0..6)
            .filter_map(|k| {
                let m = shift_month(month, k);
                let (y, m0) = (m[..4].parse::<i64>().unwrap_or(1970), m[5..7].parse::<i64>().unwrap_or(1) - 1);
                let base = clamped_date(y, m0, day);
                let to = shift_weekend(&base, &d.weekend_shift);
                (to != base).then_some(WeekendMove { from: base, to })
            })
            .collect()
    });
    let qty_amount = match (d.qty, d.buy_rate) {
        (Some(q), Some(r)) if q > 0.0 && r != 0.0 => Some(tl_cents_of(q, r, d.currency.as_deref().unwrap_or("TRY")) as f64 / 100.0),
        _ => None,
    };
    let value = d.amount.filter(|v| *v > 0.0);
    let amount_changed = match (value, current_amount) {
        (Some(v), Some(c)) => (v - c).abs() >= 0.005,
        _ => false,
    };
    let amounts = value.and_then(|v| match &item {
        None => Some(RecurringAmounts { amount: v, history: Vec::new() }),
        Some(i) if !amount_changed => Some(RecurringAmounts { amount: i.amount, history: i.history.clone() }),
        Some(i) if d.change_mode == "all" => Some(with_amount_from(i, None, v)),
        Some(i) => d.change_from.as_deref().filter(|f| !f.is_empty()).map(|f| with_amount_from(i, Some(f), v)),
    });
    RecurringPreview { current_amount, change_from_default, weekend_moves, qty_amount, amount_changed, amounts }
}
