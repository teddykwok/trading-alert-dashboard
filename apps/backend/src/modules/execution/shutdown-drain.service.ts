import type { Prisma, PrismaClient, TradeExecution } from "@prisma/client";

import { logger } from "../../config/logger";
import type { EntryLifecycleService } from "./entry-lifecycle.service";
import { OPEN_POSITION_STATUSES } from "./capacity-status";
import type { TradeExecutionStatusName } from "./execution-status";
import {
  DRAIN_CANDIDATE_STATUSES,
  isExposureFreeTerminal,
  judgeDrainPosture,
  judgeShutdownReadiness,
  summarizeDrain,
  type DrainOutcome,
  type DrainedExecution,
  type ShutdownPosture,
  type ShutdownVerdict,
} from "./shutdown-drain";

/**
 * Draining Teddy-owned pending ENTRY orders before an intentional shutdown.
 *
 * ## What it does and does not do
 *
 * It cancels ENTRY orders that belong to a known local execution, one at a
 * time, through the EXISTING entry lifecycle. It never issues a broad "cancel
 * all", never touches a protection STOP or TAKE_PROFIT, and never closes a
 * position.
 *
 * The cancellation itself is `expireEntryOrderIfDue(..., "OPERATOR_RECOVERY")`,
 * which already does the hard parts: it re-queries the exchange BEFORE
 * cancelling so a fill that just landed is never cancelled over, it treats the
 * cancel response as non-final and re-reads afterwards, and it escalates rather
 * than guessing when the outcome is ambiguous. Re-implementing any of that here
 * would create a second, weaker copy of the logic that matters most.
 *
 * ## The honest limitation
 *
 * This makes an intentional shutdown safe. It cannot make an unexpected one
 * safe — an OS that suspends the process never gives this code a chance to run.
 */

export interface DrainReport {
  posture: ShutdownPosture;
  verdict: ShutdownVerdict;
  /** True when the pass performed no cancellation (evaluate, or nothing to do). */
  readOnly: boolean;
}

export class ShutdownDrainService {
  /**
   * Built for ONE profile and unable to be built without one.
   *
   * A drain cancels real orders through an entry lifecycle holding this
   * process's Binance credentials. Taking the profile in the CONSTRUCTOR
   * rather than per call means there is no unbound drain to construct and no
   * call site that can forget to pass one -- the omission is a compile error
   * rather than a silent table-wide cancellation.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly executionProfileId: string
  ) {}

  /**
   * READ-ONLY. Reports what a drain WOULD target and whether the posture allows
   * it. Performs no cancellation and reaches no exchange.
   */
  async evaluate(posture: ShutdownPosture): Promise<DrainReport> {
    const candidates = await this.findPendingEntries();

    const drained: DrainedExecution[] = candidates.map((execution) => ({
      executionId: execution.id,
      symbol: execution.symbol,
      positionSide: execution.positionSide,
      statusBefore: execution.status,
      statusAfter: execution.status,
      // Nothing has been attempted, so nothing is resolved. Reporting these as
      // clean would be a preview that promises an outcome it has not tested.
      outcome: "NOT_DRAINABLE",
      reasonCode: "NOT_ATTEMPTED",
      detail: "Pending entry that a drain would attempt to cancel.",
    }));

    return {
      posture,
      verdict: judgeShutdownReadiness({ posture, drained }),
      readOnly: true,
    };
  }

  /**
   * Cancels each pending ENTRY through the entry lifecycle, then judges whether
   * the runtime may now be stopped.
   *
   * Deterministic order — oldest first, stable by id — so a repeated run visits
   * the same executions in the same sequence and a partial pass resumes
   * predictably.
   */
  async drain(posture: ShutdownPosture, entry: EntryLifecycleService, evaluatedAt: Date = new Date()): Promise<DrainReport> {
    const gate = judgeDrainPosture(posture);
    if (!gate.allowed) {
      // Refused before touching anything: the posture is checked first so a
      // drain can never begin while new work could still be admitted.
      return {
        posture,
        verdict: { shutdownReady: false, reasons: [gate.reason], drained: [] },
        readOnly: true,
      };
    }

    const candidates = await this.findPendingEntries();
    const drained: DrainedExecution[] = [];

    for (const execution of candidates) {
      drained.push(await this.drainOne(execution, entry, evaluatedAt));
    }

    const verdict = judgeShutdownReadiness({ posture, drained });
    logger.info(
      { drained: drained.length, shutdownReady: verdict.shutdownReady, summary: summarizeDrain(verdict) },
      "Shutdown drain pass completed"
    );

    return { posture, verdict, readOnly: candidates.length === 0 };
  }

