//! Fiş / fatura PDF'inden işleme öneri: toplam tutar ve tarih. Yalnız metni olan PDF (e-fatura, e-arşiv);
//! fotoğraf ve taranmış PDF okunmaz.

use serde::{Deserialize, Serialize};

use crate::fx::funds::tr_lower;
use crate::fx::time::parse_ymd;
use crate::CoreResult;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptHint {
    /// Ödenecek toplam (TL)
    pub amount: Option<f64>,
    /// YYYY-MM-DD
    pub date: Option<String>,
}

pub fn parse_pdf(bytes: &[u8]) -> CoreResult<ReceiptHint> {
    Ok(hint(&crate::statement::read_pdf(bytes)?))
}

/// "1.234,56" / "1234,56" / "1,234.56" / "1234.56" (TL, ₺, * ekleriyle) → sayı
fn amount_of(token: &str) -> Option<f64> {
    let t: String = token.trim_matches(|c: char| !c.is_ascii_digit() && c != ',' && c != '.').to_string();
    if t.is_empty() || !t.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let (comma, dot) = (t.rfind(','), t.rfind('.'));
    let normal = match (comma, dot) {
        (Some(c), Some(d)) if c > d => t.replace('.', "").replace(',', "."),
        (Some(_), Some(_)) => t.replace(',', ""),
        // Tek virgül ve ardında üç hane: binlik ayraç (1,250); değilse ondalık (12,50)
        (Some(c), None) if t.len() - c - 1 == 3 => t.replace(',', ""),
        (Some(_), None) => t.replace(',', "."),
        // Tek nokta ve ardında üç hane: binlik ayraç (1.250); değilse ondalık
        (None, Some(d)) if t.len() - d - 1 == 3 => t.replace('.', ""),
        _ => t,
    };
    normal.parse::<f64>().ok().filter(|v| v.is_finite() && *v > 0.0 && *v < 1e10).map(|v| (v * 100.0).round() / 100.0)
}

/// Tutar biçimi: iki ondalıklı ("45,90", "1.234,56") ya da satırda para işareti (TL, ₺) varsa tam sayı/binlik
fn money_like(token: &str, currency: bool) -> bool {
    let t = token.trim_matches(|c: char| !c.is_ascii_digit() && c != ',' && c != '.');
    let two_decimals = t.len() > 3 && matches!(t.as_bytes()[t.len() - 3], b',' | b'.') && t[t.len() - 2..].bytes().all(|b| b.is_ascii_digit());
    let digits = t.bytes().filter(u8::is_ascii_digit).count();
    // Vergi/telefon numarası gibi uzun sayılar tutar değil
    digits <= 11 && (two_decimals || currency)
}

/// Satırdaki son tutar
fn last_amount(line: &str) -> Option<f64> {
    let currency = line.contains("tl") || line.contains('₺');
    line.split_whitespace().rev().filter(|t| money_like(t, currency)).find_map(amount_of)
}

fn date_of(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    for i in 0..chars.len().saturating_sub(9) {
        let b = &chars[i..i + 10];
        let digits = |r: std::ops::Range<usize>| b[r].iter().all(|c| c.is_ascii_digit());
        let s = |r: std::ops::Range<usize>| b[r].iter().collect::<String>();
        let iso = if digits(0..2) && matches!(b[2], '.' | '/' | '-') && digits(3..5) && b[5] == b[2] && digits(6..10) {
            format!("{}-{}-{}", s(6..10), s(3..5), s(0..2))
        } else if digits(0..4) && b[4] == '-' && digits(5..7) && b[7] == '-' && digits(8..10) {
            s(0..10)
        } else {
            continue;
        };
        // Öncesi ve sonrası rakam olmamalı (uzun numaraların parçası değil)
        let before = i.checked_sub(1).is_some_and(|k| chars[k].is_ascii_digit());
        let after = chars.get(i + 10).is_some_and(|c| c.is_ascii_digit());
        if !before && !after && parse_ymd(&iso).is_some() && iso.as_str() >= "2000-01-01" {
            return Some(iso);
        }
    }
    None
}

/// Toplam olmayan satırlar: KDV (dahil değilse), ara toplam, iskonto, miktar/adet/ağırlık
fn excluded(l: &str) -> bool {
    let kdv = l.contains("kdv") && !l.contains("dahil") && !l.contains("dahıl");
    kdv || ["ara toplam", "iskonto", "ıskonto", "miktar", "adet", " kg"].iter().any(|k| l.contains(k))
}

/// Tutar: "genel toplam", "ödenecek", "toplam tutar", sonra "toplam" geçen satırlar (KDV ve ara toplam hariç);
/// aynı öncelikte birden çoksa en büyüğü. Satırda tutar yoksa sonraki satıra bakılır. Tutar iki ondalıklı ya da para
/// işaretli olmalı (vergi/telefon numarası, miktar sayılmaz). Tarih: ilk geçerli tarih.
pub fn hint(text: &str) -> ReceiptHint {
    let lines: Vec<String> = text.lines().map(|l| tr_lower(l.trim())).collect();
    // Türkçe karaktersiz yazım da (e-faturalarda "ODENECEK") aynı öncelikte
    let keys: [&[&str]; 4] = [&["genel toplam"], &["ödenecek", "odenecek"], &["toplam tutar"], &["toplam"]];
    let mut amount = None;
    for group in keys {
        let found = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| group.iter().any(|k| l.contains(k)) && !excluded(l))
            .collect::<Vec<_>>();
        // Önce satırın kendisindeki tutar (en büyüğü); hiçbirinde yoksa sonraki satırdaki
        let same = found.iter().filter_map(|(_, l)| last_amount(l)).fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v))));
        let found = same.or_else(|| found.iter().find_map(|(i, _)| lines.get(i + 1).and_then(|n| last_amount(n))));
        if found.is_some() {
            amount = found;
            break;
        }
    }
    ReceiptHint { amount, date: date_of(text) }
}
