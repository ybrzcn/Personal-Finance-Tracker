/** Döviz ve altın: para birimi listesi (Rust'taki `fx::INSTRUMENTS` ile aynı sırada), miktar ve kur hesapları. */
import { locale, t } from "./i18n";

export const TRY = "TRY";
export type FxUnit = "currency" | "gram" | "piece" | "share";
export type FxGroup = "doviz" | "altin" | "maden";

export interface Instrument {
  code: string;
  name: string;
  unit: FxUnit;
  group: FxGroup;
}

export const GROUP_LABEL: Record<FxGroup, string> = { doviz: t("Döviz"), altin: t("Altın"), maden: t("Diğer madenler") };

const c = (code: string, name: string): Instrument => ({ code, name, unit: "currency", group: "doviz" });
const g = (code: string, name: string, group: FxGroup = "altin"): Instrument => ({ code, name, unit: "gram", group });
const p = (code: string, name: string): Instrument => ({ code, name, unit: "piece", group: "altin" });

export const INSTRUMENTS: Instrument[] = [
  c("USD", t("ABD doları")), c("EUR", t("Euro")), c("GBP", t("İngiliz sterlini")), c("CHF", t("İsviçre frangı")), c("JPY", t("Japon yeni")),
  c("CAD", t("Kanada doları")), c("AUD", t("Avustralya doları")), c("DKK", t("Danimarka kronu")), c("SEK", t("İsveç kronu")),
  c("NOK", t("Norveç kronu")), c("SAR", t("Suudi Arabistan riyali")), c("KWD", t("Kuveyt dinarı")), c("QAR", t("Katar riyali")),
  c("AED", t("BAE dirhemi")), c("RON", t("Rumen leyi")), c("RUB", t("Rus rublesi")), c("CNY", t("Çin yuanı")), c("PKR", t("Pakistan rupisi")),
  c("KRW", t("Güney Kore wonu")), c("AZN", t("Azerbaycan manatı")), c("KZT", t("Kazakistan tengesi")),
  g("ALTIN", t("Gram altın (has)")), g("KULCEALTIN", t("Külçe altın")), g("AYAR22", t("22 ayar altın")), g("AYAR14", t("14 ayar altın")),
  p("CEYREK_YENI", t("Çeyrek altın (yeni)")), p("CEYREK_ESKI", t("Çeyrek altın (eski)")), p("YARIM_YENI", t("Yarım altın (yeni)")),
  p("YARIM_ESKI", t("Yarım altın (eski)")), p("TEK_YENI", t("Tam altın (yeni)")), p("TEK_ESKI", t("Tam altın (eski)")),
  p("ATA_YENI", t("Ata lira (yeni)")), p("ATA_ESKI", t("Ata lira (eski)")), p("ATA5_YENI", t("Ata beşli (yeni)")),
  p("ATA5_ESKI", t("Ata beşli (eski)")), p("GREMESE_YENI", t("Gremse (yeni)")), p("GREMESE_ESKI", t("Gremse (eski)")),
  g("GUMUSTRY", t("Gümüş"), "maden"),
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
export const qtyRule = (code: string): string => ({ currency: t("en çok 2 ondalık"), gram: t("en çok 3 ondalık"), piece: t("tam sayı"), share: t("tam sayı") })[unitOf(code)];
/** Miktar alanının birim etiketi */
export const unitLabel = (code: string): string => ({ currency: code, gram: t("gram"), piece: t("adet"), share: t("pay") })[unitOf(code)];
export const currencyLabel = (code: string): string =>
  code === TRY ? t("Türk lirası") : isFund(code) ? t("{code} fonu", { code: fundCode(code) ?? "" }) : (instrumentByCode.get(code)?.name ?? code);


const fmt = (d: number) => new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d });

export function formatQty(value: number, code: string): string {
  const u = unitOf(code);
  if (u === "share") return t("{v} pay", { v: fmt(0).format(value) });
  if (u === "piece") return t("{v} adet", { v: fmt(0).format(value) });
  if (u === "gram") return `${fmt(3).format(value)} g`;
  return `${fmt(2).format(value)} ${code}`;
}

const rateFmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
export const formatRate = (rate: number): string => rateFmt.format(rate);
