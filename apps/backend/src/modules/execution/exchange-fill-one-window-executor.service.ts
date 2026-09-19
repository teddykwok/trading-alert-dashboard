import type { PrismaClient } from "@prisma/client";

import { BinanceError } from "../binance/binance.errors";
import type { BinanceUserTradeDto } from "../binance/binance.types";
import {
  USER_TRADES_MAX_LIMIT,
  planUserTradesWindow,
} from "../binance/user-trades-window-planner";
import {
  bindConfiguredExecutionProfileEnvironment,
  type BinanceProfileBindingResult,
} from "./binance-profile-binding";
import {
  ExchangeFillLedgerService,
  FillLedgerAttributionConflictError,
  FillLedgerConflictError,
  FillLedgerInsertRaceError,
  FillLedgerRaceUnresolvedError,
  type FillIngestReport,
} from "./exchange-fill-ledger.service";
import {
  ExchangeFillIngestWindowService,
  StaleFillIngestClaimError,
  type FillIngestWindowClaim,
} from "./exchange-fill-ingest-window.service";

/**
 * ONE bounded userTrades ingestion attempt, end to end.
 *
 * Claims one durable window, spends exactly one exchange request on it, and
 * commits the fills it found together with what that page proved about the
 * interval. Then it returns. It is not a loop, not a scheduler, and it has no
 * runtime caller: whatever eventually drives it decides how often to ask.
 *
 * ## The invariant this exists to hold
 *
 * A response from an attempt whose lease expired must never commit anything.
 * The window's `attempts` counter is the fencing generation, and every write
 * this executor makes -- economic and coverage alike -- lands in the SAME
 * transaction as the fenced transition. So a worker that comes back late finds
 * its transition refused, and the ledger rows it just wrote roll back with it.
 * There is no ordering in which stale evidence becomes durable truth.
 *
 * ## What one invocation may do
 *
 * Resolve the configured profile, claim ONE window, issue ONE
 * `/fapi/v1/userTrades` dispatch, and open ONE transaction. It never paginates,
 * never retries the request, and never executes the children a split creates --
 * those are ordinary pending work for a later invocation.
 */

/**
 * How long a failed attempt waits before it is eligible again.
 *
 * One conservative fixed delay rather than a schedule. The transport backoff in
 * `binance.client.ts` is module-private and measured in milliseconds because it
 * covers a socket hiccup inside one request; this covers a whole durable
 * attempt, where the useful question is "not for a while" and five minutes is
 * long enough to outlast a rate-limit window without being long enough to
 * matter for a backfill. Deliberately not exponential and not jittered: there
 * is no operational evidence yet to shape a curve from, and inventing one now
 * would be a policy nobody reviewed. Tune it before a scheduler exists.
 */
export const INGEST_RETRY_BACKOFF_MS = 300_000;

/** How much of a sanitized error phrase is worth keeping. */
const MAX_SANITIZED_ERROR_LENGTH = 300;

/**
 * Binance failures that a later attempt at THIS window might survive.
 *
 * Deliberately wide. A credential, permission or configuration problem is not
 * evidence about the interval -- it says the account cannot be read at all
 * right now -- so the window keeps its budget and an operator gets a chance to
 * fix the cause before anything is abandoned.
 */
const RETRYABLE_BINANCE_KINDS = new Set([
  "RATE_LIMIT", "SERVER", "NETWORK", "TIMEOUT", "TIMESTAMP",
  "IP_BANNED", "IP_RESTRICTED",
  "AUTH", "PERMISSION", "MISSING_CREDENTIALS", "FUTURES_NOT_ENABLED", "DISABLED",
  "READ_ONLY_VIOLATION", "MALFORMED_RESPONSE",
]);

/**
 * Binance failures that say this REQUEST can never succeed as asked.
 *
 * A sweep asks one symbol for one settled interval. If the exchange calls that
 * request invalid or the symbol unsupported, asking again changes nothing, and
 * an order-scoped refusal to a query that named no order means the endpoint is
 * answering about something else entirely.
 */
const TERMINAL_BINANCE_KINDS = new Set([
  "REQUEST_INVALID", "UNSUPPORTED_SYMBOL", "ORDER_NOT_FOUND", "ORDER_REJECTED",
]);

