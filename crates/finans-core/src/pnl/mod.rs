//! Döviz/altın kâr-zarar: ağırlıklı ortalama maliyet, gerçekleşen ve kâğıt üstü kâr/zarar, TÜFE ile reel getiri.
//! Saf hesap: hesaplar, işlemler, kurlar ve TÜFE dışarıdan verilir; ağ ya da veritabanı erişimi yok.
//! Bütün sayılar tam sayıdır: kuruş, kur ×1e6, baz puan, en küçük birim.

mod engine;
pub mod income;

use std::collections::HashMap;

use serde::Serialize;

pub use engine::report;
pub use income::{income_category_ids, AllocationSlice, InvestmentIncome};

use crate::cpi::{CpiData, CpiStatus};
use crate::db::{Account, Transaction};
use crate::fx::{self, amount::rate_from_f64, sources::RateView};
use crate::CoreResult;

/// Güncel alış kuru (1 birimin TL fiyatı × 1e6)
#[derive(Debug, Clone)]
pub struct CurrentRate {
    pub buy: i64,
    pub observed_at: String,
    pub stale: bool,
}

/// Raporun kapsadığı varlıklar
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetFilter {
    All,
    /// Döviz ve altın
    Fx,
    /// Yatırım fonları
    Fund,
}

impl AssetFilter {
    pub fn parse(s: Option<&str>) -> CoreResult<Self> {
        match s.unwrap_or("") {
            "" | "all" => Ok(AssetFilter::All),
            "fx" => Ok(AssetFilter::Fx),
            "fund" => Ok(AssetFilter::Fund),
            other => Err(format!("Geçersiz varlık türü: {other}")),
        }
    }

    pub fn matches(self, currency: &str) -> bool {
        match self {
            AssetFilter::All => true,
            AssetFilter::Fx => !fx::is_fund(currency),
            AssetFilter::Fund => fx::is_fund(currency),
        }
    }
}

