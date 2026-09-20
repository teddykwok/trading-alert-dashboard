import Decimal from "decimal.js";

/**
 * Extreme RR planning: the alert price is the entry, the take-profit is the
 * FROZEN pre-alert extreme (highest high for LONG, lowest low for SHORT —
 * never both), and the stop loss is derived backwards from the risk template's
 * fixed reward ratio:
 *
 *   LONG:  TP = highestHigh; reward = TP − entry; risk = reward / RR; SL = entry − risk
 *   SHORT: TP = lowestLow;   reward = entry − TP; risk = reward / RR; SL = entry + risk
 *
 * Candidates are computed once from candles that CLOSED before the alert's
 * triggeredAt and never drift with later market data. All arithmetic uses
 * decimal.js; results are exact plain decimal strings.
 */

// Same local constructor clone as futures-risk.ts: high precision, plain
// string output, no mutation of the global decimal.js config.
const D = Decimal.clone({ precision: 40, toExpNeg: -30, toExpPos: 40 });

// ---------------------------------------------------------------------------
// Centralized planner configuration (single checked-in source — no scattered
// magic numbers in UI or backend).
// ---------------------------------------------------------------------------

// Ordered shortest-to-longest. ONE fetch of max(...) feeds every candidate,
// so adding a SHORTER lookback costs no extra exchange weight: it is a
// trailing slice of a dataset already in hand.
export const EXTREME_RR_LOOKBACKS = [50, 100, 200, 300] as const;
export type ExtremeRRLookback = (typeof EXTREME_RR_LOOKBACKS)[number];

export const EXTREME_RR_DEFAULT_LOOKBACK: ExtremeRRLookback = 300;

/**
 * The ONE membership test for the lookback vocabulary.
 *
 * Deliberately narrow: it accepts a number that IS one of the supported
 * lookbacks and nothing else. No coercion, no nearest-match, no default — a
 * value nobody recognises must never quietly become 300, because that would
 * plan a trade against a window the operator did not choose.
 */
export function isExtremeRRLookback(value: unknown): value is ExtremeRRLookback {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (EXTREME_RR_LOOKBACKS as readonly number[]).includes(value)
  );
}

export const EXTREME_RR_LEVERAGE_PRESETS = [5, 10, 15, 20, 25] as const;
export type ExtremeRRLeverage = (typeof EXTREME_RR_LEVERAGE_PRESETS)[number];

/**
 * The user's preferred estimated isolated-margin band, in USD.
 *
 * INFORMATIONAL ONLY — this band belongs to the dashboard's preset table
 * (`buildLeverageAnalysis`) and is deliberately NOT the execution policy. The
 * execution engine has its own band, configured through BINANCE_MIN_MARGIN_USD
 * and BINANCE_MAX_MARGIN_MULTIPLIER, and currently recommends 5.50–8.00 at a
 * 1.50 risk budget. The two do not agree, and that is a known divergence, not
 * an oversight: this model applies no exchange filters, no leverage brackets
 * and no liquidation estimate, so its numbers could not safely drive a trade.
 * A test pins that these constants never reach the execution path.
 *
 * Reconciling the two bands is a separate future branch — deliberately not
 * folded into the margin-policy work, because wiring a presentation constant
 * into execution is exactly the change that needs its own review.
 */
export const EXTREME_RR_PREFERRED_MARGIN_MIN = "6";
export const EXTREME_RR_PREFERRED_MARGIN_MAX = "10";

export const EXTREME_RR_STATUSES = ["PENDING", "READY", "INVALID", "ERROR"] as const;
export type ExtremeRRPlanStatus = (typeof EXTREME_RR_STATUSES)[number];

export const EXTREME_RR_QUEUE_NAME = "extreme-rr-plan";

export const EXTREME_RR_MARGIN_DISCLAIMER =
  "Estimated isolated margin. Actual liquidation depends on exchange maintenance margin and symbol rules.";

export const EXTREME_RR_LEVERAGE_UNVERIFIED_NOTE =
  "Exchange leverage limit not verified — confirm the selected leverage is supported on Binance before trading.";

export const EXTREME_RR_UNROUNDED_NOTE =
  "Unrounded values — exchange tick/step precision metadata is not available in this dashboard.";

/**
 * Decimal-exact extreme of a list of plain decimal strings (candle highs or
 * lows) — no float round-trips.
 */
