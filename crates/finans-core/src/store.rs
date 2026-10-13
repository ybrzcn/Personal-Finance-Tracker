//! Veri işlemleri: doğrulama, ekleme/güncelleme/silme ve geri yükleme. Hata mesajları kullanıcıya gösterilir.

use std::collections::HashSet;

use rusqlite::{params, Connection, ErrorCode, OptionalExtension};

use crate::db::{
    self, row_to_account, row_to_category, row_to_recurring, row_to_transaction, Account,
    AccountInput, Budget, Category, CategoryInput, RecurringItem, Transaction, TransactionInput,
    ACCOUNT_COLUMNS, CATEGORY_COLUMNS, RECURRING_COLUMNS, TRANSACTION_COLUMNS,
};
use crate::CoreResult;

pub fn db_err(e: rusqlite::Error) -> String {
    match &e {
        rusqlite::Error::SqliteFailure(f, msg)
            if f.code == ErrorCode::ConstraintViolation
                && f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            if msg.as_deref().is_some_and(|m| m.contains("accounts.name")) {
                "Bu isimde bir hesap zaten mevcut.".into()
            } else {
                "Bu isimde ve türde bir kategori zaten mevcut.".into()
            }
        }
        _ => format!("Veritabanı hatası: {e}"),
    }
}

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

/// Seçilen kategori mevcut olmalı ve işlem türüyle uyuşmalı.
fn check_category(conn: &Connection, category_id: &Option<String>, kind: &str) -> CoreResult<()> {
    let Some(id) = category_id else { return Ok(()) };
    let cat_kind: Option<String> = conn
        .query_row("SELECT type FROM categories WHERE id = ?1", [id], |r| r.get(0))
        .optional()
        .map_err(db_err)?;
    match cat_kind {
        None => Err("Seçilen kategori bulunamadı.".into()),
        Some(k) if k != kind => Err("Kategori türü ile işlem türü uyuşmuyor.".into()),
        Some(_) => Ok(()),
    }
}

/// Veritabanına yazılacak, doğrulanmış hesap alanları.
pub(crate) struct AccountRow {
    name: String,
    kind: String,
    color: String,
    opening_cents: i64,
    opening_date: String,
    limit_cents: Option<i64>,
    rate_bp: Option<i64>,
    statement_day: Option<i64>,
    due_day: Option<i64>,
    min_rate_bp: Option<i64>,
    sort_order: i64,
    archived: bool,
    term_months: Option<i64>,
    first_due_date: Option<String>,
    installment_cents: Option<i64>,
    tax_rate_bp: Option<i64>,
    funding_income_id: Option<String>,
    opening_period_cents: Option<i64>,
    /// JSON dizisi
    opening_installments: String,
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
pub(crate) fn clean_account(a: &Account) -> CoreResult<AccountRow> {
    let name = clean_name(&a.name, "Hesap adı")?;
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
        Some(l) if !cash && !loan => {
            if !l.is_finite() || l < 0.0 {
                return Err("Limit negatif olamaz.".into());
            }
            Some((l * 100.0).round() as i64)
        }
        _ => None,
    };
    Ok(AccountRow {
        name,
        kind: a.kind.clone(),
        color: clean_color(&a.color),
        opening_cents: to_signed_cents(a.opening_balance)?,
        opening_date: a.opening_date.clone(),
        limit_cents,
        rate_bp: if cash { None } else { rate_bp(a.interest_rate, "Faiz oranı")? },
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

fn insert_account(conn: &Connection, id: &str, r: &AccountRow) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO accounts (id, name, kind, color, opening_balance_cents, opening_date, credit_limit_cents,
                               interest_rate_bp, statement_day, due_day, min_payment_rate_bp, sort_order, archived,
                               term_months, first_due_date, installment_cents, tax_rate_bp, funding_income_id,
                               opening_period_cents, opening_installments)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            id, r.name, r.kind, r.color, r.opening_cents, r.opening_date, r.limit_cents, r.rate_bp,
            r.statement_day, r.due_day, r.min_rate_bp, r.sort_order, r.archived, r.term_months,
            r.first_due_date, r.installment_cents, r.tax_rate_bp, r.funding_income_id, r.opening_period_cents,
            r.opening_installments
        ],
    )
}

