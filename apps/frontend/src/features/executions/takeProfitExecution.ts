import {
  UNKNOWN_DISPLAY,
  displayDecimal,
  displayPercentFromRatio,
  type DisplayValue,
} from "./executionFormat";
import type { TakeProfitExecution } from "../../api/executions.api";

/**
 * How an owned take profit actually executed, prepared for display.
 *
 * A TAKE_PROFIT_MARKET order controls its trigger and nothing after it: once
 * the trigger is touched the exchange fills at market, wherever that is. The
 * backend measures the gap; this module only decides how to say it.
 *
 * Nothing here recalculates. Every number is the backend's exact decimal
 * string, and the only arithmetic is turning a ratio into a percentage for the
 * label — the unverified fraction stays reachable in `exact`.
 */

export type TakeProfitVerdict = "ADVERSE" | "ON_TARGET" | "FAVOURABLE";

export interface TakeProfitExecutionView {
  verdict: TakeProfitVerdict;
  /** Short human label for the badge. */
  verdictLabel: string;
  /**
   * Badge tone. Adverse is YELLOW, not red: this is analytics about a trade
   * that already closed, not a runtime safety condition, and red is reserved
   * in this dashboard for states that need someone to act.
   */
  tone: "yellow" | "gray" | "green";
  triggerPrice: DisplayValue;
  actualExitPrice: DisplayValue;
  closedQuantity: DisplayValue;
  plannedGrossProfit: DisplayValue;
  actualGrossProfit: DisplayValue;
  /** planned - actual gross profit. Carries entry AND exit effects. */
  grossProfitShortfall: DisplayValue;
  /** Trigger versus fill, per unit. */
  slippagePrice: DisplayValue;
  /** Trigger versus fill, in dollars. Exit effect only. */
  slippageUsd: DisplayValue;
  /** Trigger versus fill as a share of the planned reward distance. */
  slippageRatio: DisplayValue;
}

/**
 * Signs, stated once so the UI never has to guess.
 *
 * POSITIVE is adverse — filled worse than the trigger — in BOTH directions;
 * the backend already normalizes LONG and SHORT onto the same axis. NEGATIVE
 * means the fill beat the trigger, which is a real result and is shown as
 * such rather than being flattened to zero. Exactly zero means filled at the
 * trigger.
 *
 * The verdict reads the RATIO rather than the dollar figure: both carry the
 * same sign, but the ratio is unit-free, so a large position cannot make an
 * ordinary fill look dramatic.
 */
function verdictFor(ratio: string): TakeProfitVerdict {
  const value = Number(ratio);
  if (!Number.isFinite(value) || value === 0) return "ON_TARGET";
  return value > 0 ? "ADVERSE" : "FAVOURABLE";
}

const VERDICT_LABEL: Record<TakeProfitVerdict, string> = {
  ADVERSE: "Adverse",
  ON_TARGET: "On target",
  FAVOURABLE: "Favourable",
};

const VERDICT_TONE: Record<TakeProfitVerdict, TakeProfitExecutionView["tone"]> = {
  ADVERSE: "yellow",
  ON_TARGET: "gray",
  FAVOURABLE: "green",
};

/**
 * Null in, null out.
 *
 * The backend returns null whenever the measurement would not be authoritative
 * — a stop or external closure, a missing price or quantity, a closure split
 * across two filled legs. That is NOT the same as "no slippage", so this
 * refuses to manufacture a view, and the caller hides the section entirely
 * rather than rendering $0 and 0%.
 */
export function presentTakeProfitExecution(
  telemetry: TakeProfitExecution | null | undefined
): TakeProfitExecutionView | null {
  if (!telemetry) return null;

  const verdict = verdictFor(telemetry.adverseSlippageRatio);

  return {
    verdict,
    verdictLabel: VERDICT_LABEL[verdict],
    tone: VERDICT_TONE[verdict],
    triggerPrice: displayDecimal(telemetry.triggerPrice),
    actualExitPrice: displayDecimal(telemetry.actualExitPrice),
    closedQuantity: displayDecimal(telemetry.closedQuantity),
    plannedGrossProfit: displayDecimal(telemetry.plannedGrossProfitUsd),
    actualGrossProfit: displayDecimal(telemetry.actualGrossProfitUsd),
    grossProfitShortfall: displayDecimal(telemetry.grossProfitShortfallUsd),
    slippagePrice: displayDecimal(telemetry.adverseSlippagePrice),
    slippageUsd: displayDecimal(telemetry.adverseSlippageUsd),
    slippageRatio: displayPercentFromRatio(telemetry.adverseSlippageRatio),
  };
}

/** Kept beside the view so a caller never re-derives the unknown marker. */
export const TAKE_PROFIT_UNKNOWN = UNKNOWN_DISPLAY;
