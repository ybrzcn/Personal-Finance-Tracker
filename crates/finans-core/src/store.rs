//! Veri işlemleri: doğrulama ve iş kuralları. SQL içermez; `DataStore` (SQLite ya da Postgres) üzerinden çalışır.
//! Hata mesajları kullanıcıya gösterilir.

use std::collections::HashSet;

use crate::data_store::DataStore;
use crate::db::{self, Account, AccountInput, Budget, Category, CategoryInput, Goal, GoalInput, RecurringItem, Tag, TagInput, Transaction, TransactionInput};
use crate::fx::{self, amount as fxa};
use crate::order;
use crate::rows::{AccountMeta, AccountRow, GoalRow, RecurringRow, TagRow, TransactionRow};
use crate::CoreResult;

// ---------------------------------------------------------------------------
// Doğrulama
// ---------------------------------------------------------------------------

fn validate_category_kind(kind: &str) -> CoreResult<()> {
    match kind {
        "income" | "expense" => Ok(()),
        _ => Err("Geçersiz kategori türü (income/expense olmalı).".into()),
    }
}

fn validate_tx_kind(kind: &str) -> CoreResult<()> {
    match kind {
        "income" | "expense" | "transfer" => Ok(()),
        _ => Err("Geçersiz işlem türü (income/expense/transfer olmalı).".into()),
    }
}

/// Gelirin bütçe ayı: yalnız gelirde ve YYYY-AA biçiminde geçerli; diğer türlerde atılır.
fn clean_budget_month(kind: &str, month: &Option<String>) -> CoreResult<Option<String>> {
    match month.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) if kind == "income" => {
            let ok = m.len() == 7 && m.as_bytes()[4] == b'-' && m[5..7].parse::<u32>().is_ok_and(|x| (1..=12).contains(&x));
            if ok {
                Ok(Some(m.to_string()))
            } else {
                Err(format!("Geçersiz ay: {m} (YYYY-AA bekleniyor)."))
            }
        }
        _ => Ok(None),
    }
}

fn validate_date(date: &str) -> CoreResult<()> {
    let b = date.as_bytes();
    let shape_ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if shape_ok {
        let year: i32 = date[0..4].parse().unwrap_or(0);
        let month: u32 = date[5..7].parse().unwrap_or(0);
        let day: u32 = date[8..10].parse().unwrap_or(0);
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let days = match month {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 if leap => 29,
            2 => 28,
            _ => 0,
        };
        if year > 0 && day >= 1 && day <= days {
            return Ok(());
        }
    }
    Err(format!("Geçersiz tarih: {date} (YYYY-AA-GG bekleniyor)."))
}

fn to_cents(amount: f64) -> CoreResult<i64> {
    if !amount.is_finite() || amount <= 0.0 {
        return Err("Tutar sıfırdan büyük olmalıdır.".into());
    }
    if amount > 1e13 {
        return Err("Tutar çok büyük.".into());
    }
    Ok((amount * 100.0).round() as i64)
}

fn to_signed_cents(amount: f64) -> CoreResult<i64> {
    if !amount.is_finite() || amount.abs() > 1e13 {
        return Err("Geçersiz tutar.".into());
    }
    Ok((amount * 100.0).round() as i64)
}

fn clean_name(name: &str, label: &str) -> CoreResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(format!("{label} boş olamaz."));
    }
    if name.chars().count() > 60 {
        return Err(format!("{label} en fazla 60 karakter olabilir."));
    }
    Ok(name.to_string())
}

fn clean_color(color: &str) -> String {
    let c = color.trim();
    if c.is_empty() {
        "#64748b".into()
    } else {
        c.to_string()
    }
}


fn day_of_month(v: Option<i64>, label: &str) -> CoreResult<i64> {
    match v {
        Some(d) if (1..=31).contains(&d) => Ok(d),
        _ => Err(format!("{label} 1 ile 31 arasında olmalıdır.")),
    }
}

fn rate_bp(v: Option<f64>, label: &str) -> CoreResult<Option<i64>> {
    match v {
        None => Ok(None),
        Some(r) if r.is_finite() && (0.0..=100.0).contains(&r) => Ok(Some((r * 100.0).round() as i64)),
        Some(_) => Err(format!("{label} 0 ile 100 arasında olmalıdır.")),
    }
}

