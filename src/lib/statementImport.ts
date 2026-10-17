import { clampedDate, toCents } from "./cards";
import { detectDelimiter, norm, parseCsv, parseDate } from "./csv";
import type { StatementFile } from "./fileio";
import { parseAmount } from "./format";
import type { Account, Category, CategoryRule, CategoryType, Transaction } from "./types";

/** Banka ekstresi (CSV / TXT) satırları. İlk 30 satır içinde başlık aranır. */
export function readTable(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim());
  // Ayırıcıyı en çok sütun üreten satıra göre seç (başlıktan önce banka bilgisi satırları olabilir)
  const sample = lines.slice(0, 30).sort((a, b) => b.length - a.length)[0] ?? "";
  return parseCsv(clean, detectDelimiter(sample)).map((r) => r.map((c) => c.trim()));
}

/** Tutar biçimleri: 1.250,75 · 1250,75 · 1,250.75 · sonda/başta işaret. */
// Boşlukla ayrılmış tutar: 1.250,75 · 1250,75 · 1,250.75 · sonda/başta işaret, isteğe bağlı TL.
// (Eski WebKit sürümleri lookbehind desteklemediği için önceki karakter grupla yakalanır.)
const AMOUNT_RE = /(?:^|\s)([-+]?(?:\d{1,3}(?:[.,]\d{3})+|\d+)[.,]\d{2})(?!\d)(?:\s?(?:TL|TRY))?(\s?[-+](?=\s|$))?/g;
// Satır başındaki tarih; bazı bankalarda tarih ile açıklama arasında boşluk olmaz ("03 Eylül 2026MARKET ALIŞVERİŞİ")
const DATE_START_RE =
  /^(\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-zÇĞİÖŞÜçğıöşü]+\.?\s+\d{4})\s*(.*)$/;
// Sabit genişlikli işyeri alanında şehir adı işyeri adına yapışık gelebilir ("ÖRNEKCADDESİİSTANBUL")
const GLUED_CITY_RE = /^(.*\S)(İSTANBUL|ISTANBUL|ANKARA|İZMİR|IZMIR|BURSA|ANTALYA|KOCAELİ|KOCAELI)$/;

/** Sonda işaret ("1.250,75-") ve TL ekini normalize eder: "-1.250,75". Baştaki "+" korunur (alacak işareti). */
function normalizeAmountToken(token: string): string {
  let t = token.replace(/\s?(TL|TRY)/, "").trim();
  if (/[-+]$/.test(t)) t = t.slice(-1) + t.slice(0, -1).trim();
  return t;
}

/** İşyeri adı: çoklu boşlukla ayrılan ilk alan (şehir/ülke sütunları atılır). */
function merchantName(raw: string): string {
  const first = raw.split(/\s{2,}/)[0].trim();
  const glued = GLUED_CITY_RE.exec(first);
  return (glued ? glued[1] : first).replace(/\s+/g, " ").trim() || raw.replace(/\s+/g, " ").trim();
}

// İşlemin altındaki taksit açıklaması: "10.693,00 TL'lik işlemin 6 / 6 taksidi" (iadede "iadenin")
const INSTALLMENT_LINE_RE = /(\d{1,2})\s*\/\s*(\d{1,2})\s*taksid/i;

/**
 * PDF ekstre metninden tablo üretir: tarihle başlayan her satır bir işlemdir. Satırda birden çok
 * tutar varsa sondaki bakiye kabul edilir ve sondan ikincisi işlem tutarıdır. Hemen altındaki
 * "… k / n taksidi" satırı işlemin taksit sütununa ("k/n") yazılır.
 */
