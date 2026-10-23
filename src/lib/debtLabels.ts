import type { DebtRuleMode, DebtStrategy } from "./types";
import { t } from "./i18n";

/** "Kendi planım"da borç başına ödeme kuralı (ayarlarda saklanan biçim) */
export interface DebtRule {
  mode: DebtRuleMode;
  /** Yalnız "fixed": aylık tutar (TL) */
  amount?: number;
}

export const STRATEGY_LABEL: Record<DebtStrategy, string> = {
  avalanche: t("En yüksek faizliden başla (Çığ)"),
  snowball: t("En küçük borçtan başla (Kartopu)"),
  custom: t("Benim sıramla (hesap sırası)"),
  minimum: t("Yalnız asgari / taksit"),
  manual: t("Kendi planım"),
};

export const DEBT_RULE_LABEL: Record<DebtRuleMode, string> = {
  full: t("Tam öde"),
  minimum: t("Asgari"),
  fixed: t("Sabit tutar"),
  none: t("Ödeme yok"),
};
