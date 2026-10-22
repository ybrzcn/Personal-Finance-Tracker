//! Banka/nakit TL bakiyesi ve TL dışı hesap miktarı/değeri: arayüzdeki `accounts.ts` kurallarının aynısı.

use serde::Serialize;

use crate::db::{Account, Transaction};
use crate::fx::amount::RATE_SCALE;
use crate::fx::Unit;

use super::cards::{js_cents, js_round};

/// TS `toMinor`: değer × bölen, JS yuvarlaması
pub fn minor(v: f64, unit: Unit) -> i64 {
    js_round(v * unit.divisor() as f64)
}

/// TS `tlCents` (işaret korunur)
pub fn value_cents(qty: i64, rate: i64, unit: Unit) -> i64 {
    if qty == 0 {
        return 0;
    }
    let num = qty.unsigned_abs() as i128 * rate as i128 * 100;
    let den = unit.divisor() as i128 * RATE_SCALE as i128;
    qty.signum() * ((num + den / 2) / den) as i64
}

/// TS `bankBalanceCents(account, txs, d)`: `d`'den sonraki (ileri tarihli) işlemler sayılmaz
pub fn tl_balance(a: &Account, txs: &[Transaction], d: &str) -> i64 {
    let mut b = js_cents(a.opening_balance);
    for t in txs.iter().filter(|t| t.date.as_str() <= d) {
        let c = js_cents(t.amount);
        if t.account_id == a.id {
            b += if t.kind == "income" { c } else { -c };
        }
        if t.kind == "transfer" && t.to_account_id.as_deref() == Some(a.id.as_str()) {
            b += c;
        }
    }
    b
}

/// TS `nativeBalanceMinor(account, txs, d)`
pub fn qty_at(a: &Account, unit: Unit, txs: &[Transaction], d: &str) -> i64 {
    let mut q = minor(a.opening_balance, unit);
    for t in txs.iter().filter(|t| t.date.as_str() <= d) {
        if t.account_id == a.id {
            if let Some(o) = t.orig_amount {
                q += if t.kind == "income" { 1 } else { -1 } * minor(o, unit);
            }
        }
        if t.kind == "transfer" && t.to_account_id.as_deref() == Some(a.id.as_str()) {
            if let Some(o) = t.to_orig_amount {
                q += minor(o, unit);
            }
        }
    }
    q
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BankSummary {
    pub balance_cents: i64,
    pub overdraft_used_cents: i64,
    /// Bakiye + KMH limiti; KMH yoksa None
    pub available_cents: Option<i64>,
    /// BES ve diğer varlık: son elle değerleme (tarihi ve bakiyeye göre farkı); değerleme yoksa None
    pub valuation: Option<ValuationInfo>,
    /// Vadeli mevduat dönemi
    pub deposit: Option<DepositInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValuationInfo {
    pub date: String,
    pub value_cents: i64,
    /// Değer − defter bakiyesi (BES: katkılara göre kazanç; varlık: alış/maliyete göre)
    pub gain_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositInfo {
    /// Anapara: dönem başındaki bakiye (yenilenen dönemde önceki faiz dahil; dönem içi giriş/çıkış faizi değiştirmez)
    pub principal_cents: i64,
    pub term_days: i64,
    pub elapsed_days: i64,
    /// Vadeye gün (eksi: vade geçti)
    pub days_left: i64,
    /// Dönem sonu brüt faiz, stopaj ve net faiz (basit faiz, 365 gün)
    pub gross_cents: i64,
    pub tax_cents: i64,
    pub net_cents: i64,
    /// Bugüne kadar işleyen net faiz (dönemle orantılı)
    pub accrued_net_cents: i64,
    pub maturity_value_cents: i64,
    pub matured: bool,
}

/// Vadeli mevduat dönemi: anapara dönem başındaki bakiye; faiz = anapara × yıllık oran × gün / 365, stopaj brüt faizden
pub fn deposit_info(a: &Account, txs: &[Transaction], today: &str) -> Option<DepositInfo> {
    use crate::fx::time::days_between;
    let d = a.deposit()?;
    let principal = tl_balance(a, txs, &d.start);
    let term = days_between(&d.start, &d.maturity).max(1);
    let elapsed = days_between(&d.start, today).clamp(0, term);
    let gross = js_round(principal.max(0) as f64 * d.rate / 100.0 * term as f64 / 365.0);
    let tax = js_round(gross as f64 * d.tax_rate / 100.0);
    let net = gross - tax;
    Some(DepositInfo {
        principal_cents: principal,
        term_days: term,
        elapsed_days: elapsed,
        days_left: days_between(today, &d.maturity),
        gross_cents: gross,
        tax_cents: tax,
        net_cents: net,
        accrued_net_cents: js_round(net as f64 * elapsed as f64 / term as f64),
        maturity_value_cents: principal + net,
        matured: today >= d.maturity.as_str(),
    })
}

/// TL hesabın `d` günündeki değeri: BES ve diğer varlıkta o güne kadarki son elle değerleme (yoksa defter bakiyesi),
/// diğerlerinde bakiye
pub fn tl_value(a: &Account, txs: &[Transaction], d: &str) -> i64 {
    if matches!(a.subtype(), "pension" | "asset") {
        if let Some(v) = a.valuations().iter().rev().find(|v| v.date.as_str() <= d) {
            return js_cents(v.value);
        }
    }
    tl_balance(a, txs, d)
}

/// TS `bankSummary(account, txs, today)`
pub fn bank_summary(a: &Account, txs: &[Transaction], today: &str) -> BankSummary {
    let balance_cents = tl_balance(a, txs, today);
    // Mevduat, BES ve varlıkta KMH yok
    let is_bank = a.kind == "bank" && !a.is_saving();
    let limit = if is_bank { a.credit_limit.map(js_cents) } else { None };
    let valuation = match a.subtype() {
        "pension" | "asset" => a.valuations().iter().rev().find(|v| v.date.as_str() <= today).map(|v| ValuationInfo {
            date: v.date.clone(),
            value_cents: js_cents(v.value),
            gain_cents: js_cents(v.value) - balance_cents,
        }),
        _ => None,
    };
    BankSummary {
        balance_cents,
        overdraft_used_cents: if is_bank { (-balance_cents).max(0) } else { 0 },
        available_cents: limit.map(|l| balance_cents + l),
        valuation,
        deposit: deposit_info(a, txs, today),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxSummary {
    /// Hesabın biriminde en küçük birim
    pub qty_minor: i64,
    /// Gösterim miktarı (birimin kendisiyle: 12,50 USD, 3,125 gram)
    pub qty: f64,
    /// Güncel alış kuruyla TL; kur yoksa None
    pub value_cents: Option<i64>,
}

/// TS `nativeBalanceMinor` + `fxValueCents`; `rate` güncel alış (mikro)
pub fn fx_summary(a: &Account, unit: Unit, txs: &[Transaction], rate: Option<i64>, today: &str) -> FxSummary {
    let qty_minor = qty_at(a, unit, txs, today);
    FxSummary { qty_minor, qty: qty_minor as f64 / unit.divisor() as f64, value_cents: rate.map(|r| value_cents(qty_minor, r, unit)) }
}