export function pdfTextToTable(text: string): string[][] {
  const rows: string[][] = [["Tarih", "Açıklama", "Tutar", "Taksit"]];
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/\t/g, " ").trim();
    const m = DATE_START_RE.exec(line);
    if (!m || !parseDate(m[1])) continue;
    let rest = m[2];
    // Satırın başındaki ikinci tarih (valör) açıklamaya karışmasın
    const second = DATE_START_RE.exec(rest);
    if (second && parseDate(second[1])) rest = second[2];
    const amounts = [...rest.matchAll(AMOUNT_RE)];
    if (!amounts.length) continue;
    const pick = amounts.length >= 2 ? amounts[amounts.length - 2] : amounts[0];
    const description = merchantName(rest.slice(0, amounts[0].index));
    const next = (lines[i + 1] ?? "").trim();
    const inst = DATE_START_RE.test(next) ? null : INSTALLMENT_LINE_RE.exec(next);
    rows.push([
      m[1].replace(/\s+/g, " "),
      description,
      normalizeAmountToken(pick[1] + (pick[2]?.trim() ?? "")),
      inst ? `${inst[1]}/${inst[2]}` : "",
    ]);
  }
  return rows;
}

export interface StatementSummary {
  closingDate: string | null;
  dueDate: string | null;
  /** Dönem borcu (ödenmesi gereken toplam) */
  periodDebt: number | null;
  /** Dönem içi harcamalar */
  periodSpending: number | null;
  minPaymentRate: number | null;
  creditLimit: number | null;
  interestRate: number | null;
}

/** Ekstrenin özet bölümünden kesim / son ödeme tarihi, dönem borcu, limit ve faiz oranını okur. */
export function extractStatementSummary(text: string): StatementSummary {
  const t = norm(text).replace(/[ \t]+/g, " ");
  const DATE = "(\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|\\d{1,2} [a-z]+ \\d{4})";
  const AMT = "([\\d.]+,\\d{2})";
  const find = (labels: string[], value: string) => {
    for (const l of labels) {
      const m = new RegExp(`${l}\\s*:?\\s*${value}`).exec(t);
      if (m) return m[1];
    }
    return null;
  };
  const date = (labels: string[]) => {
    const v = find(labels, DATE);
    return v ? parseDate(v) : null;
  };
  const amount = (labels: string[]) => {
    const v = find(labels, AMT);
    return v ? parseAmount(v) : null;
  };
  const pct = (labels: string[]) => {
    const v = find(labels, "%?\\s*(\\d+(?:,\\d+)?)");
    return v ? Number(v.replace(",", ".")) : null;
  };
  const minRate = /asgari[^\n]*?\/\s*%?\s*(\d{1,2})\s*%?/.exec(t);
  return {
    closingDate: date(["hesap kesim tarihi", "ekstre kesim tarihi", "kesim tarihi"]),
    dueDate: date(["son odeme tarihi"]),
    periodDebt: amount(["donem borcu", "ekstre borcu", "toplam borc"]),
    periodSpending: amount(["donem ici harcamalar", "donem ici harcama"]),
    minPaymentRate: minRate ? Number(minRate[1]) : null,
    creditLimit: amount(["kart limiti", "kredi karti limiti"]),
    interestRate: pct(["akdi faiz orani", "alisveris faiz orani"]),
  };
}

/** Dosya içeriğini satır/sütun tablosuna çevirir. */
export function statementToTable(file: StatementFile): string[][] {
  if (file.kind === "table") return file.rows.map((r) => r.map((c) => c.trim()));
  if (file.kind === "pdf") return pdfTextToTable(file.text);
  return readTable(file.text);
}

export interface ColumnMap {
  date: number;
  description: number;
  /** Tek, işaretli tutar sütunu */
  amount: number;
  /** Ayrı borç/çıkan sütunu */
  debit: number;
  /** Ayrı alacak/giren sütunu */
  credit: number;
  installments: number;
}

const ALIASES: Record<keyof ColumnMap, string[]> = {
  date: ["tarih", "islem tarihi", "date", "valor", "islem tarih"],
  description: ["aciklama", "islem aciklamasi", "islem", "description", "detay", "isyeri", "uye isyeri", "merchant"],
  amount: ["tutar", "islem tutari", "tutar (tl)", "tutar tl", "amount", "miktar"],
  debit: ["borc", "harcama", "cikan", "cekilen", "borc tutari"],
  credit: ["alacak", "yatan", "giren", "alacak tutari"],
  installments: ["taksit", "taksit sayisi", "installments"],
};

