import type { PrismaClient, TradeExecution } from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import type { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import type { EntryLifecycleService } from "./entry-lifecycle.service";
import type { ProtectionLifecycleService } from "./protection-lifecycle.service";
import type { SafetyAdmissionService } from "./safety-admission.service";
// The SAME open-position classification and min-merge admission uses, so the
// soft-target decision here cannot drift from the one the safety engine makes.
import { OPEN_POSITION_STATUSES } from "./capacity-status";
import { mergeCapacityLimits } from "./safety-engine";
import {
  configuredProfileIdentity,
  resolveExecutionProfile,
  type ProfileIdentity,
  type ProfileResolutionFailure,
} from "./execution-profile.service";

/**
 * Phase 11A.1 — the production execution orchestrator.
 *
 * COORDINATION ONLY. Every decision this module appears to make is actually
 * made by an existing Phase 3–7 service; the orchestrator's whole job is to
 * pick the right already-implemented call for a persisted state and to invoke
 * it. It deliberately contains:
 *
 *  - no risk mathematics, quantity calculation or leverage selection;
 *  - no safety-policy logic;
 *  - no Binance request construction;
 *  - no protection mathematics;
 *  - no lifecycle state-transition rules;
 *  - no Telegram formatting or sending.
 *
 * Persisted TradeExecution state is the source of truth. The orchestrator holds
 * no in-memory execution state between calls, which is what makes a restart
 * indistinguishable from an ordinary tick.
 *
 * ## Why this is safe with the gates closed
 *
 * It never checks a gate itself and never bypasses one. Every mutation travels
 * through the Phase 6/7 services, which refuse to dispatch while their gates are
 * closed — so with EXECUTION_LIVE_ENTRY_ENABLED=false this whole module
 * produces exactly zero exposure-increasing requests, without needing a special
 * case anywhere.
 */

/** Statuses a reconciliation tick may act on. Terminal states are excluded. */
export const RECONCILABLE_STATUSES = [
  // A crash between creation and admission leaves PLAN_READY persisted with
  // nobody to admit it. Discovering it here is what makes the original BullMQ
  // delivery unnecessary for the execution to survive.
  "PLAN_READY",
  // Admitted but not yet reserved. Its recovery already existed
  // (`resumeEntrySubmission` handles PREFLIGHT) but nothing ever discovered it,
  // so an execution admitted just before the window closed held a pending-entry
  // and a total-active slot indefinitely.
  "PREFLIGHT",
  "ENTRY_SUBMITTING",
  "ENTRY_PENDING",
  "PARTIALLY_FILLED",
  "ENTRY_FILLED",
  "PLACING_PROTECTION",
  "PROTECTED",
  "MANUAL_INTERVENTION",
] as const;

/** Statuses that mean unresolved exposure may exist and must be resolved first. */
export const RECOVERY_REQUIRED_STATUSES = [
  "ENTRY_SUBMITTING",
  "PARTIALLY_FILLED",
  "ENTRY_FILLED",
  "PLACING_PROTECTION",
  "MANUAL_INTERVENTION",
] as const;

export interface OrchestratorDependencies {
  prisma: PrismaClient;
  readOnly: BinanceReadOnlyService;
  admission: SafetyAdmissionService;
  entry: EntryLifecycleService;
  protection: ProtectionLifecycleService;
  /** Defaults to the configured identity; injected in tests. */
  profileIdentity?: ProfileIdentity;
}

export interface AdmitSignalInput {
  /** A PLAN_READY execution created from an eligible, selected plan. */
  executionId: string;
  evaluatedAt?: Date;
}

export type AdmitOutcome =
  | { admitted: true; decision: string; reasonCode: string | null; mutationsDispatched: number }
  | { admitted: false; decision: string | null; reasonCode: string | ProfileResolutionFailure; message: string };

export interface ReconcileTickResult {
  inspected: number;
  advanced: number;
  mutationsDispatched: number;
  recoveryPending: number;
  failed: boolean;
}

export class ExecutionOrchestrator {
  constructor(private readonly deps: OrchestratorDependencies) {}

  // -------------------------------------------------------------------------
  // A. New-signal admission
  // -------------------------------------------------------------------------

  /**
   * Runs one PLAN_READY execution through safety admission and, on PASS,
   * straight into the entry lifecycle.
   *
   * There is deliberately NO bypass parameter. Admission is
   * `evaluateAndReserveSafetyAdmission`, which is idempotent per evaluated
   * version, so a duplicate BullMQ delivery replays the stored decision instead
   * of producing a second one.
   *
   * New work is refused while unresolved recovery exists: capacity looking free
   * locally is not the same as the exchange being flat.
   */
  async admitAndSubmit(input: AdmitSignalInput): Promise<AdmitOutcome> {
    const evaluatedAt = input.evaluatedAt ?? new Date();

    const profile = await resolveExecutionProfile(
      this.deps.prisma,
      this.deps.profileIdentity ?? configuredProfileIdentity()
    );
    if (!profile.ok) {
      return { admitted: false, decision: null, reasonCode: profile.reasonCode, message: profile.message };
    }

    const recoveryPending = await this.countRecoveryRequired();
    if (recoveryPending > 0) {
      return {
        admitted: false,
        decision: null,
        reasonCode: "RECOVERY_REQUIRED",
        message: `${recoveryPending} execution(s) still need reconciliation; no new work is admitted until they resolve.`,
      };
    }

    const execution = await this.deps.prisma.tradeExecution.findUnique({ where: { id: input.executionId } });
    if (!execution) {
      return { admitted: false, decision: null, reasonCode: "EXECUTION_NOT_FOUND", message: "Unknown execution." };
    }
    if (execution.executionProfileId !== profile.profile.id) {
      // Never trade an execution that belongs to a different profile than the
      // configured one — its capacity and limits are not the ones we checked.
      return {
        admitted: false,
        decision: null,
        reasonCode: "PROFILE_MISMATCH",
        message: "The execution belongs to a different execution profile than the configured one.",
      };
    }
    if (execution.status !== "PLAN_READY") {
      // Already admitted (or terminal). Replay is a no-op, never a second
      // admission.
      return {
        admitted: false,
        decision: null,
        reasonCode: "NOT_PLAN_READY",
        message: `Execution is ${execution.status}; only PLAN_READY enters admission.`,
      };
    }

    const outcome = await this.deps.admission.evaluateAndReserveSafetyAdmission({
      executionId: execution.id,
      // The version we actually read: a concurrent writer invalidates this and
      // Phase 5's optimistic check refuses, rather than admitting on stale state.
      expectedVersion: execution.version,
      evaluatedAt,
    });

    if (outcome.decision !== "PASS") {
      // SKIP is terminal, UNAVAILABLE and RETRY_CONFLICT stay retryable — all
      // decided by Phase 5, not here.
      return {
        admitted: false,
        decision: outcome.decision,
        reasonCode: outcome.reasonCode ?? "SAFETY_DECISION",
        message: `Safety admission returned ${outcome.decision}.`,
      };
    }

    const entry = await this.deps.entry.prepareEntrySubmission({
      executionId: execution.id,
      expectedVersion: outcome.execution.version,
      evaluatedAt,
    });

    return {
      admitted: true,
      decision: outcome.decision,
      reasonCode: entry.reasonCode,
      mutationsDispatched: entry.mutationsDispatched,
    };
  }

  // -------------------------------------------------------------------------
  // B. Bounded reconciliation
  // -------------------------------------------------------------------------

  /**
   * One bounded pass over non-terminal executions.
   *
   * No loop, no recursion: the scheduler decides when the next pass happens.
   * Each execution is routed to the existing service call appropriate to its
   * persisted status, and every one of those calls is independently idempotent
   * and concurrency-guarded (advisory locks + optimistic version checks), which
   * is what makes a duplicate tick or a second worker harmless.
   *
   * Never throws: reconciliation is background work and must not take down the
   * worker that also runs the alert pipeline.
   */
  async runExecutionReconciliationTick(
    options: { batchSize?: number; evaluatedAt?: Date } = {}
  ): Promise<ReconcileTickResult> {
    const batchSize = options.batchSize ?? env.EXECUTION_RECONCILE_BATCH_SIZE;
    const evaluatedAt = options.evaluatedAt ?? new Date();
    const result: ReconcileTickResult = {
      inspected: 0,
      advanced: 0,
      mutationsDispatched: 0,
      recoveryPending: 0,
      failed: false,
    };

    try {
      const executions = await this.deps.prisma.tradeExecution.findMany({
        where: { status: { in: [...RECONCILABLE_STATUSES] } },
        // Oldest first, stable by id: a backlog drains in a deterministic
        // order and no execution can be starved by a newer one.
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: batchSize,
      });

      // Which profiles have already reached their SOFT open-position target.
      // Derived from persisted state every tick — no in-memory counter — so it
      // is identical after a restart and idempotent when a tick repeats.
      const softTargetReached = await this.profilesAtSoftOpenTarget(
        [...new Set(executions.map((execution) => execution.executionProfileId))]
      );

      for (const execution of executions) {
        result.inspected += 1;
        const dispatched = await this.reconcileOne(
          execution,
          evaluatedAt,
          softTargetReached.has(execution.executionProfileId)
        );
        result.mutationsDispatched += dispatched;
        if (dispatched > 0) result.advanced += 1;
      }

      result.recoveryPending = await this.countRecoveryRequired();
    } catch (error) {
      result.failed = true;
      logger.error(
        { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
        "Execution reconciliation tick failed — persisted state is unchanged and the next tick retries"
      );
    }

    return result;
  }

  /**
   * Routes ONE execution to the existing lifecycle call for its state.
   *
   * The mapping is the whole of the orchestrator's decision-making, and it is
   * intentionally a lookup rather than logic: what "reconcile" means for each
   * state was decided in Phase 6/7 and is not re-litigated here.
   */
  /**
   * The profiles whose AUTHORITATIVE open-position count has reached their
   * effective soft target.
   *
   * Counted from the same `OPEN_POSITION_STATUSES` set admission uses, over the
   * whole profile rather than the current batch, and merged through the same
   * `mergeCapacityLimits` admission applies — so the orchestrator and the
   * safety engine can never disagree about whether the target is reached.
   */
  private async profilesAtSoftOpenTarget(profileIds: string[]): Promise<Set<string>> {
    const reached = new Set<string>();
    for (const profileId of profileIds) {
      // Failing to PROVE the target is reached must never stop the tick. This
      // probe only ever adds a cancellation; reconciliation, fill handling and
      // protection must proceed regardless, so an unreadable policy or count
      // degrades to "cancel nothing" instead of taking the whole pass down.
      try {
        reached.add(await this.softTargetProbe(profileId));
      } catch (error) {
        logger.warn(
          { profileId, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" },
          "Soft open-target check failed; no entry cancellation is initiated this tick"
        );
      }
    }
    reached.delete("");
    return reached;
  }

  /** Returns the profile id when its soft target is reached, else "". */
  private async softTargetProbe(profileId: string): Promise<string> {
    const policyRow = await this.deps.prisma.executionSafetyPolicy.findUnique({
        where: { executionProfileId: profileId },
      });
    // No row means the profile fails closed at admission anyway; there is no
    // authoritative target to compare against, so nothing is cancelled here.
    if (!policyRow) return "";

    const openCount = await this.deps.prisma.tradeExecution.count({
        where: {
          executionProfileId: profileId,
          status: { in: OPEN_POSITION_STATUSES as unknown as TradeExecution["status"][] },
        },
      });

      const effective = mergeCapacityLimits(
        {
          maxOpenPositions: env.EXECUTION_MAX_OPEN_POSITIONS,
          maxPendingEntries: env.EXECUTION_MAX_PENDING_ENTRIES,
          maxTotalActiveTrades: env.EXECUTION_MAX_TOTAL_ACTIVE_TRADES,
          maxActivePerSymbolSide: env.EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE,
          maxAlertAgeSeconds: env.EXECUTION_MAX_ALERT_AGE_SECONDS,
          softOpenPositionTarget: env.EXECUTION_SOFT_OPEN_POSITION_TARGET,
          maxTotalPlannedRiskUsd: env.EXECUTION_MAX_TOTAL_PLANNED_RISK_USD,
          maxTotalIsolatedMarginUsd: env.EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD,
        },
        {
          maxOpenPositions: policyRow.maxOpenPositions,
          maxPendingEntries: policyRow.maxPendingEntries,
          maxTotalActiveTrades: policyRow.maxTotalActiveTrades,
          maxActivePerSymbolSide: policyRow.maxActivePerSymbolSide,
          maxAlertAgeSeconds: policyRow.maxAlertAgeSeconds,
          softOpenPositionTarget: policyRow.softOpenPositionTarget,
          maxTotalPlannedRiskUsd: policyRow.maxTotalPlannedRiskUsd.toString(),
          maxTotalIsolatedMarginUsd: policyRow.maxTotalIsolatedMarginUsd.toString(),
        }
      );

    return openCount >= effective.softOpenPositionTarget ? profileId : "";
  }

  private async reconcileOne(
    execution: TradeExecution,
    evaluatedAt: Date,
    softOpenTargetReached = false
  ): Promise<number> {
    const input = { executionId: execution.id, expectedVersion: execution.version, evaluatedAt };

    try {
      switch (execution.status) {
        // Re-run admission. It is idempotent per evaluated version, so a
        // replay returns the stored decision rather than a second one.
        case "PLAN_READY": {
          const outcome = await this.admitAndSubmit({ executionId: execution.id, evaluatedAt });
          return outcome.admitted ? outcome.mutationsDispatched : 0;
        }

        // Admitted, nothing reserved. `resumeEntrySubmission` routes PREFLIGHT
        // to the ordinary `prepareEntrySubmission` path, which re-checks every
        // gate, kill switch and exchange precondition itself — so with the
        // window shut this dispatches nothing.
        //
        // The second call then asks the lifecycle service whether the execution
        // can still run at all — a closed window or a deadline that has already
        // passed both leave it holding capacity forever otherwise. It is called
        // unconditionally rather than on a failure flag: if the resume succeeded
        // the status is no longer PREFLIGHT and it returns immediately, and what
        // "unrunnable" and "safe to release" mean stays in Phase 6 rather than
        // leaking into the orchestrator.
        case "PREFLIGHT": {
          const resumed = await this.deps.entry.resumeEntrySubmission(input);
          const released = await this.deps.entry.releaseUnrunnablePreflight(input);
          return resumed.mutationsDispatched + released.mutationsDispatched;
        }

        // An ambiguous submission: resume queries the SAME deterministic client
        // order id rather than submitting anything new.
        case "ENTRY_SUBMITTING":
          return (await this.deps.entry.resumeEntrySubmission(input)).mutationsDispatched;

        // A resting order: reconcile its exchange state, then let Phase 6 decide
        // whether the TTL is due. Expiry never bypasses the fill check.
        case "ENTRY_PENDING": {
          const reconciled = await this.deps.entry.reconcileEntryOrder(input);
          // A resting order is the ONE state that is unambiguously cancellable:
          // the order is known to exist and no fill is recorded. When the soft
          // target is reached we withdraw it; otherwise the TTL decides.
          // `expireEntryOrderIfDue` re-queries first either way, so a fill that
          // landed since `reconcileEntryOrder` still wins.
          const expired = await this.deps.entry.expireEntryOrderIfDue({
            ...input,
            expectedVersion: reconciled.execution.version,
            ...(softOpenTargetReached ? { recoveryReason: "SOFT_OPEN_TARGET" as const } : {}),
          });
          return reconciled.mutationsDispatched + expired.mutationsDispatched;
        }

        // Exposure exists. Reconcile the entry first so the protected quantity
        // is measured against the latest confirmed fill, then protect it.
        case "PARTIALLY_FILLED": {
          const reconciled = await this.deps.entry.reconcileEntryOrder(input);
          // PROTECT FIRST, then withdraw the remainder. The filled quantity is
          // real exposure and its protection must never wait on a cancellation
          // that can fail, time out or come back UNKNOWN. Only after protection
          // has been attempted is the unfilled remainder cancelled — and the
          // SOFT_OPEN_TARGET cause is what keeps that from being mistaken for
          // an unprotected partial fill.
          const protection = await this.deps.protection.ensureProtectionForExposure({
            ...input,
            expectedVersion: reconciled.execution.version,
          });
          if (!softOpenTargetReached) {
            return reconciled.mutationsDispatched + protection.mutationsDispatched;
          }
          const withdrawn = await this.deps.entry.expireEntryOrderIfDue({
            ...input,
            expectedVersion: protection.execution.version,
            recoveryReason: "SOFT_OPEN_TARGET",
          });
          return reconciled.mutationsDispatched + protection.mutationsDispatched + withdrawn.mutationsDispatched;
        }

        case "ENTRY_FILLED":
          return (await this.deps.protection.ensureProtectionForExposure(input)).mutationsDispatched;

        // A half-finished protection tranche: resume, never re-reserve.
        case "PLACING_PROTECTION":
          return (await this.deps.protection.resumeProtectionLifecycle(input)).mutationsDispatched;

        // Verified protection: watch for closure AND for coverage drift.
        //
        // Both halves are required, and the ORDER is load-bearing.
        //
        // `reconcileProtectionAndClosure` owns the flat case and must run
        // first: on a real exchange a closed position makes positionRisk omit
        // the row entirely, and only this function reads a missing row as
        // "flat". `ensureProtectionForExposure` escalates it as
        // POSITION_NOT_FOUND_AFTER_FILL, so leading with the health path would
        // turn every normal close into a spurious MANUAL_INTERVENTION — from
        // which CLOSED_TP and CLOSED_SL are not even legal transitions.
        //
        // But closure reconciliation returns early while exposure remains and
        // performs NO coverage measurement, liquidation check, margin top-up or
        // repair. Without the second half a PROTECTED execution would never
        // notice a stop that was cancelled out from under it. So when the
        // position is still open — proven by the execution still being
        // PROTECTED afterwards — the full health path runs too.
        case "PROTECTED": {
          const closure = await this.deps.protection.reconcileProtectionAndClosure(input);
          // Terminalized, escalated, or otherwise moved on: closure owns it.
          if (closure.execution.status !== "PROTECTED") return closure.mutationsDispatched;

          const health = await this.deps.protection.ensureProtectionForExposure({
            ...input,
            expectedVersion: closure.execution.version,
          });
          return closure.mutationsDispatched + health.mutationsDispatched;
        }

        // Parked for a human. Nothing is ever auto-unwound here — but a parked
        // execution with LIVE exposure must not be abandoned either.
        //
        // The ordering mirrors PROTECTED and is load-bearing for the same
        // reason: closure runs FIRST, because a flat position appears on a real
        // exchange as a MISSING position row, and only closure reads that as
        // flat. Recovery would have to interpret the same absence as "no
        // exposure data" — so it never sees it. If closure terminalizes or
        // otherwise moves the execution on, recovery is skipped entirely.
        //
        // Recovery itself is an allowlist: it un-parks only an execution the
        // PROTECTION lifecycle parked, for one of four re-decidable STOP
        // reasons, with fresh exchange proof. Every other parked reason falls
        // straight through and stays exactly where it is.
        case "MANUAL_INTERVENTION": {
          const closure = await this.deps.protection.reconcileProtectionAndClosure(input);
          if (closure.execution.status !== "MANUAL_INTERVENTION") return closure.mutationsDispatched;

          const recovery = await this.deps.protection.attemptProtectionRecovery({
            ...input,
            expectedVersion: closure.execution.version,
          });
          return closure.mutationsDispatched + recovery.mutationsDispatched;
        }

        default:
          return 0;
      }
    } catch (error) {
      // One bad execution must not abort the whole batch.
      logger.warn(
        {
          executionId: execution.id,
          status: execution.status,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        },
        "Execution reconciliation failed for one execution — continuing with the rest"
      );
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // C. Startup recovery
  // -------------------------------------------------------------------------

  /**
   * Reconciles everything persisted as non-terminal at process start.
   *
   * This is deliberately the SAME code path as an ordinary tick, just run
   * eagerly and with a larger budget: a restart is not a special mode, and
   * having one recovery path rather than two removes the possibility of them
   * disagreeing. Bounded and repeatable — running it twice reconciles the same
   * rows and dispatches nothing extra, because each underlying service is
   * idempotent.
   */
  async runStartupRecovery(options: { batchSize?: number } = {}): Promise<ReconcileTickResult> {
    const pending = await this.countRecoveryRequired();
    logger.info({ recoveryRequired: pending }, "Execution startup recovery beginning");

    const result = await this.runExecutionReconciliationTick({
      batchSize: options.batchSize ?? Math.max(env.EXECUTION_RECONCILE_BATCH_SIZE, 25),
    });

    logger.info(
      { inspected: result.inspected, recoveryPending: result.recoveryPending },
      result.recoveryPending > 0
        ? "Execution startup recovery incomplete — new work stays blocked until it resolves"
        : "Execution startup recovery complete"
    );
    return result;
  }

  /** Executions whose exposure is not yet provably resolved. */
  async countRecoveryRequired(): Promise<number> {
    return this.deps.prisma.tradeExecution.count({
      where: {
        OR: [
          { status: { in: [...RECOVERY_REQUIRED_STATUSES] } },
          { requiresManualIntervention: true },
        ],
      },
    });
  }
}
