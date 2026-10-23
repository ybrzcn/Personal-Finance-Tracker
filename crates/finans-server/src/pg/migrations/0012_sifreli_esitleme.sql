-- v12: uçtan uca şifreli eşitleme (şifreli parçalar; sunucu içeriği okuyamaz); hesap tabloları gibi RLS dışında

CREATE TABLE sync_state (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    key_id      TEXT NOT NULL,
    keyring     TEXT NOT NULL,
    version     BIGINT NOT NULL DEFAULT 0,
    data        BYTEA,
    updated_at  BIGINT NOT NULL
);

CREATE TABLE sync_files (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    data        BYTEA NOT NULL,
    created_at  BIGINT NOT NULL,
    PRIMARY KEY (user_id, id)
);
