//! Kredi kartı: arayüzdeki `cards.ts` kurallarının aynısı.
//! Taksitler işlem tarihinde borca girer (kalan taksitlerin tamamı); takip başlangıcının ilk kesiminden önceki
//! ekstrelere düşen taksitler ve takip öncesi alacaklar sayılmaz.

use serde::Serialize;

use crate::db::{Account, Transaction};
use crate::fx::time::{days_between, days_from_civil, parse_ymd, ymd};

/// JavaScript `Math.round` (yarım yukarı, +∞ yönüne)
pub fn js_round(v: f64) -> i64 {
    // `(v + 0.5).floor()` 0.49999999999999994'ü 1'e yuvarlar; kesir ayrı karşılaştırılır
    let f = v.floor();
    (if v - f >= 0.5 { f + 1.0 } else { f }) as i64
}

/// TS `toCents`
pub fn js_cents(v: f64) -> i64 {
    js_round(v * 100.0)
}

pub(crate) fn days_in_month(y: i64, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    (days_from_civil(ny, nm, 1) - days_from_civil(y, m, 1)) as u32
}

/// `month0` (0 tabanlı, taşabilir) ayının `day`. günü; ayda o gün yoksa ayın son günü.
pub fn clamped_date(year: i64, month0: i64, day: i64) -> String {
    let y = year + month0.div_euclid(12);
    let m = (month0.rem_euclid(12) + 1) as u32;
    let d = (day.max(1) as u32).min(days_in_month(y, m));
    ymd(days_from_civil(y, m, d))
}

/// "YYYY-MM-DD" → (yıl, 0 tabanlı ay)
fn ym(iso: &str) -> (i64, i64) {
    (iso.get(0..4).and_then(|s| s.parse().ok()).unwrap_or(1970), iso.get(5..7).and_then(|s| s.parse::<i64>().ok()).unwrap_or(1) - 1)
}

/// `iso` tarihini içeren dönemin kesim tarihi (iso ≤ kesim)
pub fn closing_on_or_after(iso: &str, sd: i64) -> String {
    let (y, m) = ym(iso);
    let c = clamped_date(y, m, sd);
    if c.as_str() >= iso {
        c
    } else {
        clamped_date(y, m + 1, sd)
    }
}

pub fn shift_closing(closing: &str, months: i64, sd: i64) -> String {
    let (y, m) = ym(closing);
    clamped_date(y, m + months, sd)
}

/// Eşit taksitler (kuruş); artan kuruşlar ilk taksite
pub fn split_installments(total: i64, n: i64) -> Vec<i64> {
    let n = n.max(1);
    let base = total.div_euclid(n);
    let mut parts = vec![base; n as usize];
    parts[0] += total - base * n;
    parts
}

/// Kart hesabındaki tek hareket. `cents` > 0 borçlandırma, < 0 alacak (iade/ödeme).
#[derive(Debug, Clone)]
pub struct Movement {
    pub date: String,
    /// Yazıldığı ekstrenin kesim tarihi
    pub closing: String,
    pub cents: i64,
}

/// Takip başlangıcının (açılış tarihi) ilk ekstresi; daha önce kesilenler ödenmiş sayılır
pub fn first_tracked_closing(a: &Account) -> String {
    closing_on_or_after(&a.opening_date, a.statement_day.unwrap_or(1))
}

