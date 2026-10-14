//! Desteklenen para birimleri. Arayüzdeki `src/lib/fx.ts` listesiyle aynı sırada tutulur.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    /// Döviz: en küçük birim 1/100
    Currency,
    /// Gramla tartılan maden: en küçük birim miligram
    Gram,
    /// Adetli altın (çeyrek, Ata...): en küçük birim 1 adet
    Piece,
}

impl Unit {
    /// 1 birimdeki en küçük birim sayısı
    pub fn divisor(self) -> i64 {
        match self {
            Unit::Currency => 100,
            Unit::Gram => 1000,
            Unit::Piece => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Tcmb,
    Harem,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Tcmb => "tcmb",
            Source::Harem => "harem",
        }
    }
}

pub struct Instrument {
    pub code: &'static str,
    pub name: &'static str,
    pub unit: Unit,
    pub source: Source,
}

pub const TRY: &str = "TRY";

const fn tcmb(code: &'static str, name: &'static str) -> Instrument {
    Instrument { code, name, unit: Unit::Currency, source: Source::Tcmb }
}
const fn gram(code: &'static str, name: &'static str) -> Instrument {
    Instrument { code, name, unit: Unit::Gram, source: Source::Harem }
}
const fn piece(code: &'static str, name: &'static str) -> Instrument {
    Instrument { code, name, unit: Unit::Piece, source: Source::Harem }
}

pub const INSTRUMENTS: &[Instrument] = &[
    tcmb("USD", "ABD doları"),
    tcmb("EUR", "Euro"),
    tcmb("GBP", "İngiliz sterlini"),
    tcmb("CHF", "İsviçre frangı"),
    tcmb("JPY", "Japon yeni"),
    tcmb("CAD", "Kanada doları"),
    tcmb("AUD", "Avustralya doları"),
    tcmb("DKK", "Danimarka kronu"),
    tcmb("SEK", "İsveç kronu"),
    tcmb("NOK", "Norveç kronu"),
    tcmb("SAR", "Suudi Arabistan riyali"),
    tcmb("KWD", "Kuveyt dinarı"),
    tcmb("QAR", "Katar riyali"),
    tcmb("AED", "BAE dirhemi"),
    tcmb("RON", "Rumen leyi"),
    tcmb("RUB", "Rus rublesi"),
    tcmb("CNY", "Çin yuanı"),
    tcmb("PKR", "Pakistan rupisi"),
    tcmb("KRW", "Güney Kore wonu"),
    tcmb("AZN", "Azerbaycan manatı"),
    tcmb("KZT", "Kazakistan tengesi"),
    gram("ALTIN", "Gram altın (has)"),
    gram("KULCEALTIN", "Külçe altın"),
    gram("AYAR22", "22 ayar altın"),
    gram("AYAR14", "14 ayar altın"),
    piece("CEYREK_YENI", "Çeyrek altın (yeni)"),
    piece("CEYREK_ESKI", "Çeyrek altın (eski)"),
    piece("YARIM_YENI", "Yarım altın (yeni)"),
    piece("YARIM_ESKI", "Yarım altın (eski)"),
    piece("TEK_YENI", "Tam altın (yeni)"),
    piece("TEK_ESKI", "Tam altın (eski)"),
    piece("ATA_YENI", "Ata lira (yeni)"),
    piece("ATA_ESKI", "Ata lira (eski)"),
    piece("ATA5_YENI", "Ata beşli (yeni)"),
    piece("ATA5_ESKI", "Ata beşli (eski)"),
    piece("GREMESE_YENI", "Gremse (yeni)"),
    piece("GREMESE_ESKI", "Gremse (eski)"),
    gram("GUMUSTRY", "Gümüş"),
];

pub fn find(code: &str) -> Option<&'static Instrument> {
    INSTRUMENTS.iter().find(|i| i.code == code)
}

/// TRY dahil geçerli para biriminin birimi; bilinmeyen kod için None.
pub fn unit_of(code: &str) -> Option<Unit> {
    if code == TRY {
        Some(Unit::Currency)
    } else {
        find(code).map(|i| i.unit)
    }
}

/// Veritabanından okunan para birimi (yoksa ya da tanınmıyorsa TL kabul edilir).
pub fn unit_or_try(code: Option<&str>) -> Unit {
    code.and_then(unit_of).unwrap_or(Unit::Currency)
}
