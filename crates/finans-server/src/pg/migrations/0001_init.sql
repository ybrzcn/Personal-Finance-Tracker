-- Finans Postgres şeması v1. Kullanıcı tabloları satır düzeyi güvenlikle (RLS) ayrılır:
-- her istek `SELECT set_config('finans.user_id', <id>, true)` ile kendi kullanıcısını ayarlar.

CREATE TABLE users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL,
    password_hash  TEXT NOT NULL,
    recovery_hash  TEXT NOT NULL,
    created_at     BIGINT NOT NULL,
    CONSTRAINT users_email_key UNIQUE (email)
);

CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device      TEXT NOT NULL DEFAULT '',
    created_at  BIGINT NOT NULL,
    last_seen   BIGINT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE categories (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    color       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id),
    CONSTRAINT categories_name_unique UNIQUE (user_id, name, type)
);

CREATE TABLE accounts (
    user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id                    TEXT NOT NULL,
    name                  TEXT NOT NULL,
    kind                  TEXT NOT NULL CHECK (kind IN ('bank', 'cash', 'credit_card', 'loan')),
    color                 TEXT NOT NULL,
    opening_balance_cents BIGINT NOT NULL DEFAULT 0,
    opening_date          DATE NOT NULL,
    credit_limit_cents    BIGINT,
    interest_rate_bp      BIGINT,
    statement_day         BIGINT CHECK (statement_day BETWEEN 1 AND 31),
    due_day               BIGINT CHECK (due_day BETWEEN 1 AND 31),
    min_payment_rate_bp   BIGINT,
    sort_order            BIGINT NOT NULL DEFAULT 0,
    archived              BOOLEAN NOT NULL DEFAULT false,
    term_months           BIGINT CHECK (term_months BETWEEN 1 AND 600),
    first_due_date        DATE,
    installment_cents     BIGINT,
    tax_rate_bp           BIGINT,
    funding_income_id     TEXT,
    opening_period_cents  BIGINT,
    opening_installments  JSONB NOT NULL DEFAULT '[]',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id),
    CONSTRAINT accounts_name_unique UNIQUE (user_id, name)
);

CREATE TABLE transactions (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id            TEXT NOT NULL,
    amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0),
    type          TEXT NOT NULL CHECK (type IN ('income', 'expense', 'transfer')),
    account_id    TEXT NOT NULL,
    to_account_id TEXT,
    category_id   TEXT,
    date          DATE NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    installments  BIGINT NOT NULL DEFAULT 1 CHECK (installments BETWEEN 1 AND 36),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    budget_month  TEXT,
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id, account_id) REFERENCES accounts (user_id, id),
    FOREIGN KEY (user_id, to_account_id) REFERENCES accounts (user_id, id),
    FOREIGN KEY (user_id, category_id) REFERENCES categories (user_id, id) ON DELETE SET NULL (category_id),
    CHECK ((type = 'transfer') = (to_account_id IS NOT NULL)),
    CHECK (type <> 'transfer' OR category_id IS NULL)
);
CREATE INDEX idx_transactions_date ON transactions (user_id, date);
CREATE INDEX idx_transactions_account ON transactions (user_id, account_id);
CREATE INDEX idx_transactions_to_account ON transactions (user_id, to_account_id);
CREATE INDEX idx_transactions_category ON transactions (user_id, category_id);

CREATE TABLE recurring_items (
    user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id                    TEXT NOT NULL,
    name                  TEXT NOT NULL,
    type                  TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    amount_cents          BIGINT NOT NULL CHECK (amount_cents > 0),
    day                   BIGINT NOT NULL CHECK (day BETWEEN 1 AND 31),
    account_id            TEXT,
    category_id           TEXT,
    active                BOOLEAN NOT NULL DEFAULT true,
    sort_order            BIGINT NOT NULL DEFAULT 0,
    amount_history        JSONB NOT NULL DEFAULT '[]',
    amount_exceptions     JSONB NOT NULL DEFAULT '[]',
    covers_previous_month BOOLEAN NOT NULL DEFAULT false,
    start_date            DATE,
    weekend_shift         TEXT NOT NULL DEFAULT 'none',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id, account_id) REFERENCES accounts (user_id, id) ON DELETE SET NULL (account_id),
    FOREIGN KEY (user_id, category_id) REFERENCES categories (user_id, id) ON DELETE SET NULL (category_id)
);

CREATE TABLE budgets (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id  TEXT NOT NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    PRIMARY KEY (user_id, category_id),
    FOREIGN KEY (user_id, category_id) REFERENCES categories (user_id, id) ON DELETE CASCADE
);

CREATE TABLE settings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    value   JSONB NOT NULL,
    PRIMARY KEY (user_id, key)
);

-- Satır düzeyi güvenlik: tablo sahibine de uygulanır (FORCE). Ayar yoksa hiçbir satır görünmez/yazılmaz.
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['categories', 'accounts', 'transactions', 'recurring_items', 'budgets', 'settings'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY user_isolation ON %I USING (user_id = current_setting(''finans.user_id'', true)) '
            'WITH CHECK (user_id = current_setting(''finans.user_id'', true))', t);
    END LOOP;
END $$;