/// Arayüzdeki `normalizeAccount` ile aynı kurallar.
pub fn clean_account(a: &Account) -> CoreResult<AccountRow> {
    let name = clean_name(&a.name, "Hesap adı")?;
    let currency = match a.currency.trim() {
        "" => fx::TRY.to_string(),
        c => c.to_string(),
    };
    let unit = fx::unit_of(&currency).ok_or_else(|| format!("Bilinmeyen para birimi: {currency}"))?;
    let foreign = currency != fx::TRY;
    if fx::is_fund(&currency) && a.kind != "bank" {
        return Err("Fon hesabı yalnız banka türünde olabilir.".into());
    }
    if foreign && !matches!(a.kind.as_str(), "bank" | "cash") {
        return Err("Kredi kartı ve kredi hesapları yalnızca TL olabilir.".into());
    }
    if !matches!(a.kind.as_str(), "bank" | "cash" | "credit_card" | "loan") {
        return Err("Geçersiz hesap türü.".into());
    }
    validate_date(&a.opening_date)?;
    let card = a.kind == "credit_card";
    let cash = a.kind == "cash";
    let loan = a.kind == "loan";
    let (term_months, first_due_date, installment_cents, tax_rate_bp) = if loan {
        let term = match a.term_months {
            Some(t) if (1..=600).contains(&t) => t,
            _ => return Err("Vade 1 ile 600 ay arasında olmalıdır.".into()),
        };
        let first = a.first_due_date.clone().unwrap_or_default();
        validate_date(&first).map_err(|_| "Geçerli bir ilk taksit tarihi girin.".to_string())?;
        let inst = match a.installment_amount {
            Some(v) if v.is_finite() && v > 0.0 => Some((v * 100.0).round() as i64),
            Some(_) => return Err("Taksit tutarı sıfırdan büyük olmalıdır.".into()),
            None => None,
        };
        (Some(term), Some(first), inst, rate_bp(Some(a.tax_rate.unwrap_or(30.0)), "Vergi oranı")?)
    } else {
        (None, None, None, None)
    };
    let limit_cents = match a.credit_limit {
        Some(l) if !cash && !loan && !foreign => {
            if !l.is_finite() || l < 0.0 {
                return Err("Limit negatif olamaz.".into());
            }
            Some((l * 100.0).round() as i64)
        }
        _ => None,
    };
    let opening_cost_cents = match a.opening_cost.flatten() {
        None => None,
        Some(_) if !foreign => return Err("Açılış maliyeti yalnız döviz/altın hesaplarında girilebilir.".into()),
        Some(_) if a.opening_balance <= 0.0 => {
            return Err("Açılış maliyeti için açılış bakiyesi sıfırdan büyük olmalıdır.".into())
        }
        Some(v) if !v.is_finite() || v <= 0.0 => return Err("Açılış maliyeti sıfırdan büyük olmalıdır.".into()),
        Some(v) => Some(to_cents(v)?),
    };
    Ok(AccountRow {
        name,
        kind: a.kind.clone(),
        color: clean_color(&a.color),
        opening_cents: if foreign { fxa::signed_value_to_minor(a.opening_balance, unit)? } else { to_signed_cents(a.opening_balance)? },
        opening_date: a.opening_date.clone(),
        limit_cents,
        rate_bp: if cash || foreign { None } else { rate_bp(a.interest_rate, "Faiz oranı")? },
        statement_day: if card { Some(day_of_month(a.statement_day, "Kesim günü")?) } else { None },
        due_day: if card { Some(day_of_month(a.due_day, "Son ödeme günü")?) } else { None },
        min_rate_bp: if card {
            rate_bp(Some(a.min_payment_rate.unwrap_or(20.0)), "Asgari ödeme oranı")?
        } else {
            None
        },
        sort_order: a.sort_order,
        archived: a.archived,
        term_months,
        first_due_date,
        installment_cents,
        tax_rate_bp,
        opening_period_cents: match a.opening_period_spending {
            Some(v) if card && v != 0.0 => Some(to_signed_cents(v)?),
            _ => None,
        },
        opening_installments: if card { clean_opening_installments(&a.opening_installments)? } else { "[]".into() },
        currency,
        opening_cost_cents,
        funding_income_id: if card || loan {
            a.funding_income_id.clone().filter(|s| !s.is_empty())
        } else {
            None
        },
    })
}

