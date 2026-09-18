import { Prisma, type HistoricalFillCircuitState, type PrismaClient } from "@prisma/client";

import { lockCampaignForProfile } from "./historical-fill-campaign-lock";

/**
 * The systemic stop for one ACCOUNT's historical backfill.
 *
 * ## What it is for
 *
 * Every other bound in this subsystem counts requests. None of them notices
 * that the requests are all failing for the SAME reason. A rejected credential
 * or a banned IP is not a fact about the interval being asked for, so the
 * one-window executor -- correctly -- keeps each window's retry budget and
 * moves on to the next window. The next window then spends another campaign
 * slot, another minute's weight and another ingest attempt on the identical
 * fault. At the shipped defaults that is five dispatches a minute, so a
 * hundred-slot campaign is gone in twenty minutes and a hundred separate
 * windows have each lost one of their five attempts.
 *
 * This service is the thing that notices.
 *
 * ## Why the PROFILE and not the campaign
 *
 * The faults that open it describe the account, the key or the connector.
 * Campaign-scoped state was proven insufficient twice: a campaign that spends
 * its final slot becomes EXHAUSTED, which the live-uniqueness index does not
 * cover, so a replacement campaign could be created and burned against the
 * same unresolved fault; and a campaign manually PAUSED while a request was
 * still in flight could not record that request's result at all, so ordinary
 * resume walked straight back into it. Keyed by the profile, the latch outlives
 * every campaign, worker and restart.
 *
 * ## It is a LATCH
 *
 * Once OPEN, nothing here changes it back -- not a later success, not time.
 * The faults it exists for are fixed by a person changing configuration, and a
 * breaker that closed itself would simply re-burn the budget. Only an explicit
 * operator acknowledgement closes it.
 *
 * ## No network I/O
 *
 * Nothing in this file talks to anything but Postgres, and every write is one
 * short transaction under the profile advisory lock.
 */

/** Consecutive failures within one family before the latch closes over. */
export const SYSTEMIC_THRESHOLD = 3;

/**
 * Why a run of failures is being counted together.
 *
 * Grouped by REMEDY, not by transport detail: two codes share a family when an
 * operator would do the same thing about them. That is what makes an outage
 * alternating NETWORK/TIMEOUT/SERVER count as one streak of three rather than
 * three streaks of one -- and equally why RATE_LIMIT (slow down) and TIMESTAMP
 * (fix the clock) stay apart instead of combining two unrelated single
 * failures into a trip.
 *
 * A source constant, never a database enum: the underlying transport kinds grow
 * over time, and a DB enum would force a migration every time one is added.
 */
export const HISTORICAL_FILL_FAILURE_FAMILY = {
  HARD_CONFIGURATION: "HARD_CONFIGURATION",
  TRANSIENT_TRANSPORT: "TRANSIENT_TRANSPORT",
  RATE_LIMIT: "RATE_LIMIT",
  TIMESTAMP: "TIMESTAMP",
  MALFORMED: "MALFORMED",
  REQUEST_CONTRACT: "REQUEST_CONTRACT",
} as const;

export type HistoricalFillFailureFamily =
  (typeof HISTORICAL_FILL_FAILURE_FAMILY)[keyof typeof HISTORICAL_FILL_FAILURE_FAMILY];

/** How many consecutive failures each family tolerates. */
const FAMILY_THRESHOLD: Record<HistoricalFillFailureFamily, number> = {
  // ONE. These say the account cannot be read at all right now, and no other
  // window can answer differently without a person changing something.
  HARD_CONFIGURATION: 1,
  TRANSIENT_TRANSPORT: SYSTEMIC_THRESHOLD,
  RATE_LIMIT: SYSTEMIC_THRESHOLD,
  TIMESTAMP: SYSTEMIC_THRESHOLD,
  MALFORMED: SYSTEMIC_THRESHOLD,
  REQUEST_CONTRACT: SYSTEMIC_THRESHOLD,
};

/**
 * Which reason code belongs to which family.
 *
 * The keys are `BinanceErrorKind` names as the transport classifies them, plus
 * the two reasons the executor decides for itself when the endpoint breaks its
 * own contract.
 */
