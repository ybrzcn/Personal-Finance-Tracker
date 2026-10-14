//! Miktar ve kur dönüşümleri. Saklanan değerler tam sayıdır; ondalık yalnız API sınırında.

use super::instruments::{unit_or_try, Unit};
use crate::CoreResult;

/// Kur: 1 birimin TL fiyatı × 1.000.000
pub const RATE_SCALE: i64 = 1_000_000;
/// En büyük TL tutarı (kuruş); mevcut `to_cents` sınırıyla aynı (1e13 TL)
const MAX_CENTS: i128 = 1_000_000_000_000_000;

/// Doğal birimdeki miktar (1.250,00 USD; 12,5 g; 3 adet) → en küçük birim. Sıfırdan büyük olmalı.
pub fn value_to_minor(value: f64, unit: Unit) -> CoreResult<i64> {
    if !value.is_finite() || value <= 0.0 {
        return Err("Miktar sıfırdan büyük olmalıdır.".into());
    }
    if value > 1e12 {
        return Err("Miktar çok büyük.".into());
    }
    if unit == Unit::Piece && value.fract() != 0.0 {
        return Err("Adetli altın tam sayı olmalıdır.".into());
    }
    let minor = (value * unit.divisor() as f64).round();
    if minor < 1.0 {
        return Err("Miktar çok küçük.".into());
    }
    Ok(minor as i64)
}

/// Açılış bakiyesi gibi işaretli miktar (sıfır ve eksi olabilir).
pub fn signed_value_to_minor(value: f64, unit: Unit) -> CoreResult<i64> {
    if !value.is_finite() || value.abs() > 1e12 {
        return Err("Geçersiz miktar.".into());
    }
    if unit == Unit::Piece && value.fract() != 0.0 {
        return Err("Adetli altın tam sayı olmalıdır.".into());
    }
    Ok((value * unit.divisor() as f64).round() as i64)
}

pub fn minor_to_value(minor: i64, unit: Unit) -> f64 {
    minor as f64 / unit.divisor() as f64
}

pub fn rate_from_f64(rate: f64) -> CoreResult<i64> {
    if !rate.is_finite() || rate <= 0.0 {
        return Err("Kur sıfırdan büyük olmalıdır.".into());
    }
    if rate > 1e9 {
        return Err("Kur çok büyük.".into());
    }
    let r = (rate * RATE_SCALE as f64).round();
    if r < 1.0 {
        return Err("Kur çok küçük.".into());
    }
    Ok(r as i64)
}

pub fn rate_to_f64(micros: i64) -> f64 {
    micros as f64 / RATE_SCALE as f64
}

/// TL karşılığı (kuruş) = miktar × kur; yarım yukarı yuvarlanır. Sonuç 0 ya da sınırın üstündeyse hata.
pub fn tl_cents(minor: i64, rate_micros: i64, unit: Unit) -> CoreResult<i64> {
    if minor <= 0 || rate_micros <= 0 {
        return Err("Miktar ve kur sıfırdan büyük olmalıdır.".into());
    }
    let too_big = || "Tutar çok büyük.".to_string();
    let num = (minor as i128).checked_mul(rate_micros as i128).and_then(|n| n.checked_mul(100)).ok_or_else(too_big)?;
    let den = unit.divisor() as i128 * RATE_SCALE as i128;
    let cents = (num + den / 2) / den;
    if cents < 1 {
        return Err("TL karşılığı sıfır çıkıyor; miktarı ya da kuru kontrol edin.".into());
    }
    if cents > MAX_CENTS {
        return Err(too_big());
    }
    Ok(cents as i64)
}

/// Veritabanındaki (en küçük birim, kur) → API'deki (miktar, kur). `currency` hesabın para birimi.
pub fn stored_to_api(minor: Option<i64>, rate: Option<i64>, currency: Option<&str>) -> (Option<f64>, Option<f64>) {
    let unit = unit_or_try(currency);
    (minor.map(|m| minor_to_value(m, unit)), rate.map(rate_to_f64))
}
