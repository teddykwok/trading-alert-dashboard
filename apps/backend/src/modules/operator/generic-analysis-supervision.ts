import { ROLE_CONTRACTS, type DualRole, type TopologyStatus } from "./dual-account-topology";
import type { OwnershipVerdict, RoleHealth } from "./runtime-launcher";
import {
  WORKER_RESTART_MAX_ATTEMPTS,
  decideWorkerSupervision,
  type RestartBudget,
  type SupervisionDecision,
  type SupervisionReasonCode,
} from "./worker-supervision";

/**
 * Supervision for the GENERIC ANALYSIS role.
 *
 * ## The incident this exists for
 *
 * On 2026-09-28 at 07:26:49Z the vision-analysis LEAF runtime exited mid-job.
 * Its `tsx watch` wrapper did not: tsx restarts a child on a FILE CHANGE, not
 * on a crash, so it sat idle for fifty minutes with no child at all. Nothing
 * noticed. That one process hosts both the `vision-analysis` and
 * `extreme-rr-plan` queue consumers AND four schedulers -- cleanup, execution
 * notification, retention, and the alert-queue recovery sweep -- so all of it
 * stopped together: 40 jobs queued behind one permanently-ACTIVE job, 35 alerts
 * stranded, and no plan reached any account.
 *
 * The launcher already supervised both account execution workers. It did not
 * supervise this role, and the operator health signal it does publish could not
 * have helped: generic roles attest nothing.
 *
 * ## Why this is not a second supervisor
 *
 * The decision ladder, the restart budget, the backoff and the stabilization
 * window are `worker-supervision.ts`, called here unchanged. This module
 * supplies the two things that ladder takes as INPUTS and cannot derive for a
 * generic role -- a health verdict and a sibling-health verdict -- and
 * translates the outcome into role-accurate operator text. No branch, bound or
 * ordering is redefined.
 *
 * Everything here is a function of its inputs. Nothing is probed, started,
 * terminated, read from a database or written to Redis.
 */

export const GENERIC_ANALYSIS_ROLE = "generic-analysis" satisfies DualRole;
export const GENERIC_BACKEND_ROLE = "generic-backend" satisfies DualRole;

/**
 * How many LEAF runtimes of a role's entrypoint are running.
 *
 * `classifyEntrypoint` already refuses both wrapper kinds -- `pnpm` and the
 * tsx watcher carry the entrypoint on their own command lines and would
 * otherwise report three of everything -- so this count is leaf runtimes and
 * nothing else. That pre-existing exclusion is the whole reason a wrapper-only
 * tree is expressible here at all, and the regression suite pins it.
 */
export function leafRuntimeCount(status: TopologyStatus, role: DualRole): number {
  return status.entrypointCounts[ROLE_CONTRACTS[role].entrypoint] ?? 0;
}

export interface GenericAnalysisHealthInput {
  readonly status: TopologyStatus;
  /**
   * Whether the launcher's RECORDED root for this role is still provably ours.
   *
   * Deliberately separate from the leaf count. `RoleStatus.presence` answers
   * OWNED from the ownership set alone, so during the incident it read OWNED
   * with zero leaves -- structurally unable to express the fault. Health has to
   * ask both questions.
   */
  readonly ownedRootAlive: boolean;
}

/**
 * The health of the generic analysis role.
 *
 * A generic role publishes no attestation, so the evidence is the process
 * census plus the launcher's own ownership record:
 *
 *   2+ leaves          DUPLICATE  -- two consumers competing; never act.
 *   1 leaf             HEALTHY    -- whoever owns it, the work is being done.
 *   0 leaves, root ours STALE     -- THE INCIDENT. Our tree is there and the
 *                                   runtime inside it is not. Same meaning
 *                                   STALE already carries for an account
 *                                   worker: provably ours, provably not
 *                                   working, and therefore replaceable.
 *   0 leaves, no root  OFF        -- the whole tree is gone; nothing to stop.
 *
 * The leaf count is owner-blind on purpose. An externally started leaf still
 * makes this HEALTHY, which is what stops supervision adding a second consumer
 * to a queue somebody else is already draining.
 */
export function genericAnalysisHealth(input: GenericAnalysisHealthInput): RoleHealth {
  const leaves = leafRuntimeCount(input.status, GENERIC_ANALYSIS_ROLE);
  if (leaves > 1) return "DUPLICATE";
  if (leaves === 1) return "HEALTHY";
  return input.ownedRootAlive ? "STALE" : "OFF";
}

/**
 * The sibling whose health decides whether this is an analysis-only fault.
 *
 * The ladder refuses to repair half a runtime. For the generic half that
 * sibling is the generic backend, judged the same owner-blind way: it holds
 * port 4000 and attests nothing either.
 */
export function genericBackendHealth(status: TopologyStatus): RoleHealth {
  const leaves = leafRuntimeCount(status, GENERIC_BACKEND_ROLE);
  if (leaves > 1) return "DUPLICATE";
  return leaves === 1 ? "HEALTHY" : "OFF";
}

export interface GenericAnalysisSupervisionInput {
  /** The launcher's recorded root for the role, or null when none is recorded. */
  readonly record: { readonly pid: number; readonly startedAtMs: number } | null;
  /** Ownership verdict for that record; null when there is no record. */
  readonly ownership: OwnershipVerdict | null;
  readonly status: TopologyStatus;
  readonly budget: RestartBudget;
  readonly nowMs: number;
  /** True when the launcher has a runtime state file at all. */
  readonly hasRuntimeState: boolean;
}