  /**
   * One execution, through the existing lifecycle.
   *
   * The classification reads the state the lifecycle actually left behind
   * rather than the HTTP result of a cancel: an execution is only "clean" if it
   * ended exposure-free and terminal.
   */
  private async drainOne(
    execution: TradeExecution,
    entry: EntryLifecycleService,
    evaluatedAt: Date
  ): Promise<DrainedExecution> {
    const base = {
      executionId: execution.id,
      symbol: execution.symbol,
      positionSide: execution.positionSide,
      statusBefore: execution.status,
    };

    // Already finished before we touched it — a second run must not re-cancel.
    if (isExposureFreeTerminal(execution.status)) {
      return {
        ...base,
        statusAfter: execution.status,
        outcome: "CANCELED_CLEAN",
        reasonCode: "ALREADY_TERMINAL",
        detail: `Already ${execution.status}; nothing was cancelled.`,
      };
    }

    const outcome = await entry.expireEntryOrderIfDue({
      executionId: execution.id,
      expectedVersion: execution.version,
      evaluatedAt,
      // The existing operator-initiated cancellation reason. It bypasses the
      // TTL check — which is the whole point of an intentional drain — while
      // keeping every other guard the lifecycle applies.
      recoveryReason: "OPERATOR_RECOVERY",
    });

    const after = await this.prisma.tradeExecution.findUnique({
      where: { id: execution.id },
      select: { status: true, filledQuantity: true },
    });
    const statusAfter = after?.status ?? execution.status;

    return {
      ...base,
      statusAfter,
      outcome: this.classify(statusAfter, outcome.reasonCode, after?.filledQuantity ?? null),
      reasonCode: outcome.reasonCode,
      detail: outcome.message,
    };
  }

  /**
   * Turns a lifecycle result into a shutdown-safety classification.
   *
   * Driven by the PERSISTED end state, not by whether the call returned ok:
   * a cancellation that "succeeded" while a partial fill exists is not a clean
   * drain, and an execution the lifecycle parked is never treated as resolved.
   */
  private classify(statusAfter: string, reasonCode: string, filledQuantity: Prisma.Decimal | null): DrainOutcome {
    if (isExposureFreeTerminal(statusAfter)) return "CANCELED_CLEAN";

    // The lifecycle parks an ambiguous cancellation here on purpose, because
    // exposure could not be ruled out. It is the one result that must never be
    // rounded up.
    if (statusAfter === "MANUAL_INTERVENTION" || reasonCode === "ENTRY_CANCEL_RESULT_UNKNOWN") {
      return "AMBIGUOUS";
    }
    if (reasonCode === "ENTRY_ORDER_QUERY_UNAVAILABLE" || reasonCode === "ENTRY_SUBMISSION_RESULT_UNKNOWN") {
      return "AMBIGUOUS";
    }

    // A fill won the race, or one was already recorded. Real exposure now
    // exists and the worker must stay to protect it.
    if (OPEN_POSITION_STATUSES.includes(statusAfter as TradeExecutionStatusName)) return "EXPOSURE_PRESENT";
    if (filledQuantity !== null && filledQuantity.greaterThan(0)) return "EXPOSURE_PRESENT";

    // Still pending, or a state with no exchange order to cancel (PREFLIGHT).
    // Neither is exposure and neither is resolved; the worker owns it.
    return "NOT_DRAINABLE";
  }

  /**
   * Teddy-owned pending entries FOR THE BOUND PROFILE, using the CANONICAL
   * pending status set rather than a second hand-written list.
   *
   * Ownership is structural: every row here belongs to a local execution this
   * system created, and the lifecycle mints the cancellation from the PERSISTED
   * reservation, so no caller-supplied symbol or order id can reach the
   * exchange. An order placed by anyone else is unreachable from this path.
   *
   * Ownership by profile is now structural too, and at the QUERY rather than
   * afterwards: shutting down the worker for one account must not cancel
   * another account's pending entries, and a row that is never selected
   * cannot be cancelled by mistake.
   */
  private async findPendingEntries(): Promise<TradeExecution[]> {
    return this.prisma.tradeExecution.findMany({
      where: {
        executionProfileId: this.executionProfileId,
        status: { in: [...DRAIN_CANDIDATE_STATUSES] as never },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }
}

/**
 * Compile-time parameter contracts.
 *
 * Asserted in typechecked SOURCE rather than in a test, because the backend
 * tsconfig excludes `tests` -- a contract pinned only in a test file would
 * never be seen by `tsc`. Making the profile OPTIONAL, or dropping it, stops
 * these tuples matching and fails the build.
 */
type ExactTuple<A extends readonly unknown[], B extends readonly unknown[]> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

const drainRequiresAProfile: ExactTuple<
  ConstructorParameters<typeof ShutdownDrainService>,
  [PrismaClient, string]
> = true;
void drainRequiresAProfile;
