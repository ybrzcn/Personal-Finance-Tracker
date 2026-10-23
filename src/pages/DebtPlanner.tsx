import { AlertTriangle, Check, Trophy, TrendingDown } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { EmptyState, PageHeader, Term, TERMS } from "../components/common";
import { errorMessage } from "../lib/api";
import { locale, t } from "../lib/i18n";
import { rich } from "../lib/rich";
import { DEBT_RULE_LABEL, STRATEGY_LABEL, type DebtRule } from "../lib/debtLabels";
import { amountToInput, formatDate, parseAmount } from "../lib/format";
import { monthName } from "../lib/recurring";
import { ACCOUNT_KIND_LABEL, type DebtPlanDebt, type DebtPlanResult, type DebtRuleMode, type DebtStrategy } from "../lib/types";
import { useData } from "../state/data";
import { useDebtPlan, type DebtSettingsPatch } from "../state/debtPlan";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

const STRATEGIES: DebtStrategy[] = ["avalanche", "snowball", "custom", "minimum", "manual"];
const RULE_MODES: DebtRuleMode[] = ["full", "minimum", "fixed", "none"];
/** Hücrede "bu ayın tamamını öde" işareti (tutar yerine saklanır) */
const PAY_FULL = -1;
/** YYYY-MM → "Ekim 2026" */
const monthLabel = (ym: string) => formatDate(`${ym}-01`).replace(/^\d+ /, "");

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
      title={warn ? t("Bu ay gelirden (düzenli giderler düşüldükten sonra) fazlası ayrılıyor") : t("Boş bırakılırsa varsayılan aylık tutar kullanılır")}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
    />
  );
}

