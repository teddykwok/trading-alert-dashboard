import type { MutationOutcome } from "./entry-lifecycle";

/**
 * The absence proof for a stuck ENTRY_SUBMITTING execution.
 *
 * ## Why this is a separate, pure module
 *
 * Releasing a reservation is the one irreversible-feeling act in recovery: it
 * tells the rest of the system "this execution can never have exposure". If
 * that is wrong, the account carries a position nothing is protecting. So the
 * decision is expressed as data — a set of independently-gathered facts and a
 * total function over them — rather than as control flow threaded through a
 * service that also talks to an exchange.
 *
 * ## The rule
 *
 * Release requires EVERY required fact to be present AND to say "nothing
 * exists". There is no scoring, no majority, no "probably". A fact that could
 * not be gathered is not a neutral absence — it is a blocker, because the
 * question it would have answered is exactly the one that could be hiding an
 * order.
 *
 * Elapsed time is deliberately absent from this file. "It has been stuck for an
 * hour" is not evidence about an exchange, and a rule of that shape is how a
 * real order eventually gets abandoned.
 */

/** How one gathered fact turned out. Only `OK` can ever contribute to a release. */
export type EvidenceStatus = "OK" | "UNAVAILABLE";

export interface EvidenceFact<T> {
  status: EvidenceStatus;
  value: T | null;
  /** Sanitized, operator-readable reason the fact could not be gathered. */
  detail: string | null;
}

export function gathered<T>(value: T): EvidenceFact<T> {
  return { status: "OK", value, detail: null };
}

export function unavailable<T>(detail: string): EvidenceFact<T> {
  return { status: "UNAVAILABLE", value: null, detail };
}

/**
 * Everything the proof needs, each gathered independently so a single failure
 * cannot masquerade as a clean answer for the others.
 */
export interface EntryAbsenceEvidence {
  /** Outcome of the exact-clientOrderId Query Order call. */
  exactQuery: EvidenceFact<MutationOutcome>;
  /** True when the symbol's order history contains this clientOrderId. */
  historyContainsOrder: EvidenceFact<boolean>;
  /** True when any fill exists that could belong to this entry. */
  fillsExist: EvidenceFact<boolean>;
  /** Absolute position amount for the exact symbol + positionSide. */
  positionAmount: EvidenceFact<string>;
  /** True when an open order for this symbol matches the entry identity. */
  openOrderExists: EvidenceFact<boolean>;
  /** True when any open conditional/algo order exists for the symbol. */
  algoOrderExists: EvidenceFact<boolean>;
  /** Local executed quantity recorded against the entry order. */
  localExecutedQuantity: EvidenceFact<string>;
  /** True when a protection state row exists for the execution. */
  protectionStateExists: EvidenceFact<boolean>;
}

export type AbsenceVerdict =
  | { proven: true; checks: string[] }
  | { proven: false; reasonCode: AbsenceBlockedReason; blockers: string[]; checks: string[] };

export const ABSENCE_BLOCKED_REASONS = [
  /** At least one required fact could not be gathered. */
  "EVIDENCE_INCOMPLETE",
  /** Every fact was gathered and at least one proves the entry may exist. */
  "EXPOSURE_EVIDENCE_PRESENT",
] as const;

export type AbsenceBlockedReason = (typeof ABSENCE_BLOCKED_REASONS)[number];

/**
 * "0", "0.000" and "-0" mean flat; anything else — including an EMPTY or
 * blank string — does not.
 *
 * The blank case is the trap: Number of an empty string is 0, so a missing
 * quantity would otherwise read as proof the account is flat. A value that was
 * never supplied proves nothing, so it must fail the check rather than pass it.
 */
function isZeroQuantity(raw: string | null): boolean {
  if (raw === null) return false;
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed === 0;
}

/**
 * The total function over the gathered facts.
 *
 * Reads as a checklist on purpose: every line is one thing that must be true,
 * and the failure list names exactly which ones were not — so an operator
 * reading a refusal learns what to look at rather than that "recovery said no".
 */
export function judgeEntryAbsence(evidence: EntryAbsenceEvidence): AbsenceVerdict {
  const checks: string[] = [];
  const missing: string[] = [];
  const contradicting: string[] = [];

  const require = <T>(name: string, fact: EvidenceFact<T>, proves: (value: T) => boolean, contradiction: string) => {
    if (fact.status !== "OK" || fact.value === null) {
      missing.push(`${name}: ${fact.detail ?? "not gathered"}`);
      return;
    }
    if (!proves(fact.value)) {
      contradicting.push(contradiction);
      return;
    }
    checks.push(name);
  };

  // 1. Binance must positively state the order does not exist. A retryable or
  //    unknown query outcome is not a "no" — it is a missing answer.
  require(
    "exactQueryNotFound",
    evidence.exactQuery,
    (outcome) => outcome === "NOT_FOUND_CONFIRMED",
    "the exact client order id query did not confirm absence"
  );

  // 2. History must not know the id either. This is what separates "not found
  //    now" from "existed and aged out of the lookup window".
  require("historyHasNoOrder", evidence.historyContainsOrder, (found) => found === false, "order history contains this client order id");

  // 3/7. No fill may exist, locally or on the exchange.
  require("noExchangeFills", evidence.fillsExist, (found) => found === false, "exchange trade history shows a fill");
  require(
    "noLocalFill",
    evidence.localExecutedQuantity,
    (quantity) => isZeroQuantity(quantity),
    "the local entry order records a non-zero executed quantity"
  );

  // 4. Flat, for this exact symbol AND position side.
  require("positionFlat", evidence.positionAmount, (amount) => isZeroQuantity(amount), "a position exists for this symbol and side");

  // 5/6. Nothing resting and nothing conditional.
  require("noOpenOrder", evidence.openOrderExists, (found) => found === false, "an open order matches this entry");
  require("noAlgoOrder", evidence.algoOrderExists, (found) => found === false, "an open conditional/algo order exists");

  // 8. Protection implies exposure was believed real at some point.
  require("noProtectionState", evidence.protectionStateExists, (found) => found === false, "a protection state row exists");

  // Ordering matters: an ungatherable fact outranks a contradicting one,
  // because "we could not look" is a weaker position than "we looked and found
  // something", and the operator's next action differs.
  if (missing.length > 0) {
    return { proven: false, reasonCode: "EVIDENCE_INCOMPLETE", blockers: missing, checks };
  }
  if (contradicting.length > 0) {
    return { proven: false, reasonCode: "EXPOSURE_EVIDENCE_PRESENT", blockers: contradicting, checks };
  }
  return { proven: true, checks };
}

/** A short, log-safe summary. Counts and check names only — never a payload. */
export function summarizeAbsence(verdict: AbsenceVerdict): string {
  return verdict.proven
    ? `absence PROVEN (${verdict.checks.length} checks passed)`
    : `absence NOT proven: ${verdict.reasonCode} (${verdict.blockers.length} blocker(s), ${verdict.checks.length} passed)`;
}
