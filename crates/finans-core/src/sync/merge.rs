//! Üç yönlü birleştirme: son ortak sürüm (taban), bu cihaz ve sunucu. Satır satır:
//! yalnız bir taraf değiştirdiyse o taraf, ikisi de aynı değiştirdiyse o; ikisi farklı değiştirdiyse bu cihazdaki tutulur.
//! Bir tarafta silinip öbüründe değiştirilen satır korunur (veri kaybolmasın). Son olarak silinmiş bir kayda bağlı
//! kalan satırların (ör. silinen hesaba eklenen işlem) bağlı olduğu kayıt geri getirilir. Adı benzersiz olması gereken
//! kayıtlar iki cihazda ayrı ayrı açıldıysa: aynı adlı kategori ve etiketler tek kayıtta birleşir, aynı adlı hesap
//! (paralar karışmasın) yeniden adlandırılır.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::snapshot::{Snapshot, TABLES};

#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    /// Bu cihazda değişecek satır/ayar sayısı
    pub local_changes: usize,
    /// Sunucuya gidecek değişiklik sayısı
    pub remote_changes: usize,
    /// İki cihazda farklı değiştirilmiş (bu cihazdaki tutulan) satır sayısı
    pub conflicts: usize,
}

fn pick<'a>(b: Option<&'a Value>, l: Option<&'a Value>, r: Option<&'a Value>, conflicts: &mut usize) -> Option<&'a Value> {
    if l == r || l == b {
        return r;
    }
    if r == b {
        return l;
    }
    *conflicts += 1;
    // İki cihaz aynı kimlikle ayrı ayrı ekledi (otomatik kayıt): sunucudaki kalır, öbür cihazda düzenlenmiş olabilir
    if b.is_none() && r.is_some() {
        return r;
    }
    // Silme ile değişiklik çakışırsa değişiklik kalır
    l.or(r)
}

/// Satırın bağlı olduğu kayıtlar: (tablo, kimlik)
fn parents(table: &str, id: &str, row: &Value) -> Vec<(&'static str, String)> {
    let s = |k: &str| row.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
    let list = |k: &str| -> Vec<String> {
        row.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
    };
    let mut out = Vec::new();
    match table {
        "transactions" => {
            out.extend(s("accountId").map(|v| ("accounts", v)));
            out.extend(s("toAccountId").map(|v| ("accounts", v)));
            out.extend(s("categoryId").map(|v| ("categories", v)));
            out.extend(list("tagIds").into_iter().map(|v| ("tags", v)));
        }
        "recurring" => {
            out.extend(s("accountId").map(|v| ("accounts", v)));
            out.extend(s("categoryId").map(|v| ("categories", v)));
        }
        "accounts" => out.extend(s("fundingIncomeId").map(|v| ("recurring", v))),
        "budgets" => out.push(("categories", id.to_string())),
        "goals" => out.extend(list("accountIds").into_iter().map(|v| ("accounts", v))),
        "attachments" => out.extend(s("transactionId").map(|v| ("transactions", v))),
        _ => {}
    }
    out
}