/// Hesabın türü ve arşiv durumu.
fn account_meta(conn: &Connection, id: &str) -> CoreResult<(String, bool)> {
    conn.query_row("SELECT kind, archived FROM accounts WHERE id = ?1", [id], |r| {
        Ok((r.get(0)?, r.get::<_, i64>(1)? != 0))
    })
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| "Seçilen hesap bulunamadı.".to_string())
}

fn account_usage(conn: &Connection, id: &str) -> CoreResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM transactions WHERE account_id = ?1 OR to_account_id = ?1",
        [id],
        |r| r.get(0),
    )
    .map_err(db_err)
}

/// Arayüzdeki `validateTransaction` ile aynı kurallar.
#[allow(clippy::too_many_arguments)]
pub(crate) fn check_transaction(
    conn: &Connection,
    kind: &str,
    account_id: &str,
    to_account_id: Option<&str>,
    category_id: &Option<String>,
    installments: i64,
    is_new: bool,
) -> CoreResult<()> {
    validate_tx_kind(kind)?;
    let archived_err = || Err("Arşivlenmiş hesaba yeni işlem eklenemez.".to_string());
    let (acc_kind, archived) = account_meta(conn, account_id)?;
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
        let (to_kind, to_archived) = account_meta(conn, to)?;
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
        check_category(conn, category_id, kind)?;
    }
    if !(1..=36).contains(&installments) {
        return Err("Taksit sayısı 1 ile 36 arasında olmalıdır.".into());
    }
    if installments > 1 && !(kind == "expense" && acc_kind == "credit_card") {
        return Err("Taksit yalnızca kredi kartı harcamalarında kullanılabilir.".into());
    }
    Ok(())
}

fn get_category(conn: &Connection, id: &str) -> CoreResult<Category> {
    conn.query_row(
        &format!("SELECT {CATEGORY_COLUMNS} FROM categories WHERE id = ?1"),
        [id],
        row_to_category,
    )
    .map_err(db_err)
}

fn get_account(conn: &Connection, id: &str) -> CoreResult<Account> {
    conn.query_row(
        &format!("SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE id = ?1"),
        [id],
        row_to_account,
    )
    .map_err(db_err)
}

fn get_transaction(conn: &Connection, id: &str) -> CoreResult<Transaction> {
    conn.query_row(
        &format!("SELECT {TRANSACTION_COLUMNS} FROM transactions WHERE id = ?1"),
        [id],
        row_to_transaction,
    )
    .map_err(db_err)
}

// ---------------------------------------------------------------------------
// Kategoriler
// ---------------------------------------------------------------------------

pub fn list_categories(conn: &Connection) -> CoreResult<Vec<Category>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CATEGORY_COLUMNS} FROM categories ORDER BY type DESC, name COLLATE NOCASE"
        ))
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], row_to_category)
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(rows)
}

pub fn create_category(conn: &Connection, input: CategoryInput) -> CoreResult<Category> {
    validate_category_kind(&input.kind)?;
    let name = clean_name(&input.name, "Kategori adı")?;
    let id = db::new_id();
    conn.execute(
        "INSERT INTO categories (id, name, type, color) VALUES (?1, ?2, ?3, ?4)",
        (&id, &name, &input.kind, clean_color(&input.color)),
    )
    .map_err(db_err)?;
    get_category(conn, &id)
}

pub fn update_category(conn: &Connection, category: Category) -> CoreResult<Category> {
    validate_category_kind(&category.kind)?;
    let name = clean_name(&category.name, "Kategori adı")?;

    let mismatched: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM transactions WHERE category_id = ?1 AND type <> ?2",
            (&category.id, &category.kind),
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if mismatched > 0 {
        return Err(format!(
            "Bu kategori {mismatched} işlemde kullanıldığı için türü değiştirilemez."
        ));
    }
    let recurring_mismatch: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM recurring_items WHERE category_id = ?1 AND type <> ?2",
            (&category.id, &category.kind),
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if recurring_mismatch > 0 {
        return Err(format!(
            "Bu kategori {recurring_mismatch} düzenli kayıtta kullanıldığı için türü değiştirilemez."
        ));
    }
    if category.kind != "expense" {
        let budgets: i64 = conn
            .query_row("SELECT COUNT(*) FROM budgets WHERE category_id = ?1", [&category.id], |r| r.get(0))
            .map_err(db_err)?;
        if budgets > 0 {
            return Err("Bu kategorinin bütçe limiti olduğu için türü değiştirilemez; önce limiti kaldırın.".into());
        }
    }

    let changed = conn
        .execute(
            "UPDATE categories SET name = ?2, type = ?3, color = ?4 WHERE id = ?1",
            (&category.id, &name, &category.kind, clean_color(&category.color)),
        )
        .map_err(db_err)?;
    if changed == 0 {
        return Err("Kategori bulunamadı.".into());
    }
    get_category(conn, &category.id)
}

