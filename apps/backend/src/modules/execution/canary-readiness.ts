import { Prisma } from "@prisma/client";
// The SAME min-merge admission applies, so preflight and execution can never
// disagree about what the effective policy is.
import type { NaturalWindowState } from "./natural-authorization";
import {
  mergeCapacityLimits,
  policyReachabilityViolations,
  type SafetyCapacityLimits,
} from "./safety-engine";

/**
 * Phase 11A — pure live-canary readiness evaluation.
 *
 * No network, no Prisma client, no credentials, no I/O: a function of values
 * the caller already read. Nothing here can enable trading, and nothing here
 * can mutate anything.
 *
 * The distinction that matters most in this file is PREPARATION readiness
 * versus LIVE-ACTIVATION readiness. During Phase 11A every live gate is
 * expected to be OFF — that is the correct state, not a defect — so a closed
 * gate must never be reported as a preparation failure.
 */

const D = Prisma.Decimal;

export const CANARY_READINESS_CODES = [
  "CANARY_READY",
  "CANARY_BLOCKED_BINANCE",
  "CANARY_BLOCKED_IP_RESTRICTION",
  "CANARY_BLOCKED_ACCOUNT_MODE",
  "CANARY_BLOCKED_EXISTING_POSITIONS",
  "CANARY_BLOCKED_EXISTING_ORDERS",
  "CANARY_BLOCKED_LOCAL_EXECUTION",
  "CANARY_BLOCKED_RECOVERY_REQUIRED",
  "CANARY_BLOCKED_POLICY",
  "CANARY_BLOCKED_WORKER",
  "CANARY_BLOCKED_DATABASE",
  "CANARY_BLOCKED_REDIS",
  "CANARY_BLOCKED_KILL_SWITCH_STATE",
  "CANARY_BLOCKED_GATE_STATE",
  /**
   * Phase 11A addition. The execution lifecycle exists and is tested, but no
   * production caller invokes it — no worker, scheduler or route creates a
   * TradeExecution, submits an entry, reconciles a fill or places protection.
   * Until that orchestration is registered, a live canary cannot run at all,
   * whatever the gates say.
   */
  "CANARY_BLOCKED_ORCHESTRATION_NOT_WIRED",

  /**
   * Phase 12.4A. The profile has no usable authorization for the canary it is
   * being prepared for.
   *
   * ONE code with the specific cause in `detail`, mirroring how
   * CANARY_BLOCKED_POLICY reports POLICY_MISMATCH_SOURCES — rather than seven
   * near-identical codes. Scoped LIVE_ACTIVATION, because a window that has not
   * been prepared yet is the NORMAL state while preparing: it must never make
   * `execution:prepare-canary` refuse to run.
   */
  "CANARY_BLOCKED_AUTHORIZATION",
  /**
   * Phase 12.4D-A.1. ONE code for every runtime-attestation failure — missing,
   * stale, duplicate, mismatched or unreadable — with the specific cause in the
   * detail, deliberately avoiding a five-code explosion for one concern.
   * Scoped LIVE_ACTIVATION: preparation must stay possible with runtime DOWN.
   */
  "CANARY_BLOCKED_RUNTIME_ATTESTATION",
] as const;

export type CanaryReadinessCode = (typeof CANARY_READINESS_CODES)[number];

/**
 * Which kind of readiness a blocker affects.
 *
 *  - PREPARATION: the repository/runtime is not ready. Must be fixed in 11A.
 *  - LIVE_ACTIVATION: expected to block during 11A, cleared only inside an
 *    explicitly authorized canary window by a deliberate operator action.
 */
export type ReadinessScope = "PREPARATION" | "LIVE_ACTIVATION";

