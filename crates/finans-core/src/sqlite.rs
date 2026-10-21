//! `DataStore`'un SQLite uygulaması (masaüstü, mobil ve SQLite modundaki sunucu).

use rusqlite::{params, Connection, ErrorCode, OptionalExtension};

use crate::data_store::DataStore;
use crate::db::{
    row_to_account, row_to_category, row_to_recurring, row_to_transaction, Account, Budget, Category, Goal, RecurringItem, Tag,
    Transaction, ACCOUNT_COLUMNS, CATEGORY_COLUMNS, RECURRING_COLUMNS, TRANSACTION_COLUMNS,
};
use crate::fx;
use crate::rows::{AccountMeta, AccountRow, GoalRow, RecurringRow, TagRow, TransactionRow};
use crate::CoreResult;

pub fn db_err(e: rusqlite::Error) -> String {
    match &e {
        rusqlite::Error::SqliteFailure(f, msg)
            if f.code == ErrorCode::ConstraintViolation
                && f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
                && msg.as_deref().is_some_and(|m| m.contains("goal_accounts")) =>
        {
            "Bu hesap zaten başka bir hedefe bağlı.".into()
        }
        rusqlite::Error::SqliteFailure(f, msg)
            if f.code == ErrorCode::ConstraintViolation
                && f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            if msg.as_deref().is_some_and(|m| m.contains("tags_name_unique")) {
                "Bu adda bir etiket zaten var.".into()
            } else if msg.as_deref().is_some_and(|m| m.contains("accounts.name")) {
                "Bu isimde bir hesap zaten mevcut.".into()
            } else {
                "Bu isimde ve türde bir kategori zaten mevcut.".into()
            }
        }
        _ => format!("Veritabanı hatası: {e}"),
    }
}

/// `f`'i tek bir SQLite işleminde çalıştırır; hata dönerse hiçbir değişiklik kalmaz.
pub fn run<T>(conn: &mut Connection, f: impl FnOnce(&mut dyn DataStore) -> CoreResult<T>) -> CoreResult<T> {
    let tx = conn.transaction().map_err(db_err)?;
    let out = f(&mut SqliteStore { conn: &tx })?;
    tx.commit().map_err(db_err)?;
    Ok(out)
}

pub struct SqliteStore<'c> {
    pub conn: &'c Connection,
}

