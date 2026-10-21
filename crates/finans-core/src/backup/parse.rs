//! Yedeği doğrulama (TS `parseBackup`): alan tipleri, varsayılanlar, v1 yedeğin "Genel Hesap"a taşınması, hesap referansları

use std::collections::HashSet;

use serde_json::{json, Map, Value};

use crate::db::{new_id, Account};
use crate::import::csv::js_number_string;
use crate::import::js_trim;
use crate::CoreResult;

/// TS `makeDefaultAccount`
pub fn make_default_account(opening_date: &str) -> Account {
    Account {
        id: new_id(),
        name: "Genel Hesap".into(),
        kind: "bank".into(),
        color: "#6366f1".into(),
        opening_balance: 0.0,
        opening_date: opening_date.into(),
        credit_limit: None,
        interest_rate: None,
        statement_day: None,
        due_day: None,
        min_payment_rate: None,
        sort_order: 0,
        archived: false,
        term_months: None,
        first_due_date: None,
        installment_amount: None,
        tax_rate: None,
        funding_income_id: None,
        opening_period_spending: None,
        opening_installments: Vec::new(),
        currency: "TRY".into(),
        opening_cost: Some(None),
    }
}

/// JS'te `Infinity`e taşan sayı (`1e400`): serde_json ayrıştıramadığı için metinde bu işaretlere çevrilir
const POS_INF: &str = "\u{0}finans:Infinity\u{0}";
const NEG_INF: &str = "\u{0}finans:-Infinity\u{0}";

/// Metin dışındaki sayılardan f64'e sığmayanları işaret metnine çevirir
fn mark_overflow(text: &str) -> String {
    let b = text.as_bytes();
    let (mut out, mut i, mut start, mut in_str) = (String::with_capacity(text.len()), 0, 0, false);
    while i < b.len() {
        let c = b[i];
        if in_str {
            match c {
                b'\\' => i += 1,
                b'"' => in_str = false,
                _ => {}
            }
        } else if c == b'"' {
            in_str = true;
        } else if c == b'-' || c.is_ascii_digit() {
            let end = b[i..].iter().position(|x| !matches!(x, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')).map_or(b.len(), |p| i + p);
            let tok = &text[i..end];
            if let Some(v) = tok.parse::<f64>().ok().filter(|v| v.is_infinite()) {
                out.push_str(&text[start..i]);
                out.push_str(&serde_json::to_string(if v > 0.0 { POS_INF } else { NEG_INF }).unwrap());
                start = end;
            }
            i = end;
            continue;
        }
        i += 1;
    }
    out.push_str(&text[start..]);
    out
}

/// JS `typeof` denetimleri: taşan sayı işareti metin değil sayıdır
trait JsValue {
    fn js_str(&self) -> Option<&str>;
    /// `typeof v === "string"`
    fn is_str(&self) -> bool;
    /// `typeof v === "number"` (`Infinity` dahil)
    fn is_num(&self) -> bool;
}

impl JsValue for Value {
    fn js_str(&self) -> Option<&str> {
        self.as_str().filter(|s| *s != POS_INF && *s != NEG_INF)
    }
    fn is_str(&self) -> bool {
        self.js_str().is_some()
    }
    fn is_num(&self) -> bool {
        self.is_number() || matches!(self.as_str(), Some(POS_INF | NEG_INF))
    }
}

/// Çıktıdaki `Infinity` JSON'da `null` olur (TS sonucu `JSON.stringify` ile gider)
fn infinity_to_null(v: &mut Value) {
    match v {
        Value::String(s) if s == POS_INF || s == NEG_INF => *v = Value::Null,
        Value::Array(a) => a.iter_mut().for_each(infinity_to_null),
        Value::Object(m) => m.values_mut().for_each(infinity_to_null),
        _ => {}
    }
}

/// JS `typeof v === "object" && v !== null` (diziler dahil)
fn is_obj(v: &Value) -> bool {
    matches!(v, Value::Object(_) | Value::Array(_))
}

/// JS `v.key` (dizide adlı alan yok)
fn field<'a>(v: &'a Value, key: &str) -> &'a Value {
    match v {
        Value::Object(m) => m.get(key).unwrap_or(&Value::Null),
        _ => &Value::Null,
    }
}

