//! Kur kaynakları. TCMB: günlük XML (iş günü 15:30). Harem: socket.io akışı (yalnız WebSocket; resmî değil).
//! Ağ çağrıları senkron ve zaman aşımlıdır; sunucuda `spawn_blocking` içinde çağrılır.

use std::time::{Duration, Instant};

use serde::Serialize;

use super::amount::{rate_from_f64, rate_to_f64};
use super::instruments::{find, Source, INSTRUMENTS};
use super::time::*;
use crate::CoreResult;

#[derive(Debug, Clone, PartialEq)]
pub struct Quote {
    pub code: String,
    /// "tcmb" / "harem"
    pub source: String,
    /// "YYYY-MM-DDTHH:MM:SSZ"
    pub observed_at: String,
    /// 1 birimin TL fiyatı × 1.000.000
    pub buy: i64,
    pub sell: i64,
}

pub struct TcmbDay {
    /// Kur tarihi (XML'deki), "YYYY-MM-DD"
    pub date: String,
    pub quotes: Vec<Quote>,
}

/// API'ye dönen kur (TL, ondalık).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateView {
    pub code: String,
    pub source: String,
    pub observed_at: String,
    pub buy: f64,
    pub sell: f64,
    /// Bir önceki günün son alış fiyatı (günlük değişim); bilinmiyorsa yok
    pub prev_buy: Option<f64>,
    pub stale: bool,
}

impl RateView {
    pub fn from_quote(q: &Quote, prev_buy: Option<i64>, now: i64) -> Self {
        RateView {
            code: q.code.clone(),
            source: q.source.clone(),
            observed_at: q.observed_at.clone(),
            buy: rate_to_f64(q.buy),
            sell: rate_to_f64(q.sell),
            prev_buy: prev_buy.map(rate_to_f64),
            stale: is_stale(q, now),
        }
    }
}

/// Harem fiyatı 1 saatten, TCMB kuru 4 iş gününden eskiyse.
pub fn is_stale(q: &Quote, now: i64) -> bool {
    let Some(t) = parse_iso_utc(&q.observed_at) else { return true };
    if q.source == Source::Harem.as_str() {
        now - t > 3600
    } else {
        business_days_between(istanbul_today(t), istanbul_today(now)) > 4
    }
}

fn install_crypto() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).user_agent("finans").build()
}

fn attr<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let start = s.find(&format!("{name}=\""))? + name.len() + 2;
    let end = s[start..].find('"')? + start;
    Some(&s[start..end])
}

fn tag<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let start = s.find(&format!("<{name}>"))? + name.len() + 2;
    let end = s[start..].find(&format!("</{name}>"))? + start;
    Some(s[start..end].trim())
}

/// TCMB günlük XML'i. Satışı ya da alışı boş olan (XDR) ve listede olmayan kodlar alınmaz.
pub fn parse_tcmb(xml: &str) -> CoreResult<TcmbDay> {
    let bad = || "TCMB verisi okunamadı.".to_string();
    let head = xml.find("<Tarih_Date").map(|i| &xml[i..]).ok_or_else(bad)?;
    // Date="MM/DD/YYYY"
    let us = attr(head, "Date").ok_or_else(bad)?;
    let p: Vec<&str> = us.split('/').collect();
    if p.len() != 3 {
        return Err(bad());
    }
    let date = format!("{}-{}-{}", p[2], p[0], p[1]);
    let days = parse_ymd(&date).ok_or_else(bad)?;
    let observed_at = iso_utc(istanbul_to_unix(days, 15, 30, 0));
    let mut quotes = Vec::new();
    for block in xml.split("<Currency ").skip(1) {
        let Some(code) = attr(block, "CurrencyCode") else { continue };
        if !find(code).is_some_and(|i| i.source == Source::Tcmb) {
            continue;
        }
        let unit: f64 = tag(block, "Unit").and_then(|u| u.parse().ok()).filter(|u: &f64| *u > 0.0).unwrap_or(1.0);
        let rate = |name| tag(block, name).and_then(|v| v.parse::<f64>().ok()).and_then(|v| rate_from_f64(v / unit).ok());
        if let (Some(buy), Some(sell)) = (rate("ForexBuying"), rate("ForexSelling")) {
            quotes.push(Quote { code: code.into(), source: "tcmb".into(), observed_at: observed_at.clone(), buy, sell });
        }
    }
    if quotes.is_empty() {
        return Err(bad());
    }
    Ok(TcmbDay { date, quotes })
}

fn get_text(url: &str) -> CoreResult<Option<String>> {
    match agent().get(url).call() {
        Ok(r) => r.into_string().map(Some).map_err(|e| format!("Kur kaynağı okunamadı: {e}")),
        Err(ureq::Error::Status(404, _)) => Ok(None),
        Err(e) => Err(format!("Kur kaynağına ulaşılamadı: {e}")),
    }
}

