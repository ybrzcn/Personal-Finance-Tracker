//! Yatırım geliri (faiz, temettü, fon dağıtımı: seçili gelir kategorileri) ve varlık dağılımı.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};

use super::{AccountPnl, AssetFilter};
use crate::budget::recurring::shift_month;
use crate::accounts::bank::{tl_balance, tl_value};
use crate::accounts::cards::js_cents;
use crate::db::{Account, Category, Transaction};
use crate::fx::{self, instruments::Unit};

/// Yatırım geliri sayılan gelir kategorilerinin ayarı; yoksa adı "Yatırım" olan gelir kategorileri
pub const SETTING_KEY: &str = "investmentIncomeCategoryIds";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeMonth {
    /// "YYYY-MM"
    pub month: String,
    pub cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeCategory {
    pub category_id: String,
    pub cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestmentIncome {
    /// Sayılan gelir kategorileri (ayardan ya da varsayılan)
    pub category_ids: Vec<String>,
    /// Ayar yok: varsayılan ("Yatırım") kullanıldı
    pub default_categories: bool,
    /// Dönemdeki toplam (bugüne kadar)
    pub total_cents: i64,
    pub months: Vec<IncomeMonth>,
    /// Kategoriye göre, büyükten küçüğe
    pub by_category: Vec<IncomeCategory>,
}

/// Ayardaki listeden var olan gelir kategorileri; ayar yoksa (ya da bozuksa) adı "Yatırım" olanlar
pub fn income_category_ids(settings: &Map<String, Value>, categories: &[Category]) -> (Vec<String>, bool) {
    let income: Vec<&Category> = categories.iter().filter(|c| c.kind == "income").collect();
    match settings.get(SETTING_KEY).and_then(Value::as_array) {
        Some(ids) => {
            let ids: Vec<String> = ids.iter().filter_map(Value::as_str).filter(|id| income.iter().any(|c| c.id == *id)).map(String::from).collect();
            (ids, false)
        }
        None => (income.iter().filter(|c| fx::funds::tr_lower(c.name.trim()) == "yatırım").map(|c| c.id.clone()).collect(), true),
    }
}

/// Seçili kategorilerdeki gelirler: `from`–`to` (dahil, boşsa tüm zamanlar), bugünden sonrakiler sayılmaz.
/// Süzgeç gelirin girdiği hesabın birimine uygulanır: döviz/altın süzgecinde TL hesaplara gelen faiz sayılmaz.
/// Aylar dönemin başından (yoksa ilk gelir ayından) bugüne boşluksuz (gelir olmayan ay 0).
pub fn investment_income(
    txs: &[Transaction],
    accounts: &[Account],
    filter: AssetFilter,
    ids: (Vec<String>, bool),
    from: Option<&str>,
    to: Option<&str>,
    today: &str,
) -> InvestmentIncome {
    let (category_ids, default_categories) = ids;
    let currency_of = |id: &str| accounts.iter().find(|a| a.id == id).map_or(fx::TRY, |a| a.currency.as_str());
    let counts = |currency: &str| match filter {
        AssetFilter::All => true,
        AssetFilter::Fx => currency != fx::TRY && !fx::is_fund(currency),
        AssetFilter::Fund => fx::is_fund(currency),
    };
    let mut months: BTreeMap<String, i64> = BTreeMap::new();
    let mut by_cat: BTreeMap<String, i64> = BTreeMap::new();
    let mut total = 0;
    for t in txs.iter().filter(|t| t.kind == "income" && t.date.as_str() <= today) {
        let Some(cat) = t.category_id.as_deref().filter(|c| category_ids.iter().any(|id| id == c)) else { continue };
        if from.is_some_and(|f| t.date.as_str() < f) || to.is_some_and(|x| t.date.as_str() > x) || !counts(currency_of(&t.account_id)) {
            continue;
        }
        let cents = js_cents(t.amount);
        total += cents;
        *months.entry(t.date.get(..7).unwrap_or(&t.date).to_string()).or_default() += cents;
        *by_cat.entry(cat.to_string()).or_default() += cents;
    }
    // Boş aylar 0: grafikte aralıklar yanıltmasın
    let first = from.map(|f| f.get(..7).unwrap_or(f).to_string()).or_else(|| months.keys().next().cloned());
    if let Some(mut m) = first {
        let end = to.filter(|x| *x < today).unwrap_or(today);
        let end = end.get(..7).unwrap_or(end);
        while m.as_str() <= end {
            months.entry(m.clone()).or_default();
            m = shift_month(&m, 1);
        }
    }
    let mut by_category: Vec<IncomeCategory> = by_cat.into_iter().map(|(category_id, cents)| IncomeCategory { category_id, cents }).collect();
    by_category.sort_by_key(|c| std::cmp::Reverse(c.cents));
    InvestmentIncome {
        category_ids,
        default_categories,
        total_cents: total,
        months: months.into_iter().map(|(month, cents)| IncomeMonth { month, cents }).collect(),
        by_category,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationSlice {
    /// "tl" (TL nakit) | "deposit" (vadeli mevduat) | "pension" (BES) | "asset" (ev, araba…) | "fx" (döviz) |
    /// "metal" (altın, gümüş) | "fund" (fon)
    pub key: &'static str,
    pub value_cents: i64,
    /// Toplama oranı, baz puan
    pub share_bp: i64,
}

/// Bugünkü varlık dağılımı: artıdaki TL hesapları ve değeri bilinen döviz/maden/fon hesapları (süzgeçten bağımsız)
pub fn allocation(accounts: &[Account], txs: &[Transaction], foreign: &[AccountPnl], today: &str) -> Vec<AllocationSlice> {
    let tl_accounts = || accounts.iter().filter(|a| a.currency == fx::TRY && a.kind != "loan" && a.kind != "credit_card");
    let tl: i64 = tl_accounts().filter(|a| !a.is_saving()).map(|a| tl_balance(a, txs, today).max(0)).sum();
    let of = |subtype: &str| -> i64 { tl_accounts().filter(|a| a.subtype() == subtype).map(|a| tl_value(a, txs, today).max(0)).sum() };
    let (deposit, pension, asset) = (of("deposit"), of("pension"), of("asset"));
    let (mut cur, mut metal, mut fund) = (0i64, 0i64, 0i64);
    for a in foreign {
        let v = a.value_cents.unwrap_or(0).max(0);
        match fx::unit_or_try(Some(&a.currency)) {
            Unit::Share => fund += v,
            Unit::Gram | Unit::Piece => metal += v,
            Unit::Currency => cur += v,
        }
    }
    let total = tl + deposit + pension + asset + cur + metal + fund;
    [("tl", tl), ("deposit", deposit), ("pension", pension), ("asset", asset), ("fx", cur), ("metal", metal), ("fund", fund)]
        .into_iter()
        .filter(|(_, v)| *v > 0)
        .map(|(key, value_cents)| AllocationSlice {
            key,
            value_cents,
            share_bp: if total > 0 { ((value_cents as i128 * 10_000 + total as i128 / 2) / total as i128) as i64 } else { 0 },
        })
        .collect()
}
