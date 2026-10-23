-- v11: iki aşamalı doğrulama (doğrulama uygulaması kodu, passkey); hesap tabloları gibi RLS dışında

ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_last_step BIGINT;

CREATE TABLE passkeys (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    rp_id       TEXT NOT NULL,
    alg         BIGINT NOT NULL,
    public_key  BYTEA NOT NULL,
    sign_count  BIGINT NOT NULL DEFAULT 0,
    created_at  BIGINT NOT NULL,
    last_used   BIGINT
);
CREATE INDEX idx_passkeys_user ON passkeys (user_id);