/** Stable reasons this executor itself decides, as opposed to relaying. */
export const FILL_INGEST_EXECUTION_REASON = {
  /** A row for a symbol this window did not ask about. */
  SYMBOL_MISMATCH: "USER_TRADES_SYMBOL_MISMATCH",
  /** More rows than the limit allowed: the endpoint broke its own contract. */
  ROW_COUNT_EXCEEDS_LIMIT: "USER_TRADES_ROW_COUNT_EXCEEDS_LIMIT",
} as const;

export type FillIngestExecutionOutcome =
  /** Nothing eligible. No request was made. */
  | "NO_WORK"
  /**
   * The configured profile could not be bound to the connector, so this process
   * does not know which account it is authorized to read. Deliberately NOT
   * folded into NO_WORK: a misconfigured process would otherwise look idle
   * forever while reporting healthy.
   */
  | "PROFILE_UNAVAILABLE"
  | "COMPLETE"
  | "INCOMPLETE_SKIPPED_ROWS"
  | "SPLIT"
  | "SATURATED_SINGLE_MILLISECOND"
  /** The attempt failed, the window kept its budget, and it will be eligible again. */
  | "RETRY_SCHEDULED"
  /** Terminal: this evidence cannot be repaired by asking again. */
  | "ABANDONED"
  /** The lease expired mid-flight. Nothing was written; a newer attempt owns it. */
  | "STALE_CLAIM";

/** What one invocation did. Carries no BigInt, no raw response and no secret. */
export interface FillIngestExecutionResult {
  outcome: FillIngestExecutionOutcome;
  windowId?: string;
  symbol?: string;
  /** The claim generation this invocation held. */
  attempt?: number;
  reasonCode?: string;
  /** Rows the EXCHANGE returned, which is what saturation was measured against. */
  returnedRowCount?: number;
  ledger?: FillIngestReport;
}

/**
 * The one exchange read this executor performs.
 *
 * Narrow on purpose: `listRecentTradesOnce` is the SINGLE_DISPATCH entry point,
 * and by naming only that method the ordinary retrying one is not reachable
 * from here even by accident. A durable attempt owns its own retry budget, and
 * transport retry inside it would make that budget mean up to three times what
 * it says.
 */
/**
 * Whether an outcome PROVES a userTrades request reached the exchange.
 *
 * The single source of truth for "was weight actually spent", shared by every
 * caller that reserves budget before an attempt -- the scheduled batch driver
 * and the operator canary alike. It lives beside `FillIngestExecutionOutcome`
 * because it is a fact about that union: exhaustive by type, so a new outcome
 * cannot be added without deciding, here, whether it cost a request.
 *
 * `false` means CERTAIN zero dispatch, which is the only condition under which
 * a reservation may be refunded. A failed REQUEST is deliberately `true`: it
 * reached the exchange and spent its weight there. An invocation that THROWS
 * never consults this table at all -- uncertain dispatch is always counted as
 * spent.
 */
export const USER_TRADES_DISPATCH_ATTEMPTED: Record<FillIngestExecutionOutcome, boolean> = {
  PROFILE_UNAVAILABLE: false,
  NO_WORK: false,
  COMPLETE: true,
  INCOMPLETE_SKIPPED_ROWS: true,
  SPLIT: true,
  SATURATED_SINGLE_MILLISECOND: true,
  RETRY_SCHEDULED: true,
  ABANDONED: true,
  STALE_CLAIM: true,
};

export interface UserTradesPageReader {
  listRecentTradesOnce(
    symbol: string,
    options: { limit?: number; startTimeMs?: number; endTimeMs?: number }
  ): Promise<BinanceUserTradeDto[]>;
}

/**
 * A planner refusal that a valid persisted window cannot produce.
 *
 * The bounds came from a row the database already constrains to be ordered,
 * non-negative and within the documented span, and the limit is the canonical
 * constant -- so anything except a row count over the limit means this code is
 * wrong about its own inputs. Raised rather than mapped onto a Binance
 * category, because calling a local bug a transient exchange failure is how it
 * survives to production.
 */
export class FillIngestPlannerInvariantError extends Error {
  readonly reasonCode = "FILL_INGEST_PLANNER_INVARIANT";

