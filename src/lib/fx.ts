/** Döviz ve altın: para birimi listesi (Rust'taki `fx::INSTRUMENTS` ile aynı sırada), miktar ve kur hesapları. */

export const TRY = "TRY";
export type FxUnit = "currency" | "gram" | "piece" | "share";
export type FxGroup = "doviz" | "altin" | "maden";

export interface Instrument {
  code: string;
  name: string;
  unit: FxUnit;
  group: FxGroup;
}

export const GROUP_LABEL: Record<FxGroup, string> = { doviz: "Döviz", altin: "Altın", maden: "Diğer madenler" };

const c = (code: string, name: string): Instrument => ({ code, name, unit: "currency", group: "doviz" });
const g = (code: string, name: string, group: FxGroup = "altin"): Instrument => ({ code, name, unit: "gram", group });
const p = (code: string, name: string): Instrument => ({ code, name, unit: "piece", group: "altin" });

export const INSTRUMENTS: Instrument[] = [
  c("USD", "ABD doları"), c("EUR", "Euro"), c("GBP", "İngiliz sterlini"), c("CHF", "İsviçre frangı"), c("JPY", "Japon yeni"),
  c("CAD", "Kanada doları"), c("AUD", "Avustralya doları"), c("DKK", "Danimarka kronu"), c("SEK", "İsveç kronu"),
  c("NOK", "Norveç kronu"), c("SAR", "Suudi Arabistan riyali"), c("KWD", "Kuveyt dinarı"), c("QAR", "Katar riyali"),
  c("AED", "BAE dirhemi"), c("RON", "Rumen leyi"), c("RUB", "Rus rublesi"), c("CNY", "Çin yuanı"), c("PKR", "Pakistan rupisi"),
  c("KRW", "Güney Kore wonu"), c("AZN", "Azerbaycan manatı"), c("KZT", "Kazakistan tengesi"),
  g("ALTIN", "Gram altın (has)"), g("KULCEALTIN", "Külçe altın"), g("AYAR22", "22 ayar altın"), g("AYAR14", "14 ayar altın"),
  p("CEYREK_YENI", "Çeyrek altın (yeni)"), p("CEYREK_ESKI", "Çeyrek altın (eski)"), p("YARIM_YENI", "Yarım altın (yeni)"),
  p("YARIM_ESKI", "Yarım altın (eski)"), p("TEK_YENI", "Tam altın (yeni)"), p("TEK_ESKI", "Tam altın (eski)"),
  p("ATA_YENI", "Ata lira (yeni)"), p("ATA_ESKI", "Ata lira (eski)"), p("ATA5_YENI", "Ata beşli (yeni)"),
  p("ATA5_ESKI", "Ata beşli (eski)"), p("GREMESE_YENI", "Gremse (yeni)"), p("GREMESE_ESKI", "Gremse (eski)"),
  g("GUMUSTRY", "Gümüş", "maden"),
];

export const instrumentByCode = new Map(INSTRUMENTS.map((i) => [i.code, i]));
/** Yatırım fonu birimi öneki (Rust `fx::FUND_PREFIX`) */
export const FUND_PREFIX = "FON:";
const FUND_RE = /^FON:[A-Z0-9]{3}$/;
export const isFund = (code: string | null | undefined): boolean => !!code && FUND_RE.test(code);
export const fundCode = (code: string): string | null => (isFund(code) ? code.slice(FUND_PREFIX.length) : null);
export const fundUnit = (code: string): string => `${FUND_PREFIX}${code}`;

export const unitOf = (code: string): FxUnit => (isFund(code) ? "share" : (instrumentByCode.get(code)?.unit ?? "currency"));
export const isForeign = (code: string | null | undefined): boolean => !!code && code !== TRY;
export const qtyDecimals = (code: string): number => ({ currency: 2, gram: 3, piece: 0, share: 0 })[unitOf(code)];
/** Miktar alanı hata mesajı için: birimin kabul ettiği hane */
export const qtyRule = (code: string): string => ({ currency: "en çok 2 ondalık", gram: "en çok 3 ondalık", piece: "tam sayı", share: "tam sayı" })[unitOf(code)];
/** Miktar alanının birim etiketi */
export const unitLabel = (code: string): string => ({ currency: code, gram: "gram", piece: "adet", share: "pay" })[unitOf(code)];
export const currencyLabel = (code: string): string =>
  code === TRY ? "Türk lirası" : isFund(code) ? `${fundCode(code)} fonu` : (instrumentByCode.get(code)?.name ?? code);


const fmt = (d: number) => new Intl.NumberFormat("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });

export function formatQty(value: number, code: string): string {
  const u = unitOf(code);
  if (u === "share") return `${fmt(0).format(value)} pay`;
  if (u === "piece") return `${fmt(0).format(value)} adet`;
  if (u === "gram") return `${fmt(3).format(value)} g`;
  return `${fmt(2).format(value)} ${code}`;
}

const rateFmt = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
export const formatRate = (rate: number): string => rateFmt.format(rate);
