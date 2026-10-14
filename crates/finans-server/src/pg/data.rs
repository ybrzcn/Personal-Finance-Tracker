//! `DataStore`'un Postgres uygulaması. Her sorgu `user_id` ile süzülür (RLS ayrıca korur).

use finans_core::data_store::DataStore;
use finans_core::db::{cents_to_f64, Account, Budget, Category, RecurringItem, Transaction};
use finans_core::rows::{AccountRow, RecurringRow, TransactionRow};
use finans_core::CoreResult;
use postgres::Row;

use super::pg_err;

pub struct PgStore<'a, 't> {
    pub tx: &'a mut postgres::Transaction<'t>,
    pub user_id: String,
}

const CATEGORY_COLUMNS: &str = "id, name, type, color";
const ACCOUNT_COLUMNS: &str = "id, name, kind, color, opening_balance_cents, opening_date::text, credit_limit_cents, \
     interest_rate_bp, statement_day, due_day, min_payment_rate_bp, sort_order, archived, term_months, \
     first_due_date::text, installment_cents, tax_rate_bp, funding_income_id, opening_period_cents, opening_installments::text";
const RECURRING_COLUMNS: &str = "id, name, type, amount_cents, day, account_id, category_id, active, sort_order, \
     amount_history::text, amount_exceptions::text, covers_previous_month, start_date::text, weekend_shift";
const TRANSACTION_COLUMNS: &str = "id, amount_cents, type, account_id, to_account_id, category_id, date::text, description, \
     installments, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), budget_month";

fn category(r: &Row) -> Category {
    Category { id: r.get(0), name: r.get(1), kind: r.get(2), color: r.get(3) }
}

fn account(r: &Row) -> Account {
    let opt = |i: usize| r.get::<_, Option<i64>>(i).map(cents_to_f64);
    Account {
        id: r.get(0),
        name: r.get(1),
        kind: r.get(2),
        color: r.get(3),
        opening_balance: cents_to_f64(r.get(4)),
        opening_date: r.get(5),
        credit_limit: opt(6),
        interest_rate: opt(7),
        statement_day: r.get(8),
        due_day: r.get(9),
        min_payment_rate: opt(10),
        sort_order: r.get(11),
        archived: r.get(12),
        term_months: r.get(13),
        first_due_date: r.get(14),
        installment_amount: opt(15),
        tax_rate: opt(16),
        funding_income_id: r.get(17),
        opening_period_spending: opt(18),
        opening_installments: serde_json::from_str(r.get::<_, &str>(19)).unwrap_or_default(),
    }
}

fn recurring(r: &Row) -> RecurringItem {
    RecurringItem {
        id: r.get(0),
        name: r.get(1),
        kind: r.get(2),
        amount: cents_to_f64(r.get(3)),
        day: r.get(4),
        account_id: r.get(5),
        category_id: r.get(6),
        active: r.get(7),
        sort_order: r.get(8),
        history: serde_json::from_str(r.get::<_, &str>(9)).unwrap_or_default(),
        exceptions: serde_json::from_str(r.get::<_, &str>(10)).unwrap_or_default(),
        covers_previous_month: r.get(11),
        start_date: r.get(12),
        weekend_shift: r.get(13),
    }
}

fn transaction(r: &Row) -> Transaction {
    Transaction {
        id: r.get(0),
        amount: cents_to_f64(r.get(1)),
        kind: r.get(2),
        account_id: r.get(3),
        to_account_id: r.get(4),
        category_id: r.get(5),
        date: r.get(6),
        description: r.get(7),
        installments: r.get(8),
        created_at: r.get(9),
        budget_month: r.get(10),
    }
}

impl PgStore<'_, '_> {
    fn list<T>(&mut self, sql: &str, map: fn(&Row) -> T) -> CoreResult<Vec<T>> {
        Ok(self.tx.query(sql, &[&self.user_id]).map_err(pg_err)?.iter().map(map).collect())
    }

    fn one<T>(&mut self, sql: &str, id: &str, map: fn(&Row) -> T) -> CoreResult<Option<T>> {
        Ok(self.tx.query_opt(sql, &[&self.user_id, &id]).map_err(pg_err)?.as_ref().map(map))
    }

    fn exec(&mut self, sql: &str, params: &[&(dyn postgres::types::ToSql + Sync)]) -> CoreResult<u64> {
        self.tx.execute(sql, params).map_err(pg_err)
    }