const matches = (cell: string, aliases: string[]) => {
  const c = norm(cell);
  return aliases.some((a) => c === a || c.startsWith(a + " ") || c.startsWith(a + "("));
};

export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i];
    const hasDate = r.some((c) => matches(c, ALIASES.date));
    const hasMoney = r.some((c) => matches(c, ALIASES.amount) || matches(c, ALIASES.debit) || matches(c, ALIASES.credit));
    if (hasDate && hasMoney) return i;
  }
  return 0;
}

/** Her sütun en fazla bir alana atanır; önce tam eşleşme, sonra önek eşleşmesi aranır. */
export function guessColumns(header: string[]): ColumnMap {
  const used = new Set<number>();
  const find = (key: keyof ColumnMap) => {
    const free = (i: number) => !used.has(i);
    let idx = header.findIndex((h, i) => free(i) && ALIASES[key].includes(norm(h)));
    if (idx < 0) idx = header.findIndex((h, i) => free(i) && matches(h, ALIASES[key]));
    if (idx >= 0) used.add(idx);
    return idx;
  };
  const date = find("date");
  const amount = find("amount");
  const debit = find("debit");
  const credit = find("credit");
  const installments = find("installments");
  const description = find("description");
  return { date, description, amount: debit >= 0 && credit >= 0 ? -1 : amount, debit, credit, installments };
}

/** Tek tutar sütununda harcamanın işareti. Kart ekstrelerinde harcama genelde artı, banka hareketlerinde eksidir. */
export type SignMode = "negativeIsExpense" | "positiveIsExpense";

export const defaultSignMode = (account: Account): SignMode =>
  account.kind === "credit_card" || account.kind === "loan" ? "positiveIsExpense" : "negativeIsExpense";

export interface ImportRow {
  line: number;
  date: string;
  description: string;
  amount: number;
  /** "transfer" seçilirse `toAccountId` hedef hesaptır */
  type: "income" | "expense" | "transfer";
  toAccountId: string | null;
  categoryId: string | null;
  installments: number;
  include: boolean;
  /** Kullanıcıya gösterilecek not (mükerrer, kart ödemesi vb.) */
  note: string;
}

// ---------------------------------------------------------------------------
// Kategori tahmini
// ---------------------------------------------------------------------------

