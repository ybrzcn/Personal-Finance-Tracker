import { AlertTriangle, Banknote, CalendarClock, CreditCard, FileUp, HandCoins, Landmark, List, Pencil, Plus, TrendingUp, Wallet } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { bankSummary, fxValueCents, nativeBalanceMinor } from "../lib/accounts";
import { formatQty, formatRate, isForeign, isFund, unitDivisor } from "../lib/fx";
import { cardStatements, cardSummary, type Statement, type StatementStatus } from "../lib/cards";
import { daysBetween, formatDateShort, todayISO } from "../lib/format";
import { loanSummary } from "../lib/loans";
import { ACCOUNT_KIND_LABEL, type Account } from "../lib/types";
import { useData } from "../state/data";
import { usePnlSummary } from "../state/pnl";
import { useRates } from "../state/rates";
import { useSettings } from "../state/settings";
import { useUI, type AmountHint } from "../state/ui";
import { Term, TERMS } from "./common";

const STATUS: Record<StatementStatus, { label: string; cls: string }> = {
  none: { label: "Borç yok", cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
  paid: { label: "Ödendi", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400" },
  minPaid: { label: "Asgari ödendi", cls: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400" },
  pending: { label: "Bekliyor", cls: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400" },
  overdue: { label: "Gecikti", cls: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400" },
};

export function StatusBadge({ status }: { status: StatementStatus }) {
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[status].cls}`}>
      {STATUS[status].label}
    </span>
  );
}

export function dueText(today: string, due: string): string {
  const d = daysBetween(today, due);
  if (d === 0) return "Bugün";
  return d > 0 ? `${d} gün kaldı` : `${-d} gün gecikti`;
}

/** Kart ödeme formu için hazır tutarlar. */
export function paymentHints(statement: Statement | null, totalDebtCents: number): AmountHint[] {
  const hints: AmountHint[] = [];
  if (statement && statement.remainingCents > 0) {
    hints.push({ label: "Kalan ekstre", amount: statement.remainingCents / 100 });
    const minLeft = statement.minPaymentCents - statement.paidCents;
    if (minLeft > 0) hints.push({ label: "Asgari", amount: minLeft / 100 });
  }
  if (totalDebtCents > 0) hints.push({ label: "Toplam borç", amount: totalDebtCents / 100 });
  return hints;
}

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
            {isFund(account.currency) ? "Yatırım fonu" : ACCOUNT_KIND_LABEL[account.kind]}
            {account.archived && " · Arşivlendi"}
          </div>
        </div>
        <button className="icon-btn" title="Düzenle" onClick={() => openAccountForm(account)}>
          <Pencil size={15} />
        </button>
      </div>
      <div className="flex-1 space-y-3">{children}</div>
      <div className="mt-4 flex flex-wrap items-center gap-1 border-t border-zinc-100 pt-3 dark:border-zinc-800">{footer}</div>
    </section>
  );
}

const rate = (r: number) => `%${r.toLocaleString("tr-TR")}`;

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
          <IconAction title="İşlemler" onClick={() => showAccountTransactions(account.id)} icon={<List size={16} />} />
        </>
      }
    >
      <div>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">{p ? formatQty(p.qtyMinor, account.currency) : "—"}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500 tabular-nums">
          {p && p.valueCents !== null && p.rateMicros !== null ? (
            <>
              ≈ {formatMoney(p.valueCents / 100)} · fiyat {formatRate(p.rateMicros / 1_000_000)}
              {p.rateObservedAt && ` · ${formatDateShort(p.rateObservedAt.slice(0, 10))}`}
              {p.rateStale && (
                <span title="Fiyat eski: TEFAS'a ulaşılamıyor olabilir" className="text-amber-600 dark:text-amber-400">
                  <AlertTriangle size={12} />
                </span>
              )}
            </>
          ) : (
            (error ?? "TL karşılığı: — (fiyat alınamadı)")
          )}
        </div>
        {p && p.qtyMinor > 0 && p.unrealizedCents !== null && (
          <div className={`mt-0.5 text-xs tabular-nums ${p.unrealizedCents >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
            k/z {p.unrealizedCents > 0 ? "+" : ""}
            {formatMoney(p.unrealizedCents / 100)}
            {p.unrealizedBp !== null && ` (%${(p.unrealizedBp / 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 })})`}
          </div>
        )}
      </div>
    </CardShell>
  );
}

export function BankAccountCard({ account }: { account: Account }) {
  const { transactions } = useData();
  const { formatMoney } = useSettings();
  const { showAccountTransactions, openStatementImport } = useUI();
  const today = todayISO();
  const s = useMemo(() => bankSummary(account, transactions, today), [account, transactions, today]);
  const limit = account.creditLimit;
  const { rates } = useRates();
  const foreign = isForeign(account.currency);
  const native = useMemo(() => (foreign ? nativeBalanceMinor(account, transactions, today) : 0), [foreign, account, transactions, today]);
  const quote = foreign ? rates.get(account.currency) : undefined;
  const { byAccount } = usePnlSummary();
  const pnl = foreign ? byAccount.get(account.id) : undefined;
  const valueCents = foreign ? fxValueCents(account, transactions, rates, today) : null;
  return (
    <CardShell
      account={account}
      icon={account.kind === "cash" ? <Wallet size={18} /> : <Landmark size={18} />}
      footer={
        <>
          <span className="ml-auto" />
          <IconAction title="İşlemler" onClick={() => showAccountTransactions(account.id)} icon={<List size={16} />} />
          {!foreign && <IconAction title="Ekstre yükle (Excel, PDF, CSV)" onClick={() => openStatementImport(account.id)} icon={<FileUp size={16} />} />}
        </>
      }
    >
      {foreign ? (
        <div>
          <div className={`text-2xl font-semibold tracking-tight tabular-nums ${native < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>
            {formatQty(native / unitDivisor(account.currency), account.currency)}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500 tabular-nums">
            {quote && valueCents !== null ? (
              <>
                ≈ {formatMoney(valueCents / 100)} · alış {formatRate(quote.buy)} ·{" "}
                {new Date(quote.observedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}
                {quote.stale && (
                  <span title="Kur eski: kaynağa ulaşılamıyor olabilir" className="text-amber-600 dark:text-amber-400">
                    <AlertTriangle size={12} />
                  </span>
                )}
              </>
            ) : (
              "TL karşılığı: — (kur alınamadı)"
            )}
          </div>
          {pnl && pnl.qtyMinor > 0 && pnl.unrealizedCents !== null && (
            <div className={`mt-0.5 text-xs tabular-nums ${pnl.unrealizedCents >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
              k/z {pnl.unrealizedCents > 0 ? "+" : ""}
              {formatMoney(pnl.unrealizedCents / 100)}
              {pnl.unrealizedBp !== null && ` (%${(pnl.unrealizedBp / 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 })})`}
            </div>
          )}
        </div>
      ) : (
        <div className={`text-2xl font-semibold tracking-tight tabular-nums ${s.balanceCents < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>
          {formatMoney(s.balanceCents / 100)}
        </div>
      )}
      {account.kind === "cash" && (foreign ? native < 0 : s.balanceCents < 0) && (
        <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          Nakit eksiye düşemez; bir gider fazla ya da yanlış hesaba girilmiş olabilir.
        </p>
      )}
      {account.kind === "bank" && !foreign && limit !== null && limit > 0 && (
        <>
          <UsageBar used={s.overdraftUsedCents / 100} limit={limit} />
          <Row label={<Term hint={TERMS.KMH}>KMH kullanımı</Term>}>
            {formatMoney(s.overdraftUsedCents / 100)} / {formatMoney(limit)}
          </Row>
          {s.availableCents !== null && <Row label="Kullanılabilir">{formatMoney(s.availableCents / 100)}</Row>}
        </>
      )}
      {account.kind === "bank" && !foreign && account.interestRate !== null && <Row label={<Term hint={TERMS.KMH}>Aylık KMH faizi</Term>}>{rate(account.interestRate)}</Row>}
    </CardShell>
  );
}

export function CreditCardCard({ account }: { account: Account }) {
  const { transactions } = useData();
  const { formatMoney } = useSettings();
  const { openTransactionForm, showAccountTransactions } = useUI();
  const [history, setHistory] = useState(false);
  const today = todayISO();
  const summary = useMemo(() => cardSummary(account, transactions, today), [account, transactions, today]);
  const statements = useMemo(
    () => (history ? cardStatements(account, transactions, today, 6) : []),
    [history, account, transactions, today],
  );
  const st = summary.lastStatement;
  const hints = paymentHints(st, summary.totalDebtCents);
  const money = (c: number) => formatMoney(c / 100);

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
              Ödeme yap
            </button>
          )}
          {/* Arşivlenmiş karta yeni harcama eklenemez */}
          {!account.archived && (
            <>
              <button
                className="btn-ghost px-2 py-1.5 text-xs"
                title="Bu karta harcama ekle (eski taksitli alışverişler dahil)"
                onClick={() => openTransactionForm(undefined, { type: "expense", accountId: account.id })}
              >
                <Plus size={14} /> Harcama
              </button>
              <button
                className="btn-ghost px-2 py-1.5 text-xs"
                title="Bu karttan nakit avans çek (tek çekim veya taksitli)"
                onClick={() => openTransactionForm(undefined, { type: "expense", accountId: account.id, cashAdvance: true })}
              >
                <Banknote size={14} /> Nakit avans
              </button>
            </>
          )}
          <span className="ml-auto" />
          <IconAction title="İşlemler" onClick={() => showAccountTransactions(account.id)} icon={<List size={16} />} />
          <IconAction
            title={history ? "Ekstre geçmişini gizle" : "Ekstre geçmişi"}
            active={history}
            onClick={() => setHistory((h) => !h)}
            icon={<CalendarClock size={16} />}
          />
        </>
      }
    >
      <div>
        <div className="text-xs text-zinc-500">Toplam borç</div>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">{money(summary.totalDebtCents)}</div>
      </div>
      {account.creditLimit !== null && account.creditLimit > 0 && (
        <>
          <UsageBar used={summary.totalDebtCents / 100} limit={account.creditLimit} />
          {summary.availableCents !== null && <Row label="Kullanılabilir limit">{money(summary.availableCents)}</Row>}
        </>
      )}
      {st ? (
        <div className="space-y-2 rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/50">
          <div className="flex items-center justify-between gap-2">
            <span className="whitespace-nowrap text-xs font-medium uppercase tracking-wide text-zinc-500">
              Son ekstre · {formatDateShort(st.closingDate)}
            </span>
            <StatusBadge status={st.status} />
          </div>
          <Row label="Ekstre borcu">{money(st.statementCents)}</Row>
          <Row label="Son ödeme">
            {formatDateShort(st.dueDate)}
            {st.remainingCents > 0 && (
              <span className={`ml-1 text-xs font-normal ${st.status === "overdue" ? "text-rose-600 dark:text-rose-400" : "text-zinc-500"}`}>
                {/* Asgarisi ödenmişse "gecikti" denmez: kalan borç gecikme değil, faize girer */}
                · {st.status === "minPaid" && st.dueDate < today ? "kalan faize girer" : dueText(today, st.dueDate)}
              </span>
            )}
          </Row>
          <Row label={<Term hint={TERMS.asgari}>Asgari ödeme</Term>}>{money(st.minPaymentCents)}</Row>
          <Row label="Kalan">{money(st.remainingCents)}</Row>
        </div>
      ) : summary.totalDebtCents === 0 ? (
        <p className="rounded-xl bg-zinc-50 p-3 text-xs text-zinc-500 dark:bg-zinc-800/50">
          Karttaki harcamaları "Harcama" ile ekleyin veya ekstreyi yükleyin. Eski taksitli alışverişleri alış tarihi ve toplam taksit
          sayısıyla girin; ödenmiş taksitler otomatik düşülür.
        </p>
      ) : (
        <p className="text-sm text-zinc-500">Henüz kesilmiş ekstre yok.</p>
      )}
      <Row label="Gelecek ekstreye">{money(summary.currentPeriodCents)}</Row>
      {summary.laterInstallmentsCents > 0 && <Row label="Sonraki aylara taksit">{money(summary.laterInstallmentsCents)}</Row>}
      <Row label="Sonraki kesim">
        {formatDateShort(summary.nextClosingDate)}
        <span className="ml-1 text-xs font-normal text-zinc-500">· ödeme {formatDateShort(summary.nextDueDate)}</span>
      </Row>
      {account.interestRate !== null && <Row label={<Term hint={TERMS.akdi}>Aylık akdi faiz</Term>}>{rate(account.interestRate)}</Row>}
      {history && <StatementTable statements={statements} money={money} />}
    </CardShell>
  );
}

export function LoanCard({ account }: { account: Account }) {
  const { transactions } = useData();
  const { formatMoney } = useSettings();
  const { openLoanPayment, showAccountTransactions } = useUI();
  const [plan, setPlan] = useState(false);
  const today = todayISO();
  const s = useMemo(() => loanSummary(account, transactions), [account, transactions]);
  const money = (c: number) => formatMoney(c / 100);
  const principal = Math.round(account.openingBalance * 100);
  const paidPct = principal > 0 ? Math.min(100, Math.max(0, ((principal - s.remainingCents) / principal) * 100)) : 0;

  return (
    <CardShell
      account={account}
      icon={<HandCoins size={18} />}
      footer={
        <>
          {s.remainingCents > 0 && (
            <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => openLoanPayment(account)}>
              Taksit öde
            </button>
          )}
          <span className="ml-auto" />
          <IconAction title="İşlemler" onClick={() => showAccountTransactions(account.id)} icon={<List size={16} />} />
          <IconAction title={plan ? "Ödeme planını gizle" : "Ödeme planı"} active={plan} onClick={() => setPlan((p) => !p)} icon={<CalendarClock size={16} />} />
        </>
      }
    >
      <div>
        <div className="text-xs text-zinc-500">Kalan anapara</div>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">{money(s.remainingCents)}</div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${paidPct}%` }} />
      </div>
      <Row label="Taksit">
        {s.paidCount}/{s.schedule.length} ödendi
      </Row>
      {s.next ? (
        <div className="space-y-2 rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/50">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Sıradaki taksit · {s.next.index}.</div>
          <Row label="Tarih">
            {formatDateShort(s.next.date)}
            <span className={`ml-1 text-xs font-normal ${s.next.date < today ? "text-rose-600 dark:text-rose-400" : "text-zinc-500"}`}>
              · {dueText(today, s.next.date)}
            </span>
          </Row>
          <Row label="Tutar">{money(s.next.paymentCents)}</Row>
          <Row label="Faiz + vergi">{money(s.next.interestCents)}</Row>
          <Row label="Anapara">{money(s.next.principalCents)}</Row>
        </div>
      ) : (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">Kredi kapandı.</p>
      )}
      <Row label="Kalan faiz (tahmini)">{money(s.remainingInterestCents)}</Row>
      {account.interestRate !== null && <Row label={<Term hint={TERMS.akdi}>Aylık akdi faiz</Term>}>{rate(account.interestRate)}</Row>}
      {plan && (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="py-1 font-medium">#</th>
                <th className="py-1 font-medium">Tarih</th>
                <th className="py-1 text-right font-medium">Taksit</th>
                <th className="py-1 text-right font-medium">Faiz</th>
                <th className="py-1 text-right font-medium">Kalan</th>
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

function StatementTable({ statements, money }: { statements: Statement[]; money(c: number): string }) {
  if (!statements.length) return <p className="text-sm text-zinc-500">Ekstre yok.</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-zinc-500">
          <th className="py-1 font-medium">Dönem</th>
          <th className="py-1 text-right font-medium">Ekstre</th>
          <th className="py-1 text-right font-medium">Ödenen</th>
          <th className="py-1 text-right font-medium">Durum</th>
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
