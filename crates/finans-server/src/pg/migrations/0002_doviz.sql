-- v2: döviz/altın hesapları ve ortak kur geçmişi (fx_rates kullanıcıya bağlı değildir; RLS yok).

ALTER TABLE accounts ADD COLUMN currency TEXT NOT NULL DEFAULT 'TRY';

ALTER TABLE transactions
    ADD COLUMN orig_amount BIGINT,
    ADD COLUMN fx_rate BIGINT,
    ADD COLUMN to_orig_amount BIGINT,
    ADD COLUMN to_fx_rate BIGINT,
    ADD CONSTRAINT transactions_fx_pair CHECK ((orig_amount IS NULL) = (fx_rate IS NULL)),
    ADD CONSTRAINT transactions_fx_positive CHECK (orig_amount IS NULL OR (orig_amount > 0 AND fx_rate > 0)),
    ADD CONSTRAINT transactions_to_fx_pair CHECK ((to_orig_amount IS NULL) = (to_fx_rate IS NULL)),
    ADD CONSTRAINT transactions_to_fx_positive CHECK (to_orig_amount IS NULL OR (to_orig_amount > 0 AND to_fx_rate > 0));

ALTER TABLE recurring_items ADD COLUMN orig_amount BIGINT CHECK (orig_amount IS NULL OR orig_amount > 0);

CREATE TABLE fx_rates (
    code         TEXT NOT NULL,
    source       TEXT NOT NULL CHECK (source IN ('tcmb', 'harem')),
    observed_at  TIMESTAMPTZ NOT NULL,
    buy          BIGINT NOT NULL CHECK (buy > 0),
    sell         BIGINT NOT NULL CHECK (sell > 0),
    PRIMARY KEY (code, observed_at)
);
