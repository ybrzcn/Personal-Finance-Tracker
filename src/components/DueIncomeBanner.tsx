import { CircleDollarSign } from "lucide-react";
import { useMemo } from "react";
import { dueUnrecordedIncomes } from "../lib/budget";
import { formatDateShort, todayISO } from "../lib/format";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

/**
 * Yatış günü gelmiş ama girilmemiş maaş vb. için uyarı: "Yattı, kaydet" formu plan tutarıyla açar.
 * Kaydedilince bakiyeye eklenir ve "beklenen" olmaktan çıkar.
 */
export function DueIncomeBanner() {
  const { transactions, recurring } = useData();
  const { formatMoney } = useSettings();
  const { openTransactionForm } = useUI();
  const today = todayISO();
  const due = useMemo(() => dueUnrecordedIncomes(transactions, recurring, today), [transactions, recurring, today]);
  if (!due.length) return null;
  return (
    <div className="mb-4 space-y-2">
      {due.map(({ item, date, amount }) => (
        <div
          key={item.id}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm dark:border-emerald-500/25 dark:bg-emerald-500/10"
        >
          <CircleDollarSign size={18} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="min-w-0 flex-1">
            <strong>{item.name}</strong> {date === today ? "bugün" : formatDateShort(date)} yatacaktı ({formatMoney(amount)}). Yattıysa kaydet; bakiyene
            eklensin.
          </span>
          <button
            className="btn-primary px-3 py-1.5 text-xs"
            onClick={() =>
              openTransactionForm(undefined, {
                type: "income",
                amount,
                accountId: item.accountId ?? undefined,
                categoryId: item.categoryId,
                date,
                description: item.name,
                origAmount: item.origAmount ?? undefined,
              })
            }
          >
            Yattı, kaydet
          </button>
        </div>
      ))}
    </div>
  );
}
