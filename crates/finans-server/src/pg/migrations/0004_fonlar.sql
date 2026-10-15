-- v4: yatırım fonları. fx_rates TEFAS fiyatlarını da tutar; izlenen fon kodları (kullanıcıya bağlı değil, RLS yok).

ALTER TABLE fx_rates DROP CONSTRAINT fx_rates_source_check;
ALTER TABLE fx_rates ADD CONSTRAINT fx_rates_source_check CHECK (source IN ('tcmb', 'harem', 'tefas'));

CREATE TABLE fund_codes (
    code            TEXT PRIMARY KEY CHECK (code ~ '^FON:[A-Z0-9]{3}$'),
    last_requested  TIMESTAMPTZ NOT NULL DEFAULT now()
);