  constructor(readonly windowId: string, readonly plannerReasonCode: string, detail: string) {
    super(`Window ${windowId} produced planner refusal ${plannerReasonCode}: ${detail}`);
    this.name = "FillIngestPlannerInvariantError";
  }
}

/**
 * The ledger returned counts that do not add up to the page it was given.
 *
 * Raised INSIDE the transaction so the rows roll back with it. Coverage is a
 * claim about a page, and a page whose accounting does not balance cannot
 * support one.
 */
export class FillIngestReportInvariantError extends Error {
  readonly reasonCode = "FILL_INGEST_REPORT_INVARIANT";

  constructor(readonly windowId: string, detail: string) {
    super(`Window ${windowId} ledger report did not conserve its input: ${detail}`);
    this.name = "FillIngestReportInvariantError";
  }
}

export interface FillIngestExecutorDependencies {
  prisma: PrismaClient;
  reader: UserTradesPageReader;
  ledger: ExchangeFillLedgerService;
  work: ExchangeFillIngestWindowService;
  /**
   * How the configured profile is bound to the configured connector. Injectable
   * only so tests can drive a binding failure; the default is the real binder,
   * which takes no profile id precisely so a caller cannot name one.
   */
  bindProfile?: (prisma: PrismaClient) => Promise<BinanceProfileBindingResult>;
}

export class ExchangeFillOneWindowExecutor {
  private readonly bindProfile: (prisma: PrismaClient) => Promise<BinanceProfileBindingResult>;

  constructor(private readonly deps: FillIngestExecutorDependencies) {
    this.bindProfile = deps.bindProfile ?? bindConfiguredExecutionProfileEnvironment;
  }

  /**
   * Processes AT MOST ONE window attempt, then returns.
   *
   * The caller names itself and nothing else. There is deliberately no profile
   * argument: the account this executor is authorized to read comes from the
   * same configuration the connector does, so no caller can point it at a
   * different one.
   */
  async executeOne(options: { workerId: string; now?: Date }): Promise<FillIngestExecutionResult> {
    const now = options.now ?? new Date();

    /**
     * The profile is resolved BEFORE anything is claimed. A configuration
     * failure is not evidence about a window, and burning one of a window's
     * five attempts on it would spend a budget that exists to bound EXCHANGE
     * trouble.
     */
    const binding = await this.bindProfile(this.deps.prisma);
    if (!binding.ok) {
      return { outcome: "PROFILE_UNAVAILABLE", reasonCode: binding.reasonCode };
    }
    const bound = binding.context;

    const claim = await this.deps.work.claimNextWindow(this.deps.prisma, {
      executionProfileId: bound.executionProfileId,
      workerId: options.workerId,
      now,
    });
    if (claim === null) return { outcome: "NO_WORK" };

    return this.executeClaimed(bound.executionProfileId, claim, now);
  }

  /**
   * Processes ONE EXPLICITLY NAMED window attempt, then returns.
   *
   * The operator canary's executor entrypoint. It differs from `executeOne` in
   * exactly one respect -- WHICH row it claims -- and in no other: the same
   * binder decides the account, the same fencing decides whether the row may be
   * claimed, and the same post-claim path below decides everything that happens
   * afterwards.
   *
   * Still no profile argument. Naming a window does not name an account, and
   * `claimSpecificWindow` matches the bound profile as a predicate, so a window
   * id belonging to somebody else simply fails to claim.
   *
   * `NO_WORK` here means "the named window could not be claimed" -- it was
   * finished, exhausted, backing off, already leased, or won by somebody else
   * between the read and the compare-and-set. NOTHING ELSE IS CLAIMED INSTEAD,
   * and no exchange request is made. Callers that reserved budget on the
   * assumption of a dispatch may refund it under the same proven-zero-dispatch
   * predicate they already apply to `executeOne`.
   */
  async executeSpecificWindow(options: {
    workerId: string;
    windowId: string;
    now?: Date;
  }): Promise<FillIngestExecutionResult> {
    const now = options.now ?? new Date();

    // Identical to `executeOne`, and for the identical reason: a configuration
    // failure is not evidence about a window, so it must not burn an attempt.
    const binding = await this.bindProfile(this.deps.prisma);
    if (!binding.ok) {
      return { outcome: "PROFILE_UNAVAILABLE", reasonCode: binding.reasonCode };
    }
    const bound = binding.context;

    const claim = await this.deps.work.claimSpecificWindow(this.deps.prisma, {
      executionProfileId: bound.executionProfileId,
      workerId: options.workerId,
      windowId: options.windowId,
      now,
    });
    if (claim === null) return { outcome: "NO_WORK" };

    return this.executeClaimed(bound.executionProfileId, claim, now);
  }

