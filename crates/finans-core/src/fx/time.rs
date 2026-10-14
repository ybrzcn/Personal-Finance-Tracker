//! Takvim yardımcıları. İstanbul UTC+3 (Türkiye 2016'dan beri yaz saati uygulamıyor).

use std::time::{SystemTime, UNIX_EPOCH};

pub const ISTANBUL_OFFSET: i64 = 3 * 3600;

pub fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// (yıl, ay, gün) → 1970-01-01'den gün sayısı (Howard Hinnant, "days_from_civil")
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

pub fn ymd(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// "YYYY-MM-DD" → gün sayısı; geçersiz tarih None
pub fn parse_ymd(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    let m: u32 = s[5..7].parse().ok()?;
    let d: u32 = s[8..10].parse().ok()?;
    let days = days_from_civil(y, m, d);
    (civil_from_days(days) == (y, m, d)).then_some(days)
}

/// Unix saniye → "YYYY-MM-DDTHH:MM:SSZ"
pub fn iso_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    format!("{}T{:02}:{:02}:{:02}Z", ymd(days), rem / 3600, rem % 3600 / 60, rem % 60)
}

/// "YYYY-MM-DDTHH:MM:SS[.fff]Z" → unix saniye
pub fn parse_iso_utc(s: &str) -> Option<i64> {
    if s.len() < 20 || !s.ends_with('Z') || s.as_bytes()[10] != b'T' {
        return None;
    }
    let days = parse_ymd(&s[0..10])?;
    let h: i64 = s.get(11..13)?.parse().ok()?;
    let mi: i64 = s.get(14..16)?.parse().ok()?;
    let se: i64 = s.get(17..19)?.parse().ok()?;
    Some(days * 86_400 + h * 3600 + mi * 60 + se)
}

/// İstanbul yerel tarih-saati → unix saniye
pub fn istanbul_to_unix(days: i64, h: u32, mi: u32, s: u32) -> i64 {
    days * 86_400 + i64::from(h) * 3600 + i64::from(mi) * 60 + i64::from(s) - ISTANBUL_OFFSET
}

/// İstanbul'da bugünün gün sayısı
pub fn istanbul_today(now: i64) -> i64 {
    (now + ISTANBUL_OFFSET).div_euclid(86_400)
}

/// İstanbul'da günün kaçıncı dakikası
pub fn istanbul_minute(now: i64) -> i64 {
    (now + ISTANBUL_OFFSET).rem_euclid(86_400) / 60
}

/// 0 = Pazartesi … 6 = Pazar (1970-01-01 Perşembe)
pub fn weekday(days: i64) -> u32 {
    (days + 3).rem_euclid(7) as u32
}

/// (from, to] aralığındaki iş günü (Pzt–Cum) sayısı
pub fn business_days_between(from: i64, to: i64) -> i64 {
    ((from + 1)..=to).filter(|d| weekday(*d) < 5).count() as i64
}