/// JS `Object.entries(isObj(v) ? v : {})`
fn entries(v: &Value) -> Vec<(String, &Value)> {
    match v {
        Value::Object(m) => m.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Value::Array(a) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect(),
        _ => Vec::new(),
    }
}

/// TS `str`: boş olmayan metin ya da null
fn str_or_null(v: &Value) -> Value {
    match v {
        Value::String(s) if !s.is_empty() => v.clone(),
        _ => Value::Null,
    }
}

/// TS `num`: sayı ya da null
fn num(v: &Value) -> Value {
    if v.is_number() { v.clone() } else { Value::Null }
}

fn num_or(v: &Value, d: Value) -> Value {
    if v.is_number() { v.clone() } else { d }
}

fn string_or(v: &Value, d: &str) -> Value {
    if v.is_str() { v.clone() } else { json!(d) }
}

fn is_category_type(v: &Value) -> bool {
    matches!(v.js_str(), Some("income" | "expense"))
}

/// JS `String(v)`
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) if s == POS_INF => "Infinity".into(),
        Value::String(s) if s == NEG_INF => "-Infinity".into(),
        Value::String(s) => s.clone(),
        // Dizi öğeleri `,` ile birleşir; null öğe boş metin olur
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// Metin dizisinin elemanlarından yalnız metinler (dizi değilse boş)
fn strings(v: &Value) -> Value {
    Value::Array(v.as_array().map_or(Vec::new(), |a| a.iter().filter(|x| x.is_str()).cloned().collect()))
}

/// JS metin karşılaştırması (UTF-16 birimi sırası)
fn js_less(a: &str, b: &str) -> bool {
    a.encode_utf16().lt(b.encode_utf16())
}

/// Yedekteki kategori kurallarını doğrular; geçersiz kurallar ve kelimesi kalmayanlar atlanır
fn parse_category_rules(v: &Value) -> Option<Value> {
    let a = v.as_array()?;
    let rules = a.iter().filter_map(|r| {
        let (id, category_id, kind, words) = (field(r, "id"), field(r, "categoryId"), field(r, "type"), field(r, "words"));
        if !is_obj(r) || !id.is_str() || !category_id.is_str() || !is_category_type(kind) {
            return None;
        }
        let words: Vec<Value> = words.as_array()?.iter().filter_map(|w| w.js_str().map(js_trim).filter(|w| !w.is_empty()).map(|w| json!(w))).collect();
        (!words.is_empty()).then(|| json!({ "id": id, "words": words, "type": kind, "categoryId": category_id }))
    });
    Some(Value::Array(rules.collect()))
}

/// Yedekteki analiz ayarlarını doğrular; geçersiz girdiler atlanır
fn parse_analysis(v: &Value) -> Option<Value> {
    if !is_obj(v) {
        return None;
    }
    let mut overrides = Map::new();
    for (key, o) in entries(field(v, "subscriptionOverrides")) {
        if !is_obj(o) {
            continue;
        }
        let mut x = Map::new();
        if let Some(name) = field(o, "name").js_str().map(js_trim).filter(|n| !n.is_empty()) {
            x.insert("name".into(), json!(name));
        }
        if matches!(field(o, "period").js_str(), Some("monthly" | "yearly")) {
            x.insert("period".into(), field(o, "period").clone());
        }
        if field(o, "cancelled") == &Value::Bool(true) {
            x.insert("cancelled".into(), json!(true));
        }
        overrides.insert(key, Value::Object(x));
    }
    let ids = field(v, "forecastCategoryIds");
    let ids = if ids.is_array() { strings(ids) } else { Value::Null };
    Some(json!({ "subscriptionOverrides": overrides, "forecastCategoryIds": ids }))
}

