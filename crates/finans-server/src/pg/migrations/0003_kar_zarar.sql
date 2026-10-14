-- v3: döviz/altın hesabının açılış maliyeti; ortak TÜFE serisi (kullanıcıya bağlı değil, RLS yok).

ALTER TABLE accounts ADD COLUMN opening_cost_cents BIGINT CHECK (opening_cost_cents IS NULL OR opening_cost_cents > 0);

CREATE TABLE cpi (
    month         DATE PRIMARY KEY,
    index_micros  BIGINT NOT NULL CHECK (index_micros > 0)
);
