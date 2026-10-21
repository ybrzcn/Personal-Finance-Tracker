//! Kategori önerisi: kullanıcı kuralı, geçmiş işlemler, hazır anahtar kelimeler (TS `suggestCategory`)

use std::collections::HashMap;

use serde::Serialize;

use super::words::{longest_match, words};
use super::CategoryRule;
use crate::analysis::norm;
use crate::db::{Category, Transaction};

/// Varsayılan kategori adlarına anahtar kelimeler (normalize, tam kelime). Sıra önemli: Kafe Restoran'dan önce
pub(crate) const RULES: &[(&str, &str, &[&str])] = &[
    (
        "Abonelikler",
        "expense",
        &[
            "figma", "anthropic", "claude", "openai", "chatgpt", "midjourney", "cursor", "github", "gitlab", "notion", "slack", "zoom",
            "dropbox", "canva", "adobe", "microsoft", "office 365", "msft", "google one", "google storage", "google workspace",
            "gsuite", "youtube premium", "youtube", "icloud", "apple com", "apple com bill", "itunes", "netflix", "spotify",
            "disney", "blutv", "exxen", "gain", "tod tv", "mubi", "amazon prime", "prime video", "audible", "linkedin", "medium",
            "patreon", "duolingo", "nordvpn", "expressvpn", "1password", "lastpass", "jetbrains", "vercel", "heroku", "digitalocean",
            "aws", "cloudflare", "godaddy", "namecheap", "squarespace", "wix", "shopify", "substack",
        ],
    ),
    ("Market", "expense", &["migros", "a101", "bim", "sok", "carrefour", "carrefoursa", "macrocenter", "hakmar", "file market", "metro", "onur market", "bizim toptan", "market", "getir buyuk"]),
    ("Kafe", "expense", &["starbucks", "cafe", "kafe", "kahve", "coffee", "caffe", "espresso", "kahvecisi", "kahve dunyasi", "gloria jeans", "caribou", "tchibo", "nero", "costa", "walkers", "petra", "brew", "barista"]),
    ("Restoran", "expense", &["yemeksepeti", "getir yemek", "trendyol yemek", "starbucks", "burger", "kfc", "mcdonalds", "dominos", "pizza", "cafe", "kafe", "kahve", "restoran", "restaurant", "lokanta", "kebap", "doner", "mc donalds", "mcdonald s", "burger king", "unlu mamul", "unlu mamuller", "firin", "pastane", "simit"]),
    ("Ulaşım", "expense", &["shell", "opet", "bp", "petrol ofisi", "po", "total", "aytemiz", "akaryakit", "uber", "bitaksi", "marti", "istanbulkart", "otopark", "hgs", "ogs", "thy", "pegasus", "ajet", "metro istanbul", "taksi"]),
    ("Faturalar", "expense", &["turkcell", "vodafone", "turk telekom", "superonline", "enerjisa", "ck enerji", "igdas", "iski", "aski", "izsu", "dogalgaz", "elektrik", "fatura", "turknet"]),
    ("Eğlence", "expense", &["steam", "playstation", "xbox", "sinema", "cinemaximum", "biletix", "passo", "airbnb", "booking com", "otel", "hotel"]),
    ("Sağlık", "expense", &["eczane", "eczanesi", "hastane", "hastanesi", "klinik", "saglik", "doktor", "dis"]),
    ("Giyim", "expense", &["zara", "lcw", "lc waikiki", "koton", "defacto", "mavi", "boyner", "h m", "pull bear", "bershka", "decathlon"]),
    ("Kira", "expense", &["kira"]),
    ("Faiz ve Masraflar", "expense", &["faiz", "kkdf", "bsmv", "masraf", "komisyon", "kart aidati", "aidat", "ucret", "gecikme"]),
    ("Nakit Avans", "expense", &["nakit avans", "nakit cekim", "atm nakit", "taksitli nakit"]),
    ("Maaş", "income", &["maas", "maas odemesi", "personel odeme"]),
];

/// Geçmiş: "tür:açıklamanın ilk iki kelimesi" → en sık kategori (eşitlikte ilk görülen)
#[derive(Debug, Clone, Default)]
pub struct History(HashMap<String, String>);

impl History {
    pub fn get(&self, key: &str) -> Option<&String> {
        self.0.get(key)
    }
}

/// TS `historyKey`: yalnız harfler, 1 harften uzun ilk iki kelime
fn history_key(description: &str) -> String {
    let cleaned: String = norm(description).chars().map(|c| if c.is_ascii_lowercase() || crate::overview::breakdown::js_space(c) { c } else { ' ' }).collect();
    cleaned.split(crate::overview::breakdown::js_space).filter(|w| w.encode_utf16().count() > 1).take(2).collect::<Vec<_>>().join(" ")
}