export const BLOCKER_SCOPE: Record<Exclude<CanaryReadinessCode, "CANARY_READY">, ReadinessScope> = {
  CANARY_BLOCKED_BINANCE: "PREPARATION",
  CANARY_BLOCKED_IP_RESTRICTION: "PREPARATION",
  CANARY_BLOCKED_ACCOUNT_MODE: "PREPARATION",
  CANARY_BLOCKED_EXISTING_POSITIONS: "PREPARATION",
  CANARY_BLOCKED_EXISTING_ORDERS: "PREPARATION",
  CANARY_BLOCKED_LOCAL_EXECUTION: "PREPARATION",
  CANARY_BLOCKED_RECOVERY_REQUIRED: "PREPARATION",
  CANARY_BLOCKED_POLICY: "PREPARATION",
  CANARY_BLOCKED_WORKER: "PREPARATION",
  CANARY_BLOCKED_DATABASE: "PREPARATION",
  CANARY_BLOCKED_REDIS: "PREPARATION",
  CANARY_BLOCKED_ORCHESTRATION_NOT_WIRED: "PREPARATION",
  // All three of these are SUPPOSED to block right now.
  CANARY_BLOCKED_KILL_SWITCH_STATE: "LIVE_ACTIVATION",
  CANARY_BLOCKED_GATE_STATE: "LIVE_ACTIVATION",
  CANARY_BLOCKED_RUNTIME_ATTESTATION: "LIVE_ACTIVATION",
  // An unprepared window is the expected state while preparing, exactly like a
  // closed gate. Making it a PREPARATION blocker would deadlock the operator:
  // `execution:prepare-canary` refuses to run while any preparation blocker
  // exists, so "no window yet" would prevent creating one.
  CANARY_BLOCKED_AUTHORIZATION: "LIVE_ACTIVATION",
};

/**
 * ## Why there is no pinned policy constant here any more
 *
 * Readiness used to hold an exact envelope — 3 soft / 5 hard / 7.50 / 40.00 —
 * and demand that the env global, the profile row AND the effective merge all
 * equal it. That was the right guard when those numbers were the only reviewed
 * configuration and the only way to change them was an operator CLI.
 *
 * The Trading Policy Editor replaced that premise. An operator now selects the
 * operational limits deliberately, behind SAFE OFF, operator authentication,
 * validation and an optimistic-lock version, and the environment holds the
 * hard ceiling the dashboard cannot exceed. Under that model the three-sided
 * equality check is no longer a safety property — it is a copy of one
 * historical configuration, and it blocks every later one. A policy of 5/8/8/8
 * under an env ceiling of 20/20/20/20 is strictly inside the reviewed bounds
 * and was still refused as EFFECTIVE_POLICY_MISMATCH.
 *
 * So readiness now judges the EFFECTIVE policy on its merits:
 *
 *  1. it must be readable at all (a missing row proves nothing);
 *  2. every effective limit must be usable — a zero admits nothing;
 *  3. no effective limit may exceed its env ceiling, which is what keeps the
 *     environment a hard ceiling rather than a suggestion;
 *  4. the effective limits must be mutually reachable, by the SAME rules
 *     `SafetyPolicyService` enforces when the row is written.
 *
 * What was NOT relaxed: the effective values judged here are the ones
 * `mergeCapacityLimits` produces, which is the identical function admission
 * calls. Readiness and execution cannot disagree about the limits.
 *
 * `CANARY_NATURAL_MAX_CLAIMS` below is a different concept and is unchanged.
 */

/**
 * The cumulative claim budget the FIRST supervised natural canary is pinned to.
 *
 * Deliberately a SEPARATE constant, never derived from a capacity limit.
 * They mean different things: `maxTotalActiveTrades` bounds how many trades
 * may be open AT ONCE, while `maxClaims` bounds how many may ever be admitted
 * from one window. Coupling them would make a change to the operational
 * policy silently move the claim budget of every window.
 *
 * Untouched by the move away from a pinned capacity envelope: this is a
 * property of the AUTHORIZATION, not of the safety policy.
 *
 * Defined once, here, so no second module hard-codes the number.
 */
