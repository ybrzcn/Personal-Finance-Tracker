import { Check, X } from "lucide-react";
import { useState } from "react";
import { useData } from "../state/data";
import { useUI } from "../state/ui";
import { t } from "../lib/i18n";

const DISMISS_KEY = "finans-setup-dismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * İlk kullanım rehberi: uygulamanın asıl değeri (ödeme takvimi, borç planı) için gereken dört kurulum adımı.
 * Hepsi tamamlanınca ya da kullanıcı kapatınca görünmez.
 */
export function SetupChecklist() {
  const { accounts, transactions, recurring } = useData();
  const { openAccountForm, openRecurringForm, openStatementImport } = useUI();
  const [dismissed, setDismissed] = useState(readDismissed);

  const cards = accounts.filter((a) => a.kind === "credit_card" && !a.archived);
  const steps = [
    {
      title: t("Banka hesabını ve bugünkü bakiyesini gir"),
      hint: t("Vadesiz hesabın (KMH varsa limitiyle) bakiyesi; nakit planı bundan başlar."),
      done: accounts.some((a) => a.kind === "bank" && !a.subtype && (a.openingBalance !== 0 || transactions.some((tx) => tx.accountId === a.id))),
      action: () => openAccountForm(accounts.find((a) => a.kind === "bank" && !a.subtype)),
      label: t("Hesabı düzenle"),
    },
    {
      title: t("Maaşını ekle"),
      hint: t("Yattığı gün, tutarı ve hangi ayın maaşı olduğu; ödemeler maaş dönemlerine göre planlanır."),
      done: recurring.some((r) => r.type === "income" && r.active),
      action: () => openRecurringForm(undefined, "income"),
      label: t("Maaş ekle"),
    },
    {
      title: t("Kredi kartlarını tanımla"),
      hint: t("Hesap kesim ve son ödeme günleriyle; ekstreler ve son ödemeler otomatik hesaplanır."),
      done: cards.length > 0,
      action: () => openAccountForm(),
      label: t("Kart ekle"),
    },
    {
      title: t("İlk ekstreni yükle"),
      hint: t("Bankadan indirdiğin PDF, Excel veya CSV ekstresi; harcamalar kategorilenerek eklenir."),
      done: cards.some((c) => transactions.some((tx) => tx.accountId === c.id)),
      action: () => openStatementImport(cards[0]?.id),
      label: t("Ekstre yükle"),
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (dismissed || doneCount === steps.length) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* yoksay */
    }
  };

  return (
    <section className="card mb-4 p-5" aria-labelledby="setup-title">
      <div className="mb-3 flex items-start gap-3">
        <div className="flex-1">
          <h2 id="setup-title" className="text-sm font-semibold">
            {t("Kurulum · {done}/{total} adım tamam", { done: doneCount, total: steps.length })}
          </h2>
          <p className="text-xs text-zinc-500">{t("Bu dört adımla ödeme takvimi, bütçe ve borç planı senin verinle çalışır.")}</p>
        </div>
        <button className="icon-btn" aria-label={t("Kurulum listesini gizle")} title={t("Gizle")} onClick={dismiss}>
          <X size={16} />
        </button>
      </div>
      <ol className="grid gap-2 md:grid-cols-2">
        {steps.map((s, i) => (
          <li
            key={s.title}
            className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 ${
              s.done ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-500/20 dark:bg-emerald-500/5" : "border-zinc-200 dark:border-zinc-800"
            }`}
          >
            <span
              className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${
                s.done ? "bg-emerald-500 text-white" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              }`}
            >
              {s.done ? <Check size={14} strokeWidth={3} /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-medium ${s.done ? "text-zinc-500 line-through" : ""}`}>{s.title}</div>
              {!s.done && <div className="text-xs text-zinc-500">{s.hint}</div>}
            </div>
            {!s.done && (
              <button className="btn-secondary shrink-0 px-2.5 py-1 text-xs" onClick={s.action}>
                {s.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
