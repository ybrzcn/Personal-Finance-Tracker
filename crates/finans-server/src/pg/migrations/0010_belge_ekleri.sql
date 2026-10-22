-- v10: işlem ekleri (fiş, fatura); işlem silinince ekleri de silinir

CREATE TABLE attachments (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id              TEXT NOT NULL,
    transaction_id  TEXT NOT NULL,
    name            TEXT NOT NULL,
    mime            TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
    size            BIGINT NOT NULL CHECK (size > 0),
    data            BYTEA NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id, transaction_id) REFERENCES transactions (user_id, id) ON DELETE CASCADE
);
CREATE INDEX attachments_tx ON attachments (user_id, transaction_id);

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON attachments USING (user_id = current_setting('finans.user_id', true))
    WITH CHECK (user_id = current_setting('finans.user_id', true));
