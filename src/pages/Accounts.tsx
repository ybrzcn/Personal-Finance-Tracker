import { FileUp, Landmark, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { BankAccountCard, CreditCardCard, LoanCard } from "../components/AccountCards";
import { EmptyState, PageHeader } from "../components/common";
import { DueIncomeBanner } from "../components/DueIncomeBanner";
import { netPosition } from "../lib/accounts";
import { expectedIncomeThisMonth } from "../lib/budget";
import { monthName } from "../lib/recurring";
import { todayISO } from "../lib/format";
import { useData } from "../state/data";
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

  const pos = useMemo(() => netPosition(accounts, transactions, today), [accounts, transactions, today]);
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
    { label: "Varlıklar", cents: pos.assetsCents, tone: "", hint: "Bugüne kadarki bakiye" },
    {
      label: `Beklenen gelir · ${monthName(today.slice(0, 7))}`,
      cents: expected.totalCents,
      tone: expected.totalCents > 0 ? POS : "",
      hint: expectedHint || "Bu ay beklenen gelir yok",
    },
    { label: "Kart borcu", cents: pos.cardDebtCents, tone: pos.cardDebtCents > 0 ? NEG : "" },
    { label: "Kredi borcu", cents: pos.loanDebtCents, tone: pos.loanDebtCents > 0 ? NEG : "" },
    { label: "KMH kullanımı", cents: pos.overdraftCents, tone: pos.overdraftCents > 0 ? NEG : "" },
    { label: "Net durum", cents: pos.netCents, tone: pos.netCents >= 0 ? POS : NEG },
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
          <div key={t.label} className="card min-w-0 p-4">
            <div className="truncate text-xs text-zinc-500">{t.label}</div>
            <div className={`mt-1 whitespace-nowrap text-xl font-semibold tabular-nums ${t.tone}`}>{formatMoney(t.cents / 100)}</div>
            {"hint" in t && t.hint && <div className="mt-0.5 truncate text-xs text-zinc-500" title={t.hint}>{t.hint}</div>}
          </div>
        ))}
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
        </div>
      )}
    </>
  );
}
