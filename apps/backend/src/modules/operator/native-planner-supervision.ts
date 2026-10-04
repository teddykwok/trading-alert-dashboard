import { OPTIONAL_GENERIC_ROLES, ROLE_CONTRACTS, type DualRole, type TopologyStatus } from "./dual-account-topology";
import { genericBackendHealth, leafRuntimeCount } from "./generic-analysis-supervision";
import type { OwnershipVerdict, RoleHealth } from "./runtime-launcher";
import {
  WORKER_RESTART_MAX_ATTEMPTS,
  decideWorkerSupervision,
  type RestartBudget,
  type SupervisionDecision,
  type SupervisionReasonCode,
} from "./worker-supervision";

/**
 * Supervision for the OPTIONAL Native planner worker role.
 *
 * The same shape as the generic analysis role, for the same reasons: a generic
 * role publishes no account attestation, so the launcher's evidence is the
 * process census plus its own ownership record. The decision ladder, restart
 * budget, backoff and stabilization window are `worker-supervision.ts`, called
 * unchanged; this module only supplies the inputs the ladder cannot derive for
 * this role and role-accurate operator text.
 *
 * What makes it OPTIONAL: it is not in DUAL_ROLES, so Start SAFE never starts
 * it, topology verification never requires it, and Stop Runtime never needs to
 * reason about it. It is started, supervised and stopped only by its own menu
 * actions, and it never blocks the TradingView runtime.
 *
 * Everything here is a function of its inputs: nothing is probed, started,
 * terminated, read from a database or written to Redis.
 */

export const NATIVE_PLANNER_ROLE = "native-planner" satisfies DualRole;

/** Census-only health: owner-blind leaf count plus whether our recorded root is alive. */
export function nativePlannerHealth(input: { status: TopologyStatus; ownedRootAlive: boolean }): RoleHealth {
  const leaves = leafRuntimeCount(input.status, NATIVE_PLANNER_ROLE);
  if (leaves > 1) return "DUPLICATE";
  if (leaves === 1) return "HEALTHY";
  return input.ownedRootAlive ? "STALE" : "OFF";
}

export type NativePlannerStartDecision =
  /** Nothing running: start exactly one, through the fenced start. */
  | { readonly act: "START" }
  /** One runtime is already consuming the queue (ours or somebody else's): never add a second. */
  | { readonly act: "NONE"; readonly reason: "ALREADY_RUNNING_OWNED" | "ALREADY_RUNNING_EXTERNAL" | "DUPLICATE_PRESENT" | "OWNED_ROOT_WITHOUT_RUNTIME" };

/**
 * Whether the explicit "Start Native Planner" action may spawn.
 *
 * Owner-blind on purpose, exactly like supervision: a planner started by hand
 * still counts, so the launcher never adds a second consumer to a queue that is
 * already being drained. An owned tree with no runtime inside it is left to
 * supervision (which proves and terminates it first) rather than started beside.
 */
export function decideNativePlannerStart(input: { status: TopologyStatus; ownedRootAlive: boolean }): NativePlannerStartDecision {
  const leaves = leafRuntimeCount(input.status, NATIVE_PLANNER_ROLE);
  if (leaves > 1) return { act: "NONE", reason: "DUPLICATE_PRESENT" };
  if (leaves === 1) return { act: "NONE", reason: input.ownedRootAlive ? "ALREADY_RUNNING_OWNED" : "ALREADY_RUNNING_EXTERNAL" };
  if (input.ownedRootAlive) return { act: "NONE", reason: "OWNED_ROOT_WITHOUT_RUNTIME" };
  return { act: "START" };
}

