//! Eşitlenen verinin anlık görüntüsü: her tablo kimliğe göre satırlar (JSON), ayarlar anahtara göre.
//! Belge eklerinin yalnız bilgisi burada; içerikleri ayrı şifreli dosyalar olarak gider.

use std::collections::{BTreeMap, HashSet};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::data_store::DataStore;
use crate::db::Attachment;
use crate::{store, CoreResult};

pub const TABLES: [&str; 8] = ["categories", "accounts", "transactions", "recurring", "budgets", "goals", "tags", "attachments"];

pub type Rows = BTreeMap<String, Value>;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Snapshot {
    pub tables: BTreeMap<String, Rows>,
    pub settings: BTreeMap<String, Value>,
}

impl Snapshot {
    pub fn rows(&self, table: &str) -> Option<&Rows> {
        self.tables.get(table)
    }

    pub fn row(&self, table: &str, id: &str) -> Option<&Value> {
        self.tables.get(table).and_then(|t| t.get(id))
    }

    pub fn attachment_ids(&self) -> impl Iterator<Item = &String> {
        self.tables.get("attachments").into_iter().flat_map(|t| t.keys())
    }

    pub fn row_count(&self) -> usize {
        self.tables.values().map(|t| t.len()).sum()
    }
}

fn keyed<T: Serialize>(items: &[T], key: impl Fn(&T) -> &str) -> Rows {
    items.iter().map(|x| (key(x).to_string(), serde_json::to_value(x).expect("satır JSON"))).collect()
}

/// Bütün eklerin bilgisi (içeriksiz)
pub fn list_attachments(s: &mut dyn DataStore) -> CoreResult<Vec<Attachment>> {
    let mut out = Vec::new();
    for (tx, _) in s.attachment_counts()? {
        out.extend(s.list_attachments(&tx)?);
    }
    Ok(out)
}

pub fn read(s: &mut dyn DataStore) -> CoreResult<Snapshot> {
    let d = crate::backup::read_backup_data(s)?;
    let mut tables = BTreeMap::new();
    tables.insert("categories".into(), keyed(&d.categories, |x| &x.id));
    tables.insert("accounts".into(), keyed(&d.accounts, |x| &x.id));
    tables.insert("transactions".into(), keyed(&d.transactions, |x| &x.id));
    tables.insert("recurring".into(), keyed(&d.recurring, |x| &x.id));
    tables.insert("budgets".into(), keyed(&d.budgets, |x| &x.category_id));
    tables.insert("goals".into(), keyed(&d.goals, |x| &x.id));
    tables.insert("tags".into(), keyed(&d.tags, |x| &x.id));
    tables.insert("attachments".into(), keyed(&list_attachments(s)?, |x| &x.id));
    let settings = store::get_settings(s)?.into_iter().filter(|(k, _)| store::SETTING_KEYS.contains(&k.as_str())).collect();
    Ok(Snapshot { tables, settings })
}

/// `orig`'de olup bu sürümün yapısına girmeyen (gidiş-dönüşte kaybolan) alan var mı; boş değerli alanlar sayılmaz
fn lost_field(orig: &Value, back: &Value) -> Option<String> {
    match (orig, back) {
        (Value::Object(o), Value::Object(b)) => o.iter().find_map(|(k, v)| match b.get(k) {
            None if !v.is_null() => Some(k.clone()),
            Some(bv) => lost_field(v, bv).map(|f| format!("{k}.{f}")),
            None => None,
        }),
        (Value::Array(o), Value::Array(b)) => o.iter().zip(b).find_map(|(x, y)| lost_field(x, y)),
        _ => None,
    }
}

fn check_table<T: DeserializeOwned + Serialize>(snap: &Snapshot, table: &str) -> CoreResult<()> {
    for v in snap.rows(table).into_iter().flat_map(|t| t.values()) {
        let back = serde_json::to_value(serde_json::from_value::<T>(v.clone()).map_err(|e| format!("Eşitleme verisi okunamadı ({table}): {e}"))?)
            .map_err(|e| e.to_string())?;
        if let Some(f) = lost_field(v, &back) {
            return Err(format!(
                "Sunucudaki veride bu sürümün tanımadığı bir alan var ({table}.{f}); Finans'ın daha yeni bir sürümüyle eşitlenmiş. Veri kaybolmasın diye eşitleme durduruldu; uygulamayı güncelleyin."
            ));
        }
    }
    Ok(())
}

/// Daha yeni bir sürümün eklediği alanlar bu sürümde okunup yeniden yazılırken kaybolurdu: öyle bir alan varsa eşitleme durur
pub fn check_known_fields(snap: &Snapshot) -> CoreResult<()> {
    use crate::db::*;
    check_table::<Category>(snap, "categories")?;
    check_table::<Account>(snap, "accounts")?;
    check_table::<Transaction>(snap, "transactions")?;
    check_table::<RecurringItem>(snap, "recurring")?;
    check_table::<Budget>(snap, "budgets")?;
    check_table::<Goal>(snap, "goals")?;
    check_table::<Tag>(snap, "tags")?;
    check_table::<Attachment>(snap, "attachments")
}