impl SqliteStore<'_> {
    fn list<T>(&self, sql: &str, map: fn(&rusqlite::Row) -> rusqlite::Result<T>) -> CoreResult<Vec<T>> {
        let mut stmt = self.conn.prepare(sql).map_err(db_err)?;
        let rows = stmt.query_map([], map).map_err(db_err)?.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
        Ok(rows)
    }

    fn one<T>(&self, sql: &str, id: &str, map: fn(&rusqlite::Row) -> rusqlite::Result<T>) -> CoreResult<Option<T>> {
        self.conn.query_row(sql, [id], map).optional().map_err(db_err)
    }

    fn count(&self, sql: &str, p: impl rusqlite::Params) -> CoreResult<i64> {
        self.conn.query_row(sql, p, |r| r.get(0)).map_err(db_err)
    }

    fn goals_where(&self, filter: &str, id: Option<&str>) -> CoreResult<Vec<Goal>> {
        let sql = format!(
            "SELECT id, name, currency, target_minor, target_date, color, archived, created_at FROM goals {filter} ORDER BY created_at, id"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(db_err)?;
        let map = |r: &rusqlite::Row| {
            let currency: String = r.get(2)?;
            let unit = fx::unit_or_try(Some(&currency));
            Ok(Goal {
                id: r.get(0)?,
                name: r.get(1)?,
                target: fx::amount::minor_to_value(r.get(3)?, unit),
                currency,
                target_date: r.get(4)?,
                color: r.get(5)?,
                archived: r.get(6)?,
                account_ids: Vec::new(),
                created_at: r.get(7)?,
            })
        };
        let mut goals = match id {
            Some(id) => stmt.query_map([id], map),
            None => stmt.query_map([], map),
        }
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
        let links = self.list("SELECT goal_id, account_id FROM goal_accounts ORDER BY account_id", |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for g in &mut goals {
            g.account_ids = links.iter().filter(|(gid, _)| *gid == g.id).map(|(_, a)| a.clone()).collect();
        }
        Ok(goals)
    }

    fn link_accounts(&self, id: &str, ids: &[String]) -> CoreResult<()> {
        self.conn.execute("DELETE FROM goal_accounts WHERE goal_id = ?1", [id]).map_err(db_err)?;
        for a in ids {
            self.conn
                .execute("INSERT INTO goal_accounts (account_id, goal_id) VALUES (?1, ?2)", [a, id])
                .map_err(db_err)?;
        }
        Ok(())
    }
}

impl DataStore for SqliteStore<'_> {
    fn list_categories(&mut self) -> CoreResult<Vec<Category>> {
        self.list(&format!("SELECT {CATEGORY_COLUMNS} FROM categories ORDER BY type DESC, name COLLATE NOCASE"), row_to_category)
    }

    fn get_category(&mut self, id: &str) -> CoreResult<Option<Category>> {
        self.one(&format!("SELECT {CATEGORY_COLUMNS} FROM categories WHERE id = ?1"), id, row_to_category)
    }

    fn insert_category(&mut self, id: &str, name: &str, kind: &str, color: &str) -> CoreResult<()> {
        self.conn
            .execute("INSERT INTO categories (id, name, type, color) VALUES (?1, ?2, ?3, ?4)", (id, name, kind, color))
            .map_err(db_err)?;
        Ok(())
    }

    fn update_category(&mut self, id: &str, name: &str, kind: &str, color: &str) -> CoreResult<u64> {
        let n = self
            .conn
            .execute("UPDATE categories SET name = ?2, type = ?3, color = ?4 WHERE id = ?1", (id, name, kind, color))
            .map_err(db_err)?;
        Ok(n as u64)
    }

    fn delete_category(&mut self, id: &str) -> CoreResult<()> {
        self.conn.execute("UPDATE transactions SET category_id = NULL WHERE category_id = ?1", [id]).map_err(db_err)?;
        self.conn.execute("DELETE FROM categories WHERE id = ?1", [id]).map_err(db_err)?;
        Ok(())
    }

    fn category_conflicts(&mut self, id: &str, kind: &str) -> CoreResult<(i64, i64, i64)> {
        Ok((
            self.count("SELECT COUNT(*) FROM transactions WHERE category_id = ?1 AND type <> ?2", (id, kind))?,
            self.count("SELECT COUNT(*) FROM recurring_items WHERE category_id = ?1 AND type <> ?2", (id, kind))?,
            self.count("SELECT COUNT(*) FROM budgets WHERE category_id = ?1", [id])?,
        ))
    }

    fn list_accounts(&mut self) -> CoreResult<Vec<Account>> {
        self.list(&format!("SELECT {ACCOUNT_COLUMNS} FROM accounts ORDER BY sort_order, name COLLATE NOCASE"), row_to_account)
    }

    fn get_account(&mut self, id: &str) -> CoreResult<Option<Account>> {
        self.one(&format!("SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE id = ?1"), id, row_to_account)
    }

    fn account_meta(&mut self, id: &str) -> CoreResult<Option<AccountMeta>> {
        self.one("SELECT kind, archived, currency FROM accounts WHERE id = ?1", id, |r| {
            Ok(AccountMeta { kind: r.get(0)?, archived: r.get::<_, i64>(1)? != 0, currency: r.get(2)? })
        })
    }

    fn account_usage(&mut self, id: &str) -> CoreResult<i64> {
        self.count("SELECT COUNT(*) FROM transactions WHERE account_id = ?1 OR to_account_id = ?1", [id])
    }

    fn insert_account(&mut self, id: &str, r: &AccountRow) -> CoreResult<()> {
        self.conn
            .execute(
                "INSERT INTO accounts (id, name, kind, color, opening_balance_cents, opening_date, credit_limit_cents,
                                       interest_rate_bp, statement_day, due_day, min_payment_rate_bp, sort_order, archived,
                                       term_months, first_due_date, installment_cents, tax_rate_bp, funding_income_id,
                                       opening_period_cents, opening_installments, currency, opening_cost_cents)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
                params![
                    id, r.name, r.kind, r.color, r.opening_cents, r.opening_date, r.limit_cents, r.rate_bp,
                    r.statement_day, r.due_day, r.min_rate_bp, r.sort_order, r.archived, r.term_months,
                    r.first_due_date, r.installment_cents, r.tax_rate_bp, r.funding_income_id, r.opening_period_cents,
                    r.opening_installments, r.currency, r.opening_cost_cents
                ],
            )
            .map_err(db_err)?;
        Ok(())
    }

    fn update_account(&mut self, id: &str, r: &AccountRow) -> CoreResult<u64> {
        let n = self
            .conn
            .execute(
                "UPDATE accounts SET name = ?2, kind = ?3, color = ?4, opening_balance_cents = ?5, opening_date = ?6,
                        credit_limit_cents = ?7, interest_rate_bp = ?8, statement_day = ?9, due_day = ?10,
                        min_payment_rate_bp = ?11, sort_order = ?12, archived = ?13, term_months = ?14,
                        first_due_date = ?15, installment_cents = ?16, tax_rate_bp = ?17, funding_income_id = ?18,
                        opening_period_cents = ?19, opening_installments = ?20, currency = ?21, opening_cost_cents = ?22
                 WHERE id = ?1",
                params![
                    id, r.name, r.kind, r.color, r.opening_cents, r.opening_date, r.limit_cents, r.rate_bp,
                    r.statement_day, r.due_day, r.min_rate_bp, r.sort_order, r.archived, r.term_months,
                    r.first_due_date, r.installment_cents, r.tax_rate_bp, r.funding_income_id, r.opening_period_cents,
                    r.opening_installments, r.currency, r.opening_cost_cents
                ],
            )
            .map_err(db_err)?;
        Ok(n as u64)
    }

    fn delete_account(&mut self, id: &str) -> CoreResult<()> {
        self.conn.execute("DELETE FROM accounts WHERE id = ?1", [id]).map_err(db_err)?;
        Ok(())
    }

    fn list_transactions(&mut self) -> CoreResult<Vec<Transaction>> {
        self.list(&format!("SELECT {TRANSACTION_COLUMNS} FROM transactions ORDER BY date DESC, created_at DESC"), row_to_transaction)
    }

    fn get_transaction(&mut self, id: &str) -> CoreResult<Option<Transaction>> {
        self.one(&format!("SELECT {TRANSACTION_COLUMNS} FROM transactions WHERE id = ?1"), id, row_to_transaction)
    }

    fn insert_transaction(&mut self, r: &TransactionRow) -> CoreResult<()> {
        self.conn
            .execute(
                "INSERT INTO transactions (id, amount_cents, type, account_id, to_account_id, category_id, date, description,
                                           installments, budget_month, created_at, orig_amount, fx_rate, to_orig_amount, to_fx_rate)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE(?11, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                         ?12, ?13, ?14, ?15)",
                params![
                    r.id, r.amount_cents, r.kind, r.account_id, r.to_account_id, r.category_id, r.date, r.description,
                    r.installments, r.budget_month, r.created_at, r.orig_amount, r.fx_rate, r.to_orig_amount, r.to_fx_rate
                ],
            )
            .map_err(db_err)?;
        Ok(())
    }

    fn update_transaction(&mut self, r: &TransactionRow) -> CoreResult<u64> {
        let n = self
            .conn
            .execute(
                "UPDATE transactions
                 SET amount_cents = ?2, type = ?3, account_id = ?4, to_account_id = ?5, category_id = ?6,
                     date = ?7, description = ?8, installments = ?9, budget_month = ?10,
                     orig_amount = ?11, fx_rate = ?12, to_orig_amount = ?13, to_fx_rate = ?14
                 WHERE id = ?1",
                params![
                    r.id, r.amount_cents, r.kind, r.account_id, r.to_account_id, r.category_id, r.date, r.description,
                    r.installments, r.budget_month, r.orig_amount, r.fx_rate, r.to_orig_amount, r.to_fx_rate
                ],
            )
            .map_err(db_err)?;
        Ok(n as u64)
    }

    fn delete_transaction(&mut self, id: &str) -> CoreResult<()> {
        self.conn.execute("DELETE FROM transactions WHERE id = ?1", [id]).map_err(db_err)?;
        Ok(())
    }

    fn list_recurring(&mut self) -> CoreResult<Vec<RecurringItem>> {
        self.list(&format!("SELECT {RECURRING_COLUMNS} FROM recurring_items ORDER BY type DESC, day, sort_order"), row_to_recurring)
    }

    fn get_recurring(&mut self, id: &str) -> CoreResult<Option<RecurringItem>> {
        self.one(&format!("SELECT {RECURRING_COLUMNS} FROM recurring_items WHERE id = ?1"), id, row_to_recurring)
    }

    fn insert_recurring(&mut self, id: &str, r: &RecurringRow) -> CoreResult<()> {
        self.conn
            .execute(
                "INSERT INTO recurring_items (id, name, type, amount_cents, day, account_id, category_id, active, sort_order,
                                              amount_history, amount_exceptions, covers_previous_month, start_date, weekend_shift,
                                              orig_amount)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    id, r.name, r.kind, r.cents, r.day, r.account_id, r.category_id, r.active, r.sort_order, r.history,
                    r.exceptions, r.covers_previous_month, r.start_date, r.weekend_shift, r.orig_amount
                ],
            )
            .map_err(db_err)?;
        Ok(())
    }

    fn update_recurring(&mut self, id: &str, r: &RecurringRow) -> CoreResult<u64> {
        let n = self
            .conn
            .execute(
                "UPDATE recurring_items SET name = ?2, type = ?3, amount_cents = ?4, day = ?5, account_id = ?6,
                        category_id = ?7, active = ?8, sort_order = ?9, amount_history = ?10, amount_exceptions = ?11,
                        covers_previous_month = ?12, start_date = ?13, weekend_shift = ?14, orig_amount = ?15
                 WHERE id = ?1",
                params![
                    id, r.name, r.kind, r.cents, r.day, r.account_id, r.category_id, r.active, r.sort_order, r.history,
                    r.exceptions, r.covers_previous_month, r.start_date, r.weekend_shift, r.orig_amount
                ],
            )
            .map_err(db_err)?;
        Ok(n as u64)
    }

    fn delete_recurring(&mut self, id: &str) -> CoreResult<()> {
        self.conn.execute("DELETE FROM recurring_items WHERE id = ?1", [id]).map_err(db_err)?;
        Ok(())
    }

    fn clear_funding_income(&mut self, recurring_id: &str) -> CoreResult<()> {
        self.conn
            .execute("UPDATE accounts SET funding_income_id = NULL WHERE funding_income_id = ?1", [recurring_id])
            .map_err(db_err)?;
        Ok(())
    }

    fn clear_dangling_funding(&mut self) -> CoreResult<()> {
        self.conn
            .execute(
                "UPDATE accounts SET funding_income_id = NULL
                 WHERE funding_income_id IS NOT NULL
                   AND funding_income_id NOT IN (SELECT id FROM recurring_items WHERE type = 'income')",
                [],
            )
            .map_err(db_err)?;
        Ok(())
    }

    fn list_budgets(&mut self) -> CoreResult<Vec<Budget>> {
        self.list("SELECT category_id, amount_cents FROM budgets", |r| {
            Ok(Budget { category_id: r.get(0)?, amount: r.get::<_, i64>(1)? as f64 / 100.0 })
        })
    }

    fn upsert_budget(&mut self, category_id: &str, amount_cents: i64) -> CoreResult<()> {
        self.conn
            .execute(
                "INSERT INTO budgets (category_id, amount_cents) VALUES (?1, ?2)
                 ON CONFLICT(category_id) DO UPDATE SET amount_cents = excluded.amount_cents",
                params![category_id, amount_cents],
            )
            .map_err(db_err)?;
        Ok(())
    }

    fn delete_budget(&mut self, category_id: &str) -> CoreResult<()> {
        self.conn.execute("DELETE FROM budgets WHERE category_id = ?1", [category_id]).map_err(db_err)?;
        Ok(())
    }

    fn list_goals(&mut self) -> CoreResult<Vec<Goal>> {
        self.goals_where("", None)
    }

    fn get_goal(&mut self, id: &str) -> CoreResult<Option<Goal>> {
        Ok(self.goals_where("WHERE id = ?1", Some(id))?.into_iter().next())
    }

    fn insert_goal(&mut self, id: &str, r: &GoalRow, created_at: Option<&str>) -> CoreResult<()> {
        self.conn
            .execute(
                "INSERT INTO goals (id, name, currency, target_minor, target_date, color, archived, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
                params![id, r.name, r.currency, r.target_minor, r.target_date, r.color, r.archived, created_at],
            )
            .map_err(db_err)?;
        self.link_accounts(id, &r.account_ids)
    }

    fn update_goal(&mut self, id: &str, r: &GoalRow) -> CoreResult<u64> {
        let n = self
            .conn
            .execute(
                "UPDATE goals SET name = ?2, currency = ?3, target_minor = ?4, target_date = ?5, color = ?6, archived = ?7 WHERE id = ?1",
                params![id, r.name, r.currency, r.target_minor, r.target_date, r.color, r.archived],
            )
            .map_err(db_err)?;
        if n > 0 {
            self.link_accounts(id, &r.account_ids)?;
        }
        Ok(n as u64)
    }

    fn delete_goal(&mut self, id: &str) -> CoreResult<()> {
        self.conn.execute("DELETE FROM goals WHERE id = ?1", [id]).map_err(db_err)?;
        Ok(())
    }

    fn goal_of_account(&mut self, account_id: &str) -> CoreResult<Option<(String, String)>> {
        self.conn
            .query_row(
                "SELECT g.id, g.name FROM goal_accounts ga JOIN goals g ON g.id = ga.goal_id WHERE ga.account_id = ?1",
                [account_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_err)
    }

    fn list_tags(&mut self) -> CoreResult<Vec<Tag>> {
        self.list(
            "SELECT id, name, color, budget_cents, archived, created_at FROM tags ORDER BY created_at, id",
            |r| {
                Ok(Tag {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    color: r.get(2)?,
                    budget: r.get::<_, Option<i64>>(3)?.map(|c| c as f64 / 100.0),
                    archived: r.get(4)?,
                    created_at: r.get(5)?,
                })
            },
        )
    }

    fn get_tag(&mut self, id: &str) -> CoreResult<Option<Tag>> {
        Ok(self.list_tags()?.into_iter().find(|t| t.id == id))
    }

    fn insert_tag(&mut self, id: &str, r: &TagRow, created_at: Option<&str>) -> CoreResult<()> {
        self.conn
            .execute(
                "INSERT INTO tags (id, name, color, budget_cents, archived, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
                params![id, r.name, r.color, r.budget_cents, r.archived, created_at],
            )
            .map_err(db_err)?;
        Ok(())
    }

    fn update_tag(&mut self, id: &str, r: &TagRow) -> CoreResult<u64> {
        let n = self
            .conn
            .execute(
                "UPDATE tags SET name = ?2, color = ?3, budget_cents = ?4, archived = ?5 WHERE id = ?1",
                params![id, r.name, r.color, r.budget_cents, r.archived],
            )
            .map_err(db_err)?;
        Ok(n as u64)
    }

    fn delete_tag(&mut self, id: &str) -> CoreResult<()> {
        self.conn.execute("DELETE FROM tags WHERE id = ?1", [id]).map_err(db_err)?;
        Ok(())
    }

    fn list_tx_tags(&mut self) -> CoreResult<Vec<(String, String)>> {
        self.list("SELECT transaction_id, tag_id FROM transaction_tags ORDER BY rowid", |r| Ok((r.get(0)?, r.get(1)?)))
    }

    fn tags_of_tx(&mut self, transaction_id: &str) -> CoreResult<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT tag_id FROM transaction_tags WHERE transaction_id = ?1 ORDER BY rowid").map_err(db_err)?;
        let rows = stmt.query_map([transaction_id], |r| r.get(0)).map_err(db_err)?.collect::<Result<Vec<String>, _>>().map_err(db_err)?;
        Ok(rows)
    }

    fn set_tx_tags(&mut self, transaction_id: &str, tag_ids: &[String]) -> CoreResult<()> {
        self.conn.execute("DELETE FROM transaction_tags WHERE transaction_id = ?1", [transaction_id]).map_err(db_err)?;
        for t in tag_ids {
            self.add_tx_tag(transaction_id, t)?;
        }
        Ok(())
    }

    fn add_tx_tag(&mut self, transaction_id: &str, tag_id: &str) -> CoreResult<()> {
        self.conn
            .execute("INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?1, ?2)", [transaction_id, tag_id])
            .map_err(db_err)?;
        Ok(())
    }

    fn remove_tx_tag(&mut self, transaction_id: &str, tag_id: &str) -> CoreResult<()> {
        self.conn
            .execute("DELETE FROM transaction_tags WHERE transaction_id = ?1 AND tag_id = ?2", [transaction_id, tag_id])
            .map_err(db_err)?;
        Ok(())
    }

    fn list_settings(&mut self) -> CoreResult<Vec<(String, String)>> {
        self.list("SELECT key, value FROM settings", |r| Ok((r.get(0)?, r.get(1)?)))
    }

    fn upsert_setting(&mut self, key: &str, json: &str) -> CoreResult<()> {
        self.conn
            .execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json),
            )
            .map_err(db_err)?;
        Ok(())
    }

    fn clear_all(&mut self) -> CoreResult<()> {
        for table in ["transaction_tags", "tags", "goal_accounts", "goals", "budgets", "recurring_items", "transactions", "accounts", "categories"] {
            self.conn.execute(&format!("DELETE FROM {table}"), []).map_err(db_err)?;
        }
        Ok(())
    }
}