export const CANARY_NATURAL_MAX_CLAIMS = 5;

export interface InfrastructureState {
  databaseReady: boolean;
  redisReady: boolean;
  executionWorkerReady: boolean;
  notificationSchedulerReady: boolean;
  /** True only when a production caller actually drives the lifecycle. */
  executionOrchestrationWired: boolean;
}

export interface BinanceState {
  connected: boolean;
  signedRequestWorks: boolean;
  /** Consecutive successful signed health checks. */
  consecutiveSignedSuccesses: number;
  requiredConsecutiveSuccesses: number;
  authenticationFailed: boolean;
  ipRestricted: boolean;
  positionMode: string | null;
  assetMode: string | null;
  nonZeroPositionCount: number | null;
  openOrderCount: number | null;
}

export interface LocalExecutionState {
  activeExecutionCount: number | null;
  pendingEntryCount: number | null;
  openPositionCount: number | null;
  recoveryRequiredCount: number | null;
}

/** The capacity envelope readiness judges, on one side of the merge. */
export interface CanaryPolicyLimits {
  maxOpenPositions: number;
  maxPendingEntries: number;
  maxTotalActiveTrades: number;
  maxActivePerSymbolSide: number;
  softOpenPositionTarget: number;
  maxTotalPlannedRiskUsd: string;
  maxTotalIsolatedMarginUsd: string;
}

/**
 * Both sides of the policy, never just one.
 *
 * Admission enforces `min(global, profile row)`. Judging the env alone let a
 * correct global hide a stale row: with global 8.00 and a row still at 5.00 the
 * effective ceiling is 5.00, and a canary pinned to 8.00 would have reported
 * READY while being unable to admit its own plan.
 */
export interface PolicyState {
  /** Env-wide limits from config/env. */
  global: CanaryPolicyLimits;
  /**
   * The configured profile's ExecutionSafetyPolicy row. `null` means it could
   * not be read (no profile, no policy row, or the database was unreachable) —
   * never "assume it agrees".
   */
  profile: CanaryPolicyLimits | null;
}

/**
 * Why the effective policy is not fit to activate under. Carried in the detail.
 *
 * The four historical sources — GLOBAL_POLICY_MISMATCH,
 * PROFILE_POLICY_MISMATCH, PROFILE_POLICY_CLAMPS_REQUIRED_CANARY_LIMIT and
 * EFFECTIVE_POLICY_MISMATCH — existed only to say WHICH side differed from the
 * pinned envelope. With no pinned envelope there is nothing to differ from, so
 * they are gone rather than kept as names for a different meaning.
 */
export const POLICY_MISMATCH_SOURCES = [
  "PROFILE_POLICY_UNAVAILABLE",
  /** A limit that admits nothing, so the profile could never trade. */
  "EFFECTIVE_POLICY_UNUSABLE",
  /**
   * The merge produced a value above its env ceiling. `mergeCapacityLimits`
   * makes this unreachable today; it is asserted anyway, because the day it
   * becomes reachable is the day readiness and admission have split.
   */
  "EFFECTIVE_POLICY_EXCEEDS_ENV_CEILING",
  /** The effective limits contradict each other, so part of them is dead. */
  "EFFECTIVE_POLICY_INCONSISTENT",
] as const;
export type PolicyMismatchSource = (typeof POLICY_MISMATCH_SOURCES)[number];

export interface SafetyGateState {
  globalKillSwitch: boolean;
  profileKillSwitchEngaged: boolean | null;
  liveEntryEnabled: boolean;
  protectionReady: boolean;
  accountSetupMutationsEnabled: boolean;
  testOrderEnabled: boolean;
  autoAddMarginEnabled: boolean;
  emergencyCloseMode: string;
}

/** Which mode the canary being prepared is expected to run in. */
export const CANARY_AUTHORIZATION_MODES = ["EXACT_SIGNAL", "NATURAL_WINDOW"] as const;
export type CanaryAuthorizationMode = (typeof CANARY_AUTHORIZATION_MODES)[number];

