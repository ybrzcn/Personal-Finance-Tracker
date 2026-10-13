//! Banka ekstresi dosyaları (CSV / TXT / Excel / PDF): dosya içeriğinden tablo veya metin çıkarır.

use std::io::Cursor;
use std::path::Path;

use crate::CoreResult;

/// Ekstre içeriği: metin (CSV/TXT), tablo (Excel) veya PDF'ten çıkarılmış düz metin.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StatementFile {
    Text { text: String },
    Table { rows: Vec<Vec<String>> },
    Pdf { text: String },
}

fn excel_cell(cell: &calamine::Data) -> String {
    use calamine::{Data, DataType};
    match cell {
        Data::Empty => String::new(),
        Data::String(s) | Data::DateTimeIso(s) | Data::DurationIso(s) => s.trim().to_string(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                format!("{}", (f * 100.0).round() / 100.0)
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(_) => cell
            .as_date()
            .map(|d| d.to_string()) // NaiveDate gösterimi YYYY-MM-DD
            .unwrap_or_default(),
        Data::Error(_) => String::new(),
    }
}

fn read_excel(bytes: &[u8], ext: &str) -> CoreResult<Vec<Vec<String>>> {
    // calamine bozuk dosyalarda panikleyebilir; uygulamayı düşürmemesi için yakalanır
    std::panic::catch_unwind(|| read_excel_inner(bytes, ext))
        .unwrap_or_else(|_| Err("Excel dosyası okunamadı: desteklenmeyen veya bozuk dosya.".into()))
}

/// Önce uzantıya uygun okuyucu (anlamlı hata mesajı için), olmazsa biçim tahmini (ör. ".xls" adlı XLSX).
/// Dosya kopyalanmadan bayt diliminden okunur.
fn open_workbook<'a>(bytes: &'a [u8], ext: &str) -> CoreResult<calamine::Sheets<Cursor<&'a [u8]>>> {
    use calamine::{open_workbook_auto_from_rs, open_workbook_from_rs, Ods, Sheets, Xls, Xlsb, Xlsx};
    let specific = match ext {
        "xlsx" | "xlsm" => open_workbook_from_rs::<Xlsx<_>, _>(Cursor::new(bytes)).map(Sheets::Xlsx).map_err(|e| e.to_string()),
        "xls" => open_workbook_from_rs::<Xls<_>, _>(Cursor::new(bytes)).map(Sheets::Xls).map_err(|e| e.to_string()),
        "xlsb" => open_workbook_from_rs::<Xlsb<_>, _>(Cursor::new(bytes)).map(Sheets::Xlsb).map_err(|e| e.to_string()),
        "ods" => open_workbook_from_rs::<Ods<_>, _>(Cursor::new(bytes)).map(Sheets::Ods).map_err(|e| e.to_string()),
        _ => Err("desteklenmeyen biçim".to_string()),
    };
    specific.or_else(|first| {
        open_workbook_auto_from_rs(Cursor::new(bytes)).map_err(|_| format!("Excel dosyası açılamadı: {first}"))
    })
}

fn read_excel_inner(bytes: &[u8], ext: &str) -> CoreResult<Vec<Vec<String>>> {
    use calamine::Reader;
    let mut wb = open_workbook(bytes, ext)?;
    // En çok dolu satırı olan sayfa ekstredir
    let best = wb
        .worksheets()
        .into_iter()
        .map(|(_, range)| {
            range
                .rows()
                .map(|r| r.iter().map(excel_cell).collect::<Vec<_>>())
                .filter(|r| r.iter().any(|c| !c.is_empty()))
                .collect::<Vec<_>>()
        })
        .max_by_key(|rows| rows.len())
        .unwrap_or_default();
    if best.is_empty() {
        return Err("Excel dosyasında veri bulunamadı.".into());
    }
    Ok(best)
}

fn read_pdf(bytes: &[u8]) -> CoreResult<String> {
    // pdf-extract bazı bozuk/alışılmadık PDF'lerde panikleyebilir; uygulamayı düşürmemesi için yakalanır.
    let result = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(bytes));
    match result {
        Ok(Ok(text)) if !text.trim().is_empty() => Ok(text),
        Ok(Ok(_)) => Err("PDF'te metin bulunamadı (taranmış/görüntü PDF olabilir). Bankadan Excel veya CSV indirmeyi deneyin.".into()),
        Ok(Err(e)) => Err(format!(
            "PDF okunamadı ({e}). Dosya şifreli olabilir; şifresiz kaydedip tekrar deneyin."
        )),
        Err(_) => Err("PDF okunamadı: desteklenmeyen PDF biçimi. Bankadan Excel veya CSV indirmeyi deneyin.".into()),
    }
}

/// Ekstre dosyasını adından (uzantı) ve içeriğinden okur.
pub fn parse(file_name: &str, bytes: &[u8]) -> CoreResult<StatementFile> {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "csv" | "txt" => {
            // Bazı bankalar Windows-1254 (Türkçe) kodlamasıyla verir
            let text = match std::str::from_utf8(bytes) {
                Ok(s) => s.to_string(),
                Err(_) => bytes.iter().map(|&b| cp1254(b)).collect(),
            };
            Ok(StatementFile::Text { text })
        }
        "xlsx" | "xlsm" | "xls" | "xlsb" | "ods" => Ok(StatementFile::Table { rows: read_excel(bytes, &ext)? }),
        "pdf" => Ok(StatementFile::Pdf { text: read_pdf(bytes)? }),
        _ => Err("Desteklenen biçimler: CSV, TXT, Excel (XLSX/XLS), PDF.".into()),
    }
}

/// Windows-1254 (Türkçe) tek baytlık karakter → Unicode.
fn cp1254(b: u8) -> char {
    match b {
        0xD0 => 'Ğ',
        0xDD => 'İ',
        0xDE => 'Ş',
        0xF0 => 'ğ',
        0xFD => 'ı',
        0xFE => 'ş',
        0x80 => '€',
        _ => b as char, // Kalanlar Latin-1 ile aynı (Ç, Ö, Ü, ç, ö, ü dahil)
    }
}

