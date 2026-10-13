use std::path::Path;

use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub color: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInput {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub color: String,
}

fn one() -> i64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: String,
    /// Arayüz ve yedekler için ondalıklı tutar; veritabanında kuruş (INTEGER) olarak saklanır.
    pub amount: f64,
    #[serde(rename = "type")]
    pub kind: String,
    /// Gelir/gider: işlemin hesabı. Transfer: kaynak hesap.
    pub account_id: String,
    #[serde(default)]
    pub to_account_id: Option<String>,
    pub category_id: Option<String>,
    /// YYYY-MM-DD
    pub date: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "one")]
    pub installments: i64,
    /// Yalnız gelir: bütçede sayılacağı ay (YYYY-MM); None = işlem tarihinin ayı
    #[serde(default)]
    pub budget_month: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionInput {
    pub amount: f64,
    #[serde(rename = "type")]
    pub kind: String,
    pub account_id: String,
    #[serde(default)]
    pub to_account_id: Option<String>,
    pub category_id: Option<String>,
    pub date: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "one")]
    pub installments: i64,
    #[serde(default)]
    pub budget_month: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub color: String,
    /// bank/cash: açılış bakiyesi (eksi = KMH). credit_card: açılış borcu.
    pub opening_balance: f64,
    pub opening_date: String,
    pub credit_limit: Option<f64>,
    /// Aylık akdi faiz, yüzde
    pub interest_rate: Option<f64>,
    pub statement_day: Option<i64>,
    pub due_day: Option<i64>,
    /// Asgari ödeme oranı, yüzde
    pub min_payment_rate: Option<f64>,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default)]
    pub archived: bool,
    /// Yalnız kredi: vade (ay)
    #[serde(default)]
    pub term_months: Option<i64>,
    /// Yalnız kredi: ilk taksit tarihi
    #[serde(default)]
    pub first_due_date: Option<String>,
    /// Yalnız kredi: aylık taksit tutarı
    #[serde(default)]
    pub installment_amount: Option<f64>,
    /// Yalnız kredi: faize eklenen vergi oranı (KKDF + BSMV), yüzde
    #[serde(default)]
    pub tax_rate: Option<f64>,
    /// Kart/kredi ödemesinin karşılanacağı düzenli gelir (boşsa otomatik)
    #[serde(default)]
    pub funding_income_id: Option<String>,
    /// Yalnız kart: eklendiği gün açık dönemdeki taksitsiz harcamalar (sonraki ekstreye yazılır)
    #[serde(default)]
    pub opening_period_spending: Option<f64>,
    /// Yalnız kart: eklendiği gün devam eden taksitler (sonraki ekstreden itibaren her aya bir taksit)
    #[serde(default)]
    pub opening_installments: Vec<OpeningInstallment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpeningInstallment {
    #[serde(default)]
    pub description: String,
    /// Aylık taksit tutarı
    pub amount: f64,
    /// Kalan taksit sayısı (bir sonraki ekstre dahil)
    pub remaining: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub name: String,
    pub kind: String,
    pub color: String,
    pub opening_balance: f64,
    pub opening_date: String,
    pub credit_limit: Option<f64>,
    pub interest_rate: Option<f64>,
    pub statement_day: Option<i64>,
    pub due_day: Option<i64>,
    pub min_payment_rate: Option<f64>,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub term_months: Option<i64>,
    #[serde(default)]
    pub first_due_date: Option<String>,
    #[serde(default)]
    pub installment_amount: Option<f64>,
    #[serde(default)]
    pub tax_rate: Option<f64>,
    #[serde(default)]
    pub funding_income_id: Option<String>,
    #[serde(default)]
    pub opening_period_spending: Option<f64>,
    #[serde(default)]
    pub opening_installments: Vec<OpeningInstallment>,
}

