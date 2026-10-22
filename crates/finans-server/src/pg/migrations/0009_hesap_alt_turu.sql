-- v9: vadesiz hesabın alt türü (vadeli mevduat, BES, diğer varlık) ve ayrıntıları (mevduat koşulları, elle değerlemeler)

ALTER TABLE accounts ADD COLUMN subtype TEXT NOT NULL DEFAULT '' CHECK (subtype IN ('', 'deposit', 'pension', 'asset'));
ALTER TABLE accounts ADD COLUMN details JSONB NOT NULL DEFAULT '{}'::jsonb;
