//! Yedek oluşturma (TS `createBackup` + Ayarlar `exportJson`)

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::db::{Account, Budget, Category, Goal, RecurringItem, Tag, Transaction};

/// Yedeğe giren veri (TS `DataSet`)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BackupData {
    pub categories: Vec<Category>,
    pub accounts: Vec<Account>,
    pub transactions: Vec<Transaction>,
    pub recurring: Vec<RecurringItem>,
    pub budgets: Vec<Budget>,
    pub goals: Vec<Goal>,
    pub tags: Vec<Tag>,
}

/// Arayüzün `DATA_DEFAULTS`'u (`src/state/settings.tsx`): veritabanında olmayan ayar bu değeri alır
fn data_defaults() -> Map<String, Value> {
    let v = json!({
        "debtBudget": 0,
        "debtBudgetOverrides": {},
        "debtRules": {},
        "debtCells": {},
        "subscriptionOverrides": {},
        "forecastCategoryIds": null,
        "categoryRules": [],
    });
    let Value::Object(m) = v else { unreachable!() };
    m
}

/// Sürüm 3 yedek: veri ve borç planı, analiz, kategori kuralları ayarları (değerler doğrulanmadan kopyalanır)
pub fn create_backup(data: &BackupData, settings: &Map<String, Value>, exported_at: &str) -> Value {
    let mut s = data_defaults();
    for (k, v) in settings {
        if s.contains_key(k) {
            s.insert(k.clone(), v.clone());
        }
    }
    let Value::Object(mut out) = serde_json::to_value(data).expect("yedek verisi") else { unreachable!() };
    out.insert("app".into(), json!("finans"));
    out.insert("version".into(), json!(3));
    out.insert("exportedAt".into(), json!(exported_at));
    out.insert(
        "debtPlan".into(),
        json!({
            "debtBudget": s["debtBudget"],
            "debtBudgetOverrides": s["debtBudgetOverrides"],
            "debtRules": s["debtRules"],
            "debtCells": s["debtCells"],
        }),
    );
    out.insert("analysis".into(), json!({ "subscriptionOverrides": s["subscriptionOverrides"], "forecastCategoryIds": s["forecastCategoryIds"] }));
    // TS `...(categoryRules ? { categoryRules } : {})`: JS'te yanlış sayılan değer eklenmez
    let rules = &s["categoryRules"];
    if js_truthy(rules) {
        out.insert("categoryRules".into(), rules.clone());
    }
    Value::Object(out)
}

/// JS doğruluk değeri (`null`, `false`, `0`, `""` yanlış)
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Dosyaya yazılacak metin (2 boşluk girinti)
pub fn backup_json(v: &Value) -> String {
    serde_json::to_string_pretty(v).expect("yedek JSON")
}