function messageFor(reasonCode: SupervisionReasonCode, leaves: number): string {
  switch (reasonCode) {
    case "HEALTHY":
      return "The Native planner worker is running.";
    case "NO_RUNTIME_RECORDED":
      return "No launcher-owned Native planner is recorded, so there is nothing to supervise. Start it explicitly first.";
    case "NO_WORKER_RECORDED":
      return (
        "No launcher-owned Native planner is recorded, so supervision owns nothing here. " +
        (leaves > 0
          ? "A Native planner IS running, but this launcher did not start it: it will not be stopped, adopted or duplicated."
          : "Nothing was started.")
      );
    case "WORKER_DUPLICATE":
      return `${leaves} Native planner runtimes are running. Supervision will not add or remove one; resolve the duplicate first.`;
    case "HEALTH_UNKNOWN":
      return "Native planner health could not be read. Nothing was restarted.";
    case "OWNERSHIP_UNPROVEN":
      return "The recorded Native planner PID could not be proven to be ours. Nothing was terminated and nothing was started.";
    case "BACKEND_NOT_HEALTHY":
      return "The generic backend is not running, so this is not a planner-only failure. Supervision will not repair half a generic runtime.";
    case "STABILIZING":
      return "A Native planner was started moments ago and is still coming up; its health is not judged yet.";
    case "BACKOFF_PENDING":
      return "The Native planner did not come back within its stabilization window; waiting out the restart backoff before trying again.";
    case "RESTART_BUDGET_EXHAUSTED":
      return `The Native planner failed to come back across ${WORKER_RESTART_MAX_ATTEMPTS} restart attempts. Automatic recovery has stopped; operator intervention is required.`;
    case "WORKER_EXITED":
      return "The Native planner process tree is gone. Starting exactly one replacement from the generic environment file.";
    case "WORKER_STALE":
      return (
        "The Native planner tree is ours but has no runtime inside it. " +
        "Stopping the owned tree first, then starting exactly one replacement from the generic environment file."
      );
    case "INCONSISTENT_OBSERVATION":
      return "Native planner ownership and health disagree. Nothing was changed.";
    case "OWNED_ROOT_WITHOUT_RUNTIME":
    case "WORKER_RUNTIME_UNHEALTHY":
    case "STARTUP_GRACE":
    case "LEAF_CENSUS_UNKNOWN":
    case "LEAF_UNEXPLAINED":
      return "Native planner supervision does not use account leaf accounting. Nothing was changed.";
  }
}

export interface NativePlannerSupervisionInput {
  readonly record: { readonly pid: number; readonly startedAtMs: number } | null;
  readonly ownership: OwnershipVerdict | null;
  readonly status: TopologyStatus;
  readonly budget: RestartBudget;
  readonly nowMs: number;
  /** True when the Native planner's own state file exists. */
  readonly hasRuntimeState: boolean;
}

/** The reviewed ladder, unchanged; only the sentence is role-specific. */
export function decideNativePlannerSupervision(input: NativePlannerSupervisionInput): SupervisionDecision {
  const ownedRootAlive = input.ownership?.owned === true;
  const leaves = leafRuntimeCount(input.status, NATIVE_PLANNER_ROLE);
  const decision = decideWorkerSupervision({
    // Only `pid` is read from the ladder's record; the role is fixed by the caller.
    record: input.record === null ? null : { role: "worker", pid: input.record.pid, startedAtMs: input.record.startedAtMs },
    ownership: input.ownership,
    workerHealth: nativePlannerHealth({ status: input.status, ownedRootAlive }),
    backendHealth: genericBackendHealth(input.status),
    budget: input.budget,
    nowMs: input.nowMs,
    hasRuntimeState: input.hasRuntimeState,
  });
  return { ...decision, message: messageFor(decision.reasonCode, leaves) };
}

export function renderNativePlannerSupervision(decision: SupervisionDecision, budget: RestartBudget): string[] {
  const attempts = budget.attempts === 0 ? "" : `  (restart attempts ${budget.attempts}/${WORKER_RESTART_MAX_ATTEMPTS})`;
  return [`${ROLE_CONTRACTS[NATIVE_PLANNER_ROLE].label} supervision: ${decision.state}${attempts}`, `  ${decision.message}`];
}

/** The launcher status line: census + ownership only. */
export function renderNativePlannerStatus(input: { status: TopologyStatus; ownedRootAlive: boolean }): string {
  const leaves = leafRuntimeCount(input.status, NATIVE_PLANNER_ROLE);
  const presence =
    leaves > 1 ? `DUPLICATE (${leaves} runtimes)` : leaves === 1 ? (input.ownedRootAlive ? "ON (launcher-owned)" : "ON (external)") : input.ownedRootAlive ? "STALE (owned tree, no runtime)" : "OFF";
  return `${ROLE_CONTRACTS[NATIVE_PLANNER_ROLE].label} (optional, generic, not part of Start SAFE): ${presence}`;
}

/** Guard for tests and wiring: the role is optional and generic, never part of the SAFE six. */
export function isOptionalGenericRole(role: DualRole): boolean {
  return OPTIONAL_GENERIC_ROLES.includes(role) && ROLE_CONTRACTS[role].account === "GENERIC" && ROLE_CONTRACTS[role].attests === null;
}
