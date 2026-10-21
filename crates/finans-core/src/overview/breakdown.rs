//! Gider dağılımları (TS `spreadInstallments`, `byCategory`, `byAccount`, `merchantName`, `topMerchants`)

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::accounts::cards::{js_round, spread_installments};
use crate::db::Transaction;

/// Aylara bölünmüş işlem parçası (TS `spreadInstallments` çıktısı): taksitsiz işlem kendi TL tutarıyla,
/// taksitli giderin her parçası `kuruş / 100`
#[derive(Debug, Clone)]
pub struct Part<'a> {
    pub date: String,
    pub amount: f64,
    pub tx: &'a Transaction,
}

pub fn spread(txs: &[Transaction]) -> Vec<Part<'_>> {
    let mut out = Vec::new();
    for t in txs {
        let n = if t.kind == "expense" { t.installments } else { 1 };
        if n <= 1 {
            out.push(Part { date: t.date.clone(), amount: t.amount, tx: t });
            continue;
        }
        for p in spread_installments(t) {
            out.push(Part { date: p.date, amount: p.cents as f64 / 100.0, tx: t });
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorySlice {
    /// Yok: Kategorisiz (kategorisi olmayan ya da silinmiş)
    pub category_id: Option<String>,
    pub cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSlice {
    pub account_id: String,
    pub cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MerchantRow {
    pub key: String,
    pub name: String,
    pub count: i64,
    pub total_cents: i64,
}

/// Anahtara göre kuruş toplamı; sıra ilk görülme, sonra tutar azalan (kararlı)
fn grouped<K: Clone + Eq + std::hash::Hash>(items: impl Iterator<Item = (K, i64)>) -> Vec<(K, i64)> {
    let mut order: Vec<(K, i64)> = Vec::new();
    let mut index: HashMap<K, usize> = HashMap::new();
    for (k, c) in items {
        let i = *index.entry(k.clone()).or_insert_with(|| {
            order.push((k, 0));
            order.len() - 1
        });
        order[i].1 += c;
    }
    order.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
    order
}

/// Giderlerin kategori dağılımı; listede olmayan kategori Kategorisiz altında birleşir
pub fn by_category(parts: &[Part], existing: &HashSet<&str>) -> Vec<CategorySlice> {
    let items = parts.iter().filter(|p| p.tx.kind == "expense").map(|p| {
        let key = p.tx.category_id.as_deref().filter(|id| existing.contains(id)).map(str::to_string);
        (key, js_round(p.amount * 100.0))
    });
    grouped(items).into_iter().map(|(category_id, cents)| CategorySlice { category_id, cents }).collect()
}

/// Giderlerin hesap dağılımı
pub fn by_account(parts: &[Part]) -> Vec<AccountSlice> {
    let items = parts.iter().filter(|p| p.tx.kind == "expense").map(|p| (p.tx.account_id.clone(), js_round(p.amount * 100.0)));
    grouped(items).into_iter().map(|(account_id, cents)| AccountSlice { account_id, cents }).collect()
}

/// TS `/[a-zçğıöşü]/i` (Unicode bayraksız): ASCII harfler, ç/Ç ğ/Ğ ö/Ö ş/Ş ü/Ü ve yalnız küçük ı
pub(crate) fn is_code_letter(c: char) -> bool {
    c.is_ascii_alphabetic() || "çÇğĞıöÖşŞüÜ".contains(c)
}

/// JS `\s` / `trim()` boşluk kümesi: Rust'ın `is_whitespace`'i U+0085'i (NEL) sayar, U+FEFF'i (BOM) saymaz; JS tersi
pub(crate) fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// Açıklamadan harcama yeri adı: kod/numara parçaları atılır, ilk iki kelime alınır
pub fn merchant_name(description: &str) -> String {
    let words: Vec<&str> = description
        .split(js_space)
        .filter(|w| !w.is_empty())
        // Sipariş/işlem kodları (harf+rakam karışık uzun parçalar, uzun sayılar) atılır; "A101" gibi adlar kalır
        .filter(|w| {
            let long_number = w.len() >= 4 && w.bytes().all(|b| b.is_ascii_digit());
            let code = w.encode_utf16().count() >= 6 && w.chars().any(|c| c.is_ascii_digit()) && w.chars().any(is_code_letter);
            !long_number && !code
        })
        .map(|w| w.trim_start_matches(['+', '*', '#']))
        .filter(|w| !w.is_empty())
        .collect();
    let joined = words.iter().take(2).copied().collect::<Vec<_>>().join(" ");
    let trimmed = description.trim_matches(js_space);
    let base = if !joined.is_empty() {
        joined.as_str()
    } else if !trimmed.is_empty() {
        trimmed
    } else {
        "Açıklamasız"
    };
    base.trim_end_matches(['*', '-', '–']).trim_matches(js_space).to_string()
}

/// TS `toLocaleUpperCase("tr")`
pub(crate) fn upper_tr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'i' => out.push('İ'),
            'ı' => out.push('I'),
            _ => out.extend(c.to_uppercase()),
        }
    }
    out
}

/// En çok harcama yapılan yerler (TL ara toplam her adımda kuruşa yuvarlanır, TS ile aynı)
pub fn top_merchants(parts: &[Part], limit: usize) -> Vec<MerchantRow> {
    struct Acc {
        key: String,
        name: String,
        count: i64,
        total: f64,
    }
    let mut rows: Vec<Acc> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for p in parts.iter().filter(|p| p.tx.kind == "expense") {
        let name = merchant_name(&p.tx.description);
        let key = upper_tr(&name);
        let i = *index.entry(key.clone()).or_insert_with(|| {
            rows.push(Acc { key, name, count: 0, total: 0.0 });
            rows.len() - 1
        });
        rows[i].count += 1;
        rows[i].total = js_round((rows[i].total + p.amount) * 100.0) as f64 / 100.0;
    }
    rows.sort_by(|a, b| b.total.partial_cmp(&a.total).unwrap_or(Ordering::Equal));
    rows.into_iter()
        .take(limit)
        .map(|r| MerchantRow { key: r.key, name: r.name, count: r.count, total_cents: js_round(r.total * 100.0) })
        .collect()
}
