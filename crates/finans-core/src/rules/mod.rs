//! Kategori kuralları ve önerisi (TS `statementImport.ts` kategori tahmini, `CategoryRuleForm`, Analiz'deki Kafe önerisi)

pub mod cafe;
pub mod suggest;
pub mod words;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub use self::cafe::{cafe_suggestion, CafeSuggestion};
pub use self::suggest::{build_history, category_suggestions, suggest_category, suggest_for_uncategorized, CategorySuggestion, CategorySuggestions, History};
pub use self::words::{normalize_rule_word, parse_rule_words, rule_preview, transactions_matching, RuleDraft, RulePreview};

/// Kullanıcının kategori kuralı (ayarlardaki `categoryRules`)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryRule {
    pub id: String,
    pub words: Vec<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub category_id: String,
}

/// Ayarlardaki kurallar; biçimi bozuk öğe atlanır
pub fn read_rules(settings: &Map<String, Value>) -> Vec<CategoryRule> {
    settings
        .get("categoryRules")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect())
        .unwrap_or_default()
}
