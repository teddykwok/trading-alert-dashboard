import { Prisma } from "@prisma/client";
import { symbolSideKey } from "./capacity-status";

/**
 * Phase 5 — pure safety and capacity decision engine.
 *
 * Deterministic and side-effect free: no Prisma, no fetch, no environment
 * read, no logging, no Binance client, no queue, no Telegram and no clock
 * read — the caller supplies `evaluatedAt`. Given identical inputs it always
 * returns an identical decision, which is what makes the whole admission
 * auditable and testable.
 *
 * A failed check can never become PASS: checks accumulate into an ordered
 * list and any entry forces SKIP (or UNAVAILABLE when required data is
 * missing). Decimal comparisons use Prisma.Decimal — never JS floats.
 */

const D = Prisma.Decimal;
type DecimalValue = InstanceType<typeof Prisma.Decimal>;

export const SAFETY_DECISIONS = ["PASS", "SKIP", "RETRY_CONFLICT", "UNAVAILABLE"] as const;
export type SafetyDecisionName = (typeof SAFETY_DECISIONS)[number];

export const SAFETY_REASON_CODES = [
  "GLOBAL_KILL_SWITCH_ACTIVE",
  "PROFILE_KILL_SWITCH_ACTIVE",
  "PROFILE_DISABLED",
  "PROFILE_ENVIRONMENT_MISMATCH",
  "PROFILE_POLICY_UNAVAILABLE",
  "SIGNAL_TIME_UNAVAILABLE",
  "ALERT_STALE",
  "DUPLICATE_EXECUTION",
  "SYMBOL_NOT_ALLOWED",
  "UNSUPPORTED_SYMBOL",
  "SYMBOL_NOT_TRADING",
  "UNSUPPORTED_CONTRACT",
  "EXPECTED_HEDGE_MODE",
  "EXPECTED_SINGLE_ASSET_MODE",
  "EXPECTED_ISOLATED_MARGIN_TYPE",
  "SYMBOL_SIDE_ALREADY_ACTIVE",
  "SYMBOL_HAS_OPEN_POSITION_OR_ORDER",
  "OPEN_POSITION_LIMIT_REACHED",
  "PENDING_ENTRY_LIMIT_REACHED",
  "TOTAL_ACTIVE_LIMIT_REACHED",
  "TOTAL_RISK_LIMIT_REACHED",
  "TOTAL_MARGIN_LIMIT_REACHED",
  "INSUFFICIENT_AVAILABLE_BALANCE",
  "UNSAFE_LIQUIDATION_BUFFER",
  "MARGIN_PLAN_NOT_READY",
  "MARGIN_PLAN_SNAPSHOT_MISSING",
  "BINANCE_ACCOUNT_STATE_UNAVAILABLE",
  "BINANCE_SYMBOL_STATE_UNAVAILABLE",
  "CAPACITY_CONFLICT_RETRY",
] as const;
export type SafetyReasonCode = (typeof SAFETY_REASON_CODES)[number];

export type SafetyReasonRetryability = "RETRYABLE" | "TERMINAL";

/**
 * Reason codes that describe a condition which can genuinely resolve on its
 * own or by an operator action, WITHOUT changing any frozen field of the
 * execution: a connector outage, a rate limit, a network blip, an
 * un-inspectable symbol, or a profile policy that has not been created yet.
 * These produce UNAVAILABLE and leave the execution in PLAN_READY.
 *
 * Everything else is terminal. In particular, a reason rooted in permanently
 * missing IMMUTABLE execution data cannot self-heal — retrying it forever
 * would just re-derive the same answer — so it produces a normal SKIP.
 */
const RETRYABLE_REASONS: readonly SafetyReasonCode[] = [
  "PROFILE_POLICY_UNAVAILABLE",
  "BINANCE_ACCOUNT_STATE_UNAVAILABLE",
  "BINANCE_SYMBOL_STATE_UNAVAILABLE",
  "CAPACITY_CONFLICT_RETRY",
];

/**
 * Single source of truth for "can this reason be retried?". The orchestration
 * service derives the lifecycle purely from the decision, so no reason code is
 * ever special-cased outside this function.
 *
 * `SIGNAL_TIME_UNAVAILABLE` and `MARGIN_PLAN_SNAPSHOT_MISSING` are deliberately
 * TERMINAL: both describe frozen data on an existing execution (a pre-Phase-5
 * row with no trustworthy signal time; a plan snapshot that was never
 * captured). Neither can appear later, so admitting them to the retry path
 * would produce an execution that is retried indefinitely and never resolves.
 */
