import type { PrismaClient, TradeExecution } from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import type { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import type { EntryLifecycleService } from "./entry-lifecycle.service";
import type { ExecutionService } from "./execution.service";
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

/**
 * Protection refusals that leave a FILLED execution completely unresolved.
 *
 * Both write nothing, escalate nothing and dispatch nothing, so an execution
 * that keeps hitting one of them never moves and never raises anything. Named
 * here so the ENTRY_FILLED route can turn that silence into the repository's
 * ordinary parked-and-alerted state.
 */
const UNRESOLVED_FILLED_EXPOSURE_REASONS: readonly string[] = [
  "POSITION_STATE_UNAVAILABLE",
  "EXECUTION_HAS_NO_CONFIRMED_FILL",
];

/**
 * The stable code every unexpected reconciliation throw is recorded under.
 *
 * One code rather than a family: the point is to capture an error nobody has
 * classified yet. The sanitized message carries what actually happened, and a
 * recognised failure that deserves its own code should be handled where it
 * arises rather than here.
 */
export const RECONCILIATION_FAILURE_REASON_CODE = "RECONCILIATION_FAILED";

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
  /** Owns durable execution rows and events; used here only for diagnostics. */
  executions: ExecutionService;
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
  /**
   * Executions for which at least one exchange mutation was DISPATCHED.
   *
   * Deliberately not a progress metric, and it was read as one: a stuck
   * ENTRY_SUBMITTING re-sending the same submission logged `advanced: 1`
   * every 30s for 75 ticks while nothing changed. Use `progressed` for
   * "did persisted lifecycle state actually move?".
   */
  advanced: number;
  /** Executions whose persisted status/version actually changed this tick. */
  progressed: number;
  mutationsDispatched: number;
  recoveryPending: number;
  /**
   * How many rows match RECONCILABLE_STATUSES table-wide, at the end of the
   * tick. Telemetry only — nothing branches on it.
   *
   * `inspected` is one bounded window of this pool; this is the pool. Reading
   * `inspected: 10` every tick cannot distinguish a cursor most of the way
   * through a short queue from one a fraction of the way through a long one,
   * and those imply opposite conclusions about an execution that has not
   * changed: not reached yet, versus reached and did nothing.
   *
   * Null means the supplemental count itself failed, never zero.
   */
  reconcilableTotal: number | null;
  /**
   * Whether the fairness cursor still held continuation state when the tick
   * ended: true mid-cycle, false back at the oldest row.
   *
   * A boolean deliberately. Which row the cursor sits on is of no operational
   * interest, and execution identifiers do not belong in runtime telemetry.
   */
  cursorActive: boolean;
  failed: boolean;
}

/** Where the last reconciliation window stopped, in the selector's ordering. */
interface ReconciliationCursor {
  updatedAt: Date;
  id: string;
}