/** Varsayılan kategori adlarına anahtar kelime kuralları (normalize edilmiş, tam kelime eşleşmesi). */
const RULES: { category: string; type: CategoryType; words: string[] }[] = [
  // İnternet abonelikleri önce denenir (ör. "APPLE.COM/BILL", "GOOGLE *GOOGLE ONE")
  {
    category: "Abonelikler",
    type: "expense",
    words: [
      "figma", "anthropic", "claude", "openai", "chatgpt", "midjourney", "cursor", "github", "gitlab", "notion", "slack", "zoom",
      "dropbox", "canva", "adobe", "microsoft", "office 365", "msft", "google one", "google storage", "google workspace",
      "gsuite", "youtube premium", "youtube", "icloud", "apple com", "apple com bill", "itunes", "netflix", "spotify",
      "disney", "blutv", "exxen", "gain", "tod tv", "mubi", "amazon prime", "prime video", "audible", "linkedin", "medium",
      "patreon", "duolingo", "nordvpn", "expressvpn", "1password", "lastpass", "jetbrains", "vercel", "heroku", "digitalocean",
      "aws", "cloudflare", "godaddy", "namecheap", "squarespace", "wix", "shopify", "substack",
    ],
  },
  { category: "Market", type: "expense", words: ["migros", "a101", "bim", "sok", "carrefour", "carrefoursa", "macrocenter", "hakmar", "file market", "metro", "onur market", "bizim toptan", "market", "getir buyuk"] },
  // Kafe, Restoran'dan önce denenir; Kafe kategorisi yoksa aynı kelimeler Restoran'a düşer
  { category: "Kafe", type: "expense", words: ["starbucks", "cafe", "kafe", "kahve", "coffee", "caffe", "espresso", "kahvecisi", "kahve dunyasi", "gloria jeans", "caribou", "tchibo", "nero", "costa", "walkers", "petra", "brew", "barista"] },
  { category: "Restoran", type: "expense", words: ["yemeksepeti", "getir yemek", "trendyol yemek", "starbucks", "burger", "kfc", "mcdonalds", "dominos", "pizza", "cafe", "kafe", "kahve", "restoran", "restaurant", "lokanta", "kebap", "doner", "mc donalds", "mcdonald s", "burger king", "unlu mamul", "unlu mamuller", "firin", "pastane", "simit"] },
  { category: "Ulaşım", type: "expense", words: ["shell", "opet", "bp", "petrol ofisi", "po", "total", "aytemiz", "akaryakit", "uber", "bitaksi", "marti", "istanbulkart", "otopark", "hgs", "ogs", "thy", "pegasus", "ajet", "metro istanbul", "taksi"] },
  { category: "Faturalar", type: "expense", words: ["turkcell", "vodafone", "turk telekom", "superonline", "enerjisa", "ck enerji", "igdas", "iski", "aski", "izsu", "dogalgaz", "elektrik", "fatura", "turknet"] },
  { category: "Eğlence", type: "expense", words: ["steam", "playstation", "xbox", "sinema", "cinemaximum", "biletix", "passo", "airbnb", "booking com", "otel", "hotel"] },
  { category: "Sağlık", type: "expense", words: ["eczane", "eczanesi", "hastane", "hastanesi", "klinik", "saglik", "doktor", "dis"] },
  { category: "Giyim", type: "expense", words: ["zara", "lcw", "lc waikiki", "koton", "defacto", "mavi", "boyner", "h m", "pull bear", "bershka", "decathlon"] },
  { category: "Kira", type: "expense", words: ["kira"] },
  { category: "Faiz ve Masraflar", type: "expense", words: ["faiz", "kkdf", "bsmv", "masraf", "komisyon", "kart aidati", "aidat", "ucret", "gecikme"] },
  { category: "Nakit Avans", type: "expense", words: ["nakit avans", "nakit cekim", "atm nakit", "taksitli nakit"] },
  { category: "Maaş", type: "income", words: ["maas", "maas odemesi", "personel odeme"] },
];

const words = (s: string) => ` ${norm(s).replace(/[^a-z0-9]+/g, " ").trim()} `;

