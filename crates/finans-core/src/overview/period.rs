//! Genel Bakış dönemleri (TS `presetRange`, `previousRange`)

use crate::accounts::cards::{add_days, clamped_date};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Period {
    ThisMonth,
    LastMonth,
    Last30,
    ThisYear,
    All,
}

impl Period {
    pub fn parse(s: &str) -> Option<Period> {
        match s {
            "thisMonth" => Some(Period::ThisMonth),
            "lastMonth" => Some(Period::LastMonth),
            "last30" => Some(Period::Last30),
            "thisYear" => Some(Period::ThisYear),
            "all" => Some(Period::All),
            _ => None,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Period::ThisMonth => "thisMonth",
            Period::LastMonth => "lastMonth",
            Period::Last30 => "last30",
            Period::ThisYear => "thisYear",
            Period::All => "all",
        }
    }
}

/// Tarih aralığı; `None` uç sınırsız
#[derive(Debug, Clone, Default)]
pub struct Range {
    pub from: Option<String>,
    pub to: Option<String>,
}

impl Range {
    pub fn contains(&self, date: &str) -> bool {
        self.from.as_deref().is_none_or(|f| date >= f) && self.to.as_deref().is_none_or(|t| date <= t)
    }
}

/// Yıl ve 0'dan başlayan ay
fn year_month0(today: &str) -> (i64, i64) {
    let num = |r: std::ops::Range<usize>| today.get(r).and_then(|s| s.parse::<i64>().ok()).unwrap_or(1);
    (num(0..4), num(5..7) - 1)
}

fn span(from: String, to: String) -> Range {
    Range { from: Some(from), to: Some(to) }
}

/// `month0` ayının tamamı (ay sonu `clamped_date` ile)
fn whole_month(y: i64, month0: i64) -> Range {
    span(clamped_date(y, month0, 1), clamped_date(y, month0, 31))
}

pub fn range(period: Period, today: &str) -> Range {
    let (y, m) = year_month0(today);
    match period {
        Period::ThisMonth => whole_month(y, m),
        Period::LastMonth => whole_month(y, m - 1),
        Period::Last30 => span(add_days(today, -29), today.to_string()),
        Period::ThisYear => span(format!("{y}-01-01"), format!("{y}-12-31")),
        Period::All => Range::default(),
    }
}

/// Bir önceki eşdeğer dönem (karşılaştırma için); "Tümü" için yok
pub fn previous(period: Period, today: &str) -> Option<Range> {
    let (y, m) = year_month0(today);
    match period {
        Period::ThisMonth => Some(whole_month(y, m - 1)),
        Period::LastMonth => Some(whole_month(y, m - 2)),
        Period::Last30 => Some(span(add_days(today, -59), add_days(today, -30))),
        Period::ThisYear => Some(span(format!("{}-01-01", y - 1), format!("{}-12-31", y - 1))),
        Period::All => None,
    }
}

/// Bu ayın son günü
pub fn month_end(today: &str) -> String {
    let (y, m) = year_month0(today);
    clamped_date(y, m, 31)
}
