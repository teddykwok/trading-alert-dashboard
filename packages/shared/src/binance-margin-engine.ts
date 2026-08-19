import Decimal from "decimal.js";

/**
 * Phase 3 — Dynamic Leverage and Isolated Margin Engine (CALCULATION ONLY).
 *
 * Pure and deterministic: no network, no environment, no logging, no database.
 * It recommends a leverage; it never applies one. Nothing here can place an
 * order or change any Binance account setting.
 *
 * Locked policy implemented (docs/binance-execution-policy.md): USDⓈ-M
 * futures, Hedge Mode expected, ISOLATED margin, LIMIT entry, plan-locked and
 * risk-capped. Entry/SL stay frozen; quantity comes from the risk budget and
 * the entry-to-stop distance and always rounds DOWN, so rounding can only
 * reduce planned risk. Fees and funding are out of scope for v1 sizing.
 *
 * All arithmetic uses decimal.js. No Number(), parseFloat() or JS float math
 * touches a price, quantity, notional, margin or liquidation value; plain
 * integers are used only for leverage and bracket indices.
 */

// Same local constructor clone as futures-risk.ts / extreme-rr.ts.
const D = Decimal.clone({ precision: 40, toExpNeg: -30, toExpPos: 40 });

export const MARGIN_ENGINE_DEFAULTS = {
  targetMarginMultiplier: "2.5",
  maximumMarginMultiplier: "3.333333",
  liquidationBufferRatio: "0.5",
  /**
   * Minimum isolated margin in USD. "0" means DISABLED, which is the historical
   * behaviour: no lower bound and closest-to-target selection. Any positive
   * value switches the selector into floor mode — see `MARGIN_SELECTION_MODES`.
   */
  minimumMarginUsd: "0",
  /** Hard user-side ceiling for automation leverage, independent of Binance. */
  userMaximumAutomationLeverage: 25,
} as const;

/**
 * How the winner was picked among liquidation-safe candidates.
 *
 * - CLOSEST_TO_TARGET: the historical rule — minimize |margin − targetMargin|.
 *   Symmetric, so it can and does prefer a margin BELOW the target.
 * - SMALLEST_ABOVE_FLOOR: with a positive minimum configured, the smallest
 *   margin that is still at or above the floor.
 *
 * Reported on every plan so an operator can tell which rule produced a
 * leverage without re-deriving it from the configuration.
 */
export const MARGIN_SELECTION_MODES = ["CLOSEST_TO_TARGET", "SMALLEST_ABOVE_FLOOR"] as const;
export type MarginSelectionMode = (typeof MARGIN_SELECTION_MODES)[number];

/**
 * Candidate rejection strings, named so the post-loop diagnosis classifies on
 * the same values the loop wrote. These used to be inline literals compared by
 * hand further down — one edit away from a silent mis-diagnosis.
 */
const REJECTED_ABOVE_MAXIMUM = "estimated margin exceeds the maximum isolated margin";
const REJECTED_BELOW_MINIMUM = "estimated margin is below the minimum isolated margin";
const REJECTED_LIQUIDATION_UNSAFE = "estimated liquidation price is inside the required safety buffer";

/** Bracket re-resolution passes allowed before the estimate is declared unstable. */
const MAX_BRACKET_ITERATIONS = 8;

export const MARGIN_PLAN_STATUSES = [
  "READY",
  "SKIPPED",
  "INVALID",
  "LIQUIDATION_ESTIMATE_UNAVAILABLE",
] as const;
export type MarginPlanStatus = (typeof MARGIN_PLAN_STATUSES)[number];

export const MARGIN_PLAN_REASONS = [
  "INVALID_ENTRY",
  "INVALID_STOP_RELATION",
  "INVALID_RISK_BUDGET",
  "INVALID_MULTIPLIERS",
  "ENTRY_PRICE_BELOW_MINIMUM",
  "ENTRY_PRICE_ABOVE_MAXIMUM",
  "ENTRY_PRICE_NOT_TICK_ALIGNED",
  "STOP_PRICE_BELOW_MINIMUM",
  "STOP_PRICE_ABOVE_MAXIMUM",
  "STOP_PRICE_NOT_TICK_ALIGNED",
  "USER_LEVERAGE_CAP_PREVENTS_SAFE_PLAN",
  "SYMBOL_NOT_TRADING",
  "UNSUPPORTED_CONTRACT",
  "QUANTITY_ROUNDS_TO_ZERO",
  "BELOW_MIN_QUANTITY",
  "ABOVE_MAX_QUANTITY",
  "BELOW_MIN_NOTIONAL",
  "LEVERAGE_BRACKET_UNAVAILABLE",
  "NOTIONAL_OUTSIDE_BRACKETS",
  "REQUIRED_MARGIN_EXCEEDS_MAXIMUM",
  "MARGIN_FLOOR_EXCEEDS_MAXIMUM",
  "NO_LEVERAGE_MEETS_MARGIN_FLOOR",
  "LIQUIDATION_ESTIMATE_UNAVAILABLE",
  "NO_LIQUIDATION_SAFE_LEVERAGE",
] as const;
export type MarginPlanReason = (typeof MARGIN_PLAN_REASONS)[number];

/** Contract types this project plans for. */
export const SUPPORTED_CONTRACT_TYPES = ["PERPETUAL"] as const;