pub fn merge(b: &Snapshot, l: &Snapshot, r: &Snapshot) -> (Snapshot, MergeReport) {
    let mut out = Snapshot::default();
    let mut conflicts = 0;
    for table in TABLES {
        let keys: BTreeSet<&String> = [b, l, r].iter().filter_map(|s| s.rows(table)).flat_map(|t| t.keys()).collect();
        let rows = out.tables.entry(table.to_string()).or_default();
        for k in keys {
            if let Some(v) = pick(b.row(table, k), l.row(table, k), r.row(table, k), &mut conflicts) {
                rows.insert(k.clone(), v.clone());
            }
        }
    }
    let keys: BTreeSet<&String> = [b, l, r].iter().flat_map(|s| s.settings.keys()).collect();
    for k in keys {
        if let Some(v) = pick(b.settings.get(k), l.settings.get(k), r.settings.get(k), &mut conflicts) {
            out.settings.insert(k.clone(), v.clone());
        }
    }

    // Bağlı olduğu kayıt silinmiş satırlar: kayıt bu cihazdan, yoksa sunucudan, yoksa tabandan geri gelir
    loop {
        let mut missing: Vec<(&'static str, String)> = Vec::new();
        for (table, rows) in &out.tables {
            for (id, row) in rows {
                for (pt, pid) in parents(table, id, row) {
                    if out.row(pt, &pid).is_none() && !missing.contains(&(pt, pid.clone())) {
                        missing.push((pt, pid));
                    }
                }
            }
        }
        let mut changed = false;
        for (pt, pid) in missing {
            if let Some(v) = [l, r, b].iter().find_map(|s| s.row(pt, &pid)) {
                out.tables.entry(pt.to_string()).or_default().insert(pid, v.clone());
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    dedupe(&mut out, b, r);
    repair(&mut out);

    let report = MergeReport { local_changes: diff(l, &out), remote_changes: diff(r, &out), conflicts };
    (out, report)
}

/// Veritabanındaki benzersizlik kuralı: kategoride (ad, tür), hesapta ad, etikette küçük harfli ad (SQLite `lower`: yalnız ASCII)
fn unique_key(table: &str, row: &Value) -> Option<String> {
    let name = row.get("name").and_then(Value::as_str)?;
    match table {
        "categories" => Some(format!("{}\u{0}{name}", row.get("type").and_then(Value::as_str).unwrap_or(""))),
        "accounts" => Some(name.to_string()),
        "tags" => Some(name.to_ascii_lowercase()),
        _ => None,
    }
}

/// Satırlardaki ve ayarlardaki `from` kimliğini `to` yapar (kimlikler rastgele, başka değerle karışmaz)
fn replace_id(v: &mut Value, from: &str, to: &str) {
    match v {
        Value::String(s) if s == from => *s = to.to_string(),
        Value::Array(a) => {
            a.iter_mut().for_each(|x| replace_id(x, from, to));
            // Etiket listesinde aynı kimlik iki kez kalmasın
            let mut seen = BTreeSet::new();
            a.retain(|x| x.as_str().map_or(true, |s| seen.insert(s.to_string())));
        }
        Value::Object(o) => o.values_mut().for_each(|x| replace_id(x, from, to)),
        _ => {}
    }
}

fn dedupe(out: &mut Snapshot, b: &Snapshot, r: &Snapshot) {
    for table in ["categories", "tags", "accounts"] {
        let Some(rows) = out.tables.get(table) else { continue };
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (id, row) in rows {
            if let Some(k) = unique_key(table, row) {
                groups.entry(k).or_default().push(id.clone());
            }
        }
        for ids in groups.into_values().filter(|g| g.len() > 1) {
            // Kalan: sunucuda olan (öbür cihazlar onu tanıyor), sonra tabanda olan, sonra en küçük kimlik
            let rank = |id: &String| (r.row(table, id).is_none(), b.row(table, id).is_none(), id.clone());
            let keep = ids.iter().min_by_key(|id| rank(id)).unwrap().clone();
            for id in ids.into_iter().filter(|id| *id != keep) {
                if table == "accounts" {
                    // Hiç kullanılmamış eş hesap (ör. iki cihazın varsayılan hesabı) birleşir; kullanılanlar karışmasın diye yeniden adlandırılır
                    if !account_used(out, &id) && same_account(out, &id, &keep) {
                        out.tables.get_mut("accounts").unwrap().remove(&id);
                        // Ayarlarda (ör. borç planı) kalmış bağlantı kalana geçer
                        out.settings.values_mut().for_each(|v| replace_id(v, &id, &keep));
                    } else {
                        rename_account(out, &id);
                    }
                    continue;
                }
                out.tables.get_mut(table).unwrap().remove(&id);
                if table == "categories" {
                    // Bütçe kategori kimliğiyle tutulur: kalanın bütçesi yoksa taşınır
                    if let Some(budgets) = out.tables.get_mut("budgets") {
                        if let Some(mut bud) = budgets.remove(&id) {
                            if !budgets.contains_key(&keep) {
                                replace_id(&mut bud, &id, &keep);
                                budgets.insert(keep.clone(), bud);
                            }
                        }
                    }
                }
                for rows in out.tables.values_mut() {
                    rows.values_mut().for_each(|v| replace_id(v, &id, &keep));
                }
                out.settings.values_mut().for_each(|v| replace_id(v, &id, &keep));
            }
        }
    }
}

/// Hesaba bağlı işlem, düzenli kayıt ya da hedef var mı
fn account_used(out: &Snapshot, id: &str) -> bool {
    let refers = |v: &Value, k: &str| v.get(k).and_then(Value::as_str) == Some(id);
    let listed = |v: &Value, k: &str| v.get(k).and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(id)));
    out.rows("transactions").into_iter().flatten().any(|(_, v)| refers(v, "accountId") || refers(v, "toAccountId"))
        || out.rows("recurring").into_iter().flatten().any(|(_, v)| refers(v, "accountId"))
        || out.rows("goals").into_iter().flatten().any(|(_, v)| listed(v, "accountIds"))
}

/// Tür, birim ve açılış bakiyesi aynı mı (birleşince bilgi kaybolmasın)
fn same_account(out: &Snapshot, a: &str, b: &str) -> bool {
    let (Some(x), Some(y)) = (out.row("accounts", a), out.row("accounts", b)) else { return false };
    ["kind", "currency", "openingBalance"].iter().all(|k| x.get(*k) == y.get(*k))
}

/// Aynı adlı ikinci hesap "Ad (2)" olur (boş ad bulunana kadar)
fn rename_account(out: &mut Snapshot, id: &str) {
    let rows = out.tables.get_mut("accounts").unwrap();
    let taken: BTreeSet<String> = rows.values().filter_map(|v| v.get("name").and_then(Value::as_str)).map(str::to_string).collect();
    let row = rows.get_mut(id).unwrap();
    let name = row.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    // Ad en çok 60 karakter: ek sığsın diye kısaltılır
    let base: String = name.chars().take(54).collect();
    let new = (2..).map(|n| format!("{} ({n})", base.trim_end())).find(|n| !taken.contains(n)).unwrap();
    row["name"] = Value::String(new);
}

/// Her cihazda ayrı ayrı geçerli olan değişiklikler birlikte geçersiz olabilir (ör. bir cihazda kategorinin türü
/// değişti, öbüründe o kategoriyle işlem girildi). Geri yükleme bunları reddetmesin diye birleşen veri onarılır.
fn repair(out: &mut Snapshot) {
    let kind_of = |table: &str, id: &str, field: &str| -> Option<String> {
        out.row(table, id).and_then(|v| v.get(field)).and_then(Value::as_str).map(str::to_string)
    };
    let mut fixes: Vec<(String, &'static str, Value)> = Vec::new();
    for (id, t) in out.rows("transactions").into_iter().flatten() {
        let kind = t.get("type").and_then(Value::as_str).unwrap_or("");
        if let Some(cat) = t.get("categoryId").and_then(Value::as_str) {
            if kind == "transfer" || kind_of("categories", cat, "type").is_some_and(|k| k != kind) {
                fixes.push((id.clone(), "categoryId", Value::Null));
            }
        }
        let card = t.get("accountId").and_then(Value::as_str).and_then(|a| kind_of("accounts", a, "kind")).is_some_and(|k| k == "credit_card");
        if t.get("installments").and_then(Value::as_i64).unwrap_or(1) > 1 && !(kind == "expense" && card) {
            fixes.push((id.clone(), "installments", Value::from(1)));
        }
    }
    let rows = out.tables.entry("transactions".into()).or_default();
    for (id, field, v) in fixes {
        if let Some(row) = rows.get_mut(&id) {
            row[field] = v;
        }
    }
}

/// İki anlık görüntü arasında farklı satır ve ayar sayısı
pub fn diff(a: &Snapshot, b: &Snapshot) -> usize {
    let mut n = 0;
    for table in TABLES {
        let keys: BTreeSet<&String> = [a, b].iter().filter_map(|s| s.rows(table)).flat_map(|t| t.keys()).collect();
        n += keys.into_iter().filter(|k| a.row(table, k) != b.row(table, k)).count();
    }
    let keys: BTreeSet<&String> = a.settings.keys().chain(b.settings.keys()).collect();
    n + keys.into_iter().filter(|k| a.settings.get(*k) != b.settings.get(*k)).count()
}