/// Düzenli gelir (maaş) veya gider (kira, fatura, abonelik).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringItem {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub amount: f64,
    /// Ayın günü (1-31)
    pub day: i64,
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    #[serde(default = "yes")]
    pub active: bool,
    #[serde(default)]
    pub sort_order: i64,
    /// Tutar değişiklikleri: `from` tarihinden itibaren `amount` geçerlidir (`amount` alanı ilk tutardır)
    #[serde(default)]
    pub history: Vec<AmountChange>,
    /// Tek aya özel tutar (0 = o ay yok, ör. ücretsiz izin)
    #[serde(default)]
    pub exceptions: Vec<MonthException>,
    /// Gelir bir önceki ayın karşılığı (ör. 10 Ekim'de yatan maaş Eylül maaşıdır)
    #[serde(default)]
    pub covers_previous_month: bool,
    /// Başlangıç tarihi (YYYY-MM-DD); öncesindeki aylara uygulanmaz
    #[serde(default)]
    pub start_date: Option<String>,
    /// Gün hafta sonuna denk gelirse: "none" kaydırılmaz, "before" önceki Cuma, "after" sonraki Pazartesi
    #[serde(default = "weekend_none")]
    pub weekend_shift: String,
}

fn weekend_none() -> String {
    "none".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthException {
    /// YYYY-MM
    pub month: String,
    pub amount: f64,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmountChange {
    /// YYYY-MM-DD
    pub from: String,
    pub amount: f64,
}

fn yes() -> bool {
    true
}

/// Gider kategorisi için aylık bütçe limiti.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub category_id: String,
    pub amount: f64,
}

impl AccountInput {
    pub fn with_id(self, id: String) -> Account {
        Account {
            id,
            name: self.name,
            kind: self.kind,
            color: self.color,
            opening_balance: self.opening_balance,
            opening_date: self.opening_date,
            credit_limit: self.credit_limit,
            interest_rate: self.interest_rate,
            statement_day: self.statement_day,
            due_day: self.due_day,
            min_payment_rate: self.min_payment_rate,
            sort_order: self.sort_order,
            archived: self.archived,
            term_months: self.term_months,
            first_due_date: self.first_due_date,
            installment_amount: self.installment_amount,
            tax_rate: self.tax_rate,
            funding_income_id: self.funding_income_id,
            opening_period_spending: self.opening_period_spending,
            opening_installments: self.opening_installments,
        }
    }
}

const SCHEMA_V1: &str = "
CREATE TABLE IF NOT EXISTS categories (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    color       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (name, type)
);

CREATE TABLE IF NOT EXISTS transactions (
    id            TEXT PRIMARY KEY,
    amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
    type          TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
    date          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions (category_id);
";

pub const DEFAULT_ACCOUNT_NAME: &str = "Genel Hesap";

const SCHEMA_V2_TABLES: &str = "
CREATE TABLE accounts (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL UNIQUE,
    kind                  TEXT NOT NULL CHECK (kind IN ('bank', 'cash', 'credit_card')),
    color                 TEXT NOT NULL,
    opening_balance_cents INTEGER NOT NULL DEFAULT 0,
    opening_date          TEXT NOT NULL,
    credit_limit_cents    INTEGER,
    interest_rate_bp      INTEGER,
    statement_day         INTEGER CHECK (statement_day BETWEEN 1 AND 31),
    due_day               INTEGER CHECK (due_day BETWEEN 1 AND 31),
    min_payment_rate_bp   INTEGER,
    sort_order            INTEGER NOT NULL DEFAULT 0,
    archived              INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE transactions_new (
    id            TEXT PRIMARY KEY,
    amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
    type          TEXT NOT NULL CHECK (type IN ('income', 'expense', 'transfer')),
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    to_account_id TEXT REFERENCES accounts(id),
    category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
    date          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    installments  INTEGER NOT NULL DEFAULT 1 CHECK (installments BETWEEN 1 AND 36),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK ((type = 'transfer') = (to_account_id IS NOT NULL)),
    CHECK (type <> 'transfer' OR category_id IS NULL)
);
";

/// v3: hesap türüne 'loan' eklenir (CHECK değişemediği için tablo yeniden oluşturulur),
/// kredi alanları, düzenli gelir/giderler ve bütçeler.
const SCHEMA_V3: &str = "
CREATE TABLE accounts_new (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL UNIQUE,
    kind                  TEXT NOT NULL CHECK (kind IN ('bank', 'cash', 'credit_card', 'loan')),
    color                 TEXT NOT NULL,
    opening_balance_cents INTEGER NOT NULL DEFAULT 0,
    opening_date          TEXT NOT NULL,
    credit_limit_cents    INTEGER,
    interest_rate_bp      INTEGER,
    statement_day         INTEGER CHECK (statement_day BETWEEN 1 AND 31),
    due_day               INTEGER CHECK (due_day BETWEEN 1 AND 31),
    min_payment_rate_bp   INTEGER,
    sort_order            INTEGER NOT NULL DEFAULT 0,
    archived              INTEGER NOT NULL DEFAULT 0,
    term_months           INTEGER CHECK (term_months BETWEEN 1 AND 600),
    first_due_date        TEXT,
    installment_cents     INTEGER,
    tax_rate_bp           INTEGER,
    funding_income_id     TEXT,
    created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO accounts_new (id, name, kind, color, opening_balance_cents, opening_date, credit_limit_cents,
                          interest_rate_bp, statement_day, due_day, min_payment_rate_bp, sort_order, archived, created_at)
SELECT id, name, kind, color, opening_balance_cents, opening_date, credit_limit_cents,
       interest_rate_bp, statement_day, due_day, min_payment_rate_bp, sort_order, archived, created_at
FROM accounts;

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

CREATE TABLE recurring_items (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    type         TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    day          INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
    account_id   TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
    active       INTEGER NOT NULL DEFAULT 1,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE budgets (
    category_id  TEXT PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0)
);
";

/// v4: kart eklenirken girilen açık dönem harcaması ve devam eden taksitler.
const SCHEMA_V4: &str = "
ALTER TABLE accounts ADD COLUMN opening_period_cents INTEGER;
ALTER TABLE accounts ADD COLUMN opening_installments TEXT NOT NULL DEFAULT '[]';
";

pub const LATEST_VERSION: i64 = 15;

const DEFAULT_CATEGORIES: &[(&str, &str, &str)] = &[
    ("Maaş", "income", "#10b981"),
    ("Ek Gelir", "income", "#14b8a6"),
    ("Yatırım", "income", "#06b6d4"),
    ("Diğer Gelir", "income", "#84cc16"),
    ("Kira", "expense", "#f43f5e"),
    ("Market", "expense", "#f97316"),
    ("Faturalar", "expense", "#eab308"),
    ("Ulaşım", "expense", "#3b82f6"),
    ("Eğlence", "expense", "#a855f7"),
    ("Sağlık", "expense", "#ec4899"),
    ("Restoran", "expense", "#92400e"),
    ("Kafe", "expense", "#b45309"),
    ("Giyim", "expense", "#65a30d"),
    ("Abonelikler", "expense", "#0ea5e9"),
    ("Nakit Avans", "expense", "#d946ef"),
    ("Diğer Gider", "expense", "#64748b"),
];

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn open(path: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", true)?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version > LATEST_VERSION {
        // Daha yeni bir sürümün veritabanı: bilinmeyen sütunlar yazarken silinebileceği için açılmaz
        return Err(format!(
            "Bu veritabanı uygulamanın daha yeni bir sürümüyle oluşturulmuş (şema {version}); lütfen uygulamayı güncelleyin."
        )
        .into());
    }
    if version > 0 && version < LATEST_VERSION {
        // Migration'lar tabloları yeniden oluşturduğu için önce bir kopya alınır.
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("finans.db");
        std::fs::copy(path, path.with_file_name(format!("{name}.v{version}.bak")))?;
    }
    migrate(&conn)?;
    Ok(conn)
}

/// `PRAGMA user_version` ile basit, ileriye dönük şema sürümleme.
pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(SCHEMA_V1)?;
        for (name, kind, color) in DEFAULT_CATEGORIES {
            tx.execute(
                "INSERT OR IGNORE INTO categories (id, name, type, color) VALUES (?1, ?2, ?3, ?4)",
                (new_id(), name, kind, color),
            )?;
        }
        tx.execute_batch("PRAGMA user_version = 1;")?;
        tx.commit()?;
    }
    if version < 2 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(SCHEMA_V2_TABLES)?;
        let default_id = new_id();
        tx.execute(
            "INSERT INTO accounts (id, name, kind, color, opening_date)
             VALUES (?1, ?2, 'bank', '#6366f1',
                     COALESCE((SELECT MIN(date) FROM transactions), date('now', 'localtime')))",
            (&default_id, DEFAULT_ACCOUNT_NAME),
        )?;
        tx.execute(
            "INSERT INTO transactions_new (id, amount_cents, type, account_id, category_id, date, description, created_at)
             SELECT id, amount_cents, type, ?1, category_id, date, description, created_at FROM transactions",
            [&default_id],
        )?;
        tx.execute_batch(
            "DROP TABLE transactions;
             ALTER TABLE transactions_new RENAME TO transactions;
             CREATE INDEX idx_transactions_date ON transactions (date);
             CREATE INDEX idx_transactions_category ON transactions (category_id);
             CREATE INDEX idx_transactions_account ON transactions (account_id);
             CREATE INDEX idx_transactions_to_account ON transactions (to_account_id);",
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO categories (id, name, type, color) VALUES (?1, 'Faiz ve Masraflar', 'expense', '#78716c')",
            [new_id()],
        )?;
        tx.execute_batch("PRAGMA user_version = 2;")?;
        tx.commit()?;
    }
    if version < 3 {
        // Tablo yeniden oluşturulurken yabancı anahtar denetimi kapatılmalı (transaction dışında).
        conn.pragma_update(None, "foreign_keys", false)?;
        let result = (|| {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(SCHEMA_V3)?;
            let broken: i64 = tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0))?;
            if broken > 0 {
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                    Some("v3 migration: yabancı anahtar tutarsızlığı".into()),
                ));
            }
            tx.execute_batch("PRAGMA user_version = 3;")?;
            tx.commit()
        })();
        conn.pragma_update(None, "foreign_keys", true)?;
        result?;
    }
    if version < 4 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(SCHEMA_V4)?;
        tx.execute_batch("PRAGMA user_version = 4;")?;
        tx.commit()?;
    }
    if version < 5 {
        // v5: internet abonelikleri için varsayılan kategori
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO categories (id, name, type, color) VALUES (?1, 'Abonelikler', 'expense', '#0ea5e9')",
            [new_id()],
        )?;
        tx.execute_batch("PRAGMA user_version = 5;")?;
        tx.commit()?;
    }
    if version < 6 {
        // v6: düzenli gelir/giderlerde tarihli tutar değişiklikleri (zam, kira artışı)
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "ALTER TABLE recurring_items ADD COLUMN amount_history TEXT NOT NULL DEFAULT '[]';
             PRAGMA user_version = 6;",
        )?;
        tx.commit()?;
    }
    if version < 7 {
        // v7: düzenli kayıtlarda tek aya özel istisnalar (ücretsiz izin, eksik maaş)
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "ALTER TABLE recurring_items ADD COLUMN amount_exceptions TEXT NOT NULL DEFAULT '[]';
             PRAGMA user_version = 7;",
        )?;
        tx.commit()?;
    }
    if version < 8 {
        // v8: gelir bir önceki ayın karşılığı mı (maaş dönemi)
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "ALTER TABLE recurring_items ADD COLUMN covers_previous_month INTEGER NOT NULL DEFAULT 0;
             PRAGMA user_version = 8;",
        )?;
        tx.commit()?;
    }
    if version < 9 {
        // v9: düzenli kayıtlara başlangıç tarihi; mevcut kayıtlar eklendikleri günden başlar
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "ALTER TABLE recurring_items ADD COLUMN start_date TEXT;
             UPDATE recurring_items SET start_date = date(created_at, 'localtime');
             PRAGMA user_version = 9;",
        )?;
        tx.commit()?;
    }
    if version < 10 {
        // v10: gelirin bütçede sayılacağı ay
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "ALTER TABLE transactions ADD COLUMN budget_month TEXT;
             PRAGMA user_version = 10;",
        )?;
        tx.commit()?;
    }
    if version < 11 {
        // v11: kredi kartı nakit avansı için varsayılan kategori
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO categories (id, name, type, color) VALUES (?1, 'Nakit Avans', 'expense', '#d946ef')",
            [new_id()],
        )?;
        tx.execute_batch("PRAGMA user_version = 11;")?;
        tx.commit()?;
    }
    if version < 12 {
        // v12: düzenli kaydın hafta sonuna denk gelen günü (ör. maaş Cuma yatar)
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "ALTER TABLE recurring_items ADD COLUMN weekend_shift TEXT NOT NULL DEFAULT 'none';
             PRAGMA user_version = 12;",
        )?;
        tx.commit()?;
    }
    if version < 13 {
        // v13: grafikte birbirinden ayırt edilemeyen varsayılan renkler (Kira/Restoran kırmızı, Eğlence/Giyim mor);
        // kullanıcı rengi değiştirmediyse yenisi verilir
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "UPDATE categories SET color = '#92400e' WHERE name = 'Restoran' AND type = 'expense' AND lower(color) = '#ef4444';
             UPDATE categories SET color = '#65a30d' WHERE name = 'Giyim' AND type = 'expense' AND lower(color) = '#8b5cf6';
             PRAGMA user_version = 13;",
        )?;
        tx.commit()?;
    }
    if version < 14 {
        // v14: kahve/kafe harcamaları Restoran'dan ayrı izlensin diye varsayılan kategori
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO categories (id, name, type, color) VALUES (?1, 'Kafe', 'expense', '#b45309')",
            [new_id()],
        )?;
        tx.execute_batch("PRAGMA user_version = 14;")?;
        tx.commit()?;
    }
    if version < 15 {
        // v15: cihazlar arasında taşınacak uygulama ayarları (borç planı, analiz); daha önce cihazda (localStorage) tutuluyordu
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             PRAGMA user_version = 15;",
        )?;
        tx.commit()?;
    }
    // Gelecekteki şema değişiklikleri: if version < 16 { ... PRAGMA user_version = 16; }
    Ok(())
}

