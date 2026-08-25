import type { ProtectionReasonCode } from "./protection-lifecycle";

/**
 * The evidence that a stranded protection intervention is safe to retry.
 *
 * ## Why this is a separate, pure module
 *
 * Re-entering the protection lifecycle for a parked position is a deliberate,
 * money-adjacent act: it can put a live STOP on the exchange. The decision is
 * therefore expressed as data — independently gathered facts and a total
 * function over them — rather than as control flow threaded through a service
 * that also talks to Binance.
 *
 * ## The rule
 *
 * Recovery requires EVERY required fact to be present AND to say "this is the
 * situation we think it is". A fact that could not be gathered is not neutral:
 * it is a refusal, because the question it would have answered is exactly the
 * one that could be hiding an existing stop, a different position, or an
 * in-flight submission we would duplicate.
 *
 * There is no scoring and no "probably". Elapsed time is deliberately absent:
 * how long an execution has been parked says nothing about whether protecting
 * it now is safe.
 */

/** How one gathered fact turned out. Only `OK` can contribute to a decision. */
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

/** The intervention reason this recovery path exists for, and only this one. */
export const RECOVERABLE_PROTECTION_REASON: ProtectionReasonCode = "TAKE_PROFIT_TRIGGER_INVALID";

export interface ProtectionRecoveryEvidence {
  /** Execution status; must be the parked one. */
  executionStatus: EvidenceFact<string>;
  /** The execution's own manual-intervention flag. */
  requiresManualIntervention: EvidenceFact<boolean>;
  /** The protection row's state; only this service's escalate() writes it. */
  protectionState: EvidenceFact<string>;
  /** The reason parked on the protection row. */
  protectionReasonCode: EvidenceFact<string>;
  /** True when the connector environment matches the execution's profile. */
  environmentMatches: EvidenceFact<boolean>;
  /** Absolute open quantity for the exact symbol + positionSide. */
  positionQuantity: EvidenceFact<string>;
  /** The execution's own recorded filled quantity. */
  recordedFillQuantity: EvidenceFact<string>;
  /** Quantity currently proven covered by an ACTIVE stop. */
  activeStopQuantity: EvidenceFact<string>;
  /** Quantity currently proven covered by an ACTIVE take profit. */
  activeTakeProfitQuantity: EvidenceFact<string>;
  /** True when any protection order is in an ambiguous, in-flight state. */
  ambiguousProtectionSubmission: EvidenceFact<boolean>;
  /** The frozen executable stop trigger. */
  frozenStopTrigger: EvidenceFact<string>;
  /** True when that stop is placeable against the current working price. */
  stopTriggerPlaceable: EvidenceFact<boolean>;
}

export const PROTECTION_RECOVERY_BLOCKED_REASONS = [
  /** At least one required fact could not be gathered. */
  "EVIDENCE_INCOMPLETE",
  /** Every fact was gathered and at least one says this must not proceed. */
  "RECOVERY_PRECONDITION_FAILED",
] as const;

export type ProtectionRecoveryBlockedReason = (typeof PROTECTION_RECOVERY_BLOCKED_REASONS)[number];

export type ProtectionRecoveryVerdict =
  | { safe: true; checks: string[]; alreadyStopped: boolean }
  | {
      safe: false;
      reasonCode: ProtectionRecoveryBlockedReason;
      blockers: string[];
      checks: string[];
      alreadyStopped: boolean;
    };

/** "0", "0.000" and "-0" are zero; a blank string is NOT — it is unknown. */
function isZeroQuantity(raw: string | null): boolean {
  if (raw === null) return false;
  const trimmed = raw.trim();
  // Number("") is 0, so a missing quantity would otherwise read as flat.
  if (trimmed === "") return false;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed === 0;
}

function isPositiveQuantity(raw: string | null): boolean {
  if (raw === null) return false;
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0;
}

/** Exact decimal-string equality, tolerant of trailing-zero formatting. */
function sameQuantity(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const left = Number(a.trim());
  const right = Number(b.trim());
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return left === right;
}

/**
 * The total function over the gathered facts.
 *
 * Reads as a checklist on purpose: every line is one thing that must hold, and
 * the blocker list names exactly which ones did not — so an operator reading a
 * refusal learns what to look at rather than that "recovery said no".
 */
