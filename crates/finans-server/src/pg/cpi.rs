//! Ortak TÜFE tablosu (`cpi`): ay başı tarihi → endeks ×1e6. Değişen geçmiş aylar güncellenir.

use finans_core::cpi::{month_key, month_label, CpiSeries};

use super::Pool;

pub fn upsert(pool: &Pool, rows: &[(i32, i64)]) -> Result<u64, String> {
    let mut c = pool.get().map_err(|e| e.to_string())?;
    let mut tx = c.transaction().map_err(|e| e.to_string())?;
    let mut n = 0;
    for (k, v) in rows {
        let month = format!("{}-01", month_label(*k));
        n += tx
            .execute(
                "INSERT INTO cpi (month, index_micros) VALUES ($1::text::date, $2)
                 ON CONFLICT (month) DO UPDATE SET index_micros = EXCLUDED.index_micros
                 WHERE cpi.index_micros <> EXCLUDED.index_micros",
                &[&month, v],
            )
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

pub fn load(pool: &Pool) -> Result<CpiSeries, String> {
    let mut c = pool.get().map_err(|e| e.to_string())?;
    let rows = c.query("SELECT month::text, index_micros FROM cpi ORDER BY month", &[]).map_err(|e| e.to_string())?;
    Ok(CpiSeries(rows.iter().filter_map(|r| Some((month_key(r.get::<_, &str>(0))?, r.get::<_, i64>(1)))).collect()))
}