/**
 * Where the stop loss came from, which decides how tick misalignment is handled.
 *
 * - CALCULATED (default): the strategy derived it (e.g. an Extreme RR plan),
 *   so it is a mathematical price that need not sit on the exchange grid. It
 *   is normalized conservatively AWAY from entry onto the tick.
 * - EXECUTION_LOCKED: the caller states this exact price is already an
 *   executable, committed price. It is never silently moved; misalignment
 *   fails closed with STOP_PRICE_NOT_TICK_ALIGNED.
 *
 * The LIMIT entry price is always treated as execution-locked and is never
 * rounded, whatever this value is.
 */
export const STOP_LOSS_SOURCES = ["CALCULATED", "EXECUTION_LOCKED"] as const;
export type StopLossSource = (typeof STOP_LOSS_SOURCES)[number];

/** Marker set when a calculated stop was moved onto the exchange tick grid. */
export const STOP_PRICE_NORMALIZED_TO_TICK = "STOP_PRICE_NORMALIZED_TO_TICK" as const;

// ---------------------------------------------------------------------------
// Inputs (narrow, engine-owned — no raw Binance payloads)
// ---------------------------------------------------------------------------

export interface MarginPlanSymbolFilters {
  status: string | null;
  contractType: string | null;
  /**
   * PRICE_FILTER. Plan-locked entry/stop prices must satisfy these exactly —
   * a non-executable price fails closed, it is never silently rounded.
   * Zero-valued components mean the component is disabled (Binance's own
   * convention) and are skipped.
   */
  tickSize: string | null;
  minPrice: string | null;
  maxPrice: string | null;
  /** LOT_SIZE — the LIMIT-order quantity filter (never MARKET_LOT_SIZE). */
  stepSize: string | null;
  minQty: string | null;
  maxQty: string | null;
  minNotional: string | null;
}

export interface MarginPlanLeverageBracket {
  bracket: number | null;
  initialLeverage: number | null;
  notionalFloor: string | null;
  notionalCap: string | null;
  maintMarginRatio: string | null;
  cum: string | null;
}

export interface DynamicLeveragePlanInput {
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: string;
  stopLoss: string;
  /** Defaults to CALCULATED — see STOP_LOSS_SOURCES. */
  stopLossSource?: StopLossSource;
  riskBudgetUsd: string;
  targetMarginMultiplier?: string;
  maximumMarginMultiplier?: string;
  /**
   * Absolute minimum isolated margin in USD. Zero (the default) DISABLES the
   * floor and keeps closest-to-target selection; any positive value both
   * rejects candidates below it and switches the selector to "smallest margin
   * at or above the floor".
   *
   * Absolute dollars rather than a risk multiplier because the reason for a
   * floor is absolute — a position whose margin is a few dollars sits close to
   * liquidation and is dominated by fees regardless of what its risk budget
   * happens to be. It is deliberately NOT expressed against `riskBudgetUsd`,
   * so raising the risk budget cannot quietly raise the floor with it.
   */
  minimumMarginUsd?: string;
  liquidationBufferRatio?: string;
  /**
   * User-side automation leverage ceiling (positive integer, default 25).
   * The usable maximum is min(bracket initialLeverage, this value); it is
   * NEVER derived from the symbol's currently configured leverage, and the
   * engine never applies any leverage anywhere.
   */
  userMaximumAutomationLeverage?: number;
  filters: MarginPlanSymbolFilters;
  brackets: MarginPlanLeverageBracket[];
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface LeverageCandidateSummary {
  leverage: number;
  estimatedInitialMargin: string;
  estimatedLiquidationPrice: string | null;
  marginDifferenceFromTarget: string;
  eligible: boolean;
  rejectionReason: string | null;
}

export interface ResolvedBracketSummary {
  bracket: number | null;
  initialLeverage: number | null;
  notionalFloor: string | null;
  notionalCap: string | null;
  maintMarginRatio: string | null;
  cum: string | null;
}

export interface DynamicLeveragePlan {
  status: MarginPlanStatus;
  reason: MarginPlanReason | null;
  reasonMessage: string | null;

  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: string;
  /**
   * The EXECUTABLE stop used by every downstream calculation. Equals
   * executableStopLoss (i.e. the tick-normalized value when normalization
   * applied, otherwise the supplied stop).
   */
  stopLoss: string;
  /** The stop exactly as supplied by the strategy, before normalization. */
  calculatedStopLoss: string;
  /** The stop after conservative tick alignment; identical when no move was needed. */
  executableStopLoss: string;
  /** executableStopLoss − calculatedStopLoss (negative for LONG, positive for SHORT); null when unchanged. */
  stopAdjustment: string | null;
  /** STOP_PRICE_NORMALIZED_TO_TICK when the stop was moved, else null. */
  stopNormalization: typeof STOP_PRICE_NORMALIZED_TO_TICK | null;
  stopLossSource: StopLossSource;
  stopDistance: string | null;
  riskBudgetUsd: string;

  quantityRaw: string | null;
  roundedQuantity: string | null;
  quantityStepSize: string | null;
  actualPlannedLoss: string | null;
  unusedRiskBudget: string | null;
  positionNotional: string | null;
  minimumNotional: string | null;

