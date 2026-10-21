//! CSV satırlarını mevcut verinin üstüne ekleme (TS `backup.ts` `mergeCsvRows`)

use std::collections::HashMap;

use serde::Serialize;

use super::csv::CsvRow;
use super::js_trim;
use super::palette::PALETTE;
use crate::analysis::lower_tr;
use crate::db::{new_id, Account, Category, Transaction};

/// Birleştirme sonucu: yeni kategoriler ve işlemler (mevcutlara eklenecek) ve sayaçlar
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvMerge {
    pub new_categories: Vec<Category>,
    pub new_transactions: Vec<Transaction>,
    pub created_categories: i64,
    pub skipped_transfers: i64,
    pub skipped_fx: i64,
}

/// TS `isForeign`
fn is_foreign(code: &str) -> bool {
    !code.is_empty() && code != "TRY"
}

/// Satırın döviz bilgisi `cur` birimindeyse (miktar, kur)
fn fx_of(currency: &str, orig: Option<f64>, rate: Option<f64>, cur: &str) -> Option<(f64, f64)> {
    match (orig, rate) {
        (Some(o), Some(r)) if currency == cur && o > 0.0 && r > 0.0 => Some((o, r)),
        _ => None,
    }
}

/// JS `s.slice(0, n)` (UTF-16 birimi); ikiye bölünen vekil çiftin yarısı atılır (Rust metninde tek başına duramaz)
fn slice_utf16(s: &str, n: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        end = i + c.len_utf8();
    }
    s[..end].to_string()
}

/// Eksik kategoriler (ad + tür) oluşturulur; hesap adı eşleşmezse `default_account_id`;
/// hedef hesabı eşleşmeyen transferler ve döviz bilgisi eksik satırlar atlanır.
pub fn merge_csv_rows(rows: &[CsvRow], categories: &[Category], accounts: &[Account], default_account_id: &str, now: &str) -> CsvMerge {
    let key = |name: &str, kind: &str| format!("{kind}:{}", lower_tr(js_trim(name)));
    let mut index: HashMap<String, String> = categories.iter().map(|c| (key(&c.name, &c.kind), c.id.clone())).collect();
    let by_name: HashMap<String, &Account> = accounts.iter().map(|a| (lower_tr(js_trim(&a.name)), a)).collect();
    let find = |name: &str| if name.is_empty() { None } else { by_name.get(&lower_tr(js_trim(name))).copied() };
    let by_id: HashMap<&str, &Account> = accounts.iter().map(|a| (a.id.as_str(), a)).collect();
    let currency_of = |id: &str| by_id.get(id).map_or("TRY", |a| if a.currency.is_empty() { "TRY" } else { a.currency.as_str() });
    let mut out = CsvMerge { new_categories: Vec::new(), new_transactions: Vec::new(), created_categories: 0, skipped_transfers: 0, skipped_fx: 0 };
    let tx = |r: &CsvRow, kind: &str, account_id: &str| Transaction {
        id: new_id(),
        amount: r.amount,
        kind: kind.into(),
        account_id: account_id.into(),
        to_account_id: None,
        category_id: None,
        date: r.date.clone(),
        description: r.description.clone(),
        installments: 1,
        budget_month: None,
        created_at: now.into(),
        orig_amount: None,
        fx_rate: None,
        to_orig_amount: None,
        to_fx_rate: None,
        tag_ids: Vec::new(),
    };
    for r in rows {
        let account_id = find(&r.account_name).map_or(default_account_id, |a| a.id.as_str());
        if r.kind == "transfer" {
            let Some(to) = find(&r.to_account_name).filter(|to| to.id != account_id) else {
                out.skipped_transfers += 1;
                continue;
            };
            let from_cur = currency_of(account_id);
            let to_cur = if to.currency.is_empty() { "TRY" } else { to.currency.as_str() };
            let from = if is_foreign(from_cur) { fx_of(&r.fx_currency, r.orig_amount, r.fx_rate, from_cur) } else { None };
            // İki tarafı da döviz olan transferin hedefi "Hedef ..." sütunlarında; tek tarafı dövizse ana döviz sütunlarında
            let to_side = if !is_foreign(to_cur) {
                None
            } else if from.is_some() {
                fx_of(&r.to_fx_currency, r.to_orig_amount, r.to_fx_rate, to_cur)
            } else {
                fx_of(&r.fx_currency, r.orig_amount, r.fx_rate, to_cur)
            };
            // Bilgisi eksik döviz tarafı alınamaz
            if (is_foreign(from_cur) && from.is_none()) || (is_foreign(to_cur) && to_side.is_none()) {
                out.skipped_fx += 1;
                continue;
            }
            let mut t = tx(r, "transfer", account_id);
            t.to_account_id = Some(to.id.clone());
            (t.orig_amount, t.fx_rate) = (from.map(|f| f.0), from.map(|f| f.1));
            (t.to_orig_amount, t.to_fx_rate) = (to_side.map(|f| f.0), to_side.map(|f| f.1));
            out.new_transactions.push(t);
            continue;
        }
        let cur = currency_of(account_id);
        let fx = if is_foreign(cur) { fx_of(&r.fx_currency, r.orig_amount, r.fx_rate, cur) } else { None };
        if is_foreign(cur) && fx.is_none() {
            out.skipped_fx += 1;
            continue;
        }
        let mut t = tx(r, &r.kind, account_id);
        if !r.category_name.is_empty() {
            let name = slice_utf16(js_trim(&r.category_name), 60);
            let k = key(&name, &r.kind);
            let id = match index.get(&k) {
                Some(id) => id.clone(),
                None => {
                    // TS `PALETTE[(cats.length + created) % 16]`: `cats` yeni eklenenleri de içerir
                    let color = PALETTE[(categories.len() + 2 * out.created_categories as usize) % PALETTE.len()];
                    let c = Category { id: new_id(), name, kind: r.kind.clone(), color: color.into() };
                    index.insert(k, c.id.clone());
                    out.created_categories += 1;
                    let id = c.id.clone();
                    out.new_categories.push(c);
                    id
                }
            };
            t.category_id = Some(id);
        }
        if r.kind == "expense" && by_id.get(account_id).is_some_and(|a| a.kind == "credit_card") {
            t.installments = r.installments;
        }
        (t.orig_amount, t.fx_rate) = (fx.map(|f| f.0), fx.map(|f| f.1));
        out.new_transactions.push(t);
    }
    out
}
