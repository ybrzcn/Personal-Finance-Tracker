import { isForeign } from "../lib/fx";
import { useState } from "react";
import { t, tm } from "../lib/i18n";
import type { Account } from "../lib/types";
import { AccountOptions } from "./AccountOptions";
import { Modal } from "./Modal";

interface Props {
  fileName: string;
  rowCount: number;
  skipped: { line: number; reason: string }[];
  hasAccountColumn: boolean;
  accounts: Account[];
  onConfirm(accountId: string): void;
  onClose(): void;
}

export function CsvImportDialog({ fileName, rowCount, skipped, hasAccountColumn, accounts, onConfirm, onClose }: Props) {
  // Varsayılan hesap TL olmalı: döviz/altın hesabına miktar ve kursuz satır yazılamaz
  const active = accounts.filter((a) => !a.archived && !isForeign(a.currency));
  const [accountId, setAccountId] = useState(active[0]?.id ?? "");

  return (
    <Modal
      title={t("CSV içe aktar")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t("Vazgeç")}
          </button>
          <button type="button" className="btn-primary" disabled={!accountId} onClick={() => onConfirm(accountId)}>
            {t("İçe aktar")}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-zinc-600 dark:text-zinc-300">
        <p>
          {t("{file} dosyasından {rows} mevcut verilerin üzerine eklenecek.")
            .split(/(\{file\}|\{rows\})/)
            .map((part, i) =>
              part === "{file}" ? (
                <strong key={i}>{fileName}</strong>
              ) : part === "{rows}" ? (
                <strong key={i}>{t("{n} işlem", { n: rowCount })}</strong>
              ) : (
                part
              ),
            )}
        </p>
        <div>
          <label className="label" htmlFor="csv-account">
            Hedef hesap
          </label>
          <select id="csv-account" data-autofocus className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <AccountOptions accounts={active} />
          </select>
          {hasAccountColumn && (
            <p className="mt-1 text-xs text-zinc-500">
              {t(`Dosyada "Hesap" sütunu var: adı eşleşen satırlar o hesaba, eşleşmeyenler seçilen hesaba eklenir.`)}
            </p>
          )}
        </div>
        {skipped.length > 0 && (
          <p className="text-amber-600 dark:text-amber-400">
            {t("{n} satır atlanacak (ör. satır {line}: {reason}).", { n: skipped.length, line: skipped[0].line, reason: tm(skipped[0].reason) })}
          </p>
        )}
      </div>
    </Modal>
  );
}
