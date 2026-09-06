import { Prisma } from "@prisma/client";
import { symbolSideKey } from "./capacity-status";
import { standardTakeProfitMeetsMinNotional } from "./take-profit-notional";

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

  // --- Source-timeframe eligibility --------------------------------------
  //
  // The timeframe the LEVEL originated on, never the chart timeframe the
  // retest fired on. Two codes rather than one because the operator questions
  // are different: NOT_ALLOWED means the signal was understood and the policy
  // excludes it, UNAVAILABLE means the signal never carried a recognised
  // source timeframe at all — a Pine note without `sourceTf`, an unknown
  // value, or an execution predating the frozen column. Collapsing them would
  // report a parsing gap as a policy decision.
  //
  // Both TERMINAL (neither appears in RETRYABLE_REASONS below): an ineligible
  // signal is SKIPPED once and never revived, exactly as capacity and
  // authorization already behave. Widening the policy later does not
  // resurrect it; a NEW alert must arrive.
  "SOURCE_TIMEFRAME_NOT_ALLOWED",
  "SOURCE_TIMEFRAME_UNAVAILABLE",

  "UNSUPPORTED_SYMBOL",
  "SYMBOL_NOT_TRADING",
  "UNSUPPORTED_CONTRACT",

  // --- USDT-only collateral policy ---------------------------------------
  //
  // This execution profile trades USDⓈ-M perpetuals that are QUOTED in USDT
  // and MARGINED in USDT, and nothing else. It is a positive allow rule: a
  // contract is eligible only once authoritative exchange metadata confirms
  // both assets, never because its ticker happens to end in "USDT".
  //
  // Separate from UNSUPPORTED_CONTRACT because the operator question differs.
  // UNSUPPORTED_CONTRACT means "this is not a perpetual"; this means "this is
  // a perpetual we deliberately do not trade". Reading a USDC-margined
  // rejection as a contract-type problem would send someone looking at
  // Binance's listing rather than at our own policy.
  //
  // TERMINAL — it is absent from RETRYABLE_REASONS below. The contract's
  // collateral asset is a property of the listing, not of this attempt, so
  // retrying could only ever produce the same answer.
  "USDT_ONLY_CONTRACT_REQUIRED",

  "EXPECTED_HEDGE_MODE",
  "EXPECTED_SINGLE_ASSET_MODE",
  "EXPECTED_ISOLATED_MARGIN_TYPE",
  "SYMBOL_SIDE_ALREADY_ACTIVE",
  "SYMBOL_HAS_OPEN_POSITION_OR_ORDER",
  "OPEN_POSITION_LIMIT_REACHED",
  // The SOFT target: open exposure has reached the point where new admissions
  // stop, even though the hard capacity above still has room. Deliberately a
  // separate code so an operator can tell "we chose to stop here" from "we ran
  // out of slots", and so it can never be mistaken for a post-fill defect.
  "SOFT_OPEN_TARGET_REACHED",
  "PENDING_ENTRY_LIMIT_REACHED",
  "TOTAL_ACTIVE_LIMIT_REACHED",
  "TOTAL_RISK_LIMIT_REACHED",
  "TOTAL_MARGIN_LIMIT_REACHED",
  "INSUFFICIENT_AVAILABLE_BALANCE",
  "UNSAFE_LIQUIDATION_BUFFER",
  "MARGIN_PLAN_NOT_READY",
  "MARGIN_PLAN_SNAPSHOT_MISSING",
  /**
   * The FIRST take profit this plan would place is a resting LIMIT worth less
   * than the symbol's minimum notional, so it could never be placed.
   *
   * The same identifier the protection lifecycle already uses for this exact
   * condition, deliberately rather than a new one: one condition, one name,
   * whichever gate catches it. TERMINAL — it is absent from RETRYABLE_REASONS
   * because both inputs are frozen (planned quantity, plan take-profit price),
   * so a retry can only ever reach the same answer.
   */
  "PROTECTION_QUANTITY_UNSUPPORTED",
  "BINANCE_ACCOUNT_STATE_UNAVAILABLE",
  "BINANCE_SYMBOL_STATE_UNAVAILABLE",
  "CAPACITY_CONFLICT_RETRY",

  // --- Phase 12.3 — natural-window authorization -------------------------
  //
  // These describe the AUTHORIZATION to admit a new execution, never its
  // capacity. They are deliberately distinct codes rather than reuses: an
  // operator seeing TOTAL_ACTIVE_LIMIT_REACHED would reasonably conclude the
  // account was full, which is a completely different situation from "nothing
  // currently authorizes this signal".
  //
  // Every one is TERMINAL (none appears in RETRYABLE_REASONS below), so an
  // unauthorized alert is SKIPPED once and never revived. A later trade
  // closing, or a fresh window being opened, does not resurrect it — a NEW
  // alert must arrive. That is the same no-queue rule capacity already has.
  //
  // The engine itself never raises these: it stays pure and knows nothing
  // about authorization. SafetyAdmissionService folds them in from inside its
  // transaction, which is the only place the window can be read under the
  // profile lock. See `resolveAdmissionAuthorization` there.
  "NATURAL_AUTHORIZATION_REQUIRED",
  "NATURAL_AUTHORIZATION_INVALID",
  "NATURAL_AUTHORIZATION_REVOKED",
  "NATURAL_AUTHORIZATION_EXPIRED",
  "NATURAL_AUTHORIZATION_EXHAUSTED",
  "NATURAL_AUTHORIZATION_DIRECTION_NOT_ALLOWED",
  "NATURAL_AUTHORIZATION_CONFLICT",
  // --- Session trade budget ------------------------------------------------
  // Distinct codes on purpose. Reusing NATURAL_AUTHORIZATION_EXHAUSTED would
  // tell the operator their authorization ran out when in fact the session's
  // trade budget did — a different fact with a different remedy.
  "SESSION_REQUIRED",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
  "SESSION_BUDGET_EXHAUSTED",
  /** Admissions stopped by the operator; the session itself is intact. */
  "SESSION_PAUSED",
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
/**
 * The ONLY collateral asset this execution profile supports.
 *
 * Deliberately a constant rather than configuration: widening it is a product
 * decision with margin, liquidation and balance consequences, not a setting to
 * be toggled. Anything else is unsupported regardless of what the account
 * happens to hold.
 */
