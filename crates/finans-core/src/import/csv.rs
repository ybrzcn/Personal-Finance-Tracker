//! İşlemlerin CSV'si: dışa aktarma ve kendi biçimimizi okuma (TS `csv.ts`)

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{detect_delimiter, js_trim, parse_amount, parse_csv, parse_date, parse_decimal};
use crate::analysis::norm;
use crate::db::{Account, Category, Transaction};
use crate::forms::qty_decimals;
use crate::overview::breakdown::js_space;
use crate::CoreResult;

// Türkçe Excel ondalık ayırıcı olarak virgül kullandığı için alan ayırıcı ";"
const DELIMITER: &str = ";";

const HEADER: [&str; 14] = [
    "Tarih", "Tür", "Hesap", "Hedef Hesap", "Kategori", "Tutar", "Para birimi", "Orijinal tutar", "Kur", "Taksit", "Açıklama", "Hedef para birimi", "Hedef miktar", "Hedef kur",
];

/// TS `TYPE_LABEL` (bilinmeyen tür JS'te `undefined`, birleştirmede boş hücre)
fn type_label(kind: &str) -> &'static str {
    match kind {
        "income" => "Gelir",
        "expense" => "Gider",
        "transfer" => "Transfer",
        _ => "",
    }
}

/// JS `Number.prototype.toString()` (ondalık gösterim; 1e21 ve üstü, 1e-7 ve altı üstel)
pub(crate) fn js_number_string(v: f64) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if v == 0.0 {
        return "0".into();
    }
    let sign = if v < 0.0 { "-" } else { "" };
    // Rust `{:e}` en kısa gidiş-dönüş basamaklarını verir (JS ile aynı)
    let e = format!("{:e}", v.abs());
    let (mant, exp) = e.split_once('e').unwrap();
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().unwrap() + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = if e < 0 { format!("-{}", -e) } else { format!("+{e}") };
        if k == 1 { format!("{digits}e{es}") } else { format!("{}.{}e{es}", &digits[..1], &digits[1..]) }
    };
    format!("{sign}{body}")
}

/// JS `Number.prototype.toFixed(digits)`: ikili değerin tam ondalık açılımında yarımda yukarı (Rust `{:.N}` yarımda çifte yuvarlar)
pub(crate) fn js_to_fixed(v: f64, digits: usize) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.abs() >= 1e21 {
        return js_number_string(v);
    }
    let sign = if v < 0.0 { "-" } else { "" };
    // f64'ün ondalık açılımı en çok 1074 kesir basamağıdır: bu kesinlikte biçim tamdır
    let exact = format!("{:.1080}", v.abs());
    let (int, frac) = exact.split_once('.').unwrap();
    let mut d: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).map(|b| b - b'0').collect();
    if frac.as_bytes()[digits] >= b'5' {
        let mut i = d.len();
        loop {
            if i == 0 {
                d.insert(0, 1);
                break;
            }
            i -= 1;
            if d[i] == 9 {
                d[i] = 0;
            } else {
                d[i] += 1;
                break;
            }
        }
    }
    let s: String = d.iter().map(|b| (b + b'0') as char).collect();
    let (i, f) = s.split_at(s.len() - digits);
    if digits == 0 { format!("{sign}{i}") } else { format!("{sign}{i}.{f}") }
}

/// Excel'de formül olarak çalışmasın: = + - @ ile başlayan metin hücrelerine ' öneki (CSV/formül enjeksiyonu)
fn guard_formula(v: &str) -> String {
    if v.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{v}") } else { v.to_string() }
}

/// İçe aktarırken kendi eklediğimiz koruma önekini geri alır
fn unguard_formula(v: &str) -> &str {
    match v.strip_prefix('\'') {
        Some(rest) if rest.starts_with(['=', '+', '-', '@', '\t', '\r']) => rest,
        _ => v,
    }
}

fn escape_cell(v: String) -> String {
    if v.contains(['"', ';', '\n', '\r', ',']) { format!("\"{}\"", v.replace('"', "\"\"")) } else { v }
}

/// Tutar hücresi: `toFixed` ve ilk noktanın virgüle çevrilmesi
fn fixed(v: f64, digits: i32) -> String {
    js_to_fixed(v, digits as usize).replacen('.', ",", 1)
}

