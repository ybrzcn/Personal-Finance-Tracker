//! Tarih, tutar ve CSV okuma (TS `csv.ts parseDate/parseCsv/detectDelimiter`, `format.ts parseDecimal`)

use std::sync::LazyLock;

use fancy_regex::Regex;

use super::{js_re, js_trim};
use crate::accounts::cards::days_in_month;
use crate::analysis::norm;

static ISO: LazyLock<Regex> = LazyLock::new(|| js_re(r"^(\d{4})-(\d{1,2})-(\d{1,2})"));
static DMY: LazyLock<Regex> = LazyLock::new(|| js_re(r"^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)"));
static LONG: LazyLock<Regex> = LazyLock::new(|| js_re(r"(?i)^(\d{1,2})\s+([a-zçğıöşü]+)\.?\s+(\d{4})"));
const TR_MONTHS: [&str; 12] = ["oca", "sub", "mar", "nis", "may", "haz", "tem", "agu", "eyl", "eki", "kas", "ara"];

fn num(s: &str) -> i64 {
    s.parse().unwrap_or(0)
}

/// YYYY-AA-GG, GG.AA.YYYY, GG/AA/YY (saat ekli olabilir) ve "05 Eki 2026" / "5 Ekim 2026" biçimleri
pub fn parse_date(s: &str) -> Option<String> {
    let v = js_trim(s);
    let make = |mut y: i64, m: i64, d: i64| -> Option<String> {
        if y < 100 {
            y += 2000;
        }
        if !(1..=12).contains(&m) || !(1..=31).contains(&d) || d > days_in_month(y, m as u32) as i64 {
            return None;
        }
        Some(format!("{y}-{m:02}-{d:02}"))
    };
    if let Ok(Some(c)) = ISO.captures(v) {
        return make(num(&c[1]), num(&c[2]), num(&c[3]));
    }
    if let Ok(Some(c)) = DMY.captures(v) {
        return make(num(&c[3]), num(&c[2]), num(&c[1]));
    }
    if let Ok(Some(c)) = LONG.captures(v) {
        let n: String = norm(&c[2]).encode_utf16().take(3).collect::<Vec<u16>>().iter().map(|u| char::from_u32(*u as u32).unwrap_or('\u{fffd}')).collect();
        if let Some(i) = TR_MONTHS.iter().position(|m| *m == n) {
            return make(num(&c[3]), i as i64 + 1, num(&c[1]));
        }
    }
    None
}

static STRIP: LazyLock<Regex> = LazyLock::new(|| js_re(r"(?i)[\s₺$€£]|TL|TRY"));
static GROUP_COMMA: LazyLock<Regex> = LazyLock::new(|| js_re(r"^\d{1,3}(,\d{3})+$"));
static GROUP_DOT: LazyLock<Regex> = LazyLock::new(|| js_re(r"^[1-9]\d{0,2}(\.\d{3})+$"));
static PLAIN: LazyLock<Regex> = LazyLock::new(|| js_re(r"^\d+(\.\d+)?$"));

/// TS `parseDecimal(input, decimals, strict)`
pub fn parse_decimal(input: &str, decimals: i32, strict: bool) -> Option<f64> {
    let mut s = STRIP.replace_all(input, "").into_owned();
    if s.is_empty() {
        return None;
    }
    let negative = s.starts_with('-');
    if negative {
        s.remove(0);
    }
    let (comma, dot) = (s.rfind(','), s.rfind('.'));
    match (comma, dot) {
        (Some(c), Some(d)) => {
            s = if c > d { s.replace('.', "").replacen(',', ".", 1) } else { s.replace(',', "") };
        }
        (Some(_), None) => {
            s = if GROUP_COMMA.is_match(&s).unwrap_or(false) && s.split(',').count() > 2 { s.replace(',', "") } else { s.replacen(',', ".", 1) };
        }
        (None, Some(_)) if GROUP_DOT.is_match(&s).unwrap_or(false) => s = s.replace('.', ""),
        _ => {}
    }
    if !PLAIN.is_match(&s).unwrap_or(false) {
        return None;
    }
    if strict && s.split('.').nth(1).map_or(0, |f| f.len()) as i32 > decimals {
        return None;
    }
    let n: f64 = s.parse().ok()?;
    if !n.is_finite() {
        return None;
    }
    let f = 10f64.powi(decimals);
    // JS `Math.round` kayan noktada: i64'e sığmayan büyük tutarlar da kırpılmaz
    let x = if negative { -n } else { n } * f;
    let r = x.floor();
    Some(if x - r >= 0.5 { r + 1.0 } else { r } / f)
}

/// TS `parseAmount`
pub fn parse_amount(input: &str) -> Option<f64> {
    parse_decimal(input, 2, false)
}

/// RFC 4180 uyumlu küçük CSV ayrıştırıcı (tırnak, kaçış ve satır içi yeni satır destekli)
pub fn parse_csv(text: &str, delimiter: char) -> Vec<Vec<String>> {
    let chars: Vec<char> = text.chars().collect();
    let (mut rows, mut row, mut cell, mut quoted) = (Vec::new(), Vec::new(), String::new(), false);
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if quoted {
            if ch == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    cell.push('"');
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                cell.push(ch);
            }
        } else if ch == '"' {
            quoted = true;
        } else if ch == delimiter {
            row.push(std::mem::take(&mut cell));
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            row.push(std::mem::take(&mut cell));
            rows.push(std::mem::take(&mut row));
        } else {
            cell.push(ch);
        }
        i += 1;
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows.into_iter().filter(|r: &Vec<String>| r.iter().any(|c| !js_trim(c).is_empty())).collect()
}

/// En çok sütun üreten ayırıcı (eşitlikte `;`, `,`, sekme sırası)
pub fn detect_delimiter(line: &str) -> char {
    let mut best = (';', 0);
    for d in [';', ',', '\t'] {
        let n = line.split(d).count();
        if n > best.1 {
            best = (d, n);
        }
    }
    best.0
}
