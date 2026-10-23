import { en, enMessages } from "../i18n/en";

/** Arayüz dili. Cihaz tercihi (tarayıcı deposunda); değişince sayfa yeniden yüklenir (biçimlendiriciler açılışta kurulur). */
export type Lang = "tr" | "en";

const KEY = "finans-lang";

function initial(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "tr" || v === "en") return v;
  } catch {
    /* depo yok: varsayılan */
  }
  return "tr";
}

export const lang: Lang = initial();

/** Tarih ve sayı biçimi */
export const locale = lang === "en" ? "en-GB" : "tr-TR";

if (typeof document !== "undefined") document.documentElement.lang = lang;

export function setLang(next: Lang) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* yoksay */
  }
  location.reload();
}

function fill(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  // "tek|çok" biçimli çeviride `n`e göre seçilir (İngilizce çoğul)
  // (Rust metninden yakalanan sayı da metin olarak gelir)
  const n = typeof vars.n === "string" && /^\d+$/.test(vars.n) ? Number(vars.n) : vars.n;
  if (s.includes("|") && typeof n === "number") {
    const [one, many] = s.split("|");
    s = n === 1 ? one : many;
  }
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/**
 * Arayüz metni: Türkçesi anahtardır, seçili dilde çevirisi döner (yoksa Türkçe kalır).
 * `{ad}` yer tutucuları `vars`'tan doldurulur: t("{n} işlem", { n: 3 }).
 */
export function t(tr: string, vars?: Record<string, string | number>): string {
  return fill(lang === "en" ? (en[tr] ?? tr) : tr, vars);
}

/**
 * Aynı Türkçe kelimenin bağlama göre farklı çevirisi: "Açık" temada "Light", durumda "On".
 * Sözlükte `metin@bağlam` anahtarı aranır, yoksa düz `metin`. Türkçede metin aynen döner.
 */
export function tc(context: string, tr: string, vars?: Record<string, string | number>): string {
  return fill(lang === "en" ? (en[`${tr}@${context}`] ?? en[tr] ?? tr) : tr, vars);
}

type Pattern = { re: RegExp; names: string[]; to: string };
/** Kalıpta çevrilen yer tutucular: iç içe hata, alan adı, Rust notu */
const NESTED = new Set(["e", "label", "note"]);
let patterns: Pattern[] | null = null;

function compile(): Pattern[] {
  const out: Pattern[] = [];
  for (const [from, to] of Object.entries(enMessages)) {
    if (!from.includes("{")) continue;
    const names: string[] = [];
    const body = from
      .split(/(\{\w+\})/)
      .map((part) => {
        const m = part.match(/^\{(\w+)\}$/);
        if (m) {
          names.push(m[1]);
          return "([\\s\\S]+?)";
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    out.push({ re: new RegExp(`^${body}$`), names, to });
  }
  // Daha uzun (daha özgül) kalıp önce
  return out.sort((a, b) => b.re.source.length - a.re.source.length);
}

/**
 * Rust'tan ya da sunucudan gelen Türkçe metin (hata, etiket): tam eşleşme ya da yer tutuculu kalıp.
 * İç içe hatalar da çevrilir ("3. işlem: Kategori bulunamadı.").
 */
export function tm(msg: string): string {
  if (lang === "tr" || !msg) return msg;
  // Yalnız Rust/sunucu sözlüğü: Rust'ın getirdiği kullanıcı verisi (ör. "Maaş" adlı kayıt) arayüz kelimesiyle çevrilmesin
  const exact = enMessages[msg];
  if (exact !== undefined) return exact;
  patterns ??= compile();
  for (const p of patterns) {
    const m = msg.match(p.re);
    if (!m) continue;
    const vars: Record<string, string> = {};
    // Yalnız iç içe hata ve Rust'ın kendi metinleri çevrilir; hesap/hedef adı gibi kullanıcı verisi olduğu gibi kalır
    p.names.forEach((n, i) => (vars[n] = NESTED.has(n) ? tm(m[i + 1]) : m[i + 1]));
    return fill(p.to, vars);
  }
  return msg;
}

/** Rust'ın açıklaması olmayan harcamalara verdiği ad çevrilir; kullanıcının yazdığı açıklama olduğu gibi kalır */
export function merchantName(name: string): string {
  return name === "Açıklamasız" ? t("Açıklamasız") : name;
}