  /**
   * Everything that happens to a window once it is CLAIMED, whichever route
   * claimed it.
   *
   * THE CONVERGENCE POINT, and the reason targeting is safe. The request, the
   * symbol-integrity refusal, the saturation planner and the ledger commit
   * exist once, here. A targeted invocation cannot drift from the scheduled one
   * because there is no second copy of this logic to drift from -- and anything
   * a future slice changes about ingestion changes for both at the same instant.
   *
   * Extraction only: every line below came from `executeOne` unchanged, and the
   * profile it commits against is now a parameter rather than a local binding
   * because the two callers bind it at their own boundary.
   */
  private async executeClaimed(
    executionProfileId: string,
    claim: FillIngestWindowClaim,
    now: Date
  ): Promise<FillIngestExecutionResult> {
    // --- The one exchange request. No transaction is open across it. --------
    let trades: BinanceUserTradeDto[];
    try {
      trades = await this.deps.reader.listRecentTradesOnce(claim.symbol, {
        startTimeMs: claim.startTimeMs,
        endTimeMs: claim.endTimeMs,
        limit: USER_TRADES_MAX_LIMIT,
      });
    } catch (error) {
      return this.afterRequestFailure(claim, error, now);
    }

    /**
     * SYMBOL INTEGRITY, before any economic transaction.
     *
     * The request named one symbol, so a row carrying a different readable one
     * means the endpoint answered about something else. Feeding that page to
     * the ledger would insert another symbol's economics; filtering it out
     * would silently convert a broken answer into a short page and mark THIS
     * window proven. Neither is survivable, so the page is refused whole and
     * the window is terminalized on the evidence rather than the interval.
     *
     * A null symbol is not a mismatch -- it is an unreadable row, which the
     * ledger already refuses as incomplete. Nothing is fabricated into it.
     */
    const foreign = trades.find((trade) => trade.symbol !== null && trade.symbol !== claim.symbol);
    if (foreign !== undefined) {
      return this.abandon(claim, FILL_INGEST_EXECUTION_REASON.SYMBOL_MISMATCH, null, trades.length);
    }

    /**
     * The page's own cardinality is what saturation is measured against --
     * never an inserted, deduplicated or attributed tally. A thousand rows that
     * collapse to one durable fill is still a truncated page, and counting the
     * narrower number would end a window that was never exhausted.
     */
    const decision = planUserTradesWindow({
      window: { startTimeMs: claim.startTimeMs, endTimeMs: claim.endTimeMs },
      limit: USER_TRADES_MAX_LIMIT,
      returnedRowCount: trades.length,
    });

    if (decision.kind === "REFUSED") {
      if (decision.reasonCode === "ROW_COUNT_EXCEEDS_LIMIT") {
        return this.abandon(
          claim,
          FILL_INGEST_EXECUTION_REASON.ROW_COUNT_EXCEEDS_LIMIT,
          null,
          trades.length
        );
      }
      throw new FillIngestPlannerInvariantError(claim.windowId, decision.reasonCode, decision.message);
    }

    return this.commit(executionProfileId, claim, trades, decision, now);
  }