/// Yedekteki borç planı ayarlarını doğrular; geçersiz girdiler atlanır
fn parse_debt_plan(v: &Value) -> Option<Value> {
    if !is_obj(v) {
        return None;
    }
    let numbers = |o: &Value| -> Map<String, Value> { entries(o).into_iter().filter(|(_, x)| x.is_number()).map(|(k, x)| (k, x.clone())).collect() };
    let mut rules = Map::new();
    for (id, r) in entries(field(v, "debtRules")) {
        let mode = field(r, "mode");
        if !is_obj(r) || !["full", "minimum", "fixed", "none"].contains(&js_string(mode).as_str()) {
            continue;
        }
        // TS `mode: r.mode` (denetim `String(r.mode)` ile; değer olduğu gibi kopyalanır)
        let mut x = Map::new();
        x.insert("mode".into(), mode.clone());
        if field(r, "amount").is_number() {
            x.insert("amount".into(), field(r, "amount").clone());
        }
        rules.insert(id, Value::Object(x));
    }
    // TS `Math.max(0, num(v.debtBudget) ?? 0)`
    let budget = match field(v, "debtBudget") {
        n @ Value::Number(x) if x.as_f64().is_some_and(|f| f > 0.0) => n.clone(),
        _ => json!(0),
    };
    Some(json!({
        "debtBudget": budget,
        "debtBudgetOverrides": numbers(field(v, "debtBudgetOverrides")),
        "debtRules": rules,
        "debtCells": numbers(field(v, "debtCells")),
    }))
}

fn parse_account(a: &Value, i: usize) -> CoreResult<Value> {
    let f = |k| field(a, k);
    if !is_obj(a) || !f("id").is_str() || !f("name").is_str() || !matches!(f("kind").js_str(), Some("bank" | "cash" | "credit_card" | "loan")) || !f("openingDate").is_str() {
        return Err(format!("Yedekteki {}. hesap geçersiz.", i + 1));
    }
    let installments: Vec<Value> = f("openingInstallments")
        .as_array()
        .map_or(&[][..], |v| v.as_slice())
        .iter()
        .filter(|it| is_obj(it) && field(it, "amount").is_num() && field(it, "remaining").is_num())
        .map(|it| json!({ "description": string_or(field(it, "description"), ""), "amount": field(it, "amount"), "remaining": field(it, "remaining") }))
        .collect();
    Ok(json!({
        "id": f("id"),
        "name": f("name"),
        "kind": f("kind"),
        "color": string_or(f("color"), "#6366f1"),
        "openingBalance": num_or(f("openingBalance"), json!(0)),
        "openingDate": f("openingDate"),
        "creditLimit": num(f("creditLimit")),
        "interestRate": num(f("interestRate")),
        "statementDay": num(f("statementDay")),
        "dueDay": num(f("dueDay")),
        "minPaymentRate": num(f("minPaymentRate")),
        "sortOrder": num_or(f("sortOrder"), json!(0)),
        "archived": f("archived") == &Value::Bool(true),
        "termMonths": num(f("termMonths")),
        "firstDueDate": str_or_null(f("firstDueDate")),
        "installmentAmount": num(f("installmentAmount")),
        "taxRate": num(f("taxRate")),
        "fundingIncomeId": str_or_null(f("fundingIncomeId")),
        "openingPeriodSpending": num(f("openingPeriodSpending")),
        "currency": match f("currency").js_str() { Some(c) if !c.is_empty() => json!(c), _ => json!("TRY") },
        "openingCost": if f("openingCost").as_f64().is_some_and(|c| c > 0.0) { f("openingCost").clone() } else { Value::Null },
        "openingInstallments": installments,
    }))
}

