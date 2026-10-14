import { qtyDecimals } from "./fx";
import { parseAmount, toISODate, parseDecimal } from "./format";
import type { Account, Category, Transaction, TxType } from "./types";
import { TYPE_LABEL } from "./types";

// Türkçe Excel ondalık ayırıcı olarak virgül kullandığı için alan ayırıcı ";"
const DELIMITER = ";";

/** Excel'de formül olarak çalışmasın: = + - @ ile başlayan metin hücrelerine ' öneki (CSV/formül enjeksiyonu). */
const guardFormula = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/** İçe aktarırken kendi eklediğimiz koruma önekini geri alır. */
export const unguardFormula = (v: string) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);

function escapeCell(v: string): string {
  return /[";\n\r,]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function transactionsToCsv(
  txs: Transaction[],
  categoryById: Map<string, Category>,
  accountById: Map<string, Account>,
): string {
  const header = ["Tarih", "Tür", "Hesap", "Hedef Hesap", "Kategori", "Tutar", "Para birimi", "Orijinal tutar", "Kur", "Taksit", "Açıklama"];
  const name = (id: string | null) => (id && accountById.get(id)?.name) || "";
  const lines = [header.join(DELIMITER)];
  for (const t of txs) {
    lines.push(
      [
        t.date,
        TYPE_LABEL[t.type],
        guardFormula(name(t.accountId)),
        guardFormula(name(t.toAccountId)),
        guardFormula((t.categoryId && categoryById.get(t.categoryId)?.name) || ""),
        t.amount.toFixed(2).replace(".", ","),
        ...fxCells(t, accountById),
        String(t.installments),
        guardFormula(t.description),
      ]
        .map(escapeCell)
        .join(DELIMITER),
    );
  }
  // BOM: Excel'in UTF-8 (Türkçe karakterler) olarak açması için
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

/** Dövizli işlemin birimi, miktarı ve kuru: kaynak TL dışıysa kaynak, değilse hedef taraf; TL işlemde boş. */
function fxCells(t: Transaction, accountById: Map<string, Account>): string[] {
  const from = accountById.get(t.accountId)?.currency ?? "TRY";
  const to = (t.toAccountId && accountById.get(t.toAccountId)?.currency) || "TRY";
  const [cur, qty, rate] =
    t.origAmount != null ? [from, t.origAmount, t.fxRate] : t.toOrigAmount != null ? [to, t.toOrigAmount, t.toFxRate] : ["", null, null];
  const n = (v: number | null | undefined, d: number) => (v == null ? "" : v.toFixed(d).replace(".", ","));
  return [cur, n(qty, cur ? qtyDecimals(cur) : 2), n(rate, 6)];
}

/** RFC 4180 uyumlu küçük CSV ayrıştırıcı (tırnak, kaçış ve satır içi yeni satır destekli). */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function detectDelimiter(headerLine: string): string {
  const counts = [";", ",", "\t"].map((d) => [d, headerLine.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

export const norm = (s: string) =>
  s
    .trim()
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o");

const HEADER_ALIASES: Record<string, string[]> = {
  date: ["tarih", "date"],
  type: ["tur", "tip", "type"],
  account: ["hesap", "account"],
  toAccount: ["hedef hesap", "to account"],
  category: ["kategori", "category"],
  amount: ["tutar", "miktar", "amount"],
  installments: ["taksit", "installments"],
  // Döviz/altın hesabı işlemleri (dışa aktarmadaki sütunlar)
  fxCurrency: ["para birimi", "currency"],
  origAmount: ["orijinal tutar", "original amount"],
  fxRate: ["kur", "rate"],
  description: ["aciklama", "description", "not", "note"],
};

const TR_MONTHS = ["oca", "sub", "mar", "nis", "may", "haz", "tem", "agu", "eyl", "eki", "kas", "ara"];

/** YYYY-AA-GG, GG.AA.YYYY, GG/AA/YY (saat ekli olabilir) ve "05 Eki 2026" / "5 Ekim 2026" biçimleri. */
export function parseDate(s: string): string | null {
  const v = s.trim();
  const make = (y: number, m: number, d: number) => {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const date = new Date(y, m - 1, d);
    // 31.02 gibi geçersiz tarihler bir sonraki aya kaymasın
    if (date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    return toISODate(date);
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return make(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/.exec(v); // GG.AA.YYYY veya GG.AA.YY
  if (m) return make(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})\s+([a-zçğıöşü]+)\.?\s+(\d{4})/i.exec(v);
  if (m) {
    const month = TR_MONTHS.indexOf(norm(m[2]).slice(0, 3));
    if (month >= 0) return make(+m[3], month + 1, +m[1]);
  }
  return null;
}

function parseType(s: string): TxType | null {
  const v = norm(s);
  if (["gelir", "income", "+"].includes(v)) return "income";
  if (["gider", "expense", "harcama", "-"].includes(v)) return "expense";
  if (["transfer", "virman", "havale"].includes(v)) return "transfer";
  return null;
}

export interface ParsedCsvRow {
  date: string;
  type: TxType;
  categoryName: string;
  amount: number;
  description: string;
  accountName: string;
  toAccountName: string;
  installments: number;
  /** Döviz/altın tarafı: birim, kendi birimindeki miktar ve kur (yoksa boş/null) */
  fxCurrency: string;
  origAmount: number | null;
  fxRate: number | null;
}

export interface CsvParseResult {
  rows: ParsedCsvRow[];
  skipped: { line: number; reason: string }[];
  /** Dosyada "Hesap" sütunu var mı */
  hasAccountColumn: boolean;
}

export function parseTransactionsCsv(text: string): CsvParseResult {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const table = parseCsv(clean, detectDelimiter(firstLine));
  if (table.length < 2) throw "CSV dosyasında veri satırı bulunamadı.";

  const header = table[0].map(norm);
  const col: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    col[key] = header.findIndex((h) => aliases.includes(h));
  }
  if (col.date < 0 || col.amount < 0) {
    throw "CSV başlığında en az 'Tarih' ve 'Tutar' sütunları olmalıdır.";
  }

  const rows: ParsedCsvRow[] = [];
  const skipped: CsvParseResult["skipped"] = [];
  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    // Dışa aktarırken eklenen formül koruma öneki (') geri alınır
    const get = (k: string) => unguardFormula(col[k] >= 0 ? (r[col[k]] ?? "").trim() : "");
    const date = parseDate(get("date"));
    if (!date) return skipped.push({ line, reason: "Geçersiz tarih" });
    const rawAmount = parseAmount(get("amount"));
    if (rawAmount === null || rawAmount === 0) return skipped.push({ line, reason: "Geçersiz tutar" });
    // Tür sütunu yoksa negatif tutar = gider
    const type = parseType(get("type")) ?? (rawAmount < 0 ? "expense" : col.type >= 0 ? null : "income");
    if (!type) return skipped.push({ line, reason: "Geçersiz tür" });
    const installments = Number.parseInt(get("installments"), 10);
    rows.push({
      date,
      type,
      categoryName: get("category"),
      amount: Math.abs(rawAmount),
      description: get("description"),
      accountName: get("account"),
      toAccountName: get("toAccount"),
      installments: Number.isInteger(installments) && installments >= 1 && installments <= 36 ? installments : 1,
      fxCurrency: get("fxCurrency"),
      origAmount: get("origAmount") ? parseDecimal(get("origAmount"), 3) : null,
      fxRate: get("fxRate") ? parseDecimal(get("fxRate"), 6) : null,
    });
  });
  return { rows, skipped, hasAccountColumn: col.account >= 0 };
}
