import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { bankBalanceCents, nativeBalanceMinor } from "../lib/accounts";
import { errorMessage } from "../lib/api";
import { installmentPostings } from "../lib/cards";
import { cashAdvancePlan } from "../lib/loans";
import { amountToInput, daysBetween, formatDateShort, formatMonthYear, parseAmount, parseDecimal, parseQuantity, todayISO } from "../lib/format";
import { defaultSide, formatQty, formatRate, isForeign, qtyDecimals, qtyRule, tlAmount, TRY, unitDivisor, unitOf } from "../lib/fx";
import { shiftMonth } from "../lib/recurring";
import { buildHistory, suggestCategory } from "../lib/statementImport";
import type { Account, Transaction, TransactionInput, TxType } from "../lib/types";
import { useData } from "../state/data";
import { useRates } from "../state/rates";
import { useSettings } from "../state/settings";
import { useUI, type AmountHint, type TransactionDefaults } from "../state/ui";
import { AccountOptions } from "./AccountOptions";
import { MoneyInput, Term, TERMS } from "./common";
import { Modal } from "./Modal";

interface Props {
  transaction?: Transaction;
  defaults?: TransactionDefaults;
  hints?: AmountHint[];
  onClose(): void;
  onSaved(message: string): void;
}

const LAST_ACCOUNT_KEY = "finans-last-account";

function readLastAccount(): string {
  try {
    return localStorage.getItem(LAST_ACCOUNT_KEY) ?? "";
  } catch {
    return "";
  }
}

const TYPES: { value: TxType; label: string; icon: typeof ArrowUpRight; active: string }[] = [
  { value: "expense", label: "Gider", icon: ArrowUpRight, active: "text-rose-600 dark:text-rose-400" },
  { value: "income", label: "Gelir", icon: ArrowDownLeft, active: "text-emerald-600 dark:text-emerald-400" },
  { value: "transfer", label: "Transfer", icon: ArrowLeftRight, active: "text-indigo-600 dark:text-indigo-400" },
];

const SAVED: Record<TxType, string> = { income: "Gelir eklendi.", expense: "Gider eklendi.", transfer: "Transfer eklendi." };