  targetMarginMultiplier: string;
  maximumMarginMultiplier: string;
  /** The configured floor, echoed back. "0" means the floor is disabled. */
  minimumMarginUsd: string;
  targetIsolatedMargin: string | null;
  maximumIsolatedMargin: string | null;
  /** The effective floor, or null when the floor is disabled. */
  minimumIsolatedMargin: string | null;
  /** Which rule chose `selectedLeverage`; set from the configuration, always present. */
  marginSelectionMode: MarginSelectionMode;

  applicableBracket: ResolvedBracketSummary | null;
  /** Bracket initialLeverage (kept for compatibility; equals binanceMaximumSupportedLeverage). */
  maximumSupportedLeverage: number | null;
  binanceMaximumSupportedLeverage: number | null;
  userMaximumAutomationLeverage: number;
  /** min(bracket initialLeverage, user automation maximum). */
  usableMaximumLeverage: number | null;

  selectedLeverage: number | null;
  estimatedInitialMargin: string | null;
  /** ESTIMATE only — never Binance's guaranteed liquidation price. */
  estimatedLiquidationPrice: string | null;
  requiredLiquidationBoundary: string | null;
  liquidationBufferRatio: string;
  /** |stopLoss − estimatedLiquidationPrice|: how far past the stop liquidation sits. */
  liquidationDistance: string | null;
  /** stopDistance × liquidationBufferRatio: the buffer the policy demands. */
  safetyBufferDistance: string | null;
  marginDifferenceFromTarget: string | null;

