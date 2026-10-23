import { Check } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage } from "../lib/api";
import { amountToInput, parseAmount } from "../lib/format";
import { t } from "../lib/i18n";
import type { Tag } from "../lib/types";
import { useData } from "../state/data";
import { PALETTE } from "./CategoryForm";
import { Modal } from "./Modal";

export function TagForm({ tag, onClose, onSaved }: { tag?: Tag; onClose(): void; onSaved(m: string): void }) {
  const { addTag, updateTag } = useData();
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState(tag?.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  const [budget, setBudget] = useState(tag?.budget != null ? amountToInput(tag.budget) : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const b = budget.trim() ? parseAmount(budget) : null;
    if (budget.trim() && (b === null || b <= 0)) return setError(t("Geçerli bir bütçe girin."));
    setSaving(true);
    setError(null);
    try {
      if (tag) {
        await updateTag({ ...tag, name, color, budget: b });
        onSaved(t("Etiket güncellendi."));
      } else {
        await addTag({ name, color, budget: b, archived: false });
        onSaved(t("Etiket eklendi."));
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={tag ? t("Etiketi Düzenle") : t("Yeni Etiket")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("Vazgeç")}
          </button>
          <button type="submit" form="tag-form" className="btn-primary" disabled={saving}>
            {tag ? t("Kaydet") : t("Ekle")}
          </button>
        </>
      }
    >
      <form id="tag-form" onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="tag-name">
            {t("Ad")}
          </label>
          <input id="tag-name" data-autofocus className="input" maxLength={40} placeholder={t("Örn. Tatil 2026")} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="tag-budget">
            {t("Bütçe")} <span className="font-normal text-zinc-500">{t("(isteğe bağlı, toplam)")}</span>
          </label>
          <input id="tag-budget" className="input" inputMode="decimal" placeholder={t("Örn. 30.000")} value={budget} onChange={(e) => setBudget(e.target.value)} />
        </div>
        <div>
          <span className="label">{t("Renk")}</span>
          <div className="flex flex-wrap items-center gap-2">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={c}
                className="grid h-7 w-7 place-items-center rounded-full transition hover:scale-110"
                style={{ backgroundColor: c, boxShadow: color === c ? `0 0 0 2px var(--surface), 0 0 0 4px ${c}` : undefined }}
              >
                {color === c && <Check size={14} className="text-white" strokeWidth={3} />}
              </button>
            ))}
          </div>
        </div>
        {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">{error}</p>}
      </form>
    </Modal>
  );
}