/// İşlemlerin CSV metni (BOM, `;` ayırıcı, `\r\n`); işlemler verildiği sırayla
pub fn transactions_to_csv(txs: &[Transaction], categories: &[Category], accounts: &[Account]) -> String {
    let account_by_id: HashMap<&str, &Account> = accounts.iter().map(|a| (a.id.as_str(), a)).collect();
    let category_by_id: HashMap<&str, &Category> = categories.iter().map(|c| (c.id.as_str(), c)).collect();
    let name = |id: Option<&str>| id.and_then(|id| account_by_id.get(id)).map_or("", |a| a.name.as_str());
    let mut out = String::from("\u{feff}");
    out.push_str(&HEADER.join(DELIMITER));
    out.push_str("\r\n");
    for t in txs {
        let from = account_by_id.get(t.account_id.as_str()).map_or("TRY", |a| a.currency.as_str());
        let to = t.to_account_id.as_deref().and_then(|id| account_by_id.get(id)).map(|a| a.currency.as_str()).filter(|c| !c.is_empty()).unwrap_or("TRY");
        // Dövizli işlemin birimi, miktarı ve kuru: kaynak TL dışıysa kaynak, değilse hedef taraf; TL işlemde boş
        let (cur, qty, rate) = if t.orig_amount.is_some() {
            (from, t.orig_amount, t.fx_rate)
        } else if t.to_orig_amount.is_some() {
            (to, t.to_orig_amount, t.to_fx_rate)
        } else {
            ("", None, None)
        };
        let qty_digits = if cur.is_empty() { 2 } else { qty_decimals(cur) };
        // İki tarafı da döviz/altın olan transferin hedef tarafı
        let target = match (t.orig_amount, t.to_orig_amount) {
            (Some(_), Some(q)) => [to.to_string(), fixed(q, qty_decimals(to)), t.to_fx_rate.map_or(String::new(), |r| fixed(r, 6))],
            _ => Default::default(),
        };
        let category = t.category_id.as_deref().and_then(|id| category_by_id.get(id)).map_or("", |c| c.name.as_str());
        let cells = [
            t.date.clone(),
            type_label(&t.kind).to_string(),
            guard_formula(name(Some(&t.account_id))),
            guard_formula(name(t.to_account_id.as_deref())),
            guard_formula(category),
            fixed(t.amount, 2),
            cur.to_string(),
            qty.map_or(String::new(), |q| fixed(q, qty_digits)),
            rate.map_or(String::new(), |r| fixed(r, 6)),
            t.installments.to_string(),
            guard_formula(&t.description),
        ]
        .into_iter()
        .chain(target);
        out.push_str(&cells.map(escape_cell).collect::<Vec<_>>().join(DELIMITER));
        out.push_str("\r\n");
    }
    out
}

/// CSV'den okunan işlem satırı (TS `ParsedCsvRow`)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvRow {
    pub date: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub category_name: String,
    pub amount: f64,
    pub description: String,
    pub account_name: String,
    pub to_account_name: String,
    pub installments: i64,
    /// Döviz/altın tarafı: birim, kendi birimindeki miktar ve kur (yoksa boş/null)
    pub fx_currency: String,
    pub orig_amount: Option<f64>,
    pub fx_rate: Option<f64>,
    /// İki tarafı da döviz olan transferde hedef tarafı (yoksa boş/null)
    pub to_fx_currency: String,
    pub to_orig_amount: Option<f64>,
    pub to_fx_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CsvSkip {
    pub line: usize,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvParse {
    pub rows: Vec<CsvRow>,
    pub skipped: Vec<CsvSkip>,
    /// Dosyada "Hesap" sütunu var mı
    pub has_account_column: bool,
}

const HEADER_ALIASES: [(&str, &[&str]); 14] = [
    ("date", &["tarih", "date"]),
    ("type", &["tur", "tip", "type"]),
    ("account", &["hesap", "account"]),
    ("toAccount", &["hedef hesap", "to account"]),
    ("category", &["kategori", "category"]),
    ("amount", &["tutar", "miktar", "amount"]),
    ("installments", &["taksit", "installments"]),
    // Döviz/altın hesabı işlemleri (dışa aktarmadaki sütunlar)
    ("fxCurrency", &["para birimi", "currency"]),
    ("origAmount", &["orijinal tutar", "original amount"]),
    ("fxRate", &["kur", "rate"]),
    // İki tarafı da döviz olan transferin hedef tarafı
    ("toFxCurrency", &["hedef para birimi", "to currency"]),
    ("toOrigAmount", &["hedef miktar", "to original amount"]),
    ("toFxRate", &["hedef kur", "to rate"]),
    ("description", &["aciklama", "description", "not", "note"]),
];

fn parse_type(s: &str) -> Option<&'static str> {
    match norm(s).as_str() {
        "gelir" | "income" | "+" => Some("income"),
        "gider" | "expense" | "harcama" | "-" => Some("expense"),
        "transfer" | "virman" | "havale" => Some("transfer"),
        _ => None,
    }
}

