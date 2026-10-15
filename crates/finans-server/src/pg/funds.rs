//! İzlenen fon kodları: bir kullanıcı fiyat istediğinde eklenir; toplayıcı yalnız bunları yazar.

use super::Pool;

pub fn touch(pool: &Pool, codes: &[String]) -> Result<(), String> {
    if codes.is_empty() {
        return Ok(());
    }
    let mut c = pool.get().map_err(|e| e.to_string())?;
    c.execute(
        // Zaman damgası günde bir yenilenir (her okumada yazma olmasın)
        "INSERT INTO fund_codes (code) SELECT DISTINCT unnest($1::text[]) ON CONFLICT (code) DO UPDATE SET last_requested = now()
         WHERE fund_codes.last_requested < now() - interval '1 day'",
        &[&codes],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn tracked(pool: &Pool) -> Result<Vec<String>, String> {
    let mut c = pool.get().map_err(|e| e.to_string())?;
    let rows = c.query("SELECT code FROM fund_codes ORDER BY code", &[]).map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

/// `days` gündür istenmeyen kodları siler
pub fn purge(pool: &Pool, days: i64) -> Result<u64, String> {
    let mut c = pool.get().map_err(|e| e.to_string())?;
    c.execute("DELETE FROM fund_codes WHERE last_requested < now() - make_interval(days => $1::int)", &[&(days as i32)])
        .map_err(|e| e.to_string())
}
