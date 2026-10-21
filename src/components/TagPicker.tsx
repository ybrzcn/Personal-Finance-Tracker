import { X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { errorMessage } from "../lib/api";
import { tagKey } from "../lib/tags";
import { useData } from "../state/data";
import { PALETTE } from "./CategoryForm";

interface Props {
  value: string[];
  onChange(ids: string[]): void;
  /** İşlemde zaten bulunan arşivli etiketler (çip olarak kalır, yeniden eklenemez) */
  id?: string;
  placeholder?: string;
}

/** Seçili etiket çipleri + öneri listesi; eşleşme yoksa yeni etiket oluşturur. */
export function TagPicker({ value, onChange, id = "tag-picker", placeholder = "Etiket ekle…" }: Props) {
  const { tags, tagById, addTag } = useData();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const key = tagKey(q);
  const options = useMemo(
    () => tags.filter((t) => !t.archived && !value.includes(t.id) && (!key || tagKey(t.name).includes(key))).slice(0, 8),
    [tags, value, key],
  );
  const exact = tags.some((t) => tagKey(t.name) === key);
  const add = (tid: string) => {
    onChange([...value, tid]);
    setQ("");
    setError(null);
    input.current?.focus();
  };
  const create = async () => {
    try {
      const t = await addTag({ name: q.trim(), color: PALETTE[tags.length % PALETTE.length], budget: null, archived: false });
      add(t.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="relative">
      <div className="input flex min-h-[38px] flex-wrap items-center gap-1.5 py-1">
        {value.map((tid) => {
          const t = tagById.get(tid);
          return (
            <span key={tid} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t?.color ?? "#64748b" }} />
              {t?.name ?? "?"}
              <button type="button" aria-label={`${t?.name ?? "Etiket"} kaldır`} onClick={() => onChange(value.filter((x) => x !== tid))}>
                <X size={12} />
              </button>
            </span>
          );
        })}
        <input
          id={id}
          ref={input}
          className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none"
          placeholder={value.length ? "" : placeholder}
          value={q}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && q.trim()) {
              e.preventDefault();
              if (options[0] && tagKey(options[0].name) === key) add(options[0].id);
              else if (!exact) void create();
            } else if (e.key === "Backspace" && !q && value.length) onChange(value.slice(0, -1));
          }}
        />
      </div>
      {open && (options.length > 0 || (q.trim() && !exact)) && (
        <ul id={`${id}-list`} role="listbox" className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {options.map((t) => (
            <li key={t.id} role="option" aria-selected={false} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" onMouseDown={(e) => (e.preventDefault(), add(t.id))}>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.color }} />
              {t.name}
            </li>
          ))}
          {q.trim() && !exact && (
            <li role="option" aria-selected={false} className="cursor-pointer rounded-lg px-2 py-1.5 text-sm text-indigo-600 hover:bg-zinc-100 dark:text-indigo-400 dark:hover:bg-zinc-800" onMouseDown={(e) => (e.preventDefault(), void create())}>
              “{q.trim()}” etiketini oluştur
            </li>
          )}
        </ul>
      )}
      {error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}
