import Decimal from "decimal.js";

/**
 * Deterministic USD-M futures risk / reward and position-sizing math.
 *
 * Core financial rule enforced here: leverage NEVER determines the risk
 * budget or the position size. The calculation order is fixed:
 *   1. accountBalance × riskPercent  -> riskBudget (max planned loss)
 *   2. entry vs stop distance        -> positionQuantity / positionNotional
 *   3. leverage                      -> only requiredMargin for that notional
 *   4. take-profit                   -> reward and R:R
 *
 * `positionNotional = accountBalance × leverage` is deliberately never used.
 *
 * All arithmetic uses decimal.js (never JS Number) and all results are
 * returned as exact plain decimal strings.
 */

// Local constructor clone: high precision, plain (non-exponential) string
// output across our whole price range, and no mutation of the global
// decimal.js config other consumers might rely on.
const D = Decimal.clone({ precision: 40, toExpNeg: -30, toExpPos: 40 });

export type PlanDirection = "LONG" | "SHORT";

export const TRADE_MARGIN_MODES = ["ISOLATED", "CROSS"] as const;
export type TradeMarginMode = (typeof TRADE_MARGIN_MODES)[number];

/**
 * Display/education threshold only: at or above this leverage a neutral
 * informational warning is shown. It never blocks saving and never labels a
 * trade good or bad. Kept here so no UI/API sprinkles its own magic number.
 */
export const HIGH_LEVERAGE_WARNING_THRESHOLD = 50;

export const NON_DIRECTIONAL_PLAN_MESSAGE =
  "Directional risk calculation requires a LONG or SHORT alert.";

export const ISOLATED_MARGIN_WARNING =
  "Planned loss at the stop is equal to or greater than the initial margin. " +
  "Liquidation may occur before the stop. Reduce leverage, add isolated margin, or reduce position size.";

export const LIQUIDATION_BEFORE_STOP_WARNING =
  "The supplied liquidation price is at or above the stop loss. Liquidation may occur before the stop executes.";

export const LIQUIDATION_BEFORE_STOP_WARNING_SHORT =
  "The supplied liquidation price is at or below the stop loss. Liquidation may occur before the stop executes.";

export const CROSS_MARGIN_WARNING =
  "Cross margin may use the wider futures wallet balance and other positions can affect liquidation. " +
  "Required margin shown here is a planning estimate, not a maximum-loss guarantee.";

export const HIGH_LEVERAGE_WARNING =
  `Leverage is ${HIGH_LEVERAGE_WARNING_THRESHOLD}x or higher. High leverage shrinks the buffer between entry and ` +
  "liquidation; the position size here is still derived from your risk budget and stop distance, not from leverage.";

export interface FuturesRiskPlanInput {
  direction: PlanDirection;
  entryPrice: string;
  stopLossPrice: string;
  takeProfitPrice: string;
  accountBalance: string;
  riskPercent: string;
  leverage: string;
  marginMode: TradeMarginMode;
  /** Optional, manually copied from the exchange. Never calculated here. */
  liquidationPrice?: string | null;
}

export interface FuturesRiskPlan {
  valid: boolean;
  validationErrors: string[];
  warnings: string[];

  // Risk/reward (price geometry) — independent of leverage.
  riskPerUnit: string | null;
  rewardPerUnit: string | null;
  stopDistancePercent: string | null;
  rewardPercent: string | null;
  riskRewardRatio: string | null;

  // Money management.
  riskBudget: string | null;
  positionQuantity: string | null;
  positionNotional: string | null;
  requiredMargin: string | null;
  marginUsagePercent: string | null;
  expectedProfitAtTakeProfit: string | null;
}

function invalidPlan(validationErrors: string[], warnings: string[] = []): FuturesRiskPlan {
  return {
    valid: false,
    validationErrors,
    warnings,
    riskPerUnit: null,
    rewardPerUnit: null,
    stopDistancePercent: null,
    rewardPercent: null,
    riskRewardRatio: null,
    riskBudget: null,
    positionQuantity: null,
    positionNotional: null,
    requiredMargin: null,
    marginUsagePercent: null,
    expectedProfitAtTakeProfit: null,
  };
}

function parseDecimal(name: string, value: string | null | undefined, errors: string[]): Decimal | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    errors.push(`${name} is required`);
    return null;
  }
  try {
    const parsed = new D(String(value).trim());
    if (!parsed.isFinite()) {
      errors.push(`${name} must be a finite number`);
      return null;
    }
    return parsed;
  } catch {
    errors.push(`${name} must be a valid decimal number`);
    return null;
  }
}