function AccountSelect({
  id,
  value,
  onChange,
  options,
  invalid,
}: {
  id: string;
  value: string;
  onChange(v: string): void;
  options: Account[];
  invalid?: boolean;
}) {
  return (
    <select
      id={id}
      className={`input ${invalid ? "border-rose-500 focus:border-rose-500 focus:ring-rose-500/20" : ""}`}
      aria-invalid={invalid || undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="" disabled>
        Hesap seçin
      </option>
      <AccountOptions accounts={options} />
    </select>
  );
}

export function TransactionForm({ transaction, defaults, hints, onClose, onSaved }: Props) {
  const { categories, accounts, accountById, transactions, addTransaction, updateTransaction } = useData();
  const { confirm } = useUI();
  const { formatMoney, settings } = useSettings();
  const editing = !!transaction;
  const init: Partial<TransactionInput> = transaction ?? defaults ?? {};

  const initialAccount = () => {
    if (init.accountId) return init.accountId;
    const active = accounts.filter((a) => !a.archived && a.id !== init.toAccountId);
    // Transferde (ör. kart ödemesi) kaynak olarak kart dışı hesap tercih edilir
    const pool = init.type === "transfer" ? active.filter((a) => a.kind !== "credit_card") : active;
    const last = readLastAccount();
    return (pool.find((a) => a.id === last) ?? pool[0] ?? active[0])?.id ?? "";
  };

  const [type, setType] = useState<TxType>(init.type ?? "expense");
  const [amount, setAmount] = useState(init.amount ? amountToInput(init.amount) : "");
  const [accountId, setAccountId] = useState(initialAccount);
  const [toAccountId, setToAccountId] = useState(init.toAccountId ?? "");
  const [categoryId, setCategoryId] = useState<string>(
    () =>
      init.categoryId ??
      (defaults?.cashAdvance ? categories.find((c) => c.type === "expense" && c.name === "Nakit Avans")?.id : undefined) ??
      "",
  );
  const [date, setDate] = useState(init.date ?? todayISO());
  // Kart ödemesi bağlamı (Hesaplar → "Ödeme yap"): başlık ve açıklama karttan gelir
  const payCard = !transaction && init.type === "transfer" && init.toAccountId ? accountById.get(init.toAccountId) : undefined;
  const [description, setDescription] = useState(
    init.description ??
      (payCard?.kind === "credit_card" ? `${payCard.name} ekstre ödemesi` : payCard?.kind === "loan" ? `${payCard.name} ödemesi` : ""),
  );
  const [installments, setInstallments] = useState(init.installments ?? 1);
  // Yalnız gelir: bütçede hangi ayın geliri sayılacağı ("" = otomatik, işlem tarihinin ayı)
  const [budgetMonth, setBudgetMonth] = useState(init.budgetMonth ?? "");
  const monthLabel = (ym: string) => formatMonthYear(new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1));
  const budgetMonthOptions = useMemo(() => {
    const base = (date || todayISO()).slice(0, 7);
    const list = [-3, -2, -1, 0, 1].map((d) => shiftMonth(base, d));
    return budgetMonth && !list.includes(budgetMonth) ? [budgetMonth, ...list] : list;
  }, [date, budgetMonth]);
  const { rates, refresh, rateAt } = useRates();
  const decimalText = (v: number | null | undefined) => (v == null ? "" : String(v).replace(".", ","));
  const [qty, setQty] = useState(decimalText(init.origAmount));
  const [rate, setRate] = useState(decimalText(init.fxRate));
  const [toQty, setToQty] = useState(decimalText(init.toOrigAmount));
  const [toRate, setToRate] = useState(decimalText(init.toFxRate));
  // Kullanıcı ya da düzenlenen kayıt kuru belirlediyse otomatik doldurma ezmez (çevrimdışı düzenleme saklı kurla çalışır)
  const rateTouched = useRef(init.fxRate != null);
  const toRateTouched = useRef(init.toFxRate != null);
  const [rateNote, setRateNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Hatalı alan: kırmızı çerçeve + odak + ekran okuyucuya duyuru
  const [errorField, setErrorField] = useState<string | null>(null);
  const fail = (message: string, field: string) => {
    setError(message);
    setErrorField(field);
    requestAnimationFrame(() => document.getElementById(field)?.focus());
  };
  const invalid = (field: string) => (errorField === field ? "border-rose-500 focus:border-rose-500 focus:ring-rose-500/20" : "");
  // Açıklamaya göre kategori önerisi (kullanıcı kategoriyi kendisi seçmediyse)
  const categoryTouched = useRef(!!init.categoryId);
  const [suggestedName, setSuggestedName] = useState<string | null>(null);
  const history = useMemo(() => buildHistory(transactions), [transactions]);
  const onDescription = (v: string) => {
    setDescription(v);
    if (categoryTouched.current || type === "transfer" || !v.trim()) return;
    const id = suggestCategory(v, type, history, categories, settings.categoryRules);
    if (id) {
      setCategoryId(id);
      setSuggestedName(categories.find((c) => c.id === id)?.name ?? null);
    }
  };
  // Çok kayıtlı kaydetmede (nakit avans) yarıda kalırsa kaç kaydın eklendiği
  const partialSaved = useRef(0);
  // Kredi kartı nakit avansı (yalnız yeni kayıtta): ücret ve taksitli avansın sabit faizi ayrı gider olarak eklenir
  const [cashAdvance, setCashAdvance] = useState(!transaction && !!defaults?.cashAdvance);
  const [feeRate, setFeeRate] = useState("1,15");
  const [feeInput, setFeeInput] = useState<string | null>(null);
  const [advRate, setAdvRate] = useState("");
  const [advInstallmentInput, setAdvInstallmentInput] = useState<string | null>(null);
  const [advTotalInput, setAdvTotalInput] = useState<string | null>(null);
  // Ödeme planındaki toplam faiz / KKDF / BSMV (elle yazılırsa toplam bunlardan hesaplanır)
  const [advParts, setAdvParts] = useState<{ faiz: string; kkdf: string; bsmv: string } | null>(null);

  const selectable = (keep: string) => accounts.filter((a) => !a.archived || a.id === keep);
  const categoryOptions = useMemo(() => categories.filter((c) => c.type === type), [categories, type]);
  const account = accountById.get(accountId);
  const toAccount = type === "transfer" ? accountById.get(toAccountId) : undefined;
  const fromCur = account?.currency ?? TRY;
  const toCur = toAccount?.currency ?? TRY;
  const fromFx = isForeign(fromCur);
  const toFx = type === "transfer" && isForeign(toCur);
  const canInstall = type === "expense" && account?.kind === "credit_card";
  const n = canInstall ? installments : 1;
  const parsed = parseAmount(amount);
  const qtyVal = fromFx ? parseQuantity(qty, qtyDecimals(fromCur)) : null;
  const rateVal = fromFx ? parseDecimal(rate, 6) : null;
  const toQtyVal = toFx ? parseQuantity(toQty, qtyDecimals(toCur)) : null;
  const toRateVal = toFx ? parseDecimal(toRate, 6) : null;
  // TL karşılığı: TL dışı kaynaktan, o yoksa TL dışı hedeften; ikisi de TL ise girilen tutar
  const tlValue = fromFx
    ? qtyVal && qtyVal > 0 && rateVal && rateVal > 0
      ? tlAmount(qtyVal, rateVal, fromCur)
      : null
    : toFx
      ? toQtyVal && toQtyVal > 0 && toRateVal && toRateVal > 0
        ? tlAmount(toQtyVal, toRateVal, toCur)
        : null
      : parsed;
  // Döviz → döviz: hedef miktarı boşsa TL karşılığından önerilir
  const toQtySuggestion =
    fromFx && toFx && tlValue && toRateVal ? Math.round((tlValue / toRateVal) * 10 ** qtyDecimals(toCur)) / 10 ** qtyDecimals(toCur) : null;

  // Dövizli hesap seçilince kurlar kaynaktan yenilenir (en çok dakikada bir)
  useEffect(() => {
    if (fromFx || toFx) void refresh();
  }, [fromFx, toFx, refresh]);

  // Para birimi değişince elle girilen/saklı kur geçersizdir (USD kuru altın hesabında kalmasın)
  const lastFromCur = useRef(fromCur);
  const lastToCur = useRef(toCur);
  if (lastFromCur.current !== fromCur) {
    lastFromCur.current = fromCur;
    rateTouched.current = false;
  }
  if (lastToCur.current !== toCur) {
    lastToCur.current = toCur;
    toRateTouched.current = false;
  }

  // Kur alanları: bugün için güncel, geçmiş tarih için o günün kuru; kullanıcı değiştirdiyse dokunulmaz.
  // `rates` bağımlılığı: form kurlar gelmeden açıldıysa gelince doldurulur
  useEffect(() => {
    let cancelled = false;
    const fill = async (code: string, side: "buy" | "sell", set: (v: string) => void) => {
      const q = await rateAt(code, date || todayISO()).catch(() => null);
      if (cancelled) return;
      if (q) set(formatRate(q[side]));
      else {
        // Bulunamazsa başka günün/birimin kuru alanda kalmaz
        set("");
        setRateNote("Bu tarih için kur bulunamadı; kuru elle girin.");
      }
    };
    setRateNote(null);
    if (fromFx && !rateTouched.current) void fill(fromCur, defaultSide(fromCur, toFx ? toCur : null), setRate);
    if (toFx && !toRateTouched.current) void fill(toCur, defaultSide(fromCur, toCur), setToRate);
    return () => {
      cancelled = true;
    };
  }, [fromFx, toFx, fromCur, toCur, date, rateAt, rates]);
  const isAdvance = canInstall && cashAdvance && !editing;
  // Banka yöntemi: taksitler çekim gününden itibaren ekstrelere yazılır; ilk dönemin faizi çekimden ilk son ödeme
  // tarihine kadar işler (ör. kesim 23 / ödeme 2 kartta 26 Eylül çekim → 2 Kasım, 37 gün)
  const firstDue = isAdvance && account && date ? installmentPostings(account, date, 1, 1)[0].dueDate : null;
  const advance = useMemo(() => {
    if (!isAdvance || !parsed || parsed <= 0) return null;
    const principalCents = Math.round(parsed * 100);
    const feePct = parseAmount(feeRate) ?? 0;
    const fee = feeInput !== null ? (parseAmount(feeInput) ?? 0) : Math.round(principalCents * feePct) / 10000;
    let installment = parsed;
    // Banka yöntemi: ilk dönem faizi çekimden ilk taksite kadar geçen günle; ilk taksit tarihi yoksa 30 gün
    const days = firstDue ? daysBetween(date, firstDue) : 30;
    const auto = n > 1 ? cashAdvancePlan(principalCents, (parseAmount(advRate) ?? 0) / 100, n, days) : null;
    if (auto) installment = advInstallmentInput !== null ? (parseAmount(advInstallmentInput) ?? 0) : auto.paymentsCents[0] / 100;
    const cents = (v: string) => Math.round((parseAmount(v) ?? 0) * 100);
    // Toplam elle yazıldıysa (ödeme planındaki "Toplam") kuruş farkı olmadan o kullanılır
    let totalCents = auto && advInstallmentInput === null ? auto.totalCents : Math.round(installment * n * 100);
    if (n > 1 && advParts) totalCents = principalCents + cents(advParts.faiz) + cents(advParts.kkdf) + cents(advParts.bsmv);
    else if (n > 1 && advTotalInput !== null) totalCents = cents(advTotalInput);
    const total = n > 1 ? totalCents / 100 : parsed;
    if (n > 1 && (advParts || advTotalInput !== null)) installment = Math.round(totalCents / n) / 100;
    const interestCents = Math.max(0, n > 1 ? totalCents - principalCents : 0);
    // Faiz kalemleri: elle yazılmadıysa KKDF ve BSMV faizin %15'er (toplam faizin 1,3'te biri akdi faiz)
    let faizCents = Math.round(interestCents / 1.3);
    let kkdfCents = Math.round(faizCents * 0.15);
    let bsmvCents = interestCents - faizCents - kkdfCents;
    if (auto && totalCents === auto.totalCents) [faizCents, kkdfCents, bsmvCents] = [auto.interestCents, auto.kkdfCents, auto.bsmvCents];
    if (advParts) [faizCents, kkdfCents, bsmvCents] = [cents(advParts.faiz), cents(advParts.kkdf), cents(advParts.bsmv)];
    return {
      fee,
      installment,
      total,
      interest: interestCents / 100,
      parts: { faiz: faizCents / 100, kkdf: kkdfCents / 100, bsmv: bsmvCents / 100 },
    };
  }, [isAdvance, parsed, feeRate, feeInput, advRate, advInstallmentInput, advTotalInput, advParts, n, date, firstDue]);
  const postDate = date;
  const perInstallment = n > 1 && parsed && parsed > 0 ? parsed / n : null;
  // Kart harcamasının ekstrelere dağılımı; takip başlangıcından önceki taksitler ödenmiş sayılır
  const cardInfo = useMemo(() => {
    if (type !== "expense" || account?.kind !== "credit_card" || !parsed || parsed <= 0 || !postDate) return null;
    const postings = installmentPostings(account, postDate, parsed, n);
    const open = postings.filter((p) => !p.settled);
    const settled = postings.length - open.length;
    if (!open.length) return `Tüm taksitler takip başlangıcından önceki ekstrelere düşüyor (ödenmiş sayılır); borca eklenmez.`;
    const range =
      open.length === 1
        ? `${formatDateShort(open[0].closingDate)} ekstresine (son ödeme ${formatDateShort(open[0].dueDate)})`
        : `${formatDateShort(open[0].closingDate)} – ${formatDateShort(open[open.length - 1].closingDate)} ekstrelerine`;
    return settled > 0
      ? `${settled}/${postings.length} taksit önceki ekstrelerde ödenmiş sayılır; kalan ${open.length} taksit ${range} yazılır.`
      : `${open.length > 1 ? `${open.length} taksit ` : ""}${range} yazılır.`;
  }, [type, account, parsed, n, postDate]);

  const switchType = (t: TxType) => {
    setType(t);
    // Tür değişince uyumsuz kategori seçimini temizle
    if (t === "transfer" || (categoryId && !categories.some((c) => c.id === categoryId && c.type === t))) setCategoryId("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (fromFx && !(qtyVal && qtyVal > 0)) return fail(`Geçerli bir miktar girin (${qtyRule(fromCur)}).`, "tx-qty");
    if (fromFx && !(rateVal && rateVal > 0)) return fail("Kuru girin (1 birimin TL fiyatı).", "tx-rate");
    const toQtyFinal = toQtyVal ?? toQtySuggestion;
    if (toFx && !(toQtyFinal && toQtyFinal > 0)) return fail(`Hedefe geçen miktarı girin (${qtyRule(toCur)}).`, "tx-to-qty");
    if (toFx && !(toRateVal && toRateVal > 0)) return fail("Hedef hesabın kurunu girin.", "tx-to-rate");
    if (tlValue === null || tlValue <= 0) return fail("Geçerli ve sıfırdan büyük bir tutar girin (ör. 1.250,00).", "tx-amount");
    if (!date) return fail("Bir tarih seçin.", "tx-date");
    if (!accountId) return fail("Bir hesap seçin.", "tx-account");
    if (type === "transfer" && !toAccountId) return fail("Paranın gideceği hesabı seçin.", "tx-to-account");
    if (type === "transfer" && toAccountId === accountId) return fail("Kaynak ve hedef hesap aynı olamaz.", "tx-to-account");
    // Nakit hesabı eksiye düşemez: muhtemelen yanlış hesap ya da tutar
    const source = accountById.get(accountId);
    if (source?.kind === "cash" && type !== "income") {
      const others = transactions.filter((t) => t.id !== transaction?.id);
      const before = fromFx ? nativeBalanceMinor(source, others) : bankBalanceCents(source, others);
      const after = before - (fromFx ? Math.round(qtyVal! * unitDivisor(fromCur)) : Math.round(tlValue * 100));
      if (after < 0) {
        const ok = await confirm({
          title: "Nakit eksiye düşecek",
          message: `${source.name} bakiyesi ${fromFx ? formatQty(after / unitDivisor(fromCur), fromCur) : formatMoney(after / 100)} olacak. Nakit eksiye düşemez; tutarı ya da hesabı kontrol edin. Yine de kaydedilsin mi?`,
          confirmLabel: "Yine de kaydet",
        });
        if (!ok) return;
      }
    }
    setSaving(true);
    setError(null);
    setErrorField(null);
    partialSaved.current = 0;
    try {
      const payload: TransactionInput = {
        amount: tlValue,
        type,
        accountId,
        toAccountId: type === "transfer" ? toAccountId : null,
        categoryId: type === "transfer" ? null : categoryId || null,
        date,
        description,
        installments: n,
        budgetMonth: type === "income" && budgetMonth ? budgetMonth : null,
        origAmount: fromFx ? qtyVal : null,
        fxRate: fromFx ? rateVal : null,
        toOrigAmount: toFx ? toQtyFinal : null,
        toFxRate: toFx ? toRateVal : null,
      };
      if (transaction) {
        await updateTransaction({ ...transaction, ...payload });
        onSaved("İşlem güncellendi.");
      } else if (isAdvance && advance) {
        if (n > 1 && advance.total < tlValue) throw new Error("Taksit tutarı, toplamda çekilen tutardan az olamaz.");
        const advCat = categories.find((c) => c.type === "expense" && c.name === "Nakit Avans");
        const feeCat = categories.find((c) => c.type === "expense" && c.name === "Faiz ve Masraflar");
        const label = description.trim() || "Nakit avans";
        await addTransaction({ ...payload, categoryId: categoryId || advCat?.id || null, description: label });
        partialSaved.current = 1;
        if (n > 1)
          for (const [amt, what] of [
            [advance.parts.faiz, "faizi"],
            [advance.parts.kkdf, "KKDF"],
            [advance.parts.bsmv, "BSMV"],
          ] as const)
            if (amt > 0)
              (await addTransaction({
                ...payload,
                amount: amt,
                categoryId: feeCat?.id ?? null,
                description: `${label} ${what} (${n} taksit)`,
              }),
                partialSaved.current++);
        if (advance.fee > 0)
          await addTransaction({
            ...payload,
            amount: advance.fee,
            installments: 1,
            categoryId: feeCat?.id ?? null,
            description: `${label} ücreti`,
          });
        onSaved("Nakit avans eklendi.");
      } else {
        await addTransaction(payload);
        onSaved(SAVED[type]);
      }
      try {
        localStorage.setItem(LAST_ACCOUNT_KEY, accountId);
      } catch {
        /* yoksay */
      }
      onClose();
    } catch (err) {
      if (partialSaved.current > 0) {
        // Bir kısmı kaydedildi: form açık kalıp yeniden "Ekle"ye basılırsa kayıtlar çiftlenmesin
        onSaved(
          `Nakit avansın ${partialSaved.current} kaydı eklendi, kalanı eklenemedi (${errorMessage(err)}). İşlemler'den kontrol edin.`,
        );
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
      title={
        editing
          ? "İşlemi Düzenle"
          : payCard
            ? `${payCard.name} · ${payCard.kind === "credit_card" ? "Kart ödemesi" : "Ödeme"}`
            : "Yeni İşlem"
      }
      width={isAdvance ? "max-w-lg" : undefined}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Vazgeç
          </button>
          <button type="submit" form="tx-form" className="btn-primary" disabled={saving || accounts.length === 0}>
            {editing ? "Kaydet" : "Ekle"}
          </button>
        </>
      }
    >
      {accounts.length === 0 ? (
        <p className="text-sm text-zinc-500">Önce Hesaplar sayfasından bir hesap ekleyin.</p>
      ) : (
        <form id="tx-form" onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800/70">
            {TYPES.map(({ value, label, icon: Icon, active }) => (
              <button
                key={value}
                type="button"
                aria-pressed={type === value}
                onClick={() => switchType(value)}
                className={`flex items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition ${
                  type === value
                    ? `bg-white shadow-sm dark:bg-zinc-900 ${active}`
                    : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>

          {!fromFx && !toFx && (
            <div>
              <label className="label" htmlFor="tx-amount">
                Tutar
              </label>
              <MoneyInput
                id="tx-amount"
                data-autofocus
                className={`text-lg font-semibold ${invalid("tx-amount")}`}
                aria-invalid={errorField === "tx-amount" || undefined}
                aria-describedby={errorField === "tx-amount" ? "tx-error" : undefined}
                placeholder="0,00"
                value={amount}
                onValueChange={setAmount}
              />
              {hints && hints.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {hints.map((h) => (
                    <button
                      key={h.label}
                      type="button"
                      onClick={() => setAmount(amountToInput(h.amount))}
                      className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                    >
                      {h.label}: {formatMoney(h.amount)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {(fromFx || toFx) && (
            <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              {fromFx && (
                <FxFields
                  idPrefix="tx"
                  label={type === "transfer" ? "Çıkan miktar" : "Miktar"}
                  code={fromCur}
                  qty={qty}
                  onQty={setQty}
                  rate={rate}
                  onRate={(v) => {
                    rateTouched.current = true;
                    setRate(v);
                  }}
                  invalid={invalid}
                  autoFocus
                />
              )}
              {toFx && (
                <FxFields
                  idPrefix="tx-to"
                  label="Hedefe geçen miktar"
                  code={toCur}
                  qty={toQty}
                  placeholder={toQtySuggestion ? String(toQtySuggestion).replace(".", ",") : undefined}
                  onQty={setToQty}
                  rate={toRate}
                  onRate={(v) => {
                    toRateTouched.current = true;
                    setToRate(v);
                  }}
                  invalid={invalid}
                  autoFocus={!fromFx}
                />
              )}
              <p className="text-sm tabular-nums">
                TL karşılığı: <strong>{tlValue ? formatMoney(tlValue) : "—"}</strong>
              </p>
              {rateNote && <p className="text-xs text-amber-700 dark:text-amber-300">{rateNote}</p>}
            </div>
          )}

          {/* Açıklama önce: yazılınca kategori önerilir */}
          <div>
            <label className="label" htmlFor="tx-desc">
              Açıklama
            </label>
            <input
              id="tx-desc"
              className="input"
              placeholder={type === "transfer" ? "Örn. Ekstre ödemesi" : "Örn. Market alışverişi"}
              maxLength={200}
              value={description}
              onChange={(e) => onDescription(e.target.value)}
            />
            {suggestedName && <p className="mt-1 text-xs text-zinc-500">Kategori açıklamaya göre seçildi: {suggestedName}</p>}
          </div>

          {type === "transfer" ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="tx-account">
                  Nereden
                </label>
                <AccountSelect
                  id="tx-account"
                  value={accountId}
                  onChange={(v) => {
                    setAccountId(v);
                    // Hedefle aynı hesap seçilirse hedef temizlenir (listede gizlenen hedef yanlış görünmesin)
                    if (v === toAccountId) setToAccountId("");
                  }}
                  options={selectable(transaction?.accountId ?? "")}
                />
              </div>
              <div>
                <label className="label" htmlFor="tx-to-account">
                  Nereye
                </label>
                <AccountSelect
                  id="tx-to-account"
                  invalid={errorField === "tx-to-account"}
                  value={toAccountId}
                  onChange={setToAccountId}
                  options={selectable(transaction?.toAccountId ?? init.toAccountId ?? "").filter((a) => a.id !== accountId)}
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="tx-account">
                  Hesap
                </label>
                {/* Gelir/giderde kredi hesabı seçilmez (kredi taksiti "Taksit öde" ile girilir) */}
                <AccountSelect
                  id="tx-account"
                  value={accountId}
                  onChange={setAccountId}
                  options={selectable(transaction?.accountId ?? "").filter((a) => a.kind !== "loan" || a.id === transaction?.accountId)}
                />
              </div>
              <div>
                <label className="label" htmlFor="tx-category">
                  Kategori
                </label>
                <select
                  id="tx-category"
                  className="input"
                  value={categoryId}
                  onChange={(e) => {
                    categoryTouched.current = true;
                    setSuggestedName(null);
                    setCategoryId(e.target.value);
                  }}
                >
                  <option value="">Kategorisiz</option>
                  {categoryOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {canInstall && !editing && (
            <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={cashAdvance}
                onChange={(e) => {
                  setCashAdvance(e.target.checked);
                  const advCat = categories.find((c) => c.type === "expense" && c.name === "Nakit Avans");
                  if (e.target.checked && advCat && !categoryId) setCategoryId(advCat.id);
                }}
              />
              Nakit avans (ATM / nakit çekim)
            </label>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="tx-date">
                Tarih
              </label>
              <input
                id="tx-date"
                type="date"
                className={`input ${invalid("tx-date")}`}
                aria-invalid={errorField === "tx-date" || undefined}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            {canInstall && (
              <div>
                <label className="label" htmlFor="tx-installments">
                  Taksit
                </label>
                <select
                  id="tx-installments"
                  className="input"
                  value={installments}
                  onChange={(e) => setInstallments(Number(e.target.value))}
                >
                  {Array.from({ length: 36 }, (_, i) => i + 1).map((k) => (
                    <option key={k} value={k}>
                      {k === 1 ? "Tek çekim" : `${k} taksit`}
                    </option>
                  ))}
                </select>
                {perInstallment && !isAdvance && <p className="mt-1 text-xs text-zinc-500">Aylık {formatMoney(perInstallment)}</p>}
              </div>
            )}
          </div>
          {isAdvance && advance && (
            <div className="space-y-3 rounded-lg border border-indigo-200 p-3 dark:border-indigo-500/30">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="tx-fee-rate">
                    Çekim ücreti (%)
                  </label>
                  <input
                    id="tx-fee-rate"
                    className="input"
                    inputMode="decimal"
                    value={feeRate}
                    onChange={(e) => {
                      setFeeRate(e.target.value);
                      setFeeInput(null);
                    }}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="tx-fee">
                    Ücret tutarı
                  </label>
                  <input
                    id="tx-fee"
                    className="input tabular-nums"
                    inputMode="decimal"
                    value={feeInput ?? amountToInput(advance.fee)}
                    onChange={(e) => setFeeInput(e.target.value)}
                  />
                </div>
              </div>
              {n > 1 && (
                <div className="grid grid-cols-2 items-end gap-3">
                  <div>
                    <label className="label" htmlFor="tx-adv-rate">
                      Aylık faiz (%)
                    </label>
                    <input
                      id="tx-adv-rate"
                      className="input"
                      inputMode="decimal"
                      placeholder="Örn. 4,25"
                      value={advRate}
                      onChange={(e) => {
                        setAdvRate(e.target.value);
                        setAdvInstallmentInput(null);
                        setAdvTotalInput(null);
                        setAdvParts(null);
                      }}
                    />
                  </div>
                  <div className="rounded-lg bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-800/60">
                    <div className="tabular-nums">
                      Aylık taksit <strong>{formatMoney(advance.installment)}</strong>
                    </div>
                    <div className="text-xs text-zinc-500 tabular-nums">Toplam geri ödeme {formatMoney(advance.total)}</div>
                  </div>
                </div>
              )}
              {n > 1 && (
                // Ayrıntılı tutarlar yalnız bankanın ödeme planı elindeyse gerekir
                <details
                  className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800"
                  open={advInstallmentInput !== null || advTotalInput !== null || advParts !== null}
                >
                  <summary className="cursor-pointer text-sm font-medium">Bankanın ödeme planından gir</summary>
                  <div className="mt-3 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="label" htmlFor="tx-adv-inst">
                          Aylık taksit
                        </label>
                        <input
                          id="tx-adv-inst"
                          className="input tabular-nums"
                          inputMode="decimal"
                          value={
                            advTotalInput !== null || advParts
                              ? amountToInput(advance.installment)
                              : (advInstallmentInput ?? amountToInput(advance.installment))
                          }
                          onChange={(e) => {
                            setAdvInstallmentInput(e.target.value);
                            setAdvTotalInput(null);
                            setAdvParts(null);
                          }}
                        />
                      </div>
                      <div>
                        <label className="label" htmlFor="tx-adv-total">
                          Toplam ödeme
                        </label>
                        <input
                          id="tx-adv-total"
                          className="input tabular-nums"
                          inputMode="decimal"
                          value={advParts ? amountToInput(advance.total) : (advTotalInput ?? amountToInput(advance.total))}
                          onChange={(e) => {
                            setAdvTotalInput(e.target.value);
                            setAdvParts(null);
                          }}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      {(
                        [
                          ["faiz", "Akdi faiz"],
                          ["kkdf", "KKDF"],
                          ["bsmv", "BSMV"],
                        ] as const
                      ).map(([key, label]) => (
                        <div key={key}>
                          <label className="label" htmlFor={`tx-adv-${key}`}>
                            {key === "faiz" ? label : <Term hint={key === "kkdf" ? TERMS.KKDF : TERMS.BSMV}>{label}</Term>}
                          </label>
                          <input
                            id={`tx-adv-${key}`}
                            className="input tabular-nums"
                            inputMode="decimal"
                            value={advParts ? advParts[key] : amountToInput(advance.parts[key])}
                            onChange={(e) => {
                              const base = advParts ?? {
                                faiz: amountToInput(advance.parts.faiz),
                                kkdf: amountToInput(advance.parts.kkdf),
                                bsmv: amountToInput(advance.parts.bsmv),
                              };
                              setAdvParts({ ...base, [key]: e.target.value });
                              setAdvInstallmentInput(null);
                              setAdvTotalInput(null);
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </details>
              )}
              {n > 1 && firstDue && (
                <p className="text-xs font-medium text-indigo-600 dark:text-indigo-300">
                  Çekim {formatDateShort(date)} → ilk son ödeme {formatDateShort(firstDue)}: ilk taksitte {daysBetween(date, firstDue)} gün
                  faiz.
                </p>
              )}
              <p className="text-xs text-zinc-500">
                {n > 1
                  ? `Faiz ve vergiler toplamı ${formatMoney(advance.interest)}; ücretle birlikte "Faiz ve Masraflar" gideri olarak eklenir.`
                  : `Ücret "Faiz ve Masraflar" gideri olarak eklenir. Tek çekim avansın faizini ekstrede çıkınca girin.`}
              </p>
            </div>
          )}
          {cardInfo && (
            <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
              {cardInfo}
            </p>
          )}

          {type === "income" && (
            <div>
              <label className="label" htmlFor="tx-budget-month">
                Hangi ayın geliri
              </label>
              <select
                id="tx-budget-month"
                className="input capitalize"
                value={budgetMonth}
                onChange={(e) => setBudgetMonth(e.target.value)}
              >
                <option value="">Otomatik ({date ? monthLabel(date.slice(0, 7)) : "işlem tarihinin ayı"})</option>
                {budgetMonthOptions.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-zinc-500">Bütçede hangi aya sayılacağı (ör. 1 Kasım'da yatan Ekim geliri için Ekim).</p>
            </div>
          )}

          {error && (
            <p
              id="tx-error"
              role="alert"
              className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300"
            >
              {error}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}

function FxFields(props: {
  idPrefix: string;
  label: string;
  code: string;
  qty: string;
  onQty(v: string): void;
  rate: string;
  onRate(v: string): void;
  placeholder?: string;
  invalid(field: string): string;
  autoFocus?: boolean;
}) {
  const { idPrefix, label, code, qty, onQty, rate, onRate, placeholder, invalid, autoFocus } = props;
  const unit = unitOf(code) === "currency" ? code : unitOf(code) === "gram" ? "gram" : "adet";
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="label" htmlFor={`${idPrefix}-qty`}>
          {label} ({unit})
        </label>
        <input
          id={`${idPrefix}-qty`}
          data-autofocus={autoFocus || undefined}
          className={`input tabular-nums ${invalid(`${idPrefix}-qty`)}`}
          inputMode="decimal"
          autoComplete="off"
          placeholder={placeholder ?? "0"}
          value={qty}
          onChange={(e) => onQty(e.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor={`${idPrefix}-rate`}>
          Kur (1 {unit} = ₺)
        </label>
        <input
          id={`${idPrefix}-rate`}
          className={`input tabular-nums ${invalid(`${idPrefix}-rate`)}`}
          inputMode="decimal"
          autoComplete="off"
          value={rate}
          onChange={(e) => onRate(e.target.value)}
        />
      </div>
    </div>
  );
}