pub fn fetch_tcmb_today() -> CoreResult<TcmbDay> {
    install_crypto();
    let xml = get_text("https://www.tcmb.gov.tr/kurlar/today.xml")?.ok_or("TCMB kuru bulunamadı.")?;
    parse_tcmb(&xml)
}

/// Arşivdeki gün; yayın yoksa (hafta sonu, tatil) None.
pub fn fetch_tcmb_on(days: i64) -> CoreResult<Option<TcmbDay>> {
    install_crypto();
    let (y, m, d) = civil_from_days(days);
    let url = format!("https://www.tcmb.gov.tr/kurlar/{y:04}{m:02}/{d:02}{m:02}{y:04}.xml");
    match get_text(&url)? {
        Some(xml) => parse_tcmb(&xml).map(Some),
        None => Ok(None),
    }
}

fn harem_number(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::String(s) => s.trim().parse().ok(),
        serde_json::Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

/// "DD-MM-YYYY HH:MM:SS" (İstanbul) → unix
fn harem_time(s: &str) -> Option<i64> {
    let (d, t) = s.split_once(' ')?;
    let dp: Vec<&str> = d.split('-').collect();
    let tp: Vec<u32> = t.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    if dp.len() != 3 || tp.len() != 3 {
        return None;
    }
    let days = parse_ymd(&format!("{}-{}-{}", dp[2], dp[1], dp[0]))?;
    Some(istanbul_to_unix(days, tp[0], tp[1], tp[2]))
}

/// `price_changed` olayının JSON'u (`42` öneki olmadan). Listede olmayan ve 0/boş fiyatlı kodlar elenir.
pub fn parse_harem(event: &str) -> Option<Vec<Quote>> {
    let v: serde_json::Value = serde_json::from_str(event).ok()?;
    if v.get(0)?.as_str()? != "price_changed" {
        return None;
    }
    let payload = v.get(1)?;
    let data = payload.get("data")?.as_object()?;
    let meta_time = payload.pointer("/meta/time").and_then(|t| t.as_i64()).map(|ms| ms / 1000);
    let quotes: Vec<Quote> = INSTRUMENTS
        .iter()
        .filter(|i| i.source == Source::Harem)
        .filter_map(|i| {
            let e = data.get(i.code)?;
            let buy = rate_from_f64(harem_number(e.get("alis")?)?).ok()?;
            let sell = rate_from_f64(harem_number(e.get("satis")?)?).ok()?;
            let t = e.get("tarih").and_then(|t| t.as_str()).and_then(harem_time).or(meta_time)?;
            Some(Quote { code: i.code.into(), source: "harem".into(), observed_at: iso_utc(t), buy, sell })
        })
        .collect();
    (!quotes.is_empty()).then_some(quotes)
}

/// Akışa bağlanır, ilk `price_changed` olayını okur ve bağlantıyı kapatır (en çok ~25 sn).
pub fn fetch_harem() -> CoreResult<Vec<Quote>> {
    use std::net::{TcpStream, ToSocketAddrs};
    use tungstenite::client::IntoClientRequest;
    use tungstenite::Message;
    install_crypto();
    let err = |e: &dyn std::fmt::Display| format!("Altın fiyatlarına ulaşılamadı: {e}");
    let host = "hrmsocketonly.haremaltin.com";
    let addr = (host, 443).to_socket_addrs().map_err(|e| err(&e))?.next().ok_or_else(|| err(&"adres yok"))?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10)).map_err(|e| err(&e))?;
    tcp.set_read_timeout(Some(Duration::from_secs(15))).map_err(|e| err(&e))?;
    tcp.set_write_timeout(Some(Duration::from_secs(10))).map_err(|e| err(&e))?;
    let mut req = format!("wss://{host}/socket.io/?EIO=4&transport=websocket").into_client_request().map_err(|e| err(&e))?;
    req.headers_mut().insert("Origin", "https://www.haremaltin.com".parse().unwrap());
    req.headers_mut().insert("User-Agent", "Mozilla/5.0 (finans)".parse().unwrap());
    let (mut ws, _) = tungstenite::client_tls_with_config(req, tcp, None, None).map_err(|e| err(&e))?;
    let deadline = Instant::now() + Duration::from_secs(25);
    while Instant::now() < deadline {
        let msg = ws.read().map_err(|e| err(&e))?;
        let Message::Text(text) = msg else { continue };
        let text: &str = text.as_ref();
        if text.starts_with('0') {
            ws.send(Message::Text("40".into())).map_err(|e| err(&e))?;
        } else if text == "2" {
            ws.send(Message::Text("3".into())).map_err(|e| err(&e))?;
        } else if let Some(event) = text.strip_prefix("42") {
            if let Some(q) = parse_harem(event) {
                let _ = ws.close(None);
                return Ok(q);
            }
        }
    }
    Err(err(&"zaman aşımı"))
}