/// TS `cardMovements`
pub fn card_movements(a: &Account, txs: &[Transaction]) -> Vec<Movement> {
    let sd = a.statement_day.unwrap_or(1);
    let first = first_tracked_closing(a);
    let mut out = Vec::new();
    let opening = js_cents(a.opening_balance);
    if opening != 0 {
        out.push(Movement { date: a.opening_date.clone(), closing: first.clone(), cents: opening });
    }
    for t in txs {
        let c = js_cents(t.amount);
        let mine = t.account_id == a.id;
        let closing0 = closing_on_or_after(&t.date, sd);
        match t.kind.as_str() {
            "expense" if mine => {
                for (k, part) in split_installments(c, t.installments).into_iter().enumerate() {
                    let closing = shift_closing(&closing0, k as i64, sd);
                    if closing >= first {
                        out.push(Movement { date: t.date.clone(), closing, cents: part });
                    }
                }
            }
            "income" if mine => {
                if t.date >= a.opening_date {
                    out.push(Movement { date: t.date.clone(), closing: closing0, cents: -c });
                }
            }
            "transfer" => {
                if t.to_account_id.as_deref() == Some(a.id.as_str()) && t.date >= a.opening_date {
                    out.push(Movement { date: t.date.clone(), closing: closing0.clone(), cents: -c });
                }
                if mine && closing0 >= first {
                    out.push(Movement { date: t.date.clone(), closing: closing0, cents: c });
                }
            }
            _ => {}
        }
    }
    out
}

/// `d` tarihine kadarki (dahil) toplam borç; en az 0
pub fn debt_at(m: &[Movement], d: &str) -> i64 {
    m.iter().filter(|x| x.date.as_str() <= d).map(|x| x.cents).sum::<i64>().max(0)
}

/// `iso` tarihinde veya öncesindeki son kesim tarihi
pub fn closing_on_or_before(iso: &str, sd: i64) -> String {
    let (y, m) = ym(iso);
    let c = clamped_date(y, m, sd);
    if c.as_str() <= iso {
        c
    } else {
        clamped_date(y, m - 1, sd)
    }
}

/// Kesim tarihinden sonraki ilk `dd`. gün
pub fn due_date_for(closing: &str, dd: i64) -> String {
    let (y, m) = ym(closing);
    let c = clamped_date(y, m, dd);
    if c.as_str() > closing {
        c
    } else {
        clamped_date(y, m + 1, dd)
    }
}

