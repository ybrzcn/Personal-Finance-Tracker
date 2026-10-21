//! Başlık satırı ve sütun tahmini (TS `findHeaderRow`, `guessColumns`, `defaultSignMode`)

use serde::{Deserialize, Serialize};

use crate::analysis::norm;

/// Alanların sütun numarası; -1 = yok
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMap {
    pub date: i64,
    pub description: i64,
    /// Tek, işaretli tutar sütunu
    pub amount: i64,
    /// Ayrı borç/çıkan sütunu
    pub debit: i64,
    /// Ayrı alacak/giren sütunu
    pub credit: i64,
    pub installments: i64,
}

const DATE: &[&str] = &["tarih", "islem tarihi", "date", "valor", "islem tarih"];
const DESCRIPTION: &[&str] = &["aciklama", "islem aciklamasi", "islem", "description", "detay", "isyeri", "uye isyeri", "merchant"];
const AMOUNT: &[&str] = &["tutar", "islem tutari", "tutar (tl)", "tutar tl", "amount", "miktar"];
const DEBIT: &[&str] = &["borc", "harcama", "cikan", "cekilen", "borc tutari"];
const CREDIT: &[&str] = &["alacak", "yatan", "giren", "alacak tutari"];
const INSTALLMENTS: &[&str] = &["taksit", "taksit sayisi", "installments"];

fn matches(cell: &str, aliases: &[&str]) -> bool {
    let c = norm(cell);
    aliases.iter().any(|a| c == *a || c.starts_with(&format!("{a} ")) || c.starts_with(&format!("{a}(")))
}

pub fn find_header_row(rows: &[Vec<String>]) -> usize {
    rows.iter()
        .take(30)
        .position(|r| r.iter().any(|c| matches(c, DATE)) && r.iter().any(|c| matches(c, AMOUNT) || matches(c, DEBIT) || matches(c, CREDIT)))
        .unwrap_or(0)
}

/// Her sütun en fazla bir alana atanır; önce tam eşleşme, sonra önek eşleşmesi
pub fn guess_columns(header: &[String]) -> ColumnMap {
    let mut used: Vec<usize> = Vec::new();
    let mut find = |aliases: &[&str]| -> i64 {
        let idx = header
            .iter()
            .enumerate()
            .position(|(i, h)| !used.contains(&i) && aliases.contains(&norm(h).as_str()))
            .or_else(|| header.iter().enumerate().position(|(i, h)| !used.contains(&i) && matches(h, aliases)));
        match idx {
            Some(i) => {
                used.push(i);
                i as i64
            }
            None => -1,
        }
    };
    let date = find(DATE);
    let amount = find(AMOUNT);
    let debit = find(DEBIT);
    let credit = find(CREDIT);
    let installments = find(INSTALLMENTS);
    let description = find(DESCRIPTION);
    ColumnMap { date, description, amount: if debit >= 0 && credit >= 0 { -1 } else { amount }, debit, credit, installments }
}

/// Tek tutar sütununda harcamanın işareti: kart ve kredide artı, diğerlerinde eksi
pub fn default_sign_mode(kind: &str) -> &'static str {
    if kind == "credit_card" || kind == "loan" {
        "positiveIsExpense"
    } else {
        "negativeIsExpense"
    }
}
