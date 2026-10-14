//! TCMB EVDS: aylık TÜFE genel endeksi. Anahtar `key` başlığıyla gönderilir.

use crate::fx::sources::{agent, install_crypto};
use crate::fx::time::{civil_from_days, istanbul_today, unix_now};
use crate::CoreResult;

const BASE: &str = "https://evds3.tcmb.gov.tr/igmevdsms-dis/";
/// Eskiden yeniye seriler; baz değişikliği zincirlenir. TP.FG.J0 (2003=100) 2003-01..2026-01, sonra durdu;
/// TP.TUKFIY2025.GENEL (2025=100) 2005-01'den bugüne (eski serinin ölçeklenmişi). 2003-2004 eski seriden ölçeklenir.
pub const SERIES: &[&str] = &["TP.FG.J0", "TP.TUKFIY2025.GENEL"];

/// `{"items":[{"Tarih":"2003-1","TP_FG_J0":"94.77"},…]}` → (ay anahtarı, endeks ×1e6). Boş değerler atlanır.
pub fn parse_evds(json: &str, series: &str) -> CoreResult<Vec<(i32, i64)>> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|_| "TÜFE yanıtı okunamadı.".to_string())?;
    let items = v.get("items").and_then(|i| i.as_array()).ok_or("TÜFE yanıtında veri yok.")?;
    let field = series.replace('.', "_");
    let mut out = Vec::new();
    for it in items {
        let Some(t) = it.get("Tarih").and_then(|t| t.as_str()) else { continue };
        let Some((y, m)) = t.split_once('-') else { continue };
        let (Ok(y), Ok(m)) = (y.trim().parse::<i32>(), m.trim().parse::<i32>()) else { continue };
        if !(1..=12).contains(&m) {
            continue;
        }
        let val = match it.get(&field) {
            Some(serde_json::Value::String(s)) => s.trim().parse::<f64>().ok(),
            Some(serde_json::Value::Number(n)) => n.as_f64(),
            _ => None,
        };
        let Some(val) = val.filter(|v| v.is_finite() && *v > 0.0) else { continue };
        out.push((y * 12 + m - 1, (val * 1_000_000.0).round() as i64));
    }
    out.sort();
    Ok(out)
}

/// Seriler eskiden yeniye verilir. Her eski seri, yeni seriyle çakışan ilk ayın oranıyla (yeni/eski) yeni ölçeğe çekilir;
/// çakışan aylarda yeni seri geçerlidir.
pub fn chain(mut parts: Vec<Vec<(i32, i64)>>) -> Vec<(i32, i64)> {
    let Some(mut acc) = parts.pop() else { return Vec::new() };
    while let Some(old) = parts.pop() {
        let first_new = acc.first().map(|p| p.0);
        let Some((k, nv)) = acc.first().copied() else {
            acc = old;
            continue;
        };
        let Some(ov) = old.iter().find(|p| p.0 == k).map(|p| p.1) else {
            // Çakışma yok: ölçek bilinmez, eski seri alınmaz
            continue;
        };
        let mut scaled: Vec<(i32, i64)> = old
            .into_iter()
            .filter(|p| Some(p.0) < first_new)
            .map(|(m, v)| (m, ((v as i128 * nv as i128 + ov as i128 / 2) / ov as i128) as i64))
            .collect();
        scaled.extend(acc);
        acc = scaled;
    }
    acc
}

pub fn series_url(series: &str, from_year: i32, to_year: i32) -> String {
    format!("{BASE}series={series}&startDate=01-01-{from_year}&endDate=31-12-{to_year}&type=json")
}

fn this_year() -> i32 {
    civil_from_days(istanbul_today(unix_now())).0 as i32
}

fn fetch_one(key: &str, series: &str, from_year: i32) -> CoreResult<Vec<(i32, i64)>> {
    install_crypto();
    match agent().get(&series_url(series, from_year, this_year())).set("key", key).call() {
        Ok(r) => parse_evds(&r.into_string().map_err(|e| format!("EVDS yanıtı okunamadı: {e}"))?, series),
        Err(ureq::Error::Status(401 | 403, _)) => Err("EVDS anahtarı geçersiz.".into()),
        Err(e) => Err(format!("EVDS'e ulaşılamadı: {e}")),
    }
}

/// Bütün TÜFE serisi (2003'ten bugüne), gerekirse zincirlenmiş.
pub fn fetch_series(key: &str) -> CoreResult<Vec<(i32, i64)>> {
    let parts = SERIES.iter().map(|s| fetch_one(key, s, 2003)).collect::<CoreResult<Vec<_>>>()?;
    let out = chain(parts);
    if out.is_empty() {
        return Err("EVDS'ten TÜFE verisi gelmedi.".into());
    }
    Ok(out)
}

/// Yalnız son seriden, `from_year` başından bugüne (saklı seri zaten bu ölçekte; günlük güncelleme için).
pub fn fetch_recent(key: &str, from_year: i32) -> CoreResult<Vec<(i32, i64)>> {
    let series = SERIES.last().ok_or("TÜFE serisi tanımlı değil.")?;
    fetch_one(key, series, from_year)
}