/// TS `addDays`
pub fn add_days(iso: &str, n: i64) -> String {
    parse_ymd(iso).map(|d| ymd(d + n)).unwrap_or_else(|| iso.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Statement {
    pub period_start: String,
    pub closing_date: String,
    pub due_date: String,
    pub statement_cents: i64,
    /// Kesimden sonraki kesime kadar yapılan ödemeler (gecikmeli olanlar dahil)
    pub paid_cents: i64,
    pub remaining_cents: i64,
    pub min_payment_cents: i64,
    /// "none" | "paid" | "minPaid" | "pending" | "overdue"
    pub status: &'static str,
    /// Bugünden son ödemeye gün (eksi: gecikti)
    pub due_in_days: i64,
}

/// TS `statementFor`
pub fn statement_for(a: &Account, mv: &[Movement], closing: &str, today: &str) -> Statement {
    let sd = a.statement_day.unwrap_or(1);
    let due = due_date_for(closing, a.due_day.unwrap_or(1));
    // Son ödemeden sonra (gecikmeli) yapılan ödemeler de sonraki kesime kadar bu ekstreye sayılır
    let next = shift_closing(closing, 1, sd);
    let (mut debt, mut paid) = (0i64, 0i64);
    for m in mv {
        if m.cents > 0 {
            if m.closing.as_str() <= closing {
                debt += m.cents;
            }
        } else if m.date.as_str() <= closing {
            debt += m.cents;
        } else if m.date <= next {
            paid -= m.cents;
        }
    }
    let statement_cents = debt.max(0);
    let remaining_cents = (statement_cents - paid).max(0);
    let rate = a.min_payment_rate.unwrap_or(20.0);
    let min_payment_cents = statement_cents.min(js_round(statement_cents as f64 * rate / 100.0));
    let status = if statement_cents == 0 {
        "none"
    } else if remaining_cents == 0 {
        "paid"
    } else if paid >= min_payment_cents {
        "minPaid"
    } else if today > due.as_str() {
        "overdue"
    } else {
        "pending"
    };
    Statement {
        period_start: add_days(&shift_closing(closing, -1, sd), 1),
        closing_date: closing.to_string(),
        due_date: due.clone(),
        statement_cents,
        paid_cents: paid,
        remaining_cents,
        min_payment_cents,
        status,
        due_in_days: days_between(today, &due),
    }
}

/// TS `cardStatements`: kesilmiş son `count` ekstre, en yeni önce; açılıştan önceki dönemler yok
pub fn card_statements(a: &Account, mv: &[Movement], today: &str, count: usize) -> Vec<Statement> {
    let (Some(sd), Some(_)) = (a.statement_day, a.due_day) else { return Vec::new() };
    let first = first_tracked_closing(a);
    let mut out = Vec::new();
    let mut c = closing_on_or_before(today, sd);
    while out.len() < count && c >= first {
        out.push(statement_for(a, mv, &c, today));
        c = shift_closing(&c, -1, sd);
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmountHint {
    /// "Kalan ekstre" | "Asgari" | "Toplam borç"
    pub label: &'static str,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardReport {
    /// Taksitlerin tamamı dahil toplam borç (limit kullanımı)
    pub total_debt_cents: i64,
    pub available_cents: Option<i64>,
    /// Açık dönemde bir sonraki ekstreye yazılacak borçlandırmalar
    pub current_period_cents: i64,
    /// Sonraki ekstreden sonraki aylara yazılacak taksitler
    pub later_installments_cents: i64,
    pub next_closing_date: String,
    pub next_due_date: String,
    /// Kesilmiş son 6 ekstre, en yeni önce
    pub statements: Vec<Statement>,
    /// Kart ödeme formu için hazır tutarlar
    pub hints: Vec<AmountHint>,
}

/// TS `cardSummary` + `cardStatements(…, 6)` + `paymentHints`
pub fn card_report(a: &Account, txs: &[Transaction], today: &str) -> CardReport {
    let sd = a.statement_day.unwrap_or(1);
    let mv = card_movements(a, txs);
    let total_debt_cents: i64 = mv.iter().map(|m| m.cents).sum();
    let next_closing_date = closing_on_or_after(&add_days(today, 1), sd);
    let charges = |f: &dyn Fn(&str) -> bool| mv.iter().filter(|m| m.cents > 0 && f(&m.closing)).map(|m| m.cents).sum::<i64>();
    let current_period_cents = charges(&|c| c == next_closing_date);
    let later_installments_cents = charges(&|c| c > next_closing_date.as_str());
    let statements = card_statements(a, &mv, today, 6);
    let mut hints = Vec::new();
    if let Some(s) = statements.first().filter(|s| s.remaining_cents > 0) {
        hints.push(AmountHint { label: "Kalan ekstre", amount_cents: s.remaining_cents });
        let min_left = s.min_payment_cents - s.paid_cents;
        if min_left > 0 {
            hints.push(AmountHint { label: "Asgari", amount_cents: min_left });
        }
    }
    if total_debt_cents > 0 {
        hints.push(AmountHint { label: "Toplam borç", amount_cents: total_debt_cents });
    }
    CardReport {
        total_debt_cents,
        available_cents: a.credit_limit.map(|l| js_cents(l) - total_debt_cents),
        current_period_cents,
        later_installments_cents,
        next_due_date: due_date_for(&next_closing_date, a.due_day.unwrap_or(1)),
        next_closing_date,
        statements,
        hints,
    }
}

/// Taksitli kart harcamasının bir parçası ve yazıldığı ekstre
#[derive(Debug, Clone)]
pub struct InstallmentPosting {
    pub closing_date: String,
    pub due_date: String,
    pub cents: i64,
}

/// TS `installmentPostings` (takip öncesi parçalar dahil; bütçe onları da sayar)
pub fn installment_postings(a: &Account, date: &str, amount: f64, n: i64) -> Vec<InstallmentPosting> {
    let sd = a.statement_day.unwrap_or(1);
    let dd = a.due_day.unwrap_or(1);
    let closing0 = closing_on_or_after(date, sd);
    split_installments(js_cents(amount), n.max(1))
        .into_iter()
        .enumerate()
        .map(|(k, cents)| {
            let c = shift_closing(&closing0, k as i64, sd);
            InstallmentPosting { due_date: due_date_for(&c, dd), closing_date: c, cents }
        })
        .collect()
}

/// Bir işlemin aylara bölünmüş hâli (kuruş)
#[derive(Debug, Clone)]
pub struct SpreadPart {
    pub date: String,
    pub cents: i64,
}

/// TS `spreadInstallments([t])`: taksitli gider her ay bir parça, diğerleri tek parça
pub fn spread_installments(t: &Transaction) -> Vec<SpreadPart> {
    let n = if t.kind == "expense" { t.installments } else { 1 };
    if n <= 1 {
        return vec![SpreadPart { date: t.date.clone(), cents: js_cents(t.amount) }];
    }
    let (y, m) = ym(&t.date);
    let d = t.date.get(8..10).and_then(|x| x.parse().ok()).unwrap_or(1);
    split_installments(js_cents(t.amount), n)
        .into_iter()
        .enumerate()
        .map(|(k, cents)| SpreadPart { date: clamped_date(y, m + k as i64, d), cents })
        .collect()
}

/// Ödeme takvimindeki kart ödemesi (TS `CardDue`)
#[derive(Debug, Clone)]
pub struct CardDue {
    pub closing_date: String,
    pub due_date: String,
    pub amount_cents: i64,
    pub estimated: bool,
}

/// TS `cardDues`: son kesilmiş ekstrenin kalanı (ödenmemişse) ve son ödemesi `until`'e kadar düşen tahmini ekstreler
pub fn card_dues(a: &Account, txs: &[Transaction], today: &str, until: &str) -> Vec<CardDue> {
    let (Some(sd), Some(dd)) = (a.statement_day.filter(|d| *d != 0), a.due_day.filter(|d| *d != 0)) else { return Vec::new() };
    let mv = card_movements(a, txs);
    let first = first_tracked_closing(a);
    let mut out = Vec::new();
    let last = closing_on_or_before(today, sd);
    if last >= first {
        let s = statement_for(a, &mv, &last, today);
        if s.remaining_cents > 0 && (s.due_date.as_str() >= today || s.status == "overdue") {
            out.push(CardDue { closing_date: last.clone(), due_date: s.due_date, amount_cents: s.remaining_cents, estimated: false });
        }
    }
    let included: i64 = out.iter().map(|d| d.amount_cents).sum();
    let mut estimated = Vec::new();
    let mut c = shift_closing(&last, 1, sd);
    while due_date_for(&c, dd).as_str() <= until {
        let cents = mv.iter().filter(|m| m.cents > 0 && m.closing == c).map(|m| m.cents).sum();
        estimated.push(CardDue { due_date: due_date_for(&c, dd), closing_date: c.clone(), amount_cents: cents, estimated: true });
        c = shift_closing(&c, 1, sd);
    }
    // Toplam borçla uzlaştır: devreden kalan (+) ve açık dönemdeki ödeme/iadeler (−) sonraki tahmini ekstreye yansır
    let total: i64 = mv.iter().map(|m| m.cents).sum();
    let future: i64 = mv.iter().filter(|m| m.cents > 0 && m.closing > last).map(|m| m.cents).sum();
    let mut adjust = total - included - future;
    for d in estimated.iter_mut() {
        if adjust == 0 {
            break;
        }
        let next = (d.amount_cents + adjust).max(0);
        adjust -= next - d.amount_cents;
        d.amount_cents = next;
        if adjust > 0 {
            break;
        }
    }
    out.extend(estimated.into_iter().filter(|d| d.amount_cents > 0));
    out
}
