import type { HistoricalFillOperationalSnapshot } from "./historical-fill-operational-snapshot.service";

/**
 * The ONLY place historical-fill facts become an operational judgement.
 *
 * Slices 1 to 3 deliberately reported counts and said nothing about them. This
 * module is the one authority that decides whether any of those counts is worth
 * an operator's time, and it is pure: the same snapshot always yields the same
 * answer, no clock is read, no query is issued and nothing is written.
 *
 * ## Deliberately small
 *
 * Five triggers, each a plain `> 0`. No weighting, no score, no ranking and no
 * severity ladder -- the state is either NORMAL, NEEDS_ATTENTION or UNAVAILABLE
 * and nothing in between. A richer taxonomy would be easy to write and
 * impossible to defend, because nothing has yet established what "worse" means
 * for a fill queue.
 *
 * ## No clock, no SLA
 *
 * `oldestPendingCreatedAt`, `oldestClaimableCreatedAt`, `nextBackoffEligibleAt`
 * and `capturedAt` are read by NOTHING here, and neither is any queue size. An
 * age threshold would be an operational promise this system has not made: five
 * minutes is not yet known to be better or worse than five hours, and inventing
 * the number would make this file the author of a policy nobody agreed.
 *
 * ## Scope
 *
 * This describes HISTORICAL FILL INGESTION and nothing else. It is not a
 * statement about trading safety, exchange connectivity, protection readiness
 * or an account.
 */

export const HISTORICAL_FILL_OPERATIONAL_STATES = [
  "NORMAL",
  "NEEDS_ATTENTION",
  "UNAVAILABLE",
] as const;

export type HistoricalFillOperationalState = (typeof HISTORICAL_FILL_OPERATIONAL_STATES)[number];

/**
 * The conditions worth surfacing, in the order they are always reported.
 *
 * Order is structural rather than incidental: the list below IS the order, so
 * two snapshots carrying the same conditions produce byte-identical issue
 * arrays and an operator comparing two readings compares like with like.
 */
export const HISTORICAL_FILL_ISSUE_CODES = [
  "STALE_LEASES_PRESENT",
  "ATTEMPT_EXHAUSTED_PRESENT",
  "ABANDONED_WINDOWS_PRESENT",
  "INCOMPLETE_SKIPPED_ROWS_PRESENT",
  "SATURATED_SINGLE_MILLISECOND_PRESENT",
] as const;

export type HistoricalFillIssueCode = (typeof HISTORICAL_FILL_ISSUE_CODES)[number];

export interface HistoricalFillOperationalIssue {
  code: HistoricalFillIssueCode;
  /** The count exactly as the snapshot reported it. Never rounded or capped. */
  count: number;
}

export interface HistoricalFillOperationalInterpretation {
  state: HistoricalFillOperationalState;
  issues: HistoricalFillOperationalIssue[];
}

type ReadySnapshot = Extract<HistoricalFillOperationalSnapshot, { outcome: "READY" }>;

/**
 * Every trigger, and nothing else.
 *
 * What is NOT here matters as much as what is. Pending work, claimable work, a
 * live lease, a backoff, a split and an unattributed fill are all ordinary
 * states of a working system -- a queue with work in it is a queue doing its
 * job, and treating that as a condition would train an operator to ignore this
 * panel. Only evidence that something has stopped progressing, or finished
 * without proving itself, appears below.
 */
const TRIGGERS: ReadonlyArray<{
  code: HistoricalFillIssueCode;
  countOf: (snapshot: ReadySnapshot) => number;
}> = [
  { code: "STALE_LEASES_PRESENT", countOf: (s) => s.pending.staleLease },
  { code: "ATTEMPT_EXHAUSTED_PRESENT", countOf: (s) => s.pending.attemptExhausted },
  { code: "ABANDONED_WINDOWS_PRESENT", countOf: (s) => s.windows.byStatus.ABANDONED },
  {
    code: "INCOMPLETE_SKIPPED_ROWS_PRESENT",
    countOf: (s) => s.windows.byStatus.INCOMPLETE_SKIPPED_ROWS,
  },
  {
    code: "SATURATED_SINGLE_MILLISECOND_PRESENT",
    countOf: (s) => s.windows.byStatus.SATURATED_SINGLE_MILLISECOND,
  },
];

/**
 * Reads a snapshot and says whether any of it needs a human.
 *
 * `PROFILE_UNAVAILABLE` is UNAVAILABLE, not NEEDS_ATTENTION: the workset could
 * not be evaluated at all, so there is nothing to have an opinion about, and
 * reporting a condition would claim knowledge this snapshot does not have.
 */
export function interpretHistoricalFillOperationalSnapshot(
  snapshot: HistoricalFillOperationalSnapshot
): HistoricalFillOperationalInterpretation {
  if (snapshot.outcome === "PROFILE_UNAVAILABLE") {
    return { state: "UNAVAILABLE", issues: [] };
  }

  const issues = TRIGGERS.flatMap(({ code, countOf }) => {
    const count = countOf(snapshot);
    return count > 0 ? [{ code, count }] : [];
  });

  return { state: issues.length === 0 ? "NORMAL" : "NEEDS_ATTENTION", issues };
}
