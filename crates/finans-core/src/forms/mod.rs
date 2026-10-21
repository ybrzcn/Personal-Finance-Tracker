//! Form önizlemeleri: işlem, hesap ve düzenli kayıt formlarının kayıttan önce gösterdiği hesaplar (TS form içi hesaplar)

pub mod account;
pub mod recurring;
pub mod transaction;

use crate::accounts::cards::js_round;
use crate::fx::instruments::{unit_or_try, Unit};

pub use self::account::{account_preview, AccountDraft, AccountPreview, LastStatement, LoanDraft};
pub use self::recurring::{recurring_preview, RecurringAmounts, RecurringBase, RecurringDraft, RecurringPreview, WeekendMove};
pub use self::transaction::{needs_transactions, wants_suggestion, transaction_preview, AdvanceParts, CashAdvanceDraft, CashAdvancePreview, CashAfter, PostingRow, TransactionDraft, TransactionPreview};

/// TS `isForeign`
fn is_foreign(code: &str) -> bool {
    !code.is_empty() && code != "TRY"
}

fn unit(code: &str) -> Unit {
    unit_or_try(Some(code))
}

/// TS `qtyDecimals`
pub(crate) fn qty_decimals(code: &str) -> i32 {
    match unit(code) {
        Unit::Currency => 2,
        Unit::Gram => 3,
        _ => 0,
    }
}

/// TS `tlCents(toMinor(value), rateMicros(rate))`: `fx::amount::tl_cents`'in hatasız hâli (sonuç 0 olabilir)
fn tl_cents_of(value: f64, rate: f64, code: &str) -> i64 {
    let u = unit(code);
    let minor = js_round(value * u.divisor() as f64) as i128;
    let micros = js_round(rate * 1_000_000.0) as i128;
    let den = u.divisor() as i128 * 1_000_000;
    ((minor * micros * 100 + den / 2) / den) as i64
}
