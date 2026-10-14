//! Ortak kur tablosu (`fx_rates`). Yalnız değişen fiyat yazılır.

use finans_core::fx::sources::Quote;

use super::Pool;

const COLUMNS: &str = "code, source, to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), buy, sell";

fn quote(r: &postgres::Row) -> Quote {
    Quote { code: r.get(0), source: r.get(1), observed_at: r.get(2), buy: r.get(3), sell: r.get(4) }
}

/// Her kod için, kendinden önceki son satırla alış ve satışı aynıysa eklemez. Tek işlemde.
pub fn insert_if_changed(pool: &Pool, quotes: &[Quote]) -> Result<u64, String> {
    let mut c = pool.get().map_err(|e| e.to_string())?;
    let mut tx = c.transaction().map_err(|e| e.to_string())?;
    let mut n = 0;
    for q in quotes {
        n += tx
            .execute(
                "INSERT INTO fx_rates (code, source, observed_at, buy, sell)
                 SELECT $1, $2, $3::text::timestamptz, $4, $5
                 WHERE NOT EXISTS (
                     SELECT 1 FROM (SELECT buy, sell FROM fx_rates
                                    WHERE code = $1 AND observed_at <= $3::text::timestamptz
                                    ORDER BY observed_at DESC LIMIT 1) last
                     WHERE last.buy = $4 AND last.sell = $5)
                 ON CONFLICT (code, observed_at) DO NOTHING",
                &[&q.code, &q.source, &q.observed_at, &q.buy, &q.sell],
            )
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

/// Her kodun son fiyatı ve o fiyatın gününden (İstanbul) önceki son alış (günlük değişim).
pub fn latest(pool: &Pool) -> Result<Vec<(Quote, Option<i64>)>, String> {
    let mut c = pool.get().map_err(|e| e.to_string())?;
    let rows = c
        .query(
            &format!(
                "SELECT {COLUMNS},
                        (SELECT p.buy FROM fx_rates p
                         WHERE p.code = r.code
                           AND p.observed_at < date_trunc('day', r.observed_at + interval '3 hours') - interval '3 hours'
                         ORDER BY p.observed_at DESC LIMIT 1)
                 FROM (SELECT DISTINCT ON (code) * FROM fx_rates ORDER BY code, observed_at DESC) r"
            ),
            &[],
        )
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|r| (quote(r), r.get(5))).collect())
}

/// `[since, until)` aralığındaki son fiyat (UTC zaman damgaları).
pub fn last_between(pool: &Pool, code: &str, since: &str, until: &str) -> Result<Option<Quote>, String> {
    let mut c = pool.get().map_err(|e| e.to_string())?;
    let row = c
        .query_opt(
            &format!(
                "SELECT {COLUMNS} FROM fx_rates WHERE code = $1 AND observed_at >= $2::text::timestamptz
                 AND observed_at < $3::text::timestamptz ORDER BY observed_at DESC LIMIT 1"
            ),
            &[&code, &since, &until],
        )
        .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(quote))
}

/// Grafik için geçmiş: saat başına son fiyat, en yeni 5000 saat (≈ 7 ay), eskiden yeniye.
/// (Harem fiyatı 15 dk'da bir değiştiği için ham satırlar sınırı aşar; sınır yeni veriyi kesmemeli.)
pub fn history(pool: &Pool, code: &str, since: &str, until: &str) -> Result<Vec<Quote>, String> {
    let mut c = pool.get().map_err(|e| e.to_string())?;
    let rows = c
        .query(
            &format!(
                "SELECT {COLUMNS} FROM (
                     SELECT DISTINCT ON (date_trunc('hour', observed_at)) * FROM fx_rates
                     WHERE code = $1 AND observed_at >= $2::text::timestamptz AND observed_at < $3::text::timestamptz
                     ORDER BY date_trunc('hour', observed_at) DESC, observed_at DESC
                     LIMIT 5000
                 ) h ORDER BY observed_at"
            ),
            &[&code, &since, &until],
        )
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(quote).collect())
}
