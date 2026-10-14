import { FileUp, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { errorMessage } from "../lib/api";
import { openStatementFile } from "../lib/fileio";
import { formatDate, formatDateShort } from "../lib/format";
import { newId } from "../lib/id";
import { firstTrackedClosing } from "../lib/cards";
import {
  buildImportRows,
  defaultSignMode,
  extractStatementSummary,
  findHeaderRow,
  guessColumns,
  statementToTable,
  type ColumnMap,
  type ImportRow,
  type SignMode,
  type StatementSummary,
} from "../lib/statementImport";
import type { Transaction } from "../lib/types";
import { useData } from "../state/data";
import { useSettings } from "../state/settings";
import { AccountOptions } from "./AccountOptions";
import { Modal } from "./Modal";

interface Props {
  accountId?: string;
  onClose(): void;
  onSaved(message: string): void;
}

const COLUMN_LABELS: { key: keyof ColumnMap; label: string; required?: boolean }[] = [
  { key: "date", label: "Tarih", required: true },
  { key: "description", label: "Açıklama" },
  { key: "amount", label: "Tutar (tek sütun)" },
  { key: "debit", label: "Borç / Çıkan" },
  { key: "credit", label: "Alacak / Giren" },
  { key: "installments", label: "Taksit" },
];

export function StatementImportDialog({ accountId: initialAccountId, onClose, onSaved }: Props) {
  const { accounts, categories, transactions, latest, restore, updateAccount } = useData();
  const { formatMoney, settings } = useSettings();
  const active = accounts.filter((a) => !a.archived && a.kind !== "loan");
  const [accountId, setAccountId] = useState(initialAccountId ?? active[0]?.id ?? "");
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

  const rebuild = (t: string[][], h: number, m: ColumnMap, s: SignMode, accId: string) => {
    const acc = accounts.find((a) => a.id === accId);
    if (!acc) return;
    const res = buildImportRows(t, h, m, s, acc, accounts, transactions, categories, settings.categoryRules);
    setRows(res.rows);
    setSkipped(res.skipped);
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
      const t = statementToTable(picked.file);
      if (t.length < 2)
        throw picked.file.kind === "pdf"
          ? "PDF'te tarih ve tutar içeren işlem satırı bulunamadı. Bankadan Excel veya CSV indirmeyi deneyin."
          : "Dosyada okunabilir satır bulunamadı.";
      const h = findHeaderRow(t);
      const m = guessColumns(t[h]);
      const s = defaultSignMode(account);
      setFileName(file.name);
      const text = picked.file.kind === "table" ? picked.file.rows.map((r) => r.join(" ")).join("\n") : picked.file.text;
      const sum = extractStatementSummary(text);
      setSummary(Object.values(sum).some((v) => v !== null) ? sum : null);
      setTable(t);
      setHeaderRow(h);
      setMap(m);
      setSign(s);
      rebuild(t, h, m, s, account.id);
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
    rebuild(table, headerRow, m, sign, accountId);
  };

  const patchRow = (i: number, patch: Partial<ImportRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const selected = rows.filter((r) => r.include);
  const totals = useMemo(() => {
    let out = 0;
    let inc = 0;
    for (const r of selected) {
      if (r.type === "expense") out += r.amount;
      else if (r.type === "income") inc += r.amount;
    }
    return { out, inc };
  }, [selected]);

  // Ekstre özetindeki kesim/son ödeme/limit/faiz kart ayarlarından farklı mı?
  const cardFix = useMemo(() => {
    if (!summary || account?.kind !== "credit_card") return null;
    const day = (iso: string | null) => (iso ? Number(iso.slice(8, 10)) : null);
    const patch = {
      statementDay: day(summary.closingDate) ?? account.statementDay,
      dueDay: day(summary.dueDate) ?? account.dueDay,
      creditLimit: summary.creditLimit ?? account.creditLimit,
      interestRate: summary.interestRate ?? account.interestRate,
      minPaymentRate: summary.minPaymentRate ?? account.minPaymentRate,
    };
    const differs = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => patch[k] !== account[k]);
    return differs.length ? { patch, differs } : null;
  }, [summary, account]);
  const beforeTracking = !!(summary?.closingDate && account?.kind === "credit_card" && summary.closingDate < firstTrackedClosing(account));
  const FIX_LABEL: Record<string, string> = {
    statementDay: "kesim günü",
    dueDay: "son ödeme günü",
    creditLimit: "limit",
    interestRate: "faiz",
    minPaymentRate: "asgari oran",
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
      const bad = newTxs.findIndex((t) => t.type === "transfer" && !t.toAccountId);
      if (bad >= 0) throw `${selected[bad].line}. satır: transfer için hedef hesap seçin.`;
      const data = await latest();
      await restore({ ...data, transactions: [...data.transactions, ...newTxs] });
      onSaved(`${newTxs.length} işlem ${account.name} hesabına aktarıldı.`);
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
      title="Ekstre İçe Aktar"
      onClose={onClose}
      width="max-w-6xl"
      footer={
        <>
          {rows.length > 0 && (
            <span className="mr-auto self-center text-sm text-zinc-500">
              {selected.length}/{rows.length} satır seçili · Gider {formatMoney(totals.out)} · Gelir {formatMoney(totals.inc)}
              {skipped > 0 && ` · ${skipped} satır okunamadı`}
            </span>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            Vazgeç
          </button>
          <button type="button" className="btn-primary" disabled={saving || !selected.length} onClick={doImport}>
            İçe aktar
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-80">
            <label className="label" htmlFor="si-account">
              Hesap
            </label>
            <select
              id="si-account"
              className="input"
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                const acc = accounts.find((a) => a.id === e.target.value);
                if (acc && map) {
                  const s = defaultSignMode(acc);
                  setSign(s);
                  rebuild(table, headerRow, map, s, acc.id);
                }
              }}
            >
              <AccountOptions accounts={active} />
            </select>
          </div>
          <button type="button" className="btn-secondary" onClick={pickFile} disabled={!account || reading} aria-busy={reading}>
            {reading ? <Loader2 size={16} className="animate-spin" /> : <FileUp size={16} />}{" "}
            {reading ? "Dosya okunuyor…" : fileName ? "Başka dosya seç" : "Dosya seç (Excel, PDF, CSV)"}
          </button>
          {fileName && <span className="text-sm text-zinc-500">{fileName}</span>}
        </div>

        {!table.length && (
          <p className="text-sm text-zinc-500">
            Bankanızın internet şubesinden hesap hareketlerini veya kart ekstresini <strong>Excel</strong>, <strong>PDF</strong> ya da{" "}
            <strong>CSV</strong> olarak indirip seçin. Sütunlar otomatik tanınır; gerekirse aşağıdan düzeltebilirsiniz. Kategoriler
            geçmiş işlemlerinize ve bilinen işyeri adlarına göre önerilir. PDF'te tarihle başlayan satırlar okunur; şifreli PDF'leri
            önce şifresiz kaydedin. Excel en güvenilir sonucu verir.
          </p>
        )}

        {map && (
          <div className="grid grid-cols-2 gap-3 rounded-xl bg-zinc-50 p-3 md:grid-cols-4 lg:grid-cols-8 dark:bg-zinc-800/50">
            <div>
              <label className="label" htmlFor="si-header">
                Başlık satırı
              </label>
              <select
                id="si-header"
                className="input"
                value={headerRow}
                onChange={(e) => {
                  const h = Number(e.target.value);
                  const m = guessColumns(table[h] ?? []);
                  setHeaderRow(h);
                  setMap(m);
                  rebuild(table, h, m, sign, accountId);
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
                      {h || `Sütun ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div>
              <label className="label" htmlFor="si-sign">
                Harcama işareti
              </label>
              <select
                id="si-sign"
                className="input"
                value={sign}
                disabled={map.amount < 0}
                onChange={(e) => {
                  const s = e.target.value as SignMode;
                  setSign(s);
                  rebuild(table, headerRow, map, s, accountId);
                }}
              >
                <option value="negativeIsExpense">Eksi (−) = harcama</option>
                <option value="positiveIsExpense">Artı (+) = harcama</option>
              </select>
            </div>
          </div>
        )}

        {summary && (
          <div className="space-y-2 rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <span className="font-medium">Ekstre özeti</span>
              {summary.closingDate && <span className="text-zinc-500">Kesim <strong className="text-zinc-900 dark:text-zinc-100">{formatDateShort(summary.closingDate)}</strong></span>}
              {summary.dueDate && <span className="text-zinc-500">Son ödeme <strong className="text-zinc-900 dark:text-zinc-100">{formatDateShort(summary.dueDate)}</strong></span>}
              {summary.periodDebt !== null && <span className="text-zinc-500">Dönem borcu <strong className="text-zinc-900 dark:text-zinc-100">{formatMoney(summary.periodDebt)}</strong></span>}
              {summary.creditLimit !== null && <span className="text-zinc-500">Limit <strong className="text-zinc-900 dark:text-zinc-100">{formatMoney(summary.creditLimit)}</strong></span>}
              {summary.interestRate !== null && <span className="text-zinc-500">Faiz <strong className="text-zinc-900 dark:text-zinc-100">%{summary.interestRate.toLocaleString("tr-TR")}</strong></span>}
            </div>
            {summary.periodSpending !== null && rows.length > 0 && (
              Math.abs(totals.out - totals.inc - summary.periodSpending) < 0.01 ? (
                <p className="text-emerald-600 dark:text-emerald-400">✓ Seçili satırların toplamı ekstredeki dönem içi harcamalarla ({formatMoney(summary.periodSpending)}) birebir tutuyor.</p>
              ) : (
                <p className="text-amber-600 dark:text-amber-400">
                  Seçili satırların toplamı {formatMoney(totals.out - totals.inc)}, ekstredeki dönem içi harcamalar {formatMoney(summary.periodSpending)} (fark{" "}
                  {formatMoney(Math.abs(totals.out - totals.inc - summary.periodSpending))}). Atlanan veya okunamayan satırları kontrol edin.
                </p>
              )
            )}
            {beforeTracking && (
              <p className="text-amber-600 dark:text-amber-400">
                Bu ekstre kartın takip başlangıcından önce kesilmiş; içe aktarılan harcamalar ödenmiş sayılır ve borca eklenmez. Gerekirse kart
                ayarlarından takip başlangıcını değiştirin.
              </p>
            )}
            {cardFix && account && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-zinc-500">Kart ayarlarınız ekstreden farklı ({cardFix.differs.map((k) => FIX_LABEL[k]).join(", ")}).</span>
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
                  Ekstreye göre güncelle
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
                      aria-label="Tümünü seç"
                      checked={selected.length === rows.length}
                      onChange={(e) => setRows((rs) => rs.map((r) => ({ ...r, include: e.target.checked })))}
                    />
                  </th>
                  <th className="hidden w-28 px-3 py-2 md:table-cell">Tarih</th>
                  <th className="px-3 py-2">Açıklama</th>
                  <th className="hidden w-32 px-3 py-2 text-right md:table-cell">Tutar</th>
                  <th className="hidden w-44 px-3 py-2 md:table-cell">Tür</th>
                  <th className="hidden w-44 px-3 py-2 md:table-cell">Kategori</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.map((r, i) => {
                  const typeSelect = (
                    <select className="input py-1 text-xs" aria-label="Tür" value={typeValue(r)} onChange={(e) => setType(i, e.target.value)}>
                      <option value="expense">Gider</option>
                      <option value="income">Gelir / İade</option>
                      {accounts
                        .filter((a) => a.id !== accountId && !a.archived)
                        .map((a) => (
                          <option key={a.id} value={`transfer:${a.id}`}>
                            Transfer → {a.name}
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
                        aria-label="Kategori"
                        value={r.categoryId ?? ""}
                        onChange={(e) => patchRow(i, { categoryId: e.target.value || null })}
                      >
                        <option value="">Kategorisiz</option>
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
                          {r.installments > 1 && <span className="ml-1 text-xs text-zinc-500">({r.installments} taksit)</span>}
                        </div>
                        {r.note && <div className="truncate text-xs text-amber-600 dark:text-amber-400">{r.note}</div>}
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
            Satır okunamadı. Tarih ve tutar (veya borç/alacak) sütunlarını kontrol edin.
          </p>
        )}
        {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">{error}</p>}
      </div>
    </Modal>
  );
}