export function classifySafetyReasonRetryability(reasonCode: SafetyReasonCode): SafetyReasonRetryability {
  return RETRYABLE_REASONS.includes(reasonCode) ? "RETRYABLE" : "TERMINAL";
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ProposedExecution {
  executionId: string;
  profileId: string;
  symbol: string;
  positionSide: "LONG" | "SHORT" | "BOTH";
  /** Frozen Alert.triggeredAt; null means the provenance is unknown. */
  signalTriggeredAt: Date | null;
  currentStatus: string;
  riskBudgetUsd: string;
  actualPlannedLoss: string;
  estimatedInitialMargin: string;
  maximumIsolatedMargin: string;
  estimatedLiquidationPrice: string | null;
  requiredLiquidationBoundary: string | null;
  /** Status of the FROZEN Phase 3 plan; must be READY. */
  marginPlanStatus: string | null;
  marginPlanWarnings?: string[];
  selectedLeverage: number | null;
  hasMarginPlanSnapshot: boolean;
}

export interface EffectiveSafetyPolicy {
  killSwitchActive: boolean;
  globalKillSwitchActive: boolean;
  profileKillSwitchActive: boolean;
  profileEnabled: boolean;
  policyPresent: boolean;
  /** Profile environment (TESTNET/MAINNET) matches the configured connector. */
  environmentMatchesConnector: boolean;
  expectedPositionMode: "HEDGE" | "ONE_WAY";
  expectedMarginType: "ISOLATED" | "CROSS";
  maxOpenPositions: number;
  maxPendingEntries: number;
  maxTotalActiveTrades: number;
  maxTotalPlannedRiskUsd: string;
  maxTotalIsolatedMarginUsd: string;
  maxActivePerSymbolSide: number;
  maxAlertAgeSeconds: number;
  signalFutureToleranceSeconds: number;
  /** Empty = no extra restriction. */
  allowedSymbols: string[];
}

export interface LocalCapacitySnapshot {
  openPositionCount: number;
  pendingEntryCount: number;
  totalActiveCount: number;
  reservedRiskUsd: string;
  reservedMaximumMarginUsd: string;
  /** "SYMBOL:SIDE" keys already active locally. */
  activeSymbolSideKeys: string[];
  /** Reserved margin for local executions Binance does not yet reflect. */
  pendingUnreflectedMarginUsd: string;
  alreadyAdmitted: boolean;
}

export interface BinanceCapacitySnapshot {
  available: boolean;
  positionMode: "HEDGE" | "ONE_WAY" | null;
  assetMode: "MULTI_ASSET" | "SINGLE_ASSET" | null;
  usdtAvailableBalance: string | null;
  /** Symbols with a non-zero position, regardless of side. */
  symbolsWithPosition: string[];
  /** Symbols with any open order, regardless of side. */
  symbolsWithOpenOrder: string[];
  snapshotAt: Date | null;
}

export interface SymbolStateSnapshot {
  available: boolean;
  exists: boolean;
  status: string | null;
  contractType: string | null;
  hasFiltersSnapshot: boolean;
  hasBracketSnapshot: boolean;
}

export interface SafetyEvaluationInput {
  evaluatedAt: Date;
  proposed: ProposedExecution;
  policy: EffectiveSafetyPolicy;
  local: LocalCapacitySnapshot;
  binance: BinanceCapacitySnapshot;
  symbolState: SymbolStateSnapshot;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface FailedCheck {
  reasonCode: SafetyReasonCode;
  message: string;
}

export interface CapacityTotals {
  openPositionCount: number;
  pendingEntryCount: number;
  totalActiveCount: number;
  reservedRiskUsd: string;
  reservedMarginUsd: string;
}

export interface SafetyDecisionResult {
  decision: SafetyDecisionName;
  reasonCode: SafetyReasonCode | null;
  failedChecks: FailedCheck[];
  message: string;
  evaluatedAt: string;
  signalAgeSeconds: number | null;
  effectiveLimits: EffectiveSafetyPolicy;
  capacityBefore: CapacityTotals;
  proposedReservations: { riskUsd: string; marginUsd: string };
  capacityProjected: CapacityTotals;
  warnings: string[];
  binanceSnapshotAt: string | null;
}

/**
 * Effective limits = the STRICTER of global and profile values. Counts and
 * monetary caps take the minimum; the kill switch is a logical OR, so either
 * side can stop admissions and neither can re-enable them alone.
 */
/**
 * The limits that exist on BOTH sides of the merge — env-wide and per-profile.
 *
 * Named as one shape so the canary preflight can reason about "global vs row vs
 * effective" using the same arithmetic admission uses, instead of a second
 * implementation that could drift.
 */
export interface SafetyCapacityLimits {
  maxOpenPositions: number;
  maxPendingEntries: number;
  maxTotalActiveTrades: number;
  maxActivePerSymbolSide: number;
  maxAlertAgeSeconds: number;
  maxTotalPlannedRiskUsd: string;
  maxTotalIsolatedMarginUsd: string;
}

/**
 * The ONE min-merge. Counts and monetary caps take the stricter (smaller) of
 * the two sides; nothing here can widen a limit.
 *
 * `resolveEffectivePolicy` below and the canary preflight both call this, so
 * "what will actually be enforced" has a single definition. Decimals are
 * compared as decimals and returned as the ORIGINAL string, never reformatted.
 */
export function mergeCapacityLimits(
  global: SafetyCapacityLimits,
  profile: SafetyCapacityLimits
): SafetyCapacityLimits {
  const minDecimal = (a: string, b: string) => (new D(a).lessThan(new D(b)) ? a : b);
  return {
    maxOpenPositions: Math.min(global.maxOpenPositions, profile.maxOpenPositions),
    maxPendingEntries: Math.min(global.maxPendingEntries, profile.maxPendingEntries),
    maxTotalActiveTrades: Math.min(global.maxTotalActiveTrades, profile.maxTotalActiveTrades),
    maxActivePerSymbolSide: Math.min(global.maxActivePerSymbolSide, profile.maxActivePerSymbolSide),
    maxAlertAgeSeconds: Math.min(global.maxAlertAgeSeconds, profile.maxAlertAgeSeconds),
    maxTotalPlannedRiskUsd: minDecimal(global.maxTotalPlannedRiskUsd, profile.maxTotalPlannedRiskUsd),
    maxTotalIsolatedMarginUsd: minDecimal(global.maxTotalIsolatedMarginUsd, profile.maxTotalIsolatedMarginUsd),
  };
}

export function resolveEffectivePolicy(
  global: {
    killSwitchActive: boolean;
    maxOpenPositions: number;
    maxPendingEntries: number;
    maxTotalActiveTrades: number;
    maxTotalPlannedRiskUsd: string;
    maxTotalIsolatedMarginUsd: string;
    maxActivePerSymbolSide: number;
    maxAlertAgeSeconds: number;
    signalFutureToleranceSeconds: number;
  },
  profile: {
    present: boolean;
    enabled: boolean;
    environmentMatchesConnector: boolean;
    killSwitchActive: boolean;
    expectedPositionMode: "HEDGE" | "ONE_WAY";
    expectedMarginType: "ISOLATED" | "CROSS";
    maxOpenPositions: number;
    maxPendingEntries: number;
    maxTotalActiveTrades: number;
    maxTotalPlannedRiskUsd: string;
    maxTotalIsolatedMarginUsd: string;
    maxActivePerSymbolSide: number;
    maxAlertAgeSeconds: number;
    allowedSymbols: string[];
  }
): EffectiveSafetyPolicy {
  return {
    globalKillSwitchActive: global.killSwitchActive,
    profileKillSwitchActive: profile.killSwitchActive,
    killSwitchActive: global.killSwitchActive || profile.killSwitchActive,
    profileEnabled: profile.enabled,
    policyPresent: profile.present,
    environmentMatchesConnector: profile.environmentMatchesConnector,
    expectedPositionMode: profile.expectedPositionMode,
    expectedMarginType: profile.expectedMarginType,
    // The limits come from the shared merge so preflight cannot disagree.
    ...mergeCapacityLimits(global, profile),
    signalFutureToleranceSeconds: global.signalFutureToleranceSeconds,
    allowedSymbols: profile.allowedSymbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean),
  };
}

function decimalOrNull(value: string | null | undefined): DecimalValue | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  try {
    const parsed = new D(String(value).trim());
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Evaluates one admission. Returns PASS only when every check passes; a
 * missing-data failure yields UNAVAILABLE, any policy failure yields SKIP.
 */
export function evaluateSafetyAdmission(input: SafetyEvaluationInput): SafetyDecisionResult {
  const { evaluatedAt, proposed, policy, local, binance, symbolState } = input;
  const failed: FailedCheck[] = [];
  const warnings: string[] = [...(proposed.marginPlanWarnings ?? [])];
  const fail = (reasonCode: SafetyReasonCode, message: string) => failed.push({ reasonCode, message });

  const riskReservation = decimalOrNull(proposed.riskBudgetUsd);
  const marginReservation = decimalOrNull(proposed.maximumIsolatedMargin);

  const capacityBefore: CapacityTotals = {
    openPositionCount: local.openPositionCount,
    pendingEntryCount: local.pendingEntryCount,
    totalActiveCount: local.totalActiveCount,
    reservedRiskUsd: local.reservedRiskUsd,
    reservedMarginUsd: local.reservedMaximumMarginUsd,
  };

  const projectedRisk = (decimalOrNull(local.reservedRiskUsd) ?? new D(0)).plus(riskReservation ?? new D(0));
  const projectedMargin = (decimalOrNull(local.reservedMaximumMarginUsd) ?? new D(0)).plus(
    marginReservation ?? new D(0)
  );
  const capacityProjected: CapacityTotals = {
    openPositionCount: local.openPositionCount,
    pendingEntryCount: local.pendingEntryCount + 1,
    totalActiveCount: local.totalActiveCount + 1,
    reservedRiskUsd: projectedRisk.toString(),
    reservedMarginUsd: projectedMargin.toString(),
  };

  // --- 1. Kill switches (short-circuit; caller skips Binance calls) --------
  if (policy.globalKillSwitchActive) {
    fail("GLOBAL_KILL_SWITCH_ACTIVE", "Global execution kill switch is active; no new admissions.");
  }
  if (policy.profileKillSwitchActive) {
    fail("PROFILE_KILL_SWITCH_ACTIVE", "Profile kill switch is active; no new admissions for this profile.");
  }

  // --- 2. Profile ---------------------------------------------------------
  if (!policy.policyPresent) fail("PROFILE_POLICY_UNAVAILABLE", "No safety policy exists for this profile.");
  // PROFILE_DISABLED is reserved for an actually disabled profile; every other
  // configuration mismatch has its own stable code so operators can tell an
  // intentionally-off profile from a misconfigured one.
  if (!policy.profileEnabled) fail("PROFILE_DISABLED", "Execution profile is disabled.");
  if (!policy.environmentMatchesConnector) {
    fail(
      "PROFILE_ENVIRONMENT_MISMATCH",
      "Profile environment does not match the active Binance connector environment."
    );
  }
  if (policy.expectedPositionMode !== "HEDGE") {
    fail("EXPECTED_HEDGE_MODE", "Profile is not configured for HEDGE position mode.");
  }
  if (policy.expectedMarginType !== "ISOLATED") {
    fail("EXPECTED_ISOLATED_MARGIN_TYPE", "Profile is not configured for ISOLATED margin.");
  }

  // --- 3. Freshness (original signal time only, never createdAt) ----------
  let signalAgeSeconds: number | null = null;
  if (!proposed.signalTriggeredAt || Number.isNaN(proposed.signalTriggeredAt.getTime())) {
    fail("SIGNAL_TIME_UNAVAILABLE", "No trustworthy original signal timestamp; refusing to infer freshness.");
  } else {
    const deltaMs = evaluatedAt.getTime() - proposed.signalTriggeredAt.getTime();
    signalAgeSeconds = Math.floor(deltaMs / 1000);
    if (signalAgeSeconds < -policy.signalFutureToleranceSeconds) {
      fail(
        "SIGNAL_TIME_UNAVAILABLE",
        `Signal timestamp is ${Math.abs(signalAgeSeconds)}s in the future, beyond the ${policy.signalFutureToleranceSeconds}s clock tolerance.`
      );
    } else if (signalAgeSeconds > policy.maxAlertAgeSeconds) {
      fail("ALERT_STALE", `Signal is ${signalAgeSeconds}s old; the limit is ${policy.maxAlertAgeSeconds}s.`);
    }
  }

  // --- 4. Duplicate / already admitted ------------------------------------
  if (local.alreadyAdmitted) {
    fail("DUPLICATE_EXECUTION", "This execution has already been admitted; capacity is not reserved twice.");
  }
  if (proposed.currentStatus !== "PLAN_READY") {
    fail("DUPLICATE_EXECUTION", `Only a PLAN_READY execution can be admitted (status is ${proposed.currentStatus}).`);
  }

  // --- 5. Symbol support ---------------------------------------------------
  const symbol = proposed.symbol.trim().toUpperCase();
  if (policy.allowedSymbols.length > 0 && !policy.allowedSymbols.includes(symbol)) {
    fail("SYMBOL_NOT_ALLOWED", `${symbol} is not in the profile symbol allowlist.`);
  }
  if (!symbolState.available) {
    fail("BINANCE_SYMBOL_STATE_UNAVAILABLE", "Symbol state could not be read from Binance.");
  } else {
    if (!symbolState.exists) fail("UNSUPPORTED_SYMBOL", `${symbol} is not listed on Binance USDⓈ-M futures.`);
    else {
      if ((symbolState.status ?? "").toUpperCase() !== "TRADING") {
        fail("SYMBOL_NOT_TRADING", `${symbol} status is ${symbolState.status ?? "unknown"}, not TRADING.`);
      }
      if ((symbolState.contractType ?? "").toUpperCase() !== "PERPETUAL") {
        fail("UNSUPPORTED_CONTRACT", `${symbol} contract type is ${symbolState.contractType ?? "unknown"}.`);
      }
    }
  }
  // Two different failures used to share one code. They are separated because
  // their retryability differs: the FROZEN plan snapshot lives on the
  // execution and can never appear later, while the LIVE filters/bracket read
  // is just this attempt's symbol state and may succeed next time.
  if (!proposed.hasMarginPlanSnapshot) {
    fail("MARGIN_PLAN_SNAPSHOT_MISSING", "The frozen margin-plan snapshot is missing from this execution.");
  }
  if (symbolState.available && (!symbolState.hasFiltersSnapshot || !symbolState.hasBracketSnapshot)) {
    fail(
      "BINANCE_SYMBOL_STATE_UNAVAILABLE",
      "Symbol filters or leverage brackets were incomplete in this read; nothing was recalculated."
    );
  }

  // --- 6. Frozen Phase 3 plan must be READY and liquidation-safe ----------
  if ((proposed.marginPlanStatus ?? "").toUpperCase() !== "READY" || proposed.selectedLeverage === null) {
    fail("MARGIN_PLAN_NOT_READY", "The frozen margin plan is not READY with a selected leverage.");
  }

  const liquidation = decimalOrNull(proposed.estimatedLiquidationPrice);
  const boundary = decimalOrNull(proposed.requiredLiquidationBoundary);
  if (liquidation === null || boundary === null) {
    // Phase 5 never invents an estimate — missing data fails closed.
    fail("UNSAFE_LIQUIDATION_BUFFER", "Liquidation estimate or required boundary is missing; cannot prove safety.");
  } else if (proposed.positionSide === "SHORT") {
    if (liquidation.lessThan(boundary)) {
      fail("UNSAFE_LIQUIDATION_BUFFER", "SHORT liquidation estimate sits inside the required safety buffer.");
    }
  } else if (liquidation.greaterThan(boundary)) {
    fail("UNSAFE_LIQUIDATION_BUFFER", "LONG liquidation estimate sits inside the required safety buffer.");
  }

  // --- 7. Binance account state -------------------------------------------
  if (!binance.available) {
    fail("BINANCE_ACCOUNT_STATE_UNAVAILABLE", "Binance account state could not be read.");
  } else {
    if (binance.positionMode !== "HEDGE") {
      fail("EXPECTED_HEDGE_MODE", `Binance account position mode is ${binance.positionMode ?? "unknown"}, expected HEDGE.`);
    }
    if (binance.assetMode !== "SINGLE_ASSET") {
      fail(
        "EXPECTED_SINGLE_ASSET_MODE",
        `Binance account asset mode is ${binance.assetMode ?? "unknown"}, expected SINGLE_ASSET.`
      );
    }
    // First live executor: ANY existing exposure or order on the symbol blocks
    // admission, regardless of side (a leverage/margin change would otherwise
    // affect live exposure).
    if (binance.symbolsWithPosition.map((s) => s.toUpperCase()).includes(symbol)) {
      fail("SYMBOL_HAS_OPEN_POSITION_OR_ORDER", `${symbol} already has an open Binance position.`);
    }
    if (binance.symbolsWithOpenOrder.map((s) => s.toUpperCase()).includes(symbol)) {
      fail("SYMBOL_HAS_OPEN_POSITION_OR_ORDER", `${symbol} already has an open Binance order.`);
    }
  }

  // --- 8. Local symbol/side and count capacity ----------------------------
  const key = symbolSideKey(symbol, proposed.positionSide);
  const sameKeyCount = local.activeSymbolSideKeys.filter((existing) => existing === key).length;
  if (sameKeyCount >= policy.maxActivePerSymbolSide) {
    fail("SYMBOL_SIDE_ALREADY_ACTIVE", `${key} already has ${sameKeyCount} active execution(s).`);
  }
  if (local.openPositionCount >= policy.maxOpenPositions) {
    fail("OPEN_POSITION_LIMIT_REACHED", `Open positions ${local.openPositionCount}/${policy.maxOpenPositions}.`);
  }
  if (local.pendingEntryCount >= policy.maxPendingEntries) {
    fail("PENDING_ENTRY_LIMIT_REACHED", `Pending entries ${local.pendingEntryCount}/${policy.maxPendingEntries}.`);
  }
  if (local.totalActiveCount >= policy.maxTotalActiveTrades) {
    fail("TOTAL_ACTIVE_LIMIT_REACHED", `Active trades ${local.totalActiveCount}/${policy.maxTotalActiveTrades}.`);
  }

  // --- 9. Risk and margin totals (decimal, inclusive limits) --------------
  if (riskReservation === null || marginReservation === null) {
    fail("MARGIN_PLAN_SNAPSHOT_MISSING", "Risk budget or maximum isolated margin is missing from the frozen plan.");
  } else {
    if (projectedRisk.greaterThan(new D(policy.maxTotalPlannedRiskUsd))) {
      fail(
        "TOTAL_RISK_LIMIT_REACHED",
        `Projected planned risk ${projectedRisk.toString()} exceeds ${policy.maxTotalPlannedRiskUsd}.`
      );
    }
    if (projectedMargin.greaterThan(new D(policy.maxTotalIsolatedMarginUsd))) {
      fail(
        "TOTAL_MARGIN_LIMIT_REACHED",
        `Projected reserved margin ${projectedMargin.toString()} exceeds ${policy.maxTotalIsolatedMarginUsd}.`
      );
    }
  }

  // --- 10. Available balance ----------------------------------------------
  if (binance.available) {
    const availableBalance = decimalOrNull(binance.usdtAvailableBalance);
    if (availableBalance === null) {
      fail("BINANCE_ACCOUNT_STATE_UNAVAILABLE", "USDT available balance is unavailable.");
    } else if (marginReservation !== null) {
      // Conservative: subtract local reservations Binance cannot yet reflect
      // (pending entries whose margin is not committed on the exchange).
      const unreflected = decimalOrNull(local.pendingUnreflectedMarginUsd) ?? new D(0);
      const effectiveAvailable = availableBalance.minus(unreflected);
      if (effectiveAvailable.lessThan(marginReservation)) {
        fail(
          "INSUFFICIENT_AVAILABLE_BALANCE",
          `Effective available balance ${effectiveAvailable.toString()} is below the required ${marginReservation.toString()}.`
        );
      }
    }
  }

  // --- Decide --------------------------------------------------------------
  // Retryable only when EVERY failure is retryable. A single terminal failure
  // makes the whole decision terminal, so a permanent precondition can never
  // hide behind a transient one and be retried forever.
  const allRetryable =
    failed.length > 0 && failed.every((check) => classifySafetyReasonRetryability(check.reasonCode) === "RETRYABLE");
  const decision: SafetyDecisionName = failed.length === 0 ? "PASS" : allRetryable ? "UNAVAILABLE" : "SKIP";

  // The reported reason must agree with the decision: on a terminal outcome
  // report the first TERMINAL check, not a transient one that happens to be
  // listed earlier.
  const primary =
    (decision === "SKIP"
      ? failed.find((check) => classifySafetyReasonRetryability(check.reasonCode) === "TERMINAL")
      : failed[0]) ?? null;

  return {
    decision,
    reasonCode: primary?.reasonCode ?? null,
    failedChecks: failed,
    message:
      failed.length === 0
        ? "All safety and capacity checks passed."
        : failed.map((check) => check.message).join(" "),
    evaluatedAt: evaluatedAt.toISOString(),
    signalAgeSeconds,
    effectiveLimits: policy,
    capacityBefore,
    proposedReservations: {
      // The FULL risk budget (not the reduced rounded loss) and the MAXIMUM
      // isolated margin (not the selected estimate) are reserved, so a later
      // safety top-up still fits inside the configured ceiling.
      riskUsd: proposed.riskBudgetUsd,
      marginUsd: proposed.maximumIsolatedMargin,
    },
    capacityProjected,
    warnings,
    binanceSnapshotAt: binance.snapshotAt ? binance.snapshotAt.toISOString() : null,
  };
}