fn parse_recurring(r: &Value, i: usize) -> CoreResult<Value> {
    let f = |k| field(r, k);
    if !is_obj(r) || !f("id").is_str() || !f("name").is_str() || !is_category_type(f("type")) || !f("amount").is_num() {
        return Err(format!("Yedekteki {}. düzenli kayıt geçersiz.", i + 1));
    }
    let list = |k| f(k).as_array().map_or(&[][..], |v| v.as_slice());
    let history: Vec<Value> = list("history")
        .iter()
        .filter(|h| is_obj(h) && field(h, "from").is_str() && field(h, "amount").is_num())
        .map(|h| json!({ "from": field(h, "from"), "amount": field(h, "amount") }))
        .collect();
    let exceptions: Vec<Value> = list("exceptions")
        .iter()
        .filter(|e| is_obj(e) && field(e, "month").is_str() && field(e, "amount").is_num())
        .map(|e| json!({ "month": field(e, "month"), "amount": field(e, "amount"), "note": string_or(field(e, "note"), "") }))
        .collect();
    Ok(json!({
        "id": f("id"),
        "name": f("name"),
        "type": f("type"),
        "amount": f("amount"),
        "day": num_or(f("day"), json!(1)),
        "accountId": str_or_null(f("accountId")),
        "categoryId": str_or_null(f("categoryId")),
        "active": f("active") != &Value::Bool(false),
        "sortOrder": num_or(f("sortOrder"), json!(0)),
        "history": history,
        "exceptions": exceptions,
        "coversPreviousMonth": f("coversPreviousMonth") == &Value::Bool(true),
        "startDate": str_or_null(f("startDate")),
        "weekendShift": match f("weekendShift").js_str() { Some(w @ ("before" | "after")) => json!(w), _ => json!("none") },
        "origAmount": num(f("origAmount")),
    }))
}

