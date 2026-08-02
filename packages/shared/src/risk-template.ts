import Decimal from "decimal.js";

/**
 * Risk templates implement step-based fixed-capital money management: the
 * user plans risk against a manually chosen reference capital (e.g. USD 400)
 * that NEVER follows the real account balance. It only changes when the user
 * edits the template (e.g. stepping up to USD 1,000). Nothing in this module
 * may ever read an exchange balance, PnL, alerts, or outcomes.
 *
 * Derived amounts are recomputed from the stored fields on every read and are
 * never persisted or accepted from clients:
 *   riskAmount   = referenceCapital × (riskPercent / 100)
 *   targetAmount = riskAmount × rewardRatio
 */

// Same local constructor clone as futures-risk.ts: high precision, plain
// (non-exponential) string output, no mutation of the global decimal.js
// config other consumers might rely on.
const D = Decimal.clone({ precision: 40, toExpNeg: -30, toExpPos: 40 });

export interface RiskTemplateAmounts {
  /** referenceCapital × riskPercent / 100, as an exact decimal string. */
  riskAmount: string;
  /** riskAmount × rewardRatio, as an exact decimal string. */
  targetAmount: string;
}

export function calculateRiskTemplateAmounts(
  referenceCapital: string,
  riskPercent: string,
  rewardRatio: string
): RiskTemplateAmounts {
  const riskAmount = new D(referenceCapital).times(riskPercent).div(100);
  const targetAmount = riskAmount.times(rewardRatio);
  return { riskAmount: riskAmount.toString(), targetAmount: targetAmount.toString() };
}

/**
 * A risk template as serialized over the API. Decimal fields travel as exact
 * strings (same convention as TradeReview); riskAmount/targetAmount are
 * always freshly derived by the server from the stored fields.
 */
export interface RiskTemplate extends RiskTemplateAmounts {
  id: string;
  name: string;
  referenceCapital: string;
  riskPercent: string;
  rewardRatio: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