pub struct PnlInput<'a> {
    pub accounts: &'a [Account],
    pub transactions: &'a [Transaction],
    /// Kod → güncel alış kuru
    pub rates: &'a HashMap<String, CurrentRate>,
    /// Hesap id → açılış günü alış kuru ×1e6 (`opening_needs` ile istenenler; bulunamayan yok)
    pub opening_rates: &'a HashMap<String, i64>,
    pub cpi: &'a CpiData,
    /// "YYYY-MM-DD"; bundan sonraki işlemler sayılmaz
    pub today: &'a str,
    /// Gerçekleşenler ve aylık özet için aralık (dahil); boşsa tüm zamanlar
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
    /// Süzgeç: hesaplar ve gerçekleşenler bu varlıklarla sınırlanır (yürüyüş tüm hesaplarla yapılır)
    pub filter: AssetFilter,
    /// Yatırım geliri sayılan gelir kategorileri ve varsayılan mı (`income_category_ids`); None: gelir ve dağılım
    /// hesaplanmaz (net servetin ay sonu maliyetleri)
    pub income_categories: Option<(Vec<String>, bool)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PnlReport {
    pub accounts: Vec<AccountPnl>,
    pub realized: Vec<RealizedItem>,
    pub months: Vec<MonthTotal>,
    pub totals: PnlTotals,
    pub cpi: CpiInfo,
    /// Dönemdeki faiz, temettü ve fon dağıtımı (seçili gelir kategorileri)
    pub income: Option<InvestmentIncome>,
    /// Bugünkü varlık dağılımı (süzgeçten bağımsız)
    pub allocation: Vec<AllocationSlice>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPnl {
    pub account_id: String,
    pub name: String,
    pub currency: String,
    pub qty_minor: i64,
    /// Gösterim miktarı
    pub qty: f64,
    /// Maliyet bilinmiyorsa yok
    pub cost_cents: Option<i64>,
    /// 1 birimin ortalama maliyeti ×1e6
    pub avg_cost_micros: Option<i64>,
    pub rate_micros: Option<i64>,
    pub rate_observed_at: Option<String>,
    pub value_cents: Option<i64>,
    pub unrealized_cents: Option<i64>,
    pub unrealized_bp: Option<i64>,
    /// Maliyetin son açıklanan aya taşınmış hali (TÜFE)
    pub real_cost_cents: Option<i64>,
    pub real_unrealized_cents: Option<i64>,
    pub real_unrealized_bp: Option<i64>,
    /// Maliyetin taşındığı enflasyon: reel maliyet / maliyet − 1
    pub inflation_bp: Option<i64>,
    pub cost_unknown: bool,
    /// İlk tutarsız (eldekinden fazla) çıkışın tarihi
    pub inconsistent_since: Option<String>,
    pub rate_stale: bool,
    pub no_rate: bool,
    pub cpi_approx: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealizedItem {
    pub transaction_id: String,
    pub date: String,
    pub account_id: String,
    /// "expense" | "transfer"
    pub kind: String,
    pub qty_minor: i64,
    /// Gösterim miktarı
    pub qty: f64,
    pub currency: String,
    pub proceeds_cents: i64,
    pub cost_cents: Option<i64>,
    pub pnl_cents: Option<i64>,
    pub real_pnl_cents: Option<i64>,
    pub cost_unknown: bool,
    pub cpi_approx: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthTotal {
    /// "YYYY-MM"
    pub month: String,
    pub pnl_cents: i64,
    /// Aydaki her satışın reel kârı biliniyorsa toplamı (TÜFE yoksa boş)
    pub real_pnl_cents: Option<i64>,
    /// Maliyeti bilinmeyen satış toplama girmedi
    pub partial: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PnlTotals {
    /// Değeri ve maliyeti bilinen hesapların maliyeti
    pub cost_cents: i64,
    /// Değeri bilinen bütün hesapların değeri
    pub value_cents: i64,
    pub unrealized_cents: i64,
    pub unrealized_bp: Option<i64>,
    pub real_unrealized_cents: Option<i64>,
    pub real_unrealized_bp: Option<i64>,
    pub inflation_bp: Option<i64>,
    /// Dönemde gerçekleşen (maliyeti bilinenler)
    pub realized_cents: i64,
    pub real_realized_cents: Option<i64>,
    /// Dönemdeki yatırım geliri
    pub income_cents: i64,
    /// Kâğıt üstü + dönemde gerçekleşen + dönemdeki yatırım geliri
    pub total_gain_cents: i64,
    /// Bir hesap ya da satış toplama girmedi (kur yok, maliyet bilinmiyor)
    pub partial: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpiInfo {
    pub status: CpiStatus,
    /// Son açıklanan ay "YYYY-MM"
    pub latest_month: Option<String>,
    pub message: Option<String>,
}

pub struct OpeningNeed {
    pub account_id: String,
    pub code: String,
    pub date: String,
}

fn foreign(a: &Account) -> bool {
    a.currency != fx::TRY && fx::unit_of(&a.currency).is_some()
}

/// Açılış maliyeti girilmemiş, açılış bakiyesi olan TL dışı hesaplar: açılış günü kuru gerekir.
pub fn opening_needs(accounts: &[Account]) -> Vec<OpeningNeed> {
    accounts
        .iter()
        .filter(|a| foreign(a) && a.opening_balance > 0.0 && a.opening_cost.flatten().is_none())
        .map(|a| OpeningNeed { account_id: a.id.clone(), code: a.currency.clone(), date: a.opening_date.clone() })
        .collect()
}

/// `opening_needs`'i `at` (kod, tarih → o günün kuru) ile doldurur. Bulunamayan ya da hata veren atlanır (çevrimdışı).
pub fn opening_rates(accounts: &[Account], at: impl Fn(&str, &str) -> CoreResult<Option<RateView>>) -> HashMap<String, i64> {
    opening_needs(accounts)
        .into_iter()
        .filter_map(|n| {
            let r = at(&n.code, &n.date).ok().flatten()?;
            Some((n.account_id, rate_from_f64(r.buy).ok()?))
        })
        .collect()
}

/// API kurları → kod başına alış ×1e6
pub fn current_rates(views: &[RateView]) -> HashMap<String, CurrentRate> {
    views
        .iter()
        .filter_map(|v| {
            Some((v.code.clone(), CurrentRate { buy: rate_from_f64(v.buy).ok()?, observed_at: v.observed_at.clone(), stale: v.stale }))
        })
        .collect()
}

/// Hesaplardaki fon birimleri (`FON:XXX`), benzersiz ve sıralı
pub fn fund_codes(accounts: &[Account]) -> Vec<String> {
    let mut v: Vec<String> = accounts.iter().filter(|a| fx::is_fund(&a.currency)).map(|a| a.currency.clone()).collect();
    v.sort();
    v.dedup();
    v
}