export function calculateFuturesRiskPlan(input: FuturesRiskPlanInput): FuturesRiskPlan {
  const errors: string[] = [];

  const entry = parseDecimal("entryPrice", input.entryPrice, errors);
  const stop = parseDecimal("stopLossPrice", input.stopLossPrice, errors);
  const target = parseDecimal("takeProfitPrice", input.takeProfitPrice, errors);
  const balance = parseDecimal("accountBalance", input.accountBalance, errors);
  const riskPercent = parseDecimal("riskPercent", input.riskPercent, errors);
  const leverage = parseDecimal("leverage", input.leverage, errors);

  let liquidation: Decimal | null = null;
  if (input.liquidationPrice !== undefined && input.liquidationPrice !== null && String(input.liquidationPrice).trim() !== "") {
    liquidation = parseDecimal("liquidationPrice", input.liquidationPrice, errors);
  }

  if (input.direction !== "LONG" && input.direction !== "SHORT") {
    errors.push("direction must be LONG or SHORT");
  }

  if (errors.length > 0 || !entry || !stop || !target || !balance || !riskPercent || !leverage) {
    return invalidPlan(errors);
  }

  if (entry.lte(0)) errors.push("entryPrice must be greater than zero");
  if (stop.lte(0)) errors.push("stopLossPrice must be greater than zero");
  if (target.lte(0)) errors.push("takeProfitPrice must be greater than zero");
  if (balance.lte(0)) errors.push("accountBalance must be greater than zero");
  if (riskPercent.lte(0)) errors.push("riskPercent must be greater than zero");
  if (leverage.lt(1)) errors.push("leverage must be at least 1");
  if (liquidation && liquidation.lte(0)) errors.push("liquidationPrice must be greater than zero");

  if (errors.length > 0) {
    return invalidPlan(errors);
  }

  // Direction geometry -> risk/reward per unit.
  let riskPerUnit: Decimal;
  let rewardPerUnit: Decimal;
  if (input.direction === "LONG") {
    if (stop.gte(entry)) errors.push("LONG geometry invalid: stopLossPrice must be below entryPrice");
    if (target.lte(entry)) errors.push("LONG geometry invalid: takeProfitPrice must be above entryPrice");
    riskPerUnit = entry.minus(stop);
    rewardPerUnit = target.minus(entry);
  } else {
    if (stop.lte(entry)) errors.push("SHORT geometry invalid: stopLossPrice must be above entryPrice");
    if (target.gte(entry)) errors.push("SHORT geometry invalid: takeProfitPrice must be below entryPrice");
    riskPerUnit = stop.minus(entry);
    rewardPerUnit = entry.minus(target);
  }

  if (errors.length > 0) {
    return invalidPlan(errors);
  }

  // 1. Risk budget from account + risk %, NEVER from leverage.
  const riskBudget = balance.times(riskPercent).div(100);

  // 2. Position size from risk budget and stop distance.
  const positionQuantity = riskBudget.div(riskPerUnit);
  const positionNotional = positionQuantity.times(entry);

  // 3. Leverage only converts that notional into required initial margin.
  const requiredMargin = positionNotional.div(leverage);
  const marginUsagePercent = requiredMargin.div(balance).times(100);

  // 4. Reward metrics.
  const stopDistancePercent = riskPerUnit.div(entry).times(100);
  const rewardPercent = rewardPerUnit.div(entry).times(100);
  const riskRewardRatio = rewardPerUnit.div(riskPerUnit);
  const expectedProfitAtTakeProfit = positionQuantity.times(rewardPerUnit);

  const values = [
    riskBudget, positionQuantity, positionNotional, requiredMargin,
    marginUsagePercent, stopDistancePercent, rewardPercent, riskRewardRatio,
    expectedProfitAtTakeProfit,
  ];
  if (values.some((value) => !value.isFinite()) || requiredMargin.lte(0)) {
    return invalidPlan(["calculation produced a non-finite or non-positive result"]);
  }

  const warnings: string[] = [];

  if (input.marginMode === "ISOLATED" && requiredMargin.lte(riskBudget)) {
    warnings.push(ISOLATED_MARGIN_WARNING);
  }

  if (liquidation) {
    if (input.direction === "LONG" && liquidation.gte(stop)) {
      warnings.push(LIQUIDATION_BEFORE_STOP_WARNING);
    }
    if (input.direction === "SHORT" && liquidation.lte(stop)) {
      warnings.push(LIQUIDATION_BEFORE_STOP_WARNING_SHORT);
    }
  }

  if (input.marginMode === "CROSS") {
    warnings.push(CROSS_MARGIN_WARNING);
  }

  if (leverage.gte(HIGH_LEVERAGE_WARNING_THRESHOLD)) {
    warnings.push(HIGH_LEVERAGE_WARNING);
  }

  return {
    valid: true,
    validationErrors: [],
    warnings,
    riskPerUnit: riskPerUnit.toString(),
    rewardPerUnit: rewardPerUnit.toString(),
    stopDistancePercent: stopDistancePercent.toString(),
    rewardPercent: rewardPercent.toString(),
    riskRewardRatio: riskRewardRatio.toString(),
    riskBudget: riskBudget.toString(),
    positionQuantity: positionQuantity.toString(),
    positionNotional: positionNotional.toString(),
    requiredMargin: requiredMargin.toString(),
    marginUsagePercent: marginUsagePercent.toString(),
    expectedProfitAtTakeProfit: expectedProfitAtTakeProfit.toString(),
  };
}