/** Why the authorization is not ready. Carried in the finding detail. */
export const AUTHORIZATION_MISMATCH_SOURCES = [
  "AUTHORIZATION_STATE_UNAVAILABLE",
  "NO_EXACT_AUTHORIZATION",
  "NO_NATURAL_WINDOW",
  "NATURAL_WINDOW_INVALID",
  "NATURAL_WINDOW_EXPIRED",
  "NATURAL_WINDOW_REVOKED",
  "NATURAL_WINDOW_EXHAUSTED",
  "NATURAL_WINDOW_DIRECTION_CONFIGURATION_INVALID",
  "NATURAL_WINDOW_MAX_CLAIMS_MISMATCH",
] as const;
export type AuthorizationMismatchSource = (typeof AUTHORIZATION_MISMATCH_SOURCES)[number];

/**
 * The authorization side of readiness — SANITIZED, never a row.
 *
 * A natural window carries no secret, and an exact one carries only a hash that
 * must never leave the service, so this describes state rather than passing the
 * record through. `null` fields mean "could not be read", which is always a
 * blocker: not knowing is never the same as being ready.
 */
export interface AuthorizationReadinessState {
  /** Which mode this preflight is judging. */
  mode: CanaryAuthorizationMode;
  /** False when the authorization table could not be read at all. */
  available: boolean;
  /** EXACT_SIGNAL: an unconsumed, unrevoked, unexpired authorization exists. */
  exactPrepared: boolean;
  /** NATURAL_WINDOW: the newest window's state, or null when none exists. */
  naturalState: NaturalWindowState | null;
  naturalAllowedDirections: string[];
  naturalMaxClaims: number | null;
  naturalClaimedCount: number | null;
}

export interface CanaryPreflightInput {
  infrastructure: InfrastructureState;
  binance: BinanceState;
  local: LocalExecutionState;
  policy: PolicyState;
  gates: SafetyGateState;
  authorization: AuthorizationReadinessState;
  /**
   * Absent when the caller did not evaluate runtime attestation at all (for
   * example a pure preparation check). Absent is NOT a blocker — only an
   * evaluated failure is.
   */
  runtimeAttestation?: RuntimeAttestationReadiness;
}

/** Sanitized view of the attestation verdict; carries no gate secrets. */
export interface RuntimeAttestationReadiness {
  evaluated: boolean;
  ok: boolean;
  reasonCode: string | null;
  message: string | null;
}

export interface CanaryFinding {
  code: Exclude<CanaryReadinessCode, "CANARY_READY">;
  scope: ReadinessScope;
  /** Sanitized: counts and names only, never account detail. */
  detail: string;
}

export interface CanaryPreflightResult {
  /** True only when NOTHING blocks, including live activation. */
  ready: boolean;
  /** True when every PREPARATION blocker is clear. */
  preparationReady: boolean;
  findings: CanaryFinding[];
  preparationBlockers: CanaryFinding[];
  liveActivationBlockers: CanaryFinding[];
  summary: CanaryReadinessCode;
}

/** A money ceiling that can actually reserve something. */
function isPositiveDecimal(value: string): boolean {
  try {
    return new D(value).greaterThan(0);
  } catch {
    // Unparseable is never "probably fine".
    return false;
  }
}

/** Decimal-exact `left <= right`; a bad value fails closed. */
function decimalAtMost(left: string, right: string): boolean {
  try {
    return new D(left).lessThanOrEqualTo(new D(right));
  } catch {
    return false;
  }
}

/**
 * The limits readiness validates, in a fixed order for stable reporting.
 *
 * Named for what it now does. These are no longer PINNED to fixed values —
 * each is judged against its env ceiling and its siblings.
 */
