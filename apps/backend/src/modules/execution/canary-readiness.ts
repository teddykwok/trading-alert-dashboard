import { Prisma } from "@prisma/client";

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
  // Both of these are SUPPOSED to block right now.
  CANARY_BLOCKED_KILL_SWITCH_STATE: "LIVE_ACTIVATION",
  CANARY_BLOCKED_GATE_STATE: "LIVE_ACTIVATION",
};

/**
 * The exact policy the initial $1.50 canary requires.
 *
 * Capacity stays at one trade in every dimension. Only the aggregate margin
 * ceiling moved, and only because admission reserves `maximumIsolatedMargin`
 * (risk × BINANCE_MAX_MARGIN_MULTIPLIER), never the smaller selected margin:
 * at the recommended 5.333333 multiplier a single $1.50 plan reserves
 * $7.9999995, so a $5.00 aggregate ceiling could not admit even ONE trade.
 * $8.00 is therefore the one-trade ceiling, NOT room for a second trade —
 * maxTotalActiveTrades = 1 is what bounds the count.
 *
 * These are compared against the ENV globals (see canary-preflight.service),
 * so raising the ceiling here fails the preflight closed until an operator
 * sets EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD deliberately.
 */
export const CANARY_POLICY = {
  maxOpenPositions: 1,
  maxPendingEntries: 1,
  maxTotalActiveTrades: 1,
  maxActivePerSymbolSide: 1,
  maxTotalPlannedRiskUsd: "1.50",
  maxTotalIsolatedMarginUsd: "8.00",
} as const;

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

export interface PolicyState {
  maxOpenPositions: number;
  maxPendingEntries: number;
  maxTotalActiveTrades: number;
  maxActivePerSymbolSide: number;
  maxTotalPlannedRiskUsd: string;
  maxTotalIsolatedMarginUsd: string;
}

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

export interface CanaryPreflightInput {
  infrastructure: InfrastructureState;
  binance: BinanceState;
  local: LocalExecutionState;
  policy: PolicyState;
  gates: SafetyGateState;
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
  const policyChecks: Array<[string, boolean, string]> = [
    ["maxOpenPositions", input.policy.maxOpenPositions === CANARY_POLICY.maxOpenPositions, String(input.policy.maxOpenPositions)],
    ["maxPendingEntries", input.policy.maxPendingEntries === CANARY_POLICY.maxPendingEntries, String(input.policy.maxPendingEntries)],
    ["maxTotalActiveTrades", input.policy.maxTotalActiveTrades === CANARY_POLICY.maxTotalActiveTrades, String(input.policy.maxTotalActiveTrades)],
    ["maxActivePerSymbolSide", input.policy.maxActivePerSymbolSide === CANARY_POLICY.maxActivePerSymbolSide, String(input.policy.maxActivePerSymbolSide)],
    ["maxTotalPlannedRiskUsd", equalDecimal(input.policy.maxTotalPlannedRiskUsd, CANARY_POLICY.maxTotalPlannedRiskUsd), input.policy.maxTotalPlannedRiskUsd],
    ["maxTotalIsolatedMarginUsd", equalDecimal(input.policy.maxTotalIsolatedMarginUsd, CANARY_POLICY.maxTotalIsolatedMarginUsd), input.policy.maxTotalIsolatedMarginUsd],
  ];
  for (const [name, ok, actual] of policyChecks) {
    if (!ok) {
      add(
        "CANARY_BLOCKED_POLICY",
        `${name} is ${actual}; the canary requires ${String(CANARY_POLICY[name as keyof typeof CANARY_POLICY])}.`
      );
    }
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
