//! Kelime eşleştirme (TS `words`, `normalizeRuleWord`, `longestMatch`, `transactionsMatching`, `parseWords`)

use serde::{Deserialize, Serialize};

use crate::analysis::norm;
use crate::db::Transaction;
use crate::import::js_trim;

/// TS `words`: normalize edilmiş, yalnız harf/rakam, başı ve sonu boşluklu (" migros sanal ")
pub(crate) fn words(s: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in norm(s).chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    format!(" {out} ")
}

/// Kural kelimesinin karşılaştırmada kullanılan biçimi ("MARKET-Örnek Şube" → "market ornek sube")
pub fn normalize_rule_word(word: &str) -> String {
    words(word).trim().to_string()
}

/// Kuralın kelimelerinden açıklamada geçen en uzununun uzunluğu; son kelime 4+ harfse önek eşleşmesi
pub(crate) fn longest_match(w: &str, rule_words: &[String]) -> usize {
    let mut best = 0;
    for k in rule_words {
        let n = normalize_rule_word(k);
        if n.is_empty() || n.len() <= best {
            continue;
        }
        let last = n.rsplit(' ').next().unwrap_or("");
        let found = if last.len() >= 4 { w.contains(&format!(" {n}")) } else { w.contains(&format!(" {n} ")) };
        if found {
            best = n.len();
        }
    }
    best
}

/// Kural formunda yazılan metin: virgülle ayrılır, kırpılır, normalize biçimi aynı olan tekrar atılır
pub fn parse_rule_words(text: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for w in text.split(',').map(js_trim) {
        let n = normalize_rule_word(w);
        if n.is_empty() || seen.contains(&n) {
            continue;
        }
        seen.push(n);
        out.push(w.to_string());
    }
    out
}

/// Kural önizlemesi: kelimelerden birini içeren, o türdeki işlemler (yeniden eskiye; eşit tarihte liste sırası)
pub fn transactions_matching(rule_words: &[String], kind: &str, txs: &[Transaction]) -> Vec<String> {
    if !rule_words.iter().any(|k| !normalize_rule_word(k).is_empty()) {
        return Vec::new();
    }
    let mut hit: Vec<&Transaction> =
        txs.iter().filter(|t| t.kind == kind && !t.description.is_empty() && longest_match(&words(&t.description), rule_words) > 0).collect();
    hit.sort_by(|a, b| b.date.cmp(&a.date));
    hit.into_iter().map(|t| t.id.clone()).collect()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDraft {
    pub words_text: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulePreview {
    /// Kaydedilecek kelimeler (kırpılmış, tekrarsız)
    pub words: Vec<String>,
    pub matching_transaction_ids: Vec<String>,
}

/// Kural formu önizlemesi
pub fn rule_preview(d: &RuleDraft, txs: &[Transaction]) -> RulePreview {
    let words = parse_rule_words(&d.words_text);
    RulePreview { matching_transaction_ids: transactions_matching(&words, &d.kind, txs), words }
}
