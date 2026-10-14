#!/bin/sh
# Postgres ilk açılışta bir kez çalışır: uygulama için süper kullanıcı OLMAYAN rol ve veritabanı.
# (Süper kullanıcılar satır düzeyi güvenliği atlar; Finans bu yüzden onlarla bağlanmayı reddeder.)
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<EOSQL
CREATE ROLE finans LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${FINANS_DB_PASSWORD}';
CREATE DATABASE finans OWNER finans;
EOSQL
