//! TEFAS fon fiyatları. Sitenin kullandığı JSON servisi (resmî ve belgelenmiş değil; 2026-04'te değişti).
//! Ayrıştırma ağdan ayrıdır. Süreç başına istek sınırı `Limiter` ile tutulur.

use std::collections::VecDeque;

use super::amount::rate_from_f64;
use super::sources::{agent, install_crypto, Quote};
use super::time::*;
use super::FUND_PREFIX;
use crate::CoreResult;

const URL: &str = "https://www.tefas.gov.tr/api/funds/fonGnlBlgSiraliGetir";
const UNREADABLE: &str = "TEFAS yanıtı okunamadı.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FundKind {
    Yat,
    Byf,
}

impl FundKind {
    pub const ALL: [FundKind; 2] = [FundKind::Yat, FundKind::Byf];

    pub fn as_str(self) -> &'static str {
        match self {
            FundKind::Yat => "YAT",
            FundKind::Byf => "BYF",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            FundKind::Yat => "Yatırım fonu",
            FundKind::Byf => "Borsa yatırım fonu",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FundPrice {
    /// TEFAS kodu (öneksiz), ör. "AFT"
    pub code: String,
    pub name: String,
    pub kind: FundKind,
    /// Fiyat günü "YYYY-MM-DD"
    pub date: String,
    /// 1 payın TL fiyatı ×1e6
    pub price: i64,
}

fn number(v: Option<&serde_json::Value>) -> Option<f64> {
    match v? {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().replace(',', ".").parse().ok(),
        _ => None,
    }
}

/// TEFAS yanıtı → fiyatlar. Tatil/hafta sonu mesajları boş liste; diğer hata mesajları hata.
pub fn parse_funds(json: &str, kind: FundKind) -> CoreResult<Vec<FundPrice>> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|_| UNREADABLE.to_string())?;
    let obj = v.as_object().ok_or_else(|| UNREADABLE.to_string())?;
    if let Some(msg) = obj.get("errorMessage").and_then(|m| m.as_str()).filter(|m| !m.is_empty()) {
        let low = msg.to_lowercase();
        if low.contains("out of bounds") || low.contains("veri bulunamadı") {
            return Ok(Vec::new());
        }
        return Err(format!("TEFAS: {msg}"));
    }
    let rows = match obj.get("resultList") {
        Some(serde_json::Value::Array(a)) => a,
        Some(serde_json::Value::Null) | None => return Ok(Vec::new()),
        _ => return Err(UNREADABLE.into()),
    };
    let mut out = Vec::new();
    for r in rows {
        let (Some(code), Some(date)) = (r.get("fonKodu").and_then(|c| c.as_str()), r.get("tarih").and_then(|d| d.as_str())) else { continue };
        let date = date.get(..10).unwrap_or(date);
        if parse_ymd(date).is_none() {
            continue;
        }
        let bulletin = if kind == FundKind::Byf { number(r.get("borsaBultenFiyat")).filter(|p| *p > 0.0) } else { None };
        let Some(price) = bulletin.or_else(|| number(r.get("fiyat")).filter(|p| *p > 0.0)) else { continue };
        let Ok(price) = rate_from_f64(price) else { continue };
        out.push(FundPrice {
            code: code.trim().to_string(),
            name: r.get("fonUnvan").and_then(|n| n.as_str()).unwrap_or("").trim().to_string(),
            kind,
            date: date.to_string(),
            price,
        });
    }
    Ok(out)
}

/// Kayıt için kota: kod `FON:XXX`, kaynak `tefas`, fiyat günü 18:00 (İstanbul).
pub fn fund_quote(p: &FundPrice) -> Quote {
    let day = parse_ymd(&p.date).unwrap_or(0);
    Quote {
        code: format!("{FUND_PREFIX}{}", p.code),
        source: "tefas".into(),
        observed_at: iso_utc(istanbul_to_unix(day, 18, 0, 0)),
        buy: p.price,
        sell: p.price,
    }
}

fn ymd_compact(day: i64) -> String {
    ymd(day).replace('-', "")
}

fn post(kind: FundKind, code: Option<&str>, from: i64, to: i64) -> CoreResult<Vec<FundPrice>> {
    install_crypto();
    let body = serde_json::json!({
        "fonTipi": kind.as_str(), "fonKodu": code, "aramaMetni": null, "fonTurKod": null, "fonGrubu": null,
        "sfonTurKod": null, "fonTurAciklama": null, "kurucuKod": null,
        "basTarih": ymd_compact(from), "bitTarih": ymd_compact(to), "basSira": 1, "bitSira": 100000,
        "dil": "TR", "sFonTurKod": "", "fonKod": "", "fonGrup": "", "fonUnvanTip": ""
    });
    let res = agent()
        .post(URL)
        .set("Accept", "*/*")
        .set("Content-Type", "application/json")
        .set("Origin", "https://www.tefas.gov.tr")
        .set("Referer", "https://www.tefas.gov.tr/tr/fon-verileri")
        .send_string(&body.to_string());
    let text = match res {
        Ok(r) => r.into_string().map_err(|e| format!("TEFAS okunamadı: {e}"))?,
        Err(ureq::Error::Status(429, _)) => return Err("TEFAS istek sınırı; biraz sonra tekrar deneyin.".into()),
        Err(e) => return Err(format!("TEFAS'a ulaşılamadı: {e}")),
    };
    if text.trim().is_empty() {
        return Err(UNREADABLE.into());
    }
    parse_funds(&text, kind)
}

/// Bir türün tüm fonları, `[from, to]` (gün) aralığında; tek istek.
pub fn fetch_list(kind: FundKind, from: i64, to: i64) -> CoreResult<Vec<FundPrice>> {
    post(kind, None, from, to)
}

/// Tek fonun `[from, to]` aralığı (en çok 28 gün; daha uzunu kırpılır).
pub fn fetch_fund(code: &str, kind: FundKind, from: i64, to: i64) -> CoreResult<Vec<FundPrice>> {
    post(kind, Some(code), from.max(to - 27), to)
}

/// Süreç başına istek sınırı: dakikada `PER_MINUTE`; hata sonrası `RETRY_SECS` boyunca istek yok.
#[derive(Default)]
pub struct Limiter {
    sent: VecDeque<i64>,
    down_until: i64,
}

impl Limiter {
    pub const PER_MINUTE: usize = 5;
    pub const RETRY_SECS: i64 = 600;

    /// İstek gönderilebilirse yerini ayırır; gönderilemezse hata.
    pub fn check(&mut self, now: i64) -> CoreResult<()> {
        if now < self.down_until {
            return Err("TEFAS'a şu an ulaşılamıyor; birkaç dakika sonra tekrar denenecek.".into());
        }
        while self.sent.front().is_some_and(|t| now - t >= 60) {
            self.sent.pop_front();
        }
        if self.sent.len() >= Self::PER_MINUTE {
            return Err("TEFAS istek sınırı; biraz sonra tekrar deneyin.".into());
        }
        self.sent.push_back(now);
        Ok(())
    }

    /// Ağ hatası, 429, boş ya da okunamayan yanıt sonrası.
    pub fn failed(&mut self, now: i64) {
        self.down_until = now + Self::RETRY_SECS;
    }
}