const USDT_ASSET = "USDT";

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
  /**
   * Frozen Alert.sourceTimeframe — the timeframe the LEVEL originated on.
   * Never the chart timeframe. Null means no recognised value was captured,
   * which fails closed rather than matching any policy.
   */
  sourceTimeframe: string | null;
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
  /** Final rounded quantity that would actually be submitted. */
  plannedQuantity: string;
  /** The FROZEN plan take-profit price. Null means the plan has no target. */
  takeProfit: string | null;
  /**
   * Which modality this execution's FIRST take profit would use, resolved from
   * durable lineage and configuration by the caller (the same resolver the
   * protection lifecycle uses). Null when no take profit is intended, or when
   * the lineage is AMBIGUOUS and no modality may be continued.
   */
  intendedTakeProfitModality: "ALGO" | "STANDARD" | null;
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
  /**
   * SOFT admission target. Once open exposure reaches it, NEW admissions stop
   * and the orchestrator cancels remaining live ENTRY orders. It is NOT a
   * post-fill validity rule: a fill that beats the cancellation is real
   * exposure, stays valid up to maxOpenPositions, and is protected normally.
   */
  softOpenPositionTarget: number;
  signalFutureToleranceSeconds: number;
  /** Empty = no extra restriction. */
  allowedSymbols: string[];
  /**
   * Which source timeframes may create a live execution.
   *
   * Read this the OPPOSITE way to `allowedSymbols` directly above. Empty
   * there means no extra restriction; empty HERE admits nothing, because the
   * rule asks whether the list contains the signal's timeframe. The
   * asymmetry is the point — an eligibility list that silently means
   * everything is the failure mode this control exists to prevent.
   */
  allowedSourceTimeframes: string[];
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
  /**
   * Quote and margin asset exactly as Binance reported them, or null when the
   * read did not carry them.
   *
   * Null is NOT a soft "probably fine". The USDT-only rule is a positive
   * allow rule, so a null here means the contract could not be confirmed
   * eligible and the engine refuses on the UNAVAILABLE (retryable) path
   * rather than the unsupported (terminal) one.
   */
  quoteAsset: string | null;
  marginAsset: string | null;
  /**
   * The symbol's authoritative minimum notional, exactly as Binance reported
   * it, or null when the read did not carry one. Never defaulted and never
   * hardcoded: a null is "we could not look", which is not permission.
   */
  minNotional: string | null;
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
  /**
   * SOFT admission target for open positions — never a post-fill validity
   * rule. See `softOpenPositionTarget` on EffectiveSafetyPolicy.
   */
  softOpenPositionTarget: number;
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
    // Stricter side wins here too: either the env or the profile may lower the
    // point at which new admissions stop, and neither can raise the other's.
    softOpenPositionTarget: Math.min(global.softOpenPositionTarget, profile.softOpenPositionTarget),
    maxTotalPlannedRiskUsd: minDecimal(global.maxTotalPlannedRiskUsd, profile.maxTotalPlannedRiskUsd),
    maxTotalIsolatedMarginUsd: minDecimal(global.maxTotalIsolatedMarginUsd, profile.maxTotalIsolatedMarginUsd),
  };
}

