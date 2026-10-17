import { FileUp, Landmark, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { BankAccountCard, CreditCardCard, FundAccountCard, LoanCard } from "../components/AccountCards";
import { EmptyState, PageHeader, SummaryTile, type TileTone } from "../components/common";
import { DueIncomeBanner } from "../components/DueIncomeBanner";
import { NetWorthCard } from "../components/NetWorthCard";
import { netPosition } from "../lib/accounts";
import { backend } from "../lib/platform";
import { expectedIncomeThisMonth } from "../lib/budget";
import { isFund } from "../lib/fx";
import { monthName } from "../lib/recurring";
import { todayISO } from "../lib/format";
import { useData } from "../state/data";
import { useNetWorth } from "../state/networth";
import { useRates } from "../state/rates";
import { useSettings } from "../state/settings";
import { useUI } from "../state/ui";

const NEG = "text-rose-600 dark:text-rose-400";
const POS = "text-emerald-600 dark:text-emerald-400";

export function Accounts() {
  const { accounts, transactions, recurring } = useData();
  const { formatMoney } = useSettings();
  const { openAccountForm, openStatementImport } = useUI();
  const [showArchived, setShowArchived] = useState(false);
  const today = todayISO();

  const { rates } = useRates();
  const nw = useNetWorth();
  const localPos = useMemo(
    () => (backend === "local" ? netPosition(accounts, transactions, today, rates) : null),
    [accounts, transactions, today, rates],
  );
  const last = nw.report?.points.at(-1);
  // Kutular Rust raporunun son noktasından; tarayıcı modunda TS hesabı
  const pos =
    localPos ??
    (last
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
        : null);
  const expected = useMemo(() => expectedIncomeThisMonth(transactions, recurring, today), [transactions, recurring, today]);
  const expectedHint = [
    expected.regularCents > 0 ? `Maaş ${formatMoney(expected.regularCents / 100)}` : "",
    expected.otherCents > 0 ? `Diğer ${formatMoney(expected.otherCents / 100)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const visible = accounts.filter((a) => showArchived || !a.archived);
  const cards = visible.filter((a) => a.kind === "credit_card");
  const banks = visible.filter((a) => (a.kind === "bank" || a.kind === "cash") && !isFund(a.currency));
  const funds = visible.filter((a) => isFund(a.currency));
  const loans = visible.filter((a) => a.kind === "loan");
  const hasArchived = accounts.some((a) => a.archived);

  // Kart bileşenleri (ekstre hesabı) ileri tarihli harcamayı da gösterir; kutu tarihi gelince sayar
  const cardIds = new Set(accounts.filter((a) => a.kind === "credit_card").map((a) => a.id));
  const futureCard = transactions.some((t) => t.date > today && cardIds.has(t.accountId) && t.type !== "income");
  const tiles = [
    { label: "Varlıklar", cents: pos?.assetsCents ?? null, tone: "", color: "income" as TileTone, hint: "Bugüne kadarki bakiye" },
    {
      label: `Beklenen gelir · ${monthName(today.slice(0, 7))}`,
      cents: expected.totalCents,
      tone: expected.totalCents > 0 ? POS : "",
      hint: expectedHint || "Bu ay beklenen gelir yok",
    },
    {
      label: "Kart borcu",
      cents: pos?.cardDebtCents ?? null,
      tone: "",
      color: "expense" as TileTone,
      hint: futureCard ? "İleri tarihli harcamalar tarihinde eklenir" : null,
    },
    { label: "Kredi borcu", cents: pos?.loanDebtCents ?? null, tone: "", color: "expense" as TileTone },
    { label: "KMH kullanımı", cents: pos?.overdraftCents ?? null, tone: (pos?.overdraftCents ?? 0) > 0 ? NEG : "" },
    { label: "Net durum", cents: pos?.netCents ?? null, tone: "", color: "net" as TileTone },
  ];

  return (
    <>
      <PageHeader
        title="Hesaplar"
        subtitle="Vadesiz hesaplar, nakit ve kredi kartları"
        actions={
          <>
            {hasArchived && (
              <button className="btn-secondary" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? "Arşivlenenleri gizle" : "Arşivlenenleri göster"}
              </button>
            )}
            <button className="btn-secondary" onClick={() => openStatementImport()}>
              <FileUp size={16} /> Ekstre Yükle
            </button>
            <button className="btn-primary" onClick={() => openAccountForm()}>
              <Plus size={16} /> Yeni Hesap
            </button>
          </>
        }
      />

      <DueIncomeBanner />

      {nw.error && (
        <div role="alert" className="card mb-4 flex items-center justify-between gap-3 px-5 py-4 text-sm">
          <span className="text-rose-600 dark:text-rose-400">
            {pos ? `Güncellenemedi; gösterilen değerler eski olabilir (${nw.error})` : `Net servet hesaplanamadı: ${nw.error}`}
          </span>
          <button className="btn-secondary px-3 py-1.5 text-xs" onClick={nw.reload}>
            Tekrar dene
          </button>
        </div>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-6">
        {tiles.map((t) => (
          <SummaryTile
            key={t.label}
            label={t.label}
            value={t.cents === null ? "…" : formatMoney(t.cents / 100)}
            tone={"color" in t ? t.color : "plain"}
            valueClass={t.tone}
            hint={"hint" in t ? t.hint : undefined}
          />
        ))}
      </div>
      {(pos?.unvaluedCount ?? 0) > 0 && (
        <p className="-mt-4 mb-6 text-xs text-amber-700 dark:text-amber-300">
          {pos?.unvaluedCount} döviz/altın hesabı kur alınamadığı için toplama katılmadı.
        </p>
      )}
      <div className="mb-6">
        {backend === "local" ? (
          <p className="text-xs text-zinc-500">Net servet geçmişi sunucu ya da masaüstü uygulaması gerektirir.</p>
        ) : (
          <NetWorthCard report={nw.report} error={nw.error} />
        )}
      </div>

      {visible.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Landmark}
            title="Henüz hesap yok"
            hint="Vadesiz hesabınızı, nakdinizi ve kredi kartlarınızı ekleyin."
            action={
              <button className="btn-primary" onClick={() => openAccountForm()}>
                <Plus size={16} /> Hesap Ekle
              </button>
            }
          />
        </div>
      ) : (
        <div className="space-y-6">
          {cards.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold">Kredi Kartları</h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {cards.map((a) => (
                  <CreditCardCard key={a.id} account={a} />
                ))}
              </div>
            </div>
          )}
          {loans.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold">Krediler</h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {loans.map((a) => (
                  <LoanCard key={a.id} account={a} />
                ))}
              </div>
            </div>
          )}
          {banks.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold">Banka ve Nakit</h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {banks.map((a) => (
                  <BankAccountCard key={a.id} account={a} />
                ))}
              </div>
            </div>
          )}
          {funds.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold">Yatırımlar</h2>
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