  candidates: LeverageCandidateSummary[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Decimal helpers
// ---------------------------------------------------------------------------

function parse(value: string | null | undefined): Decimal | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  try {
    const parsed = new D(String(value).trim());
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

/** Normalized authoritative output: plain decimal string, no exponent form. */
function out(value: Decimal | null): string | null {
  return value === null ? null : value.toString();
}

function baseResult(input: DynamicLeveragePlanInput): DynamicLeveragePlan {
  return {
    status: "INVALID",
    reason: null,
    reasonMessage: null,
    symbol: input.symbol,
    direction: input.direction,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    calculatedStopLoss: input.stopLoss,
    executableStopLoss: input.stopLoss,
    stopAdjustment: null,
    stopNormalization: null,
    stopLossSource: input.stopLossSource ?? "CALCULATED",
    stopDistance: null,
    riskBudgetUsd: input.riskBudgetUsd,
    quantityRaw: null,
    roundedQuantity: null,
    quantityStepSize: input.filters.stepSize,
    actualPlannedLoss: null,
    unusedRiskBudget: null,
    positionNotional: null,
    minimumNotional: input.filters.minNotional,
    targetMarginMultiplier: input.targetMarginMultiplier ?? MARGIN_ENGINE_DEFAULTS.targetMarginMultiplier,
    maximumMarginMultiplier: input.maximumMarginMultiplier ?? MARGIN_ENGINE_DEFAULTS.maximumMarginMultiplier,
    minimumMarginUsd: input.minimumMarginUsd ?? MARGIN_ENGINE_DEFAULTS.minimumMarginUsd,
    targetIsolatedMargin: null,
    maximumIsolatedMargin: null,
    minimumIsolatedMargin: null,
    marginSelectionMode: "CLOSEST_TO_TARGET",
    applicableBracket: null,
    maximumSupportedLeverage: null,
    binanceMaximumSupportedLeverage: null,
    userMaximumAutomationLeverage:
      input.userMaximumAutomationLeverage ?? MARGIN_ENGINE_DEFAULTS.userMaximumAutomationLeverage,
    usableMaximumLeverage: null,
    selectedLeverage: null,
    estimatedInitialMargin: null,
    estimatedLiquidationPrice: null,
    requiredLiquidationBoundary: null,
    liquidationBufferRatio: input.liquidationBufferRatio ?? MARGIN_ENGINE_DEFAULTS.liquidationBufferRatio,
    liquidationDistance: null,
    safetyBufferDistance: null,
    marginDifferenceFromTarget: null,
    candidates: [],
    warnings: [],
  };
}

function fail(
  result: DynamicLeveragePlan,
  status: MarginPlanStatus,
  reason: MarginPlanReason,
  message: string
): DynamicLeveragePlan {
  return { ...result, status, reason, reasonMessage: message };
}

// ---------------------------------------------------------------------------
// Bracket resolution
// ---------------------------------------------------------------------------

interface ResolvedBracket {
  summary: ResolvedBracketSummary;
  maintMarginRatio: Decimal;
  cum: Decimal;
  maxLeverage: number;
}

/**
 * Picks the bracket whose (notionalFloor, notionalCap] window contains the
 * notional. Binance publishes brackets in ascending order with an exclusive
 * floor and inclusive cap; the first bracket's floor is 0.
 */
function resolveBracket(
  brackets: MarginPlanLeverageBracket[],
  notional: Decimal
): ResolvedBracket | null {
  for (const bracket of brackets) {
    const floor = parse(bracket.notionalFloor);
    const cap = parse(bracket.notionalCap);
    const mmr = parse(bracket.maintMarginRatio);
    const cum = parse(bracket.cum) ?? new D(0);
    if (floor === null || cap === null || mmr === null) continue;
    if (notional.gt(floor) && notional.lte(cap)) {
      const maxLeverage = bracket.initialLeverage;
      if (maxLeverage === null || !Number.isInteger(maxLeverage) || maxLeverage < 1) continue;
      return {
        summary: {
          bracket: bracket.bracket,
          initialLeverage: maxLeverage,
          notionalFloor: out(floor),
          notionalCap: out(cap),
          maintMarginRatio: out(mmr),
          cum: out(cum),
        },
        maintMarginRatio: mmr,
        cum,
        maxLeverage,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Liquidation estimation (ISOLATED, single position)
// ---------------------------------------------------------------------------

export interface LiquidationEstimateInput {
  direction: "LONG" | "SHORT";
  /** Absolute position size. */
  quantity: string;
  entryPrice: string;
  /** Isolated wallet balance backing this position (= initial margin at open). */
  isolatedWallet: string;
  brackets: MarginPlanLeverageBracket[];
}

export interface LiquidationEstimate {
  available: boolean;
  price: string | null;
  bracket: ResolvedBracketSummary | null;
  unavailableReason: string | null;
}

/**
 * Estimates the ISOLATED liquidation price for a single position.
 *
 * Algebra — liquidation is the mark price MP at which the position's margin
 * balance equals its maintenance margin. For an isolated position the wallet
 * balance WB is the isolated wallet, and (per Binance's published formula)
 * the maintenance margin is `notionalAtMP × MMR − cum`, with the maintenance
 * amount `cum` subtracted:
 *
 *   LONG:   WB + qty·(MP − EP) = qty·MP·MMR − cum
 *           => MP = (qty·EP − WB − cum) / (qty·(1 − MMR))
 *   SHORT:  WB + qty·(EP − MP) = qty·MP·MMR − cum
 *           => MP = (qty·EP + WB + cum) / (qty·(1 + MMR))
 *
 * Assumptions (all required by the isolated single-position case): no other
 * contracts contribute (TMM = 0, UPNL of other contracts = 0), and the
 * position is not in Multi-Assets mode.
 *
 * MMR and cum depend on the notional AT the liquidation price, which may sit
 * in a different bracket than the entry notional, so the bracket is
 * re-resolved and the price recomputed until it stabilizes (bounded by
 * MAX_BRACKET_ITERATIONS). If it cannot stabilize, or required data is
 * missing, the estimate is reported UNAVAILABLE and the caller fails closed.
 *
 * This is an ESTIMATE. It is never Binance's guaranteed liquidation price.
 */
export function estimateIsolatedLiquidationPrice(
  input: LiquidationEstimateInput
): LiquidationEstimate {
  const quantity = parse(input.quantity)?.abs() ?? null;
  const entry = parse(input.entryPrice);
  const wallet = parse(input.isolatedWallet);

  if (quantity === null || quantity.lte(0)) {
    return { available: false, price: null, bracket: null, unavailableReason: "quantity is missing or not positive" };
  }
  if (entry === null || entry.lte(0)) {
    return { available: false, price: null, bracket: null, unavailableReason: "entry price is missing or not positive" };
  }
  if (wallet === null || wallet.lt(0)) {
    return { available: false, price: null, bracket: null, unavailableReason: "isolated wallet balance is missing or negative" };
  }
  if (input.brackets.length === 0) {
    return { available: false, price: null, bracket: null, unavailableReason: "no leverage brackets supplied" };
  }

  let bracket = resolveBracket(input.brackets, quantity.times(entry));
  if (!bracket) {
    return {
      available: false,
      price: null,
      bracket: null,
      unavailableReason: "entry notional falls outside every published leverage bracket",
    };
  }

  let price: Decimal | null = null;

  for (let iteration = 0; iteration < MAX_BRACKET_ITERATIONS; iteration += 1) {
    const { maintMarginRatio: mmr, cum } = bracket;
    const base = quantity.times(entry);

    const numerator = input.direction === "LONG" ? base.minus(wallet).minus(cum) : base.plus(wallet).plus(cum);
    const denominator =
      input.direction === "LONG"
        ? quantity.times(new D(1).minus(mmr))
        : quantity.times(new D(1).plus(mmr));

    if (denominator.isZero() || !denominator.isFinite()) {
      return { available: false, price: null, bracket: bracket.summary, unavailableReason: "degenerate maintenance-margin denominator" };
    }

    const next = numerator.div(denominator);
    if (!next.isFinite()) {
      return { available: false, price: null, bracket: bracket.summary, unavailableReason: "liquidation arithmetic produced a non-finite result" };
    }

    // A LONG can be unliquidatable (margin exceeds the whole position value):
    // a non-positive price means liquidation cannot occur before price zero.
    if (next.lte(0)) {
      return {
        available: true,
        price: out(new D(0)),
        bracket: bracket.summary,
        unavailableReason: null,
      };
    }

    // Re-resolve the bracket at the liquidation notional and repeat until the
    // bracket stops changing.
    const settledBracket = resolveBracket(input.brackets, quantity.times(next));
    if (!settledBracket) {
      return {
        available: false,
        price: null,
        bracket: bracket.summary,
        unavailableReason: "liquidation notional falls outside every published leverage bracket",
      };
    }

    price = next;
    if (settledBracket.summary.bracket === bracket.summary.bracket) {
      return { available: true, price: out(price), bracket: bracket.summary, unavailableReason: null };
    }
    bracket = settledBracket;
  }

  return {
    available: false,
    price: null,
    bracket: bracket.summary,
    unavailableReason: `leverage bracket did not stabilize within ${MAX_BRACKET_ITERATIONS} iterations`,
  };
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

export function calculateDynamicLeveragePlan(input: DynamicLeveragePlanInput): DynamicLeveragePlan {
  const result = baseResult(input);
  const warnings: string[] = [];

  // --- Input validation -----------------------------------------------------
  const entry = parse(input.entryPrice);
  const stop = parse(input.stopLoss);
  const risk = parse(input.riskBudgetUsd);
  const targetMultiplier = parse(result.targetMarginMultiplier);
  const maxMultiplier = parse(result.maximumMarginMultiplier);
  const minimumMargin = parse(result.minimumMarginUsd);
  const bufferRatio = parse(result.liquidationBufferRatio);

  if (entry === null || entry.lte(0)) {
    return fail(result, "INVALID", "INVALID_ENTRY", "Entry price must be a positive decimal.");
  }
  if (risk === null || risk.lte(0)) {
    return fail(result, "INVALID", "INVALID_RISK_BUDGET", "Risk budget must be a positive decimal.");
  }
  if (stop === null || stop.lte(0)) {
    return fail(result, "INVALID", "INVALID_STOP_RELATION", "Stop loss must be a positive decimal.");
  }
  if (targetMultiplier === null || targetMultiplier.lte(0) || maxMultiplier === null || maxMultiplier.lte(0)) {
    return fail(result, "INVALID", "INVALID_MULTIPLIERS", "Margin multipliers must be positive decimals.");
  }
  if (maxMultiplier.lt(targetMultiplier)) {
    return fail(
      result,
      "INVALID",
      "INVALID_MULTIPLIERS",
      "Maximum margin multiplier must be greater than or equal to the target multiplier."
    );
  }
  if (bufferRatio === null || bufferRatio.lt(0)) {
    return fail(result, "INVALID", "INVALID_MULTIPLIERS", "Liquidation buffer ratio must be zero or greater.");
  }
  // Same convention as the buffer ratio: zero is a legitimate "off", anything
  // negative or unparseable is a misconfiguration and never defaulted away.
  if (minimumMargin === null || minimumMargin.lt(0)) {
    return fail(result, "INVALID", "INVALID_MULTIPLIERS", "Minimum isolated margin must be zero or greater.");
  }

  // A positive floor switches the selector; zero leaves every historical
  // behaviour exactly as it was. Recorded before any other failure can return,
  // so even a rejected plan reports which rule was configured.
  const floorEnabled = minimumMargin.gt(0);
  result.marginSelectionMode = floorEnabled ? "SMALLEST_ABOVE_FLOOR" : "CLOSEST_TO_TARGET";
  result.minimumIsolatedMargin = floorEnabled ? out(minimumMargin) : null;

  // An impossible band would otherwise surface as a puzzling "no leverage
  // works" at trade time. `maximumMargin` is only derived further down, but
  // both of its inputs are validated by now, so the contradiction is caught
  // here — before any sizing work and independently of market data.
  if (floorEnabled && minimumMargin.gt(risk.times(maxMultiplier))) {
    return fail(
      result,
      "INVALID",
      "MARGIN_FLOOR_EXCEEDS_MAXIMUM",
      `Minimum isolated margin ${minimumMargin.toString()} exceeds the maximum ${risk.times(maxMultiplier).toString()} ` +
        `(risk budget ${risk.toString()} × ${maxMultiplier.toString()}); no margin can satisfy both.`
    );
  }
  if (input.direction === "LONG" && stop.gte(entry)) {
    return fail(result, "INVALID", "INVALID_STOP_RELATION", "LONG requires stopLoss < entryPrice.");
  }
  if (input.direction === "SHORT" && stop.lte(entry)) {
    return fail(result, "INVALID", "INVALID_STOP_RELATION", "SHORT requires stopLoss > entryPrice.");
  }

  const stopSource: StopLossSource = input.stopLossSource ?? "CALCULATED";
  const userCap = result.userMaximumAutomationLeverage;
  if (!Number.isSafeInteger(userCap) || userCap < 1) {
    return fail(
      result,
      "INVALID",
      "INVALID_MULTIPLIERS",
      "User maximum automation leverage must be a positive integer."
    );
  }

  // --- PRICE_FILTER validation (plan-locked prices fail closed) --------------
  // Zero-valued components are disabled per Binance convention. Alignment is
  // exact decimal modulo — never a float remainder.
  const minPrice = parse(input.filters.minPrice);
  const maxPrice = parse(input.filters.maxPrice);
  const tickSize = parse(input.filters.tickSize);

  // The LIMIT entry is always execution-locked: it is validated, never moved.
  if (minPrice !== null && minPrice.gt(0) && entry.lt(minPrice)) {
    return fail(result, "INVALID", "ENTRY_PRICE_BELOW_MINIMUM", `Entry ${entry.toString()} is below the symbol minimum price ${minPrice.toString()}.`);
  }
  if (maxPrice !== null && maxPrice.gt(0) && entry.gt(maxPrice)) {
    return fail(result, "INVALID", "ENTRY_PRICE_ABOVE_MAXIMUM", `Entry ${entry.toString()} is above the symbol maximum price ${maxPrice.toString()}.`);
  }
  if (tickSize !== null && tickSize.gt(0) && !entry.mod(tickSize).isZero()) {
    return fail(result, "INVALID", "ENTRY_PRICE_NOT_TICK_ALIGNED", `Entry ${entry.toString()} is not aligned to the ${tickSize.toString()} tick; the LIMIT entry is never rounded.`);
  }

  // --- Stop-loss execution-price normalization -------------------------------
  // A strategy-derived stop is a mathematical price and need not land on the
  // exchange grid. Move it onto the tick AWAY from entry — LONG rounds DOWN,
  // SHORT rounds UP — so the stop can only widen, never tighten. Widening
  // increases stopDistance, which reduces quantity and therefore planned loss,
  // so the risk cap is preserved by construction. An explicitly
  // EXECUTION_LOCKED stop is never moved and still fails closed.
  let executableStop = stop;

  if (tickSize !== null && tickSize.gt(0) && !stop.mod(tickSize).isZero()) {
    if (stopSource === "EXECUTION_LOCKED") {
      return fail(
        result,
        "INVALID",
        "STOP_PRICE_NOT_TICK_ALIGNED",
        `Stop ${stop.toString()} is not aligned to the ${tickSize.toString()} tick; an execution-locked stop is never rounded.`
      );
    }

    executableStop =
      input.direction === "LONG"
        ? stop.div(tickSize).floor().times(tickSize)
        : stop.div(tickSize).ceil().times(tickSize);

    result.executableStopLoss = out(executableStop) as string;
    result.stopLoss = result.executableStopLoss;
    result.stopAdjustment = out(executableStop.minus(stop));
    result.stopNormalization = STOP_PRICE_NORMALIZED_TO_TICK;
    warnings.push(
      `${STOP_PRICE_NORMALIZED_TO_TICK}: Stop moved away from entry to match the exchange tick. ` +
        `Quantity was recalculated downward so planned loss remains within the risk budget. ` +
        `(${stop.toString()} → ${executableStop.toString()}, tick ${tickSize.toString()}.)`
    );
    result.warnings = warnings;
  }

  // Everything below uses the EXECUTABLE stop.
  if (executableStop.lte(0)) {
    return fail(result, "INVALID", "STOP_PRICE_BELOW_MINIMUM", "Stop loss is not positive after tick normalization.");
  }
  if (minPrice !== null && minPrice.gt(0) && executableStop.lt(minPrice)) {
    return fail(result, "INVALID", "STOP_PRICE_BELOW_MINIMUM", `Stop ${executableStop.toString()} is below the symbol minimum price ${minPrice.toString()}.`);
  }
  if (maxPrice !== null && maxPrice.gt(0) && executableStop.gt(maxPrice)) {
    return fail(result, "INVALID", "STOP_PRICE_ABOVE_MAXIMUM", `Stop ${executableStop.toString()} is above the symbol maximum price ${maxPrice.toString()}.`);
  }
  // Normalization moves away from entry, so this can only be violated by
  // degenerate input; assert it rather than assume it.
  if (input.direction === "LONG" ? executableStop.gte(entry) : executableStop.lte(entry)) {
    return fail(
      result,
      "INVALID",
      "INVALID_STOP_RELATION",
      "Stop loss is on the wrong side of entry after tick normalization."
    );
  }

  const stopDistance = entry.minus(executableStop).abs();
  result.stopDistance = out(stopDistance);

  // --- Symbol tradability ---------------------------------------------------
  if ((input.filters.status ?? "").toUpperCase() !== "TRADING") {
    return fail(
      result,
      "SKIPPED",
      "SYMBOL_NOT_TRADING",
      `Symbol status is ${input.filters.status ?? "unknown"}; only TRADING symbols are planned.`
    );
  }
  const contractType = (input.filters.contractType ?? "").toUpperCase();
  if (!(SUPPORTED_CONTRACT_TYPES as readonly string[]).includes(contractType)) {
    return fail(
      result,
      "SKIPPED",
      "UNSUPPORTED_CONTRACT",
      `Contract type ${input.filters.contractType ?? "unknown"} is not supported (expected PERPETUAL).`
    );
  }

  // --- Risk sizing (LOT_SIZE, always rounded DOWN) --------------------------
  const stepSize = parse(input.filters.stepSize);
  if (stepSize === null || stepSize.lte(0)) {
    return fail(
      result,
      "SKIPPED",
      "LEVERAGE_BRACKET_UNAVAILABLE",
      "LOT_SIZE stepSize is unavailable, so quantity cannot be rounded safely."
    );
  }

  const quantityRaw = risk.div(stopDistance);
  result.quantityRaw = out(quantityRaw);

  // Round DOWN to the step grid: never increases planned risk.
  const roundedQuantity = quantityRaw.div(stepSize).floor().times(stepSize);
  result.roundedQuantity = out(roundedQuantity);

  if (roundedQuantity.lte(0)) {
    return fail(
      result,
      "SKIPPED",
      "QUANTITY_ROUNDS_TO_ZERO",
      "Risk budget is too small for one LOT_SIZE step at this stop distance."
    );
  }

  const minQty = parse(input.filters.minQty);
  const maxQty = parse(input.filters.maxQty);
  if (minQty !== null && roundedQuantity.lt(minQty)) {
    return fail(
      result,
      "SKIPPED",
      "BELOW_MIN_QUANTITY",
      `Rounded quantity ${roundedQuantity.toString()} is below the symbol minimum ${minQty.toString()}.`
    );
  }
  if (maxQty !== null && roundedQuantity.gt(maxQty)) {
    return fail(
      result,
      "SKIPPED",
      "ABOVE_MAX_QUANTITY",
      `Rounded quantity ${roundedQuantity.toString()} exceeds the symbol maximum ${maxQty.toString()}.`
    );
  }

  const actualPlannedLoss = roundedQuantity.times(stopDistance);
  const positionNotional = roundedQuantity.times(entry);
  result.actualPlannedLoss = out(actualPlannedLoss);
  result.unusedRiskBudget = out(risk.minus(actualPlannedLoss));
  result.positionNotional = out(positionNotional);

  // Structural guarantee of rounding down.
  if (actualPlannedLoss.gt(risk)) {
    return fail(
      result,
      "INVALID",
      "INVALID_RISK_BUDGET",
      "Internal error: planned loss exceeded the risk budget after rounding down."
    );
  }

  const minNotional = parse(input.filters.minNotional);
  if (minNotional !== null && positionNotional.lt(minNotional)) {
    // Deliberately NOT increased to satisfy the exchange minimum: that would
    // push planned loss above the risk budget.
    return fail(
      result,
      "SKIPPED",
      "BELOW_MIN_NOTIONAL",
      `Notional ${positionNotional.toString()} is below the symbol minimum ${minNotional.toString()}; increasing quantity would exceed the risk budget.`
    );
  }

  // --- Margin envelope (from the BUDGET, not the reduced rounded loss) ------
  const targetMargin = risk.times(targetMultiplier);
  const maximumMargin = risk.times(maxMultiplier);
  result.targetIsolatedMargin = out(targetMargin);
  result.maximumIsolatedMargin = out(maximumMargin);

  // --- Bracket resolution ---------------------------------------------------
  if (input.brackets.length === 0) {
    return fail(
      result,
      "SKIPPED",
      "LEVERAGE_BRACKET_UNAVAILABLE",
      "No account leverage brackets were supplied for this symbol."
    );
  }
  const bracket = resolveBracket(input.brackets, positionNotional);
  if (!bracket) {
    return fail(
      result,
      "SKIPPED",
      "NOTIONAL_OUTSIDE_BRACKETS",
      `Notional ${positionNotional.toString()} falls outside every published leverage bracket.`
    );
  }
  result.applicableBracket = bracket.summary;
  result.maximumSupportedLeverage = bracket.maxLeverage;
  result.binanceMaximumSupportedLeverage = bracket.maxLeverage;

  // Usable ceiling = min(Binance bracket max, user automation max). The
  // symbol's currently configured leverage plays no part, and nothing is
  // ever applied to the account.
  const usableMaximumLeverage = Math.min(bracket.maxLeverage, userCap);
  result.usableMaximumLeverage = usableMaximumLeverage;

  // --- Required liquidation boundary ---------------------------------------
  const safetyBuffer = stopDistance.times(bufferRatio);
  const boundary =
    input.direction === "LONG" ? executableStop.minus(safetyBuffer) : executableStop.plus(safetyBuffer);
  result.safetyBufferDistance = out(safetyBuffer);
  result.requiredLiquidationBoundary = out(boundary);

  // --- Candidate generation (1x .. usable maximum) ---------------------------
  const candidates: LeverageCandidateSummary[] = [];
  let best: { leverage: number; margin: Decimal; liquidation: Decimal; difference: Decimal } | null = null;
  let sawUnavailableEstimate = false;

  for (let leverage = 1; leverage <= usableMaximumLeverage; leverage += 1) {
    const margin = positionNotional.div(leverage);
    const difference = margin.minus(targetMargin);

    if (margin.gt(maximumMargin)) {
      candidates.push({
        leverage,
        estimatedInitialMargin: out(margin) as string,
        estimatedLiquidationPrice: null,
        marginDifferenceFromTarget: out(difference) as string,
        eligible: false,
        rejectionReason: REJECTED_ABOVE_MAXIMUM,
      });
      continue;
    }

    // The floor rejects from below exactly as the ceiling rejects from above.
    // Quantity and notional were fixed long before this loop and are NEVER
    // revisited to reach the floor — only the leverage changes.
    if (floorEnabled && margin.lt(minimumMargin)) {
      candidates.push({
        leverage,
        estimatedInitialMargin: out(margin) as string,
        estimatedLiquidationPrice: null,
        marginDifferenceFromTarget: out(difference) as string,
        eligible: false,
        rejectionReason: REJECTED_BELOW_MINIMUM,
      });
      continue;
    }

    // Isolated wallet at open == the initial margin for this candidate.
    const estimate = estimateIsolatedLiquidationPrice({
      direction: input.direction,
      quantity: out(roundedQuantity) as string,
      entryPrice: out(entry) as string,
      isolatedWallet: out(margin) as string,
      brackets: input.brackets,
    });

    if (!estimate.available || estimate.price === null) {
      sawUnavailableEstimate = true;
      candidates.push({
        leverage,
        estimatedInitialMargin: out(margin) as string,
        estimatedLiquidationPrice: null,
        marginDifferenceFromTarget: out(difference) as string,
        eligible: false,
        rejectionReason: `liquidation estimate unavailable: ${estimate.unavailableReason ?? "unknown"}`,
      });
      continue;
    }

    const liquidation = new D(estimate.price);
    const safe =
      input.direction === "LONG" ? liquidation.lte(boundary) : liquidation.gte(boundary);

    candidates.push({
      leverage,
      estimatedInitialMargin: out(margin) as string,
      estimatedLiquidationPrice: out(liquidation),
      marginDifferenceFromTarget: out(difference) as string,
      eligible: safe,
      rejectionReason: safe ? null : REJECTED_LIQUIDATION_UNSAFE,
    });

    if (!safe) continue;

    // Only liquidation-safe candidates ever reach here, so neither rule can
    // trade safety away for a nicer margin.
    if (floorEnabled) {
      // Smallest margin at or above the floor. Compared on the margin itself
      // rather than relying on margin descending as leverage ascends, so the
      // rule stays correct if candidate generation is ever reordered.
      if (best === null || margin.lt(best.margin)) {
        best = { leverage, margin, liquidation, difference: difference.abs() };
      }
    } else {
      // Closest to target wins; ascending iteration makes ties keep the LOWER
      // leverage (strict improvement only).
      const distance = difference.abs();
      if (best === null || distance.lt(best.difference)) {
        best = { leverage, margin, liquidation, difference: distance };
      }
    }
  }

  result.candidates = candidates;

  if (best === null) {
    // Fail closed: if no candidate could even be estimated, say so explicitly
    // rather than implying the leverage range is unsafe.
    const everyEstimateFailed = candidates.every((candidate) => candidate.estimatedLiquidationPrice === null);
    if (sawUnavailableEstimate && everyEstimateFailed) {
      return fail(
        result,
        "LIQUIDATION_ESTIMATE_UNAVAILABLE",
        "LIQUIDATION_ESTIMATE_UNAVAILABLE",
        "No liquidation estimate could be produced, so no leverage can be declared safe."
      );
    }

    // When Binance itself supports higher leverage than the user cap, probe
    // (calculation only — nothing is recommended or shown as a candidate)
    // whether some leverage above the cap would have satisfied both the
    // margin ceiling and liquidation safety. If so, the truthful reason is
    // the user cap, not the exchange.
    if (usableMaximumLeverage < bracket.maxLeverage) {
      for (let leverage = usableMaximumLeverage + 1; leverage <= bracket.maxLeverage; leverage += 1) {
        const margin = positionNotional.div(leverage);
        if (margin.gt(maximumMargin)) continue;
        // Above the cap means MORE leverage and therefore a SMALLER margin, so
        // the floor must be applied here too. Without it the plan would blame
        // the user cap for a leverage the floor would have rejected anyway.
        if (floorEnabled && margin.lt(minimumMargin)) continue;
        const estimate = estimateIsolatedLiquidationPrice({
          direction: input.direction,
          quantity: out(roundedQuantity) as string,
          entryPrice: out(entry) as string,
          isolatedWallet: out(margin) as string,
          brackets: input.brackets,
        });
        if (!estimate.available || estimate.price === null) continue;
        const liquidation = new D(estimate.price);
        const safe = input.direction === "LONG" ? liquidation.lte(boundary) : liquidation.gte(boundary);
        if (safe) {
          return fail(
            result,
            "SKIPPED",
            "USER_LEVERAGE_CAP_PREVENTS_SAFE_PLAN",
            `A safe plan exists at ${leverage}x, but the user automation maximum is ${userCap}x; no leverage at or below the cap satisfies the margin ceiling and liquidation safety.`
          );
        }
      }
    }

    const allExceedMaximum = candidates.every((candidate) => candidate.rejectionReason === REJECTED_ABOVE_MAXIMUM);
    if (allExceedMaximum) {
      return fail(
        result,
        "SKIPPED",
        "REQUIRED_MARGIN_EXCEEDS_MAXIMUM",
        `Every usable leverage needs more than the maximum isolated margin ${maximumMargin.toString()}.`
      );
    }

    // Third distinct case, deliberately not folded into either neighbour: the
    // margin BAND excluded every leverage before liquidation was ever
    // consulted, and since the all-above-maximum case already returned, the
    // floor is what closed it. A candidate that reached the liquidation test
    // and failed there is NOT this case — that stays the liquidation reason
    // below, so enabling a floor can never disguise a liquidation problem.
    const noneReachedLiquidationTest = candidates.every(
      (candidate) =>
        candidate.rejectionReason === REJECTED_ABOVE_MAXIMUM || candidate.rejectionReason === REJECTED_BELOW_MINIMUM
    );
    if (floorEnabled && noneReachedLiquidationTest) {
      const belowFloor = candidates.filter((candidate) => candidate.rejectionReason === REJECTED_BELOW_MINIMUM).length;
      return fail(
        result,
        "SKIPPED",
        "NO_LEVERAGE_MEETS_MARGIN_FLOOR",
        `No usable leverage lands in the isolated-margin band ${minimumMargin.toString()}–${maximumMargin.toString()}: ` +
          `${belowFloor} of ${candidates.length} candidate(s) fall below the minimum. ` +
          `Quantity was not increased to reach it.`
      );
    }

    return fail(
      result,
      "SKIPPED",
      "NO_LIQUIDATION_SAFE_LEVERAGE",
      "No usable leverage keeps the estimated liquidation price beyond the required safety buffer."
    );
  }

  if (sawUnavailableEstimate) {
    warnings.push("Some leverage candidates could not be estimated and were excluded.");
  }

  result.status = "READY";
  result.selectedLeverage = best.leverage;
  result.estimatedInitialMargin = out(best.margin);
  result.estimatedLiquidationPrice = out(best.liquidation);
  result.marginDifferenceFromTarget = out(best.margin.minus(targetMargin));
  result.liquidationDistance = out(executableStop.minus(best.liquidation).abs());
  result.warnings = warnings;
  return result;
}
