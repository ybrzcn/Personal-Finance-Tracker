import { AlertTriangle, Check, Trophy, TrendingDown } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";
import { EmptyState, PageHeader, Term, TERMS } from "../components/common";
import { primarySalary, regularExpenseForMonth, regularIncomeForMonth, salaryMonthFor, splitMonthIncome } from "../lib/budget";
import {
  DEBT_RULE_LABEL,
  debtsFromAccounts,
  defaultDebtRule,
  minimumMonthlyCents,
  simulate,
  simulateManual,
  STRATEGY_LABEL,
  type DebtRule,
  type DebtRuleMode,
  type SimResult,
  type Strategy,
} from "../lib/debt";
import { errorMessage } from "../lib/api";
import { amountToInput, formatDate, parseAmount, todayISO } from "../lib/format";
import { addMonthsISO } from "../lib/plan";
import { monthName, occurrenceIn, shiftMonth } from "../lib/recurring";
import { ACCOUNT_KIND_LABEL } from "../lib/types";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

const STRATEGIES: Strategy[] = ["avalanche", "snowball", "custom", "minimum"];
const RULE_MODES: DebtRuleMode[] = ["full", "minimum", "fixed", "none"];
/** Hücrede "bu ayın tamamını öde" işareti (tutar yerine saklanır) */
const PAY_FULL = -1;

