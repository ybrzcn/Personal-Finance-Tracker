import { FileUp, Landmark, Plus } from "lucide-react";
import { useState } from "react";
import { BankAccountCard, CreditCardCard, FundAccountCard, LoanCard } from "../components/AccountCards";
import { EmptyState, PageHeader, SummaryTile, type TileTone } from "../components/common";
import { DueIncomeBanner } from "../components/DueIncomeBanner";
import { NetWorthCard } from "../components/NetWorthCard";
import { isFund } from "../lib/fx";
import { monthName } from "../lib/recurring";
import { todayISO } from "../lib/format";
import { useAccountsReport } from "../state/accountsReport";
import { useData } from "../state/data";
import { useIncomeStatus } from "../state/incomeStatus";
import { useNetWorth } from "../state/networth";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";
import { t, tm } from "../lib/i18n";

const NEG = "text-rose-600 dark:text-rose-400";
const POS = "text-emerald-600 dark:text-emerald-400";

export function Accounts() {
  const { accounts, transactions } = useData();
  const { formatMoney } = useSettings();
  const { openAccountForm, openStatementImport } = useUI();
  const [showArchived, setShowArchived] = useState(false);
  const today = todayISO();

  const nw = useNetWorth();
  const ar = useAccountsReport();
  const last = nw.report?.points.at(-1);
  // Kutular Rust raporunun son noktasından
  const pos =
    last
      ? {
          assetsCents: last.assetsCents,
          cardDebtCents: last.cardDebtCents,
          loanDebtCents: last.loanDebtCents,
          overdraftCents: last.overdraftCents,
          netCents: last.netCents,
          unvaluedCount: last.unvaluedCount,
        }
      : nw.report
        ? { assetsCents: 0, cardDebtCents: 0, loanDebtCents: 0, overdraftCents: 0, netCents: 0, unvaluedCount: 0 }
        : null;
  // Beklenen gelir Rust'ta hesaplanır; yokken "…" bekleniyor, "—" hata
  const inc = useIncomeStatus();
  const expected = inc.status?.expected ?? null;
  const expectedPlaceholder = inc.loading && !inc.error ? "…" : "—";
  const expectedHint = [
    expected && expected.regularCents > 0 ? t("Maaş {amount}", { amount: formatMoney(expected.regularCents / 100) }) : "",
    expected && expected.otherCents > 0 ? t("Diğer {amount}", { amount: formatMoney(expected.otherCents / 100) }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const visible = accounts.filter((a) => showArchived || !a.archived);
  const cards = visible.filter((a) => a.kind === "credit_card");
  const banks = visible.filter((a) => (a.kind === "bank" || a.kind === "cash") && !isFund(a.currency) && !a.subtype);
  // Vadeli mevduat, BES, ev/araba: harcanabilir nakitten ayrı
  const savings = visible.filter((a) => !!a.subtype);
  const funds = visible.filter((a) => isFund(a.currency));
  const loans = visible.filter((a) => a.kind === "loan");
  const hasArchived = accounts.some((a) => a.archived);

  // Kart bileşenleri (ekstre hesabı) ileri tarihli harcamayı da gösterir; kutu tarihi gelince sayar
  const cardIds = new Set(accounts.filter((a) => a.kind === "credit_card").map((a) => a.id));
  const futureCard = transactions.some((t) => t.date > today && cardIds.has(t.accountId) && t.type !== "income");
  const tiles = [
    { label: t("Varlıklar"), cents: pos?.assetsCents ?? null, tone: "", color: "income" as TileTone, hint: t("Bugüne kadarki bakiye") },
    {
      label: `${t("Beklenen gelir")} · ${monthName(today.slice(0, 7))}`,
      cents: expected?.totalCents ?? null,
      placeholder: expectedPlaceholder,
      tone: (expected?.totalCents ?? 0) > 0 ? POS : "",
      hint: expected ? expectedHint || t("Bu ay beklenen gelir yok") : null,
    },
    {
      label: t("Kart borcu"),
      cents: pos?.cardDebtCents ?? null,
      tone: "",
      color: "expense" as TileTone,
      hint: futureCard ? t("İleri tarihli harcamalar tarihinde eklenir") : null,
    },
    { label: t("Kredi borcu"), cents: pos?.loanDebtCents ?? null, tone: "", color: "expense" as TileTone },
    { label: t("KMH kullanımı"), cents: pos?.overdraftCents ?? null, tone: (pos?.overdraftCents ?? 0) > 0 ? NEG : "" },
    { label: t("Net durum"), cents: pos?.netCents ?? null, tone: "", color: "net" as TileTone },
  ];

  return (
    <>
      <PageHeader
        title={t("Hesaplar")}
        subtitle={t("Vadesiz hesaplar, nakit ve kredi kartları")}
        actions={
          <>
            {hasArchived && (
              <button className="btn-secondary" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? t("Arşivlenenleri gizle") : t("Arşivlenenleri göster")}
              </button>
            )}
            <button className="btn-secondary" onClick={() => openStatementImport()}>
              <FileUp size={16} /> {t("Ekstre Yükle")}
            </button>
            <button className="btn-primary" onClick={() => openAccountForm()}>
              <Plus size={16} /> {t("Yeni Hesap")}
            </button>
          </>
        }
      />

      {ar.error && (
        <div role="alert" className="card mb-4 flex items-center justify-between gap-3 px-5 py-4 text-sm">
          <span className="text-rose-600 dark:text-rose-400">{t("Hesap özetleri alınamadı: {error}", { error: tm(ar.error) })}</span>
          <button className="btn-secondary px-3 py-1.5 text-xs" onClick={ar.reload}>
            {t("Tekrar dene")}
          </button>
        </div>
      )}
      <DueIncomeBanner />

      {nw.error && (
        <div role="alert" className="card mb-4 flex items-center justify-between gap-3 px-5 py-4 text-sm">
          <span className="text-rose-600 dark:text-rose-400">
            {pos
              ? t("Güncellenemedi; gösterilen değerler eski olabilir ({error})", { error: tm(nw.error) })
              : t("Net servet hesaplanamadı: {error}", { error: tm(nw.error) })}
          </span>
          <button className="btn-secondary px-3 py-1.5 text-xs" onClick={nw.reload}>
            {t("Tekrar dene")}
          </button>
        </div>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-6">
        {tiles.map((t) => (
          <SummaryTile
            key={t.label}
            label={t.label}
            value={t.cents === null ? ("placeholder" in t && t.placeholder) || "…" : formatMoney(t.cents / 100)}
            tone={"color" in t ? t.color : "plain"}
            valueClass={t.tone}
            hint={"hint" in t ? t.hint : undefined}
          />
        ))}
      </div>
      {(pos?.unvaluedCount ?? 0) > 0 && (
        <p className="-mt-4 mb-6 text-xs text-amber-700 dark:text-amber-300">
          {t("{n} döviz/altın hesabı kur alınamadığı için toplama katılmadı.", { n: pos?.unvaluedCount ?? 0 })}
        </p>
      )}
      <div className="mb-6">
        <NetWorthCard report={nw.report} error={nw.error} />
      </div>

      {visible.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Landmark}
            title={t("Henüz hesap yok")}
            hint={t("Vadesiz hesabınızı, nakdinizi ve kredi kartlarınızı ekleyin.")}
            action={
              <button className="btn-primary" onClick={() => openAccountForm()}>
                <Plus size={16} /> {t("Hesap Ekle")}
              </button>
            }
          />
        </div>
      ) : (
        <div className="space-y-6">
          {cards.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold">{t("Kredi Kartları")}</h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {cards.map((a) => (
                  <CreditCardCard key={a.id} account={a} />
                ))}
              </div>
            </div>
          )}
          {loans.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold">{t("Krediler")}</h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {loans.map((a) => (
                  <LoanCard key={a.id} account={a} />
                ))}
              </div>
            </div>
          )}
          {banks.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold">{t("Banka ve Nakit")}</h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {banks.map((a) => (
                  <BankAccountCard key={a.id} account={a} />
                ))}
              </div>
            </div>
          )}
          {savings.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold">{t("Birikim ve Varlıklar")}</h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {savings.map((a) => (
                  <BankAccountCard key={a.id} account={a} />
                ))}
              </div>
            </section>
          )}
          {funds.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold">{t("Yatırımlar")}</h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {funds.map((a) => (
                  <FundAccountCard key={a.id} account={a} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}
