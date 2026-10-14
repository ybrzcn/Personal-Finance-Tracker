//! `AuthStore`'un SQLite uygulaması (`auth.db`).

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension};

use crate::auth_store::{AuthStore, NewUser, SessionInfo, StoreError, StoreResult, UserRow, UserSummary};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    recovery_hash  TEXT NOT NULL,
    created_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
PRAGMA user_version = 1;
";

pub struct SqliteAuthStore {
    conn: Mutex<Connection>,
}

fn err(e: rusqlite::Error) -> StoreError {
    StoreError::Other(e.to_string())
}

impl SqliteAuthStore {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        Ok(SqliteAuthStore { conn: Mutex::new(conn) })
    }

    /// Bir istek panik ederse kilit zehirlenir; bağlantı yine kullanılabilir.
    fn c(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl AuthStore for SqliteAuthStore {
    fn find_user(&self, email: &str) -> StoreResult<Option<UserRow>> {
        self.c()
            .query_row("SELECT id, email, password_hash, recovery_hash FROM users WHERE email = ?1", [email], |r| {
                Ok(UserRow { id: r.get(0)?, email: r.get(1)?, password_hash: r.get(2)?, recovery_hash: r.get(3)? })
            })
            .optional()
            .map_err(err)
    }

    fn password_hash(&self, user_id: &str) -> StoreResult<Option<String>> {
        self.c().query_row("SELECT password_hash FROM users WHERE id = ?1", [user_id], |r| r.get(0)).optional().map_err(err)
    }

    fn user_exists(&self, user_id: &str) -> StoreResult<bool> {
        self.c().query_row("SELECT EXISTS (SELECT 1 FROM users WHERE id = ?1)", [user_id], |r| r.get(0)).map_err(err)
    }

    fn count_users(&self) -> StoreResult<i64> {
        self.c().query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0)).map_err(err)
    }

    fn insert_user(&self, id: &str, email: &str, password_hash: &str, recovery_hash: &str, created_at: i64) -> StoreResult<NewUser> {
        let r = self.c().execute(
            "INSERT INTO users (id, email, password_hash, recovery_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            (id, email, password_hash, recovery_hash, created_at),
        );
        match r {
            Ok(_) => Ok(NewUser::Created),
            Err(rusqlite::Error::SqliteFailure(f, _)) if f.code == rusqlite::ErrorCode::ConstraintViolation => Ok(NewUser::EmailTaken),
            Err(e) => Err(err(e)),
        }
    }

    fn delete_user(&self, user_id: &str) -> StoreResult<()> {
        self.c().execute("DELETE FROM users WHERE id = ?1", [user_id]).map_err(err)?;
        Ok(())
    }

    fn set_password(&self, user_id: &str, password_hash: &str) -> StoreResult<()> {
        self.c().execute("UPDATE users SET password_hash = ?2 WHERE id = ?1", (user_id, password_hash)).map_err(err)?;
        Ok(())
    }

    fn set_password_and_recovery(&self, user_id: &str, password_hash: &str, recovery_hash: &str) -> StoreResult<()> {
        self.c()
            .execute("UPDATE users SET password_hash = ?2, recovery_hash = ?3 WHERE id = ?1", (user_id, password_hash, recovery_hash))
            .map_err(err)?;
        Ok(())
    }

    fn insert_session(&self, token_hash: &str, user_id: &str, device: &str, now: i64) -> StoreResult<()> {
        self.c()
            .execute(
                "INSERT INTO sessions (token_hash, user_id, device, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)",
                (token_hash, user_id, device, now),
            )
            .map_err(err)?;
        Ok(())
    }

    fn session(&self, token_hash: &str) -> StoreResult<Option<SessionInfo>> {
        self.c()
            .query_row(
                "SELECT u.id, u.email, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1",
                [token_hash],
                |r| Ok(SessionInfo { user_id: r.get(0)?, email: r.get(1)?, last_seen: r.get(2)? }),
            )
            .optional()
            .map_err(err)
    }

    fn touch_session(&self, token_hash: &str, now: i64) -> StoreResult<()> {
        self.c().execute("UPDATE sessions SET last_seen = ?2 WHERE token_hash = ?1", (token_hash, now)).map_err(err)?;
        Ok(())
    }

    fn delete_session(&self, token_hash: &str) -> StoreResult<()> {
        self.c().execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash]).map_err(err)?;
        Ok(())
    }

    fn delete_sessions(&self, user_id: &str, keep: Option<&str>) -> StoreResult<()> {
        match keep {
            Some(k) => self.c().execute("DELETE FROM sessions WHERE user_id = ?1 AND token_hash <> ?2", (user_id, k)),
            None => self.c().execute("DELETE FROM sessions WHERE user_id = ?1", [user_id]),
        }
        .map_err(err)?;
        Ok(())
    }

    fn sweep_sessions(&self, older_than: i64) -> StoreResult<u64> {
        Ok(self.c().execute("DELETE FROM sessions WHERE last_seen < ?1", [older_than]).map_err(err)? as u64)
    }

    fn list_users(&self) -> StoreResult<Vec<UserSummary>> {
        let c = self.c();
        let mut stmt = c
            .prepare(
                "SELECT id, email, created_at, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id)
                 FROM users u ORDER BY created_at",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok(UserSummary { id: r.get(0)?, email: r.get(1)?, created_at: r.get(2)?, sessions: r.get(3)? }))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        Ok(rows)
    }

    fn ping(&self) -> StoreResult<()> {
        self.c().query_row("SELECT 1", [], |_| Ok(())).map_err(err)
    }
}