fn clean_opening_installments(items: &[db::OpeningInstallment]) -> CoreResult<String> {
    let mut out = Vec::with_capacity(items.len());
    for (i, it) in items.iter().enumerate() {
        if !it.amount.is_finite() || it.amount <= 0.0 {
            return Err(format!("{}. taksit: aylık tutar sıfırdan büyük olmalıdır.", i + 1));
        }
        if !(1..=36).contains(&it.remaining) {
            return Err(format!("{}. taksit: kalan taksit 1 ile 36 arasında olmalıdır.", i + 1));
        }
        out.push(db::OpeningInstallment {
            description: it.description.trim().chars().take(100).collect(),
            amount: (it.amount * 100.0).round() / 100.0,
            remaining: it.remaining,
        });
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

/// Seçilen kategori mevcut olmalı ve işlem türüyle uyuşmalı.
fn check_category(s: &mut dyn DataStore, category_id: &Option<String>, kind: &str) -> CoreResult<()> {
    let Some(id) = category_id else { return Ok(()) };
    match s.get_category(id)? {
        None => Err("Seçilen kategori bulunamadı.".into()),
        Some(c) if c.kind != kind => Err("Kategori türü ile işlem türü uyuşmuyor.".into()),
        Some(_) => Ok(()),
    }
}

/// Hesabın türü, arşiv durumu ve para birimi.
fn account_meta(s: &mut dyn DataStore, id: &str) -> CoreResult<AccountMeta> {
    s.account_meta(id)?.ok_or_else(|| "Seçilen hesap bulunamadı.".to_string())
}

/// Geri yüklemede `createdAt`: yalnız geçerli `YYYY-MM-DDTHH:MM:SS[.f…]Z` (UTC) korunur; diğerleri "şimdi" olur
/// (Postgres geçersiz zamanı reddeder, SQLite'la aynı sonuç için önceden elenir).
fn clean_created_at(v: &str) -> Option<String> {
    let b = v.as_bytes();
    if !v.is_ascii() || b.len() < 20 || b[10] != b'T' || b[b.len() - 1] != b'Z' || validate_date(&v[0..10]).is_err() {
        return None;
    }
    let num = |i: usize| -> Option<u32> { v.get(i..i + 2).filter(|s| s.bytes().all(|c| c.is_ascii_digit()))?.parse().ok() };
    let time_ok = b[13] == b':'
        && b[16] == b':'
        && num(11).is_some_and(|h| h < 24)
        && num(14).is_some_and(|m| m < 60)
        && num(17).is_some_and(|s| s < 60);
    // Saniyeden sonra ya hiçbir şey ya da "." ve 1-9 rakam
    let frac = &v[19..v.len() - 1];
    let frac_ok = frac.is_empty()
        || (frac.len() >= 2 && frac.len() <= 10 && frac.starts_with('.') && frac[1..].bytes().all(|c| c.is_ascii_digit()));
    (time_ok && frac_ok).then(|| v.to_string())
}

/// Arayüzdeki `validateTransaction` ile aynı kurallar.
#[allow(clippy::too_many_arguments)]
pub fn check_transaction(
    s: &mut dyn DataStore,
    kind: &str,
    account_id: &str,
    to_account_id: Option<&str>,
    category_id: &Option<String>,
    installments: i64,
    is_new: bool,
) -> CoreResult<()> {
    validate_tx_kind(kind)?;
    let archived_err = || Err("Arşivlenmiş hesaba yeni işlem eklenemez.".to_string());
    let AccountMeta { kind: acc_kind, archived, currency: acc_currency } = account_meta(s, account_id)?;
    if kind != "transfer" && fx::is_fund(&acc_currency) {
        return Err("Fon hesabında gelir/gider olmaz; alım-satım transferle yapılır.".into());
    }
    if is_new && archived {
        return archived_err();
    }
    if kind == "transfer" {
        let Some(to) = to_account_id else {
            return Err("Transfer için hedef hesap seçilmelidir.".into());
        };
        if to == account_id {
            return Err("Kaynak ve hedef hesap aynı olamaz.".into());
        }
        let AccountMeta { kind: to_kind, archived: to_archived, .. } = account_meta(s, to)?;
        // Arşivlenmiş kart/kredinin kalan borcu yine de ödenebilir
        let pays_debt = to_kind == "credit_card" || to_kind == "loan";
        if is_new && to_archived && !pays_debt {
            return archived_err();
        }
        if category_id.is_some() {
            return Err("Transferlere kategori atanamaz.".into());
        }
    } else {
        if to_account_id.is_some() {
            return Err("Hedef hesap yalnızca transferde kullanılır.".into());
        }
        check_category(s, category_id, kind)?;
    }
    if !(1..=36).contains(&installments) {
        return Err("Taksit sayısı 1 ile 36 arasında olmalıdır.".into());
    }
    if installments > 1 && !(kind == "expense" && acc_kind == "credit_card") {
        return Err("Taksit yalnızca kredi kartı harcamalarında kullanılabilir.".into());
    }
    Ok(())
}

fn get_category(s: &mut dyn DataStore, id: &str) -> CoreResult<Category> {
    s.get_category(id)?.ok_or_else(|| "Kategori bulunamadı.".to_string())
}

fn get_account(s: &mut dyn DataStore, id: &str) -> CoreResult<Account> {
    s.get_account(id)?.ok_or_else(|| "Hesap bulunamadı.".to_string())
}

fn get_transaction(s: &mut dyn DataStore, id: &str) -> CoreResult<Transaction> {
    let mut t = s.get_transaction(id)?.ok_or_else(|| "İşlem bulunamadı.".to_string())?;
    t.tag_ids = s.tags_of_tx(id)?;
    Ok(t)
}

fn get_recurring(s: &mut dyn DataStore, id: &str) -> CoreResult<RecurringItem> {
    s.get_recurring(id)?.ok_or_else(|| "Kayıt bulunamadı.".to_string())
}

/// Yeni kullanıcının başlangıç verisi: varsayılan kategoriler ve "Genel Hesap" (SQLite'ta geçişlerin oluşturduğunun aynısı).
/// Postgres arka ucu kullanır; `today` YYYY-AA-GG.
pub fn seed_new_user(s: &mut dyn DataStore, today: &str) -> CoreResult<()> {
    for (name, kind, color) in db::DEFAULT_CATEGORY_SEED {
        s.insert_category(&db::new_id(), name, kind, color)?;
    }
    let account = Account {
        id: String::new(),
        name: db::DEFAULT_ACCOUNT_NAME.into(),
        kind: "bank".into(),
        color: "#6366f1".into(),
        opening_balance: 0.0,
        opening_date: today.into(),
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
        currency: fx::TRY.into(),
        opening_cost: None,
    };
    s.insert_account(&db::new_id(), &clean_account(&account)?)
}

/// "Verileri sıfırla" sonrası başlangıç verisi: varsayılan kategoriler ve boş "Genel Hesap" (yeni kimliklerle)
#[derive(Debug, Clone, serde::Serialize)]
pub struct ResetSeed {
    pub categories: Vec<Category>,
    pub accounts: Vec<Account>,
}

pub fn reset_seed(today: &str) -> ResetSeed {
    ResetSeed {
        categories: db::DEFAULT_CATEGORY_SEED
            .iter()
            .map(|(name, kind, color)| Category { id: db::new_id(), name: name.to_string(), kind: kind.to_string(), color: color.to_string() })
            .collect(),
        accounts: vec![crate::backup::make_default_account(today)],
    }
}

// Kategoriler

pub fn list_categories(s: &mut dyn DataStore) -> CoreResult<Vec<Category>> {
    let mut xs = s.list_categories()?;
    order::sort_categories(&mut xs);
    Ok(xs)
}

pub fn create_category(s: &mut dyn DataStore, input: CategoryInput) -> CoreResult<Category> {
    validate_category_kind(&input.kind)?;
    let name = clean_name(&input.name, "Kategori adı")?;
    let id = db::new_id();
    s.insert_category(&id, &name, &input.kind, &clean_color(&input.color))?;
    get_category(s, &id)
}

pub fn update_category(s: &mut dyn DataStore, category: Category) -> CoreResult<Category> {
    validate_category_kind(&category.kind)?;
    let name = clean_name(&category.name, "Kategori adı")?;
    let (mismatched, recurring_mismatch, budgets) = s.category_conflicts(&category.id, &category.kind)?;
    if mismatched > 0 {
        return Err(format!("Bu kategori {mismatched} işlemde kullanıldığı için türü değiştirilemez."));
    }
    if recurring_mismatch > 0 {
        return Err(format!("Bu kategori {recurring_mismatch} düzenli kayıtta kullanıldığı için türü değiştirilemez."));
    }
    if category.kind != "expense" && budgets > 0 {
        return Err("Bu kategorinin bütçe limiti olduğu için türü değiştirilemez; önce limiti kaldırın.".into());
    }
    if s.update_category(&category.id, &name, &category.kind, &clean_color(&category.color))? == 0 {
        return Err("Kategori bulunamadı.".into());
    }
    get_category(s, &category.id)
}

/// Kategori silinince ona bağlı işlemler silinmez, "Kategorisiz" kalır.
pub fn delete_category(s: &mut dyn DataStore, id: &str) -> CoreResult<()> {
    s.delete_category(id)
}

// Hesaplar

pub fn list_accounts(s: &mut dyn DataStore) -> CoreResult<Vec<Account>> {
    let mut xs = s.list_accounts()?;
    order::sort_accounts(&mut xs);
    Ok(xs)
}

pub fn create_account(s: &mut dyn DataStore, input: AccountInput) -> CoreResult<Account> {
    let row = clean_account(&input.with_id(String::new()))?;
    let id = db::new_id();
    s.insert_account(&id, &row)?;
    get_account(s, &id)
}

pub fn update_account(s: &mut dyn DataStore, mut account: Account) -> CoreResult<Account> {
    // Alanı göndermeyen (eski) istemci açılış maliyetini silmesin
    if account.opening_cost.is_none() {
        account.opening_cost = Some(get_account(s, &account.id)?.opening_cost.flatten());
    }
    let row = clean_account(&account)?;
    let old = account_meta(s, &account.id).map_err(|_| "Hesap bulunamadı.".to_string())?;
    let used = s.account_usage(&account.id)? > 0;
    if old.kind != row.kind && used {
        return Err("Bu hesapta işlem bulunduğu için türü değiştirilemez.".into());
    }
    if row.kind != "bank" && row.kind != "cash" {
        if let Some((_, gname)) = s.goal_of_account(&account.id)? {
            return Err(format!("Bu hesap '{gname}' hedefine bağlı olduğu için kart ya da krediye çevrilemez."));
        }
    }
    if old.currency != row.currency && used {
        return Err("Bu hesapta işlem bulunduğu için para birimi değiştirilemez.".into());
    }
    if old.currency != row.currency && fx::is_fund(&row.currency) && s.list_recurring()?.iter().any(|r| r.account_id.as_deref() == Some(account.id.as_str())) {
        return Err("Bu hesaba bağlı düzenli gelir/gider olduğu için fon hesabına çevrilemez.".into());
    }
    s.update_account(&account.id, &row)?;
    get_account(s, &account.id)
}

/// İşlemi olan hesap silinemez; yalnızca arşivlenebilir.
pub fn delete_account(s: &mut dyn DataStore, id: &str) -> CoreResult<()> {
    let used = s.account_usage(id)?;
    if used > 0 {
        return Err(format!("Bu hesapta {used} işlem var; silmek yerine arşivleyin."));
    }
    s.delete_account(id)
}

// İşlemler

pub fn list_transactions(s: &mut dyn DataStore) -> CoreResult<Vec<Transaction>> {
    let mut txs = s.list_transactions()?;
    let mut by_tx: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for (tx, tag) in s.list_tx_tags()? {
        by_tx.entry(tx).or_default().push(tag);
    }
    for t in &mut txs {
        if let Some(v) = by_tx.remove(&t.id) {
            t.tag_ids = v;
        }
    }
    order::sort_transactions(&mut txs);
    Ok(txs)
}

/// TL dışı hesap tarafı: miktar ve kur zorunlu → (en küçük birim, kur). TL tarafı: gönderilen değerler yok sayılır.
fn fx_side(currency: &str, amount: Option<f64>, rate: Option<f64>, label: &str) -> CoreResult<Option<(i64, i64, fx::Unit)>> {
    if currency == fx::TRY {
        return Ok(None);
    }
    let unit = fx::unit_or_try(Some(currency));
    let amount = amount.ok_or_else(|| format!("{label}: miktar girin."))?;
    let rate = rate.ok_or_else(|| format!("{label}: kur girin."))?;
    Ok(Some((fxa::value_to_minor(amount, unit)?, fxa::rate_from_f64(rate)?, unit)))
}

struct FxAmounts {
    amount_cents: i64,
    from: Option<(i64, i64)>,
    to: Option<(i64, i64)>,
}

/// TL karşılığı: TL dışı kaynaktan, o yoksa TL dışı hedeften hesaplanır; ikisi de TL ise girilen tutardır.
fn fx_amounts(s: &mut dyn DataStore, t: &TransactionInput) -> CoreResult<FxAmounts> {
    let from_cur = account_meta(s, &t.account_id)?.currency;
    let transfer = t.kind == "transfer";
    let from = fx_side(&from_cur, t.orig_amount, t.fx_rate, if transfer { "Kaynak hesap" } else { "Hesap" })?;
    let to = match (&t.to_account_id, transfer) {
        (Some(id), true) => {
            let cur = account_meta(s, id)?.currency;
            fx_side(&cur, t.to_orig_amount, t.to_fx_rate, "Hedef hesap")?
        }
        _ => None,
    };
    let amount_cents = match (from, to) {
        (Some((m, r, u)), _) | (None, Some((m, r, u))) => fxa::tl_cents(m, r, u)?,
        (None, None) => to_cents(t.amount)?,
    };
    Ok(FxAmounts { amount_cents, from: from.map(|(m, r, _)| (m, r)), to: to.map(|(m, r, _)| (m, r)) })
}

fn transaction_row(
    s: &mut dyn DataStore,
    id: String,
    t: &TransactionInput,
    is_new: bool,
    created_at: Option<String>,
) -> CoreResult<TransactionRow> {
    validate_date(&t.date)?;
    check_transaction(s, &t.kind, &t.account_id, t.to_account_id.as_deref(), &t.category_id, t.installments, is_new)?;
    let fx = fx_amounts(s, t)?;
    Ok(TransactionRow {
        id,
        amount_cents: fx.amount_cents,
        kind: t.kind.clone(),
        account_id: t.account_id.clone(),
        to_account_id: t.to_account_id.clone(),
        category_id: t.category_id.clone(),
        date: t.date.clone(),
        description: t.description.trim().to_string(),
        installments: t.installments,
        budget_month: clean_budget_month(&t.kind, &t.budget_month)?,
        created_at,
        orig_amount: fx.from.map(|p| p.0),
        fx_rate: fx.from.map(|p| p.1),
        to_orig_amount: fx.to.map(|p| p.0),
        to_fx_rate: fx.to.map(|p| p.1),
    })
}

fn as_input(t: &Transaction, category_id: Option<String>) -> TransactionInput {
    TransactionInput {
        amount: t.amount,
        kind: t.kind.clone(),
        account_id: t.account_id.clone(),
        to_account_id: t.to_account_id.clone(),
        category_id,
        date: t.date.clone(),
        description: t.description.clone(),
        installments: t.installments,
        budget_month: t.budget_month.clone(),
        orig_amount: t.orig_amount,
        fx_rate: t.fx_rate,
        to_orig_amount: t.to_orig_amount,
        to_fx_rate: t.to_fx_rate,
        tag_ids: Some(t.tag_ids.clone()),
    }
}

pub fn create_transaction(s: &mut dyn DataStore, input: TransactionInput) -> CoreResult<Transaction> {
    // Arşivli etiket de kabul edilir: silinen işlemi "Geri al" etiketleriyle yeniden ekler (seçiciler arşivliyi göstermez)
    let ids = input.tag_ids.as_deref().unwrap_or_default();
    let tags = clean_tx_tags(s, ids, ids)?;
    let row = transaction_row(s, db::new_id(), &input, true, None)?;
    s.insert_transaction(&row)?;
    s.set_tx_tags(&row.id, &tags)?;
    get_transaction(s, &row.id)
}

/// `tags`: Some = listeyi bununla değiştir; None = mevcut etiketleri koru
pub fn update_transaction_with(s: &mut dyn DataStore, transaction: Transaction, tags: Option<Vec<String>>) -> CoreResult<Transaction> {
    let input = as_input(&transaction, transaction.category_id.clone());
    let row = transaction_row(s, transaction.id.clone(), &input, false, None)?;
    if s.update_transaction(&row)? == 0 {
        return Err("İşlem bulunamadı.".into());
    }
    let prev = s.tags_of_tx(&transaction.id)?;
    let wanted = tags.unwrap_or_else(|| prev.clone());
    let clean = clean_tx_tags(s, &wanted, &prev)?;
    s.set_tx_tags(&transaction.id, &clean)?;
    get_transaction(s, &transaction.id)
}

pub fn update_transaction(s: &mut dyn DataStore, transaction: Transaction) -> CoreResult<Transaction> {
    let tags = Some(transaction.tag_ids.clone());
    update_transaction_with(s, transaction, tags)
}

pub fn delete_transaction(s: &mut dyn DataStore, id: &str) -> CoreResult<()> {
    s.delete_transaction(id)
}

// Düzenli gelir / giderler ve bütçeler

fn clean_recurring(s: &mut dyn DataStore, r: &RecurringItem) -> CoreResult<RecurringRow> {
    validate_category_kind(&r.kind)?;
    let name = clean_name(&r.name, "Ad")?;
    let day = day_of_month(Some(r.day), "Gün")?;
    let currency = match &r.account_id {
        Some(id) => account_meta(s, id)?.currency,
        None => fx::TRY.to_string(),
    };
    if fx::is_fund(&currency) {
        return Err("Fon hesabına düzenli gelir/gider bağlanamaz.".into());
    }
    let orig_amount = if currency == fx::TRY {
        None
    } else {
        let v = r.orig_amount.ok_or("Döviz/altın hesabındaki düzenli kayıt için miktar girin.")?;
        Some(fxa::value_to_minor(v, fx::unit_or_try(Some(&currency)))?)
    };
    check_category(s, &r.category_id, &r.kind)?;
    // Buradan sonrası bugünkü clean_recurring ile birebir aynı (history/exceptions/weekend_shift/start_date doğrulaması)
    let mut history = Vec::with_capacity(r.history.len());
    for h in &r.history {
        validate_date(&h.from)?;
        to_cents(h.amount).map_err(|e| format!("Tutar değişikliği ({}): {e}", h.from))?;
        history.push(db::AmountChange { from: h.from.clone(), amount: (h.amount * 100.0).round() / 100.0 });
    }
    history.sort_by(|a, b| a.from.cmp(&b.from));
    history.dedup_by(|b, a| a.from == b.from);
    let mut exceptions = Vec::with_capacity(r.exceptions.len());
    for e in &r.exceptions {
        let b = e.month.as_bytes();
        let month_ok = b.len() == 7 && b[4] == b'-' && e.month[5..7].parse::<u32>().is_ok_and(|m| (1..=12).contains(&m));
        if !month_ok {
            return Err(format!("Geçersiz ay: {} (YYYY-AA bekleniyor).", e.month));
        }
        if !e.amount.is_finite() || e.amount < 0.0 {
            return Err(format!("{} için tutar negatif olamaz.", e.month));
        }
        exceptions.push(db::MonthException {
            month: e.month.clone(),
            amount: (e.amount * 100.0).round() / 100.0,
            note: e.note.trim().chars().take(60).collect(),
        });
    }
    exceptions.sort_by(|a, b| a.month.cmp(&b.month));
    exceptions.dedup_by(|b, a| a.month == b.month);
    let weekend_shift = match r.weekend_shift.as_str() {
        "none" | "before" | "after" => r.weekend_shift.clone(),
        "" => "none".into(),
        other => return Err(format!("Geçersiz hafta sonu ayarı: {other}")),
    };
    let start_date = r.start_date.clone().filter(|d| !d.trim().is_empty());
    if let Some(d) = &start_date {
        validate_date(d)?;
    }
    Ok(RecurringRow {
        weekend_shift,
        start_date,
        covers_previous_month: r.kind == "income" && r.covers_previous_month,
        exceptions: serde_json::to_string(&exceptions).map_err(|e| e.to_string())?,
        history: serde_json::to_string(&history).map_err(|e| e.to_string())?,
        name,
        kind: r.kind.clone(),
        cents: to_cents(r.amount)?,
        day,
        account_id: r.account_id.clone(),
        category_id: r.category_id.clone(),
        active: r.active,
        sort_order: r.sort_order,
        orig_amount,
    })
}

pub fn list_recurring(s: &mut dyn DataStore) -> CoreResult<Vec<RecurringItem>> {
    let mut xs = s.list_recurring()?;
    order::sort_recurring(&mut xs);
    Ok(xs)
}

pub fn create_recurring(s: &mut dyn DataStore, item: RecurringItem) -> CoreResult<RecurringItem> {
    let row = clean_recurring(s, &item)?;
    let id = db::new_id();
    s.insert_recurring(&id, &row)?;
    get_recurring(s, &id)
}

pub fn update_recurring(s: &mut dyn DataStore, item: RecurringItem) -> CoreResult<RecurringItem> {
    let r = clean_recurring(s, &item)?;
    if s.update_recurring(&item.id, &r)? == 0 {
        return Err("Kayıt bulunamadı.".into());
    }
    if r.kind != "income" {
        s.clear_funding_income(&item.id)?;
    }
    get_recurring(s, &item.id)
}

/// Ay istisnası isteği: `amount` None ise o ayın istisnası kalkar
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionRequest {
    pub month: String,
    pub amount: Option<f64>,
    #[serde(default)]
    pub note: String,
}

/// `month` için istisnayı ekler ya da değiştirir (aya göre sıralı); `amount` None ise kaldırır
pub fn with_exception(exceptions: &[db::MonthException], month: &str, amount: Option<f64>, note: &str) -> Vec<db::MonthException> {
    let mut out: Vec<db::MonthException> = exceptions.iter().filter(|e| e.month != month).cloned().collect();
    if let Some(amount) = amount {
        out.push(db::MonthException { month: month.to_string(), amount, note: note.to_string() });
        out.sort_by(|a, b| a.month.cmp(&b.month));
    }
    out
}

/// Ödeme Takvimi'ndeki "bu ay yatmayacak" ve geri alma. Kayıt yoksa None.
pub fn set_recurring_exception(s: &mut dyn DataStore, id: &str, req: ExceptionRequest) -> CoreResult<Option<RecurringItem>> {
    if !crate::budget::valid_month(&req.month) {
        return Err("Geçersiz ay.".into());
    }
    let Some(mut item) = s.get_recurring(id)? else { return Ok(None) };
    item.exceptions = with_exception(&item.exceptions, &req.month, req.amount, &req.note);
    update_recurring(s, item).map(Some)
}

pub fn delete_recurring(s: &mut dyn DataStore, id: &str) -> CoreResult<()> {
    s.clear_funding_income(id)?;
    s.delete_recurring(id)
}

pub fn list_budgets(s: &mut dyn DataStore) -> CoreResult<Vec<Budget>> {
    s.list_budgets()
}

fn upsert_budget(s: &mut dyn DataStore, category_id: &str, amount: Option<f64>) -> CoreResult<()> {
    match amount {
        Some(a) if a > 0.0 => {
            match s.get_category(category_id)?.map(|c| c.kind) {
                None => return Err("Kategori bulunamadı.".into()),
                Some(k) if k == "expense" => {}
                Some(_) => return Err("Bütçe yalnızca gider kategorilerine tanımlanabilir.".into()),
            }
            s.upsert_budget(category_id, to_cents(a)?)
        }
        _ => s.delete_budget(category_id),
    }
}

/// Tutar boş veya 0 ise kategorinin bütçesi kaldırılır.
pub fn set_budget(s: &mut dyn DataStore, category_id: &str, amount: Option<f64>) -> CoreResult<()> {
    upsert_budget(s, category_id, amount)
}

/// Devreden bütçeyi `from` ayından (YYYY-MM) itibaren açar; None kapatır. Limiti olmayan kategoride hata.
pub fn set_budget_rollover(s: &mut dyn DataStore, category_id: &str, from: Option<&str>) -> CoreResult<()> {
    let from = from.map(str::trim).filter(|m| !m.is_empty());
    if from.is_some_and(|m| !crate::budget::valid_month(m)) {
        return Err("Geçersiz ay".into());
    }
    if s.set_budget_rollover(category_id, from)? == 0 {
        return Err("Devretmek için önce bu kategoriye limit koyun.".into());
    }
    Ok(())
}

// Birikim hedefleri

/// `own_id`: kaydedilen hedef (kendi hesapları "başka hedefe bağlı" sayılmaz). `today` yoksa (geri yükleme)
/// tarih geleceğe göre denetlenmez; `prev_date` düzenlenen hedefin değişmeyen eski tarihidir.
fn clean_goal(s: &mut dyn DataStore, own_id: &str, g: &GoalInput, today: Option<&str>, prev_date: Option<&str>) -> CoreResult<GoalRow> {
    let name = clean_name(&g.name, "Hedef adı")?;
    let currency = g.currency.trim().to_string();
    if fx::is_fund(&currency) {
        return Err("Hedef birimi fon olamaz; TL, döviz ya da altın seçin.".into());
    }
    if currency != fx::TRY && fx::find(&currency).is_none() {
        return Err(format!("Bilinmeyen birim: {currency}"));
    }
    if !g.target.is_finite() || g.target <= 0.0 {
        return Err("Hedef tutarı sıfırdan büyük olmalıdır.".into());
    }
    let target_minor = fxa::value_to_minor(g.target, fx::unit_or_try(Some(&currency)))?;
    let target_date = match g.target_date.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        None => None,
        Some(d) => {
            validate_date(d)?;
            if let Some(t) = today {
                if d <= t && prev_date != Some(d) {
                    return Err("Hedef tarihi bugünden sonra olmalıdır.".into());
                }
            }
            Some(d.to_string())
        }
    };
    let mut account_ids: Vec<String> = Vec::new();
    for id in &g.account_ids {
        if account_ids.contains(id) {
            continue;
        }
        let Some(a) = s.get_account(id)? else { return Err("Hesap bulunamadı.".into()) };
        if a.kind != "bank" && a.kind != "cash" {
            return Err(format!(
                "{} hesabı hedefe bağlanamaz; yalnız vadesiz, nakit, döviz/altın ve fon hesapları bağlanabilir.",
                a.name
            ));
        }
        if let Some((gid, gname)) = s.goal_of_account(id)? {
            if gid != own_id {
                return Err(format!("{} hesabı zaten '{gname}' hedefine bağlı.", a.name));
            }
        }
        account_ids.push(id.clone());
    }
    Ok(GoalRow { name, currency, target_minor, target_date, color: clean_color(&g.color), archived: g.archived, account_ids })
}

pub fn list_goals(s: &mut dyn DataStore) -> CoreResult<Vec<Goal>> {
    let mut xs = s.list_goals()?;
    order::sort_goals(&mut xs);
    Ok(xs)
}

pub fn create_goal(s: &mut dyn DataStore, input: GoalInput, today: &str) -> CoreResult<Goal> {
    let id = db::new_id();
    let row = clean_goal(s, &id, &input, Some(today), None)?;
    s.insert_goal(&id, &row, None)?;
    s.get_goal(&id)?.ok_or_else(|| "Hedef kaydedilemedi.".into())
}

pub fn update_goal(s: &mut dyn DataStore, goal: Goal, today: &str) -> CoreResult<Goal> {
    let prev = s.get_goal(&goal.id)?.ok_or("Hedef bulunamadı.")?;
    let row = clean_goal(s, &goal.id, &GoalInput::from(&goal), Some(today), prev.target_date.as_deref())?;
    s.update_goal(&goal.id, &row)?;
    s.get_goal(&goal.id)?.ok_or_else(|| "Hedef bulunamadı.".into())
}

pub fn delete_goal(s: &mut dyn DataStore, id: &str) -> CoreResult<()> {
    s.delete_goal(id)
}

// Etiketler

/// Türkçe büyük/küçük harf duyarsız karşılaştırma anahtarı (I→ı, İ→i)
fn tag_key(name: &str) -> String {
    name.chars().map(|c| match c { 'I' => 'ı', 'İ' => 'i', _ => c }).collect::<String>().to_lowercase()
}

fn clean_tag(s: &mut dyn DataStore, own_id: &str, t: &TagInput) -> CoreResult<TagRow> {
    let name = t.name.trim();
    if name.is_empty() {
        return Err("Etiket adı boş olamaz.".into());
    }
    if name.chars().count() > 40 {
        return Err("Etiket adı en fazla 40 karakter olabilir.".into());
    }
    let key = tag_key(name);
    if s.list_tags()?.iter().any(|x| x.id != own_id && tag_key(&x.name) == key) {
        return Err("Bu adda bir etiket zaten var.".into());
    }
    let budget_cents = match t.budget {
        None => None,
        Some(b) => Some(to_cents(b).map_err(|_| "Bütçe sıfırdan büyük olmalıdır.".to_string())?),
    };
    Ok(TagRow { name: name.to_string(), color: clean_color(&t.color), budget_cents, archived: t.archived })
}

/// Tekrarsız; var olmalı; arşivli etiket yalnız `prev`'de (işlemde zaten) varsa kabul
fn clean_tx_tags(s: &mut dyn DataStore, ids: &[String], prev: &[String]) -> CoreResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if out.contains(id) {
            continue;
        }
        let t = s.get_tag(id)?.ok_or("Etiket bulunamadı.")?;
        if t.archived && !prev.contains(id) {
            return Err(format!("'{}' etiketi arşivde; önce geri alın.", t.name));
        }
        out.push(id.clone());
    }
    Ok(out)
}