export function judgeProtectionRecovery(evidence: ProtectionRecoveryEvidence): ProtectionRecoveryVerdict {
  const checks: string[] = [];
  const missing: string[] = [];
  const failing: string[] = [];

  const require = <T>(name: string, fact: EvidenceFact<T>, holds: (value: T) => boolean, failure: string) => {
    if (fact.status !== "OK" || fact.value === null) {
      missing.push(`${name}: ${fact.detail ?? "not gathered"}`);
      return;
    }
    if (!holds(fact.value)) {
      failing.push(failure);
      return;
    }
    checks.push(name);
  };

  // 1-4. This must be the exact situation the path exists for. Recovering some
  //      other intervention would apply a rule nobody reviewed to it.
  require("statusIsManualIntervention", evidence.executionStatus, (s) => s === "MANUAL_INTERVENTION", "the execution is not in MANUAL_INTERVENTION");
  require("requiresManualIntervention", evidence.requiresManualIntervention, (v) => v === true, "the execution does not require manual intervention");
  require(
    "protectionRowIsParked",
    evidence.protectionState,
    (s) => s === "MANUAL_INTERVENTION",
    "the intervention did not come from the protection lifecycle"
  );
  require(
    "reasonIsTakeProfitTriggerInvalid",
    evidence.protectionReasonCode,
    (code) => code === RECOVERABLE_PROTECTION_REASON,
    `the intervention reason is not ${RECOVERABLE_PROTECTION_REASON}`
  );

  // 5. The account this would act on must be the one the execution belongs to.
  require("environmentMatches", evidence.environmentMatches, (v) => v === true, "the connector environment does not match the execution's profile");

  // 6-7. Real, open, and the size we think it is. A mismatch is a contradiction
  //      rather than a gap, and protecting the wrong quantity is its own hazard.
  require("positionIsOpen", evidence.positionQuantity, (q) => isPositiveQuantity(q), "no open position exists for this symbol and side");
  require(
    "positionMatchesRecordedFill",
    evidence.recordedFillQuantity,
    (recorded) => sameQuantity(recorded, evidence.positionQuantity.value),
    "the open position quantity does not match the execution's recorded fill"
  );

  // 8-9. Every protection leg must be READABLE. Unreadable is not "absent".
  require("stopCoverageKnown", evidence.activeStopQuantity, () => true, "stop coverage could not be established");
  require("takeProfitCoverageKnown", evidence.activeTakeProfitQuantity, () => true, "take-profit coverage could not be established");

  // 10. Nothing may be in flight. Re-entering on top of an unresolved
  //     submission is how a second stop gets created.
  require(
    "noAmbiguousSubmission",
    evidence.ambiguousProtectionSubmission,
    (v) => v === false,
    "a protection order is in an ambiguous or in-flight state"
  );

  // 11-12. There must be a stop worth placing, and it must be placeable now.
  require("frozenStopExists", evidence.frozenStopTrigger, (v) => isPositiveQuantity(v), "the execution has no usable frozen stop trigger");
  require(
    "stopTriggerPlaceable",
    evidence.stopTriggerPlaceable,
    (v) => v === true,
    "the frozen stop trigger is not valid against the current working price"
  );

  // Reported alongside the verdict rather than gating it: a position that is
  // ALREADY fully stopped is still safe to re-admit — the lifecycle reconciles
  // and places nothing — and refusing would leave it parked for no reason.
  const alreadyStopped =
    evidence.activeStopQuantity.status === "OK" &&
    evidence.positionQuantity.status === "OK" &&
    !isZeroQuantity(evidence.activeStopQuantity.value) &&
    sameQuantity(evidence.activeStopQuantity.value, evidence.positionQuantity.value);

  // Ordering matters: an ungatherable fact outranks a failing one, because "we
  // could not look" is a weaker position than "we looked and it does not hold",
  // and the operator's next action differs.
  if (missing.length > 0) {
    return { safe: false, reasonCode: "EVIDENCE_INCOMPLETE", blockers: missing, checks, alreadyStopped };
  }
  if (failing.length > 0) {
    return { safe: false, reasonCode: "RECOVERY_PRECONDITION_FAILED", blockers: failing, checks, alreadyStopped };
  }
  return { safe: true, checks, alreadyStopped };
}

/** A short, log-safe summary. Counts and check names only — never a payload. */
export function summarizeProtectionRecovery(verdict: ProtectionRecoveryVerdict): string {
  return verdict.safe
    ? `recovery SAFE (${verdict.checks.length} checks passed${verdict.alreadyStopped ? ", stop already active" : ""})`
    : `recovery NOT safe: ${verdict.reasonCode} (${verdict.blockers.length} blocker(s), ${verdict.checks.length} passed)`;
}
