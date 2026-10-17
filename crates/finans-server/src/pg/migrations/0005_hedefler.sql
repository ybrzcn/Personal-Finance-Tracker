-- v5: birikim hedefleri; her hesap en çok bir hedefe bağlı (birincil anahtar)

CREATE TABLE goals (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id            TEXT NOT NULL,
    name          TEXT NOT NULL,
    currency      TEXT NOT NULL,
    target_minor  BIGINT NOT NULL CHECK (target_minor > 0),
    target_date   DATE,
    color         TEXT NOT NULL,
    archived      BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id)
);

CREATE TABLE goal_accounts (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id  TEXT NOT NULL,
    goal_id     TEXT NOT NULL,
    CONSTRAINT goal_accounts_pkey PRIMARY KEY (user_id, account_id),
    FOREIGN KEY (user_id, account_id) REFERENCES accounts (user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, goal_id) REFERENCES goals (user_id, id) ON DELETE CASCADE
);
CREATE INDEX goal_accounts_goal ON goal_accounts (user_id, goal_id);

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['goals', 'goal_accounts'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY user_isolation ON %I USING (user_id = current_setting(''finans.user_id'', true)) '
            'WITH CHECK (user_id = current_setting(''finans.user_id'', true))', t);
    END LOOP;
END $$;