const FAMILY_BY_REASON_CODE: Readonly<Record<string, HistoricalFillFailureFamily>> = {
  MISSING_CREDENTIALS: "HARD_CONFIGURATION",
  AUTH: "HARD_CONFIGURATION",
  PERMISSION: "HARD_CONFIGURATION",
  IP_BANNED: "HARD_CONFIGURATION",
  IP_RESTRICTED: "HARD_CONFIGURATION",
  FUTURES_NOT_ENABLED: "HARD_CONFIGURATION",
  DISABLED: "HARD_CONFIGURATION",
  READ_ONLY_VIOLATION: "HARD_CONFIGURATION",

  SERVER: "TRANSIENT_TRANSPORT",
  NETWORK: "TRANSIENT_TRANSPORT",
  TIMEOUT: "TRANSIENT_TRANSPORT",

  RATE_LIMIT: "RATE_LIMIT",
  TIMESTAMP: "TIMESTAMP",

  MALFORMED_RESPONSE: "MALFORMED",
  USER_TRADES_SYMBOL_MISMATCH: "MALFORMED",
  USER_TRADES_ROW_COUNT_EXCEEDS_LIMIT: "MALFORMED",

  // NOT window-local for this endpoint. A userTrades request varies per window
  // only in symbol and two timestamps; its parameter STRUCTURE is identical
  // every time. So "unknown parameter", "parameter not read" or "illegal
  // characters" is a construction or contract fault that repeats on every
  // window -- and because the executor treats it as terminal, each occurrence
  // abandons a window outright with no backoff to slow the burn. The genuinely
  // symbol-local rejection is a different kind entirely: UNSUPPORTED_SYMBOL.
  REQUEST_INVALID: "REQUEST_CONTRACT",
};

/**
 * Outcomes that PROVE the pipeline works end to end.
 *
 * Only these reset a streak, and the reason is narrower than "the exchange
 * answered". A rejection also proves connectivity, but it produces no data and
 * still spends a slot -- so treating one as health would let a run of
 * rejections, which is exactly the budget burn this breaker exists to stop,
 * read as the all-clear. Reset means "we are making progress", not "the socket
 * opened".
 *
 * SPLIT counts: the queue still has work, but the REQUEST succeeded.
 */
const EXCHANGE_HEALTHY_OUTCOMES: ReadonlySet<string> = new Set([
  "COMPLETE",
  "SPLIT",
  "INCOMPLETE_SKIPPED_ROWS",
  "SATURATED_SINGLE_MILLISECOND",
]);

/** Outcomes that say nothing about the exchange at all. */
const NEUTRAL_OUTCOMES: ReadonlySet<string> = new Set([
  // Decided before the transport was touched; already refunded by the driver.
  "NO_WORK",
  "PROFILE_UNAVAILABLE",
  // Our lease expired and a newer attempt owns the window. Contention.
  "STALE_CLAIM",
]);

/**
 * Reasons that neither count nor reset.
 *
 * The three Binance kinds here are well-formed business answers about ONE
 * symbol or ONE order, so they are not evidence of a systemic fault -- but they
 * are not evidence of progress either, so they must not clear a streak that a
 * transport fault is building. The three database reasons are local contention,
 * observed without any exchange involvement.
 */
const NEUTRAL_REASON_CODES: ReadonlySet<string> = new Set([
  "UNSUPPORTED_SYMBOL",
  "ORDER_NOT_FOUND",
  "ORDER_REJECTED",
  "FILL_LEDGER_INSERT_RACE",
  "FILL_LEDGER_RACE_UNRESOLVED",
  "FILL_INGEST_STALE_CLAIM",
]);

export type HistoricalFillOutcomeClassification =
  | { kind: "EXCHANGE_HEALTHY" }
  | { kind: "NEUTRAL" }
  | { kind: "SYSTEMIC"; family: HistoricalFillFailureFamily; threshold: number };