  /**
   * The fills and what the page proved, in ONE transaction.
   *
   * This is the whole point of the slice. The ledger writes and the fenced work
   * transition commit together or not at all, so there is no instant at which
   * an interval is marked processed with none of its fills recorded -- a hole
   * that would look exactly like proven-empty history forever after.
   *
   * The transition is fenced on the claim generation, which means a worker
   * whose lease expired while its request was in flight fails HERE, and takes
   * its own ledger rows down with it.
   */
  private async commit(
    executionProfileId: string,
    claim: FillIngestWindowClaim,
    trades: BinanceUserTradeDto[],
    decision: Extract<
      ReturnType<typeof planUserTradesWindow>,
      { kind: "COMPLETE" | "SPLIT" | "SATURATED_SINGLE_MILLISECOND" }
    >,
    now: Date
  ): Promise<FillIngestExecutionResult> {
    try {
      return await this.deps.prisma.$transaction(async (tx) => {
        const report = await this.deps.ledger.ingestUserTradesInTransaction(
          tx,
          executionProfileId,
          trades
        );
        this.assertReportConserves(claim, report, trades.length);

        const settled = (outcome: FillIngestExecutionOutcome): FillIngestExecutionResult => ({
          outcome,
          windowId: claim.windowId,
          symbol: claim.symbol,
          attempt: claim.attempt,
          returnedRowCount: trades.length,
          ledger: report,
        });

        if (decision.kind === "SPLIT") {
          /**
           * A skipped row does NOT downgrade a SPLIT parent to a known gap.
           * The parent is proof of SUBDIVISION, not of economic completeness --
           * its children re-query the same milliseconds at finer resolution, and
           * whichever leaf finally returns a short page containing that row is
           * the one that records the hole, at the narrowest interval that
           * isolates it.
           */
          await this.deps.work.splitWindowInTransaction(tx, claim, {
            left: decision.left,
            right: decision.right,
          });
          return settled("SPLIT");
        }

        if (decision.kind === "SATURATED_SINGLE_MILLISECOND") {
          // Terminal even with nothing skipped: there is no smaller window to
          // ask for, so time-windowing cannot prove exhaustion at all.
          await this.deps.work.markSaturatedSingleMillisecond(tx, claim);
          return settled("SATURATED_SINGLE_MILLISECOND");
        }

        /**
         * A short page proves the interval was not truncated. It proves the
         * interval is WHOLE only if every row it returned could be represented:
         * one unusable row is a known hole, and the good rows stay recorded
         * while the claim of completeness is withheld.
         */
        if (report.skipped === 0) {
          await this.deps.work.markComplete(tx, claim);
          return settled("COMPLETE");
        }
        await this.deps.work.markIncompleteSkippedRows(tx, claim);
        return settled("INCOMPLETE_SKIPPED_ROWS");
      });
    } catch (error) {
      return this.afterTransactionFailure(claim, error, now, trades.length);
    }
  }

  /**
   * The report must account for every row it was handed.
   *
   * Checked rather than trusted, and checked INSIDE the transaction so a
   * disagreement rolls the rows back instead of committing coverage on
   * arithmetic nobody can reproduce.
   */
  private assertReportConserves(
    claim: FillIngestWindowClaim,
    report: FillIngestReport,
    returnedRowCount: number
  ): void {
    const accounted = report.inserted + report.duplicates + report.skipped;
    if (accounted !== returnedRowCount) {
      throw new FillIngestReportInvariantError(
        claim.windowId,
        `inserted ${report.inserted} + duplicates ${report.duplicates} + skipped ${report.skipped} ` +
          `= ${accounted}, but the page held ${returnedRowCount}`
      );
    }
    if (report.attributionEnriched > report.duplicates) {
      throw new FillIngestReportInvariantError(
        claim.windowId,
        `attributionEnriched ${report.attributionEnriched} exceeds duplicates ${report.duplicates}`
      );
    }
  }

  /**
   * What a failed request costs this window.
   *
   * No transaction was opened and no economic row was written, so the only
   * question is whether asking again could ever answer differently. The two
   * sets are exhaustive over `BinanceErrorKind`; anything else -- including a
   * failure that is not a BinanceError at all -- is rethrown rather than
   * guessed at, because a wrong classification either abandons recoverable
   * history or retries an unrecoverable request five times.
   */
  private async afterRequestFailure(
    claim: FillIngestWindowClaim,
    error: unknown,
    now: Date
  ): Promise<FillIngestExecutionResult> {
    if (!(error instanceof BinanceError)) throw error;

    // Already sanitized: BinanceError runs every message through
    // `sanitizeBinanceText` at construction, so no credential, signature or
    // API-key header can reach the column.
    const sanitized = error.message.slice(0, MAX_SANITIZED_ERROR_LENGTH);

    if (TERMINAL_BINANCE_KINDS.has(error.kind)) {
      return this.abandon(claim, error.kind, sanitized);
    }
    if (RETRYABLE_BINANCE_KINDS.has(error.kind)) {
      return this.scheduleRetry(claim, error.kind, sanitized, now);
    }
    throw error;
  }

