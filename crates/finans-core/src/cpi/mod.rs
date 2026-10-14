//! TÜFE (tüketici fiyat endeksi) serisi: aylık endeks × 1.000.000. Kaynak TCMB EVDS.

pub mod evds;
pub mod live;

use std::collections::BTreeMap;

use serde::Serialize;

/// "YYYY-MM[-DD]" → ay anahtarı (yıl × 12 + ay − 1)
pub fn month_key(date: &str) -> Option<i32> {
    let y: i32 = date.get(0..4)?.parse().ok()?;
    let m: i32 = date.get(5..7)?.parse().ok()?;
    (date.as_bytes().get(4) == Some(&b'-') && (1..=12).contains(&m)).then_some(y * 12 + m - 1)
}

/// Ay anahtarı → "YYYY-MM"
pub fn month_label(key: i32) -> String {
    format!("{:04}-{:02}", key.div_euclid(12), key.rem_euclid(12) + 1)
}

/// Ay anahtarı → endeks × 1.000.000
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CpiSeries(pub BTreeMap<i32, i64>);

impl CpiSeries {
    pub fn latest(&self) -> Option<(i32, i64)> {
        self.0.iter().next_back().map(|(k, v)| (*k, *v))
    }

    /// Ayın endeksi. Ay henüz açıklanmadıysa (son aydan sonra) son ay, `true` (yaklaşık) ile döner.
    /// Serinin başından önceki ya da serideki bir boşluk ayı için None.
    pub fn index_at(&self, month: i32) -> Option<(i64, bool)> {
        if let Some(v) = self.0.get(&month) {
            return Some((*v, false));
        }
        let (last, v) = self.latest()?;
        (month > last).then_some((v, true))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CpiStatus {
    Ok,
    /// Anahtar tanımlı değil
    NoKey,
    /// Kaynağa ulaşılamadı ya da anahtar geçersiz (mesajda neden)
    Unavailable,
}

#[derive(Debug, Clone)]
pub struct CpiData {
    pub series: Option<CpiSeries>,
    pub status: CpiStatus,
    pub message: Option<String>,
}