export const CANARY_VALIDATED_LIMITS = [
  "maxOpenPositions",
  "maxPendingEntries",
  "maxTotalActiveTrades",
  "maxActivePerSymbolSide",
  "softOpenPositionTarget",
  "maxTotalPlannedRiskUsd",
  "maxTotalIsolatedMarginUsd",
] as const satisfies ReadonlyArray<keyof CanaryPolicyLimits>;

/**
 * Pads the validated limits into the shape the shared merge consumes.
 *
 * `maxAlertAgeSeconds` is min-merged by admission but is not part of the
 * capacity envelope readiness judges, so it is filled with a neutral value
 * here and never read back. The point is to reuse the real arithmetic rather
 * than restate `Math.min` in a second place.
 */
function withMergeDefaults(limits: CanaryPolicyLimits): SafetyCapacityLimits {
  return { ...limits, maxAlertAgeSeconds: Number.MAX_SAFE_INTEGER };
}

/**
 * The effective limits, for callers that want to DISPLAY the merge
 * (the preflight CLI) without restating the arithmetic.
 */
export function effectiveCanaryLimits(
  global: CanaryPolicyLimits,
  profile: CanaryPolicyLimits
): CanaryPolicyLimits {
  const merged = mergeCapacityLimits(withMergeDefaults(global), withMergeDefaults(profile));
  return {
    maxOpenPositions: merged.maxOpenPositions,
    maxPendingEntries: merged.maxPendingEntries,
    maxTotalActiveTrades: merged.maxTotalActiveTrades,
    maxActivePerSymbolSide: merged.maxActivePerSymbolSide,
    softOpenPositionTarget: merged.softOpenPositionTarget,
    maxTotalPlannedRiskUsd: merged.maxTotalPlannedRiskUsd,
    maxTotalIsolatedMarginUsd: merged.maxTotalIsolatedMarginUsd,
  };
}

/**
 * Evaluates every canary precondition.
 *
 * Deliberately collects ALL findings rather than returning the first: an
 * operator preparing a real-money run needs the whole list, not a blocker at a
 * time. An unknown count is never treated as zero — "we could not read it" and
 * "it is empty" are different answers, and only one of them is safe.
 */