    fn count(&mut self, sql: &str, params: &[&(dyn postgres::types::ToSql + Sync)]) -> CoreResult<i64> {
        Ok(self.tx.query_one(sql, params).map_err(pg_err)?.get(0))
    }
}

impl DataStore for PgStore<'_, '_> {
    fn list_categories(&mut self) -> CoreResult<Vec<Category>> {
        self.list(
            &format!("SELECT {CATEGORY_COLUMNS} FROM categories WHERE user_id = $1 ORDER BY type DESC, lower(name COLLATE \"C\")"),
            category,
        )
    }

    fn get_category(&mut self, id: &str) -> CoreResult<Option<Category>> {
        self.one(&format!("SELECT {CATEGORY_COLUMNS} FROM categories WHERE user_id = $1 AND id = $2"), id, category)
    }

    fn insert_category(&mut self, id: &str, name: &str, kind: &str, color: &str) -> CoreResult<()> {
        let u = self.user_id.clone();
        self.exec("INSERT INTO categories (user_id, id, name, type, color) VALUES ($1, $2, $3, $4, $5)", &[&u, &id, &name, &kind, &color])?;
        Ok(())
    }

    fn update_category(&mut self, id: &str, name: &str, kind: &str, color: &str) -> CoreResult<u64> {
        let u = self.user_id.clone();
        self.exec("UPDATE categories SET name = $3, type = $4, color = $5 WHERE user_id = $1 AND id = $2", &[&u, &id, &name, &kind, &color])
    }

    fn delete_category(&mut self, id: &str) -> CoreResult<()> {
        let u = self.user_id.clone();
        self.exec("UPDATE transactions SET category_id = NULL WHERE user_id = $1 AND category_id = $2", &[&u, &id])?;
        self.exec("DELETE FROM categories WHERE user_id = $1 AND id = $2", &[&u, &id])?;
        Ok(())
    }

    fn category_conflicts(&mut self, id: &str, kind: &str) -> CoreResult<(i64, i64, i64)> {
        let u = self.user_id.clone();
        let row = self
            .tx
            .query_one(
                "SELECT (SELECT COUNT(*) FROM transactions WHERE user_id = $1 AND category_id = $2 AND type <> $3),
                        (SELECT COUNT(*) FROM recurring_items WHERE user_id = $1 AND category_id = $2 AND type <> $3),
                        (SELECT COUNT(*) FROM budgets WHERE user_id = $1 AND category_id = $2)",
                &[&u, &id, &kind],
            )
            .map_err(pg_err)?;
        Ok((row.get(0), row.get(1), row.get(2)))
    }

    fn list_accounts(&mut self) -> CoreResult<Vec<Account>> {
        self.list(
            &format!("SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE user_id = $1 ORDER BY sort_order, lower(name COLLATE \"C\")"),
            account,
        )
    }

    fn get_account(&mut self, id: &str) -> CoreResult<Option<Account>> {
        self.one(&format!("SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE user_id = $1 AND id = $2"), id, account)
    }

    fn account_meta(&mut self, id: &str) -> CoreResult<Option<(String, bool)>> {
        self.one("SELECT kind, archived FROM accounts WHERE user_id = $1 AND id = $2", id, |r| (r.get(0), r.get(1)))
    }

    fn account_usage(&mut self, id: &str) -> CoreResult<i64> {
        let u = self.user_id.clone();
        self.count("SELECT COUNT(*) FROM transactions WHERE user_id = $1 AND (account_id = $2 OR to_account_id = $2)", &[&u, &id])
    }

