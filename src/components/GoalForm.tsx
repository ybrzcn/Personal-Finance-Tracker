import { Check } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { errorMessage } from "../lib/api";
import { amountToInput, parseAmount, parseQuantity } from "../lib/format";
import { GROUP_LABEL, INSTRUMENTS, qtyDecimals, qtyRule, TRY, unitLabel, type FxGroup } from "../lib/fx";
import { GOAL_ACCOUNT_KINDS } from "../lib/goals";
import { locale, t } from "../lib/i18n";
import type { Goal } from "../lib/types";
import { useData } from "../state/data";
import { PALETTE } from "./CategoryForm";
import { Modal } from "./Modal";

interface Props {
  goal?: Goal;
  onClose(): void;
  onSaved(message: string): void;
}

const GROUPS: FxGroup[] = ["doviz", "altin", "maden"];

/** Düzenlenen hedefin tutarı birimin ondalığıyla (gram 3, adet 0); TL uygulamanın tutar biçimiyle */
const targetToInput = (v: number, code: string) =>
  code === TRY ? amountToInput(v) : v.toLocaleString(locale, { useGrouping: false, maximumFractionDigits: qtyDecimals(code) });

export function GoalForm({ goal, onClose, onSaved }: Props) {
  const { accounts, goals, addGoal, updateGoal } = useData();
  const [name, setName] = useState(goal?.name ?? "");
  const [currency, setCurrency] = useState(goal?.currency ?? TRY);
  const [target, setTarget] = useState(goal ? targetToInput(goal.target, goal.currency) : "");
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? "");
  const [color, setColor] = useState(goal?.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  const [accountIds, setAccountIds] = useState<string[]>(goal?.accountIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Hesap → bağlı olduğu başka hedefin adı
  const ownerOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of goals) if (g.id !== goal?.id) for (const a of g.accountIds) m.set(a, g.name);
    return m;
  }, [goals, goal?.id]);
  const eligible = accounts.filter((a) => GOAL_ACCOUNT_KINDS.has(a.kind) && (!a.archived || goal?.accountIds.includes(a.id)));

  const toggle = (id: string) => setAccountIds((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = currency === TRY ? parseAmount(target) : parseQuantity(target, qtyDecimals(currency));
    if (!name.trim()) return setError(t("Hedef adı boş olamaz."));
    if (value === null || value <= 0)
      return setError(currency === TRY ? t("Geçerli bir hedef tutarı girin.") : t("Geçerli bir hedef tutarı girin ({rule}).", { rule: qtyRule(currency) }));
    setSaving(true);
    setError(null);
    const input = { name, currency, target: value, targetDate: targetDate || null, color, archived: goal?.archived ?? false, accountIds };
    try {
      if (goal) {
        await updateGoal({ ...goal, ...input });
        onSaved(t("Hedef güncellendi."));
      } else {
        await addGoal(input);
        onSaved(t("Hedef eklendi."));
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
      title={goal ? t("Hedefi Düzenle") : t("Yeni Hedef")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("Vazgeç")}
          </button>
          <button type="submit" form="goal-form" className="btn-primary" disabled={saving}>
            {goal ? t("Kaydet") : t("Ekle")}
          </button>
        </>
      }
    >
      <form id="goal-form" onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="goal-name">
            {t("Ad")}
          </label>
          <input id="goal-name" data-autofocus className="input" maxLength={60} placeholder={t("Örn. Ev peşinatı")} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="goal-currency">
              {t("Birim")}
            </label>
            <select id="goal-currency" className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value={TRY}>{t("Türk lirası (TL)")}</option>
              {GROUPS.map((g) => (
                <optgroup key={g} label={GROUP_LABEL[g]}>
                  {INSTRUMENTS.filter((i) => i.group === g).map((i) => (
                    <option key={i.code} value={i.code}>
                      {i.name}
                      {i.unit === "currency" ? ` (${i.code})` : i.unit === "gram" ? ` (${t("gram")})` : ` (${t("adet")})`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="goal-target">
              {t("Hedef tutarı")}
              {currency === TRY ? "" : ` (${unitLabel(currency)})`}
            </label>
            <input id="goal-target" className="input" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="goal-date">
            {t("Hedef tarihi")} <span className="font-normal text-zinc-500">{t("(isteğe bağlı)")}</span>
          </label>
          <input id="goal-date" type="date" className="input" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </div>
        <div>
          <span className="label">{t("Hesaplar")}</span>
          {eligible.length === 0 ? (
            <p className="text-sm text-zinc-500">{t("Önce bir vadesiz, nakit, döviz/altın ya da fon hesabı ekle.")}</p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-zinc-200 p-2 dark:border-zinc-700">
              {eligible.map((a) => {
                const owner = ownerOf.get(a.id);
                return (
                  <li key={a.id}>
                    <label className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${owner ? "opacity-50" : "hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}>
                      <input type="checkbox" checked={accountIds.includes(a.id)} disabled={!!owner} onChange={() => toggle(a.id)} aria-label={a.name} />
                      <span className="min-w-0 flex-1 truncate">{a.name}</span>
                      {a.archived && <span className="text-xs text-zinc-500">{t("arşivli")}</span>}
                      {owner && <span className="shrink-0 text-xs text-zinc-500">{t("'{goal}' hedefine bağlı", { goal: owner })}</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
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
