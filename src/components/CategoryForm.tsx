import { Check } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage } from "../lib/api";
import type { Category, CategoryType } from "../lib/types";
import { useData } from "../state/data";
import { Modal } from "./Modal";

export const PALETTE = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e", "#10b981", "#14b8a6",
  "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#ec4899", "#64748b",
];

interface Props {
  category?: Category;
  defaultType?: CategoryType;
  onClose(): void;
  onSaved(message: string): void;
}

export function CategoryForm({ category, defaultType = "expense", onClose, onSaved }: Props) {
  const { addCategory, updateCategory } = useData();
  const [name, setName] = useState(category?.name ?? "");
  const [type, setType] = useState<CategoryType>(category?.type ?? defaultType);
  const [color, setColor] = useState(category?.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Kategori adı boş olamaz.");
    setSaving(true);
    setError(null);
    try {
      if (category) {
        await updateCategory({ ...category, name, type, color });
        onSaved("Kategori güncellendi.");
      } else {
        await addCategory({ name, type, color });
        onSaved("Kategori eklendi.");
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
      title={category ? "Kategoriyi Düzenle" : "Yeni Kategori"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Vazgeç
          </button>
          <button type="submit" form="cat-form" className="btn-primary" disabled={saving}>
            {category ? "Kaydet" : "Ekle"}
          </button>
        </>
      }
    >
      <form id="cat-form" onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="cat-name">
            Ad
          </label>
          <input
            id="cat-name"
            data-autofocus
            className="input"
            maxLength={60}
            placeholder="Örn. Abonelikler"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <span className="label">Tür</span>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800/70">
            {(["expense", "income"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={`rounded-lg py-1.5 text-sm font-medium transition ${
                  type === t
                    ? "bg-white shadow-sm dark:bg-zinc-900"
                    : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                {t === "income" ? "Gelir" : "Gider"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="label">Renk</span>
          <div className="flex flex-wrap items-center gap-2">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={c}
                className="grid h-7 w-7 place-items-center rounded-full transition hover:scale-110"
                style={{
                  backgroundColor: c,
                  boxShadow: color === c ? `0 0 0 2px var(--surface), 0 0 0 4px ${c}` : undefined,
                }}
              >
                {color === c && <Check size={14} className="text-white" strokeWidth={3} />}
              </button>
            ))}
            <label className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border border-dashed border-zinc-400" title="Özel renk">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
              <span className="grid h-full place-items-center text-xs text-zinc-500">+</span>
            </label>
          </div>
        </div>
        {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">{error}</p>}
      </form>
    </Modal>
  );
}