/** Tabloda aya özel "borçlara ayrılan" tutar; boşsa varsayılan aylık tutar kullanılır. */
function MonthBudgetInput({
  value,
  placeholder,
  warn,
  onSave,
}: {
  value: number | undefined;
  placeholder: string;
  warn: boolean;
  onSave(v: number | null): void;
}) {
  const initial = value !== undefined ? amountToInput(value) : "";
  const [text, setText] = useState(initial);
  const commit = () => {
    // Değişmeyen hücreye odaklanıp çıkmak (ör. "tamamını öde" işaretli hücre) kaydı silmesin
    if (text.trim() === initial.trim()) return;
    const v = text.trim() ? parseAmount(text) : null;
    if (text.trim() && (v === null || v < 0)) {
      setText(initial); // hatalı yazım: eski değere dön, silme
      return;
    }
    onSave(v);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && (e.target as HTMLInputElement).blur();
  return (
    <input
      className={`input w-32 py-1 text-right tabular-nums ${value !== undefined ? "font-semibold" : ""} ${warn ? "border-amber-400 dark:border-amber-500/60" : ""}`}
      inputMode="decimal"
      placeholder={placeholder}
      title={warn ? "Bu ay gelirden (düzenli giderler düşüldükten sonra) fazlası ayrılıyor" : "Boş bırakılırsa varsayılan aylık tutar kullanılır"}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
    />
  );
}

export function DebtPlannerPage() {
  const { accounts, accountById, transactions, recurring } = useData();
  const { confirm, toast } = useUI();
  const { settings, update: saveSettings, formatMoney } = useSettings();
  // Ayar veritabanına yazılamazsa değer geri alınır ve kullanıcı uyarılır
  const update = (patch: Parameters<typeof saveSettings>[0]) =>
    void saveSettings(patch).catch((e) => toast(`Borç planı kaydedilemedi: ${errorMessage(e)}`, "error"));
  const today = todayISO();
  // Satırın ödemelerini karşılayan maaşın ayı (bütçe ayı): o ay yatan maaşın ait olduğu ay (Ekim'de yatan Eylül maaşı)
  const salary = useMemo(() => primarySalary(recurring, today), [recurring, today]);
  const incomeMonth = (i: number) => {
    const m = shiftMonth(today.slice(0, 7), i - 1);
    return salary ? salaryMonthFor(salary, occurrenceIn(salary, m)) : m;
  };
  const firstIncomeMonth = incomeMonth(1);
  // Kart ekstreleri, son ödemelerini karşılayan maaşın satırına düşer (Ödeme Takvimi ile aynı kural)
  const debts = useMemo(() => {
    const bucket = (due: string) => {
      const m = salary ? salaryMonthFor(salary, due) : due.slice(0, 7);
      const diff = (Number(m.slice(0, 4)) - Number(firstIncomeMonth.slice(0, 4))) * 12 + Number(m.slice(5, 7)) - Number(firstIncomeMonth.slice(5, 7));
      return Math.max(1, diff + 1);
    };
    return debtsFromAccounts(accounts, transactions, today, bucket);
  }, [accounts, transactions, today, salary, firstIncomeMonth]);
  const minimum = useMemo(() => minimumMonthlyCents(debts), [debts]);
  const budgetCents = settings.debtBudget > 0 ? Math.round(settings.debtBudget * 100) : minimum;
  const [budgetText, setBudgetText] = useState(settings.debtBudget > 0 ? amountToInput(settings.debtBudget) : "");
  const [selected, setSelected] = useState<Strategy>("avalanche");

  // Ay numarası (1 = bu ay) → YYYY-MM; aya özel tutar varsa o, yoksa varsayılan
  const overrides = settings.debtBudgetOverrides ?? {};
  const monthKey = (i: number) => shiftMonth(today.slice(0, 7), i - 1);
  const incomeFor = (ym: string) =>
    regularIncomeForMonth(transactions, recurring, ym).reduce((s, l) => s + l.usedCents, 0) +
    splitMonthIncome(transactions, recurring, ym).irregularCents;
  const budgetForMonth = (i: number) => {
    const o = overrides[monthKey(i)];
    return o !== undefined ? Math.round(o * 100) : budgetCents;
  };
  const results = useMemo(
    () => Object.fromEntries(STRATEGIES.map((s) => [s, simulate(debts, budgetForMonth, s)])) as Record<Strategy, SimResult>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debts, budgetCents, JSON.stringify(overrides), today],
  );
  // "Kendi planım": borç başına kural + elle girilen aylık ödemeler
  const rules = (settings.debtRules ?? {}) as Record<string, DebtRule>;
  const cells = settings.debtCells ?? {};
  const planEmpty = Object.keys(settings.debtRules ?? {}).length === 0 && Object.keys(cells).length === 0;
  const ruleOf = (id: string) => rules[id] ?? defaultDebtRule(debts.find((d) => d.id === id)!);
  const manual = useMemo(
    () =>
      simulateManual(debts, rules, (i, id) => {
        const v = cells[`${monthKey(i)}:${id}`];
        if (v === PAY_FULL) return Number.POSITIVE_INFINITY; // tamamı (faiz işlemez)
        return v !== undefined ? Math.round(v * 100) : undefined;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debts, JSON.stringify(rules), JSON.stringify(cells), today],
  );
  const setRule = (id: string, rule: DebtRule) => update({ debtRules: { ...rules, [id]: rule } });
  const setCell = (key: string, v: number | null) => {
    const next = { ...cells };
    if (v === null) delete next[key];
    else next[key] = v;
    update({ debtCells: next });
  };
  const setOverride = (month: string, v: number | null) => {
    const next = { ...overrides };
    if (v === null) delete next[month];
    else next[month] = v;
    update({ debtBudgetOverrides: next });
  };
  const money = (c: number) => formatMoney(c / 100);
  const allResults: Record<Strategy, SimResult> = { ...results, manual };
  const best = ([...STRATEGIES, "manual"] as Strategy[])
    .filter((s) => allResults[s].months !== null)
    .sort((a, b) => allResults[a].totalInterestCents - allResults[b].totalInterestCents)[0];
  const current = allResults[selected];
  const isManual = selected === "manual";

  const commitBudget = () => {
    const v = budgetText.trim() ? parseAmount(budgetText) : 0;
    update({ debtBudget: v && v > 0 ? v : 0 });
  };

  if (debts.length === 0) {
    return (
      <>
        <PageHeader title="Borç Planı" subtitle="Hangi borcu hangi sırayla kapatırsanız daha az faiz ödersiniz" />
        <div className="card">
          <EmptyState icon={Trophy} title="Faiz işleyen borcunuz yok" hint="Kredi kartı borcu, KMH kullanımı veya kredi eklendiğinde burada plan oluşturulur." />
        </div>
      </>
    );
  }

  // Aylık tablo satırları; gelir / düzenli gider her ay aynıysa sütun yerine özet satırında bir kez gösterilir
  const tableRows = current.timeline.slice(0, 24).map((m) => {
    const key = monthKey(m.month);
    const salaryMonth = incomeMonth(m.month);
    return { m, key, salaryMonth, income: incomeFor(salaryMonth), fixed: regularExpenseForMonth(recurring, key) };
  });
  const constIncome = tableRows.length > 1 && tableRows.every((x) => x.income === tableRows[0].income);
  const constFixed = tableRows.length > 1 && tableRows.every((x) => x.fixed === tableRows[0].fixed);
  // Borçların kapanış ayları (zaman çizelgesi)
  const payoffs = debts
    .map((d) => ({ d, month: current.payoffMonth[d.id] }))
    .filter((x): x is { d: (typeof debts)[number]; month: number } => typeof x.month === "number" && x.month > 0)
    .sort((a, b) => a.month - b.month);

  return (
    <>
      <PageHeader title="Borç Planı" subtitle="Hangi borcu hangi sırayla kapatırsanız daha az faiz ödersiniz" />

      {/* Tutar kartı yalnız çok geniş ekranda tablonun yanında; 1280 px'te borç tablosu tam genişlik */}
      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-4">
        <section className="card p-5">
          <label className="label" htmlFor="debt-budget">
            Borçlara ayırabileceğim aylık tutar
          </label>
          <input
            id="debt-budget"
            className="input text-lg font-semibold tabular-nums"
            inputMode="decimal"
            placeholder={amountToInput(minimum / 100)}
            value={budgetText}
            onChange={(e) => setBudgetText(e.target.value)}
            onBlur={commitBudget}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <p className="mt-2 text-xs text-zinc-500">
            Bu ay asgari ödemeler + kredi taksitleri: <strong>{money(minimum)}</strong>. Boş bırakılırsa bu tutar kullanılır.
          </p>
          {current.budgetShort && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle size={14} className="mt-px shrink-0" /> Bazı aylarda asgari ödemeler bu tutarı aşıyor; plan asgarileri yine de öder.
            </p>
          )}
        </section>

        <section className="card overflow-x-auto 2xl:col-span-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60">
                <th className="px-4 py-2.5">Borç</th>
                <th className="px-4 py-2.5 text-right">Bakiye</th>
                <th className="whitespace-nowrap px-4 py-2.5 text-right">
                  <Term hint={TERMS.efektif}>Aylık faiz</Term>
                </th>
                <th className="whitespace-nowrap px-4 py-2.5 text-right">Asgari</th>
                <th className="whitespace-nowrap px-4 py-2.5">Planım</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {debts.map((d) => {
                const i = Math.round((d.billing ? (d.billing[0] ?? 0) : d.balanceCents) * d.monthlyRate);
                const min = results.minimum.timeline[0]?.payments[d.id] ?? 0;
                return (
                  <tr key={d.id}>
                    <td className="px-4 py-2.5">
                      <div className="flex max-w-[16rem] items-center gap-2" title={d.name}>
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
                        <span className="truncate font-medium">{d.name}</span>
                        <span className="shrink-0 whitespace-nowrap text-xs text-zinc-500">{ACCOUNT_KIND_LABEL[d.kind]}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {money(d.balanceCents)}
                      {d.billing && d.billing[0] !== d.balanceCents && (
                        <div className="text-xs text-zinc-500">ilk ay {money(d.billing[0] ?? 0)}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      %{(d.monthlyRate * 100).toLocaleString("tr-TR", { maximumFractionDigits: 2 })}
                      {/* Hesaptaki akdi oranla farkı çelişki gibi görünmesin: vergiler ayrıca gösterilir */}
                      {accountById.get(d.id)?.interestRate ? (
                        <div className="text-xs text-zinc-500">
                          %{accountById.get(d.id)!.interestRate!.toLocaleString("tr-TR", { maximumFractionDigits: 2 })} akdi + vergiler
                        </div>
                      ) : null}
                      <div className="text-xs text-zinc-500">{money(i)}/ay</div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{money(min)}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1.5">
                        <select
                          className="input w-32 py-1 text-xs"
                          aria-label={`${d.name} ödeme kuralı`}
                          value={ruleOf(d.id).mode}
                          onChange={(e) => {
                            const mode = e.target.value as DebtRuleMode;
                            // Sabit tutara geçerken başlangıç değeri o borcun asgari tutarı
                            const amount = mode === "fixed" ? (ruleOf(d.id).amount ?? Math.round(min) / 100) : ruleOf(d.id).amount;
                            setRule(d.id, { mode, amount });
                            setSelected("manual");
                          }}
                        >
                          {RULE_MODES.map((m) => (
                            <option key={m} value={m}>
                              {d.kind === "loan" && m === "minimum" ? "Taksit" : d.kind === "bank" && m === "minimum" ? "Yalnız faiz" : DEBT_RULE_LABEL[m]}
                            </option>
                          ))}
                        </select>
                        {ruleOf(d.id).mode === "fixed" && (
                          <MonthBudgetInput
                            key={`rule:${d.id}:${ruleOf(d.id).amount ?? ""}`}
                            value={ruleOf(d.id).amount}
                            placeholder="Aylık"
                            warn={false}
                            onSave={(v) => {
                              setRule(d.id, { mode: "fixed", amount: v ?? 0 });
                              setSelected("manual");
                            }}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
            Aylık faiz, akdi faize <Term hint={TERMS.KKDF}>KKDF</Term> ve <Term hint={TERMS.BSMV}>BSMV</Term> eklenmiş orandır. Krediler sabit
            taksitle ödenir; ek ödeme en son krediye yönlendirilir.
          </p>
        </section>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {[...STRATEGIES, "manual" as Strategy].map((s) => {
          const r = allResults[s];
          const isBest = s === best;
          return (
            <button
              key={s}
              onClick={() => setSelected(s)}
              className={`card p-4 text-left transition ${selected === s ? "ring-2 ring-indigo-500" : "hover:border-indigo-300"}`}
            >
              <div className="flex min-h-[2.5rem] items-start justify-between gap-2">
                <span className="text-sm font-semibold">{STRATEGY_LABEL[s]}</span>
                {isBest && (
                  <span className="shrink-0 whitespace-nowrap rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
                    En az faiz
                  </span>
                )}
              </div>
              {s === "manual" && planEmpty ? (
                <p className="mt-3 text-sm text-zinc-500">Planını kur: tabloda her borç için kural seç ya da tutar yaz.</p>
              ) : r.months === null ? (
                <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">30 yılda kapanmıyor</p>
              ) : (
                <>
                  <div className="mt-3 text-xl font-semibold tabular-nums">{money(r.totalInterestCents)}</div>
                  <div className="text-xs text-zinc-500">toplam faiz</div>
                  <div className="mt-2 text-sm">
                    {r.months} ay · {formatDate(addMonthsISO(today, r.months))}
                  </div>
                  {best && !isBest && (
                    <div className="mt-1 text-xs">
                      {r.totalInterestCents - allResults[best].totalInterestCents >= 100 ? (
                        <span className="text-rose-600 dark:text-rose-400">+{money(r.totalInterestCents - allResults[best].totalInterestCents)} fazla faiz</span>
                      ) : (
                        <span className="text-zinc-500">En iyiyle aynı sonuç</span>
                      )}
                    </div>
                  )}
                </>
              )}
            </button>
          );
        })}
      </div>

      <section className="card mt-4 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <TrendingDown size={16} className="text-indigo-500" />
          <h2 className="text-sm font-semibold">{STRATEGY_LABEL[selected]} · aylık ödeme planı</h2>
          <span className="ml-auto text-xs text-zinc-500">
            {isManual
              ? "Her borcun her ayki ödemesini hücreye yazın; boş hücreler 'Planım' kuralını kullanır (seçilmediyse ödeme yok)."
              : "\"Borçlara ayrılan\" sütununda her ay için farklı tutar girebilirsiniz; boş aylar varsayılan tutarı kullanır."}
          </span>
          {isManual && (Object.keys(rules).length > 0 || Object.keys(cells).length > 0) && (
            <button
              className="btn-secondary px-2.5 py-1 text-xs"
              title="Tüm kuralları ve hücrelere yazılan tutarları temizler"
              onClick={async () => {
                const ok = await confirm({
                  title: "Plan temizlensin mi?",
                  message: "Kendi planındaki tüm borç kuralları ve hücrelere yazdığın tutarlar silinir.",
                  confirmLabel: "Temizle",
                  danger: true,
                });
                if (ok) update({ debtRules: {}, debtCells: {} });
              }}
            >
              Planı temizle
            </button>
          )}
        </div>
        {(constIncome || constFixed || payoffs.length > 0 || (isManual && planEmpty)) && (
          <div className="space-y-2 border-b border-zinc-200 px-5 py-3 text-sm dark:border-zinc-800">
            {isManual && planEmpty && (
              <p className="text-zinc-600 dark:text-zinc-300">
                Başlamak için yukarıdaki tabloda her borcun <strong>Planım</strong> kuralını seç (Tam öde, Asgari, Sabit tutar) ya da aşağıdaki
                hücrelere o ay ödeyeceğin tutarı yaz.
              </p>
            )}
            {(constIncome || constFixed) && (
              <p className="text-zinc-500">
                {constIncome && (
                  <>
                    Her ay gelir <strong className="tabular-nums text-emerald-600 dark:text-emerald-400">{money(tableRows[0].income)}</strong>
                  </>
                )}
                {constIncome && constFixed && " · "}
                {constFixed && (
                  <>
                    düzenli gider <strong className="tabular-nums">{tableRows[0].fixed ? `−${money(tableRows[0].fixed)}` : "yok"}</strong>
                  </>
                )}
              </p>
            )}
            {payoffs.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="Borçların kapanış ayları">
                {payoffs.map(({ d, month }) => (
                  <li key={d.id} className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: d.color }} />
                    {d.name} · bitiş <strong>{formatDate(addMonthsISO(today, month - 1)).replace(/^\d+ /, "")}</strong>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60">
                <th className="sticky left-0 z-10 whitespace-nowrap bg-zinc-50 px-4 py-2.5 dark:bg-zinc-900">Ay</th>
                {!constIncome && <th className="whitespace-nowrap px-4 py-2.5 text-right">Gelir</th>}
                {!constFixed && <th className="whitespace-nowrap px-4 py-2.5 text-right">Düzenli gider</th>}
                <th className="whitespace-nowrap px-4 py-2.5 text-right" title={isManual ? undefined : `Boş aylarda ${money(budgetCents)} kullanılır`}>
                  {isManual ? "Gelirden kalan" : `Borçlara ayrılan (${money(budgetCents)})`}
                </th>
                {debts.map((d) => (
                  <th key={d.id} className={`max-w-[10rem] truncate whitespace-nowrap py-2.5 ${isManual ? "px-2 text-center" : "px-4 text-right"}`} title={d.name}>
                    {d.name}
                  </th>
                ))}
                <th className="px-4 py-2.5 text-right">Toplam</th>
                <th className="px-4 py-2.5 text-right">Kalan borç</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {tableRows.map(({ m, key, salaryMonth, income, fixed }) => {
                const strategy = selected;
                const total = Object.values(m.payments).reduce((s, v) => s + v, 0);
                const left = Object.values(m.balances).reduce((s, v) => s + v, 0);
                const allotted = budgetForMonth(m.month);
                return (
                  <tr key={m.month}>
                    <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-4 py-2 text-zinc-500 dark:bg-zinc-900">
                      {formatDate(addMonthsISO(today, m.month - 1)).replace(/^\d+ /, "")}
                      {salary && salaryMonth !== key && <span className="ml-1 text-xs text-zinc-400">· {monthName(salaryMonth)} maaşı</span>}
                    </td>
                    {!constIncome && (
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{money(income)}</td>
                    )}
                    {!constFixed && (
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-zinc-500">{fixed ? `−${money(fixed)}` : "—"}</td>
                    )}
                    <td className="whitespace-nowrap px-2 py-1 text-right">
                      {isManual ? (
                        <span
                          className={`px-2 font-medium tabular-nums ${income - fixed - total < 0 ? "text-rose-600 dark:text-rose-400" : "text-zinc-600 dark:text-zinc-300"}`}
                          title="Gelir − düzenli giderler − bu ayki borç ödemeleri"
                        >
                          {money(income - fixed - total)}
                        </span>
                      ) : strategy === "minimum" ? (
                        <span className="text-zinc-400">—</span>
                      ) : (
                        <MonthBudgetInput
                          key={`${key}:${overrides[key] ?? ""}:${budgetCents}`}
                          value={overrides[key]}
                          placeholder=""
                          warn={income > 0 && allotted > income - fixed}
                          onSave={(v) => setOverride(key, v)}
                        />
                      )}
                    </td>
                    {debts.map((d) =>
                      isManual ? (
                        <td key={d.id} className="whitespace-nowrap px-2 py-1 text-center">
                          {m.balances[d.id] === 0 && !m.payments[d.id] ? (
                            <span className="px-2 text-zinc-300 dark:text-zinc-700">—</span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <MonthBudgetInput
                                key={`${key}:${d.id}:${cells[`${key}:${d.id}`] ?? ""}:${m.payments[d.id] ?? 0}`}
                                value={cells[`${key}:${d.id}`] === PAY_FULL ? undefined : cells[`${key}:${d.id}`]}
                                placeholder={m.payments[d.id] ? amountToInput(m.payments[d.id] / 100) : ""}
                                warn={false}
                                onSave={(v) => setCell(`${key}:${d.id}`, v)}
                              />
                              {(() => {
                                const cellKey = `${key}:${d.id}`;
                                const full = cells[cellKey] === PAY_FULL;
                                const closes = m.balances[d.id] === 0 && !!m.payments[d.id];
                                return (
                                  <button
                                    type="button"
                                    title={full ? "Geri al (kurala dön)" : "Bu ayın tamamını öde"}
                                    aria-label={full ? `${d.name} tamamını ödeme işaretini kaldır` : `${d.name} bu ayın tamamını öde`}
                                    aria-pressed={full}
                                    onClick={() => setCell(cellKey, full ? null : PAY_FULL)}
                                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border transition ${
                                      full
                                        ? "border-emerald-500 bg-emerald-500 text-white"
                                        : closes
                                          ? "border-emerald-500/60 text-emerald-500 hover:bg-emerald-500/10"
                                          : "border-zinc-300 text-zinc-400 hover:border-emerald-500 hover:text-emerald-500 dark:border-zinc-700"
                                    }`}
                                  >
                                    <Check size={13} strokeWidth={3} />
                                  </button>
                                );
                              })()}
                            </span>
                          )}
                        </td>
                      ) : (
                        <td key={d.id} className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${m.payments[d.id] ? "" : "text-zinc-300 dark:text-zinc-700"}`}>
                          {m.payments[d.id] ? money(m.payments[d.id]) : "—"}
                          {m.balances[d.id] === 0 && m.payments[d.id] ? <span className="ml-1 text-emerald-500">✓</span> : null}
                        </td>
                      ),
                    )}
                    <td className="whitespace-nowrap px-4 py-2 text-right font-medium tabular-nums">{money(total)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-zinc-500">{money(left)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {current.timeline.length > 24 && (
          <p className="border-t border-zinc-100 px-5 py-2 text-xs text-zinc-500 dark:border-zinc-800">İlk 24 ay gösteriliyor.</p>
        )}
      </section>

      <p className="mt-4 text-xs text-zinc-500">
        Simülasyon yeni harcama olmadığını ve faiz oranlarının sabit kaldığını varsayar; gerçek banka hesaplamalarından (günlük faiz,
        gecikme faizi) farklı olabilir. Çığ yöntemi genellikle en az faizi, Kartopu ise en hızlı "borç kapatma" motivasyonunu sağlar.
      </p>
    </>
  );
}