/**
 * The count limits whose RELATIONSHIPS decide whether a policy is reachable.
 *
 * Separate from `SafetyCapacityLimits` because only these four constrain one
 * another; money ceilings and alert age stand alone.
 */
export interface PolicyReachabilityLimits {
  maxOpenPositions: number;
  maxPendingEntries: number;
  maxTotalActiveTrades: number;
  softOpenPositionTarget: number;
}

/**
 * The canonical reachability rules for a set of limits, as violation messages.
 *
 * ONE rule set, deliberately. `SafetyPolicyService` throws the first of these
 * when an operator writes a policy row, and canary readiness reports them as
 * findings against the EFFECTIVE limits. Stating them twice is how the two
 * would eventually disagree about what a valid policy is.
 *
 * Checking the effective values is not the same check as validating the row.
 * A row can be internally consistent and still merge into an unreachable
 * combination: env `maxOpenPositions` 3 against a row of 8 gives an effective
 * 3, while a soft target of 5 survives an env soft of 20 — leaving a soft gate
 * above the hard cap that can never fire. Only the merged view shows that.
 *
 * Returns every violation rather than the first, so a caller reporting
 * findings does not have to re-run the check to discover the next one.
 */
export function policyReachabilityViolations(limits: PolicyReachabilityLimits): string[] {
  const violations: string[] = [];
  if (limits.maxTotalActiveTrades < limits.maxOpenPositions) {
    violations.push("maxTotalActiveTrades must be >= maxOpenPositions.");
  }
  if (limits.maxTotalActiveTrades < limits.maxPendingEntries) {
    violations.push("maxTotalActiveTrades must be >= maxPendingEntries.");
  }
  // A soft target above the hard cap is unreachable: the hard limit rejects
  // first and the soft gate never fires, so the policy claims behaviour it
  // does not implement.
  if (limits.softOpenPositionTarget > limits.maxOpenPositions) {
    violations.push("softOpenPositionTarget must be <= maxOpenPositions.");
  }
  return violations;
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
    softOpenPositionTarget: number;
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
    softOpenPositionTarget: number;
    allowedSymbols: string[];
    allowedSourceTimeframes: string[];
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
    // Upper-cased exactly as allowedSymbols above, and for the same reason:
    // the canonical spelling IS upper case, so this makes a hand-edited row
    // comparable without the engine needing to know the vocabulary.
    //
    // It deliberately does NOT validate membership. The engine has no
    // business owning the timeframe vocabulary — the operator service
    // validates what may be STORED. A stored value like "W" simply matches no
    // signal and therefore admits nothing, which is the safe direction.
    allowedSourceTimeframes: (profile.allowedSourceTimeframes ?? [])
      .map((value) => String(value).trim().toUpperCase())
      .filter(Boolean),
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

  // --- 4b. Source-timeframe eligibility ------------------------------------
  //
  // Placed with the other admission rules and therefore BEFORE anything is
  // spent: SafetyAdmissionService reaches the authorization claim and the
  // capacity reservation only when this whole evaluation returns PASS, so an
  // ineligible source timeframe costs no natural-window claim, no risk, no
  // margin and no capacity slot.
  //
  // NOTE the missing `length > 0` guard, which the symbol allowlist above
  // deliberately has and this deliberately does not. `includes` on an empty
  // list is false for every input, so an empty policy refuses everything.
  // That is the required fail-closed behaviour, not an oversight.
  // Already canonical on the execution — it is frozen at creation through the
  // shared normalizer — so this only guards against a legacy or absent value.
  const sourceTimeframe = (proposed.sourceTimeframe ?? "").trim().toUpperCase();
  if (sourceTimeframe === "") {
    fail(
      "SOURCE_TIMEFRAME_UNAVAILABLE",
      "This signal carries no recognised source timeframe, so its eligibility cannot be established."
    );
  } else if (!policy.allowedSourceTimeframes.includes(sourceTimeframe)) {
    fail(
      "SOURCE_TIMEFRAME_NOT_ALLOWED",
      `Source timeframe ${sourceTimeframe} is not enabled for execution (allowed: ${
        policy.allowedSourceTimeframes.length > 0 ? policy.allowedSourceTimeframes.join(", ") : "none"
      }).`
    );
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

      /**
       * USDT-only collateral. The rule the account can actually carry.
       *
       * Stated as a POSITIVE allow rule: both assets must be READ and must
       * both equal USDT. Two consequences follow deliberately.
       *
       * 1. The ticker is never consulted. `USDCUSDT` is a USDT-quoted,
       *    USDT-margined perpetual and is eligible; `BNBUSDC` is not. A
       *    substring or suffix test would get both of those backwards, and a
       *    hypothetical `XYZUSDT` absent from exchangeInfo never reaches here
       *    at all.
       * 2. A MISSING asset is unknown, not acceptable. It refuses on the
       *    retryable UNAVAILABLE path, because "we could not read the
       *    collateral asset" is a fact about this read, whereas "it is USDC"
       *    is a fact about the listing.
       */
      const quoteAsset = (symbolState.quoteAsset ?? "").trim().toUpperCase();
      const marginAsset = (symbolState.marginAsset ?? "").trim().toUpperCase();
      if (quoteAsset === "" || marginAsset === "") {
        fail(
          "BINANCE_SYMBOL_STATE_UNAVAILABLE",
          `${symbol} did not report both a quote asset and a margin asset in this read, so its eligibility could not be established.`
        );
      } else if (quoteAsset !== USDT_ASSET || marginAsset !== USDT_ASSET) {
        fail(
          "USDT_ONLY_CONTRACT_REQUIRED",
          `${symbol} is quoted in ${quoteAsset} and margined in ${marginAsset}; this execution profile trades ${USDT_ASSET}-quoted, ${USDT_ASSET}-margined perpetuals only.`
        );
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

  /**
   * --- 5b. A resting LIMIT take profit that could never be placed ----------
   *
   * A STANDARD take profit is an ordinary order and must clear the symbol's
   * MIN_NOTIONAL; a conditional TAKE_PROFIT_MARKET need not. So a plan whose
   * frozen target is worth less than the floor is, before a single order
   * exists, already guaranteed to fill and then be unable to place its target.
   *
   * FLOCKUSDT proved why this belongs BEFORE entry rather than after the fill.
   * It filled 121 @ 0.05548 with a frozen target of 0.03691 — a notional of
   * 4.46611 against a floor of 5. The stop was placed and verified, the target
   * was refused, and the execution parked at PLACING_PROTECTION permanently:
   * both inputs to that comparison are frozen, so no later tick could ever
   * reach a different answer. That single row then held
   * `countRecoveryRequired() > 0` open, which globally refused EVERY new
   * admission until a human closed the position by hand.
   *
   * Placed with the other admission rules and therefore BEFORE anything is
   * spent: the authorization claim and the capacity reservation are reached
   * only when this whole evaluation returns PASS, so a refusal here costs no
   * claim, no risk, no margin and no capacity slot.
   *
   * Deliberately NARROW. It fires only when the take profit would actually be
   * STANDARD, so the ALGO path is untouched and the flag-off runtime behaves
   * exactly as it did. It never moves the target, never resizes the plan and
   * never converts modality — the plan is refused, not rewritten.
   *
   * A null floor is NOT treated as zero. `hasFiltersSnapshot` above already
   * refuses an incomplete read on the retryable path, so reaching here with no
   * floor means the symbol genuinely reported none, and the shared rule then
   * answers "placeable" rather than inventing a minimum.
   */
  if (
    proposed.intendedTakeProfitModality === "STANDARD" &&
    proposed.takeProfit !== null &&
    symbolState.available &&
    !standardTakeProfitMeetsMinNotional({
      quantity: proposed.plannedQuantity,
      price: proposed.takeProfit,
      minNotional: symbolState.minNotional,
    })
  ) {
    fail(
      "PROTECTION_QUANTITY_UNSUPPORTED",
      `A resting LIMIT take profit of ${proposed.plannedQuantity} at ${proposed.takeProfit} is worth less than ` +
        `${symbol}'s minimum notional of ${symbolState.minNotional}; this plan would fill and then be unable to ` +
        `place its target, so no exposure is opened.`
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
  // The soft gate. Reported IN ADDITION to the hard one when both trip, so the
  // finding list never hides which limit an operator actually configured. It
  // governs NEW admission only — nothing downstream of admission reads it, so
  // an execution that is already filled can never be invalidated by it.
  if (local.openPositionCount >= policy.softOpenPositionTarget) {
    fail(
      "SOFT_OPEN_TARGET_REACHED",
      `Open positions ${local.openPositionCount} reached the soft target ${policy.softOpenPositionTarget} ` +
        `(hard capacity ${policy.maxOpenPositions}); no new execution is admitted and remaining entry orders are cancelled.`
    );
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
