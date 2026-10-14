import { useMemo, useState, type FormEvent } from "react";
import { errorMessage } from "../lib/api";
import { isForeign } from "../lib/fx";
import { amountToInput, parseAmount, todayISO } from "../lib/format";
import { loanSummary } from "../lib/loans";
import { norm } from "../lib/csv";
import type { Account } from "../lib/types";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { AccountOptions } from "./AccountOptions";
import { MoneyInput } from "./common";
import { Modal } from "./Modal";

interface Props {
  account: Account;
  onClose(): void;
  onSaved(message: string): void;
}

/**
 * Kredi taksiti iki kayıt olarak girilir: anapara kısmı kaynak hesaptan krediye transfer
 * (borcu azaltır), faiz kısmı "Faiz ve Masraflar" gideri (raporlarda gider olarak görünür).
 */
export function LoanPaymentForm({ account, onClose, onSaved }: Props) {
  const { accounts, transactions, categories, addTransaction } = useData();
  const { formatMoney } = useSettings();
  const summary = useMemo(() => loanSummary(account, transactions), [account, transactions]);
  const next = summary.next;
  // Taksit TL ödenir: döviz/altın hesapları kaynak olamaz
  const sources = accounts.filter((a) => !a.archived && (a.kind === "bank" || a.kind === "cash") && !isForeign(a.currency));
  const feeCategory = categories.find((c) => c.type === "expense" && norm(c.name) === norm("Faiz ve Masraflar"));

  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [date, setDate] = useState(todayISO());
  const [principal, setPrincipal] = useState(next ? amountToInput(next.principalCents / 100) : "");
  const [interest, setInterest] = useState(next ? amountToInput(next.interestCents / 100) : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const p = parseAmount(principal) ?? 0;
  const i = parseAmount(interest) ?? 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!sourceId) return setError("Ödemenin yapılacağı hesabı seçin.");
    // Hatalı yazılmış tutar sessizce 0 sayılmasın
    if ((principal.trim() && parseAmount(principal) === null) || (interest.trim() && parseAmount(interest) === null))
      return setError("Tutarları geçerli bir sayı olarak girin (ör. 12.500,00).");
    if (p < 0 || i < 0 || p + i <= 0) return setError("Geçerli tutarlar girin.");
    setSaving(true);
    setError(null);
    let savedPrincipal = false;
    const label = next ? `${account.name} ${next.index}/${summary.schedule.length}. taksit` : `${account.name} ödemesi`;
    try {
      if (p > 0) {
        await addTransaction({
          amount: p,
          type: "transfer",
          accountId: sourceId,
          toAccountId: account.id,
          categoryId: null,
          date,
          description: `${label} (anapara)`,
          installments: 1,
        });
        savedPrincipal = true;
      }
      if (i > 0) {
        await addTransaction({
          amount: i,
          type: "expense",
          accountId: sourceId,
          toAccountId: null,
          categoryId: feeCategory?.id ?? null,
          date,
          description: `${label} (faiz)`,
          installments: 1,
        });
      }
      onSaved("Kredi ödemesi kaydedildi.");
      onClose();
    } catch (err) {
      if (savedPrincipal) {
        // Anapara kaydedildi, faiz eklenemedi: tekrar kaydetmede anapara çiftlenmesin
        onSaved(`Anapara kaydedildi, faiz eklenemedi (${errorMessage(err)}). Faizi İşlemler'den ekleyin.`);
        onClose();
        return;
      }
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`${account.name} · Taksit Öde`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Vazgeç
          </button>
          <button type="submit" form="loan-pay-form" className="btn-primary" disabled={saving}>
            Kaydet
          </button>
        </>
      }
    >
      <form id="loan-pay-form" onSubmit={submit} className="space-y-4">
        {next && (
          <p className="rounded-lg bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-800/50">
            Sıradaki taksit: <strong>{next.index}/{summary.schedule.length}</strong> · {formatMoney(next.paymentCents / 100)}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="lp-source">
              Ödenen hesap
            </label>
            <select id="lp-source" className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <AccountOptions accounts={sources} />
            </select>
          </div>
          <div>
            <label className="label" htmlFor="lp-date">
              Tarih
            </label>
            <input id="lp-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="lp-principal">
              Anapara
            </label>
            <MoneyInput id="lp-principal" data-autofocus value={principal} onValueChange={setPrincipal} />
          </div>
          <div>
            <label className="label" htmlFor="lp-interest">
              Faiz + vergi
            </label>
            <MoneyInput id="lp-interest" value={interest} onValueChange={setInterest} />
          </div>
        </div>
        <p className="text-xs text-zinc-500">
          Toplam {formatMoney(p + i)}. Anapara krediye transfer, faiz {feeCategory ? `"${feeCategory.name}"` : ""} gideri olarak kaydedilir.
        </p>
        {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">{error}</p>}
      </form>
    </Modal>
  );
}
