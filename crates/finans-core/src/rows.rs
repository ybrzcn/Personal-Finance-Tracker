//! Doğrulanmış, veritabanına yazılmaya hazır satırlar (SQLite ve Postgres depoları ortak kullanır).

pub struct AccountRow {
    pub name: String,
    pub kind: String,
    pub color: String,
    pub opening_cents: i64,
    pub opening_date: String,
    pub limit_cents: Option<i64>,
    pub rate_bp: Option<i64>,
    pub statement_day: Option<i64>,
    pub due_day: Option<i64>,
    pub min_rate_bp: Option<i64>,
    pub sort_order: i64,
    pub archived: bool,
    pub term_months: Option<i64>,
    pub first_due_date: Option<String>,
    pub installment_cents: Option<i64>,
    pub tax_rate_bp: Option<i64>,
    pub funding_income_id: Option<String>,
    pub opening_period_cents: Option<i64>,
    /// JSON dizisi
    pub opening_installments: String,
    pub currency: String,
}

pub struct RecurringRow {
    pub name: String,
    pub kind: String,
    pub cents: i64,
    pub day: i64,
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub active: bool,
    pub sort_order: i64,
    /// JSON dizisi, tarihe göre sıralı
    pub history: String,
    /// JSON dizisi, aya göre sıralı
    pub exceptions: String,
    pub covers_previous_month: bool,
    pub start_date: Option<String>,
    pub weekend_shift: String,
    pub orig_amount: Option<i64>,
}

pub struct TransactionRow {
    pub id: String,
    pub amount_cents: i64,
    pub kind: String,
    pub account_id: String,
    pub to_account_id: Option<String>,
    pub category_id: Option<String>,
    pub date: String,
    pub description: String,
    pub installments: i64,
    pub budget_month: Option<String>,
    /// Yalnız geri yüklemede verilir (`YYYY-MM-DDTHH:MM:SS[.fff]Z`); None = şimdi
    pub created_at: Option<String>,
    pub orig_amount: Option<i64>,
    pub fx_rate: Option<i64>,
    pub to_orig_amount: Option<i64>,
    pub to_fx_rate: Option<i64>,
}

/// İş kurallarının ihtiyaç duyduğu hesap bilgisi.
pub struct AccountMeta {
    pub kind: String,
    pub archived: bool,
    pub currency: String,
}