  /**
   * What a failed transaction costs this window.
   *
   * The transaction has already rolled back, so nothing this invocation wrote
   * survives -- not the fills, not the transition. Ingestion is NOT retried
   * inside this invocation: an insert race resolves by a FRESH read, and this
   * one has none.
   */
  private async afterTransactionFailure(
    claim: FillIngestWindowClaim,
    error: unknown,
    now: Date,
    returnedRowCount: number
  ): Promise<FillIngestExecutionResult> {
    /**
     * The fence refused us. Our lease expired while the request was in flight
     * and a newer attempt owns this window; everything we just wrote went with
     * the rollback, which is exactly the design working.
     */
    if (error instanceof StaleFillIngestClaimError) {
      return {
        outcome: "STALE_CLAIM",
        windowId: claim.windowId,
        symbol: claim.symbol,
        attempt: claim.attempt,
        reasonCode: error.reasonCode,
        returnedRowCount,
      };
    }

    // Contention, not contradiction: a later attempt reads what the winner
    // wrote and compares against it properly.
    if (error instanceof FillLedgerInsertRaceError || error instanceof FillLedgerRaceUnresolvedError) {
      return this.scheduleRetry(claim, error.reasonCode, null, now, returnedRowCount);
    }

    /**
     * Contradiction, not contention. The exchange reported economics that
     * disagree with economics already durable under the same immutable trade
     * id, or an owner that disagrees with a recorded one. Asking again
     * reproduces it exactly, so the window is terminalized where an operator
     * can see it rather than spending four more attempts on the same answer.
     */
    if (error instanceof FillLedgerConflictError || error instanceof FillLedgerAttributionConflictError) {
      return this.abandon(claim, error.reasonCode, null, returnedRowCount);
    }

    throw error;
  }

  /** Terminal, fenced. A stale claimant abandons nothing. */
  private async abandon(
    claim: FillIngestWindowClaim,
    reasonCode: string,
    sanitizedError: string | null,
    returnedRowCount?: number
  ): Promise<FillIngestExecutionResult> {
    try {
      await this.deps.work.markAbandoned(this.deps.prisma, claim, { reasonCode, sanitizedError });
    } catch (error) {
      if (error instanceof StaleFillIngestClaimError) {
        return this.stale(claim, error.reasonCode, returnedRowCount);
      }
      throw error;
    }
    return {
      outcome: "ABANDONED",
      windowId: claim.windowId,
      symbol: claim.symbol,
      attempt: claim.attempt,
      reasonCode,
      returnedRowCount,
    };
  }

  /** Durable backoff, fenced. The window keeps whatever budget it has left. */
  private async scheduleRetry(
    claim: FillIngestWindowClaim,
    reasonCode: string,
    sanitizedError: string | null,
    now: Date,
    returnedRowCount?: number
  ): Promise<FillIngestExecutionResult> {
    let settled: "PENDING" | "ABANDONED";
    try {
      settled = await this.deps.work.recordRetryableFailure(this.deps.prisma, claim, {
        reasonCode,
        sanitizedError,
        nextEligibleAt: new Date(now.getTime() + INGEST_RETRY_BACKOFF_MS),
      });
    } catch (error) {
      if (error instanceof StaleFillIngestClaimError) {
        return this.stale(claim, error.reasonCode, returnedRowCount);
      }
      throw error;
    }
    return {
      // The window service abandons on its own once the budget is spent, and
      // that is reported as what it is rather than as a scheduled retry.
      outcome: settled === "ABANDONED" ? "ABANDONED" : "RETRY_SCHEDULED",
      windowId: claim.windowId,
      symbol: claim.symbol,
      attempt: claim.attempt,
      reasonCode,
      returnedRowCount,
    };
  }

  private stale(
    claim: FillIngestWindowClaim,
    reasonCode: string,
    returnedRowCount?: number
  ): FillIngestExecutionResult {
    return {
      outcome: "STALE_CLAIM",
      windowId: claim.windowId,
      symbol: claim.symbol,
      attempt: claim.attempt,
      reasonCode,
      returnedRowCount,
    };
  }
}