/// JSON yedeğini ayrıştırır ve doğrular; v1 yedekler "Genel Hesap"a taşınır (işlem yoksa açılış `today`)
pub fn parse_backup(text: &str, today: &str) -> CoreResult<Value> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    // JS `JSON.parse` taşan sayıyı `Infinity` yapar; serde_json reddeder: o sayılar işaretlenip yeniden denenir
    let data: Value = serde_json::from_str(text)
        .or_else(|e| if e.to_string().starts_with("number out of range") { serde_json::from_str(&mark_overflow(text)) } else { Err(e) })
        .map_err(|_| "Dosya geçerli bir JSON değil.".to_string())?;
    let d = |k| field(&data, k);
    let (Some(cats), Some(txs)) = (d("categories").as_array(), d("transactions").as_array()) else {
        return Err("Bu dosya bir Finans yedeği gibi görünmüyor (categories / transactions alanları eksik).".into());
    };
    let categories = cats
        .iter()
        .enumerate()
        .map(|(i, c)| {
            if !is_obj(c) || !field(c, "id").is_str() || !field(c, "name").is_str() || !is_category_type(field(c, "type")) {
                return Err(format!("Yedekteki {}. kategori geçersiz.", i + 1));
            }
            Ok(json!({ "id": field(c, "id"), "name": field(c, "name"), "type": field(c, "type"), "color": string_or(field(c, "color"), "#64748b") }))
        })
        .collect::<CoreResult<Vec<_>>>()?;

    let mut accounts = match d("accounts").as_array() {
        Some(a) => a.iter().enumerate().map(|(i, a)| parse_account(a, i)).collect::<CoreResult<Vec<_>>>()?,
        None => Vec::new(),
    };
    let mut default_id: Option<String> = None;
    if !d("accounts").is_array() {
        // En eski işlem tarihi (yoksa bugün) "Genel Hesap"ın açılışı olur
        let oldest = txs.iter().filter_map(|t| field(t, "date").js_str()).filter(|s| !s.is_empty()).fold(None, |m: Option<&str>, s| match m {
            Some(m) if !js_less(s, m) => Some(m),
            _ => Some(s),
        });
        let a = make_default_account(oldest.unwrap_or(today));
        default_id = Some(a.id.clone());
        accounts.push(serde_json::to_value(a).expect("hesap"));
    }
    let ids: HashSet<&str> = accounts.iter().filter_map(|a| a["id"].js_str()).collect();

    let transactions = txs
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let f = |k| field(t, k);
            let kind = f("type").js_str().filter(|k| matches!(*k, "income" | "expense" | "transfer"));
            let (Some(kind), true) = (kind, is_obj(t) && f("id").is_str() && f("amount").is_num() && f("date").is_str()) else {
                return Err(format!("Yedekteki {}. işlem geçersiz.", i + 1));
            };
            let account_id = default_id.clone().unwrap_or_else(|| f("accountId").js_str().unwrap_or("").to_string());
            let to = f("toAccountId").js_str();
            if !ids.contains(account_id.as_str()) || (kind == "transfer" && !to.is_some_and(|to| !to.is_empty() && ids.contains(to))) {
                return Err(format!("Yedekteki {}. işlemin hesabı bulunamadı.", i + 1));
            }
            Ok(json!({
                "id": f("id"),
                "amount": f("amount"),
                "type": kind,
                "accountId": account_id,
                "toAccountId": if kind == "transfer" { json!(to) } else { Value::Null },
                "categoryId": if kind != "transfer" && f("categoryId").is_str() { f("categoryId").clone() } else { Value::Null },
                "date": f("date"),
                "description": string_or(f("description"), ""),
                "installments": num_or(f("installments"), json!(1)),
                "budgetMonth": if kind == "income" && f("budgetMonth").is_str() { f("budgetMonth").clone() } else { Value::Null },
                "createdAt": string_or(f("createdAt"), ""),
                "origAmount": num(f("origAmount")),
                "fxRate": num(f("fxRate")),
                "toOrigAmount": num(f("toOrigAmount")),
                "toFxRate": num(f("toFxRate")),
                "tagIds": strings(f("tagIds")),
            }))
        })
        .collect::<CoreResult<Vec<_>>>()?;

    let list = |k| d(k).as_array().map_or(&[][..], |v| v.as_slice());
    let recurring = list("recurring").iter().enumerate().map(|(i, r)| parse_recurring(r, i)).collect::<CoreResult<Vec<_>>>()?;
    let budgets: Vec<Value> = list("budgets")
        .iter()
        .filter(|b| is_obj(b) && field(b, "categoryId").is_str() && field(b, "amount").is_num())
        .map(|b| json!({ "categoryId": field(b, "categoryId"), "amount": field(b, "amount") }))
        .collect();
    let goals: Vec<Value> = list("goals")
        .iter()
        .filter(|g| is_obj(g) && ["id", "name", "currency"].iter().all(|k| field(g, k).is_str()) && field(g, "target").is_num())
        .map(|g| {
            json!({
                "id": field(g, "id"),
                "name": field(g, "name"),
                "currency": field(g, "currency"),
                "target": field(g, "target"),
                "targetDate": str_or_null(field(g, "targetDate")),
                "color": string_or(field(g, "color"), "#64748b"),
                "archived": field(g, "archived") == &Value::Bool(true),
                "accountIds": strings(field(g, "accountIds")),
                "createdAt": string_or(field(g, "createdAt"), ""),
            })
        })
        .collect();
    let tags: Vec<Value> = list("tags")
        .iter()
        .filter(|g| is_obj(g) && field(g, "id").is_str() && field(g, "name").is_str())
        .map(|g| {
            json!({
                "id": field(g, "id"),
                "name": field(g, "name"),
                "color": string_or(field(g, "color"), "#64748b"),
                "budget": num(field(g, "budget")),
                "archived": field(g, "archived") == &Value::Bool(true),
                "createdAt": string_or(field(g, "createdAt"), ""),
            })
        })
        .collect();

    let exported_at = match d("exportedAt") {
        Value::Null => String::new(),
        v => js_string(v),
    };
    let mut out = json!({
        "app": "finans",
        "version": 3,
        "exportedAt": exported_at,
        "categories": categories,
        "accounts": accounts,
        "transactions": transactions,
        "recurring": recurring,
        "budgets": budgets,
        "goals": goals,
        "tags": tags,
    });
    for (k, v) in [("debtPlan", parse_debt_plan(d("debtPlan"))), ("analysis", parse_analysis(d("analysis"))), ("categoryRules", parse_category_rules(d("categoryRules")))] {
        if let Some(v) = v {
            out[k] = v;
        }
    }
    infinity_to_null(&mut out);
    Ok(out)
}