pub fn list_tags(s: &mut dyn DataStore) -> CoreResult<Vec<Tag>> {
    s.list_tags()
}

pub fn create_tag(s: &mut dyn DataStore, input: TagInput) -> CoreResult<Tag> {
    let id = db::new_id();
    let row = clean_tag(s, &id, &input)?;
    s.insert_tag(&id, &row, None)?;
    s.get_tag(&id)?.ok_or_else(|| "Etiket kaydedilemedi.".into())
}

pub fn update_tag(s: &mut dyn DataStore, tag: Tag) -> CoreResult<Tag> {
    let row = clean_tag(s, &tag.id, &TagInput::from(&tag))?;
    if s.update_tag(&tag.id, &row)? == 0 {
        return Err("Etiket bulunamadı.".into());
    }
    s.get_tag(&tag.id)?.ok_or_else(|| "Etiket bulunamadı.".into())
}

pub fn delete_tag(s: &mut dyn DataStore, id: &str) -> CoreResult<()> {
    s.delete_tag(id)
}

/// Seçili işlemlere etiket ekler/kaldırır; işlemlerden biri yoksa hiçbir şey değişmez (çağıran tek işlemde çalıştırır)
pub fn set_transaction_tags(s: &mut dyn DataStore, ids: &[String], add: &[String], remove: &[String]) -> CoreResult<Vec<Transaction>> {
    if ids.len() > 5000 {
        return Err("Tek seferde en çok 5.000 işlem seçilebilir.".into());
    }
    let add = clean_tx_tags(s, add, &[])?;
    let mut seen: Vec<&String> = Vec::new();
    for id in ids {
        if seen.contains(&id) {
            continue;
        }
        seen.push(id);
        if s.get_transaction(id)?.is_none() {
            return Err("İşlem bulunamadı.".into());
        }
        for t in &add {
            s.add_tx_tag(id, t)?;
        }
        for t in remove {
            s.remove_tx_tag(id, t)?;
        }
    }
    seen.into_iter().map(|id| get_transaction(s, id)).collect()
}