fn typed<T: DeserializeOwned>(snap: &Snapshot, table: &str) -> CoreResult<Vec<T>> {
    snap.rows(table)
        .into_iter()
        .flat_map(|t| t.values())
        .map(|v| serde_json::from_value(v.clone()).map_err(|e| format!("Eşitleme verisi okunamadı ({table}): {e}")))
        .collect()
}

/// `local`'den `snap`'e geçer. Yalnız işlemler (ve ayarlar) değiştiyse yalnız onlar yazılır; değilse her şey yeniden
/// yazılır (`apply_rows`). Ekler ayrıca `apply_attachments` ile.
pub fn apply_changes(s: &mut dyn DataStore, local: &Snapshot, snap: &Snapshot) -> CoreResult<()> {
    let only_tx = TABLES.iter().filter(|t| !matches!(**t, "transactions" | "attachments")).all(|t| local.rows(t) == snap.rows(t));
    if !only_tx {
        return apply_rows(s, snap);
    }
    let empty = Rows::new();
    let (old, new) = (local.rows("transactions").unwrap_or(&empty), snap.rows("transactions").unwrap_or(&empty));
    let delete: Vec<String> = old.keys().filter(|k| !new.contains_key(*k)).cloned().collect();
    let mut upsert: Vec<crate::db::Transaction> = Vec::new();
    for (k, v) in new {
        if old.get(k) != Some(v) {
            upsert.push(serde_json::from_value(v.clone()).map_err(|e| format!("Eşitleme verisi okunamadı (transactions): {e}"))?);
        }
    }
    upsert.sort_by(|a, b| (&a.date, &a.created_at, &a.id).cmp(&(&b.date, &b.created_at, &b.id)));
    store::apply_synced_transactions(s, &upsert, &delete).map_err(|e| format!("Eşitlenen veri bu cihaza uygulanamadı: {e}"))?;
    for (k, v) in &snap.settings {
        if store::SETTING_KEYS.contains(&k.as_str()) && local.settings.get(k) != Some(v) {
            store::set_setting(s, k, v.clone())?;
        }
    }
    Ok(())
}

/// Anlık görüntünün kayıtlarını ve ayarlarını bu cihazın verisi yapar (tek veritabanı işleminde çağrılır);
/// ekleri ardından `apply_attachments` eşitler.
pub fn apply_rows(s: &mut dyn DataStore, snap: &Snapshot) -> CoreResult<()> {
    let mut transactions: Vec<crate::db::Transaction> = typed(snap, "transactions")?;
    // Tarih sırası: aynı gün içindeki sıra eklenme sırasına göre korunur
    transactions.sort_by(|a, b| (&a.date, &a.created_at, &a.id).cmp(&(&b.date, &b.created_at, &b.id)));
    let mut accounts: Vec<crate::db::Account> = typed(snap, "accounts")?;
    accounts.sort_by(|a, b| (a.sort_order, &a.id).cmp(&(b.sort_order, &b.id)));
    let mut recurring: Vec<crate::db::RecurringItem> = typed(snap, "recurring")?;
    recurring.sort_by(|a, b| (a.sort_order, &a.id).cmp(&(b.sort_order, &b.id)));
    let mut goals: Vec<crate::db::Goal> = typed(snap, "goals")?;
    goals.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
    store::restore_data(
        s,
        typed(snap, "categories")?,
        accounts,
        transactions,
        recurring,
        typed(snap, "budgets")?,
        goals,
        Some(typed(snap, "tags")?),
    )
    .map_err(|e| format!("Eşitlenen veri bu cihaza uygulanamadı: {e}"))?;
    for (k, v) in &snap.settings {
        if store::SETTING_KEYS.contains(&k.as_str()) {
            store::set_setting(s, k, v.clone())?;
        }
    }
    Ok(())
}

/// Ekler: listede olmayanlar silinir, yeniler `content`'ten eklenir. İçeriği (henüz) olmayan ya da işlemi bulunmayan
/// eklerin kimlikleri döner.
pub fn apply_attachments(s: &mut dyn DataStore, snap: &Snapshot, content: &dyn Fn(&str) -> Option<Vec<u8>>) -> CoreResult<HashSet<String>> {
    let wanted: Vec<Attachment> = typed(snap, "attachments")?;
    let wanted_ids: HashSet<&str> = wanted.iter().map(|a| a.id.as_str()).collect();
    let have: HashSet<String> = list_attachments(s)?.into_iter().map(|a| a.id).collect();
    for id in &have {
        if !wanted_ids.contains(id.as_str()) {
            s.delete_attachment(id)?;
        }
    }
    let mut missing = HashSet::new();
    for a in &wanted {
        if have.contains(&a.id) {
            continue;
        }
        match content(&a.id) {
            Some(data) if s.get_transaction(&a.transaction_id)?.is_some() => s.insert_attachment(a, &data)?,
            _ => {
                missing.insert(a.id.clone());
            }
        }
    }
    Ok(missing)
}
