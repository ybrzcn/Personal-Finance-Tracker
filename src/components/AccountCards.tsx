import { AlertTriangle, Banknote, CalendarClock, CreditCard, FileUp, HandCoins, Landmark, List, Pencil, Plus, TrendingUp, Wallet } from "lucide-react";
import { useState, type ReactNode } from "react";
import { formatQty, formatRate, isForeign, isFund } from "../lib/fx";
import { errorMessage } from "../lib/api";
import { formatDate, formatDateShort, parseAmount, todayISO } from "../lib/format";
import { ACCOUNT_KIND_LABEL, SUBTYPE_LABEL, type Account, type AmountHintCents, type BankSummary, type CardStatement, type CardStatementStatus } from "../lib/types";
import { useData } from "../state/data";
import { useAccountReport } from "../state/accountsReport";
import { usePnlSummary } from "../state/pnl";
import { useRates } from "../state/rates";
import { useSettings } from "../state/settings";
import { useUI, type AmountHint } from "../state/ui";
import { MoneyInput, Term, TERMS } from "./common";
import { locale, t } from "../lib/i18n";

const STATUS: Record<CardStatementStatus, { label: string; cls: string }> = {
  none: { label: t("Borç yok"), cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
  paid: { label: t("Ödendi"), cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400" },
  minPaid: { label: t("Asgari ödendi"), cls: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400" },
  pending: { label: t("Bekliyor"), cls: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400" },
  overdue: { label: t("Gecikti"), cls: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400" },
};

export function StatusBadge({ status }: { status: CardStatementStatus }) {
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[status].cls}`}>
      {STATUS[status].label}
    </span>
  );
}

/** Rust'ın gün sayısından (son ödemeye kalan) metin */
export function dueText(d: number): string {
  if (d === 0) return t("Bugün");
  return d > 0 ? t("{n} gün kaldı", { n: d }) : t("{n} gün gecikti", { n: -d });
}

/** Rapordaki kart ödeme ipuçları → ödeme formunun hazır tutarları (TL). */
export const toHints = (hints: AmountHintCents[]): AmountHint[] => hints.map((h) => ({ label: h.label, amount: h.amountCents / 100 }));

function IconAction({ title, icon, onClick, active }: { title: string; icon: ReactNode; onClick(): void; active?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={`icon-btn ${active ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100" : ""}`}
    >
      {icon}
    </button>
  );
}

function UsageBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  const tone = pct >= 90 ? "bg-rose-500" : pct >= 70 ? "bg-amber-500" : "bg-indigo-500";
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="shrink-0 whitespace-nowrap text-zinc-500">{label}</span>
      <span className="min-w-0 truncate text-right font-medium tabular-nums">{children}</span>
    </div>
  );
}

function CardShell({ account, icon, children, footer }: { account: Account; icon: ReactNode; children: ReactNode; footer: ReactNode }) {
  const { openAccountForm } = useUI();
  return (
    <section className={`card flex flex-col p-5 ${account.archived ? "opacity-60" : ""}`}>
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl" style={{ backgroundColor: `${account.color}22`, color: account.color }}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{account.name}</div>
          <div className="text-xs text-zinc-500">
            {isFund(account.currency) ? t("Yatırım fonu") : account.subtype ? SUBTYPE_LABEL[account.subtype] : ACCOUNT_KIND_LABEL[account.kind]}
            {account.archived && ` · ${t("Arşivlendi")}`}
          </div>
        </div>
        <button className="icon-btn" title={t("Düzenle")} aria-label={t("Düzenle")} onClick={() => openAccountForm(account)}>
          <Pencil size={15} />
        </button>
      </div>
      <div className="flex-1 space-y-3">{children}</div>
      <div className="mt-4 flex flex-wrap items-center gap-1 border-t border-zinc-100 pt-3 dark:border-zinc-800">{footer}</div>
    </section>
  );
}

const rate = (r: number) => t("%{v}", { v: r.toLocaleString(locale) });

/** Fon hesabı: değer ve kâr/zarar Rust'taki rapordan (kartta hesap yok). */
export function FundAccountCard({ account }: { account: Account }) {
  const { formatMoney } = useSettings();
  const { showAccountTransactions } = useUI();
  const { byAccount, error } = usePnlSummary();
  const p = byAccount.get(account.id);
  return (
    <CardShell
      account={account}
      icon={<TrendingUp size={18} />}
      footer={
        <>
          <span className="ml-auto" />
          <IconAction title={t("İşlemler")} onClick={() => showAccountTransactions(account.id)} icon={<List size={16} />} />
        </>
      }
    >
      <div>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">{p ? formatQty(p.qty, account.currency) : "—"}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500 tabular-nums">
          {p && p.valueCents !== null && p.rateMicros !== null ? (
            <>
              ≈ {formatMoney(p.valueCents / 100)} · {t("fiyat {rate}", { rate: formatRate(p.rateMicros / 1_000_000) })}
              {p.rateObservedAt && ` · ${formatDateShort(p.rateObservedAt.slice(0, 10))}`}
              {p.rateStale && (
                <span title={t("Fiyat eski: TEFAS'a ulaşılamıyor olabilir")} className="text-amber-600 dark:text-amber-400">
                  <AlertTriangle size={12} />
                </span>
              )}
            </>
          ) : (
            (error ?? t("TL karşılığı: — (fiyat alınamadı)"))
          )}
        </div>
        {p && p.qtyMinor > 0 && p.unrealizedCents !== null && (
          <div className={`mt-0.5 text-xs tabular-nums ${p.unrealizedCents >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
            {t("k/z")} {p.unrealizedCents > 0 ? "+" : ""}
            {formatMoney(p.unrealizedCents / 100)}
            {p.unrealizedBp !== null && ` (${t("%{v}", { v: (p.unrealizedBp / 100).toLocaleString(locale, { maximumFractionDigits: 1 }) })})`}
          </div>
        )}
      </div>
    </CardShell>
  );
}

export function BankAccountCard({ account }: { account: Account }) {
  const { formatMoney } = useSettings();
  const { showAccountTransactions, openStatementImport } = useUI();
  const { r, placeholder } = useAccountReport(account.id);
  const s = r?.bank ?? null;
  const limit = account.creditLimit;
  const { rates } = useRates();
  const foreign = isForeign(account.currency);
  const native = r?.fx?.qty ?? null;
  const quote = foreign ? rates.get(account.currency) : undefined;
  const { byAccount } = usePnlSummary();
  const pnl = foreign ? byAccount.get(account.id) : undefined;
  const valueCents = r?.fx?.valueCents ?? null;
  return (
    <CardShell
      account={account}
      icon={account.kind === "cash" ? <Wallet size={18} /> : <Landmark size={18} />}
      footer={
        <>
          <span className="ml-auto" />
          <IconAction title={t("İşlemler")} onClick={() => showAccountTransactions(account.id)} icon={<List size={16} />} />
          {!foreign && !account.subtype && (
            <IconAction title={t("Ekstre yükle (Excel, PDF, CSV)")} onClick={() => openStatementImport(account.id)} icon={<FileUp size={16} />} />
          )}
        </>
      }
    >
      {foreign ? (
        <div>
          <div className={`text-2xl font-semibold tracking-tight tabular-nums ${native !== null && native < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>
            {native === null ? placeholder : formatQty(native, account.currency)}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500 tabular-nums">
            {r === null ? (
              t("TL karşılığı: {value}", { value: placeholder })
            ) : quote && valueCents !== null ? (
              <>
                ≈ {formatMoney(valueCents / 100)} · {t("alış {rate}", { rate: formatRate(quote.buy) })} ·{" "}
                {new Date(quote.observedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
                {quote.stale && (
                  <span title={t("Kur eski: kaynağa ulaşılamıyor olabilir")} className="text-amber-600 dark:text-amber-400">
                    <AlertTriangle size={12} />
                  </span>
                )}
              </>
            ) : (
              t("TL karşılığı: — (kur alınamadı)")
            )}
          </div>
          {pnl && pnl.qtyMinor > 0 && pnl.unrealizedCents !== null && (
            <div className={`mt-0.5 text-xs tabular-nums ${pnl.unrealizedCents >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
              {t("k/z")} {pnl.unrealizedCents > 0 ? "+" : ""}
              {formatMoney(pnl.unrealizedCents / 100)}
              {pnl.unrealizedBp !== null && ` (${t("%{v}", { v: (pnl.unrealizedBp / 100).toLocaleString(locale, { maximumFractionDigits: 1 }) })})`}
            </div>
          )}
        </div>
      ) : account.subtype === "pension" || account.subtype === "asset" ? (
        <ValuationBlock account={account} s={s} placeholder={placeholder} />
      ) : (
        <div className={`text-2xl font-semibold tracking-tight tabular-nums ${s !== null && s.balanceCents < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>
          {s ? formatMoney(s.balanceCents / 100) : placeholder}
        </div>
      )}
      {account.subtype === "deposit" && <DepositBlock account={account} s={s} placeholder={placeholder} />}
      {account.kind === "cash" && (foreign ? native !== null && native < 0 : s !== null && s.balanceCents < 0) && (
        <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          {t("Nakit eksiye düşemez; bir gider fazla ya da yanlış hesaba girilmiş olabilir.")}
        </p>
      )}
      {account.kind === "bank" && !foreign && limit !== null && limit > 0 && (
        <>
          <UsageBar used={(s?.overdraftUsedCents ?? 0) / 100} limit={limit} />
          <Row label={<Term hint={TERMS.KMH}>{t("KMH kullanımı")}</Term>}>
            {s ? formatMoney(s.overdraftUsedCents / 100) : placeholder} / {formatMoney(limit)}
          </Row>
          {s?.availableCents != null && <Row label={t("Kullanılabilir")}>{formatMoney(s.availableCents / 100)}</Row>}
        </>
      )}
      {account.kind === "bank" && !foreign && account.interestRate !== null && <Row label={<Term hint={TERMS.KMH}>{t("Aylık KMH faizi")}</Term>}>{rate(account.interestRate)}</Row>}
    </CardShell>
  );
}

/** Vadeli mevduat: dönem, işleyen ve vade sonu net faiz (Rust); vade dolunca faiz kaydı ve yenileme */
function DepositBlock({ account, s, placeholder }: { account: Account; s: BankSummary | null; placeholder: string }) {
  const { formatMoney } = useSettings();
  const { depositMature } = useData();
  const { toast } = useUI();
  const [busy, setBusy] = useState(false);
  const terms = account.details?.deposit;
  const d = s?.deposit ?? null;
  if (!terms) return null;
  const money = (c: number | undefined) => (c === undefined ? placeholder : formatMoney(c / 100));
  const mature = async (renew: boolean) => {
    setBusy(true);
    try {
      await depositMature(account.id, renew);
      toast(renew ? t("Faiz kaydedildi, mevduat yenilendi.") : t("Faiz kaydedildi, hesap vadesize çevrildi."));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row label={t("Vade")}>
        {formatDate(terms.maturity)}
        {d && <span className="ml-1 text-xs text-zinc-500">{d.matured ? `· ${t("doldu")}` : `· ${t("{n} gün", { n: d.daysLeft })}`}</span>}
      </Row>
      <Row label={t("Faiz")}>
        {t("%{rate} brüt · %{tax} stopaj", { rate: terms.rate.toLocaleString(locale), tax: terms.taxRate.toLocaleString(locale) })}
      </Row>
      <Row label={t("İşleyen net faiz")}>{money(d?.accruedNetCents)}</Row>
      <Row label={t("Vade sonu")}>
        {money(d?.maturityValueCents)} <span className="text-xs text-emerald-600 dark:text-emerald-400">(+{money(d?.netCents)})</span>
      </Row>
      {d?.matured && !account.archived && (
        <div className="flex flex-wrap gap-2 pt-1">
          <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy} onClick={() => void mature(true)}>
            {t("Faizi kaydet, yenile")}
          </button>
          <button className="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onClick={() => void mature(false)}>
            {t("Faizi kaydet, vadesize çevir")}
          </button>
        </div>
      )}
    </>
  );
}

/** BES ve diğer varlık: son elle değerleme ve katkılara / alış bedeline göre fark; yeni değer girişi */
function ValuationBlock({ account, s, placeholder }: { account: Account; s: BankSummary | null; placeholder: string }) {
  const { formatMoney } = useSettings();
  const { updateAccount } = useData();
  const { toast } = useUI();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [date, setDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const v = s?.valuation ?? null;
  const save = async () => {
    const n = parseAmount(value);
    if (n === null || n < 0) return toast(t("Geçerli bir değer girin."), "error");
    setBusy(true);
    try {
      const valuations = [...(account.details?.valuations ?? []).filter((x) => x.date !== date), { date, value: n }];
      await updateAccount({ ...account, details: { valuations } });
      setOpen(false);
      setValue("");
      toast(t("Değer kaydedildi."));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const base = account.subtype === "pension" ? t("Katkılar") : t("Alış bedeli");
  return (
    <div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{s ? formatMoney((v ? v.valueCents : s.balanceCents) / 100) : placeholder}</div>
      <div className="mt-0.5 text-xs text-zinc-500 tabular-nums">
        {v ? (
          <>
            {t("{date} değeri", { date: formatDateShort(v.date) })} · {base.toLocaleLowerCase(locale)} {s ? formatMoney(s.balanceCents / 100) : placeholder} ·{" "}
            <span className={v.gainCents >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
              {v.gainCents > 0 ? "+" : ""}
              {formatMoney(v.gainCents / 100)}
            </span>
          </>
        ) : (
          t("{base}; güncel değer girilmedi", { base })
        )}
      </div>
      {open ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <MoneyInput aria-label={t("Güncel değer")} placeholder={t("Güncel değer")} value={value} onValueChange={setValue} />
          <input type="date" aria-label={t("Değer tarihi")} className="input" value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy} onClick={() => void save()}>
            {t("Kaydet")}
          </button>
          <button className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setOpen(false)}>
            {t("Vazgeç")}
          </button>
        </div>
      ) : (
        <button className="btn-secondary mt-2 px-3 py-1.5 text-xs" onClick={() => setOpen(true)}>
          {t("Değer gir")}
        </button>
      )}
    </div>
  );
}

export function CreditCardCard({ account }: { account: Account }) {
  const { formatMoney } = useSettings();
  const { openTransactionForm, showAccountTransactions } = useUI();
  const [history, setHistory] = useState(false);
  const { r, placeholder } = useAccountReport(account.id);
  const summary = r?.card ?? null;
  const st = summary?.statements[0] ?? null;
  const hints = summary ? toHints(summary.hints) : [];
  const money = (c: number | null | undefined) => (c == null ? placeholder : formatMoney(c / 100));

  return (
    <CardShell
      account={account}
      icon={<CreditCard size={18} />}
      footer={
        <>
{/* Birincil eylem önce: ödeme (gecikmişse kırmızı); harcama eklemek ikincil */}
          {hints.length > 0 && (
            <button
              className={`${st?.status === "overdue" ? "btn-danger" : "btn-primary"} px-3 py-1.5 text-xs`}
              onClick={() => openTransactionForm(undefined, { type: "transfer", toAccountId: account.id, amount: hints[0].amount }, hints)}
            >
              {t("Ödeme yap")}
            </button>
          )}
          {/* Arşivlenmiş karta yeni harcama eklenemez */}
          {!account.archived && (
            <>
              <button
                className="btn-ghost px-2 py-1.5 text-xs"
                title={t("Bu karta harcama ekle (eski taksitli alışverişler dahil)")}
                onClick={() => openTransactionForm(undefined, { type: "expense", accountId: account.id })}
              >
                <Plus size={14} /> {t("Harcama")}
              </button>
              <button
                className="btn-ghost px-2 py-1.5 text-xs"
                title={t("Bu karttan nakit avans çek (tek çekim veya taksitli)")}
                onClick={() => openTransactionForm(undefined, { type: "expense", accountId: account.id, cashAdvance: true })}
              >
                <Banknote size={14} /> {t("Nakit avans")}
              </button>
            </>
          )}
          <span className="ml-auto" />
          <IconAction title={t("İşlemler")} onClick={() => showAccountTransactions(account.id)} icon={<List size={16} />} />
          <IconAction
            title={history ? t("Ekstre geçmişini gizle") : t("Ekstre geçmişi")}
            active={history}
            onClick={() => setHistory((h) => !h)}
            icon={<CalendarClock size={16} />}
          />
        </>
      }
    >
      <div>
        <div className="text-xs text-zinc-500">{t("Toplam borç")}</div>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">{money(summary?.totalDebtCents)}</div>
      </div>
      {account.creditLimit !== null && account.creditLimit > 0 && (
        <>
          <UsageBar used={(summary?.totalDebtCents ?? 0) / 100} limit={account.creditLimit} />
          {summary?.availableCents != null && <Row label={t("Kullanılabilir limit")}>{money(summary.availableCents)}</Row>}
        </>
      )}
      {st ? (
        <div className="space-y-2 rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/50">
          <div className="flex items-center justify-between gap-2">
            <span className="whitespace-nowrap text-xs font-medium uppercase tracking-wide text-zinc-500">
              {t("Son ekstre")} · {formatDateShort(st.closingDate)}
            </span>
            <StatusBadge status={st.status} />
          </div>
          <Row label={t("Ekstre borcu")}>{money(st.statementCents)}</Row>
          <Row label={t("Son ödeme")}>
            {formatDateShort(st.dueDate)}
            {st.remainingCents > 0 && (
              <span className={`ml-1 text-xs font-normal ${st.status === "overdue" ? "text-rose-600 dark:text-rose-400" : "text-zinc-500"}`}>
                {/* Asgarisi ödenmişse "gecikti" denmez: kalan borç gecikme değil, faize girer */}
                · {st.status === "minPaid" && st.dueInDays < 0 ? t("kalan faize girer") : dueText(st.dueInDays)}
              </span>
            )}
          </Row>
          <Row label={<Term hint={TERMS.asgari}>{t("Asgari ödeme")}</Term>}>{money(st.minPaymentCents)}</Row>
          <Row label={t("Kalan")}>{money(st.remainingCents)}</Row>
        </div>
      ) : summary?.totalDebtCents === 0 ? (
        <p className="rounded-xl bg-zinc-50 p-3 text-xs text-zinc-500 dark:bg-zinc-800/50">
          {t(
            'Karttaki harcamaları "Harcama" ile ekleyin veya ekstreyi yükleyin. Eski taksitli alışverişleri alış tarihi ve toplam taksit sayısıyla girin; ödenmiş taksitler otomatik düşülür.',
          )}
        </p>
      ) : (
        <p className="text-sm text-zinc-500">{summary ? t("Henüz kesilmiş ekstre yok.") : placeholder}</p>
      )}
      <Row label={t("Gelecek ekstreye")}>{money(summary?.currentPeriodCents)}</Row>
      {summary && summary.laterInstallmentsCents > 0 && <Row label={t("Sonraki aylara taksit")}>{money(summary.laterInstallmentsCents)}</Row>}
      <Row label={t("Sonraki kesim")}>
        {summary ? (
          <>
            {formatDateShort(summary.nextClosingDate)}
            <span className="ml-1 text-xs font-normal text-zinc-500">· {t("ödeme {date}", { date: formatDateShort(summary.nextDueDate) })}</span>
          </>
        ) : (
          placeholder
        )}
      </Row>
      {account.interestRate !== null && <Row label={<Term hint={TERMS.akdi}>{t("Aylık akdi faiz")}</Term>}>{rate(account.interestRate)}</Row>}
      {history && summary && <StatementTable statements={summary.statements} money={(c) => formatMoney(c / 100)} />}
    </CardShell>
  );
}

export function LoanCard({ account }: { account: Account }) {
  const { formatMoney } = useSettings();
  const { openLoanPayment, showAccountTransactions } = useUI();
  const [plan, setPlan] = useState(false);
  const { r: rep, placeholder } = useAccountReport(account.id);
  const s = rep?.loan ?? null;
  const money = (c: number | null | undefined) => (c == null ? placeholder : formatMoney(c / 100));
  const principal = Math.round(account.openingBalance * 100);
  const paidPct = principal > 0 && s ? Math.min(100, Math.max(0, ((principal - s.remainingCents) / principal) * 100)) : 0;

  return (
    <CardShell
      account={account}
      icon={<HandCoins size={18} />}
      footer={
        <>
          {s && s.remainingCents > 0 && (
            <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => openLoanPayment(account)}>
              {t("Taksit öde")}
            </button>
          )}
          <span className="ml-auto" />
          <IconAction title={t("İşlemler")} onClick={() => showAccountTransactions(account.id)} icon={<List size={16} />} />
          <IconAction title={plan ? t("Ödeme planını gizle") : t("Ödeme planı")} active={plan} onClick={() => setPlan((p) => !p)} icon={<CalendarClock size={16} />} />
        </>
      }
    >
      <div>
        <div className="text-xs text-zinc-500">{t("Kalan anapara")}</div>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">{money(s?.remainingCents)}</div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${paidPct}%` }} />
      </div>
      <Row label={t("Taksit")}>
        {s ? t("{paid}/{total} ödendi", { paid: s.paidCount, total: s.schedule.length }) : placeholder}
      </Row>
      {s?.next ? (
        <div className="space-y-2 rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/50">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{t("Sıradaki taksit · {i}.", { i: s.next.index })}</div>
          <Row label={t("Tarih")}>
            {formatDateShort(s.next.date)}
            <span className={`ml-1 text-xs font-normal ${(s.nextDueInDays ?? 0) < 0 ? "text-rose-600 dark:text-rose-400" : "text-zinc-500"}`}>
              · {s.nextDueInDays !== null && dueText(s.nextDueInDays)}
            </span>
          </Row>
          <Row label={t("Tutar")}>{money(s.next.paymentCents)}</Row>
          <Row label={t("Faiz + vergi")}>{money(s.next.interestCents)}</Row>
          <Row label={t("Anapara")}>{money(s.next.principalCents)}</Row>
        </div>
      ) : s ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">{t("Kredi kapandı.")}</p>
      ) : null}
      <Row label={t("Kalan faiz (tahmini)")}>{money(s?.remainingInterestCents)}</Row>
      {account.interestRate !== null && <Row label={<Term hint={TERMS.akdi}>{t("Aylık akdi faiz")}</Term>}>{rate(account.interestRate)}</Row>}
      {plan && s && (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="py-1 font-medium">#</th>
                <th className="py-1 font-medium">{t("Tarih")}</th>
                <th className="py-1 text-right font-medium">{t("Taksit")}</th>
                <th className="py-1 text-right font-medium">{t("Faiz")}</th>
                <th className="py-1 text-right font-medium">{t("Kalan")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {s.schedule.map((r) => (
                <tr key={r.index} className={r.index <= s.paidCount ? "text-zinc-400" : ""}>
                  <td className="py-1">{r.index}</td>
                  <td className="whitespace-nowrap py-1">{formatDateShort(r.date)}</td>
                  <td className="py-1 text-right tabular-nums">{money(r.paymentCents)}</td>
                  <td className="py-1 text-right tabular-nums">{money(r.interestCents)}</td>
                  <td className="py-1 text-right tabular-nums">{money(r.balanceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CardShell>
  );
}

function StatementTable({ statements, money }: { statements: CardStatement[]; money(c: number): string }) {
  if (!statements.length) return <p className="text-sm text-zinc-500">{t("Ekstre yok.")}</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-zinc-500">
          <th className="py-1 font-medium">{t("Dönem")}</th>
          <th className="py-1 text-right font-medium">{t("Ekstre")}</th>
          <th className="py-1 text-right font-medium">{t("Ödenen")}</th>
          <th className="py-1 text-right font-medium">{t("Durum")}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {statements.map((s) => (
          <tr key={s.closingDate}>
            <td className="whitespace-nowrap py-1.5">
              {formatDateShort(s.periodStart)} – {formatDateShort(s.closingDate)}
            </td>
            <td className="py-1.5 text-right tabular-nums">{money(s.statementCents)}</td>
            <td className="py-1.5 text-right tabular-nums">{money(s.paidCents)}</td>
            <td className="py-1.5 text-right">
              <StatusBadge status={s.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
