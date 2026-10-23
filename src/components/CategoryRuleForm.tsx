import { useMemo, useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api";
import { formatDate } from "../lib/format";
import { t } from "../lib/i18n";
import { newId } from "../lib/id";
import type { CategoryRule, CategoryType } from "../lib/types";
import { useData } from "../state/data";
import { useFormPreview } from "../state/formPreview";
import { useSettings } from "../state/settings";
import { CategoryLabel } from "./common";
import { Modal } from "./Modal";

interface Props {
  rule?: CategoryRule;
  onClose(): void;
  onSaved(message: string): void;
}

export function CategoryRuleForm({ rule, onClose, onSaved }: Props) {
  const { categories, categoryById, transactions } = useData();
  const { settings, update } = useSettings();
  const [type, setType] = useState<CategoryType>(rule?.type ?? "expense");
  const [wordsText, setWordsText] = useState(rule?.words.join(", ") ?? "");
  const [categoryId, setCategoryId] = useState(rule?.categoryId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const options = categories.filter((c) => c.type === type);
  // Kelimeler ve kurala uyan işlemler Rust'ta ("migros, a101 ,, migros" → ["migros", "a101"])
  const { preview, latest } = useFormPreview({ wordsText, type }, api.previewCategoryRule);
  const words = preview?.words ?? [];
  const matches = useMemo(() => {
    const byId = new Map(transactions.map((tx) => [tx.id, tx]));
    return (preview?.matchingTransactionIds ?? []).flatMap((id) => byId.get(id) ?? []);
  }, [preview, transactions]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Kaydedilen kelimeler son yazılanın hesabından
    let words: string[];
    try {
      words = (await latest({ wordsText, type })).words;
    } catch (err) {
      return setError(t("Hesap yapılamadı: {error}", { error: errorMessage(err) }));
    }
    if (!words.length) return setError(t("En az bir kelime yazın."));
    if (!options.some((c) => c.id === categoryId)) return setError(t("Bir kategori seçin."));
    const next: CategoryRule = { id: rule?.id ?? newId(), words, type, categoryId };
    const list = rule ? settings.categoryRules.map((r) => (r.id === rule.id ? next : r)) : [...settings.categoryRules, next];
    setSaving(true);
    setError(null);
    try {
      await update({ categoryRules: list });
      onSaved(rule ? t("Kural güncellendi.") : t("Kural eklendi."));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={rule ? t("Kuralı Düzenle") : t("Yeni Kural")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("Vazgeç")}
          </button>
          <button type="submit" form="rule-form" className="btn-primary" disabled={saving}>
            {rule ? t("Kaydet") : t("Ekle")}
          </button>
        </>
      }
    >
      <form id="rule-form" onSubmit={submit} className="space-y-4">
        <div>
          <span className="label">{t("Tür")}</span>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800/70">
            {(["expense", "income"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={type === k}
                onClick={() => {
                  setType(k);
                  if (k !== type) setCategoryId("");
                }}
                className={`rounded-lg py-1.5 text-sm font-medium transition ${
                  type === k
                    ? "bg-white shadow-sm dark:bg-zinc-900"
                    : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                {k === "income" ? t("Gelir") : t("Gider")}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label" htmlFor="rule-words">
            {t("Açıklamada geçerse")}
          </label>
          <input
            id="rule-words"
            data-autofocus
            className="input"
            maxLength={500}
            placeholder={t("Örn. sinema, konser")}
            value={wordsText}
            onChange={(e) => setWordsText(e.target.value)}
          />
          <p className="mt-1 text-xs text-zinc-500">
            {t(
              "Birden fazla kelimeyi virgülle ayırın. Büyük/küçük harf ve Türkçe karakter farkı gözetilmez. 4 harf ve üstü kelimeler ekleriyle de eşleşir (kira → “Ev kirası”); daha kısalar tam kelime olarak aranır.",
            )}
          </p>
        </div>
        <div>
          <label className="label" htmlFor="rule-category">
            {t("Kategori")}
          </label>
          <select id="rule-category" className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">{t("Seçin…")}</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {words.length > 0 && (
          <div className="rounded-xl bg-zinc-50 px-3 py-2.5 text-sm dark:bg-zinc-950/60">
            <p className="font-medium">
              {matches.length ? t("Bu kurala uyan {n} işlem var", { n: matches.length }) : t("Şu an bu kurala uyan işlem yok")}
            </p>
            {matches.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {matches.slice(0, 3).map((tx) => (
                  <li key={tx.id} className="flex items-center gap-2 text-xs">
                    <span className="shrink-0 tabular-nums text-zinc-500">{formatDate(tx.date)}</span>
                    <span className="min-w-0 flex-1 truncate">{tx.description}</span>
                    <CategoryLabel category={tx.categoryId ? categoryById.get(tx.categoryId) : undefined} />
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-xs text-zinc-500">
              {t("Kural yeni girilen ve aktarılan işlemlere uygulanır; mevcut işlemlerin kategorisi değişmez.")}
            </p>
          </div>
        )}
        {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">{error}</p>}
      </form>
    </Modal>
  );
}
