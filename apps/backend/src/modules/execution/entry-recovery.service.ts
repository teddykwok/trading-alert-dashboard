import type { PrismaClient, TradeExecution } from "@prisma/client";

import { logger } from "../../config/logger";
import type { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import { classifyMutationOutcome, type MutationFailureShape } from "./entry-lifecycle";
import {
  gathered,
  judgeEntryAbsence,
  summarizeAbsence,
  unavailable,
  type AbsenceVerdict,
  type EntryAbsenceEvidence,
  type EvidenceFact,
} from "./entry-absence-evidence";

/**
 * Evidence-gated recovery for ONE stuck ENTRY_SUBMITTING execution.
 *
 * ## What this exists for
 *
 * A submission whose outcome never became known leaves the execution in
 * ENTRY_SUBMITTING holding risk and margin. That status is deliberately part of
 * RECOVERY_REQUIRED, so while it is unresolved every later signal is refused —
 * which is correct while the outcome is genuinely uncertain, and a permanent
 * trading halt when the outcome is knowable and simply never asked for.
 *
 * This service asks. It gathers the exchange facts, hands them to a pure judge,
 * and terminalizes ONLY on a complete proof of absence.
 *
 * ## What it deliberately is not
 *
 *  - It is not automatic. Reconciliation never calls it; an operator names one
 *    executionId. A stuck row is a money question, and the system should not
 *    quietly decide it on a timer.
 *  - It is not a "clear stuck executions" tool. There is no bulk form, because
 *    the proof is per-execution and a bulk verb invites acting on the aggregate
 *    rather than on the evidence.
 *  - It never submits, cancels, or configures anything. Every exchange call it
 *    makes is a signed GET through the read-only connector, so it is safe while
 *    SAFE_OFF/SAFE_RECOVERY and needs no live-entry gate.
 */

export const ENTRY_RECOVERY_OUTCOMES = [
  /** Absence proven; the execution is now terminal and its capacity is free. */
  "RECOVERED",
  /** Already terminal — a repeat call, and deliberately not an error. */
  "ALREADY_RESOLVED",
  /** Evidence incomplete or contradicting. Nothing was changed. */
  "BLOCKED",
  /** The execution is not in a state this service may act on. */
  "NOT_APPLICABLE",
  /**
   * The execution belongs to a different profile than this process is bound
   * to. A refusal, never a skip: the operator named a real row and deserves
   * to be told why this process will not touch it.
   */
  "FOREIGN_PROFILE",
] as const;

export type EntryRecoveryOutcome = (typeof ENTRY_RECOVERY_OUTCOMES)[number];

export interface EntryRecoveryResult {
  ok: boolean;
  outcome: EntryRecoveryOutcome;
  executionId: string;
  /** Sanitized, operator-readable. Never a raw exchange payload. */
  message: string;
  /** Which checks passed, and which blocked. Names only. */
  checks: string[];
  blockers: string[];
  /** The status the execution holds after the call. */
  status: string | null;
}

/** The only status this service will ever act on. */
const RECOVERABLE_STATUS = "ENTRY_SUBMITTING";

/** Reached only on a complete absence proof; capacity-free by definition. */
const TERMINAL_STATUS = "FAILED";

export const ENTRY_RECOVERY_REASON_CODE = "ENTRY_SUBMISSION_ABANDONED";

export class EntryRecoveryService {
  /**
   * Bound to ONE profile, and unable to be built without one.
   *
   * `readOnly` is authenticated for exactly one account. An executionId comes
   * from an operator's terminal, so nothing upstream guarantees the row
   * belongs to that account -- this service has to check, and it can only
   * check against something it was given at construction.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly readOnly: BinanceReadOnlyService,
    private readonly executionProfileId: string
  ) {}

  /**
   * Evaluate the evidence WITHOUT changing anything.
   *
   * Exposed separately so an operator (or a test) can see exactly what the
   * exchange says before anything is decided. `recover` runs the same gather
   * and refuses to act on a different reading.
   */
  async evaluate(executionId: string): Promise<{ verdict: AbsenceVerdict; evidence: EntryAbsenceEvidence } | null> {
    const execution = await this.loadOwnedExecution(executionId);
    if (!execution || execution.status !== RECOVERABLE_STATUS) return null;
    // SECONDARY guard. The query above cannot return a foreign row, so this
    // can only fire if something bypassed it; it still runs BEFORE `gather`,
    // which is the first thing that would reach the exchange.
    if (!this.belongsToBoundProfile(execution)) return null;
    const evidence = await this.gather(execution);
    return { verdict: judgeEntryAbsence(evidence), evidence };
  }

  /**
   * Terminalize ONE execution, but only on a complete proof of absence.
   *
   * Idempotent by construction: the write is conditional on the execution still
   * being ENTRY_SUBMITTING at the version that was evaluated, so a repeat call,
   * a concurrent reconciliation and a process restart cannot double-release.
   */
  async recover(executionId: string): Promise<EntryRecoveryResult> {
    const execution = await this.loadOwnedExecution(executionId);
    if (!execution) {
      // The row was not selected, so nothing about it is known here. Which
      // refusal to print is decided by a COUNT -- no row, no fields, nothing
      // that could be carried onward into evidence gathering.
      return (await this.existsUnderAnyProfile(executionId))
        ? this.result(
            false,
            "FOREIGN_PROFILE",
            executionId,
            "The execution belongs to a different execution profile than this process is bound to; nothing was read from the exchange and nothing was changed.",
            [],
            ["execution belongs to another execution profile"],
            null
          )
        : this.result(false, "NOT_APPLICABLE", executionId, "No such execution.", [], [], null);
    }
    // SECONDARY guard, kept deliberately: the DB predicate is the primary
    // one, so reaching this branch means the query was defeated. Said out
    // loud, with ids only -- never an account alias or a credential.
    // one, and a row that reached here mismatched means something bypassed it.
    if (!this.belongsToBoundProfile(execution)) {
      logger.error(
        { executionId, boundExecutionProfileId: this.executionProfileId },
        "Entry recovery refused an execution that bypassed its profile-scoped query"
      );
      return this.result(
        false,
        "FOREIGN_PROFILE",
        executionId,
        "The execution belongs to a different execution profile than this process is bound to; nothing was read from the exchange and nothing was changed.",
        [],
        ["execution belongs to another execution profile (it bypassed the scoped query)"],
        null
      );
    }
    if (execution.status !== RECOVERABLE_STATUS) {
      // A row that already reached a terminal state is a success from the
      // caller's point of view: the thing they asked for is true.
      const resolved = execution.status !== "PREFLIGHT" && execution.status !== "PLAN_READY";
      return this.result(
        resolved,
        resolved ? "ALREADY_RESOLVED" : "NOT_APPLICABLE",
        executionId,
        `The execution is ${execution.status}; only ${RECOVERABLE_STATUS} is recoverable here.`,
        [],
        [],
        execution.status
      );
    }

    const evidence = await this.gather(execution);
    const verdict = judgeEntryAbsence(evidence);

    logger.info(
      { executionId, symbol: execution.symbol, verdict: summarizeAbsence(verdict) },
      "Entry recovery evidence evaluated"
    );

    if (!verdict.proven) {
      // Fail closed, loudly, and leave every reservation exactly where it was.
      return this.result(
        false,
        "BLOCKED",
        executionId,
        `Absence is not proven (${verdict.reasonCode}); nothing was released.`,
        verdict.checks,
        verdict.blockers,
        execution.status
      );
    }

    const committed = await this.prisma.$transaction(async (tx) => {
      // Conditional on status AND version: whatever else raced us, this write
      // lands at most once for the state that was actually evaluated.
      const updated = await tx.tradeExecution.updateMany({
        where: { id: execution.id, version: execution.version, status: RECOVERABLE_STATUS },
        data: {
          status: TERMINAL_STATUS,
          version: { increment: 1 },
          requiresManualIntervention: false,
          decisionReasonCode: ENTRY_RECOVERY_REASON_CODE,
          sanitizedMessage:
            "Entry submission abandoned: the exchange proved no order, fill or position exists for it.",
        },
      });
      if (updated.count === 0) return null;

      // Scoped like every other read in this service, so the rule is absolute
      // rather than "except the one inside the transaction". The CAS above just
      // matched this exact row, so the predicate cannot change what is found.
      const next = await tx.tradeExecution.findFirstOrThrow({
        where: { id: execution.id, executionProfileId: this.executionProfileId },
      });
      // The local intent is closed out too, so nothing later mistakes a
      // SUBMITTING row for work still in flight.
      await tx.binanceOrder.updateMany({
        where: { tradeExecutionId: execution.id, role: "ENTRY", status: "SUBMITTING" },
        data: { status: "CANCELED" },
      });
      await tx.executionEvent.create({
        data: {
          tradeExecutionId: execution.id,
          sequenceNumber: next.version,
          eventType: "FAILURE_RECORDED",
          fromStatus: RECOVERABLE_STATUS,
          toStatus: TERMINAL_STATUS,
          reasonCode: ENTRY_RECOVERY_REASON_CODE,
          message: `Absence proven by ${verdict.checks.length} independent exchange checks; risk and margin released.`,
        },
      });
      return next;
    });

    if (!committed) {
      const current = await this.loadOwnedExecution(execution.id);
      return this.result(
        false,
        "BLOCKED",
        executionId,
        "The execution changed while its evidence was being evaluated; nothing was released.",
        verdict.checks,
        ["version or status changed during evaluation"],
        current?.status ?? null
      );
    }

    logger.warn(
      { executionId, symbol: execution.symbol, checks: verdict.checks.length },
      "Entry submission abandoned after proven absence — risk and margin released"
    );

    return this.result(
      true,
      "RECOVERED",
      executionId,
      // The claim is deliberately not mentioned as refunded: claims are
      // cumulative and this releases capacity, never authorization.
      "Absence proven. The execution is FAILED, its risk and margin reservations are released, and the authorization claim remains spent.",
      verdict.checks,
      [],
      committed.status
    );
  }

  // -------------------------------------------------------------------------
  // Evidence gathering — every fact independently, every failure recorded
  // -------------------------------------------------------------------------

  /**
   * Each fact is gathered in its own try/catch so ONE failing call cannot make
   * the others look clean. A thrown error becomes UNAVAILABLE carrying a
   * sanitized reason, which the judge treats as a blocker rather than a "no".
   */
  private async gather(execution: TradeExecution): Promise<EntryAbsenceEvidence> {
    const symbol = execution.symbol;
    const positionSide = execution.positionSide;

    const entryOrder = await this.prisma.binanceOrder.findFirst({
      where: { tradeExecutionId: execution.id, role: "ENTRY" },
      orderBy: { generation: "desc" },
    });

    const clientOrderId = entryOrder?.clientOrderId ?? null;

    const exactQuery: EvidenceFact<ReturnType<typeof classifyMutationOutcome>> = clientOrderId
      ? await this.fact(async () => {
          try {
            await this.readOnly.queryOrderByClientOrderId(symbol, clientOrderId);
            // It answered with an order: that is the opposite of absence.
            return "CONFIRMED_ACCEPTED" as const;
          } catch (error) {
            // NOT_FOUND_CONFIRMED only when Binance said so about THIS id.
            return classifyMutationOutcome(this.failureShape(error), "QUERY");
          }
        })
      : unavailable("no local entry order row carries a client order id");

    const history = clientOrderId
      ? await this.fact(async () => {
          const rows = await this.readOnly.listRecentOrders(symbol, {
            startTimeMs: execution.createdAt.getTime() - HISTORY_LOOKBEHIND_MS,
          });
          return rows.some((row) => row.clientOrderId === clientOrderId);
        })
      : unavailable<boolean>("no local entry order row carries a client order id");

    const fills = await this.fact(async () => {
      const trades = await this.readOnly.listRecentTrades(symbol, {
        startTimeMs: execution.createdAt.getTime() - HISTORY_LOOKBEHIND_MS,
      });
      // Any trade on this symbol/side in the window is disqualifying. Being
      // broader than the exact order id is deliberate: a fill we cannot
      // attribute is exactly the case that must not release.
      return trades.some((trade) => trade.positionSide === null || trade.positionSide === positionSide);
    });

    const position = await this.fact(async () => {
      const found = await this.readOnly.getPositionForSide(symbol, positionSide);
      return found?.positionAmt ?? "0";
    });

    const openOrder = await this.fact(async () => {
      const open = (await this.readOnly.getOpenOrders(symbol)) as Array<{ clientOrderId?: string | null }>;
      if (!Array.isArray(open)) throw new Error("open orders response was not a list");
      return clientOrderId === null ? open.length > 0 : open.some((row) => row.clientOrderId === clientOrderId);
    });

    const algo = await this.fact(async () => {
      const open = await this.readOnly.getOpenAlgoOrders(symbol);
      return open.length > 0;
    });

    const protectionStateExists = await this.fact(async () => {
      const count = await this.prisma.executionProtectionState.count({
        where: { tradeExecutionId: execution.id },
      });
      return count > 0;
    });

    return {
      exactQuery,
      historyContainsOrder: history,
      fillsExist: fills,
      positionAmount: position,
      openOrderExists: openOrder,
      algoOrderExists: algo,
      localExecutedQuantity: gathered(entryOrder?.executedQuantity?.toString() ?? "0"),
      protectionStateExists,
    };
  }

  private async fact<T>(read: () => Promise<T>): Promise<EvidenceFact<T>> {
    try {
      return gathered(await read());
    } catch (error) {
      return unavailable(describeFailure(error));
    }
  }

  private failureShape(error: unknown): MutationFailureShape {
    const shaped = error as { kind?: unknown; binanceCode?: unknown; httpStatus?: unknown };
    return {
      kind: (typeof shaped?.kind === "string" ? shaped.kind : "MALFORMED_RESPONSE") as MutationFailureShape["kind"],
      binanceCode: typeof shaped?.binanceCode === "number" ? shaped.binanceCode : null,
      httpStatus: typeof shaped?.httpStatus === "number" ? shaped.httpStatus : null,
    };
  }

  /**
   * THE load-bearing read: an execution is selected by id AND by the bound
   * profile, in one predicate, at the database boundary.
   *
   * A row-addressed read followed by a JavaScript ownership check is not the
   * same thing. It brings another account's execution into this process, and
   * every later line is then one forgotten branch away from handing it to a
   * signed client. Not selecting it at all removes that possibility rather
   * than guarding against it.
   */
  private async loadOwnedExecution(executionId: string): Promise<TradeExecution | null> {
    return this.prisma.tradeExecution.findFirst({
      where: { id: executionId, executionProfileId: this.executionProfileId },
    });
  }

  /**
   * EXISTENCE ONLY, and deliberately a count rather than a row.
   *
   * It exists so an operator who names another profile's execution is told
   * that, instead of being told the row does not exist during an incident.
   * It returns a number: there is no object to pass to `gather`, no field to
   * print, and no path from here into signed logic.
   */
  private async existsUnderAnyProfile(executionId: string): Promise<boolean> {
    return (await this.prisma.tradeExecution.count({ where: { id: executionId } })) > 0;
  }

  /**
   * The profile this service is bound to, for callers that need to EXPLAIN
   * a refusal rather than re-derive it.
   *
   * Exposing the id is not a selector: it is read-only, it is the value
   * supplied at construction, and no method accepts one.
   */
  get boundExecutionProfileId(): string {
    return this.executionProfileId;
  }

  /**
   * Whether a loaded row belongs to the profile this process is bound to.
   *
   * Compares persisted ids only. No account number is invented and no
   * credential is consulted -- the bound id came from configuration and the
   * row's came from the database, and those are the only two facts needed.
   */
  private belongsToBoundProfile(execution: TradeExecution): boolean {
    return execution.executionProfileId === this.executionProfileId;
  }

  private result(
    ok: boolean,
    outcome: EntryRecoveryOutcome,
    executionId: string,
    message: string,
    checks: string[],
    blockers: string[],
    status: string | null
  ): EntryRecoveryResult {
    return { ok, outcome, executionId, message, checks, blockers, status };
  }
}

/**
 * How far before the execution was created the history queries reach back.
 *
 * An hour of slack around a submission that happens in milliseconds. It bounds
 * the query, never the proof: nothing here concludes absence because a window
 * elapsed — a window that returns no rows is only ever ONE of the facts the
 * judge requires, and any query that fails is a blocker.
 */
const HISTORY_LOOKBEHIND_MS = 60 * 60 * 1000;

/** Log-safe: error type and errno/Binance code only, never a message body. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { binanceCode?: number | null }).binanceCode;
    return code === undefined || code === null ? error.name : `${error.name}(${code})`;
  }
  return "UnknownError";
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

const entryRecoveryRequiresAProfile: ExactTuple<
  ConstructorParameters<typeof EntryRecoveryService>,
  [PrismaClient, BinanceReadOnlyService, string]
> = true;
void entryRecoveryRequiresAProfile;

/** No method takes a profile: the binding is construction-time and only.
 *  `recover` and `evaluate` take an execution id and nothing else. */
const entryRecoveryTakesOnlyAnExecutionId: ExactTuple<
  Parameters<EntryRecoveryService["recover"]>,
  [string]
> = true;
void entryRecoveryTakesOnlyAnExecutionId;
