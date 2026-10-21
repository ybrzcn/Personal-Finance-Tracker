import { Check, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api";
import { amountToInput, formatDate, parseAmount, parseQuantity, todayISO } from "../lib/format";
import { fundCode, fundUnit, GROUP_LABEL, INSTRUMENTS, isForeign, isFund, qtyDecimals, qtyRule, TRY, unitLabel, type FxGroup } from "../lib/fx";
import { DEFAULT_LOAN_TAX } from "../lib/loans";
import { ACCOUNT_KIND_LABEL, type Account, type AccountDraft, type AccountInput, type AccountKind, type FundHit } from "../lib/types";
import { useData } from "../state/data";
import { useFormPreview } from "../state/formPreview";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";
import { MoneyInput, Term, TERMS } from "./common";
import { PALETTE } from "./CategoryForm";
import { Modal } from "./Modal";

interface Props {
  account?: Account;
  onClose(): void;
  onSaved(message: string): void;
}

/** Formdaki tür: "fund" veride bank + FON:XXX birimidir */
type FormKind = AccountKind | "fund";
const KINDS: FormKind[] = ["bank", "credit_card", "loan", "cash", "fund"];
const KIND_LABEL: Record<FormKind, string> = { ...ACCOUNT_KIND_LABEL, fund: "Yatırım fonu" };
const percentInput = (n: number | null) => (n === null ? "" : String(n).replace(".", ","));
const isDay = (n: number) => Number.isInteger(n) && n >= 1 && n <= 31;

const OPENING_LABEL: Record<FormKind, string> = {
  fund: "Pay adedi",
  bank: "Açılış bakiyesi",
  cash: "Açılış bakiyesi",
  credit_card: "Açılış borcu",
  loan: "Kalan anapara",
};

export function AccountForm({ account, onClose, onSaved }: Props) {
  const { accounts, recurring, addAccount, updateAccount, deleteAccount } = useData();
  const { formatMoney } = useSettings();
  const { confirm } = useUI();
  const incomes = recurring.filter((r) => r.type === "income");

  const [name, setName] = useState(account?.name ?? "");
  const [formKind, setFormKind] = useState<FormKind>(account && isFund(account.currency) ? "fund" : (account?.kind ?? "bank"));
  const kind: AccountKind = formKind === "fund" ? "bank" : formKind;
  const fund = formKind === "fund";
  const [fundQuery, setFundQuery] = useState(account && isFund(account.currency) ? (fundCode(account.currency) ?? "") : "");
  const [fundHits, setFundHits] = useState<FundHit[]>([]);
  const [fundPick, setFundPick] = useState<FundHit | null>(null);
  const [fundError, setFundError] = useState<string | null>(null);
  const [color, setColor] = useState(account?.color ?? PALETTE[accounts.length % PALETTE.length]);
  const [opening, setOpening] = useState(
    account && account.openingBalance !== 0
      ? isForeign(account.currency)
        ? String(account.openingBalance).replace(".", ",")
        : amountToInput(account.openingBalance)
      : "",
  );
  // Fon hesabı başka türe çevrilirse birimi TL'den başlar
  const [currency, setCurrency] = useState(account && !isFund(account.currency) ? account.currency : TRY);
  const [openingCost, setOpeningCost] = useState(account?.openingCost != null ? amountToInput(account.openingCost) : "");
  const [openingDate, setOpeningDate] = useState(account?.openingDate ?? todayISO());
  const [limit, setLimit] = useState(account?.creditLimit != null ? amountToInput(account.creditLimit) : "");
  const [rate, setRate] = useState(percentInput(account?.interestRate ?? null));
  const [statementDay, setStatementDay] = useState(account?.statementDay ? String(account.statementDay) : "");
  const [dueDay, setDueDay] = useState(account?.dueDay ? String(account.dueDay) : "");
  const [minRate, setMinRate] = useState(percentInput(account?.minPaymentRate ?? 20));
  const [term, setTerm] = useState(account?.termMonths ? String(account.termMonths) : "");
  const [firstDue, setFirstDue] = useState(account?.firstDueDate ?? "");
  const [installment, setInstallment] = useState(account?.installmentAmount != null ? amountToInput(account.installmentAmount) : "");
  const [taxRate, setTaxRate] = useState(percentInput(account?.taxRate ?? DEFAULT_LOAN_TAX));
  const [fundingIncomeId, setFundingIncomeId] = useState(account?.fundingIncomeId ?? "");
  // Yeni kartta: son kesilen ekstre ödendi mi? (takip başlangıcını belirler)
  const [lastPaid, setLastPaid] = useState<boolean | null>(null);
  const [sortOrder, setSortOrder] = useState(String(account?.sortOrder ?? accounts.length));
  const [archived, setArchived] = useState(account?.archived ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const card = kind === "credit_card";
  const cash = kind === "cash";
  const loan = kind === "loan";
  // Fon hesabının fonu değiştirilemez; başka türden çevrilen hesapta fon seçilir
  const fundLocked = !!account && isFund(account.currency);
  const unitCode = fund ? (fundLocked ? account.currency : fundPick ? fundUnit(fundPick.code) : "") : currency;
  const foreign = fund || (isForeign(currency) && (kind === "bank" || kind === "cash"));
  // Açılış maliyeti yalnız açılış bakiyesi varken anlamlı
  const openingPositive = foreign && (parseQuantity(opening, qtyDecimals(unitCode || currency)) ?? 0) > 0;

  // Fon arama (Rust'ta): yazdıkça, 300 ms gecikmeli
  useEffect(() => {
    if (!fund || fundLocked) return;
    const q = fundQuery.trim();
    // Fon kodları Latin harfli: "i" → "I" (toLocaleUpperCase("tr") "İ" yapar)
    if (q.length < 2 || fundPick?.code === q.toUpperCase()) {
      setFundHits([]);
      setFundError(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .fundsSearch(q)
        .then((h) => {
          if (!live) return;
          setFundHits(h);
          setFundError(h.length ? null : "TEFAS'ta bu kodla fon bulunamadı.");
        })
        .catch((e) => live && setFundError(errorMessage(e)));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [fund, fundLocked, fundQuery, fundPick]);
  const sd = Number(statementDay);
  const dd = Number(dueDay);
  // Önizleme hesapları Rust'ta (finans-core::forms): kart kesim/son ödeme, kredi taksit önerisi, işlem kaydı var mı
  const loanDraft = (() => {
    if (!loan) return null;
    const p = parseAmount(opening);
    const n = Number.parseInt(term, 10);
    const r = parseAmount(rate);
    if (!p || p <= 0 || !n || n < 1 || r === null) return null;
    return { principal: p, term: n, ratePct: r, taxPct: parseAmount(taxRate) };
  })();
  const draft: AccountDraft = {
    accountId: account?.id ?? null,
    statementDay: card && isDay(sd) && isDay(dd) ? sd : null,
    dueDay: card && isDay(sd) && isDay(dd) ? dd : null,
    loan: loanDraft,
  };
  const { preview: calc, latest } = useFormPreview(draft, api.previewAccount);
  // Önizleme gelene (ya da alınamazsa) kadar düzenlenen hesap işlemli sayılır: Sil ve tür/birim seçimi açılıp kapanmasın.
  const used = calc?.used ?? !!account;
  const preview =
    card && calc?.nextClosing && calc.nextDue ? `Sonraki kesim ${formatDate(calc.nextClosing)} → son ödeme ${formatDate(calc.nextDue)}` : null;

  // Yeni kart: son kesim ve son ödemesi; ödendiyse takip sonraki dönemden, ödenmediyse o ekstreden başlar
  const lastStatement = card ? (calc?.lastStatement ?? null) : null;
  const paid = lastPaid ?? lastStatement?.defaultPaid ?? true;

  // Taksit tutarı boşsa anüite formülüyle hesaplanan öneri
  const suggestedInstallment = loan && calc?.suggestedInstallmentCents != null ? calc.suggestedInstallmentCents / 100 : null;

  const optional = (s: string, label: string): number | null => {
    if (!s.trim()) return null;
    const v = parseAmount(s);
    if (v === null || v < 0) throw `Geçerli bir ${label} girin.`;
    return v;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let input: AccountInput;
    // Yeni kartın takip başlangıcı son girdinin hesabından (Rust)
    let newCardOpening: string | null = null;
    if (card && !account && isDay(sd) && isDay(dd)) {
      try {
        const last = (await latest(draft)).lastStatement;
        if (last) newCardOpening = (lastPaid ?? last.defaultPaid) ? last.openingIfPaid : last.openingIfUnpaid;
      } catch (err) {
        return setError(`Hesap yapılamadı: ${errorMessage(err)}`);
      }
    }
    try {
      if (fund && !unitCode) throw "Listeden bir fon seçin (TEFAS'ta bu kodla fon bulunamadı).";
      const openingValue = opening.trim() ? (foreign ? parseQuantity(opening, qtyDecimals(unitCode || currency)) : parseAmount(opening)) : 0;
      if (openingValue === null)
        throw `Geçerli bir ${OPENING_LABEL[formKind].toLocaleLowerCase("tr")} girin${foreign ? ` (${qtyRule(unitCode || currency)})` : ""}.`;
      if (card && (!isDay(sd) || !isDay(dd))) throw "Kesim ve son ödeme günü 1 ile 31 arasında olmalıdır.";
      const termValue = Number.parseInt(term, 10);
      if (loan && (!termValue || termValue < 1)) throw "Kalan vade (ay) girin.";
      if (loan && !firstDue) throw "Sonraki taksit tarihini girin.";
      const costValue = openingPositive && openingCost.trim() ? parseAmount(openingCost) : null;
      if (openingPositive && openingCost.trim() && (costValue === null || costValue <= 0)) throw "Geçerli bir açılış maliyeti girin.";
      input = {
        name,
        kind,
        color,
        // Düzenlemede formda olmayan kart açılış borcu korunur
        openingBalance: card ? (account?.kind === "credit_card" ? account.openingBalance : 0) : openingValue,
        openingDate: newCardOpening ?? openingDate,
        creditLimit: cash || loan ? null : optional(limit, "limit"),
        interestRate: cash ? null : optional(rate, "faiz oranı"),
        statementDay: card ? sd : null,
        dueDay: card ? dd : null,
        minPaymentRate: card ? (optional(minRate, "asgari ödeme oranı") ?? 20) : null,
        sortOrder: Number.parseInt(sortOrder, 10) || 0,
        archived,
        termMonths: loan ? termValue : null,
        firstDueDate: loan ? firstDue : null,
        installmentAmount: loan ? optional(installment, "taksit tutarı") : null,
        taxRate: loan ? (optional(taxRate, "vergi oranı") ?? DEFAULT_LOAN_TAX) : null,
        fundingIncomeId: (card || loan) && fundingIncomeId ? fundingIncomeId : null,
        openingPeriodSpending: account?.openingPeriodSpending ?? null,
        openingInstallments: account?.openingInstallments ?? [],
        currency: fund ? unitCode : foreign ? currency : TRY,
        openingCost: openingPositive ? costValue : null,
      };
    } catch (err) {
      return setError(errorMessage(err));
    }
    setSaving(true);
    try {
      if (account) {
        await updateAccount({ ...input, id: account.id });
        onSaved("Hesap güncellendi.");
      } else {
        await addAccount(input);
        onSaved("Hesap eklendi.");
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!account) return;
    const ok = await confirm({
      title: "Hesabı sil",
      message: (
        <>
          <strong>{account.name}</strong> hesabı kalıcı olarak silinecek.
        </>
      ),
      confirmLabel: "Sil",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteAccount(account.id);
      onSaved("Hesap silindi.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      title={account ? "Hesabı Düzenle" : "Yeni Hesap"}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          {account && !used && (
            <button type="button" className="btn-ghost mr-auto text-rose-600" onClick={remove}>
              <Trash2 size={15} /> Sil
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            Vazgeç
          </button>
          <button type="submit" form="account-form" className="btn-primary" disabled={saving}>
            {account ? "Kaydet" : "Ekle"}
          </button>
        </>
      }
    >
      <form id="account-form" onSubmit={submit} className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        <div>
          <label className="label" htmlFor="acc-name">
            Ad
          </label>
          <input
            id="acc-name"
            data-autofocus
            className="input"
            maxLength={60}
            placeholder={loan ? "Örn. İhtiyaç Kredisi" : "Örn. Kredi Kartım"}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <span className="label">Tür</span>
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-zinc-100 p-1 sm:grid-cols-5 dark:bg-zinc-800/70">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                disabled={used && k !== formKind}
                onClick={() => {
                  setFormKind(k);
                  // Kart ve kredi yalnız TL
                  if (k === "credit_card" || k === "loan") setCurrency(TRY);
                }}
                className={`rounded-lg py-1.5 text-sm font-medium transition disabled:opacity-40 ${
                  formKind === k ? "bg-white shadow-sm dark:bg-zinc-900" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          {used && <p className="mt-1 text-xs text-zinc-500">İşlemi olan hesabın türü değiştirilemez.</p>}
        </div>

        {!fund && (kind === "bank" || kind === "cash") && (
          <div>
            <label className="label" htmlFor="acc-currency">
              Para birimi
            </label>
            <select id="acc-currency" className="input" value={currency} disabled={used} onChange={(e) => setCurrency(e.target.value)}>
              <option value={TRY}>Türk lirası (TL)</option>
              {(["doviz", "altin", "maden"] as FxGroup[]).map((g) => (
                <optgroup key={g} label={GROUP_LABEL[g]}>
                  {INSTRUMENTS.filter((i) => i.group === g).map((i) => (
                    <option key={i.code} value={i.code}>
                      {i.name}
                      {i.unit === "currency" ? ` (${i.code})` : i.unit === "gram" ? " (gram)" : " (adet)"}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {used && <p className="mt-1 text-xs text-zinc-500">İşlemi olan hesabın para birimi değiştirilemez.</p>}
          </div>
        )}

        {fund && (
          <div className="relative">
            <label className="label" htmlFor="acc-fund">
              Fon
            </label>
            <input
              id="acc-fund"
              className="input uppercase"
              placeholder="Kod ya da ad (ör. AFT)"
              autoComplete="off"
              disabled={fundLocked}
              value={fundQuery}
              role="combobox"
              aria-expanded={fundHits.length > 0}
              aria-controls="acc-fund-list"
              onChange={(e) => {
                setFundQuery(e.target.value);
                setFundPick(null);
              }}
            />
            {fundHits.length > 0 && (
              <ul
                id="acc-fund-list"
                role="listbox"
                className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-zinc-200 bg-white text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
              >
                {fundHits.map((h) => (
                  <li
                    key={h.code}
                    role="option"
                    aria-selected={false}
                    className="cursor-pointer px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                    onClick={() => {
                      setFundPick(h);
                      setFundQuery(h.code);
                      setFundHits([]);
                      setFundError(null);
                      if (!name.trim()) setName(`${h.code} · ${h.name}`.slice(0, 60));
                    }}
                  >
                    <span className="font-medium">{h.code}</span> <span className="text-zinc-500">{h.name}</span>
                    <span className="block text-xs text-zinc-400">
                      {h.kindLabel} · {h.price.toLocaleString("tr-TR", { maximumFractionDigits: 6 })} ₺ ({h.date})
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {fundPick && (
              <p className="mt-1 text-xs text-zinc-500">
                {fundPick.name} · {fundPick.kindLabel}
              </p>
            )}
            {fundError && !fundPick && <p className="mt-1 text-xs text-amber-600">{fundError}</p>}
            {fundLocked && <p className="mt-1 text-xs text-zinc-500">Fon hesabının fonu değiştirilemez.</p>}
          </div>
        )}

        {!card && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="acc-opening">
                {OPENING_LABEL[formKind]}
              </label>
              {foreign ? (
                <div className="relative">
                  <input
                    id="acc-opening"
                    className="input pr-14 tabular-nums"
                    inputMode="decimal"
                    placeholder="0"
                    value={opening}
                    onChange={(e) => setOpening(e.target.value)}
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-zinc-400">
                    {unitLabel(unitCode || currency)}
                  </span>
                </div>
              ) : (
                <MoneyInput id="acc-opening" placeholder="0,00" value={opening} onValueChange={setOpening} />
              )}
              {kind === "bank" && !foreign && (
                <p className="mt-1 text-xs text-zinc-500">
                  Eksi değer = <Term hint={TERMS.KMH}>KMH</Term> kullanımı
                </p>
              )}
            </div>
            <div>
              <label className="label" htmlFor="acc-opening-date">
                {card || loan ? "Borç tarihi" : "Bakiye tarihi"}
              </label>
              <input
                id="acc-opening-date"
                type="date"
                className="input"
                value={openingDate}
                onChange={(e) => setOpeningDate(e.target.value)}
              />
            </div>
          </div>
        )}

        {openingPositive && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="acc-opening-cost">
                Açılış maliyeti (TL)
              </label>
              <MoneyInput id="acc-opening-cost" placeholder="İsteğe bağlı" value={openingCost} onValueChange={setOpeningCost} />
            </div>
            <p className="self-end pb-2 text-xs text-zinc-500">
              {fund ? "Kâr/zarar için. Boşsa açılış günündeki fon fiyatı kullanılır." : "Kâr/zarar için. Boşsa açılış günündeki kur kullanılır."}
            </p>
          </div>
        )}

        {!cash && !foreign && (
          <div className="grid grid-cols-2 gap-3">
            {!loan && (
              <div>
                <label className="label" htmlFor="acc-limit">
                  {card ? (
                    "Kart limiti"
                  ) : (
                    <>
                      <Term hint={TERMS.KMH}>KMH</Term> limiti (varsa)
                    </>
                  )}
                </label>
                <MoneyInput id="acc-limit" placeholder="0,00" value={limit} onValueChange={setLimit} />
              </div>
            )}
            <div>
              <label className="label" htmlFor="acc-rate">
                Aylık <Term hint={TERMS.akdi}>akdi faiz</Term> (%)
              </label>
              <input
                id="acc-rate"
                className="input tabular-nums"
                inputMode="decimal"
                placeholder="Örn. 4,25"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>
            {loan && (
              <div>
                <label className="label" htmlFor="acc-tax">
                  KKDF + BSMV (%)
                </label>
                <input
                  id="acc-tax"
                  className="input tabular-nums"
                  inputMode="decimal"
                  value={taxRate}
                  onChange={(e) => setTaxRate(e.target.value)}
                />
              </div>
            )}
          </div>
        )}

        {loan && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label" htmlFor="acc-term">
                  Kalan vade (ay)
                </label>
                <input
                  id="acc-term"
                  type="number"
                  min={1}
                  max={600}
                  className="input"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="acc-first-due">
                  Sonraki taksit
                </label>
                <input id="acc-first-due" type="date" className="input" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="acc-installment">
                  Taksit tutarı
                </label>
                <input
                  id="acc-installment"
                  className="input tabular-nums"
                  inputMode="decimal"
                  placeholder={suggestedInstallment ? amountToInput(suggestedInstallment) : "Otomatik"}
                  value={installment}
                  onChange={(e) => setInstallment(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-zinc-500">
              Taksit tutarını boş bırakırsanız faiz ve vergiyle hesaplanır
              {suggestedInstallment ? ` (${formatMoney(suggestedInstallment)})` : ""}. Bankanın ödeme planındaki tutarı girmek en
              doğrusudur.
            </p>
          </>
        )}

        {card && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label" htmlFor="acc-sd">
                  Kesim günü
                </label>
                <input
                  id="acc-sd"
                  type="number"
                  min={1}
                  max={31}
                  className="input"
                  value={statementDay}
                  onChange={(e) => setStatementDay(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="acc-dd">
                  Son ödeme günü
                </label>
                <input
                  id="acc-dd"
                  type="number"
                  min={1}
                  max={31}
                  className="input"
                  value={dueDay}
                  onChange={(e) => setDueDay(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="acc-min">
                  Asgari ödeme (%)
                </label>
                <input
                  id="acc-min"
                  className="input tabular-nums"
                  inputMode="decimal"
                  value={minRate}
                  onChange={(e) => setMinRate(e.target.value)}
                />
              </div>
            </div>
            {preview && (
              <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                {preview}
              </p>
            )}
            {account && (
              <p className="text-xs text-zinc-500">
                Kesim veya son ödeme günü değişirse geçmiş ekstreler yeni günlere göre yeniden hesaplanır.
              </p>
            )}
          </>
        )}

        {card && !account && lastStatement && (
          <section className="space-y-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <span className="label mb-0">
              Son ekstre ({formatDate(lastStatement.last)} kesimli, son ödeme {formatDate(lastStatement.due)}) ödendi mi?
            </span>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800/70">
              {[true, false].map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  onClick={() => setLastPaid(v)}
                  className={`rounded-lg py-1.5 text-sm font-medium transition ${
                    paid === v ? "bg-white shadow-sm dark:bg-zinc-900" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                  }`}
                >
                  {v ? "Ödendi" : "Ödenmedi"}
                </button>
              ))}
            </div>
            <p className="text-xs text-zinc-500">
              {paid
                ? `Takip ${formatDate(lastStatement.openingIfPaid)} tarihinden başlar; önceki ekstreler ödenmiş sayılır.`
                : `Takip ${formatDate(lastStatement.last)} ekstresinden başlar; o ekstreye düşen harcama ve taksitleri de girin.`}{" "}
              Kartı ekledikten sonra harcamaları girin; eski taksitli alışverişleri alış tarihi ve toplam taksit sayısıyla girerseniz
              ödenmiş taksitler otomatik düşülür.
            </p>
          </section>
        )}
        {card && account && (
          <div>
            <label className="label" htmlFor="acc-opening-date">
              Takip başlangıcı
            </label>
            <input
              id="acc-opening-date"
              type="date"
              className="input"
              value={openingDate}
              onChange={(e) => setOpeningDate(e.target.value)}
            />
            <p className="mt-1 text-xs text-zinc-500">Bu tarihten önce kesilen ekstreler ödenmiş sayılır.</p>
          </div>
        )}

        {(card || loan) && (
          <div>
            <label className="label" htmlFor="acc-funding">
              Hangi gelirden ödenecek
            </label>
            <select id="acc-funding" className="input" value={fundingIncomeId} onChange={(e) => setFundingIncomeId(e.target.value)}>
              <option value="">Otomatik (son ödemeden önceki son gelir)</option>
              {incomes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · her ayın {r.day}'i
                </option>
              ))}
            </select>
            {incomes.length === 0 && (
              <p className="mt-1 text-xs text-zinc-500">Bütçe sayfasından maaş gibi düzenli gelir ekleyebilirsiniz.</p>
            )}
          </div>
        )}

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
                style={{ backgroundColor: c, boxShadow: color === c ? `0 0 0 2px var(--surface), 0 0 0 4px ${c}` : undefined }}
              >
                {color === c && <Check size={14} className="text-white" strokeWidth={3} />}
              </button>
            ))}
          </div>
        </div>

        {account && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Arşivle (yeni işlemlerde gösterme)
          </label>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-zinc-600 dark:text-zinc-300">Gelişmiş</summary>
          <div className="mt-2 max-w-[12rem]">
            <label className="label" htmlFor="acc-order">
              Sıra
            </label>
            <input id="acc-order" type="number" className="input" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
            <p className="mt-1 text-xs text-zinc-500">
              Hesap listelerindeki sıra; Borç Planı'nda "Benim sıramla" stratejisinin ödeme önceliği.
            </p>
          </div>
        </details>

        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