pub fn build_history(txs: &[Transaction]) -> History {
    // Kategori sırası ilk görülme sırasıdır (TS Map ekleme sırası; eşitlikte ilk görülen kazanır)
    let mut counts: Vec<(String, Vec<(String, i64)>)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for t in txs {
        let Some(cat) = t.category_id.as_deref() else { continue };
        if cat.is_empty() || t.description.is_empty() || t.kind == "transfer" {
            continue;
        }
        let key = format!("{}:{}", t.kind, history_key(&t.description));
        let idx = *index.entry(key.clone()).or_insert_with(|| {
            counts.push((key, Vec::new()));
            counts.len() - 1
        });
        let m = &mut counts[idx].1;
        match m.iter_mut().find(|(c, _)| c == cat) {
            Some(e) => e.1 += 1,
            None => m.push((cat.to_string(), 1)),
        }
    }
    History(
        counts
            .into_iter()
            .map(|(k, m)| {
            let mut best = &m[0];
            for e in &m[1..] {
                if e.1 > best.1 {
                    best = e;
                }
            }
            (k, best.0.clone())
            })
            .collect(),
    )
}

/// Kullanıcı kuralı: en uzun kelimesi eşleşen kazanır; eşitlikte listede önce gelen. Kategorisi silinmiş kural atlanır
fn match_user_rule(description: &str, kind: &str, rules: &[CategoryRule], categories: &[Category]) -> Option<String> {
    let w = words(description);
    let mut best = None;
    let mut best_len = 0;
    for r in rules {
        if r.kind != kind || !categories.iter().any(|c| c.id == r.category_id && c.kind == kind) {
            continue;
        }
        let len = longest_match(&w, &r.words);
        if len > best_len {
            best = Some(r.category_id.clone());
            best_len = len;
        }
    }
    best
}

/// Öneri: önce kullanıcı kuralları, sonra geçmiş, en son hazır anahtar kelime listesi
pub fn suggest_category(description: &str, kind: &str, history: &History, categories: &[Category], rules: &[CategoryRule]) -> Option<String> {
    if let Some(id) = match_user_rule(description, kind, rules, categories) {
        return Some(id);
    }
    let key = format!("{kind}:{}", history_key(description));
    if let Some(id) = history.get(&key) {
        if categories.iter().any(|c| c.id == *id) {
            return Some(id.clone());
        }
    }
    let w = words(description);
    for (name, rkind, list) in RULES {
        if *rkind != kind || !list.iter().any(|k| w.contains(&format!(" {k} "))) {
            continue;
        }
        if let Some(c) = categories.iter().find(|c| c.kind == kind && norm(&c.name) == norm(name)) {
            return Some(c.id.clone());
        }
    }
    None
}

/// Kategorisiz gelir/gider işlemleri için öneriler (işlem, kategori), işlem sırasıyla
pub fn suggest_for_uncategorized(txs: &[Transaction], categories: &[Category], rules: &[CategoryRule]) -> Vec<(String, String)> {
    let history = build_history(txs);
    txs.iter()
        .filter(|t| t.category_id.as_deref().is_none_or(str::is_empty) && t.kind != "transfer" && !t.description.is_empty())
        .filter_map(|t| suggest_category(&t.description, &t.kind, &history, categories, rules).map(|c| (t.id.clone(), c)))
        .collect()
}

/// Açıklama, adı verilen kategorinin anahtar kelime kuralına uyuyor mu (TS `matchesCategoryRule`)
pub(crate) fn matches_category_rule(description: &str, category_name: &str) -> bool {
    let w = words(description);
    RULES.iter().any(|(name, _, list)| norm(name) == norm(category_name) && list.iter().any(|k| w.contains(&format!(" {k} "))))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorySuggestion {
    pub transaction_id: String,
    pub category_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorySuggestions {
    pub suggestions: Vec<CategorySuggestion>,
}

/// İşlemler sayfasının "Otomatik kategorile" önerileri
pub fn category_suggestions(txs: &[Transaction], categories: &[Category], rules: &[CategoryRule]) -> CategorySuggestions {
    CategorySuggestions {
        suggestions: suggest_for_uncategorized(txs, categories, rules)
            .into_iter()
            .map(|(transaction_id, category_id)| CategorySuggestion { transaction_id, category_id })
            .collect(),
    }
}
