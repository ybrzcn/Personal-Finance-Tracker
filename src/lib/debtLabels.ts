import type { DebtRuleMode, DebtStrategy } from "./types";

/** "Kendi planım"da borç başına ödeme kuralı (ayarlarda saklanan biçim) */
export interface DebtRule {
  mode: DebtRuleMode;
  /** Yalnız "fixed": aylık tutar (TL) */
  amount?: number;
}

export const STRATEGY_LABEL: Record<DebtStrategy, string> = {
  avalanche: "En yüksek faizliden başla (Çığ)",
  snowball: "En küçük borçtan başla (Kartopu)",
  custom: "Benim sıramla (hesap sırası)",
  minimum: "Yalnız asgari / taksit",
  manual: "Kendi planım",
};

export const DEBT_RULE_LABEL: Record<DebtRuleMode, string> = {
  full: "Tam öde",
  minimum: "Asgari",
  fixed: "Sabit tutar",
  none: "Ödeme yok",
};
