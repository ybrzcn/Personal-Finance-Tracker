//! Ekstre dosyasından satır/sütun tablosu (TS `statementToTable`, `readTable`, `pdfTextToTable`)

use std::sync::LazyLock;

use fancy_regex::Regex;

use super::{detect_delimiter, js_re, js_trim, parse_csv, parse_date};
use crate::statement::StatementFile;

/// Boşlukla ayrılmış tutar: 1.250,75 · 1250,75 · 1,250.75 · sonda/başta işaret, isteğe bağlı TL
static AMOUNT: LazyLock<Regex> =
    LazyLock::new(|| js_re(r"(?:^|\s)([-+]?(?:\d{1,3}(?:[.,]\d{3})+|\d+)[.,]\d{2})(?!\d)(?:\s?(?:TL|TRY))?(\s?[-+](?=\s|$))?"));
/// Satır başındaki tarih (tarih ile açıklama arasında boşluk olmayabilir)
static DATE_START: LazyLock<Regex> = LazyLock::new(|| {
    js_re(r"^(\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-zÇĞİÖŞÜçğıöşü]+\.?\s+\d{4})\s*([^\n\r\x{2028}\x{2029}]*)$")
});
/// İşyeri adına yapışık şehir ("ÖRNEKCADDESİİSTANBUL")
static GLUED_CITY: LazyLock<Regex> =
    LazyLock::new(|| js_re(r"^([^\n\r\x{2028}\x{2029}]*\S)(İSTANBUL|ISTANBUL|ANKARA|İZMİR|IZMIR|BURSA|ANTALYA|KOCAELİ|KOCAELI)$"));
/// İşlemin altındaki taksit açıklaması ("… işlemin 6 / 6 taksidi")
static INSTALLMENT_LINE: LazyLock<Regex> = LazyLock::new(|| js_re(r"(?i)(\d{1,2})\s*/\s*(\d{1,2})\s*taksid"));
static MULTI_SPACE: LazyLock<Regex> = LazyLock::new(|| js_re(r"\s{2,}"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| js_re(r"\s+"));
static CURRENCY: LazyLock<Regex> = LazyLock::new(|| js_re(r"\s?(TL|TRY)"));

/// TS `readTable`: ayırıcı ilk 30 satırın en uzununa göre seçilir
fn read_table(text: &str) -> Vec<Vec<String>> {
    let clean = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = split_lines(clean).into_iter().filter(|l| !js_trim(l).is_empty()).collect();
    let mut sample = "";
    let mut best = 0;
    for l in lines.iter().take(30) {
        let n = l.encode_utf16().count();
        if n > best || sample.is_empty() && best == 0 {
            if n > best {
                best = n;
            }
            sample = l;
        }
    }
    parse_csv(clean, detect_delimiter(sample)).into_iter().map(|r| r.iter().map(|c| js_trim(c).to_string()).collect()).collect()
}

/// JS `split(/\r?\n/)`
fn split_lines(s: &str) -> Vec<&str> {
    s.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

/// TS `normalizeAmountToken`: sondaki işaret başa alınır, TL eki atılır
fn normalize_amount_token(token: &str) -> String {
    let t = CURRENCY.replace(token, "");
    let t = js_trim(&t);
    match t.chars().last() {
        Some(c @ ('-' | '+')) => format!("{c}{}", js_trim(&t[..t.len() - 1])),
        _ => t.to_string(),
    }
}

/// TS `merchantName` (ekstre): çoklu boşlukla ayrılan ilk alan, yapışık şehir atılır
fn merchant_name(raw: &str) -> String {
    let first = MULTI_SPACE.split(raw).next().and_then(|r| r.ok()).unwrap_or("");
    let first = js_trim(first);
    let base = match GLUED_CITY.captures(first) {
        Ok(Some(c)) => c.get(1).map_or(first, |m| m.as_str()),
        _ => first,
    };
    let name = js_trim(&SPACES.replace_all(base, " ")).to_string();
    if name.is_empty() {
        js_trim(&SPACES.replace_all(raw, " ")).to_string()
    } else {
        name
    }
}

/// TS `pdfTextToTable`: tarihle başlayan her satır bir işlem; sondan ikinci tutar işlem tutarıdır
fn pdf_text_to_table(text: &str) -> Vec<Vec<String>> {
    let mut rows = vec![vec!["Tarih".to_string(), "Açıklama".to_string(), "Tutar".to_string(), "Taksit".to_string()]];
    let lines = split_lines(text);
    for (i, raw) in lines.iter().enumerate() {
        let line = raw.replace('\t', " ");
        let line = js_trim(&line);
        let Ok(Some(m)) = DATE_START.captures(line) else { continue };
        if parse_date(&m[1]).is_none() {
            continue;
        }
        let mut rest = m.get(2).map_or("", |x| x.as_str());
        if let Ok(Some(second)) = DATE_START.captures(rest) {
            if parse_date(&second[1]).is_some() {
                rest = second.get(2).map_or("", |x| x.as_str());
            }
        }
        let amounts: Vec<fancy_regex::Captures> = AMOUNT.captures_iter(rest).filter_map(Result::ok).collect();
        if amounts.is_empty() {
            continue;
        }
        let pick = if amounts.len() >= 2 { &amounts[amounts.len() - 2] } else { &amounts[0] };
        let start = amounts[0].get(0).map_or(0, |x| x.start());
        let description = merchant_name(&rest[..start]);
        let next = js_trim(lines.get(i + 1).copied().unwrap_or(""));
        let inst = if DATE_START.is_match(next).unwrap_or(false) { None } else { INSTALLMENT_LINE.captures(next).ok().flatten() };
        let token = format!("{}{}", &pick[1], pick.get(2).map_or("", |x| js_trim(x.as_str())));
        rows.push(vec![
            SPACES.replace_all(&m[1], " ").into_owned(),
            description,
            normalize_amount_token(&token),
            inst.map_or(String::new(), |c| format!("{}/{}", &c[1], &c[2])),
        ]);
    }
    rows
}

/// Dosya içeriğini satır/sütun tablosuna çevirir
pub fn statement_table(file: &StatementFile) -> Vec<Vec<String>> {
    match file {
        StatementFile::Table { rows } => rows.iter().map(|r| r.iter().map(|c| js_trim(c).to_string()).collect()).collect(),
        StatementFile::Pdf { text } => pdf_text_to_table(text),
        StatementFile::Text { text } => read_table(text),
    }
}
