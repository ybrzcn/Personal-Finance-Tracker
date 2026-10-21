//! Liste sıraları: arayüz listeleri bu sırayla gösterir (eski TS karşılaştırıcılarıyla aynı).
//! Türkçe ad karşılaştırması ICU ile yapılır (JS `localeCompare(…, "tr")` da ICU kullanır).
//! Sıralamalar kararlıdır: eşit kayıtlar veritabanından geldiği sırada kalır.

use crate::db::{Account, Category, Goal, RecurringItem, Transaction};
use icu_collator::{Collator, CollatorBorrowed};
use icu_locale_core::locale;
use std::cmp::Ordering;
use std::sync::OnceLock;

fn collator() -> &'static CollatorBorrowed<'static> {
    static C: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    C.get_or_init(|| Collator::try_new(locale!("tr").into(), Default::default()).expect("tr sıralama verisi"))
}

/// JS `a.localeCompare(b, "tr")` ile aynı sıra.
pub fn cmp_tr(a: &str, b: &str) -> Ordering {
    collator().compare(a, b)
}

/// Önce gelir, sonra gider.
fn income_first(a: &str, b: &str) -> Ordering {
    (a != "income").cmp(&(b != "income"))
}

/// Tarih yeniden eskiye; aynı günde oluşturma zamanı yeniden eskiye.
pub fn sort_transactions(xs: &mut [Transaction]) {
    xs.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| b.created_at.cmp(&a.created_at)));
}

/// Kullanıcının sırası, sonra ad.
pub fn sort_accounts(xs: &mut [Account]) {
    xs.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then_with(|| cmp_tr(&a.name, &b.name)));
}

/// Önce gelir kategorileri, sonra ad.
pub fn sort_categories(xs: &mut [Category]) {
    xs.sort_by(|a, b| income_first(&a.kind, &b.kind).then_with(|| if a.kind == b.kind { cmp_tr(&a.name, &b.name) } else { Ordering::Equal }));
}

/// Önce gelirler; aynı türde gün, sonra kullanıcının sırası.
pub fn sort_recurring(xs: &mut [RecurringItem]) {
    xs.sort_by(|a, b| {
        income_first(&a.kind, &b.kind).then_with(|| if a.kind == b.kind { a.day.cmp(&b.day).then(a.sort_order.cmp(&b.sort_order)) } else { Ordering::Equal })
    });
}

/// Hedef tarihi en yakın önce, tarihsizler sonda; aynıysa oluşturma sırası.
pub fn sort_goals(xs: &mut [Goal]) {
    let date = |g: &Goal| g.target_date.clone().unwrap_or_else(|| "9999-12-31".into());
    xs.sort_by(|a, b| date(a).cmp(&date(b)).then_with(|| a.created_at.cmp(&b.created_at)));
}
