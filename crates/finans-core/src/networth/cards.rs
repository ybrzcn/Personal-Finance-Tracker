//! Kredi kartı borcu: arayüzdeki `cards.ts` (`cardMovements`) kurallarının aynısı.
//! Taksitler işlem tarihinde borca girer (kalan taksitlerin tamamı); takip başlangıcının ilk kesiminden önceki
//! ekstrelere düşen taksitler ve takip öncesi alacaklar sayılmaz.

use crate::db::{Account, Transaction};
use crate::fx::time::{days_from_civil, ymd};

/// JavaScript `Math.round` (yarım yukarı, +∞ yönüne)
pub fn js_round(v: f64) -> i64 {
    // `(v + 0.5).floor()` 0.49999999999999994'ü 1'e yuvarlar; kesir ayrı karşılaştırılır
    let f = v.floor();
    (if v - f >= 0.5 { f + 1.0 } else { f }) as i64
}

/// TS `toCents`
pub fn js_cents(v: f64) -> i64 {
    js_round(v * 100.0)
}

fn days_in_month(y: i64, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    (days_from_civil(ny, nm, 1) - days_from_civil(y, m, 1)) as u32
}

/// `month0` (0 tabanlı, taşabilir) ayının `day`. günü; ayda o gün yoksa ayın son günü.
pub fn clamped_date(year: i64, month0: i64, day: i64) -> String {
    let y = year + month0.div_euclid(12);
    let m = (month0.rem_euclid(12) + 1) as u32;
    let d = (day.max(1) as u32).min(days_in_month(y, m));
    ymd(days_from_civil(y, m, d))
}

/// "YYYY-MM-DD" → (yıl, 0 tabanlı ay)
fn ym(iso: &str) -> (i64, i64) {
    (iso.get(0..4).and_then(|s| s.parse().ok()).unwrap_or(1970), iso.get(5..7).and_then(|s| s.parse::<i64>().ok()).unwrap_or(1) - 1)
}

/// `iso` tarihini içeren dönemin kesim tarihi (iso ≤ kesim)
pub fn closing_on_or_after(iso: &str, sd: i64) -> String {
    let (y, m) = ym(iso);
    let c = clamped_date(y, m, sd);
    if c.as_str() >= iso {
        c
    } else {
        clamped_date(y, m + 1, sd)
    }
}

pub fn shift_closing(closing: &str, months: i64, sd: i64) -> String {
    let (y, m) = ym(closing);
    clamped_date(y, m + months, sd)
}

/// Eşit taksitler (kuruş); artan kuruşlar ilk taksite
pub fn split_installments(total: i64, n: i64) -> Vec<i64> {
    let n = n.max(1);
    let base = total.div_euclid(n);
    let mut parts = vec![base; n as usize];
    parts[0] += total - base * n;
    parts
}

/// Kart hareketleri: (borca giriş tarihi, kuruş); > 0 borçlandırma, < 0 alacak
pub fn card_movements(a: &Account, txs: &[Transaction]) -> Vec<(String, i64)> {
    let sd = a.statement_day.unwrap_or(1);
    let first = closing_on_or_after(&a.opening_date, sd);
    let mut out = Vec::new();
    let opening = js_cents(a.opening_balance);
    if opening != 0 {
        out.push((a.opening_date.clone(), opening));
    }
    for t in txs {
        let c = js_cents(t.amount);
        let mine = t.account_id == a.id;
        let closing0 = closing_on_or_after(&t.date, sd);
        match t.kind.as_str() {
            "expense" if mine => {
                for (k, part) in split_installments(c, t.installments).into_iter().enumerate() {
                    if shift_closing(&closing0, k as i64, sd) >= first {
                        out.push((t.date.clone(), part));
                    }
                }
            }
            "income" if mine => {
                if t.date >= a.opening_date {
                    out.push((t.date.clone(), -c));
                }
            }
            "transfer" => {
                if t.to_account_id.as_deref() == Some(a.id.as_str()) && t.date >= a.opening_date {
                    out.push((t.date.clone(), -c));
                }
                if mine && closing0 >= first {
                    out.push((t.date.clone(), c));
                }
            }
            _ => {}
        }
    }
    out
}

/// `d` tarihine kadarki (dahil) toplam borç; en az 0
pub fn debt_at(m: &[(String, i64)], d: &str) -> i64 {
    m.iter().filter(|(x, _)| x.as_str() <= d).map(|(_, c)| c).sum::<i64>().max(0)
}