/**
 * Role-accurate operator text.
 *
 * The ladder's own messages describe an ACCOUNT worker and say "attesting",
 * which is false for a role that publishes no attestation. Only the sentence
 * is replaced: `action`, `state`, `reasonCode` and `terminatePid` come back
 * exactly as the reviewed ladder decided them.
 */
function messageFor(reasonCode: SupervisionReasonCode, leaves: number): string {
  switch (reasonCode) {
    case "HEALTHY":
      return "The generic analysis runtime is running.";
    case "NO_RUNTIME_RECORDED":
      return "No launcher-owned runtime is recorded, so there is no generic analysis role to supervise.";
    case "NO_WORKER_RECORDED":
      return (
        "The recorded runtime has no generic analysis process, so supervision owns nothing here. " +
        (leaves > 0
          ? "A generic analysis runtime IS running, but this launcher did not start it: it will not be stopped, adopted or duplicated."
          : "Nothing was started.")
      );
    case "WORKER_DUPLICATE":
      return `${leaves} generic analysis runtimes are running. Supervision will not add or remove one; resolve the duplicate first.`;
    case "HEALTH_UNKNOWN":
      return "Generic analysis health could not be read. Nothing was restarted.";
    case "OWNERSHIP_UNPROVEN":
      return "The recorded generic analysis PID could not be proven to be ours. Nothing was terminated and nothing was started.";
    case "BACKEND_NOT_HEALTHY":
      return "The generic backend is not running, so this is not an analysis-only failure. Supervision will not repair half a runtime; use the launcher's Stop and Start controls.";
    case "STABILIZING":
      return "A generic analysis runtime was started moments ago and is still coming up; its health is not judged yet.";
    case "BACKOFF_PENDING":
      return "The generic analysis runtime did not come back within its stabilization window; waiting out the restart backoff before trying again.";
    case "RESTART_BUDGET_EXHAUSTED":
      return `The generic analysis runtime failed to come back across ${WORKER_RESTART_MAX_ATTEMPTS} restart attempts. Automatic recovery has stopped; operator intervention is required.`;
    case "WORKER_EXITED":
      return "The generic analysis process tree is gone. Starting exactly one replacement from the generic environment file.";
    case "WORKER_STALE":
      return (
        "The generic analysis tree is ours but has no runtime inside it -- the wrapper survived and its child did not. " +
        "Stopping the owned tree first, then starting exactly one replacement from the generic environment file."
      );
    case "INCONSISTENT_OBSERVATION":
      return "Generic analysis ownership and health disagree. Nothing was changed.";
    // The account-worker leaf-accounting branch. This role supplies no leaf
    // evidence, so the ladder never enters it and these are unreachable here --
    // but the switch stays exhaustive so a future reason code cannot be added
    // without this file being made to answer for it.
    case "OWNED_ROOT_WITHOUT_RUNTIME":
    case "WORKER_RUNTIME_UNHEALTHY":
    case "STARTUP_GRACE":
    case "LEAF_CENSUS_UNKNOWN":
    case "LEAF_UNEXPLAINED":
      return "Generic analysis supervision does not use account leaf accounting. Nothing was changed.";
  }
}

/**
 * What, if anything, to do about the generic analysis role.
 *
 * Every safety property is the ladder's, unchanged:
 *
 *   - no state file, or no record        -> NONE (nothing is owned)
 *   - a leaf is running                  -> NONE (including somebody else's)
 *   - two leaves                         -> NONE (never choose between them)
 *   - PID reused / other repo            -> NONE (ownership unproven)
 *   - generic backend down               -> NONE (not an analysis-only fault)
 *   - inside stabilization or backoff    -> NONE
 *   - budget exhausted                   -> NONE, and says so
 *   - tree gone                          -> RESTART
 *   - tree ours, no runtime inside it    -> TERMINATE_THEN_RESTART
 */
export function decideGenericAnalysisSupervision(
  input: GenericAnalysisSupervisionInput
): SupervisionDecision {
  const ownedRootAlive = input.ownership?.owned === true;
  const leaves = leafRuntimeCount(input.status, GENERIC_ANALYSIS_ROLE);
  const decision = decideWorkerSupervision({
    // The ladder's record type names the legacy single-stack role. Only `pid`
    // is read from it, and the role this pass is about is fixed by the caller,
    // so this can never act on another role's process.
    record:
      input.record === null
        ? null
        : { role: "worker", pid: input.record.pid, startedAtMs: input.record.startedAtMs },
    ownership: input.ownership,
    workerHealth: genericAnalysisHealth({ status: input.status, ownedRootAlive }),
    backendHealth: genericBackendHealth(input.status),
    budget: input.budget,
    nowMs: input.nowMs,
    hasRuntimeState: input.hasRuntimeState,
  });
  return { ...decision, message: messageFor(decision.reasonCode, leaves) };
}

/** The supervision lines for the launcher screen. Counts and states only. */
export function renderGenericAnalysisSupervision(
  decision: SupervisionDecision,
  budget: RestartBudget
): string[] {
  const attempts =
    budget.attempts === 0 ? "" : `  (restart attempts ${budget.attempts}/${WORKER_RESTART_MAX_ATTEMPTS})`;
  return [
    `${ROLE_CONTRACTS[GENERIC_ANALYSIS_ROLE].label} supervision: ${decision.state}${attempts}`,
    `  ${decision.message}`,
  ];
}
