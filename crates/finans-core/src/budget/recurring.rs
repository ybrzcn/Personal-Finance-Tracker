//! Düzenli kayıt (maaş, kira…) yardımcıları: arayüzdeki `recurring.ts` kurallarının aynısı.

use crate::accounts::cards::{add_days, clamped_date};
use crate::db::{MonthException, RecurringItem};
use crate::fx::time::{parse_ymd, weekday};

/// "YYYY-MM-DD" ya da "YYYY-MM" → "YYYY-MM"
pub fn month_of(date: &str) -> &str {
    date.get(..7).unwrap_or(date)
}

/// "YYYY-MM…" → (yıl, 0 tabanlı ay)
fn ym_parts(s: &str) -> (i64, i64) {
    (s.get(0..4).and_then(|x| x.parse().ok()).unwrap_or(1970), s.get(5..7).and_then(|x| x.parse::<i64>().ok()).unwrap_or(1) - 1)
}

/// Kayıt `date` tarihinde başlamış mı (başlangıç tarihinden önceki aylara uygulanmaz)
pub fn has_started(item: &RecurringItem, date: &str) -> bool {
    match item.start_date.as_deref() {
        Some(s) if !s.is_empty() => date >= s,
        _ => true,
    }
}

/// `date` tarihinde geçerli tutar: o tarihe kadar başlamış son değişiklik, yoksa ilk tutar
pub fn amount_at(item: &RecurringItem, date: &str) -> f64 {
    let mut amount = item.amount;
    for h in &item.history {
        if h.from.as_str() <= date {
            amount = h.amount;
        }
    }
    amount
}

pub fn exception_for<'a>(item: &'a RecurringItem, month: &str) -> Option<&'a MonthException> {
    item.exceptions.iter().find(|e| e.month == month)
}

/// YYYY-MM ayını `delta` ay kaydırır
pub fn shift_month(ym: &str, delta: i64) -> String {
    let (y, m0) = ym_parts(ym);
    let t = y * 12 + m0 + delta;
    format!("{:04}-{:02}", t.div_euclid(12), t.rem_euclid(12) + 1)
}

/// Hafta sonuna denk gelen tarihi kaydırır: "before" önceki Cuma, diğerleri ("after") sonraki Pazartesi
pub fn shift_weekend(date: &str, shift: &str) -> String {
    if shift.is_empty() || shift == "none" {
        return date.to_string();
    }
    let Some(days) = parse_ymd(date) else { return date.to_string() };
    // weekday: 5 Cumartesi, 6 Pazar
    match (weekday(days), shift == "before") {
        (5, true) => add_days(date, -1),
        (6, true) => add_days(date, -2),
        (5, false) => add_days(date, 2),
        (6, false) => add_days(date, 1),
        _ => date.to_string(),
    }
}

/// Düzenli kaydın `month` içindeki tarihi (ay sonu kısıtlamalı, hafta sonu kaydırmalı)
pub fn occurrence_in(item: &RecurringItem, month: &str) -> String {
    let (y, m0) = ym_parts(month);
    shift_weekend(&clamped_date(y, m0, item.day), &item.weekend_shift)
}

/// Tarihin ait olduğu plan ayı: hafta sonu kuralı tarihi komşu aya taşıdıysa asıl ay
pub fn scheduled_month(item: &RecurringItem, date: &str) -> String {
    let own = month_of(date);
    let shift = item.weekend_shift.as_str();
    if shift.is_empty() || shift == "none" || occurrence_in(item, own) == date {
        return own.to_string();
    }
    for m in [shift_month(own, 1), shift_month(own, -1)] {
        if occurrence_in(item, &m) == date {
            return m;
        }
    }
    own.to_string()
}

/// Yatışın karşılık geldiği tarih ("önceki ayın karşılığı" olan gelirde bir ay öncesi)
pub fn cover_date(item: &RecurringItem, paid_date: &str) -> String {
    let month = scheduled_month(item, paid_date);
    let base = if month == month_of(paid_date) {
        paid_date.to_string()
    } else {
        let (y, m0) = ym_parts(&month);
        clamped_date(y, m0, item.day)
    };
    if !(item.kind == "income" && item.covers_previous_month) {
        return base;
    }
    let (y, m0) = ym_parts(&base);
    let d = base.get(8..10).and_then(|x| x.parse().ok()).unwrap_or(1);
    clamped_date(y, m0 - 1, d)
}

/// `date` tarihindeki yatış/ödeme tutarı: karşılık geldiği aya özel istisna varsa o, yoksa geçerli tutar
pub fn amount_for_occurrence(item: &RecurringItem, date: &str) -> f64 {
    let cover = cover_date(item, date);
    match exception_for(item, month_of(&cover)) {
        Some(e) => e.amount,
        None => amount_at(item, &cover),
    }
}
