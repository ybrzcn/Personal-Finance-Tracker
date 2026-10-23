import { FileUp, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { openStatementFile } from "../lib/fileio";
import { formatDate, formatDateShort } from "../lib/format";
import { isForeign } from "../lib/fx";
import { locale, t, tm } from "../lib/i18n";
import { newId } from "../lib/id";
import type { ColumnMap, ImportRow, SignMode, StatementSummary, Transaction } from "../lib/types";
import { useData } from "../state/data";
import { useFormPreview } from "../state/formPreview";
import { useSettings } from "../state/settings";
import { AccountOptions } from "./AccountOptions";
import { Modal } from "./Modal";

interface Props {
  accountId?: string;
  onClose(): void;
  onSaved(message: string): void;
}

const COLUMN_LABELS: { key: keyof ColumnMap; label: string; required?: boolean }[] = [
  { key: "date", label: t("Tarih"), required: true },
  { key: "description", label: t("Açıklama") },
  { key: "amount", label: t("Tutar (tek sütun)") },
  { key: "debit", label: t("Borç / Çıkan") },
  { key: "credit", label: t("Alacak / Giren") },
  { key: "installments", label: t("Taksit") },
];

export function StatementImportDialog({ accountId: initialAccountId, onClose, onSaved }: Props) {
  const { accounts, categories, latest, restore, updateAccount } = useData();
  const { formatMoney } = useSettings();
  // Ekstre TL tutarlıdır: döviz/altın hesaplarına yüklenmez, transfer hedefi de olamaz
  const active = accounts.filter((a) => !a.archived && a.kind !== "loan" && !isForeign(a.currency));
  const [accountId, setAccountId] = useState(active.find((a) => a.id === initialAccountId)?.id ?? active[0]?.id ?? "");
  const account = accounts.find((a) => a.id === accountId);

  const [fileName, setFileName] = useState("");
  const [table, setTable] = useState<string[][]>([]);
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState<ColumnMap | null>(null);
  const [sign, setSign] = useState<SignMode>("negativeIsExpense");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [summary, setSummary] = useState<StatementSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const header = table[headerRow] ?? [];

  // Satırlar Rust'ta (finans-core::import). Sütunlar boşsa başlık satırından, işaret boşsa hesaptan tahmin edilir; ikisi de cevapla
  // seçicilere yazılır. Kesim tarihi: devam eden taksit paylarını bu ekstrenin dönemine tarihlemek için.
  // Yalnız son isteğin cevabı uygulanır; satır düzenlemeleri yalnız bu yeniden kurmalarda sıfırlanır
  // Yeni dosya ya da hesapta eski satırlar hemen kalkar; istek sürerken "İçe aktar" kapalıdır, başarısız olursa satırlar silinir
  // (başka dosyanın ya da hesabın satırları aktarılmasın)
  const rowsSeq = useRef(0);
  const [rowsPending, setRowsPending] = useState(false);
  const rebuild = async (
    tbl: string[][],
    h: number,
    m: ColumnMap | null,
    s: SignMode | null,
    accId: string,
    closing = summary?.closingDate ?? null,
    fresh = false,
  ) => {
    if (!accounts.some((a) => a.id === accId)) return;
    const n = ++rowsSeq.current;
    if (fresh) {
      setRows([]);
      setSkipped(0);
    }
    setRowsPending(true);
    try {
      const res = await api.statementRows({ table: tbl, headerRow: h, columns: m, signMode: s, accountId: accId, closingDate: closing });
      if (n !== rowsSeq.current) return;
      setRows(res.rows);
      setSkipped(res.skipped);
      setMap(res.columns);
      setSign(res.signMode);
      setError(null);
    } catch (e) {
      if (n !== rowsSeq.current) return;
      setRows([]);
      setSkipped(0);
      setError(errorMessage(e));
    } finally {
      if (n === rowsSeq.current) setRowsPending(false);
    }
  };

  // Dosya seçilip okunurken (sunucuda/mobilde büyük dosya sürebilir) ikinci kez başlatılmasın
  const [reading, setReading] = useState(false);

  const pickFile = async () => {
    if (reading) return;
    setError(null);
    setReading(true);
    try {
      const picked = await openStatementFile();
      if (!picked || !account) return;
      const file = { name: picked.name };
      // Okuma Rust'ta (tablo, başlık, sütunlar, özet)
      const { table: tbl, headerRow: h, columns: m, summary: sum } = picked.file;
      setFileName(file.name);
      setSummary(sum);
      setTable(tbl);
      setHeaderRow(h);
      setMap(m);
      await rebuild(tbl, h, m, null, account.id, sum?.closingDate ?? null, true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setReading(false);
    }
  };

  const updateMap = (key: keyof ColumnMap, value: number) => {
    if (!map) return;
    const m = { ...map, [key]: value };
    // Tek tutar sütunu seçildiyse borç/alacak kullanılmaz (ve tersi)
    if (key === "amount" && value >= 0) Object.assign(m, { debit: -1, credit: -1 });
    if ((key === "debit" || key === "credit") && value >= 0) m.amount = -1;
    setMap(m);
    void rebuild(table, headerRow, m, sign, accountId);
  };

  const patchRow = (i: number, patch: Partial<ImportRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const selected = rows.filter((r) => r.include);
  // Seçili satırların toplamı ve özetle uyumu (Rust)
  const totalsDraft = rows.length ? { rows: selected.map((r) => ({ amount: r.amount, type: r.type })), periodSpending: summary?.periodSpending ?? null } : null;
  const { preview: sums, source: sumsSource } = useFormPreview(totalsDraft, api.previewStatementTotals);
  // Özet uyumu yalnız şimdiki satırların sonucuyla gösterilir (başka dosyanın "birebir tutuyor" mesajı kalmasın)
  const sumsNow = sums && JSON.stringify(sumsSource) === JSON.stringify(totalsDraft) ? sums : null;
  const totals = { out: sums?.expense ?? 0, inc: sums?.income ?? 0 };

  // Ekstre özetindeki kesim/son ödeme/limit/faiz kart ayarlarından farklı mı (Rust)? Kartın ayarları yenileme anahtarıdır:
  // "Ekstreye göre güncelle"den sonra kendiliğinden yenilenir
  const { preview: card, source: cardSource } = useFormPreview(
    summary && account
      ? {
          accountId: account.id,
          summary,
          statementDay: account.statementDay,
          dueDay: account.dueDay,
          creditLimit: account.creditLimit,
          interestRate: account.interestRate,
          minPaymentRate: account.minPaymentRate,
          openingDate: account.openingDate,
        }
      : null,
    api.previewStatementCard,
  );
  // Önceki hesabın ya da önceki dosyanın özetinin sonucu gösterilmez (güncelle düğmesi eski farkı uygulamasın)
  const cardNow = card && cardSource?.accountId === accountId && JSON.stringify(cardSource.summary) === JSON.stringify(summary) ? card : null;
  const cardFix = cardNow?.cardFix ?? null;
  const beforeTracking = cardNow?.beforeTracking ?? false;
  const FIX_LABEL: Record<string, string> = {
    statementDay: t("kesim günü"),
    dueDay: t("son ödeme günü"),
    creditLimit: t("limit"),
    interestRate: t("faiz"),
    minPaymentRate: t("asgari oran"),
  };

  const doImport = async () => {
    if (!account || !selected.length) return;
    setSaving(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const newTxs: Transaction[] = selected.map((r) => ({
        id: newId(),
        amount: r.amount,
        type: r.type,
        accountId: account.id,
        toAccountId: r.type === "transfer" ? r.toAccountId : null,
        categoryId: r.type === "transfer" ? null : r.categoryId,
        date: r.date,
        description: r.description.slice(0, 200),
        installments: r.type === "expense" && account.kind === "credit_card" ? r.installments : 1,
        createdAt: now,
      }));
      const bad = newTxs.findIndex((tx) => tx.type === "transfer" && !tx.toAccountId);
      if (bad >= 0) throw t("{line}. satır: transfer için hedef hesap seçin.", { line: selected[bad].line });
      const data = await latest();
      await restore({ ...data, transactions: [...data.transactions, ...newTxs] });
      onSaved(t("{n} işlem {account} hesabına aktarıldı.", { n: newTxs.length, account: account.name }));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const typeValue = (r: ImportRow) => (r.type === "transfer" ? `transfer:${r.toAccountId ?? ""}` : r.type);
  const setType = (i: number, v: string) => {
    if (v.startsWith("transfer:")) patchRow(i, { type: "transfer", toAccountId: v.slice(9) || null, categoryId: null });
    else patchRow(i, { type: v as "income" | "expense", toAccountId: null, categoryId: null });
  };

  return (
    <Modal
      title={t("Ekstre İçe Aktar")}
      onClose={onClose}
      width="max-w-6xl"
      footer={
        <>
          {rows.length > 0 && (
            <span className="mr-auto self-center text-sm text-zinc-500">
              {t("{selected}/{total} satır seçili", { selected: selected.length, total: rows.length })} · {t("Gider")} {formatMoney(totals.out)} ·{" "}
              {t("Gelir")} {formatMoney(totals.inc)}
              {skipped > 0 && ` · ${t("{n} satır okunamadı", { n: skipped })}`}
            </span>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("Vazgeç")}
          </button>
          <button type="button" className="btn-primary" disabled={saving || rowsPending || !selected.length} onClick={doImport}>
            {t("İçe aktar")}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-80">
            <label className="label" htmlFor="si-account">
              {t("Hesap")}
            </label>
            <select
              id="si-account"
              className="input"
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                const acc = accounts.find((a) => a.id === e.target.value);
                if (acc && map) void rebuild(table, headerRow, map, null, acc.id, summary?.closingDate ?? null, true);
              }}
            >
              <AccountOptions accounts={active} />
            </select>
          </div>
          <button type="button" className="btn-secondary" onClick={pickFile} disabled={!account || reading} aria-busy={reading}>
            {reading ? <Loader2 size={16} className="animate-spin" /> : <FileUp size={16} />}{" "}
            {reading ? t("Dosya okunuyor…") : fileName ? t("Başka dosya seç") : t("Dosya seç (Excel, PDF, CSV)")}
          </button>
          {fileName && <span className="text-sm text-zinc-500">{fileName}</span>}
        </div>

        {!table.length && (
          <p className="text-sm text-zinc-500">
            {t(
              "Bankanızın internet şubesinden hesap hareketlerini veya kart ekstresini {excel}, {pdf} ya da {csv} olarak indirip seçin. Sütunlar otomatik tanınır; gerekirse aşağıdan düzeltebilirsiniz. Kategoriler geçmiş işlemlerinize ve bilinen işyeri adlarına göre önerilir. PDF'te tarihle başlayan satırlar okunur; şifreli PDF'leri önce şifresiz kaydedin. Excel en güvenilir sonucu verir.",
            )
              .split(/\{(excel|pdf|csv)\}/)
              .map((part, i) => (i % 2 ? <strong key={i}>{part === "excel" ? "Excel" : part.toUpperCase()}</strong> : part))}
          </p>
        )}

        {map && (
          <div className="grid grid-cols-2 gap-3 rounded-xl bg-zinc-50 p-3 md:grid-cols-4 lg:grid-cols-8 dark:bg-zinc-800/50">
            <div>
              <label className="label" htmlFor="si-header">
                {t("Başlık satırı")}
              </label>
              <select
                id="si-header"
                className="input"
                value={headerRow}
                onChange={(e) => {
                  const h = Number(e.target.value);
                  setHeaderRow(h);
                  void rebuild(table, h, null, sign, accountId);
                }}
              >
                {table.slice(0, 30).map((r, i) => (
                  <option key={i} value={i}>
                    {i + 1}: {r.filter(Boolean).slice(0, 3).join(" · ").slice(0, 40)}
                  </option>
                ))}
              </select>
            </div>
            {COLUMN_LABELS.map(({ key, label }) => (
              <div key={key}>
                <label className="label" htmlFor={`si-${key}`}>
                  {label}
                </label>
                <select id={`si-${key}`} className="input" value={map[key]} onChange={(e) => updateMap(key, Number(e.target.value))}>
                  <option value={-1}>—</option>
                  {header.map((h, i) => (
                    <option key={i} value={i}>
                      {h || t("Sütun {n}", { n: i + 1 })}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div>
              <label className="label" htmlFor="si-sign">
                {t("Harcama işareti")}
              </label>
              <select
                id="si-sign"
                className="input"
                value={sign}
                disabled={map.amount < 0}
                onChange={(e) => {
                  const s = e.target.value as SignMode;
                  setSign(s);
                  void rebuild(table, headerRow, map, s, accountId);
                }}
              >
                <option value="negativeIsExpense">{t("Eksi (−) = harcama")}</option>
                <option value="positiveIsExpense">{t("Artı (+) = harcama")}</option>
              </select>
            </div>
          </div>
        )}

        {summary && (
          <div className="space-y-2 rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <span className="font-medium">{t("Ekstre özeti")}</span>
              {summary.closingDate && <span className="text-zinc-500">{t("Kesim")} <strong className="text-zinc-900 dark:text-zinc-100">{formatDateShort(summary.closingDate)}</strong></span>}
              {summary.dueDate && <span className="text-zinc-500">{t("Son ödeme")} <strong className="text-zinc-900 dark:text-zinc-100">{formatDateShort(summary.dueDate)}</strong></span>}
              {summary.periodDebt !== null && <span className="text-zinc-500">{t("Dönem borcu")} <strong className="text-zinc-900 dark:text-zinc-100">{formatMoney(summary.periodDebt)}</strong></span>}
              {summary.creditLimit !== null && <span className="text-zinc-500">{t("Limit")} <strong className="text-zinc-900 dark:text-zinc-100">{formatMoney(summary.creditLimit)}</strong></span>}
              {summary.interestRate !== null && <span className="text-zinc-500">{t("Faiz")} <strong className="text-zinc-900 dark:text-zinc-100">{t("%{v}", { v: summary.interestRate.toLocaleString(locale) })}</strong></span>}
            </div>
            {summary.periodSpending !== null && rows.length > 0 && sumsNow && sumsNow.matchesSummary !== null && (
              sumsNow.matchesSummary ? (
                <p className="text-emerald-600 dark:text-emerald-400">
                  ✓ {t("Seçili satırların toplamı ekstredeki dönem içi harcamalarla ({amount}) birebir tutuyor.", { amount: formatMoney(summary.periodSpending) })}
                </p>
              ) : (
                <p className="text-amber-600 dark:text-amber-400">
                  {t("Seçili satırların toplamı {net}, ekstredeki dönem içi harcamalar {spending} (fark {diff}). Atlanan veya okunamayan satırları kontrol edin.", {
                    net: formatMoney(sumsNow.net),
                    spending: formatMoney(summary.periodSpending),
                    diff: formatMoney(sumsNow.difference ?? 0),
                  })}
                </p>
              )
            )}
            {beforeTracking && (
              <p className="text-amber-600 dark:text-amber-400">
                {t(
                  "Bu ekstre kartın takip başlangıcından önce kesilmiş; içe aktarılan harcamalar ödenmiş sayılır ve borca eklenmez. Gerekirse kart ayarlarından takip başlangıcını değiştirin.",
                )}
              </p>
            )}
            {cardFix && account && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-zinc-500">{t("Kart ayarlarınız ekstreden farklı ({fields}).", { fields: cardFix.differs.map((k) => FIX_LABEL[k]).join(", ") })}</span>
                <button
                  type="button"
                  className="btn-secondary px-2.5 py-1 text-xs"
                  onClick={async () => {
                    try {
                      await updateAccount({ ...account, ...cardFix.patch });
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                >
                  {t("Ekstreye göre güncelle")}
                </button>
              </div>
            )}
          </div>
        )}

        {rows.length > 0 && (
          <div className="max-h-[50vh] overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={t("Tümünü seç")}
                      checked={selected.length === rows.length}
                      onChange={(e) => setRows((rs) => rs.map((r) => ({ ...r, include: e.target.checked })))}
                    />
                  </th>
                  <th className="hidden w-28 px-3 py-2 md:table-cell">{t("Tarih")}</th>
                  <th className="px-3 py-2">{t("Açıklama")}</th>
                  <th className="hidden w-32 px-3 py-2 text-right md:table-cell">{t("Tutar")}</th>
                  <th className="hidden w-44 px-3 py-2 md:table-cell">{t("Tür")}</th>
                  <th className="hidden w-44 px-3 py-2 md:table-cell">{t("Kategori")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.map((r, i) => {
                  const typeSelect = (
                    <select className="input py-1 text-xs" aria-label={t("Tür")} value={typeValue(r)} onChange={(e) => setType(i, e.target.value)}>
                      <option value="expense">{t("Gider")}</option>
                      <option value="income">{t("Gelir / İade")}</option>
                      {accounts
                        .filter((a) => a.id !== accountId && !a.archived && !isForeign(a.currency))
                        .map((a) => (
                          <option key={a.id} value={`transfer:${a.id}`}>
                            {t("Transfer")} → {a.name}
                          </option>
                        ))}
                    </select>
                  );
                  const categorySelect =
                    r.type === "transfer" ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <select
                        className="input py-1 text-xs"
                        aria-label={t("Kategori")}
                        value={r.categoryId ?? ""}
                        onChange={(e) => patchRow(i, { categoryId: e.target.value || null })}
                      >
                        <option value="">{t("Kategorisiz")}</option>
                        {categories
                          .filter((c) => c.type === r.type)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    );
                  return (
                    <tr key={r.line} className={r.include ? "" : "opacity-50"}>
                      <td className="px-3 py-1.5 align-top md:align-middle">
                        <input type="checkbox" checked={r.include} onChange={(e) => patchRow(i, { include: e.target.checked })} />
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-1.5 tabular-nums md:table-cell">{formatDate(r.date)}</td>
                      <td className="px-3 py-1.5 md:max-w-0">
                        <div className="truncate" title={r.description}>
                          {r.description || "—"}
                          {r.installments > 1 && <span className="ml-1 text-xs text-zinc-500">({t("{n} taksit", { n: r.installments })})</span>}
                        </div>
                        {r.note && <div className="truncate text-xs text-amber-600 dark:text-amber-400">{tm(r.note)}</div>}
                        {/* Telefonda tarih, tutar, tür ve kategori açıklamanın altında */}
                        <div className="mt-1 space-y-1.5 md:hidden">
                          <div className="flex justify-between text-xs text-zinc-500">
                            <span>{formatDate(r.date)}</span>
                            <span className="font-medium tabular-nums text-zinc-800 dark:text-zinc-200">{formatMoney(r.amount)}</span>
                          </div>
                          {typeSelect}
                          {categorySelect}
                        </div>
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-1.5 text-right tabular-nums md:table-cell">{formatMoney(r.amount)}</td>
                      <td className="hidden px-3 py-1.5 md:table-cell">{typeSelect}</td>
                      <td className="hidden px-3 py-1.5 md:table-cell">{categorySelect}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {map && rows.length === 0 && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {t("Satır okunamadı. Tarih ve tutar (veya borç/alacak) sütunlarını kontrol edin.")}
          </p>
        )}
        {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">{error}</p>}
      </div>
    </Modal>
  );
}
