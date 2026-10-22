-- v8: düzenli kaydın günü gelince işlem olarak kendiliğinden kaydedilmesi; işlenen son ay (YYYY-MM)

ALTER TABLE recurring_items ADD COLUMN auto_post BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE recurring_items ADD COLUMN auto_posted_until TEXT CHECK (auto_posted_until IS NULL OR auto_posted_until ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
