import { t } from "../lib/i18n";
import { ACCOUNT_KIND_LABEL, type Account, type AccountKind } from "../lib/types";

const GROUP_LABEL: Record<AccountKind, string> = {
  bank: t("Vadesiz Hesaplar"),
  cash: t("Nakit"),
  credit_card: t("Kredi Kartları"),
  loan: t("Krediler"),
};
const ORDER: AccountKind[] = ["bank", "credit_card", "cash", "loan"];

/** Hesapları türe göre gruplanmış `<option>` listesi (seçim kutusunda tür etiketi metni kırpmasın diye). */
export function AccountOptions({ accounts }: { accounts: Account[] }) {
  return (
    <>
      {ORDER.map((kind) => {
        const list = accounts.filter((a) => a.kind === kind);
        if (!list.length) return null;
        return (
          <optgroup key={kind} label={GROUP_LABEL[kind] ?? ACCOUNT_KIND_LABEL[kind]}>
            {list.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.archived ? ` (${t("arşiv")})` : ""}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}