/**
 * What one durable dispatch outcome means for the circuit.
 *
 * Pure, exported, and the ONLY place this judgement is made -- the driver
 * passes the executor's outcome and reason through untouched rather than
 * forming an opinion of its own.
 *
 * An unrecognised reason code is NEUTRAL, deliberately. Guessing that an
 * unknown failure is systemic would let one unclassified code pause an
 * operator's campaign on no evidence; the conservative direction for a LATCH
 * is to require a reason we actually understand.
 */
export function classifyDispatchOutcome(
  outcome: string,
  reasonCode: string | null | undefined
): HistoricalFillOutcomeClassification {
  if (EXCHANGE_HEALTHY_OUTCOMES.has(outcome)) return { kind: "EXCHANGE_HEALTHY" };
  if (NEUTRAL_OUTCOMES.has(outcome)) return { kind: "NEUTRAL" };
  if (!reasonCode || NEUTRAL_REASON_CODES.has(reasonCode)) return { kind: "NEUTRAL" };

  const family = FAMILY_BY_REASON_CODE[reasonCode];
  if (!family) return { kind: "NEUTRAL" };
  return { kind: "SYSTEMIC", family, threshold: FAMILY_THRESHOLD[family] };
}

/** The breaker as an operator or a caller may see it. Never a message or a payload. */
export interface HistoricalFillCircuitSnapshot {
  state: HistoricalFillCircuitState;
  failureFamily: string | null;
  lastReasonCode: string | null;
  consecutiveCount: number;
  firstFailureAt: Date | null;
  lastFailureAt: Date | null;
  openedAt: Date | null;
}

/** A profile that has never failed: no row, and nothing stopped. */
const CLOSED_AND_CLEAN: HistoricalFillCircuitSnapshot = {
  state: "CLOSED",
  failureFamily: null,
  lastReasonCode: null,
  consecutiveCount: 0,
  firstFailureAt: null,
  lastFailureAt: null,
  openedAt: null,
};

export type HistoricalFillCircuitObservationResult =
  | "NO_CHANGE"
  | "STREAK_UPDATED"
  | "STREAK_RESET"
  | "CIRCUIT_OPENED"
  | "ALREADY_OPEN";

export interface HistoricalFillCircuitObservation {
  result: HistoricalFillCircuitObservationResult;
  /** The family/threshold this observation was judged against, when systemic. */
  observedFamily: HistoricalFillFailureFamily | null;
  threshold: number | null;
  /** The campaign this trip paused, when it paused one. */
  pausedCampaignId: string | null;
  circuit: HistoricalFillCircuitSnapshot;
}

export type HistoricalFillCircuitAcknowledgement =
  | { result: "ALREADY_CLOSED"; circuit: HistoricalFillCircuitSnapshot }
  | { result: "ACKNOWLEDGED"; circuit: HistoricalFillCircuitSnapshot };

/** Lineage or state this service cannot act on, surfaced rather than guessed at. */
export class HistoricalFillCircuitInvariantError extends Error {
  readonly reasonCode = "HISTORICAL_FILL_CIRCUIT_INVARIANT";
  constructor(detail: string) {
    super(`Historical fill circuit breaker invariant violated: ${detail}`);
    this.name = "HistoricalFillCircuitInvariantError";
  }
}

type BreakerRow = {
  state: HistoricalFillCircuitState;
  failureFamily: string | null;
  lastReasonCode: string | null;
  consecutiveCount: number;
  firstFailureAt: Date | null;
  lastFailureAt: Date | null;
  openedAt: Date | null;
};

const BREAKER_FIELDS = {
  state: true,
  failureFamily: true,
  lastReasonCode: true,
  consecutiveCount: true,
  firstFailureAt: true,
  lastFailureAt: true,
  openedAt: true,
} as const;

function snapshotOf(row: BreakerRow | null): HistoricalFillCircuitSnapshot {
  return row === null ? CLOSED_AND_CLEAN : { ...row };
}

