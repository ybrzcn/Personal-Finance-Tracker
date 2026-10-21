//! Ekstre içe aktarma: dosyadan okunan metin/tablodan işlem satırlarına (TS `statementImport.ts`)

pub mod card;
pub mod columns;
pub mod csv;
pub mod merge;
pub mod palette;
pub mod parse;
pub mod rows;
pub mod summary;
pub mod table;
pub mod totals;

use serde::Serialize;

use crate::statement::StatementFile;
use crate::CoreResult;

pub use self::card::{card_for, statement_card, CardDraft, CardFix, CardPatch, StatementCard};
pub use self::merge::{merge_csv_rows, CsvMerge};
pub use self::palette::PALETTE;
pub use self::csv::{parse_transactions_csv, transactions_to_csv, CsvParse, CsvRow, CsvSkip};
pub use self::columns::{default_sign_mode, find_header_row, guess_columns, ColumnMap};
pub use self::parse::{detect_delimiter, parse_amount, parse_csv, parse_date, parse_decimal};
pub use self::rows::{build_import_rows, rows_for, ImportRow, ImportRows, RowsInput, RowsRequest, MAX_ROWS};
pub use self::summary::{statement_summary, StatementSummary};
pub use self::table::statement_table;
pub use self::totals::{statement_totals, StatementTotals, TotalsDraft, TotalsRow};

/// JS düzenli ifadelerindeki `\s` (Rust `regex`'in Unicode `\s`'iyle aynı değil)
pub(crate) const WS: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

/// JS düzenli ifadesini Rust'a çevirir: `\s` → JS boşluk kümesi, `\S` → tümleyeni, `\d` → ASCII rakam
pub(crate) fn js_re(src: &str) -> fancy_regex::Regex {
    let s = src.replace(r"\s", &format!("[{WS}]")).replace(r"\S", &format!("[^{WS}]")).replace(r"\d", "[0-9]");
    fancy_regex::Regex::new(&s).expect("düzenli ifade")
}

/// JS `String.prototype.trim`
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(crate::overview::breakdown::js_space)
}

/// Okunan ekstre: tablo, başlık satırı, tahmin edilen sütunlar ve (varsa) özet
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementRead {
    pub table: Vec<Vec<String>>,
    pub header_row: usize,
    pub columns: ColumnMap,
    pub summary: Option<StatementSummary>,
}

/// Dosya içeriğini çözümler (TS `StatementImportDialog.pickFile`)
pub fn read_statement(file: &StatementFile) -> CoreResult<StatementRead> {
    let table = statement_table(file);
    if table.len() < 2 {
        return Err(match file {
            StatementFile::Pdf { .. } => "PDF'te tarih ve tutar içeren işlem satırı bulunamadı. Bankadan Excel veya CSV indirmeyi deneyin.",
            _ => "Dosyada okunabilir satır bulunamadı.",
        }
        .into());
    }
    let header_row = find_header_row(&table);
    let columns = guess_columns(&table[header_row]);
    let text = match file {
        StatementFile::Table { rows } => rows.iter().map(|r| r.join(" ")).collect::<Vec<_>>().join("\n"),
        StatementFile::Text { text } | StatementFile::Pdf { text } => text.clone(),
    };
    let s = statement_summary(&text);
    Ok(StatementRead { table, header_row, columns, summary: (!s.is_empty()).then_some(s) })
}