/// Kategori silinince ona bağlı işlemler silinmez, "Kategorisiz" kalır (ON DELETE SET NULL).
pub fn delete_category(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute(
        "UPDATE transactions SET category_id = NULL WHERE category_id = ?1",
        [&id],
    )
    .map_err(db_err)?;
    conn.execute("DELETE FROM categories WHERE id = ?1", [&id])
        .map_err(db_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Hesaplar
// ---------------------------------------------------------------------------

pub fn list_accounts(conn: &Connection) -> CoreResult<Vec<Account>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ACCOUNT_COLUMNS} FROM accounts ORDER BY sort_order, name COLLATE NOCASE"
        ))
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], row_to_account)
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(rows)
}

pub fn create_account(conn: &Connection, input: AccountInput) -> CoreResult<Account> {
    let row = clean_account(&input.with_id(String::new()))?;
    let id = db::new_id();
    insert_account(conn, &id, &row).map_err(db_err)?;
    get_account(conn, &id)
}

pub fn update_account(conn: &Connection, account: Account) -> CoreResult<Account> {
    let row = clean_account(&account)?;
    let (old_kind, _) = account_meta(conn, &account.id).map_err(|_| "Hesap bulunamadı.".to_string())?;
    if old_kind != row.kind && account_usage(conn, &account.id)? > 0 {
        return Err("Bu hesapta işlem bulunduğu için türü değiştirilemez.".into());
    }
    conn.execute(
        "UPDATE accounts SET name = ?2, kind = ?3, color = ?4, opening_balance_cents = ?5, opening_date = ?6,
                credit_limit_cents = ?7, interest_rate_bp = ?8, statement_day = ?9, due_day = ?10,
                min_payment_rate_bp = ?11, sort_order = ?12, archived = ?13, term_months = ?14,
                first_due_date = ?15, installment_cents = ?16, tax_rate_bp = ?17, funding_income_id = ?18,
                opening_period_cents = ?19, opening_installments = ?20
         WHERE id = ?1",
        params![
            account.id, row.name, row.kind, row.color, row.opening_cents, row.opening_date, row.limit_cents,
            row.rate_bp, row.statement_day, row.due_day, row.min_rate_bp, row.sort_order, row.archived,
            row.term_months, row.first_due_date, row.installment_cents, row.tax_rate_bp, row.funding_income_id,
            row.opening_period_cents, row.opening_installments
        ],
    )
    .map_err(db_err)?;
    get_account(conn, &account.id)
}

/// İşlemi olan hesap silinemez; yalnızca arşivlenebilir.
pub fn delete_account(conn: &Connection, id: &str) -> CoreResult<()> {
    let used = account_usage(conn, id)?;
    if used > 0 {
        return Err(format!("Bu hesapta {used} işlem var; silmek yerine arşivleyin."));
    }
    conn.execute("DELETE FROM accounts WHERE id = ?1", [&id])
        .map_err(db_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// İşlemler
// ---------------------------------------------------------------------------

pub fn list_transactions(conn: &Connection) -> CoreResult<Vec<Transaction>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TRANSACTION_COLUMNS} FROM transactions ORDER BY date DESC, created_at DESC"
        ))
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], row_to_transaction)
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(rows)
}

pub fn create_transaction(conn: &Connection, input: TransactionInput) -> CoreResult<Transaction> {
    validate_date(&input.date)?;
    let cents = to_cents(input.amount)?;
    check_transaction(
        conn,
        &input.kind,
        &input.account_id,
        input.to_account_id.as_deref(),
        &input.category_id,
        input.installments,
        true,
    )?;
    let id = db::new_id();
    conn.execute(
        "INSERT INTO transactions (id, amount_cents, type, account_id, to_account_id, category_id, date, description, installments,
                                   budget_month)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            cents,
            input.kind,
            input.account_id,
            input.to_account_id,
            input.category_id,
            input.date,
            input.description.trim(),
            input.installments,
            clean_budget_month(&input.kind, &input.budget_month)?
        ],
    )
    .map_err(db_err)?;
    get_transaction(conn, &id)
}