export class HistoricalFillCircuitBreakerService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The breaker as it stands. Read-only, unlocked, and safe to call often.
   *
   * No row means CLOSED and never-failed, which is a complete answer rather
   * than missing data -- so the healthy path never has to write anything just
   * to be readable.
   */
  async readState(options: { executionProfileId: string }): Promise<HistoricalFillCircuitSnapshot> {
    const row = await this.prisma.historicalFillCircuitBreaker.findUnique({
      where: { executionProfileId: options.executionProfileId },
      select: BREAKER_FIELDS,
    });
    return snapshotOf(row);
  }

  /**
   * Records what one DURABLE dispatch outcome means for the circuit.
   *
   * ## Once OPEN, nothing here is rewritten
   *
   * Load-bearing. Requests admitted before the trip keep landing afterwards,
   * and if each one could overwrite `failureFamily`, `lastReasonCode` or the
   * timestamps, the snapshot an operator reads would describe whichever
   * straggler arrived last rather than the fault that actually stopped the
   * work. An OPEN circuit therefore answers ALREADY_OPEN and performs ZERO
   * writes -- `updatedAt` does not even move.
   *
   * ## A healthy result never closes it
   *
   * A latch is only useful if success cannot silently release it. One window
   * succeeding while credentials are broken proves nothing about the fault, and
   * auto-closing would simply resume burning the budget.
   */
  async observeDispatchOutcome(options: {
    executionProfileId: string;
    campaignId: string;
    outcome: string;
    reasonCode?: string | null;
    now?: Date;
  }): Promise<HistoricalFillCircuitObservation> {
    const classification = classifyDispatchOutcome(options.outcome, options.reasonCode);
    const now = options.now ?? new Date();

    // Unlocked fast path. Neither NEUTRAL nor an already-clean CLOSED breaker
    // can write anything, so taking the profile lock for them would serialize
    // the healthy path -- the common case -- for no effect at all. Anything
    // that COULD write re-reads under the lock below and decides there.
    const current = await this.readState(options);
    if (current.state === "OPEN") {
      return {
        result: "ALREADY_OPEN",
        observedFamily: classification.kind === "SYSTEMIC" ? classification.family : null,
        threshold: classification.kind === "SYSTEMIC" ? classification.threshold : null,
        pausedCampaignId: null,
        circuit: current,
      };
    }
    if (classification.kind === "NEUTRAL") {
      return {
        result: "NO_CHANGE",
        observedFamily: null,
        threshold: null,
        pausedCampaignId: null,
        circuit: current,
      };
    }
    if (classification.kind === "EXCHANGE_HEALTHY" && isAlreadyClean(current)) {
      return {
        result: "NO_CHANGE",
        observedFamily: null,
        threshold: null,
        pausedCampaignId: null,
        circuit: current,
      };
    }

    return this.prisma.$transaction(async (tx) => {
      // FIRST, and the same lock every campaign transition already takes, so a
      // trip cannot interleave with an admission, a pause, an abort or a
      // refund for this profile.
      await lockCampaignForProfile(tx, options.executionProfileId);

      // Lineage, checked before anything is written: a breaker must never be
      // opened for a profile on the strength of another profile's request.
      await this.assertCampaignBelongs(tx, options.campaignId, options.executionProfileId);

      const row = await tx.historicalFillCircuitBreaker.findUnique({
        where: { executionProfileId: options.executionProfileId },
        select: BREAKER_FIELDS,
      });
      const locked = snapshotOf(row);

      // Re-decided under the lock: the unlocked read above may be stale.
      if (locked.state === "OPEN") {
        return {
          result: "ALREADY_OPEN" as const,
          observedFamily: classification.kind === "SYSTEMIC" ? classification.family : null,
          threshold: classification.kind === "SYSTEMIC" ? classification.threshold : null,
          pausedCampaignId: null,
          circuit: locked,
        };
      }

      if (classification.kind === "EXCHANGE_HEALTHY") {
        return this.reset(tx, options.executionProfileId, locked);
      }
      return this.recordSystemic(
          tx,
          options.executionProfileId,
          classification,
          options.reasonCode as string,
          locked,
          now
        );
    });
  }

  /** Clears a streak that a healthy dispatch has disproven. CLOSED stays CLOSED. */
  private async reset(
    tx: Prisma.TransactionClient,
    executionProfileId: string,
    locked: HistoricalFillCircuitSnapshot
  ): Promise<HistoricalFillCircuitObservation> {
    if (isAlreadyClean(locked)) {
      return {
        result: "NO_CHANGE",
        observedFamily: null,
        threshold: null,
        pausedCampaignId: null,
        circuit: locked,
      };
    }
    const updated = await tx.historicalFillCircuitBreaker.update({
      where: { executionProfileId },
      data: {
        failureFamily: null,
        lastReasonCode: null,
        consecutiveCount: 0,
        firstFailureAt: null,
        lastFailureAt: null,
      },
      select: BREAKER_FIELDS,
    });
    return {
      result: "STREAK_RESET",
      observedFamily: null,
      threshold: null,
      pausedCampaignId: null,
      circuit: snapshotOf(updated),
    };
  }

  /**
   * Advances the streak, and closes the latch when its family's bound is hit.
   *
   * A family CHANGE restarts the count at 1, never 0: a systemic failure is
   * never evidence of health, and resetting to zero would let a fault that
   * alternates between families run forever.
   */
  private async recordSystemic(
    tx: Prisma.TransactionClient,
    executionProfileId: string,
    classification: Extract<HistoricalFillOutcomeClassification, { kind: "SYSTEMIC" }>,
    reasonCode: string,
    locked: HistoricalFillCircuitSnapshot,
    now: Date
  ): Promise<HistoricalFillCircuitObservation> {
    const sameFamily = locked.failureFamily === classification.family;
    const consecutiveCount = sameFamily ? locked.consecutiveCount + 1 : 1;
    const firstFailureAt = sameFamily ? (locked.firstFailureAt ?? now) : now;
    const opening = consecutiveCount >= classification.threshold;

    const streak = {
      failureFamily: classification.family,
      lastReasonCode: reasonCode,
      consecutiveCount,
      firstFailureAt,
      lastFailureAt: now,
    };

    const updated = await tx.historicalFillCircuitBreaker.upsert({
      where: { executionProfileId },
      // Stated explicitly on both paths -- there is no column default, because
      // a breaker that existed by accident would be a licence to dispatch.
      create: {
        executionProfileId,
        state: opening ? "OPEN" : "CLOSED",
        ...streak,
        openedAt: opening ? now : null,
      },
      update: {
        state: opening ? "OPEN" : "CLOSED",
        ...streak,
        ...(opening ? { openedAt: now } : {}),
      },
      select: BREAKER_FIELDS,
    });

    if (!opening) {
      return {
        result: "STREAK_UPDATED",
        observedFamily: classification.family,
        threshold: classification.threshold,
        pausedCampaignId: null,
        circuit: snapshotOf(updated),
      };
    }

    const pausedCampaignId = await this.pauseCurrentActiveCampaign(tx, executionProfileId);
    return {
      result: "CIRCUIT_OPENED",
      observedFamily: classification.family,
      threshold: classification.threshold,
      pausedCampaignId,
      circuit: snapshotOf(updated),
    };
  }

  /**
   * Pauses whichever campaign is ACTIVE for this profile RIGHT NOW.
   *
   * Deliberately not the campaign the triggering request belonged to. That
   * campaign may have become EXHAUSTED on its final slot and a REPLACEMENT may
   * already be ACTIVE by the time its response lands -- pausing the triggering
   * row would then leave the replacement running straight into the same fault.
   * Pausing the current ACTIVE row instead upholds the invariant the whole
   * design rests on:
   *
   *   OPEN commits  =>  the profile has ZERO ACTIVE campaigns.
   *
   * That invariant is also why acknowledgement can safely be its own command:
   * clearing the latch cannot expose runnable work, because there is none to
   * expose until an operator explicitly resumes or starts a campaign.
   *
   * Only `status` moves. Spend, ceiling, ending and the operator's note are
   * facts about the campaign that a systemic transport fault has no business
   * rewriting.
   */
  private async pauseCurrentActiveCampaign(
    tx: Prisma.TransactionClient,
    executionProfileId: string
  ): Promise<string | null> {
    const active = await tx.historicalFillCampaign.findFirst({
      where: { executionProfileId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!active) return null;

    const paused = await tx.historicalFillCampaign.updateMany({
      where: { id: active.id, status: "ACTIVE" },
      data: { status: "PAUSED" },
    });
    if (paused.count !== 1) {
      // Under this profile's own lock nothing else can move that row, so a miss
      // is corruption rather than contention.
      throw new HistoricalFillCircuitInvariantError(
        `campaign ${active.id} could not be paused while opening the circuit for profile ${executionProfileId}`
      );
    }
    return active.id;
  }

  /**
   * The ONLY thing that closes the latch, and it is always a person.
   *
   * Refuses while an ACTIVE campaign exists. That state should be unreachable
   * -- opening the circuit pauses the current ACTIVE campaign in the same
   * transaction -- so reaching it means something bypassed or corrupted that
   * invariant, and clearing the latch would instantly expose runnable work to
   * the very fault the operator has not finished investigating. Failing closed
   * costs a puzzled operator one error message; failing open costs a campaign.
   *
   * Touches the breaker row and nothing else: no campaign is started, resumed
   * or created, no window, reservation, Redis key or exchange is involved. A
   * second, explicit operator action is always required before work resumes.
   */
  async acknowledge(options: {
    executionProfileId: string;
    now?: Date;
  }): Promise<HistoricalFillCircuitAcknowledgement> {
    return this.prisma.$transaction(async (tx) => {
      await lockCampaignForProfile(tx, options.executionProfileId);

      const row = await tx.historicalFillCircuitBreaker.findUnique({
        where: { executionProfileId: options.executionProfileId },
        select: BREAKER_FIELDS,
      });
      const locked = snapshotOf(row);
      if (locked.state !== "OPEN") {
        return { result: "ALREADY_CLOSED" as const, circuit: locked };
      }

      const active = await tx.historicalFillCampaign.count({
        where: { executionProfileId: options.executionProfileId, status: "ACTIVE" },
      });
      if (active > 0) {
        throw new HistoricalFillCircuitInvariantError(
          `profile ${options.executionProfileId} has ${active} ACTIVE campaign(s) while its circuit is OPEN; ` +
            `refusing to clear the breaker until that is resolved`
        );
      }

      const cleared = await tx.historicalFillCircuitBreaker.update({
        where: { executionProfileId: options.executionProfileId },
        data: {
          state: "CLOSED",
          openedAt: null,
          failureFamily: null,
          lastReasonCode: null,
          consecutiveCount: 0,
          firstFailureAt: null,
          lastFailureAt: null,
        },
        select: BREAKER_FIELDS,
      });
      return { result: "ACKNOWLEDGED" as const, circuit: snapshotOf(cleared) };
    });
  }

  /** The triggering campaign is evidence lineage; it must belong to this profile. */
  private async assertCampaignBelongs(
    tx: Prisma.TransactionClient,
    campaignId: string,
    executionProfileId: string
  ): Promise<void> {
    const campaign = await tx.historicalFillCampaign.findUnique({
      where: { id: campaignId },
      select: { executionProfileId: true },
    });
    if (!campaign) {
      throw new HistoricalFillCircuitInvariantError(
        `campaign ${campaignId} does not exist, so its dispatch outcome has no lineage`
      );
    }
    if (campaign.executionProfileId !== executionProfileId) {
      throw new HistoricalFillCircuitInvariantError(
        `campaign ${campaignId} belongs to a different execution profile than ${executionProfileId}`
      );
    }
  }
}

/** A CLOSED breaker carrying no streak at all: nothing for a reset to clear. */
function isAlreadyClean(circuit: HistoricalFillCircuitSnapshot): boolean {
  return (
    circuit.state === "CLOSED" &&
    circuit.consecutiveCount === 0 &&
    circuit.failureFamily === null &&
    circuit.lastReasonCode === null &&
    circuit.firstFailureAt === null &&
    circuit.lastFailureAt === null
  );
}