export function extremeOfDecimalStrings(values: string[], kind: "max" | "min"): string {
  if (values.length === 0) {
    throw new Error("extremeOfDecimalStrings requires at least one value");
  }
  let extreme = new D(values[0]);
  for (const value of values) {
    const current = new D(value);
    if (kind === "max" ? current.gt(extreme) : current.lt(extreme)) {
      extreme = current;
    }
  }
  return extreme.toString();
}

// ---------------------------------------------------------------------------
// Candidate price geometry
// ---------------------------------------------------------------------------

export type ExtremeType = "HIGHEST_HIGH" | "LOWEST_LOW";

export interface ExtremeCandidateInput {
  direction: "LONG" | "SHORT";
  /** Entry basis is always the alert price. */
  entryPrice: string;
  /** Highest high (LONG) or lowest low (SHORT) of the frozen lookback window. */
  extremePrice: string;
  /** Fixed reward ratio from the risk-template snapshot; null when none was active. */
  rewardRatio: string | null;
}

export interface ExtremeCandidateGeometry {
  valid: boolean;
  invalidReason: string | null;
  extremeType: ExtremeType;
  takeProfit: string | null;
  stopLoss: string | null;
  rewardDistance: string | null;
  riskDistance: string | null;
  /** Always equals the template reward ratio by construction; stored as a cross-check. */
  riskRewardRatio: string | null;
}

export function calculateExtremeCandidate(input: ExtremeCandidateInput): ExtremeCandidateGeometry {
  const entry = new D(input.entryPrice);
  const extreme = new D(input.extremePrice);
  const extremeType: ExtremeType = input.direction === "LONG" ? "HIGHEST_HIGH" : "LOWEST_LOW";

  const invalid = (reason: string, partial?: Partial<ExtremeCandidateGeometry>): ExtremeCandidateGeometry => ({
    valid: false,
    invalidReason: reason,
    extremeType,
    takeProfit: null,
    stopLoss: null,
    rewardDistance: null,
    riskDistance: null,
    riskRewardRatio: null,
    ...partial,
  });

  if (input.direction === "LONG") {
    // LONG uses ONLY the highest high — the lowest low never participates.
    if (extreme.lte(entry)) {
      return invalid(
        `Highest high (${extreme.toString()}) is not above entry (${entry.toString()}) — no valid LONG target in this lookback`
      );
    }
    const rewardDistance = extreme.minus(entry);
    if (input.rewardRatio === null) {
      return invalid(
        "No active risk template at generation time — a reward ratio is required to derive the stop loss",
        { takeProfit: extreme.toString(), rewardDistance: rewardDistance.toString() }
      );
    }
    const riskDistance = rewardDistance.div(input.rewardRatio);
    const stopLoss = entry.minus(riskDistance);
    if (stopLoss.lte(0)) {
      return invalid("Calculated stop loss is not positive", {
        takeProfit: extreme.toString(),
        rewardDistance: rewardDistance.toString(),
      });
    }
    // Guaranteed by construction, asserted anyway: stopLoss < entry < takeProfit.
    if (!(stopLoss.lt(entry) && entry.lt(extreme))) {
      return invalid("LONG validation failed: expected stopLoss < entry < takeProfit");
    }
    return {
      valid: true,
      invalidReason: null,
      extremeType,
      takeProfit: extreme.toString(),
      stopLoss: stopLoss.toString(),
      rewardDistance: rewardDistance.toString(),
      riskDistance: riskDistance.toString(),
      riskRewardRatio: rewardDistance.div(riskDistance).toString(),
    };
  }

  // SHORT uses ONLY the lowest low — the highest high never participates.
  if (extreme.gte(entry)) {
    return invalid(
      `Lowest low (${extreme.toString()}) is not below entry (${entry.toString()}) — no valid SHORT target in this lookback`
    );
  }
  const rewardDistance = entry.minus(extreme);
  if (input.rewardRatio === null) {
    return invalid(
      "No active risk template at generation time — a reward ratio is required to derive the stop loss",
      { takeProfit: extreme.toString(), rewardDistance: rewardDistance.toString() }
    );
  }
  const riskDistance = rewardDistance.div(input.rewardRatio);
  const stopLoss = entry.plus(riskDistance);
  // Guaranteed by construction, asserted anyway: takeProfit < entry < stopLoss.
  if (!(extreme.lt(entry) && entry.lt(stopLoss))) {
    return invalid("SHORT validation failed: expected takeProfit < entry < stopLoss");
  }
  return {
    valid: true,
    invalidReason: null,
    extremeType,
    takeProfit: extreme.toString(),
    stopLoss: stopLoss.toString(),
    rewardDistance: rewardDistance.toString(),
    riskDistance: riskDistance.toString(),
    riskRewardRatio: rewardDistance.div(riskDistance).toString(),
  };
}

