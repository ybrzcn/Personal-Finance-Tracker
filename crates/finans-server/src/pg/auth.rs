//! `AuthStore`'un Postgres uygulaması (users/sessions; RLS dışında).

use crate::auth_store::{AuthStore, NewUser, SessionInfo, StoreError, StoreResult, UserRow, UserSummary};

use super::{store_err, Pool};

pub struct PgAuthStore {
    pool: Pool,
}

impl PgAuthStore {
    pub fn new(pool: Pool) -> Self {
        PgAuthStore { pool }
    }

    fn c(&self) -> StoreResult<r2d2::PooledConnection<r2d2_postgres::PostgresConnectionManager<tokio_postgres_rustls::MakeRustlsConnect>>> {
        self.pool.get().map_err(|e| StoreError::Unavailable(e.to_string()))
    }
}

impl AuthStore for PgAuthStore {
    fn find_user(&self, email: &str) -> StoreResult<Option<UserRow>> {
        let row = self
            .c()?
            .query_opt("SELECT id, email, password_hash, recovery_hash FROM users WHERE email = $1", &[&email])
            .map_err(store_err)?;
        Ok(row.map(|r| UserRow { id: r.get(0), email: r.get(1), password_hash: r.get(2), recovery_hash: r.get(3) }))
    }

    fn password_hash(&self, user_id: &str) -> StoreResult<Option<String>> {
        Ok(self.c()?.query_opt("SELECT password_hash FROM users WHERE id = $1", &[&user_id]).map_err(store_err)?.map(|r| r.get(0)))
    }

    fn user_exists(&self, user_id: &str) -> StoreResult<bool> {
        Ok(self.c()?.query_one("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)", &[&user_id]).map_err(store_err)?.get(0))
    }

    fn count_users(&self) -> StoreResult<i64> {
        Ok(self.c()?.query_one("SELECT COUNT(*) FROM users", &[]).map_err(store_err)?.get(0))
    }

    fn insert_user(&self, id: &str, email: &str, password_hash: &str, recovery_hash: &str, created_at: i64) -> StoreResult<NewUser> {
        let r = self.c()?.execute(
            "INSERT INTO users (id, email, password_hash, recovery_hash, created_at) VALUES ($1, $2, $3, $4, $5)",
            &[&id, &email, &password_hash, &recovery_hash, &created_at],
        );
        match r {
            Ok(_) => Ok(NewUser::Created),
            Err(e) if e.as_db_error().is_some_and(|d| d.constraint() == Some("users_email_key")) => Ok(NewUser::EmailTaken),
            Err(e) => Err(store_err(e)),
        }
    }

    fn delete_user(&self, user_id: &str) -> StoreResult<()> {
        self.c()?.execute("DELETE FROM users WHERE id = $1", &[&user_id]).map_err(store_err)?;
        Ok(())
    }

    fn set_password(&self, user_id: &str, password_hash: &str) -> StoreResult<()> {
        self.c()?.execute("UPDATE users SET password_hash = $2 WHERE id = $1", &[&user_id, &password_hash]).map_err(store_err)?;
        Ok(())
    }

    fn set_password_and_recovery(&self, user_id: &str, password_hash: &str, recovery_hash: &str) -> StoreResult<()> {
        self.c()?
            .execute(
                "UPDATE users SET password_hash = $2, recovery_hash = $3 WHERE id = $1",
                &[&user_id, &password_hash, &recovery_hash],
            )
            .map_err(store_err)?;
        Ok(())
    }

    fn insert_session(&self, token_hash: &str, user_id: &str, device: &str, now: i64) -> StoreResult<()> {
        self.c()?
            .execute(
                "INSERT INTO sessions (token_hash, user_id, device, created_at, last_seen) VALUES ($1, $2, $3, $4, $4)",
                &[&token_hash, &user_id, &device, &now],
            )
            .map_err(store_err)?;
        Ok(())
    }

    fn session(&self, token_hash: &str) -> StoreResult<Option<SessionInfo>> {
        let row = self
            .c()?
            .query_opt(
                "SELECT u.id, u.email, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1",
                &[&token_hash],
            )
            .map_err(store_err)?;
        Ok(row.map(|r| SessionInfo { user_id: r.get(0), email: r.get(1), last_seen: r.get(2) }))
    }

    fn touch_session(&self, token_hash: &str, now: i64) -> StoreResult<()> {
        self.c()?.execute("UPDATE sessions SET last_seen = $2 WHERE token_hash = $1", &[&token_hash, &now]).map_err(store_err)?;
        Ok(())
    }

    fn delete_session(&self, token_hash: &str) -> StoreResult<()> {
        self.c()?.execute("DELETE FROM sessions WHERE token_hash = $1", &[&token_hash]).map_err(store_err)?;
        Ok(())
    }

    fn delete_sessions(&self, user_id: &str, keep: Option<&str>) -> StoreResult<()> {
        let mut c = self.c()?;
        match keep {
            Some(k) => c.execute("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", &[&user_id, &k]),
            None => c.execute("DELETE FROM sessions WHERE user_id = $1", &[&user_id]),
        }
        .map_err(store_err)?;
        Ok(())
    }

    fn sweep_sessions(&self, older_than: i64) -> StoreResult<u64> {
        self.c()?.execute("DELETE FROM sessions WHERE last_seen < $1", &[&older_than]).map_err(store_err)
    }

    fn list_users(&self) -> StoreResult<Vec<UserSummary>> {
        let rows = self
            .c()?
            .query(
                "SELECT id, email, created_at, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id)
                 FROM users u ORDER BY created_at",
                &[],
            )
            .map_err(store_err)?;
        Ok(rows.iter().map(|r| UserSummary { id: r.get(0), email: r.get(1), created_at: r.get(2), sessions: r.get(3) }).collect())
    }

    fn ping(&self) -> StoreResult<()> {
        self.c()?.execute("SELECT 1", &[]).map_err(store_err)?;
        Ok(())
    }
}