pub fn update_transaction(conn: &Connection, transaction: Transaction) -> CoreResult<Transaction> {
    validate_date(&transaction.date)?;
    let cents = to_cents(transaction.amount)?;
    check_transaction(
        conn,
        &transaction.kind,
        &transaction.account_id,
        transaction.to_account_id.as_deref(),
        &transaction.category_id,
        transaction.installments,
        false,
    )?;
    let changed = conn
        .execute(
            "UPDATE transactions
             SET amount_cents = ?2, type = ?3, account_id = ?4, to_account_id = ?5, category_id = ?6,
                 date = ?7, description = ?8, installments = ?9, budget_month = ?10
             WHERE id = ?1",
            params![
                transaction.id,
                cents,
                transaction.kind,
                transaction.account_id,
                transaction.to_account_id,
                transaction.category_id,
                transaction.date,
                transaction.description.trim(),
                transaction.installments,
                clean_budget_month(&transaction.kind, &transaction.budget_month)?
            ],
        )
        .map_err(db_err)?;
    if changed == 0 {
        return Err("İşlem bulunamadı.".into());
    }
    get_transaction(conn, &transaction.id)
}

pub fn delete_transaction(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("DELETE FROM transactions WHERE id = ?1", [&id])
        .map_err(db_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Düzenli gelir / giderler ve bütçeler
// ---------------------------------------------------------------------------

struct RecurringRow {
    name: String,
    kind: String,
    cents: i64,
    day: i64,
    account_id: Option<String>,
    category_id: Option<String>,
    active: bool,
    sort_order: i64,
    /// JSON dizisi, tarihe göre sıralı
    history: String,
    /// JSON dizisi, aya göre sıralı
    exceptions: String,
    covers_previous_month: bool,
    start_date: Option<String>,
    weekend_shift: String,
}

fn clean_recurring(conn: &Connection, r: &RecurringItem) -> CoreResult<RecurringRow> {
    validate_category_kind(&r.kind)?;
    let name = clean_name(&r.name, "Ad")?;
    let day = day_of_month(Some(r.day), "Gün")?;
    if let Some(id) = &r.account_id {
        account_meta(conn, id)?;
    }
    check_category(conn, &r.category_id, &r.kind)?;
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
    })
}

fn insert_recurring(conn: &Connection, id: &str, r: &RecurringRow) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO recurring_items (id, name, type, amount_cents, day, account_id, category_id, active, sort_order,
                                      amount_history, amount_exceptions, covers_previous_month, start_date, weekend_shift)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            id, r.name, r.kind, r.cents, r.day, r.account_id, r.category_id, r.active, r.sort_order, r.history, r.exceptions,
            r.covers_previous_month, r.start_date, r.weekend_shift
        ],
    )
}

fn get_recurring(conn: &Connection, id: &str) -> CoreResult<RecurringItem> {
    conn.query_row(
        &format!("SELECT {RECURRING_COLUMNS} FROM recurring_items WHERE id = ?1"),
        [id],
        row_to_recurring,
    )
    .map_err(db_err)
}

pub fn list_recurring(conn: &Connection) -> CoreResult<Vec<RecurringItem>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {RECURRING_COLUMNS} FROM recurring_items ORDER BY type DESC, day, sort_order"
        ))
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], row_to_recurring)
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(rows)
}

pub fn create_recurring(conn: &Connection, item: RecurringItem) -> CoreResult<RecurringItem> {
    let row = clean_recurring(conn, &item)?;
    let id = db::new_id();
    insert_recurring(conn, &id, &row).map_err(db_err)?;
    get_recurring(conn, &id)
}

pub fn update_recurring(conn: &Connection, item: RecurringItem) -> CoreResult<RecurringItem> {
    let r = clean_recurring(conn, &item)?;
    let changed = conn
        .execute(
            "UPDATE recurring_items SET name = ?2, type = ?3, amount_cents = ?4, day = ?5, account_id = ?6,
                    category_id = ?7, active = ?8, sort_order = ?9, amount_history = ?10, amount_exceptions = ?11,
                    covers_previous_month = ?12, start_date = ?13, weekend_shift = ?14
             WHERE id = ?1",
            params![
                item.id, r.name, r.kind, r.cents, r.day, r.account_id, r.category_id, r.active, r.sort_order, r.history,
                r.exceptions, r.covers_previous_month, r.start_date, r.weekend_shift
            ],
        )
        .map_err(db_err)?;
    if changed == 0 {
        return Err("Kayıt bulunamadı.".into());
    }
    if r.kind != "income" {
        conn.execute("UPDATE accounts SET funding_income_id = NULL WHERE funding_income_id = ?1", [&item.id])
            .map_err(db_err)?;
    }
    get_recurring(conn, &item.id)
}