// ---------------------------------------------------------------------------
// Money management (from the frozen risk-template snapshot)
// ---------------------------------------------------------------------------

export interface ExtremeMoneyInput {
  entryPrice: string;
  riskDistance: string;
  rewardDistance: string;
  /** riskAmount from the frozen template snapshot. */
  riskAmount: string;
}

export interface ExtremeMoney {
  /** riskAmount / |entry − stopLoss| — UNROUNDED (no exchange step metadata). */
  quantityRaw: string;
  plannedLossRaw: string;
  plannedProfitRaw: string;
  positionNotionalRaw: string;
}

export function calculateExtremeMoney(input: ExtremeMoneyInput): ExtremeMoney {
  const riskDistance = new D(input.riskDistance);
  const quantityRaw = new D(input.riskAmount).div(riskDistance);
  return {
    quantityRaw: quantityRaw.toString(),
    plannedLossRaw: quantityRaw.times(riskDistance).toString(),
    plannedProfitRaw: quantityRaw.times(input.rewardDistance).toString(),
    positionNotionalRaw: quantityRaw.times(input.entryPrice).toString(),
  };
}

// ---------------------------------------------------------------------------
// Leverage presets -> estimated isolated margin
// ---------------------------------------------------------------------------

export interface ExtremeLeverageOption {
  leverage: ExtremeRRLeverage;
  /** positionNotional / leverage — an estimate only, see EXTREME_RR_MARGIN_DISCLAIMER. */
  estimatedInitialMargin: string;
  /** True when the estimate falls inside the configured preferred USD band. */
  preferred: boolean;
  /** True when the estimated margin is <= the planned loss budget (warning). */
  marginAtOrBelowRisk: boolean;
}

export interface ExtremeLeverageAnalysis {
  positionNotional: string;
  options: ExtremeLeverageOption[];
  /** When no preset lands in the preferred band: the closest one, informational only. */
  closestToPreferred: ExtremeRRLeverage | null;
}

// ---------------------------------------------------------------------------
// API DTO shapes (decimals travel as exact strings; dates as ISO strings)
// ---------------------------------------------------------------------------

/** One frozen lookback candidate as serialized by the API. */
export interface ExtremeRRCandidate extends ExtremeCandidateGeometry {
  requestedCandles: ExtremeRRLookback;
  /** Honest count — may be lower than requested when history was short. */
  actualCandles: number;
  /** False when fewer than the requested candles were available. */
  complete: boolean;
  extremePrice: string | null;
  oldestCandleOpenTime: string | null;
  newestCandleCloseTime: string | null;
  /** Money management for this candidate; null without a template snapshot or when invalid. */
  money: (ExtremeMoney & { leverage: ExtremeLeverageAnalysis }) | null;
}

/** Frozen risk-template snapshot embedded in a plan. */
export interface ExtremeRRTemplateSnapshot {
  riskTemplateId: string | null;
  name: string;
  referenceCapital: string;
  riskPercent: string;
  rewardRatio: string;
  riskAmount: string;
  targetAmount: string;
}

/**
 * What the selected-plan executor decided about this plan, if it ever ran.
 *
 * Historical, not derived. The refusal is recorded when it happens, so a plan
 * refused at 12:00 for want of authorization still says so at 15:00 when an
 * authorization exists again. Nothing here may be recomputed from current
 * capacity, claims, positions, risk or runtime mode — inferring it later is
 * precisely the unsafe behaviour this record exists to replace.
 *
 * `null` on the plan means no decision was ever recorded: either the executor
 * has not run, or the alert predates this evidence being stored at all. Both
 * are honestly "unknown" and must not be presented as a reason.
 */
export interface SelectedPlanOutcomeDto {
  /** False for a pre-execution refusal; true when an execution was reached. */
  handled: boolean;
  /** The executor's canonical code, verbatim. Never re-interpreted. */
  reasonCode: string | null;
  /** The executor's own sentence, when it had one. Never a UI string. */
  message: string | null;
  /** Present only when handled — the execution remains authoritative for it. */
  executionId: string | null;
  /** When the decision was actually taken. */
  evaluatedAt: string;
}