    fn insert_account(&mut self, id: &str, r: &AccountRow) -> CoreResult<()> {
        let u = self.user_id.clone();
        self.exec(
            "INSERT INTO accounts (user_id, id, name, kind, color, opening_balance_cents, opening_date, credit_limit_cents,
                                   interest_rate_bp, statement_day, due_day, min_payment_rate_bp, sort_order, archived,
                                   term_months, first_due_date, installment_cents, tax_rate_bp, funding_income_id,
                                   opening_period_cents, opening_installments)
             VALUES ($1, $2, $3, $4, $5, $6, $7::text::date, $8, $9, $10, $11, $12, $13, $14, $15, $16::text::date, $17, $18, $19,
                     $20, $21::text::jsonb)",
            &[
                &u, &id, &r.name, &r.kind, &r.color, &r.opening_cents, &r.opening_date, &r.limit_cents, &r.rate_bp,
                &r.statement_day, &r.due_day, &r.min_rate_bp, &r.sort_order, &r.archived, &r.term_months, &r.first_due_date,
                &r.installment_cents, &r.tax_rate_bp, &r.funding_income_id, &r.opening_period_cents, &r.opening_installments,
            ],
        )?;
        Ok(())
    }

    fn update_account(&mut self, id: &str, r: &AccountRow) -> CoreResult<u64> {
        let u = self.user_id.clone();
        self.exec(
            "UPDATE accounts SET name = $3, kind = $4, color = $5, opening_balance_cents = $6, opening_date = $7::text::date,
                    credit_limit_cents = $8, interest_rate_bp = $9, statement_day = $10, due_day = $11,
                    min_payment_rate_bp = $12, sort_order = $13, archived = $14, term_months = $15,
                    first_due_date = $16::text::date, installment_cents = $17, tax_rate_bp = $18, funding_income_id = $19,
                    opening_period_cents = $20, opening_installments = $21::text::jsonb
             WHERE user_id = $1 AND id = $2",
            &[
                &u, &id, &r.name, &r.kind, &r.color, &r.opening_cents, &r.opening_date, &r.limit_cents, &r.rate_bp,
                &r.statement_day, &r.due_day, &r.min_rate_bp, &r.sort_order, &r.archived, &r.term_months, &r.first_due_date,
                &r.installment_cents, &r.tax_rate_bp, &r.funding_income_id, &r.opening_period_cents, &r.opening_installments,
            ],
        )
    }

    fn delete_account(&mut self, id: &str) -> CoreResult<()> {
        let u = self.user_id.clone();
        self.exec("DELETE FROM accounts WHERE user_id = $1 AND id = $2", &[&u, &id])?;
        Ok(())
    }

    fn list_transactions(&mut self) -> CoreResult<Vec<Transaction>> {
        self.list(
            &format!("SELECT {TRANSACTION_COLUMNS} FROM transactions WHERE user_id = $1 ORDER BY date DESC, created_at DESC"),
            transaction,
        )
    }

    fn get_transaction(&mut self, id: &str) -> CoreResult<Option<Transaction>> {
        self.one(&format!("SELECT {TRANSACTION_COLUMNS} FROM transactions WHERE user_id = $1 AND id = $2"), id, transaction)
    }

    fn insert_transaction(&mut self, r: &TransactionRow) -> CoreResult<()> {
        let u = self.user_id.clone();
        self.exec(
            "INSERT INTO transactions (user_id, id, amount_cents, type, account_id, to_account_id, category_id, date, description,
                                       installments, budget_month, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::date, $9, $10, $11, COALESCE($12::text::timestamptz, now()))",
            &[
                &u, &r.id, &r.amount_cents, &r.kind, &r.account_id, &r.to_account_id, &r.category_id, &r.date, &r.description,
                &r.installments, &r.budget_month, &r.created_at,
            ],
        )?;
        Ok(())
    }

    fn update_transaction(&mut self, r: &TransactionRow) -> CoreResult<u64> {
        let u = self.user_id.clone();
        self.exec(
            "UPDATE transactions
             SET amount_cents = $3, type = $4, account_id = $5, to_account_id = $6, category_id = $7,
                 date = $8::text::date, description = $9, installments = $10, budget_month = $11
             WHERE user_id = $1 AND id = $2",
            &[
                &u, &r.id, &r.amount_cents, &r.kind, &r.account_id, &r.to_account_id, &r.category_id, &r.date, &r.description,
                &r.installments, &r.budget_month,
            ],
        )
    }

    fn delete_transaction(&mut self, id: &str) -> CoreResult<()> {
        let u = self.user_id.clone();
        self.exec("DELETE FROM transactions WHERE user_id = $1 AND id = $2", &[&u, &id])?;
        Ok(())
    }

    fn list_recurring(&mut self) -> CoreResult<Vec<RecurringItem>> {
        self.list(
            &format!("SELECT {RECURRING_COLUMNS} FROM recurring_items WHERE user_id = $1 ORDER BY type DESC, day, sort_order"),
            recurring,
        )
    }

    fn get_recurring(&mut self, id: &str) -> CoreResult<Option<RecurringItem>> {
        self.one(&format!("SELECT {RECURRING_COLUMNS} FROM recurring_items WHERE user_id = $1 AND id = $2"), id, recurring)
    }

    fn insert_recurring(&mut self, id: &str, r: &RecurringRow) -> CoreResult<()> {
        let u = self.user_id.clone();
        self.exec(
            "INSERT INTO recurring_items (user_id, id, name, type, amount_cents, day, account_id, category_id, active, sort_order,
                                          amount_history, amount_exceptions, covers_previous_month, start_date, weekend_shift)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb, $12::text::jsonb, $13, $14::text::date, $15)",
            &[
                &u, &id, &r.name, &r.kind, &r.cents, &r.day, &r.account_id, &r.category_id, &r.active, &r.sort_order, &r.history,
                &r.exceptions, &r.covers_previous_month, &r.start_date, &r.weekend_shift,
            ],
        )?;
        Ok(())
    }

    fn update_recurring(&mut self, id: &str, r: &RecurringRow) -> CoreResult<u64> {
        let u = self.user_id.clone();
        self.exec(
            "UPDATE recurring_items SET name = $3, type = $4, amount_cents = $5, day = $6, account_id = $7,
                    category_id = $8, active = $9, sort_order = $10, amount_history = $11::text::jsonb,
                    amount_exceptions = $12::text::jsonb, covers_previous_month = $13, start_date = $14::text::date,
                    weekend_shift = $15
             WHERE user_id = $1 AND id = $2",
            &[
                &u, &id, &r.name, &r.kind, &r.cents, &r.day, &r.account_id, &r.category_id, &r.active, &r.sort_order, &r.history,
                &r.exceptions, &r.covers_previous_month, &r.start_date, &r.weekend_shift,
            ],
        )
    }

    fn delete_recurring(&mut self, id: &str) -> CoreResult<()> {
        let u = self.user_id.clone();
        self.exec("DELETE FROM recurring_items WHERE user_id = $1 AND id = $2", &[&u, &id])?;
        Ok(())
    }

    fn clear_funding_income(&mut self, recurring_id: &str) -> CoreResult<()> {
        let u = self.user_id.clone();
        self.exec("UPDATE accounts SET funding_income_id = NULL WHERE user_id = $1 AND funding_income_id = $2", &[&u, &recurring_id])?;
        Ok(())
    }

    fn clear_dangling_funding(&mut self) -> CoreResult<()> {
        let u = self.user_id.clone();
        self.exec(
            "UPDATE accounts SET funding_income_id = NULL
             WHERE user_id = $1 AND funding_income_id IS NOT NULL
               AND funding_income_id NOT IN (SELECT id FROM recurring_items WHERE user_id = $1 AND type = 'income')",
            &[&u],
        )?;
        Ok(())
    }

    fn list_budgets(&mut self) -> CoreResult<Vec<Budget>> {
        self.list("SELECT category_id, amount_cents FROM budgets WHERE user_id = $1", |r| Budget {
            category_id: r.get(0),
            amount: r.get::<_, i64>(1) as f64 / 100.0,
        })
    }

    fn upsert_budget(&mut self, category_id: &str, amount_cents: i64) -> CoreResult<()> {
        let u = self.user_id.clone();
        self.exec(
            "INSERT INTO budgets (user_id, category_id, amount_cents) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, category_id) DO UPDATE SET amount_cents = EXCLUDED.amount_cents",
            &[&u, &category_id, &amount_cents],
        )?;
        Ok(())
    }

    fn delete_budget(&mut self, category_id: &str) -> CoreResult<()> {
        let u = self.user_id.clone();
        self.exec("DELETE FROM budgets WHERE user_id = $1 AND category_id = $2", &[&u, &category_id])?;
        Ok(())
    }

    fn list_settings(&mut self) -> CoreResult<Vec<(String, String)>> {
        self.list("SELECT key, value::text FROM settings WHERE user_id = $1", |r| (r.get(0), r.get(1)))
    }

    fn upsert_setting(&mut self, key: &str, json: &str) -> CoreResult<()> {
        let u = self.user_id.clone();
        self.exec(
            "INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3::text::jsonb)
             ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value",
            &[&u, &key, &json],
        )?;
        Ok(())
    }

    fn clear_all(&mut self) -> CoreResult<()> {
        let u = self.user_id.clone();
        for table in ["budgets", "recurring_items", "transactions", "accounts", "categories"] {
            self.exec(&format!("DELETE FROM {table} WHERE user_id = $1"), &[&u])?;
        }
        Ok(())
    }
}