pub fn delete_recurring(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("UPDATE accounts SET funding_income_id = NULL WHERE funding_income_id = ?1", [&id])
        .map_err(db_err)?;
    conn.execute("DELETE FROM recurring_items WHERE id = ?1", [&id])
        .map_err(db_err)?;
    Ok(())
}

pub fn list_budgets(conn: &Connection) -> CoreResult<Vec<Budget>> {
    let mut stmt = conn
        .prepare("SELECT category_id, amount_cents FROM budgets")
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Budget {
                category_id: r.get(0)?,
                amount: r.get::<_, i64>(1)? as f64 / 100.0,
            })
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(rows)
}

fn upsert_budget(conn: &Connection, category_id: &str, amount: Option<f64>) -> CoreResult<()> {
    match amount {
        Some(a) if a > 0.0 => {
            let kind: Option<String> = conn
                .query_row("SELECT type FROM categories WHERE id = ?1", [category_id], |r| r.get(0))
                .optional()
                .map_err(db_err)?;
            match kind.as_deref() {
                None => return Err("Kategori bulunamadı.".into()),
                Some("expense") => {}
                Some(_) => return Err("Bütçe yalnızca gider kategorilerine tanımlanabilir.".into()),
            }
            conn.execute(
                "INSERT INTO budgets (category_id, amount_cents) VALUES (?1, ?2)
                 ON CONFLICT(category_id) DO UPDATE SET amount_cents = excluded.amount_cents",
                params![category_id, to_cents(a)?],
            )
            .map_err(db_err)?;
        }
        _ => {
            conn.execute("DELETE FROM budgets WHERE category_id = ?1", [category_id])
                .map_err(db_err)?;
        }
    }
    Ok(())
}

/// Tutar boş veya 0 ise kategorinin bütçesi kaldırılır.
pub fn set_budget(conn: &Connection, category_id: &str, amount: Option<f64>) -> CoreResult<()> {
    upsert_budget(conn, category_id, amount)
}

// ---------------------------------------------------------------------------
// Yedekleme / Geri yükleme
// ---------------------------------------------------------------------------