/** Geçmiş işlemlerde açıklamanın ilk iki kelimesine göre en sık kullanılan kategori. */
export function buildHistory(txs: Transaction[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const t of txs) {
    if (!t.categoryId || !t.description || t.type === "transfer") continue;
    const key = `${t.type}:${historyKey(t.description)}`;
    const m = counts.get(key) ?? new Map<string, number>();
    m.set(t.categoryId, (m.get(t.categoryId) ?? 0) + 1);
    counts.set(key, m);
  }
  const out = new Map<string, string>();
  for (const [key, m] of counts) out.set(key, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return out;
}

const historyKey = (description: string) =>
  norm(description)
    .replace(/[^a-z\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 2)
    .join(" ");

/** Kural kelimesinin karşılaştırmada kullanılan biçimi ("MARKET-Örnek Şube" → "market ornek sube"). */
export const normalizeRuleWord = (word: string) => words(word).trim();

/**
 * Kullanıcı kuralının kelimelerinden açıklamada geçen en uzununun uzunluğu; yoksa 0.
 * Son kelimesi 4 harf ve üstüyse kelime başından eşleşir, Türkçe ekler de tutar ("kira" → "Ev kirası");
 * daha kısaysa tam kelime aranır ("bim" "BİMEKS"i tutmaz).
 */
function longestMatch(w: string, ruleWords: string[]): number {
  let best = 0;
  for (const k of ruleWords) {
    const n = normalizeRuleWord(k);
    if (!n || n.length <= best) continue;
    const prefix = n.slice(n.lastIndexOf(" ") + 1).length >= 4;
    if (w.includes(prefix ? ` ${n}` : ` ${n} `)) best = n.length;
  }
  return best;
}

/**
 * Kullanıcı kurallarından uyan kategori. Birden çok kural uyarsa en uzun kelimesi eşleşen kazanır
 * ("getir yemek" → Restoran, "getir" → Market'i yener); eşitlikte listede önce gelen. Kategorisi silinmiş kural atlanır.
 */
export function matchUserRule(description: string, type: CategoryType, rules: CategoryRule[], categories: Category[]): string | null {
  const w = words(description);
  let best: string | null = null;
  let bestLen = 0;
  for (const r of rules) {
    if (r.type !== type || !categories.some((c) => c.id === r.categoryId && c.type === type)) continue;
    const len = longestMatch(w, r.words);
    if (len > bestLen) {
      best = r.categoryId;
      bestLen = len;
    }
  }
  return best;
}

/** Kural formundaki önizleme: verilen kelimelerden birini içeren, o türdeki işlemler (yeniden eskiye). */
export function transactionsMatching(ruleWords: string[], type: CategoryType, txs: Transaction[]): Transaction[] {
  if (!ruleWords.some((k) => normalizeRuleWord(k))) return [];
  return txs
    .filter((t) => t.type === type && t.description && longestMatch(words(t.description), ruleWords) > 0)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Kategori önerisi: önce kullanıcı kuralları, sonra geçmiş işlemler, en son hazır anahtar kelime listesi. */
export function suggestCategory(
  description: string,
  type: CategoryType,
  history: Map<string, string>,
  categories: Category[],
  rules: CategoryRule[] = [],
): string | null {
  const fromRule = matchUserRule(description, type, rules, categories);
  if (fromRule) return fromRule;
  const fromHistory = history.get(`${type}:${historyKey(description)}`);
  if (fromHistory && categories.some((c) => c.id === fromHistory)) return fromHistory;
  const w = words(description);
  for (const rule of RULES) {
    if (rule.type !== type) continue;
    if (!rule.words.some((k) => w.includes(` ${k} `))) continue;
    const cat = categories.find((c) => c.type === type && norm(c.name) === norm(rule.category));
    if (cat) return cat.id;
  }
  return null;
}

/** Açıklama, adı verilen kategorinin anahtar kelime kuralına uyuyor mu (ör. "STARBUCKS ..." → Kafe). */
export function matchesCategoryRule(description: string, categoryName: string): boolean {
  const w = words(description);
  return RULES.some((r) => norm(r.category) === norm(categoryName) && r.words.some((k) => w.includes(` ${k} `)));
}

/** Kategorisiz gelir/gider işlemleri için öneriler: işlem id → kategori id. */
export function suggestForUncategorized(txs: Transaction[], categories: Category[], rules: CategoryRule[] = []): Map<string, string> {
  const history = buildHistory(txs);
  const out = new Map<string, string>();
  for (const t of txs) {
    if (t.categoryId || t.type === "transfer" || !t.description) continue;
    const c = suggestCategory(t.description, t.type, history, categories, rules);
    if (c) out.set(t.id, c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Satırları işlemlere çevirme
// ---------------------------------------------------------------------------

const looksLikeCardPayment = (description: string) => {
  const w = words(description);
  return w.includes(" odeme ") || w.includes(" odemesi ") || w.includes(" kart odeme ") || w.includes(" hesaptan odeme ");
};

export function buildImportRows(
  table: string[][],
  headerRow: number,
  map: ColumnMap,
  sign: SignMode,
  account: Account,
  accounts: Account[],
  existing: Transaction[],
  categories: Category[],
  rules: CategoryRule[] = [],
  /** Ekstrenin kesim tarihi (özetten); yoksa en son işlem tarihi kullanılır */
  closingDate: string | null = null,
): { rows: ImportRow[]; skipped: number } {
  const history = buildHistory(existing);
  const own = existing.filter((t) => t.accountId === account.id);
  // Devam eden taksit payı dönemden önce tarihliyse dönem sonuna (kesim tarihine) alınır; yoksa
  // ilk alışverişin tarihiyle eski bir ekstreye düşer ve bu dönemin borcunda görünmez
  const refDate =
    closingDate ??
    table
      .slice(headerRow + 1)
      .map((r) => parseDate((r[map.date] ?? "").trim()))
      .reduce<string | null>((max, d) => (d && (!max || d > max) ? d : max), null);
  const periodStart = refDate
    ? clampedDate(Number(refDate.slice(0, 4)), Number(refDate.slice(5, 7)) - 2, Number(refDate.slice(8, 10)))
    : null;
  const trDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  const seen = new Set(
    existing.filter((t) => t.accountId === account.id).map((t) => `${t.date}|${toCents(t.amount)}|${t.type}`),
  );
  const cards = accounts.filter((a) => a.kind === "credit_card" && !a.archived && a.id !== account.id);
  const rows: ImportRow[] = [];
  let skipped = 0;

  table.slice(headerRow + 1).forEach((r, i) => {
    const cell = (idx: number) => (idx >= 0 ? (r[idx] ?? "").trim() : "");
    let date = parseDate(cell(map.date));
    const money = (s: string) => parseAmount(s.replace(/^\+/, "").replace(/\s*(TL|TRY)$/i, ""));
    let signed: number | null = null;
    if (map.amount >= 0) {
      const raw = cell(map.amount);
      const v = money(raw);
      // Açık "+" işareti her iki düzende de alacak (ödeme/iade/gelir) anlamına gelir
      if (v !== null) signed = /^\+/.test(raw) ? Math.abs(v) : sign === "negativeIsExpense" ? v : -v;
    } else {
      const debit = map.debit >= 0 ? money(cell(map.debit)) : null;
      const credit = map.credit >= 0 ? money(cell(map.credit)) : null;
      if (debit) signed = -Math.abs(debit);
      else if (credit) signed = Math.abs(credit);
    }
    if (!date || signed === null || signed === 0) {
      skipped++;
      return;
    }
    let description = cell(map.description);
    const amount = Math.abs(signed);
    let type: ImportRow["type"] = signed < 0 ? "expense" : "income";
    let toAccountId: string | null = null;
    let include = true;
    let note = "";

    // "2/6" gibi değer süren bir taksitin bu ayki payıdır: yeni taksitli alışveriş değil, tek tutar olarak eklenir
    const instCell = cell(map.installments).trim();
    const ongoing = /^\d+\s*\/\s*\d+$/.test(instCell);
    let originalDate: string | null = null;
    if (ongoing && account.kind === "credit_card") {
      description = `${description} (taksit ${instCell.replace(/\s+/g, "")})`;
      if (refDate && periodStart && date <= periodStart) {
        originalDate = date;
        date = refDate;
        note = `İlk işlem ${trDate(originalDate)}`;
      }
    }
    const parsedInst = ongoing ? 1 : Number.parseInt(instCell, 10);
    const installments =
      type === "expense" && account.kind === "credit_card" && Number.isInteger(parsedInst) && parsedInst > 1 && parsedInst <= 36
        ? parsedInst
        : 1;

    if (account.kind === "credit_card" && type === "income" && looksLikeCardPayment(description)) {
      include = false;
      note = "Kart ödemesi: vadesiz hesap tarafında transfer olarak girin";
    } else if (account.kind !== "credit_card" && type === "expense" && looksLikeCardPayment(description) && cards.length) {
      type = "transfer";
      toAccountId = cards[0].id;
      note = "Kart ödemesi olarak algılandı";
    }
    if (seen.has(`${date}|${toCents(amount)}|${type}`)) {
      include = false;
      note = "Aynı tarih ve tutarda kayıt zaten var";
    } else if (originalDate && own.some((t) => t.date === originalDate && toCents(t.amount) === toCents(amount) && t.type === type)) {
      note = `${note}. Aynı tutarda ${trDate(originalDate)} tarihli kayıt var; o kaydı silin`;
    }

    rows.push({
      line: headerRow + i + 2,
      date,
      description,
      amount,
      type,
      toAccountId,
      categoryId: type === "transfer" ? null : suggestCategory(description, type, history, categories, rules),
      installments,
      include,
      note,
    });
  });
  return { rows, skipped };
}