/// JS `Number.parseInt(s, 10)` 1–36 aralığındaysa o, değilse 1
fn installments_of(s: &str) -> i64 {
    let s = s.trim_start_matches(js_space);
    let (neg, rest) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let digits: &str = &rest[..rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len())];
    let digits = digits.trim_start_matches('0');
    if neg || digits.is_empty() || digits.len() > 2 {
        return 1;
    }
    let n: i64 = digits.parse().unwrap();
    if (1..=36).contains(&n) { n } else { 1 }
}

/// Kendi CSV biçimimizi (ve benzerlerini) okur (TS `parseTransactionsCsv`)
pub fn parse_transactions_csv(text: &str) -> CoreResult<CsvParse> {
    let clean = text.strip_prefix('\u{feff}').unwrap_or(text);
    let first = clean.split('\n').next().unwrap_or("");
    let first = first.strip_suffix('\r').unwrap_or(first);
    let table = parse_csv(clean, detect_delimiter(first));
    if table.len() < 2 {
        return Err("CSV dosyasında veri satırı bulunamadı.".into());
    }
    let header: Vec<String> = table[0].iter().map(|h| norm(h)).collect();
    let col: HashMap<&str, Option<usize>> =
        HEADER_ALIASES.iter().map(|(k, aliases)| (*k, header.iter().position(|h| aliases.contains(&h.as_str())))).collect();
    if col["date"].is_none() || col["amount"].is_none() {
        return Err("CSV başlığında en az 'Tarih' ve 'Tutar' sütunları olmalıdır.".into());
    }
    let mut rows = Vec::new();
    let mut skipped = Vec::new();
    for (i, r) in table[1..].iter().enumerate() {
        let line = i + 2;
        // Dışa aktarırken eklenen formül koruma öneki (') geri alınır
        let get = |k: &str| -> String {
            unguard_formula(col[k].map_or("", |c| r.get(c).map_or("", |v| js_trim(v)))).to_string()
        };
        let skip = |reason: &str| CsvSkip { line, reason: reason.into() };
        let Some(date) = parse_date(&get("date")) else {
            skipped.push(skip("Geçersiz tarih"));
            continue;
        };
        let raw = match parse_amount(&get("amount")) {
            Some(v) if v != 0.0 => v,
            _ => {
                skipped.push(skip("Geçersiz tutar"));
                continue;
            }
        };
        // Tür sütunu yoksa negatif tutar = gider
        let kind = parse_type(&get("type")).or(if raw < 0.0 {
            Some("expense")
        } else if col["type"].is_some() {
            None
        } else {
            Some("income")
        });
        let Some(kind) = kind else {
            skipped.push(skip("Geçersiz tür"));
            continue;
        };
        let decimal = |k: &str, d: i32| {
            let v = get(k);
            if v.is_empty() { None } else { parse_decimal(&v, d, false) }
        };
        rows.push(CsvRow {
            date,
            kind: kind.into(),
            category_name: get("category"),
            amount: raw.abs(),
            description: get("description"),
            account_name: get("account"),
            to_account_name: get("toAccount"),
            installments: installments_of(&get("installments")),
            fx_currency: get("fxCurrency"),
            orig_amount: decimal("origAmount", 3),
            fx_rate: decimal("fxRate", 6),
            to_fx_currency: get("toFxCurrency"),
            to_orig_amount: decimal("toOrigAmount", 3),
            to_fx_rate: decimal("toFxRate", 6),
        });
    }
    Ok(CsvParse { rows, skipped, has_account_column: col["account"].is_some() })
}