export class ExecutionOrchestrator {
  /**
   * Round-robin position, held for the life of this orchestrator.
   *
   * The scheduler builds ONE orchestrator and reuses it for startup recovery
   * and every periodic tick, which is what lets successive windows advance.
   */
  private reconcileCursor: ReconciliationCursor | null = null;

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
      progressed: 0,
      mutationsDispatched: 0,
      recoveryPending: 0,
      reconcilableTotal: null,
      cursorActive: false,
      failed: false,
    };
    const versionsBefore = new Map<string, number>();

    try {
      const executions = await this.selectReconciliationBatch(batchSize);

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
        versionsBefore.set(execution.id, execution.version);
      }

      // Persisted movement, measured rather than inferred. ONE query for the
      // whole batch, AFTER the loop and in its own try: an observability
      // metric must never be able to abort the reconciliation it reports on,
      // which is exactly what a per-execution read inside the loop did.
      try {
        if (versionsBefore.size > 0) {
          const after = await this.deps.prisma.tradeExecution.findMany({
            where: { id: { in: [...versionsBefore.keys()] } },
            select: { id: true, version: true },
          });
          // Every lifecycle transition increments the version inside its own
          // transaction, so a version that did not move means nothing moved.
          for (const row of after) {
            if (row.version !== versionsBefore.get(row.id)) result.progressed += 1;
          }
        }
      } catch {
        // Leaves progressed at 0 rather than failing the tick.
      }

      // Where the next tick resumes. Set AFTER the batch is processed so a
      // tick that throws mid-batch leaves the cursor alone and retries the
      // same window rather than skipping past unserviced rows.
      this.advanceReconciliationCursor(executions, batchSize);
      result.cursorActive = this.reconcileCursor !== null;

      // The size of the pool the cursor is rotating through, in its OWN try
      // for the same reason `progressed` above has one: an observability
      // metric must never be able to abort the reconciliation it reports on.
      // A failure leaves the field null, which reads as unknown, not as zero.
      try {
        result.reconcilableTotal = await this.countReconcilable();
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
          "Reconciliation backlog count failed — telemetry only, the tick itself is unaffected"
        );
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

  /**
   * One bounded window of reconcilable work, resuming where the last tick
   * stopped.
   *
   * ## Why a cursor at all
   *
   * The batch is the `batchSize` oldest rows by `updatedAt`, and a row that is
   * inspected but needs no durable write keeps its `updatedAt`. A full batch of
   * such rows therefore sorts identically on the next tick, and the next, for
   * as long as they stay that way — so row `batchSize + 1` is never reached.
   * Not delayed: never reached. That is what a live MAINNET filled position sat
   * behind, while every tick honestly reported `inspected 10, progressed 0` and
   * `recoveryPending 1` for work the batch could not see.
   *
   * The ordering comment this replaced said "no execution can be starved by a
   * newer one", which was true and beside the point: the starvation came from
   * OLDER rows that never moved.
   *
   * ## Why a keyset, and why process-local
   *
   * Keyset rather than OFFSET so the window stays bounded and stable under
   * concurrent writes. Process-local rather than persisted because it is a
   * scheduling hint, not a fact about an execution — a restart simply resumes
   * from the oldest row, which delays a cycle at worst and cannot strand
   * anything. Persisting it would mean a schema change to make a fairness
   * heuristic durable, which is the wrong trade.
   *
   * ## Why it cannot skip anything
   *
   * The cursor only ever moves forward through the ordering and resets to the
   * start as soon as a window comes back short — the end of the set. Every
   * eligible row is therefore reached within one full cycle,
   * `ceil(total / batchSize)` ticks, whatever the rows ahead of it do.
   */
  private async selectReconciliationBatch(batchSize: number): Promise<TradeExecution[]> {
    const query = (after: ReconciliationCursor | null) =>
      this.deps.prisma.tradeExecution.findMany({
        where: {
          status: { in: [...RECONCILABLE_STATUSES] },
          ...(after
            ? {
                OR: [
                  { updatedAt: { gt: after.updatedAt } },
                  { updatedAt: after.updatedAt, id: { gt: after.id } },
                ],
              }
            : {}),
        },
        // Oldest first, stable by id: the same total order the cursor walks.
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: batchSize,
      });

    const batch = await query(this.reconcileCursor);
    if (batch.length > 0 || this.reconcileCursor === null) return batch;

    // The cursor ran off the end. Wrap once, in the SAME tick, so reaching the
    // tail never costs an idle pass. Bounded: at most two queries, each of at
    // most `batchSize` rows.
    this.reconcileCursor = null;
    return query(null);
  }

  /** Park the cursor on the last row served, or rewind when the set ends. */
  private advanceReconciliationCursor(batch: TradeExecution[], batchSize: number): void {
    const last = batch[batch.length - 1];
    // A short window means the end of the ordering was reached, so the next
    // tick starts over. A full one continues after the row just served.
    this.reconcileCursor =
      last && batch.length >= batchSize ? { updatedAt: last.updatedAt, id: last.id } : null;
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

        // Exposure exists and nothing has been built on it yet. Closure FIRST,
        // then protection — the same order PLACING_PROTECTION, PROTECTED and
        // MANUAL_INTERVENTION already use, and load-bearing for the same
        // reason plus one more that only applies here.
        //
        // The shared reason: on a real exchange a closed position is a MISSING
        // positionRisk row, and closure is the only path that reads absence as
        // flat. `ensureProtectionForExposure` reads the same absence as
        // POSITION_NOT_FOUND_AFTER_FILL and parks the execution at
        // MANUAL_INTERVENTION — so an entry that filled and then closed, by a
        // stop, a target or an operator, took a detour through a human queue
        // before another tick could terminalize it. Closure reaches
        // CLOSED_EXTERNAL (or CLOSED_TP / CLOSED_SL on owned evidence)
        // directly, and every one of those is already a legal transition from
        // ENTRY_FILLED.
        //
        // The reason specific to ENTRY_FILLED: this is the FIRST state in
        // which real exposure exists with no protection row and no protection
        // orders yet. `ensureProtectionForExposure` has two early returns that
        // write nothing at all and escalate nothing —
        // EXECUTION_HAS_NO_CONFIRMED_FILL and POSITION_STATE_UNAVAILABLE — so
        // an execution that hits either one stays ENTRY_FILLED, with no
        // protection row, indefinitely. That is precisely the shape the
        // MAINNET incident left behind: filled, holding an OPEN slot and its
        // risk and margin, with reconciliation reporting attempted 0 forever.
        // Asking closure first gives the row a second, independent chance to
        // resolve on authoritative exchange state.
        //
        // Live exposure is unaffected: closure returns early, writing nothing,
        // while the position is still open, and protection then runs exactly
        // as it does today.
        case "ENTRY_FILLED": {
          const closure = await this.deps.protection.reconcileProtectionAndClosure(input);
          // Terminalized, escalated, or otherwise moved on: closure owns it.
          if (closure.execution.status !== "ENTRY_FILLED") return closure.mutationsDispatched;

          let dispatched = closure.mutationsDispatched;
          let protection = await this.deps.protection.ensureProtectionForExposure({
            ...input,
            expectedVersion: closure.execution.version,
          });
          dispatched += protection.mutationsDispatched;

          // --- Repair a missing confirmed fill, never invent one -----------
          //
          // `ensureProtectionForExposure` refuses outright when
          // `TradeExecution.filledQuantity` is not positive, and that refusal
          // writes nothing and escalates nothing — so an execution that
          // reached ENTRY_FILLED without that field populated would sit inert
          // while its position was live and unprotected.
          //
          // Detected by REASON CODE rather than by inspecting the field here.
          // The orchestrator routes; it does not do arithmetic, and protection
          // is the authority on what counts as a confirmed fill.
          //
          // `reconcileEntryOrder` is the canonical repair and the only one
          // used: it re-queries the entry by its own deterministic
          // clientOrderId and writes the quantity the EXCHANGE reports.
          // Nothing is guessed. If the query cannot answer, the fill stays
          // unset and the park below catches it.
          if (protection.reasonCode === "EXECUTION_HAS_NO_CONFIRMED_FILL") {
            const reconciled = await this.deps.entry.reconcileEntryOrder({
              ...input,
              expectedVersion: closure.execution.version,
            });
            dispatched += reconciled.mutationsDispatched;
            // Reconciling the entry can legitimately move the execution on:
            // a cancelled remainder, a lost fill, or an escalation of its own.
            if (reconciled.execution.status !== "ENTRY_FILLED") return dispatched;

            protection = await this.deps.protection.ensureProtectionForExposure({
              ...input,
              expectedVersion: reconciled.execution.version,
            });
            dispatched += protection.mutationsDispatched;
          }

          // --- Never leave filled exposure inert ---------------------------
          //
          // Two of protection's refusals write nothing and change nothing:
          // POSITION_STATE_UNAVAILABLE (the exchange did not answer) and
          // EXECUTION_HAS_NO_CONFIRMED_FILL (the repair above could not prove
          // the fill). Both leave a possibly-live, definitely-unprotected
          // position with no owner and no alarm — the exact state the MAINNET
          // incident was found in, where every tick reported nothing to do.
          //
          // UNKNOWN is still not FLAT: nothing is terminalized, and nothing is
          // submitted on a position we cannot see. The execution is parked
          // instead — the durable safety state this repository already uses —
          // and because POSITION_STATE_UNAVAILABLE is a recoverable
          // intervention reason, the MANUAL_INTERVENTION route un-parks it by
          // itself once the exchange answers again.
          if (UNRESOLVED_FILLED_EXPOSURE_REASONS.includes(protection.reasonCode)) {
            const parked = await this.deps.protection.parkUnresolvedFilledExposure(
              input,
              protection.reasonCode,
              protection.message
            );
            dispatched += parked.mutationsDispatched;
          }
          return dispatched;
        }

        // A half-finished protection tranche. Closure FIRST, then resume — the
        // same order PROTECTED and MANUAL_INTERVENTION already use, and it is
        // load-bearing for the same reason.
        //
        // This case used to call `resumeProtectionLifecycle` alone, and that is
        // what stranded the executions this fix exists for. An entry that
        // filled and then closed on the exchange — by our own TP or SL, or by
        // anything else — leaves the position flat. Resume routes to
        // `ensureProtectionForExposure`, which reads a MISSING position row as
        // POSITION_NOT_FOUND_AFTER_FILL and parks the execution, and reads a
        // zero-quantity row by handing off to closure. Neither is the right
        // first question for an execution whose position may simply be gone,
        // and the parking path is strictly worse: it turns an ordinary close
        // into a MANUAL_INTERVENTION a human has to clear.
        //
        // Closure asks the right question directly. It owns the flat case, it
        // is the only path that reads a missing position row as flat, and it
        // fails closed on an unreadable one. If the position is still open it
        // returns without terminalizing and the resume below runs exactly as
        // before, so nothing about the live-exposure path changes.
        case "PLACING_PROTECTION": {
          const closure = await this.deps.protection.reconcileProtectionAndClosure(input);
          // Terminalized, escalated, or otherwise moved on: closure owns it.
          if (closure.execution.status !== "PLACING_PROTECTION") return closure.mutationsDispatched;

          const resumed = await this.deps.protection.resumeProtectionLifecycle({
            ...input,
            expectedVersion: closure.execution.version,
          });
          return closure.mutationsDispatched + resumed.mutationsDispatched;
        }

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
      const detail = error instanceof Error ? error.message.slice(0, 200) : "unknown";
      logger.warn(
        { executionId: execution.id, status: execution.status, error: detail },
        "Execution reconciliation failed for one execution — continuing with the rest"
      );

      // The log line above is the ONLY record this used to leave, and the
      // launcher spawns the worker with `stdio: "ignore"` — so on a real
      // runtime it goes to NUL and the error is gone. An execution can
      // therefore fail to reconcile on every tick for hours while looking, to
      // an operator, exactly like an execution nothing has tried to touch.
      //
      // That is what happened: a filled MAINNET position sat unprotected with
      // a timeline whose last entry predated the failures entirely.
      //
      // Recording it durably costs one row and makes the next occurrence
      // diagnosable from the execution's own timeline.
      // Delegated, never written here. The orchestrator routes and counts;
      // every durable write in this system belongs to a service, and a
      // structural test keeps that boundary honest.
      // Guarded at the CALL SITE as well as inside the recorder.
      //
      // The recorder catches its own persistence failures, but that only
      // helps once it has been entered — a missing or malformed dependency
      // throws on the property access itself, inside this catch, and would
      // escape `reconcileOne` and abort the rest of the batch. Diagnostics
      // must never be able to do that, so the delegation is wrapped too.
      try {
        await this.deps.executions.recordReconciliationFailure(execution, detail, evaluatedAt);
      } catch {
        // Already logged above; the batch continues regardless.
      }
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

  /**
   * Executions currently eligible for reconciliation, table-wide.
   *
   * Reads the SAME RECONCILABLE_STATUSES constant as
   * `selectReconciliationBatch`, so the reported total can never describe a
   * different set from the one the cursor actually walks. A COUNT over the
   * indexed `status` column: no execution rows are loaded, and it is strictly
   * cheaper than `countRecoveryRequired`, which already runs every tick and
   * whose OR reaches an unindexed column.
   */
  async countReconcilable(): Promise<number> {
    return this.deps.prisma.tradeExecution.count({
      where: { status: { in: [...RECONCILABLE_STATUSES] } },
    });
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
