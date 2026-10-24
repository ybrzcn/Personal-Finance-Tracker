//! Tablo satırlarını işlem önerilerine çevirme (TS `buildImportRows`): işaret, taksit, kart ödemesi, mükerrer, kategori önerisi

use std::sync::LazyLock;

use fancy_regex::Regex;
use serde::{Deserialize, Serialize};

use super::{default_sign_mode, guess_columns, js_re, js_trim, parse_amount, parse_date, ColumnMap};
use crate::accounts::cards::{clamped_date, js_cents};
use crate::db::{Account, Category, Transaction};
use crate::rules::words::words;
use crate::rules::{build_history, suggest_category, CategoryRule};
use crate::CoreResult;

/// Bozuk ya da kötü niyetli büyük dosyaya karşı satır sınırı
pub const MAX_ROWS: usize = 20_000;

pub struct RowsInput<'a> {
    pub table: Vec<Vec<String>>,
    pub header_row: usize,
    /// Boşsa başlık satırından tahmin edilir
    pub columns: Option<ColumnMap>,
    /// Boşsa hesabın varsayılanı
    pub sign_mode: Option<String>,
    pub account: &'a Account,
    pub accounts: &'a [Account],
    pub existing: &'a [Transaction],
    pub categories: &'a [Category],
    pub rules: &'a [CategoryRule],
    /// Ekstrenin kesim tarihi (özetten); yoksa en son işlem tarihi
    pub closing_date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRow {
    pub line: usize,
    pub date: String,
    pub description: String,
    pub amount: f64,
    /// "transfer" ise `to_account_id` hedef hesaptır
    #[serde(rename = "type")]
    pub kind: String,
    pub to_account_id: Option<String>,
    pub category_id: Option<String>,
    pub installments: i64,
    pub include: bool,
    /// Kullanıcıya gösterilecek not (mükerrer, kart ödemesi vb.)
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRows {
    pub rows: Vec<ImportRow>,
    pub skipped: i64,
    pub sign_mode: String,
    pub columns: ColumnMap,
}

static PLUS: LazyLock<Regex> = LazyLock::new(|| js_re(r"^\+"));
static CURRENCY_END: LazyLock<Regex> = LazyLock::new(|| js_re(r"(?i)\s*(TL|TRY)$"));
static ONGOING: LazyLock<Regex> = LazyLock::new(|| js_re(r"^\d+\s*/\s*\d+$"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| js_re(r"\s+"));

/// TS `trDate`: kısa (ör. üç haneli yıl) tarihte de TS gibi elde olan parçalar (çökmez)
fn tr_date(iso: &str) -> String {
    let part = |a: usize, b: usize| iso.get(a..b.min(iso.len())).unwrap_or("");
    format!("{}.{}.{}", part(8, 10), part(5, 7), part(0, 4))
}

/// Puanla/bonusla ödenen kısım (Garanti BBVA "BONUS BEDAVA ALIŞVERİŞ"): ekstre tutarına ve borca girmez
fn looks_like_reward_use(description: &str) -> bool {
    let w = words(description);
    w.contains(" bonus bedava ") || w.contains(" bonus kullanimi ")
}

fn looks_like_card_payment(description: &str) -> bool {
    let w = words(description);
    [" odeme ", " odemesi ", " odemeniz ", " kart odeme ", " hesaptan odeme "].iter().any(|k| w.contains(k))
}

/// JS `Number.parseInt(s, 10)`: baştaki boşluk ve işaretten sonraki rakamlar; yoksa None
fn js_parse_int(s: &str) -> Option<i64> {
    let t = js_trim(s);
    let (neg, digits) = match t.chars().next() {
        Some('-') => (true, &t[1..]),
        Some('+') => (false, &t[1..]),
        _ => (false, t),
    };
    let n: String = digits.chars().take_while(|c| c.is_ascii_digit()).collect();
    let v: i64 = n.parse().ok()?;
    Some(if neg { -v } else { v })
}

/// Satır isteği (sunucu ve masaüstü)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowsRequest {
    pub table: Vec<Vec<String>>,
    pub header_row: usize,
    #[serde(default)]
    pub columns: Option<ColumnMap>,
    #[serde(default)]
    pub sign_mode: Option<String>,
    pub account_id: String,
    #[serde(default)]
    pub closing_date: Option<String>,
}

/// İsteği veriyle birleştirir; hesap bu kullanıcıda yoksa "Bulunamadı."
pub fn rows_for(req: RowsRequest, accounts: &[Account], existing: &[Transaction], categories: &[Category], rules: &[CategoryRule]) -> CoreResult<ImportRows> {
    if req.table.len() > MAX_ROWS {
        return Err("Dosyada çok fazla satır var (en fazla 20.000).".into());
    }
    let account = accounts.iter().find(|a| a.id == req.account_id).ok_or("Bulunamadı.")?;
    build_import_rows(&RowsInput {
        table: req.table,
        header_row: req.header_row,
        columns: req.columns,
        sign_mode: req.sign_mode,
        account,
        accounts,
        existing,
        categories,
        rules,
        closing_date: req.closing_date,
    })
}

pub fn build_import_rows(input: &RowsInput) -> CoreResult<ImportRows> {
    if input.table.len() > MAX_ROWS {
        return Err("Dosyada çok fazla satır var (en fazla 20.000).".into());
    }
    let account = input.account;
    let empty = Vec::new();
    let header = input.table.get(input.header_row).unwrap_or(&empty);
    let map = input.columns.unwrap_or_else(|| guess_columns(header));
    let sign = input.sign_mode.clone().unwrap_or_else(|| default_sign_mode(&account.kind).to_string());
    let card = account.kind == "credit_card";
    let history = build_history(input.existing);
    let own: Vec<&Transaction> = input.existing.iter().filter(|t| t.account_id == account.id).collect();
    // Bozuk ya da kötü niyetli çok büyük başlık satırında taşma yok: gövde boş
    let body = input.header_row.checked_add(1).and_then(|s| input.table.get(s..)).unwrap_or(&[]);
    let cell = |r: &Vec<String>, idx: i64| -> String { if idx >= 0 { r.get(idx as usize).map_or("", |c| js_trim(c)).to_string() } else { String::new() } };
    // Devam eden taksit payı dönemden önce tarihliyse dönem sonuna (kesim tarihine) alınır
    let ref_date = input.closing_date.clone().or_else(|| body.iter().filter_map(|r| parse_date(&cell(r, map.date))).max());
    let period_start = ref_date.as_ref().map(|d| {
        let n = |a: usize, b: usize| d.get(a..b).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
        clamped_date(n(0, 4), n(5, 7) - 2, n(8, 10))
    });
    let seen: std::collections::HashSet<String> = own.iter().map(|t| format!("{}|{}|{}", t.date, js_cents(t.amount), t.kind)).collect();
    let cards: Vec<&Account> = input.accounts.iter().filter(|a| a.kind == "credit_card" && !a.archived && a.id != account.id).collect();
    let money = |s: &str| {
        let s = PLUS.replace(s, "");
        parse_amount(&CURRENCY_END.replace(&s, ""))
    };

    let mut rows = Vec::new();
    let mut skipped = 0;
    for (i, r) in body.iter().enumerate() {
        let mut date = parse_date(&cell(r, map.date));
        let signed = if map.amount >= 0 {
            let raw = cell(r, map.amount);
            money(&raw).map(|v| {
                // Açık "+" işareti her iki düzende de alacak (ödeme/iade/gelir) anlamına gelir
                if raw.starts_with('+') {
                    v.abs()
                } else if sign == "negativeIsExpense" {
                    v
                } else {
                    -v
                }
            })
        } else {
            let debit = if map.debit >= 0 { money(&cell(r, map.debit)) } else { None };
            let credit = if map.credit >= 0 { money(&cell(r, map.credit)) } else { None };
            match (debit, credit) {
                (Some(d), _) if d != 0.0 => Some(-d.abs()),
                (_, Some(c)) if c != 0.0 => Some(c.abs()),
                _ => None,
            }
        };
        let (Some(d), Some(signed)) = (date.clone(), signed) else {
            skipped += 1;
            continue;
        };
        if signed == 0.0 {
            skipped += 1;
            continue;
        }
        date = Some(d);
        let mut description = cell(r, map.description);
        let amount = signed.abs();
        let mut kind = if signed < 0.0 { "expense" } else { "income" };
        let mut to_account_id = None;
        let mut include = true;
        let mut note = String::new();

        // "2/6" gibi süren bir taksitin bu ayki payı: yeni taksitli alışveriş değil, tek tutar
        let inst_cell = js_trim(&cell(r, map.installments)).to_string();
        let ongoing = ONGOING.is_match(&inst_cell).unwrap_or(false);
        let mut original_date = None;
        if ongoing && card {
            description = format!("{description} (taksit {})", SPACES.replace_all(&inst_cell, ""));
            if let (Some(rd), Some(ps)) = (&ref_date, &period_start) {
                if date.as_deref().is_some_and(|x| x <= ps.as_str()) {
                    original_date = date.replace(rd.clone());
                    note = format!("İlk işlem {}", tr_date(original_date.as_deref().unwrap_or_default()));
                }
            }
        }
        let parsed_inst = if ongoing { Some(1) } else { js_parse_int(&inst_cell) };
        let installments = match parsed_inst {
            Some(n) if kind == "expense" && card && n > 1 && n <= 36 => n,
            _ => 1,
        };

        if card && looks_like_reward_use(&description) {
            include = false;
            note = "Bonus kullanımı: ekstre borcuna girmez".to_string();
        } else if card && kind == "income" && looks_like_card_payment(&description) {
            include = false;
            note = "Kart ödemesi: vadesiz hesap tarafında transfer olarak girin".to_string();
        } else if !card && kind == "expense" && looks_like_card_payment(&description) && !cards.is_empty() {
            kind = "transfer";
            to_account_id = Some(cards[0].id.clone());
            note = "Kart ödemesi olarak algılandı".to_string();
        }
        let date = date.unwrap_or_default();
        if seen.contains(&format!("{date}|{}|{kind}", js_cents(amount))) {
            include = false;
            note = "Aynı tarih ve tutarda kayıt zaten var".to_string();
        } else if let Some(od) = &original_date {
            if own.iter().any(|t| t.date == *od && js_cents(t.amount) == js_cents(amount) && t.kind == kind) {
                note = format!("{note}. Aynı tutarda {} tarihli kayıt var; o kaydı silin", tr_date(od));
            }
        }
        let category_id = if kind == "transfer" { None } else { suggest_category(&description, kind, &history, input.categories, input.rules) };
        rows.push(ImportRow {
            line: input.header_row.saturating_add(i + 2),
            date,
            description,
            amount,
            kind: kind.to_string(),
            to_account_id,
            category_id,
            installments,
            include,
            note,
        });
    }
    Ok(ImportRows { rows, skipped, sign_mode: sign, columns: map })
}