/**
 * ONE account's own verdict on a plan. Canonical after Phase 11E.
 *
 * There is exactly one of these per execution profile that evaluated the
 * plan, and two accounts may legitimately disagree -- account A admitting
 * while account B refuses is a correct outcome, not a conflict to resolve.
 * So these are never merged, ranked or collapsed.
 */
export interface SelectedPlanAccountOutcomeDto {
  /** The evaluating profile's row id. Never an exchange account alias. */
  executionProfileId: string;
  /** False for a pre-execution refusal; true when an execution was reached. */
  handled: boolean;
  /** The executor's canonical code, verbatim. Never re-interpreted. */
  reasonCode: string | null;
  /** The executor's own sentence, when it had one. Never a UI string. */
  message: string | null;
  /** Present only when handled — the execution remains authoritative for it. */
  executionId: string | null;
  /** When the decision was actually taken. */
  evaluatedAt: string;
}

export interface ExtremeRRPlanDto {
  id: string;
  alertId: string;
  status: ExtremeRRPlanStatus;
  direction: "LONG" | "SHORT";
  entryBasis: "ALERT_PRICE";
  entryPrice: string;
  /** Frozen candle cutoff — the alert's triggeredAt. */
  cutoffAt: string;
  timeframe: string;
  template: ExtremeRRTemplateSnapshot | null;
  candidates: ExtremeRRCandidate[];
  selectedLookback: ExtremeRRLookback;
  selectedLeverage: ExtremeRRLeverage | null;
  /** No exchange tick/step metadata is available — values are unrounded. */
  precision: "UNROUNDED";
  /** No verified symbol leverage-limit source exists — never claimed as supported. */
  leverageLimitVerified: false;
  errorReason: string | null;
  /**
   * The executor's recorded verdict on this plan, or null when none exists.
   *
   * Carried on the plan because Alert Detail already loads the plan for exactly
   * this question, so exposing it here needs no new endpoint and no second
   * fetch. It stays a structured domain object rather than a formatted
   * sentence: presentation belongs to the frontend's shared reason vocabulary,
   * not to the API.
   */
  /**
   * Every account's verdict, one entry per profile that finished evaluating.
   *
   * Ordered by executionProfileId so the list is stable between reads; the
   * order carries no precedence and must not be read as any.
   */
  executionOutcomes: SelectedPlanAccountOutcomeDto[];
  /**
   * Compatibility projection of the above, and null whenever projecting one
   * would be a lie.
   *
   * Exactly one account evaluated  -> that account's verdict, unambiguous.
   * Two or more accounts evaluated -> NULL. There is no overall verdict to
   *   report, and picking the latest, the first or any other arbitrary one
   *   would present one account's decision as the system's.
   * No account evaluated           -> the pre-11E SelectedPlanOutcome row if
   *   one exists, which is how historical plans keep their explanation.
   *
   * Read `executionOutcomes` for anything that must be correct with more
   * than one account.
   */
  executionOutcome: SelectedPlanOutcomeDto | null;
  generatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function buildLeverageAnalysis(
  positionNotional: string,
  riskAmount: string | null
): ExtremeLeverageAnalysis {
  const notional = new D(positionNotional);
  const min = new D(EXTREME_RR_PREFERRED_MARGIN_MIN);
  const max = new D(EXTREME_RR_PREFERRED_MARGIN_MAX);
  const bandCenter = min.plus(max).div(2);

  const options: ExtremeLeverageOption[] = EXTREME_RR_LEVERAGE_PRESETS.map((leverage) => {
    const margin = notional.div(leverage);
    return {
      leverage,
      estimatedInitialMargin: margin.toString(),
      preferred: margin.gte(min) && margin.lte(max),
      marginAtOrBelowRisk: riskAmount !== null && margin.lte(riskAmount),
    };
  });

  let closestToPreferred: ExtremeRRLeverage | null = null;
  if (!options.some((option) => option.preferred)) {
    let best: { leverage: ExtremeRRLeverage; distance: Decimal } | null = null;
    for (const option of options) {
      const distance = new D(option.estimatedInitialMargin).minus(bandCenter).abs();
      if (!best || distance.lt(best.distance)) {
        best = { leverage: option.leverage, distance };
      }
    }
    closestToPreferred = best?.leverage ?? null;
  }

  return { positionNotional: notional.toString(), options, closestToPreferred };
}