/// Tüm veriyi tek bir SQLite transaction'ı içinde verilen içerikle değiştirir.
/// Herhangi bir satır hatalıysa hiçbir değişiklik uygulanmaz (atomik).
pub fn restore_data(conn: &mut Connection, categories: Vec<Category>, accounts: Vec<Account>, transactions: Vec<Transaction>, recurring: Vec<RecurringItem>, budgets: Vec<Budget>) -> CoreResult<()> {
    let tx = conn.transaction().map_err(db_err)?;

    tx.execute("DELETE FROM budgets", []).map_err(db_err)?;
    tx.execute("DELETE FROM recurring_items", []).map_err(db_err)?;
    tx.execute("DELETE FROM transactions", []).map_err(db_err)?;
    tx.execute("DELETE FROM accounts", []).map_err(db_err)?;
    tx.execute("DELETE FROM categories", []).map_err(db_err)?;

    let mut category_ids = HashSet::new();
    for c in &categories {
        validate_category_kind(&c.kind)?;
        let name = clean_name(&c.name, "Kategori adı")?;
        let id = if c.id.trim().is_empty() { db::new_id() } else { c.id.clone() };
        tx.execute(
            "INSERT INTO categories (id, name, type, color) VALUES (?1, ?2, ?3, ?4)",
            (&id, &name, &c.kind, clean_color(&c.color)),
        )
        .map_err(|e| format!("Kategori \"{name}\" eklenemedi: {}", db_err(e)))?;
        category_ids.insert(id);
    }

    for a in &accounts {
        let row = clean_account(a).map_err(|e| format!("Hesap \"{}\": {e}", a.name))?;
        let id = if a.id.trim().is_empty() { db::new_id() } else { a.id.clone() };
        insert_account(&tx, &id, &row)
            .map_err(|e| format!("Hesap \"{}\" eklenemedi: {}", row.name, db_err(e)))?;
    }

    for (i, t) in transactions.iter().enumerate() {
        let row = i + 1;
        validate_date(&t.date).map_err(|e| format!("{row}. işlem: {e}"))?;
        let cents = to_cents(t.amount).map_err(|e| format!("{row}. işlem: {e}"))?;
        let category_id = if t.kind == "transfer" {
            None
        } else {
            t.category_id
                .as_ref()
                .filter(|id| category_ids.contains(*id))
                .cloned()
        };
        check_transaction(
            &tx,
            &t.kind,
            &t.account_id,
            t.to_account_id.as_deref(),
            &category_id,
            t.installments,
            false,
        )
        .map_err(|e| format!("{row}. işlem: {e}"))?;
        let id = if t.id.trim().is_empty() { db::new_id() } else { t.id.clone() };
        tx.execute(
            "INSERT INTO transactions (id, amount_cents, type, account_id, to_account_id, category_id, date, description, installments,
                                       created_at, budget_month)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                     COALESCE(NULLIF(?10, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?11)",
            params![
                id,
                cents,
                t.kind,
                t.account_id,
                t.to_account_id,
                category_id,
                t.date,
                t.description.trim(),
                t.installments,
                t.created_at,
                clean_budget_month(&t.kind, &t.budget_month).map_err(|e| format!("{row}. işlem: {e}"))?
            ],
        )
        .map_err(|e| format!("{row}. işlem eklenemedi: {}", db_err(e)))?;
    }

    for (i, r) in recurring.iter().enumerate() {
        // Silinmiş hesap/kategoriye ya da türü uymayan kategoriye bağlı düzenli kayıt bağlantısız geri yüklenir
        let mut r = r.clone();
        if let Some(id) = &r.account_id {
            if account_meta(&tx, id).is_err() {
                r.account_id = None;
            }
        }
        if r.category_id.is_some() && check_category(&tx, &r.category_id, &r.kind).is_err() {
            r.category_id = None;
        }
        let r = &r;
        let row = clean_recurring(&tx, r).map_err(|e| format!("{}. düzenli kayıt: {e}", i + 1))?;
        let id = if r.id.trim().is_empty() { db::new_id() } else { r.id.clone() };
        insert_recurring(&tx, &id, &row)
            .map_err(|e| format!("{}. düzenli kayıt eklenemedi: {}", i + 1, db_err(e)))?;
    }
    for b in &budgets {
        if !category_ids.contains(&b.category_id) {
            continue;
        }
        // Bütçe yalnız gider kategorilerinde anlamlı; diğerleri (eski/elle düzenlenmiş yedek) atlanır
        let kind: Option<String> = tx
            .query_row("SELECT type FROM categories WHERE id = ?1", [&b.category_id], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        if kind.as_deref() == Some("expense") {
            upsert_budget(&tx, &b.category_id, Some(b.amount))?;
        }
    }
    // Silinmiş düzenli gelire işaret eden finansman bağlantılarını temizle
    tx.execute(
        "UPDATE accounts SET funding_income_id = NULL
         WHERE funding_income_id IS NOT NULL
           AND funding_income_id NOT IN (SELECT id FROM recurring_items WHERE type = 'income')",
        [],
    )
    .map_err(db_err)?;

    tx.commit().map_err(db_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Uygulama ayarları
// ---------------------------------------------------------------------------

/// Veritabanında saklanan (cihazlar arasında taşınan) ayarlar. Tema gibi cihaz tercihleri burada değildir.
pub const SETTING_KEYS: &[&str] = &[
    "debtBudget",
    "debtBudgetOverrides",
    "debtRules",
    "debtCells",
    "subscriptionOverrides",
    "forecastCategoryIds",
];

pub fn get_settings(conn: &Connection) -> CoreResult<serde_json::Map<String, serde_json::Value>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings").map_err(db_err)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    // Bozuk JSON satırı atlanır (arayüz varsayılanı kullanır)
    Ok(rows
        .into_iter()
        .filter_map(|(k, v)| serde_json::from_str(&v).ok().map(|v| (k, v)))
        .collect())
}

pub fn set_setting(conn: &Connection, key: &str, value: serde_json::Value) -> CoreResult<()> {
    if !SETTING_KEYS.contains(&key) {
        return Err(format!("Bilinmeyen ayar: {key}"));
    }
    let json = value.to_string();
    if json.len() > 1_000_000 {
        return Err("Ayar çok büyük.".into());
    }
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, &json),
    )
    .map_err(db_err)?;
    Ok(())
}
