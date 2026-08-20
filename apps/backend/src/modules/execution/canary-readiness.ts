import { Prisma } from "@prisma/client";
// The SAME min-merge admission applies, so preflight and execution can never
// disagree about what the effective policy is.
import type { NaturalWindowState } from "./natural-authorization";
import { mergeCapacityLimits, type SafetyCapacityLimits } from "./safety-engine";

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
 * The exact policy the natural canary requires.
 *
 * This is a READINESS CONTRACT, not the runtime capacity engine. Nothing here
 * limits a live trade: admission enforces `min(env global, profile row)` through
 * `mergeCapacityLimits`, and this constant is only compared against those two
 * so an operator cannot activate under limits nobody reviewed. Changing it
 * changes what preflight DEMANDS, never what execution ALLOWS.
 *
 * Every pinned value is judged on THREE sides — env global, profile row and the
 * effective merge — and all three must equal it, so a stale row cannot hide
 * behind a correct global.
 *
 * Phase 12.4A moved this from the historical one-slot $1.50 contract to the
 * reviewed 3-soft/5-hard envelope the live profile has held since policy
 * version 3. The MAINNET row was NOT touched; only this code expectation moved
 * to match it, which is what unblocks CANARY_BLOCKED_POLICY.
 */
export const CANARY_POLICY = {
  maxOpenPositions: 5,
  maxPendingEntries: 5,
  maxTotalActiveTrades: 5,
  maxActivePerSymbolSide: 1,
  // SOFT 3 under a HARD 5. New admission stops at three open positions while
  // the account can still safely hold five, so a fill that beats a cancellation
  // is never invalidated. See softOpenPositionTarget on ExecutionSafetyPolicy.
  softOpenPositionTarget: 3,
  // Five $1.50 plans reserve 5 x 1.50 = 7.50 of planned risk, and five MAXIMUM
  // isolated margins at the 5.333333 multiplier reserve 5 x 7.9999995 =
  // 39.9999975, which 40.00 covers. Both are AGGREGATE admission ceilings and
  // are never an input to per-plan sizing.
  maxTotalPlannedRiskUsd: "7.50",
  maxTotalIsolatedMarginUsd: "40.00",
} as const;

/**
 * The cumulative claim budget the FIRST supervised natural canary is pinned to.
 *
 * Deliberately a SEPARATE constant rather than derived from
 * `CANARY_POLICY.maxTotalActiveTrades`, even though both are 5 today. They mean
 * different things: `maxTotalActiveTrades` bounds how many trades may be open
 * AT ONCE, while `maxClaims` bounds how many may ever be admitted from one
 * window. A future canary could legitimately pair five concurrent slots with a
 * larger cumulative budget, and deriving one from the other would silently
 * couple them.
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

/** Exactly the limits CANARY_POLICY pins, on one side of the merge. */
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

/** Which side of the merge a mismatch came from. Carried in the finding detail. */
export const POLICY_MISMATCH_SOURCES = [
  "GLOBAL_POLICY_MISMATCH",
  "PROFILE_POLICY_MISMATCH",
  "PROFILE_POLICY_CLAMPS_REQUIRED_CANARY_LIMIT",
  "EFFECTIVE_POLICY_MISMATCH",
  "PROFILE_POLICY_UNAVAILABLE",
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

function equalDecimal(left: string, right: string): boolean {
  try {
    return new D(left).equals(new D(right));
  } catch {
    return false;
  }
}

/** The limits the canary pins, in a fixed order for stable reporting. */
export const CANARY_PINNED_LIMITS = [
  "maxOpenPositions",
  "maxPendingEntries",
  "maxTotalActiveTrades",
  "maxActivePerSymbolSide",
  "softOpenPositionTarget",
  "maxTotalPlannedRiskUsd",
  "maxTotalIsolatedMarginUsd",
] as const satisfies ReadonlyArray<keyof CanaryPolicyLimits & keyof typeof CANARY_POLICY>;

/**
 * Pads the pinned limits into the shape the shared merge consumes.
 *
 * `maxAlertAgeSeconds` is min-merged by admission but is NOT pinned by the
 * canary, so it is filled with a neutral value here and never read back. The
 * point is to reuse the real arithmetic for the six that ARE pinned rather
 * than restate `Math.min` in a second place.
 */
function withMergeDefaults(limits: CanaryPolicyLimits): SafetyCapacityLimits {
  return { ...limits, maxAlertAgeSeconds: Number.MAX_SAFE_INTEGER };
}

/**
 * The effective pinned limits, for callers that want to DISPLAY the merge
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
  // Every pinned limit is judged on THREE values, not one: the env global, the
  // profile row, and the effective min-merge admission will actually apply.
  // All three must equal the pinned canary value.
  //
  // Requiring the ROW to match, not merely the effective result, is deliberate:
  // a row wider than the canary (row 10 while global is 8) produces a correct
  // effective 8 today, but the moment the global is relaxed the row stops
  // clamping and the canary silently runs under a limit nobody reviewed. A
  // pinned canary has to be reproducible from its own configuration.
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

    for (const name of CANARY_PINNED_LIMITS) {
      const required = CANARY_POLICY[name];
      const same = (value: number | string) =>
        typeof required === "number" ? value === required : equalDecimal(String(value), required);

      const globalOk = same(global[name]);
      const rowOk = same(row[name]);
      const effectiveOk = same(effective[name]);
      if (globalOk && rowOk && effectiveOk) continue;

      // Name the side that is actually wrong. The clamp case is called out
      // separately because it is the one an env-only check used to miss.
      let source: PolicyMismatchSource;
      if (!globalOk && !rowOk) source = "EFFECTIVE_POLICY_MISMATCH";
      else if (!globalOk) source = "GLOBAL_POLICY_MISMATCH";
      else if (!effectiveOk) source = "PROFILE_POLICY_CLAMPS_REQUIRED_CANARY_LIMIT";
      else source = "PROFILE_POLICY_MISMATCH";

      add(
        "CANARY_BLOCKED_POLICY",
        `${source}: ${name} global ${String(global[name])}, row ${String(row[name])}, ` +
          `effective ${String(effective[name])}; the canary requires ${String(required)}.`
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