export function evaluateCanaryPreflight(input: CanaryPreflightInput): CanaryPreflightResult {
  const findings: CanaryFinding[] = [];
  const add = (code: CanaryFinding["code"], detail: string): void => {
    findings.push({ code, scope: BLOCKER_SCOPE[code], detail });
  };

  // --- Infrastructure ------------------------------------------------------
  if (!input.infrastructure.databaseReady) add("CANARY_BLOCKED_DATABASE", "PostgreSQL is not reachable.");
  if (!input.infrastructure.redisReady) add("CANARY_BLOCKED_REDIS", "Redis is not reachable.");
  if (!input.infrastructure.notificationSchedulerReady) {
    add("CANARY_BLOCKED_WORKER", "The Phase 9 notification scheduler is not registered in the worker runtime.");
  }
  if (!input.infrastructure.executionWorkerReady) {
    add("CANARY_BLOCKED_WORKER", "The execution worker runtime is not alive.");
  }
  if (!input.infrastructure.executionOrchestrationWired) {
    add(
      "CANARY_BLOCKED_ORCHESTRATION_NOT_WIRED",
      "No production caller drives the execution lifecycle: nothing creates a TradeExecution, submits an entry, " +
        "reconciles a fill or places protection. A live canary cannot run until that orchestration is registered."
    );
  }

  // --- Binance connectivity ------------------------------------------------
  if (input.binance.ipRestricted) {
    add("CANARY_BLOCKED_IP_RESTRICTION", "Binance rejected a signed request for an IP restriction.");
  }
  if (input.binance.authenticationFailed) {
    add("CANARY_BLOCKED_BINANCE", "Signed authentication failed.");
  }
  if (!input.binance.connected || !input.binance.signedRequestWorks) {
    add("CANARY_BLOCKED_BINANCE", "The signed Binance connection is not usable.");
  } else if (input.binance.consecutiveSignedSuccesses < input.binance.requiredConsecutiveSuccesses) {
    // One success is luck; a canary needs a connection that is repeatably up.
    add(
      "CANARY_BLOCKED_BINANCE",
      `Only ${input.binance.consecutiveSignedSuccesses} of ${input.binance.requiredConsecutiveSuccesses} consecutive signed health checks succeeded.`
    );
  }

  // --- Account mode --------------------------------------------------------
  if (input.binance.positionMode !== "HEDGE") {
    add("CANARY_BLOCKED_ACCOUNT_MODE", `Position mode is ${input.binance.positionMode ?? "unknown"}; HEDGE is required.`);
  }
  if (input.binance.assetMode !== "SINGLE_ASSET") {
    add("CANARY_BLOCKED_ACCOUNT_MODE", `Asset mode is ${input.binance.assetMode ?? "unknown"}; SINGLE_ASSET is required.`);
  }

  // --- Clean account -------------------------------------------------------
  // The INITIAL canary must start flat. Nothing here cancels or closes
  // anything: what happens to existing exposure is the operator's decision.
  if (input.binance.nonZeroPositionCount === null) {
    add("CANARY_BLOCKED_EXISTING_POSITIONS", "The account-wide position count could not be read.");
  } else if (input.binance.nonZeroPositionCount > 0) {
    add(
      "CANARY_BLOCKED_EXISTING_POSITIONS",
      `${input.binance.nonZeroPositionCount} existing non-zero position(s). Nothing was closed — resolve them manually.`
    );
  }
  if (input.binance.openOrderCount === null) {
    add("CANARY_BLOCKED_EXISTING_ORDERS", "The account-wide open-order count could not be read.");
  } else if (input.binance.openOrderCount > 0) {
    add(
      "CANARY_BLOCKED_EXISTING_ORDERS",
      `${input.binance.openOrderCount} existing open order(s). Nothing was cancelled — resolve them manually.`
    );
  }

  // --- Local execution state ----------------------------------------------
  const { activeExecutionCount, pendingEntryCount, openPositionCount, recoveryRequiredCount } = input.local;
  if (activeExecutionCount === null || pendingEntryCount === null || openPositionCount === null) {
    add("CANARY_BLOCKED_LOCAL_EXECUTION", "Local execution state could not be read.");
  } else if (activeExecutionCount > 0 || pendingEntryCount > 0 || openPositionCount > 0) {
    add(
      "CANARY_BLOCKED_LOCAL_EXECUTION",
      `Local executions are not clean: ${activeExecutionCount} active, ${pendingEntryCount} pending entry, ${openPositionCount} open.`
    );
  }
  if (recoveryRequiredCount === null) {
    add("CANARY_BLOCKED_RECOVERY_REQUIRED", "Recovery-required execution count could not be read.");
  } else if (recoveryRequiredCount > 0) {
    add(
      "CANARY_BLOCKED_RECOVERY_REQUIRED",
      `${recoveryRequiredCount} execution(s) need manual intervention or reconciliation first.`
    );
  }

  // --- Policy --------------------------------------------------------------
  // The EFFECTIVE policy is what admission will apply, so the effective policy
  // is what is judged. It is produced by `mergeCapacityLimits` — the same
  // function `resolveEffectivePolicy` calls on the admission path — so there
  // is one definition of the limits and readiness cannot approve a value
  // execution would not use.
  //
  // The env global keeps its role as a HARD CEILING: it is one side of that
  // merge, so an operator-selected row can only ever tighten it. The row is
  // deliberately NOT required to equal any fixed envelope; the Trading Policy
  // Editor is what reviews it, behind SAFE OFF and operator authentication.
  if (input.policy.profile === null) {
    add(
      "CANARY_BLOCKED_POLICY",
      "PROFILE_POLICY_UNAVAILABLE: the profile's safety-policy row could not be read, " +
        "so the effective policy cannot be proven. Run execution:ensure-profile."
    );
  } else {
    const global = input.policy.global;
    const row = input.policy.profile;
    const effective = effectiveCanaryLimits(global, row);

    const report = (source: PolicyMismatchSource, detail: string) =>
      add("CANARY_BLOCKED_POLICY", `${source}: ${detail}`);

    for (const name of CANARY_VALIDATED_LIMITS) {
      const effectiveValue = effective[name];
      const ceiling = global[name];
      const context =
        `${name} global ${String(ceiling)}, row ${String(row[name])}, ` +
        `effective ${String(effectiveValue)}`;

      // A limit of zero is not a strict policy, it is a profile that can never
      // admit anything. Reported as a policy problem rather than left to
      // surface later as an unexplained refusal on every single alert.
      const usable =
        typeof effectiveValue === "number"
          ? Number.isSafeInteger(effectiveValue) && effectiveValue >= 1
          : isPositiveDecimal(effectiveValue);
      if (!usable) {
        report("EFFECTIVE_POLICY_UNUSABLE", `${context}; this admits nothing.`);
        continue;
      }

      // The min-merge cannot produce this, which is the point of asserting it.
      // If it ever does, readiness and admission have stopped agreeing and the
      // environment has stopped being a ceiling.
      const withinCeiling =
        typeof effectiveValue === "number"
          ? effectiveValue <= (ceiling as number)
          : decimalAtMost(String(effectiveValue), String(ceiling));
      if (!withinCeiling) {
        report(
          "EFFECTIVE_POLICY_EXCEEDS_ENV_CEILING",
          `${context}; the environment ceiling must never be exceeded.`
        );
      }
    }

    // The relationships, on the MERGED values. A row can be internally valid
    // and still merge into a combination where part of it is dead — an env
    // that clamps maxOpenPositions below a surviving softOpenPositionTarget,
    // for instance. Same rules the policy write path enforces.
    for (const violation of policyReachabilityViolations(effective)) {
      report(
        "EFFECTIVE_POLICY_INCONSISTENT",
        `${violation} Effective: open ${effective.maxOpenPositions}, ` +
          `pending ${effective.maxPendingEntries}, total ${effective.maxTotalActiveTrades}, ` +
          `soft ${effective.softOpenPositionTarget}.`
      );
    }
  }

  // --- Authorization (LIVE_ACTIVATION scope) -------------------------------
  // Judged for the mode the operator says they are preparing. Nothing here is
  // a PREPARATION blocker: an unprepared window is the normal starting state.
  const authorization = input.authorization;
  const refuseAuthorization = (source: AuthorizationMismatchSource, detail: string): void => {
    add("CANARY_BLOCKED_AUTHORIZATION", `${source}: ${detail}`);
  };

  if (!authorization.available) {
    refuseAuthorization(
      "AUTHORIZATION_STATE_UNAVAILABLE",
      "the authorization table could not be read, so readiness cannot be proven."
    );
  } else if (authorization.mode === "EXACT_SIGNAL") {
    // Unchanged historical expectation: one prepared, unconsumed exact
    // authorization. Natural fields are NOT required and are not consulted.
    if (!authorization.exactPrepared) {
      refuseAuthorization(
        "NO_EXACT_AUTHORIZATION",
        "no active exact authorization is prepared. Run execution:prepare-canary."
      );
    }
  } else {
    // NATURAL_WINDOW. No token, no symbol, no singular direction is required.
    switch (authorization.naturalState) {
      case null:
        refuseAuthorization(
          "NO_NATURAL_WINDOW",
          "no natural window has been prepared. Run execution:prepare-natural-window."
        );
        break;
      case "INVALID":
        refuseAuthorization("NATURAL_WINDOW_INVALID", "the natural window contradicts its own declared mode.");
        break;
      case "EXPIRED":
        refuseAuthorization("NATURAL_WINDOW_EXPIRED", "the natural window has expired. Prepare a fresh one.");
        break;
      case "REVOKED":
        refuseAuthorization("NATURAL_WINDOW_REVOKED", "the natural window was revoked. Prepare a fresh one.");
        break;
      case "EXHAUSTED":
        refuseAuthorization(
          "NATURAL_WINDOW_EXHAUSTED",
          `the natural window has spent its whole budget ` +
            `(${authorization.naturalClaimedCount ?? "?"}/${authorization.naturalMaxClaims ?? "?"}).`
        );
        break;
      case "AVAILABLE":
        // The window is usable; now judge how it was CONFIGURED.
        if (authorization.naturalAllowedDirections.length === 0) {
          refuseAuthorization(
            "NATURAL_WINDOW_DIRECTION_CONFIGURATION_INVALID",
            "the window names no direction, which admits nothing."
          );
        }
        if (authorization.naturalMaxClaims !== CANARY_NATURAL_MAX_CLAIMS) {
          refuseAuthorization(
            "NATURAL_WINDOW_MAX_CLAIMS_MISMATCH",
            `maxClaims is ${authorization.naturalMaxClaims ?? "unset"}; the canary is pinned to ` +
              `${CANARY_NATURAL_MAX_CLAIMS} cumulative admitted executions.`
          );
        }
        break;
    }
  }

  // --- Runtime attestation (LIVE_ACTIVATION scope) ------------------------
  // Only an EVALUATED failure blocks. When the caller did not evaluate it at
  // all — the normal case while the runtime is intentionally down — nothing is
  // added, so preparationReady is unaffected.
  if (input.runtimeAttestation?.evaluated && !input.runtimeAttestation.ok) {
    add(
      "CANARY_BLOCKED_RUNTIME_ATTESTATION",
      `${input.runtimeAttestation.reasonCode}: ${input.runtimeAttestation.message}`
    );
  }

  // --- Gates (LIVE_ACTIVATION scope) --------------------------------------
  // These are EXPECTED to block during Phase 11A. They are reported so the
  // operator can see the posture, never as a preparation defect.
  if (input.gates.globalKillSwitch) {
    add("CANARY_BLOCKED_KILL_SWITCH_STATE", "EXECUTION_GLOBAL_KILL_SWITCH is engaged (correct until an authorized window).");
  }
  if (input.gates.profileKillSwitchEngaged !== false) {
    add(
      "CANARY_BLOCKED_KILL_SWITCH_STATE",
      input.gates.profileKillSwitchEngaged === null
        ? "No execution profile was found, so its kill switch state is unknown."
        : "The execution profile kill switch is engaged (correct until an authorized window)."
    );
  }
  if (!input.gates.liveEntryEnabled) {
    add("CANARY_BLOCKED_GATE_STATE", "EXECUTION_LIVE_ENTRY_ENABLED is false (correct until an authorized window).");
  }
  if (!input.gates.protectionReady) {
    add("CANARY_BLOCKED_GATE_STATE", "EXECUTION_PROTECTION_READY is false (correct until an authorized window).");
  }
  // These must stay off even DURING a canary window.
  if (input.gates.accountSetupMutationsEnabled) {
    add("CANARY_BLOCKED_GATE_STATE", "BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED must be false during a canary.");
  }
  if (input.gates.testOrderEnabled) {
    add("CANARY_BLOCKED_GATE_STATE", "BINANCE_TEST_ORDER_ENABLED must be false during a canary.");
  }

  const preparationBlockers = findings.filter((finding) => finding.scope === "PREPARATION");
  const liveActivationBlockers = findings.filter((finding) => finding.scope === "LIVE_ACTIVATION");

  return {
    ready: findings.length === 0,
    preparationReady: preparationBlockers.length === 0,
    findings,
    preparationBlockers,
    liveActivationBlockers,
    summary: findings.length === 0 ? "CANARY_READY" : (preparationBlockers[0]?.code ?? liveActivationBlockers[0].code),
  };
}