export function DebtPlannerPage() {
  const { accountById } = useData();
  const { confirm, toast } = useUI();
  const { settings, formatMoney } = useSettings();
  const { report, error, retry, refreshing, save } = useDebtPlan();
  // Ayar veritabanına yazılamazsa değer geri alınır ve kullanıcı uyarılır
  const update = (patch: DebtSettingsPatch) => void save(patch).catch((e) => toast(t("Borç planı kaydedilemedi: {error}", { error: errorMessage(e) }), "error"));
  const [budgetText, setBudgetText] = useState(settings.debtBudget > 0 ? amountToInput(settings.debtBudget) : "");
  const [selected, setSelected] = useState<DebtStrategy>("avalanche");
  const overrides = settings.debtBudgetOverrides ?? {};
  const rules = (settings.debtRules ?? {}) as Record<string, DebtRule>;
  const cells = settings.debtCells ?? {};
  // "Kendi planım" boş başlar: kural seçilmeyen ve hücresine tutar yazılmayan borca ödeme yapılmaz
  const ruleOf = (id: string): DebtRule => rules[id] ?? { mode: "none" };
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
  const commitBudget = () => {
    const v = budgetText.trim() ? parseAmount(budgetText) : 0;
    update({ debtBudget: v && v > 0 ? v : 0 });
  };
  const header = <PageHeader title={t("Borç Planı")} subtitle={t("Hangi borcu hangi sırayla kapatırsanız daha az faiz ödersiniz")} />;

  if (!report)
    return (
      <>
        {header}
        {error ? (
          <div role="alert" className="card flex items-center justify-between gap-3 px-5 py-4 text-sm">
            <span className="text-rose-600 dark:text-rose-400">{t("Borç planı alınamadı: {error}", { error })}</span>
            <button className="btn-secondary px-3 py-1.5 text-xs" onClick={retry}>
              {t("Tekrar dene")}
            </button>
          </div>
        ) : (
          <div className="card p-5 text-sm text-zinc-500">{t("Borç planı hesaplanıyor…")}</div>
        )}
      </>
    );
  if (report.debts.length === 0) {
    return (
      <>
        {header}
        <div className="card">
          <EmptyState icon={Trophy} title={t("Faiz işleyen borcunuz yok")} hint={t("Kredi kartı borcu, KMH kullanımı veya kredi eklendiğinde burada plan oluşturulur.")} />
        </div>
      </>
    );
  }

  const debts = report.debts;
  const nameOf = (d: DebtPlanDebt) => {
    const name = accountById.get(d.id)?.name ?? t("Silinmiş hesap");
    return d.kind === "bank" ? t("{name} (KMH)", { name }) : name;
  };
  const colorOf = (id: string) => accountById.get(id)?.color ?? "#a1a1aa";
  const debtById = new Map(debts.map((d) => [d.id, d]));
  const plans = Object.fromEntries(report.plans.map((p) => [p.strategy, p])) as Record<DebtStrategy, DebtPlanResult>;
  const best = report.best;
  const current = plans[selected];
  const isManual = selected === "manual";
  const planEmpty = report.manualEmpty;
  const rows = current.rows;
  // Gelir / düzenli gider her ay aynıysa sütun yerine özet satırında bir kez gösterilir
  const constIncome = current.incomeSame;
  const constFixed = current.fixedSame;
  // Ayar kaydından sonra yeni rapor gelene kadar rakamlar soluk; tablo yerinde kalır (odak kaybolmasın)
  const dim = refreshing ? "opacity-60 transition-opacity" : "transition-opacity";

  return (
    <>
      {header}

      {/* Tutar kartı yalnız çok geniş ekranda tablonun yanında; 1280 px'te borç tablosu tam genişlik */}
      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-4">
        <section className="card p-5">
          <label className="label" htmlFor="debt-budget">
            {t("Borçlara ayırabileceğim aylık tutar")}
          </label>
          <input
            id="debt-budget"
            className="input text-lg font-semibold tabular-nums"
            inputMode="decimal"
            placeholder={amountToInput(report.minimumCents / 100)}
            value={budgetText}
            onChange={(e) => setBudgetText(e.target.value)}
            onBlur={commitBudget}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <p className={`mt-2 text-xs text-zinc-500 ${dim}`}>
            {rich(t("Bu ay asgari ödemeler + kredi taksitleri: {amount}. Boş bırakılırsa bu tutar kullanılır."), {
              amount: <strong>{money(report.minimumCents)}</strong>,
            })}
          </p>
          {current.budgetShort && (
            <p className={`mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400 ${dim}`}>
              <AlertTriangle size={14} className="mt-px shrink-0" /> {t("Bazı aylarda asgari ödemeler bu tutarı aşıyor; plan asgarileri yine de öder.")}
            </p>
          )}
          {refreshing && (
            <p className="mt-2 text-xs text-zinc-500" role="status">
              {t("Hesaplanıyor…")}
            </p>
          )}
        </section>

        <section className={`card overflow-x-auto 2xl:col-span-3 ${dim}`} aria-busy={refreshing}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60">
                <th className="px-4 py-2.5">{t("Borç")}</th>
                <th className="px-4 py-2.5 text-right">{t("Bakiye")}</th>
                <th className="whitespace-nowrap px-4 py-2.5 text-right">
                  <Term hint={TERMS.efektif}>{t("Aylık faiz")}</Term>
                </th>
                <th className="whitespace-nowrap px-4 py-2.5 text-right">{t("Asgari")}</th>
                <th className="whitespace-nowrap px-4 py-2.5">{t("Planım")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {debts.map((d) => {
                const name = nameOf(d);
                const rate = accountById.get(d.id)?.interestRate;
                return (
                  <tr key={d.id}>
                    <td className="px-4 py-2.5">
                      <div className="flex max-w-[16rem] items-center gap-2" title={name}>
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorOf(d.id) }} />
                        <span className="truncate font-medium">{name}</span>
                        <span className="shrink-0 whitespace-nowrap text-xs text-zinc-500">{ACCOUNT_KIND_LABEL[d.kind]}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {money(d.balanceCents)}
                      {d.firstMonthCents !== null && d.firstMonthCents !== d.balanceCents && (
                        <div className="text-xs text-zinc-500">{t("ilk ay {amount}", { amount: money(d.firstMonthCents) })}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {t("%{v}", { v: (d.monthlyRate * 100).toLocaleString(locale, { maximumFractionDigits: 2 }) })}
                      {/* Hesaptaki akdi oranla farkı çelişki gibi görünmesin: vergiler ayrıca gösterilir */}
                      {rate ? (
                        <div className="text-xs text-zinc-500">
                          {t("%{v} akdi + vergiler", { v: rate.toLocaleString(locale, { maximumFractionDigits: 2 }) })}
                        </div>
                      ) : null}
                      <div className="text-xs text-zinc-500">{t("{amount}/ay", { amount: money(d.interestCents) })}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{money(d.minimumCents)}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1.5">
                        <select
                          className="input w-32 py-1 text-xs"
                          aria-label={t("{name} ödeme kuralı", { name })}
                          value={ruleOf(d.id).mode}
                          onChange={(e) => {
                            const mode = e.target.value as DebtRuleMode;
                            // Sabit tutara geçerken başlangıç değeri o borcun asgari tutarı
                            const amount = mode === "fixed" ? (ruleOf(d.id).amount ?? d.minimumCents / 100) : ruleOf(d.id).amount;
                            setRule(d.id, { mode, amount });
                            setSelected("manual");
                          }}
                        >
                          {RULE_MODES.map((m) => (
                            <option key={m} value={m}>
                              {d.kind === "loan" && m === "minimum" ? t("Taksit") : d.kind === "bank" && m === "minimum" ? t("Yalnız faiz") : DEBT_RULE_LABEL[m]}
                            </option>
                          ))}
                        </select>
                        {ruleOf(d.id).mode === "fixed" && (
                          <MonthBudgetInput
                            key={`rule:${d.id}:${ruleOf(d.id).amount ?? ""}`}
                            value={ruleOf(d.id).amount}
                            placeholder={t("Aylık")}
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
            {rich(t("Aylık faiz, akdi faize {kkdf} ve {bsmv} eklenmiş orandır. Krediler sabit taksitle ödenir; ek ödeme en son krediye yönlendirilir."), {
              kkdf: <Term hint={TERMS.KKDF}>KKDF</Term>,
              bsmv: <Term hint={TERMS.BSMV}>BSMV</Term>,
            })}
          </p>
        </section>
      </div>

      <div className={`mt-4 grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5 ${dim}`} aria-busy={refreshing}>
        {STRATEGIES.map((s) => {
          const r = plans[s];
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
                    {t("En az faiz")}
                  </span>
                )}
              </div>
              {s === "manual" && planEmpty ? (
                <p className="mt-3 text-sm text-zinc-500">{t("Planını kur: tabloda her borç için kural seç ya da tutar yaz.")}</p>
              ) : r.months === null || r.payoffDate === null ? (
                <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{t("30 yılda kapanmıyor")}</p>
              ) : (
                <>
                  <div className="mt-3 text-xl font-semibold tabular-nums">{money(r.totalInterestCents)}</div>
                  <div className="text-xs text-zinc-500">{t("toplam faiz")}</div>
                  <div className="mt-2 text-sm">
                    {t("{n} ay", { n: r.months })} · {formatDate(r.payoffDate)}
                  </div>
                  {r.extraInterestCents !== null && (
                    <div className="mt-1 text-xs">
                      {r.extraInterestCents >= 100 ? (
                        <span className="text-rose-600 dark:text-rose-400">{t("+{amount} fazla faiz", { amount: money(r.extraInterestCents) })}</span>
                      ) : (
                        <span className="text-zinc-500">{t("En iyiyle aynı sonuç")}</span>
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
          <h2 className="text-sm font-semibold">{STRATEGY_LABEL[selected]} · {t("aylık ödeme planı")}</h2>
          <span className="ml-auto text-xs text-zinc-500">
            {isManual
              ? t("Her borcun her ayki ödemesini hücreye yazın; boş hücreler 'Planım' kuralını kullanır (seçilmediyse ödeme yok).")
              : t("\"Borçlara ayrılan\" sütununda her ay için farklı tutar girebilirsiniz; boş aylar varsayılan tutarı kullanır.")}
          </span>
          {isManual && (Object.keys(rules).length > 0 || Object.keys(cells).length > 0) && (
            <button
              className="btn-secondary px-2.5 py-1 text-xs"
              title={t("Tüm kuralları ve hücrelere yazılan tutarları temizler")}
              onClick={async () => {
                const ok = await confirm({
                  title: t("Plan temizlensin mi?"),
                  message: t("Kendi planındaki tüm borç kuralları ve hücrelere yazdığın tutarlar silinir."),
                  confirmLabel: t("Temizle"),
                  danger: true,
                });
                if (ok) update({ debtRules: {}, debtCells: {} });
              }}
            >
              {t("Planı temizle")}
            </button>
          )}
        </div>
        {(constIncome || constFixed || current.payoffs.length > 0 || (isManual && planEmpty)) && (
          <div className={`space-y-2 border-b border-zinc-200 px-5 py-3 text-sm dark:border-zinc-800 ${dim}`}>
            {isManual && planEmpty && (
              <p className="text-zinc-600 dark:text-zinc-300">
                {rich(t("Başlamak için yukarıdaki tabloda her borcun {plan} kuralını seç (Tam öde, Asgari, Sabit tutar) ya da aşağıdaki hücrelere o ay ödeyeceğin tutarı yaz."), {
                  plan: <strong>{t("Planım")}</strong>,
                })}
              </p>
            )}
            {(constIncome || constFixed) && (
              <p className="text-zinc-500">
                {constIncome && (
                  <>
                    {t("Her ay gelir")} <strong className="tabular-nums text-emerald-600 dark:text-emerald-400">{money(rows[0].incomeCents)}</strong>
                  </>
                )}
                {constIncome && constFixed && " · "}
                {constFixed && (
                  <>
                    {t("düzenli gider")} <strong className="tabular-nums">{rows[0].fixedCents ? `−${money(rows[0].fixedCents)}` : t("yok")}</strong>
                  </>
                )}
              </p>
            )}
            {current.payoffs.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label={t("Borçların kapanış ayları")}>
                {current.payoffs.map((p) => {
                  const d = debtById.get(p.id);
                  return (
                    <li key={p.id} className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorOf(p.id) }} />
                      {d ? nameOf(d) : t("Silinmiş hesap")} · {t("bitiş")} <strong>{monthLabel(p.monthKey)}</strong>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        <div className={`overflow-x-auto ${dim}`} aria-busy={refreshing}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60">
                <th className="sticky left-0 z-10 whitespace-nowrap bg-zinc-50 px-4 py-2.5 dark:bg-zinc-900">{t("Ay")}</th>
                {!constIncome && <th className="whitespace-nowrap px-4 py-2.5 text-right">{t("Gelir")}</th>}
                {!constFixed && <th className="whitespace-nowrap px-4 py-2.5 text-right">{t("Düzenli gider")}</th>}
                <th
                  className="whitespace-nowrap px-4 py-2.5 text-right"
                  title={isManual ? undefined : t("Boş aylarda {amount} kullanılır", { amount: money(report.budgetCents) })}
                >
                  {isManual ? t("Gelirden kalan") : t("Borçlara ayrılan ({amount})", { amount: money(report.budgetCents) })}
                </th>
                {debts.map((d) => (
                  <th key={d.id} className={`max-w-[10rem] truncate whitespace-nowrap py-2.5 ${isManual ? "px-2 text-center" : "px-4 text-right"}`} title={nameOf(d)}>
                    {nameOf(d)}
                  </th>
                ))}
                <th className="px-4 py-2.5 text-right">{t("Toplam")}</th>
                <th className="px-4 py-2.5 text-right">{t("Kalan borç")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((row) => {
                const key = row.monthKey;
                return (
                  <tr key={row.month}>
                    <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-4 py-2 text-zinc-500 dark:bg-zinc-900">
                      {monthLabel(key)}
                      {row.salaryMonth !== key && <span className="ml-1 text-xs text-zinc-400">· {t("{month} maaşı", { month: monthName(row.salaryMonth) })}</span>}
                    </td>
                    {!constIncome && (
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{money(row.incomeCents)}</td>
                    )}
                    {!constFixed && (
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-zinc-500">{row.fixedCents ? `−${money(row.fixedCents)}` : "—"}</td>
                    )}
                    <td className="whitespace-nowrap px-2 py-1 text-right">
                      {isManual ? (
                        <span
                          className={`px-2 font-medium tabular-nums ${row.freeCents < 0 ? "text-rose-600 dark:text-rose-400" : "text-zinc-600 dark:text-zinc-300"}`}
                          title={t("Gelir − düzenli giderler − bu ayki borç ödemeleri")}
                        >
                          {money(row.freeCents)}
                        </span>
                      ) : selected === "minimum" ? (
                        <span className="text-zinc-400">—</span>
                      ) : (
                        <MonthBudgetInput
                          key={`${key}:${overrides[key] ?? ""}`}
                          value={overrides[key]}
                          placeholder=""
                          warn={row.overIncome}
                          onSave={(v) => setOverride(key, v)}
                        />
                      )}
                    </td>
                    {debts.map((d) => {
                      const pay = row.payments[d.id] ?? 0;
                      const left = row.balances[d.id] ?? 0;
                      if (!isManual)
                        return (
                          <td key={d.id} className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${pay ? "" : "text-zinc-300 dark:text-zinc-700"}`}>
                            {pay ? money(pay) : "—"}
                            {left === 0 && pay ? <span className="ml-1 text-emerald-500">✓</span> : null}
                          </td>
                        );
                      const cellKey = `${key}:${d.id}`;
                      const full = cells[cellKey] === PAY_FULL;
                      const closes = left === 0 && !!pay;
                      return (
                        <td key={d.id} className="whitespace-nowrap px-2 py-1 text-center">
                          {left === 0 && !pay ? (
                            <span className="px-2 text-zinc-300 dark:text-zinc-700">—</span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <MonthBudgetInput
                                key={`${cellKey}:${cells[cellKey] ?? ""}`}
                                value={full ? undefined : cells[cellKey]}
                                placeholder={pay ? amountToInput(pay / 100) : ""}
                                warn={false}
                                onSave={(v) => setCell(cellKey, v)}
                              />
                              <button
                                type="button"
                                title={full ? t("Geri al (kurala dön)") : t("Bu ayın tamamını öde")}
                                aria-label={
                                  full ? t("{name} tamamını ödeme işaretini kaldır", { name: nameOf(d) }) : t("{name} bu ayın tamamını öde", { name: nameOf(d) })
                                }
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
                            </span>
                          )}
                        </td>
                      );
                    })}
                    <td className="whitespace-nowrap px-4 py-2 text-right font-medium tabular-nums">{money(row.totalCents)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-zinc-500">{money(row.leftCents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {current.hasMore && (
          <p className="border-t border-zinc-100 px-5 py-2 text-xs text-zinc-500 dark:border-zinc-800">{t("İlk 24 ay gösteriliyor.")}</p>
        )}
      </section>

      <p className="mt-4 text-xs text-zinc-500">
        {t(
          "Simülasyon yeni harcama olmadığını ve faiz oranlarının sabit kaldığını varsayar; gerçek banka hesaplamalarından (günlük faiz, gecikme faizi) farklı olabilir. Çığ yöntemi genellikle en az faizi, Kartopu ise en hızlı \"borç kapatma\" motivasyonunu sağlar.",
        )}
      </p>
    </>
  );
}