// Yedekleme / Geri yükleme

/// Tüm veriyi verilen içerikle değiştirir. Çağıran bunu tek bir veritabanı işleminde çalıştırır
/// (`sqlite::run` ya da sunucudaki Postgres karşılığı): herhangi bir satır hatalıysa hiçbir değişiklik kalmaz.
// Yedekteki her veri türü ayrı liste olarak gelir (sunucu gövdesi ve Tauri komutu aynı biçimde)
#[allow(clippy::too_many_arguments)]
pub fn restore_data(
    s: &mut dyn DataStore,
    categories: Vec<Category>,
    accounts: Vec<Account>,
    transactions: Vec<Transaction>,
    recurring: Vec<RecurringItem>,
    budgets: Vec<Budget>,
    goals: Vec<Goal>,
    // None: etiketleri bilmeyen (1.7 öncesi) istemci; mevcut etiketler ve işlem bağlantıları korunur
    tags: Option<Vec<Tag>>,
) -> CoreResult<()> {
    let old_client = tags.is_none();
    let (tags, old_links) = match tags {
        Some(t) => (t, Vec::new()),
        None => (s.list_tags()?, s.list_tx_tags()?),
    };
    let mut kept: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for (tx, tag) in old_links {
        kept.entry(tx).or_default().push(tag);
    }
    s.clear_all()?;

    // Etiketler işlemlerden önce (işlem bağlantıları için)
    let mut tag_ids: HashSet<String> = HashSet::new();
    for (i, t) in tags.iter().enumerate() {
        let id = if t.id.trim().is_empty() { db::new_id() } else { t.id.clone() };
        let row = clean_tag(s, &id, &TagInput::from(t)).map_err(|e| format!("{}. etiket: {e}", i + 1))?;
        let created = Some(t.created_at.as_str()).filter(|c| !c.trim().is_empty());
        s.insert_tag(&id, &row, created).map_err(|e| format!("{}. etiket eklenemedi: {e}", i + 1))?;
        tag_ids.insert(id);
    }

    let mut category_ids = HashSet::new();
    for c in &categories {
        validate_category_kind(&c.kind)?;
        let name = clean_name(&c.name, "Kategori adı")?;
        let id = if c.id.trim().is_empty() { db::new_id() } else { c.id.clone() };
        s.insert_category(&id, &name, &c.kind, &clean_color(&c.color))
            .map_err(|e| format!("Kategori \"{name}\" eklenemedi: {e}"))?;
        category_ids.insert(id);
    }

    for a in &accounts {
        let row = clean_account(a).map_err(|e| format!("Hesap \"{}\": {e}", a.name))?;
        let id = if a.id.trim().is_empty() { db::new_id() } else { a.id.clone() };
        s.insert_account(&id, &row).map_err(|e| format!("Hesap \"{}\" eklenemedi: {e}", row.name))?;
    }

    for (i, t) in transactions.iter().enumerate() {
        let n = i + 1;
        let category_id = if t.kind == "transfer" {
            None
        } else {
            t.category_id.as_ref().filter(|id| category_ids.contains(*id)).cloned()
        };
        let id = if t.id.trim().is_empty() { db::new_id() } else { t.id.clone() };
        let row = transaction_row(s, id, &as_input(t, category_id), false, clean_created_at(&t.created_at))
            .map_err(|e| format!("{n}. işlem: {e}"))?;
        s.insert_transaction(&row).map_err(|e| format!("{n}. işlem eklenemedi: {e}"))?;
        // Yedekte olmayan etikete bağlantı atlanır; arşivli etiket bağlantısı korunur
        let mut links: Vec<String> = Vec::new();
        let wanted = if old_client && t.tag_ids.is_empty() { kept.get(&t.id).cloned().unwrap_or_default() } else { t.tag_ids.clone() };
        for tg in &wanted {
            if tag_ids.contains(tg) && !links.contains(tg) {
                links.push(tg.clone());
            }
        }
        s.set_tx_tags(&row.id, &links)?;
    }

    for (i, r) in recurring.iter().enumerate() {
        // Silinmiş hesap/kategoriye ya da türü uymayan kategoriye bağlı düzenli kayıt bağlantısız geri yüklenir
        let mut r = r.clone();
        if let Some(id) = &r.account_id {
            if s.account_meta(id)?.is_none() {
                r.account_id = None;
            }
        }
        if r.category_id.is_some() && check_category(s, &r.category_id, &r.kind).is_err() {
            r.category_id = None;
        }
        let row = clean_recurring(s, &r).map_err(|e| format!("{}. düzenli kayıt: {e}", i + 1))?;
        let id = if r.id.trim().is_empty() { db::new_id() } else { r.id.clone() };
        s.insert_recurring(&id, &row).map_err(|e| format!("{}. düzenli kayıt eklenemedi: {e}", i + 1))?;
    }
    for b in &budgets {
        if !category_ids.contains(&b.category_id) {
            continue;
        }
        // Bütçe yalnız gider kategorilerinde anlamlı; diğerleri (eski/elle düzenlenmiş yedek) atlanır
        if s.get_category(&b.category_id)?.is_some_and(|c| c.kind == "expense") {
            upsert_budget(s, &b.category_id, Some(b.amount))?;
            // Bozuk ay yedeği düşürmesin: devir kapalı gelir
            let from = b.rollover_from.as_deref().filter(|m| crate::budget::valid_month(m));
            s.set_budget_rollover(&b.category_id, from)?;
        }
    }
    // Hedefler: yedekte olmayan ya da bağlanamayan (kart/kredi) hesaba ve önceki bir hedefe bağlı hesaba bağlantı atlanır
    let mut linked: HashSet<String> = HashSet::new();
    for (i, g) in goals.iter().enumerate() {
        let mut input = GoalInput::from(g);
        let mut keep = Vec::new();
        for a in &input.account_ids {
            if linked.contains(a) {
                continue;
            }
            if s.get_account(a)?.is_some_and(|x| x.kind == "bank" || x.kind == "cash") {
                keep.push(a.clone());
            }
        }
        input.account_ids = keep;
        let id = if g.id.trim().is_empty() { db::new_id() } else { g.id.clone() };
        let row = clean_goal(s, &id, &input, None, None).map_err(|e| format!("{}. hedef: {e}", i + 1))?;
        linked.extend(row.account_ids.iter().cloned());
        let created = Some(g.created_at.as_str()).filter(|c| !c.trim().is_empty());
        s.insert_goal(&id, &row, created).map_err(|e| format!("{}. hedef eklenemedi: {e}", i + 1))?;
    }
    // Silinmiş düzenli gelire işaret eden finansman bağlantılarını temizle
    s.clear_dangling_funding()
}

// Uygulama ayarları

/// Veritabanında saklanan (cihazlar arasında taşınan) ayarlar. Tema gibi cihaz tercihleri burada değildir.
pub const SETTING_KEYS: &[&str] = &[
    "debtBudget",
    "debtBudgetOverrides",
    "debtRules",
    "debtCells",
    "subscriptionOverrides",
    "forecastCategoryIds",
    "categoryRules",
];

pub fn get_settings(s: &mut dyn DataStore) -> CoreResult<serde_json::Map<String, serde_json::Value>> {
    // Bozuk JSON satırı atlanır (arayüz varsayılanı kullanır)
    Ok(s.list_settings()?
        .into_iter()
        .filter_map(|(k, v)| serde_json::from_str(&v).ok().map(|v| (k, v)))
        .collect())
}

pub fn set_setting(s: &mut dyn DataStore, key: &str, value: serde_json::Value) -> CoreResult<()> {
    if !SETTING_KEYS.contains(&key) {
        return Err(format!("Bilinmeyen ayar: {key}"));
    }
    let json = value.to_string();
    if json.len() > 1_000_000 {
        return Err("Ayar çok büyük.".into());
    }
    s.upsert_setting(key, &json)
}

