-- v6: işlem etiketleri; ad benzersizliği Türkçe kurallarla uygulamada, dizin eşzamanlı eklemeye karşı

CREATE TABLE tags (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id            TEXT NOT NULL,
    name          TEXT NOT NULL,
    color         TEXT NOT NULL,
    budget_cents  BIGINT CHECK (budget_cents IS NULL OR budget_cents > 0),
    archived      BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX tags_name_unique ON tags (user_id, lower(name));

CREATE TABLE transaction_tags (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id  TEXT NOT NULL,
    tag_id          TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, transaction_id, tag_id),
    FOREIGN KEY (user_id, transaction_id) REFERENCES transactions (user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, tag_id) REFERENCES tags (user_id, id) ON DELETE CASCADE
);
CREATE INDEX transaction_tags_tag ON transaction_tags (user_id, tag_id);

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['tags', 'transaction_tags'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY user_isolation ON %I USING (user_id = current_setting(''finans.user_id'', true)) '
            'WITH CHECK (user_id = current_setting(''finans.user_id'', true))', t);
    END LOOP;
END $$;
