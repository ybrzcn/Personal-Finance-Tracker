import { FileUp, Landmark, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { BankAccountCard, CreditCardCard, LoanCard } from "../components/AccountCards";
import { EmptyState, PageHeader, SummaryTile, type TileTone } from "../components/common";
import { DueIncomeBanner } from "../components/DueIncomeBanner";
import { netPosition } from "../lib/accounts";
import { expectedIncomeThisMonth } from "../lib/budget";
import { monthName } from "../lib/recurring";
import { todayISO } from "../lib/format";
import { useData } from "../state/data";
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
  const pos = useMemo(() => netPosition(accounts, transactions, today, rates), [accounts, transactions, today, rates]);
  const expected = useMemo(() => expectedIncomeThisMonth(transactions, recurring, today), [transactions, recurring, today]);
  const expectedHint = [
    expected.regularCents > 0 ? `Maaş ${formatMoney(expected.regularCents / 100)}` : "",
    expected.otherCents > 0 ? `Diğer ${formatMoney(expected.otherCents / 100)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const visible = accounts.filter((a) => showArchived || !a.archived);
  const cards = visible.filter((a) => a.kind === "credit_card");
  const banks = visible.filter((a) => a.kind === "bank" || a.kind === "cash");
  const loans = visible.filter((a) => a.kind === "loan");
  const hasArchived = accounts.some((a) => a.archived);

  const tiles = [
    { label: "Varlıklar", cents: pos.assetsCents, tone: "", color: "income" as TileTone, hint: "Bugüne kadarki bakiye" },
    {
      label: `Beklenen gelir · ${monthName(today.slice(0, 7))}`,
      cents: expected.totalCents,
      tone: expected.totalCents > 0 ? POS : "",
      hint: expectedHint || "Bu ay beklenen gelir yok",
    },
    { label: "Kart borcu", cents: pos.cardDebtCents, tone: "", color: "expense" as TileTone },
    { label: "Kredi borcu", cents: pos.loanDebtCents, tone: "", color: "expense" as TileTone },
    { label: "KMH kullanımı", cents: pos.overdraftCents, tone: pos.overdraftCents > 0 ? NEG : "" },
    { label: "Net durum", cents: pos.netCents, tone: "", color: "net" as TileTone },
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

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-6">
        {tiles.map((t) => (
          <SummaryTile
            key={t.label}
            label={t.label}
            value={formatMoney(t.cents / 100)}
            tone={"color" in t ? t.color : "plain"}
            valueClass={t.tone}
            hint={"hint" in t ? t.hint : undefined}
          />
        ))}
      </div>
      {pos.unvaluedCount > 0 && (
        <p className="-mt-4 mb-6 text-xs text-amber-700 dark:text-amber-300">
          {pos.unvaluedCount} döviz/altın hesabı kur alınamadığı için toplama katılmadı.
        </p>
      )}

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
        </div>
      )}
    </>
  );
}