pub const CATEGORY_COLUMNS: &str = "id, name, type, color";
pub const ACCOUNT_COLUMNS: &str = "id, name, kind, color, opening_balance_cents, opening_date, credit_limit_cents, \
     interest_rate_bp, statement_day, due_day, min_payment_rate_bp, sort_order, archived, \
     term_months, first_due_date, installment_cents, tax_rate_bp, funding_income_id, \
     opening_period_cents, opening_installments";
pub const RECURRING_COLUMNS: &str =
    "id, name, type, amount_cents, day, account_id, category_id, active, sort_order, amount_history, amount_exceptions, \
     covers_previous_month, start_date, weekend_shift";
pub const TRANSACTION_COLUMNS: &str =
    "id, amount_cents, type, account_id, to_account_id, category_id, date, description, installments, created_at, budget_month";

fn cents_to_f64(c: i64) -> f64 {
    c as f64 / 100.0
}

pub fn row_to_category(r: &Row) -> rusqlite::Result<Category> {
    Ok(Category {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        color: r.get(3)?,
    })
}

/// `_cents` ve `_bp` (yüzde × 100) sütunları 100'e bölünerek ondalığa çevrilir.
pub fn row_to_account(r: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        color: r.get(3)?,
        opening_balance: cents_to_f64(r.get(4)?),
        opening_date: r.get(5)?,
        credit_limit: r.get::<_, Option<i64>>(6)?.map(cents_to_f64),
        interest_rate: r.get::<_, Option<i64>>(7)?.map(cents_to_f64),
        statement_day: r.get(8)?,
        due_day: r.get(9)?,
        min_payment_rate: r.get::<_, Option<i64>>(10)?.map(cents_to_f64),
        sort_order: r.get(11)?,
        archived: r.get::<_, i64>(12)? != 0,
        term_months: r.get(13)?,
        first_due_date: r.get(14)?,
        installment_amount: r.get::<_, Option<i64>>(15)?.map(cents_to_f64),
        tax_rate: r.get::<_, Option<i64>>(16)?.map(cents_to_f64),
        funding_income_id: r.get(17)?,
        opening_period_spending: r.get::<_, Option<i64>>(18)?.map(cents_to_f64),
        opening_installments: serde_json::from_str(&r.get::<_, String>(19)?).unwrap_or_default(),
    })
}

pub fn row_to_recurring(r: &Row) -> rusqlite::Result<RecurringItem> {
    Ok(RecurringItem {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        amount: cents_to_f64(r.get(3)?),
        day: r.get(4)?,
        account_id: r.get(5)?,
        category_id: r.get(6)?,
        active: r.get::<_, i64>(7)? != 0,
        sort_order: r.get(8)?,
        history: serde_json::from_str(&r.get::<_, String>(9)?).unwrap_or_default(),
        exceptions: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or_default(),
        covers_previous_month: r.get::<_, i64>(11)? != 0,
        start_date: r.get(12)?,
        weekend_shift: r.get(13)?,
    })
}

pub fn row_to_transaction(r: &Row) -> rusqlite::Result<Transaction> {
    Ok(Transaction {
        id: r.get(0)?,
        amount: cents_to_f64(r.get(1)?),
        kind: r.get(2)?,
        account_id: r.get(3)?,
        to_account_id: r.get(4)?,
        category_id: r.get(5)?,
        date: r.get(6)?,
        description: r.get(7)?,
        installments: r.get(8)?,
        created_at: r.get(9)?,
        budget_month: r.get(10)?,
    })
}
