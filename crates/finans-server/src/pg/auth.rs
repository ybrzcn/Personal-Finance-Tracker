//! `AuthStore`'un Postgres uygulaması (users/sessions; RLS dışında).

use crate::auth_store::{AuthStore, NewUser, PasskeyRow, SessionInfo, StoreError, StoreResult, SyncFile, SyncMeta, SyncPut, UserRow, UserSummary};

use super::{store_err, Pool};

const PASSKEY_COLS: &str = "id, user_id, name, rp_id, alg, public_key, sign_count, created_at, last_used";

fn passkey_row(r: &postgres::Row) -> PasskeyRow {
    PasskeyRow {
        id: r.get(0),
        user_id: r.get(1),
        name: r.get(2),
        rp_id: r.get(3),
        alg: r.get(4),
        public_key: r.get(5),
        sign_count: r.get(6),
        created_at: r.get(7),
        last_used: r.get(8),
    }
}

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
            .query_opt(
                "SELECT id, email, password_hash, recovery_hash, totp_secret IS NOT NULL FROM users WHERE email = $1",
                &[&email],
            )
            .map_err(store_err)?;
        Ok(row.map(|r| UserRow { id: r.get(0), email: r.get(1), password_hash: r.get(2), recovery_hash: r.get(3), totp_enabled: r.get(4) }))
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
                "UPDATE users SET password_hash = $2, recovery_hash = $3, totp_secret = NULL, totp_last_step = NULL WHERE id = $1",
                &[&user_id, &password_hash, &recovery_hash],
            )
            .map_err(store_err)?;
        Ok(())
    }

    fn user_email(&self, user_id: &str) -> StoreResult<Option<String>> {
        Ok(self.c()?.query_opt("SELECT email FROM users WHERE id = $1", &[&user_id]).map_err(store_err)?.map(|r| r.get(0)))
    }

    fn totp(&self, user_id: &str) -> StoreResult<(Option<String>, Option<i64>)> {
        let row = self.c()?.query_opt("SELECT totp_secret, totp_last_step FROM users WHERE id = $1", &[&user_id]).map_err(store_err)?;
        Ok(row.map_or((None, None), |r| (r.get(0), r.get(1))))
    }

    fn set_totp(&self, user_id: &str, secret: Option<&str>) -> StoreResult<()> {
        self.c()?
            .execute("UPDATE users SET totp_secret = $2, totp_last_step = NULL WHERE id = $1", &[&user_id, &secret])
            .map_err(store_err)?;
        Ok(())
    }

    fn use_totp_step(&self, user_id: &str, step: i64) -> StoreResult<bool> {
        let n = self
            .c()?
            .execute(
                "UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)",
                &[&user_id, &step],
            )
            .map_err(store_err)?;
        Ok(n == 1)
    }

    fn list_passkeys(&self, user_id: &str) -> StoreResult<Vec<PasskeyRow>> {
        let rows = self
            .c()?
            .query(&format!("SELECT {PASSKEY_COLS} FROM passkeys WHERE user_id = $1 ORDER BY created_at"), &[&user_id])
            .map_err(store_err)?;
        Ok(rows.iter().map(passkey_row).collect())
    }

    fn passkey(&self, id: &str) -> StoreResult<Option<PasskeyRow>> {
        Ok(self.c()?.query_opt(&format!("SELECT {PASSKEY_COLS} FROM passkeys WHERE id = $1"), &[&id]).map_err(store_err)?.as_ref().map(passkey_row))
    }

    fn insert_passkey(&self, p: &PasskeyRow) -> StoreResult<bool> {
        let n = self
            .c()?
            .execute(
                "INSERT INTO passkeys (id, user_id, name, rp_id, alg, public_key, sign_count, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING",
                &[&p.id, &p.user_id, &p.name, &p.rp_id, &p.alg, &p.public_key, &p.sign_count, &p.created_at],
            )
            .map_err(store_err)?;
        Ok(n == 1)
    }

    fn passkey_used(&self, id: &str, old_count: i64, new_count: i64, now: i64) -> StoreResult<bool> {
        let n = self
            .c()?
            .execute(
                "UPDATE passkeys SET sign_count = $3, last_used = $4 WHERE id = $1 AND sign_count = $2",
                &[&id, &old_count, &new_count, &now],
            )
            .map_err(store_err)?;
        Ok(n == 1)
    }

    fn delete_passkey(&self, user_id: &str, id: &str) -> StoreResult<bool> {
        Ok(self.c()?.execute("DELETE FROM passkeys WHERE user_id = $1 AND id = $2", &[&user_id, &id]).map_err(store_err)? == 1)
    }

    fn delete_passkeys(&self, user_id: &str) -> StoreResult<u64> {
        self.c()?.execute("DELETE FROM passkeys WHERE user_id = $1", &[&user_id]).map_err(store_err)
    }

    fn sync_meta(&self, user_id: &str) -> StoreResult<Option<SyncMeta>> {
        let row = self
            .c()?
            .query_opt(
                "SELECT keyring, version, updated_at, COALESCE(octet_length(data), 0)::BIGINT,
                        (SELECT count(*) FROM sync_files WHERE user_id = $1)::BIGINT,
                        (SELECT COALESCE(sum(octet_length(data)), 0) FROM sync_files WHERE user_id = $1)::BIGINT
                 FROM sync_state WHERE user_id = $1",
                &[&user_id],
            )
            .map_err(store_err)?;
        Ok(row.map(|r| SyncMeta {
            keyring: r.get(0),
            version: r.get(1),
            updated_at: r.get(2),
            data_bytes: r.get(3),
            files: r.get(4),
            files_bytes: r.get(5),
        }))
    }

    fn sync_set_keyring(&self, user_id: &str, key_id: &str, keyring: &str, now: i64) -> StoreResult<bool> {
        let n = self
            .c()?
            .execute(
                "INSERT INTO sync_state (user_id, key_id, keyring, updated_at) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id) DO UPDATE SET keyring = excluded.keyring, updated_at = excluded.updated_at
                 WHERE sync_state.key_id = excluded.key_id",
                &[&user_id, &key_id, &keyring, &now],
            )
            .map_err(store_err)?;
        Ok(n == 1)
    }

    fn sync_data(&self, user_id: &str) -> StoreResult<Option<(i64, Vec<u8>)>> {
        let row = self.c()?.query_opt("SELECT version, data FROM sync_state WHERE user_id = $1 AND data IS NOT NULL", &[&user_id]).map_err(store_err)?;
        Ok(row.map(|r| (r.get(0), r.get(1))))
    }

    fn sync_put_data(&self, user_id: &str, key_id: &str, base: i64, data: &[u8], now: i64, quota: Option<i64>) -> StoreResult<SyncPut> {
        // Durum satırı kilitlenir: aynı kullanıcının veri ve dosya yazmaları sırayla, kota denetimi yazmayla aynı işlemde
        let mut c = self.c()?;
        let mut tx = c.transaction().map_err(store_err)?;
        let cur = tx.query_opt("SELECT key_id, version FROM sync_state WHERE user_id = $1 FOR UPDATE", &[&user_id]).map_err(store_err)?;
        let out = match cur {
            Some(r) if r.get::<_, String>(0) == key_id => {
                let files: i64 = tx
                    .query_one("SELECT COALESCE(sum(octet_length(data)), 0)::BIGINT FROM sync_files WHERE user_id = $1", &[&user_id])
                    .map_err(store_err)?
                    .get(0);
                if r.get::<_, i64>(1) != base {
                    SyncPut::Conflict
                } else if quota.is_some_and(|q| files + data.len() as i64 > q) {
                    SyncPut::OverQuota
                } else {
                    tx.execute("UPDATE sync_state SET data = $2, version = version + 1, updated_at = $3 WHERE user_id = $1", &[&user_id, &data, &now])
                        .map_err(store_err)?;
                    SyncPut::Ok(base + 1)
                }
            }
            _ => SyncPut::KeyChanged,
        };
        tx.commit().map_err(store_err)?;
        Ok(out)
    }

    fn sync_files(&self, user_id: &str) -> StoreResult<Vec<SyncFile>> {
        let rows = self
            .c()?
            .query("SELECT id, octet_length(data)::BIGINT, created_at FROM sync_files WHERE user_id = $1 ORDER BY id", &[&user_id])
            .map_err(store_err)?;
        Ok(rows.iter().map(|r| SyncFile { id: r.get(0), size: r.get(1), created_at: r.get(2) }).collect())
    }

    fn sync_file(&self, user_id: &str, id: &str) -> StoreResult<Option<Vec<u8>>> {
        let row = self.c()?.query_opt("SELECT data FROM sync_files WHERE user_id = $1 AND id = $2", &[&user_id, &id]).map_err(store_err)?;
        Ok(row.map(|r| r.get(0)))
    }

    fn sync_put_file(&self, user_id: &str, key_id: &str, id: &str, data: &[u8], now: i64, quota: Option<i64>) -> StoreResult<SyncPut> {
        let mut c = self.c()?;
        let mut tx = c.transaction().map_err(store_err)?;
        let cur = tx
            .query_opt("SELECT key_id, COALESCE(octet_length(data), 0)::BIGINT FROM sync_state WHERE user_id = $1 FOR UPDATE", &[&user_id])
            .map_err(store_err)?;
        let out = match cur {
            Some(r) if r.get::<_, String>(0) == key_id => {
                let files: i64 = tx
                    .query_one("SELECT COALESCE(sum(octet_length(data)), 0)::BIGINT FROM sync_files WHERE user_id = $1 AND id <> $2", &[&user_id, &id])
                    .map_err(store_err)?
                    .get(0);
                if quota.is_some_and(|q| r.get::<_, i64>(1) + files + data.len() as i64 > q) {
                    SyncPut::OverQuota
                } else {
                    tx.execute(
                        "INSERT INTO sync_files (user_id, id, data, created_at) VALUES ($1, $2, $3, $4)
                         ON CONFLICT (user_id, id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at",
                        &[&user_id, &id, &data, &now],
                    )
                    .map_err(store_err)?;
                    SyncPut::Ok(0)
                }
            }
            _ => SyncPut::KeyChanged,
        };
        tx.commit().map_err(store_err)?;
        Ok(out)
    }

    fn sync_delete_file(&self, user_id: &str, id: &str) -> StoreResult<bool> {
        Ok(self.c()?.execute("DELETE FROM sync_files WHERE user_id = $1 AND id = $2", &[&user_id, &id]).map_err(store_err)? == 1)
    }

    fn sync_delete(&self, user_id: &str) -> StoreResult<()> {
        let mut c = self.c()?;
        let mut tx = c.transaction().map_err(store_err)?;
        tx.execute("DELETE FROM sync_files WHERE user_id = $1", &[&user_id]).map_err(store_err)?;
        tx.execute("DELETE FROM sync_state WHERE user_id = $1", &[&user_id]).map_err(store_err)?;
        tx.commit().map_err(store_err)
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
