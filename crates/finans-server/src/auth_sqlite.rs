//! `AuthStore`'un SQLite uygulaması (`auth.db`).

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension};

use crate::auth_store::{AuthStore, NewUser, PasskeyRow, SessionInfo, StoreError, StoreResult, SyncFile, SyncMeta, SyncPut, UserRow, UserSummary};

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
";

/// v2: iki aşamalı doğrulama (doğrulama uygulaması kodu, passkey). Sütunlar `open`'da eklenir: eski sürüme dönülüp
/// (eski sürüm her açılışta user_version'ı 1 yapar) yeniden yükseltilince de çalışsın.
const V2: &str = "
CREATE TABLE IF NOT EXISTS passkeys (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    rp_id       TEXT NOT NULL,
    alg         INTEGER NOT NULL,
    public_key  BLOB NOT NULL,
    sign_count  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    last_used   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys (user_id);
PRAGMA user_version = 2;
";

/// v3: uçtan uca şifreli eşitleme (şifreli parçalar; sunucu içeriği okuyamaz)
const V3: &str = "
CREATE TABLE IF NOT EXISTS sync_state (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    key_id      TEXT NOT NULL,
    keyring     TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 0,
    data        BLOB,
    updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_files (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    data        BLOB NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
);
PRAGMA user_version = 3;
";

const PASSKEY_COLS: &str = "id, user_id, name, rp_id, alg, public_key, sign_count, created_at, last_used";

fn passkey_row(r: &rusqlite::Row) -> rusqlite::Result<PasskeyRow> {
    Ok(PasskeyRow {
        id: r.get(0)?,
        user_id: r.get(1)?,
        name: r.get(2)?,
        rp_id: r.get(3)?,
        alg: r.get(4)?,
        public_key: r.get(5)?,
        sign_count: r.get(6)?,
        created_at: r.get(7)?,
        last_used: r.get(8)?,
    })
}

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
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 3 {
            // Aynı anda açılan başka süreç (ör. yönetim komutu) de göç ediyor olabilir: yazma kilidiyle, sütunlara bakarak
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let r = (|| {
                let has = |col: &str| -> rusqlite::Result<bool> {
                    conn.query_row("SELECT EXISTS (SELECT 1 FROM pragma_table_info('users') WHERE name = ?1)", [col], |r| r.get(0))
                };
                if !has("totp_secret")? {
                    conn.execute_batch("ALTER TABLE users ADD COLUMN totp_secret TEXT")?;
                }
                if !has("totp_last_step")? {
                    conn.execute_batch("ALTER TABLE users ADD COLUMN totp_last_step INTEGER")?;
                }
                conn.execute_batch(V2)?;
                conn.execute_batch(V3)
            })();
            conn.execute_batch(if r.is_ok() { "COMMIT" } else { "ROLLBACK" })?;
            r?;
        }
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
            .query_row(
                "SELECT id, email, password_hash, recovery_hash, totp_secret IS NOT NULL FROM users WHERE email = ?1",
                [email],
                |r| Ok(UserRow { id: r.get(0)?, email: r.get(1)?, password_hash: r.get(2)?, recovery_hash: r.get(3)?, totp_enabled: r.get(4)? }),
            )
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
            .execute(
                "UPDATE users SET password_hash = ?2, recovery_hash = ?3, totp_secret = NULL, totp_last_step = NULL WHERE id = ?1",
                (user_id, password_hash, recovery_hash),
            )
            .map_err(err)?;
        Ok(())
    }

    fn user_email(&self, user_id: &str) -> StoreResult<Option<String>> {
        self.c().query_row("SELECT email FROM users WHERE id = ?1", [user_id], |r| r.get(0)).optional().map_err(err)
    }

    fn totp(&self, user_id: &str) -> StoreResult<(Option<String>, Option<i64>)> {
        Ok(self
            .c()
            .query_row("SELECT totp_secret, totp_last_step FROM users WHERE id = ?1", [user_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(err)?
            .unwrap_or((None, None)))
    }

    fn set_totp(&self, user_id: &str, secret: Option<&str>) -> StoreResult<()> {
        self.c()
            .execute("UPDATE users SET totp_secret = ?2, totp_last_step = NULL WHERE id = ?1", (user_id, secret))
            .map_err(err)?;
        Ok(())
    }

    fn use_totp_step(&self, user_id: &str, step: i64) -> StoreResult<bool> {
        let n = self
            .c()
            .execute(
                "UPDATE users SET totp_last_step = ?2 WHERE id = ?1 AND (totp_last_step IS NULL OR totp_last_step < ?2)",
                (user_id, step),
            )
            .map_err(err)?;
        Ok(n == 1)
    }

    fn list_passkeys(&self, user_id: &str) -> StoreResult<Vec<PasskeyRow>> {
        let c = self.c();
        let mut stmt = c.prepare(&format!("SELECT {PASSKEY_COLS} FROM passkeys WHERE user_id = ?1 ORDER BY created_at")).map_err(err)?;
        let rows = stmt.query_map([user_id], passkey_row).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
        Ok(rows)
    }

    fn passkey(&self, id: &str) -> StoreResult<Option<PasskeyRow>> {
        self.c().query_row(&format!("SELECT {PASSKEY_COLS} FROM passkeys WHERE id = ?1"), [id], passkey_row).optional().map_err(err)
    }

    fn insert_passkey(&self, p: &PasskeyRow) -> StoreResult<bool> {
        let r = self.c().execute(
            "INSERT INTO passkeys (id, user_id, name, rp_id, alg, public_key, sign_count, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            (&p.id, &p.user_id, &p.name, &p.rp_id, p.alg, &p.public_key, p.sign_count, p.created_at),
        );
        match r {
            Ok(_) => Ok(true),
            // Yalnız aynı kimlik "zaten kayıtlı"; kullanıcı silinmişse (yabancı anahtar) hata
            Err(rusqlite::Error::SqliteFailure(f, _)) if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY => Ok(false),
            Err(e) => Err(err(e)),
        }
    }

    fn passkey_used(&self, id: &str, old_count: i64, new_count: i64, now: i64) -> StoreResult<bool> {
        let n = self
            .c()
            .execute(
                "UPDATE passkeys SET sign_count = ?3, last_used = ?4 WHERE id = ?1 AND sign_count = ?2",
                (id, old_count, new_count, now),
            )
            .map_err(err)?;
        Ok(n == 1)
    }

    fn delete_passkey(&self, user_id: &str, id: &str) -> StoreResult<bool> {
        Ok(self.c().execute("DELETE FROM passkeys WHERE user_id = ?1 AND id = ?2", (user_id, id)).map_err(err)? == 1)
    }

    fn delete_passkeys(&self, user_id: &str) -> StoreResult<u64> {
        Ok(self.c().execute("DELETE FROM passkeys WHERE user_id = ?1", [user_id]).map_err(err)? as u64)
    }

    fn sync_meta(&self, user_id: &str) -> StoreResult<Option<SyncMeta>> {
        self.c()
            .query_row(
                "SELECT keyring, version, updated_at, COALESCE(length(data), 0),
                        (SELECT count(*) FROM sync_files WHERE user_id = ?1),
                        (SELECT COALESCE(sum(length(data)), 0) FROM sync_files WHERE user_id = ?1)
                 FROM sync_state WHERE user_id = ?1",
                [user_id],
                |r| {
                    Ok(SyncMeta {
                        keyring: r.get(0)?,
                        version: r.get(1)?,
                        updated_at: r.get(2)?,
                        data_bytes: r.get(3)?,
                        files: r.get(4)?,
                        files_bytes: r.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(err)
    }

    fn sync_set_keyring(&self, user_id: &str, key_id: &str, keyring: &str, now: i64) -> StoreResult<bool> {
        let n = self
            .c()
            .execute(
                "INSERT INTO sync_state (user_id, key_id, keyring, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (user_id) DO UPDATE SET keyring = excluded.keyring, updated_at = excluded.updated_at
                 WHERE sync_state.key_id = excluded.key_id",
                (user_id, key_id, keyring, now),
            )
            .map_err(err)?;
        Ok(n == 1)
    }

    fn sync_data(&self, user_id: &str) -> StoreResult<Option<(i64, Vec<u8>)>> {
        self.c()
            .query_row("SELECT version, data FROM sync_state WHERE user_id = ?1 AND data IS NOT NULL", [user_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(err)
    }

    fn sync_put_data(&self, user_id: &str, key_id: &str, base: i64, data: &[u8], now: i64, quota: Option<i64>) -> StoreResult<SyncPut> {
        // Tek bağlantı kilit altında: okuma, kota denetimi ve yazma arasına başka istek giremez
        let c = self.c();
        let cur: Option<(String, i64, i64)> = c
            .query_row(
                "SELECT key_id, version, (SELECT COALESCE(sum(length(data)), 0) FROM sync_files WHERE user_id = ?1) FROM sync_state WHERE user_id = ?1",
                [user_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(err)?;
        match cur {
            Some((k, _, _)) if k != key_id => Ok(SyncPut::KeyChanged),
            None => Ok(SyncPut::KeyChanged),
            Some((_, _, files)) if quota.is_some_and(|q| files + data.len() as i64 > q) => Ok(SyncPut::OverQuota),
            Some(_) => {
                let n = c
                    .execute(
                        "UPDATE sync_state SET data = ?4, version = version + 1, updated_at = ?5 WHERE user_id = ?1 AND key_id = ?2 AND version = ?3",
                        (user_id, key_id, base, data, now),
                    )
                    .map_err(err)?;
                Ok(if n == 1 { SyncPut::Ok(base + 1) } else { SyncPut::Conflict })
            }
        }
    }

    fn sync_files(&self, user_id: &str) -> StoreResult<Vec<SyncFile>> {
        let c = self.c();
        let mut st = c.prepare("SELECT id, length(data), created_at FROM sync_files WHERE user_id = ?1 ORDER BY id").map_err(err)?;
        let rows = st.query_map([user_id], |r| Ok(SyncFile { id: r.get(0)?, size: r.get(1)?, created_at: r.get(2)? })).map_err(err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
    }

    fn sync_file(&self, user_id: &str, id: &str) -> StoreResult<Option<Vec<u8>>> {
        self.c()
            .query_row("SELECT data FROM sync_files WHERE user_id = ?1 AND id = ?2", (user_id, id), |r| r.get(0))
            .optional()
            .map_err(err)
    }

    fn sync_put_file(&self, user_id: &str, key_id: &str, id: &str, data: &[u8], now: i64, quota: Option<i64>) -> StoreResult<SyncPut> {
        let c = self.c();
        let cur: Option<(String, i64)> = c
            .query_row(
                "SELECT key_id, COALESCE(length(data), 0) + (SELECT COALESCE(sum(length(data)), 0) FROM sync_files WHERE user_id = ?1 AND id != ?2)
                 FROM sync_state WHERE user_id = ?1",
                (user_id, id),
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        match cur {
            Some((k, used)) if k == key_id => {
                if quota.is_some_and(|q| used + data.len() as i64 > q) {
                    return Ok(SyncPut::OverQuota);
                }
                c.execute(
                    "INSERT INTO sync_files (user_id, id, data, created_at) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT (user_id, id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at",
                    (user_id, id, data, now),
                )
                .map_err(err)?;
                Ok(SyncPut::Ok(0))
            }
            _ => Ok(SyncPut::KeyChanged),
        }
    }

    fn sync_delete_file(&self, user_id: &str, id: &str) -> StoreResult<bool> {
        Ok(self.c().execute("DELETE FROM sync_files WHERE user_id = ?1 AND id = ?2", (user_id, id)).map_err(err)? == 1)
    }

    fn sync_delete(&self, user_id: &str) -> StoreResult<()> {
        let mut c = self.c();
        let tx = c.transaction().map_err(err)?;
        tx.execute("DELETE FROM sync_files WHERE user_id = ?1", [user_id]).map_err(err)?;
        tx.execute("DELETE FROM sync_state WHERE user_id = ?1", [user_id]).map_err(err)?;
        tx.commit().map_err(err)
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
