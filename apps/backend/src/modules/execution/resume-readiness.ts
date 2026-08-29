import { Prisma } from "@prisma/client";
import type { CanaryFinding, CanaryReadinessCode } from "./canary-readiness";
import { mergeCapacityLimits, policyReachabilityViolations } from "./safety-engine";

/**
 * Phase 13 — readiness for RESUMING a paused session, as a pure function.
 *
 * ## Why this is not `evaluateCanaryPreflight`
 *
 * Canary preflight answers "may a NEW session start here?", and part of that
 * answer is "the account is clean": no open position, no resting order, no
 * local execution. That is right for Start Trading, which mints a fresh
 * session and a fresh budget, and it is exactly wrong for Resume, which
 * continues a session that was admitting trades a moment ago and whose whole
 * purpose is to carry on managing what it already opened.
 *
 * Reusing preflight verbatim would refuse every resume that mattered — the
 * operator paused BECAUSE positions were live. Suppressing all its blockers
 * would be worse: it would resume into an unreachable exchange or a broken
 * runtime.
 *
 * So this module does neither. It takes the SAME gathered evidence preflight
 * produced and re-judges it under two narrow, explicit allowlists, blocking on
 * everything else. Both are hard-coded lists rather than category tests, so a
 * readiness code added later blocks Resume until someone decides otherwise —
 * the safe default for a control that opens live admission.
 *
 * ## Why this takes EVERY finding, not just the preparation-scoped ones
 *
 * The kill switch is the sharp edge here. Pausing engages it, so
 * `CANARY_BLOCKED_KILL_SWITCH_STATE` is the NORMAL, expected posture of a
 * paused profile — and resuming is precisely the act that releases it. A
 * resume that treated it as an unsafe blocker would refuse to undo the state
 * it created, and no operator could ever get out.
 *
 * That finding happens to be scoped LIVE_ACTIVATION rather than PREPARATION,
 * so passing only `preparationBlockers` would sidestep the problem by
 * accident. Relying on that would be brittle in the worst way: a caller that
 * later passed `findings` instead — the obvious, more thorough-looking
 * choice — would deadlock Resume permanently, and nothing would explain why.
 *
 * So this function accepts ALL findings and names the live-activation ones it
 * knowingly leaves to a dedicated check. The decision lives in one place, and
 * passing more evidence can never make Resume less correct.
 *
 * ## What Resume adds that Start does not need
 *
 * Start begins with nothing on the book, so "does current exposure fit the
 * policy?" is trivially yes. Resume does not: the policy may have been
 * narrowed while the session was paused, or the session may have been paused
 * precisely because exposure grew. So exposure is compared against the
 * EFFECTIVE limits — the same `mergeCapacityLimits` output admission uses —
 * before admission is reopened.
 */

const D = Prisma.Decimal;

/**
 * Findings that describe a NON-EMPTY account rather than an unsafe one.
 *
 * Each is here because it is a precondition of STARTING, not of trading:
 *
 *  - EXISTING_POSITIONS / EXISTING_ORDERS: the account holds positions or
 *    resting orders. For a resume, that is the normal and expected state — the
 *    session opened them.
 *  - LOCAL_EXECUTION: this profile has active or pending executions. Same
 *    reason, and the counts are judged against the policy below instead.
 *
 * Deliberately NOT tolerated, though it is also about existing work:
 * CANARY_BLOCKED_RECOVERY_REQUIRED. An execution needing manual intervention
 * or reconciliation is not healthy existing work, and resuming admission on
 * top of one is how a small problem becomes several.
 */
export const RESUME_TOLERATED_READINESS_CODES: readonly CanaryReadinessCode[] = [
  "CANARY_BLOCKED_EXISTING_POSITIONS",
  "CANARY_BLOCKED_EXISTING_ORDERS",
  "CANARY_BLOCKED_LOCAL_EXECUTION",
];

/**
 * Findings the RESUME ACTION judges itself, with a stronger check than a
 * preflight snapshot, so re-judging them here would be duplication at best and
 * a deadlock at worst.
 *
 * Each entry is a promise about the caller, and each is asserted by a test:
 *
 *  - KILL_SWITCH_STATE: the expected posture of a PAUSED profile, and exactly
 *    what this resume is about to release. `armNaturalWindow` performs that
 *    release as a compare-and-set under the profile advisory lock, re-reading
 *    the window version, the policy version and the allowlist — a far stronger
 *    guarantee than "the switch was engaged when preflight looked".
 *  - GATE_STATE: the action calls `environmentArmed()` directly and refuses.
 *    Environment gates are not database state; nothing can move them but a
 *    `.env` edit and a restart.
 *  - RUNTIME_ATTESTATION: the action calls `readAttestation()` directly and
 *    refuses. This is the whole reason the operator paused, so it is checked
 *    against the live heartbeat rather than a gathered snapshot.
 *  - AUTHORIZATION: the action looks up the window belonging to THIS session
 *    by id and refuses if it is missing, revoked or expired. Preflight's
 *    generic "is there a usable window" cannot express "for this session".
 *
 * Anything NOT named here blocks, whatever its scope. A live-activation code
 * added in future is therefore fail-closed for Resume until someone decides
 * otherwise, which is the direction a mistake should point.
 */
export const RESUME_SEPARATELY_CHECKED_CODES: readonly CanaryReadinessCode[] = [
  "CANARY_BLOCKED_KILL_SWITCH_STATE",
  "CANARY_BLOCKED_GATE_STATE",
  "CANARY_BLOCKED_RUNTIME_ATTESTATION",
  "CANARY_BLOCKED_AUTHORIZATION",
];

/** Why a resume was refused. Distinct from the canary codes on purpose. */
export const RESUME_BLOCKER_CODES = [
  /** A readiness finding that a resume does not get to ignore. */
  "RESUME_BLOCKED_READINESS",
  /** Current exposure does not fit the policy admission would apply. */
  "RESUME_BLOCKED_EXPOSURE",
  /** The effective policy itself is not one anything may trade under. */
  "RESUME_BLOCKED_POLICY",
] as const;
export type ResumeBlockerCode = (typeof RESUME_BLOCKER_CODES)[number];

/** The limits both sides of the merge supply. */
export interface ResumeCapacityLimits {
  maxOpenPositions: number;
  maxPendingEntries: number;
  maxTotalActiveTrades: number;
  maxActivePerSymbolSide: number;
  softOpenPositionTarget: number;
  maxTotalPlannedRiskUsd: string;
  maxTotalIsolatedMarginUsd: string;
}

/** What this profile is currently carrying, counted from TradeExecution rows. */
export interface ResumeExposure {
  openPositionCount: number;
  pendingEntryCount: number;
  totalActiveCount: number;
  reservedRiskUsd: string;
  reservedMaximumMarginUsd: string;
}

export interface ResumeReadinessInput {
  /**
   * Every finding the canary preflight produced, BOTH scopes.
   *
   * Pass them all. The allowlists above decide what is tolerated; handing this
   * function a pre-filtered subset only hides evidence from it.
   */
  findings: readonly CanaryFinding[];
  /** Env-wide ceilings. */
  globalLimits: ResumeCapacityLimits;
  /** The profile's stored policy row, or null when it could not be read. */
  profileLimits: ResumeCapacityLimits | null;
  exposure: ResumeExposure;
}

export interface ResumeReadinessResult {
  ready: boolean;
  /** Ready-to-display strings, one per refusal. Empty when ready. */
  blockers: string[];
  /** The limits admission will apply, or null when they could not be proven. */
  effectiveLimits: ResumeCapacityLimits | null;
}

function withAlertAge(limits: ResumeCapacityLimits) {
  // `maxAlertAgeSeconds` is min-merged by the shared function but is not a
  // capacity limit, so it is filled neutrally and never read back.
  return { ...limits, maxAlertAgeSeconds: Number.MAX_SAFE_INTEGER };
}

/** Decimal-exact `left <= right`; an unparseable value fails closed. */
function atMost(left: string, right: string): boolean {
  try {
    return new D(left).lessThanOrEqualTo(new D(right));
  } catch {
    return false;
  }
}

/**
 * May admission be reopened for a paused session?
 *
 * Pure: no clock, no database, no network. Everything it judges is passed in,
 * so the decision is reproducible and the caller owns the gathering.
 */
export function evaluateResumeReadiness(input: ResumeReadinessInput): ResumeReadinessResult {
  const blockers: string[] = [];

  for (const finding of input.findings) {
    // Expected on a non-empty account, which is the normal state for a resume.
    if (RESUME_TOLERATED_READINESS_CODES.includes(finding.code)) continue;
    // Judged by the action itself, with a stronger check than this snapshot.
    if (RESUME_SEPARATELY_CHECKED_CODES.includes(finding.code)) continue;
    blockers.push(`RESUME_BLOCKED_READINESS: ${finding.code}: ${finding.detail}`);
  }

  if (input.profileLimits === null) {
    blockers.push(
      "RESUME_BLOCKED_POLICY: the profile's safety-policy row could not be read, " +
        "so the limits admission would apply cannot be proven."
    );
    return { ready: false, blockers, effectiveLimits: null };
  }

  const merged = mergeCapacityLimits(
    withAlertAge(input.globalLimits),
    withAlertAge(input.profileLimits)
  );
  const effectiveLimits: ResumeCapacityLimits = {
    maxOpenPositions: merged.maxOpenPositions,
    maxPendingEntries: merged.maxPendingEntries,
    maxTotalActiveTrades: merged.maxTotalActiveTrades,
    maxActivePerSymbolSide: merged.maxActivePerSymbolSide,
    softOpenPositionTarget: merged.softOpenPositionTarget,
    maxTotalPlannedRiskUsd: merged.maxTotalPlannedRiskUsd,
    maxTotalIsolatedMarginUsd: merged.maxTotalIsolatedMarginUsd,
  };

  // The same reachability rules the policy writer and canary readiness use.
  for (const violation of policyReachabilityViolations(effectiveLimits)) {
    blockers.push(`RESUME_BLOCKED_POLICY: ${violation}`);
  }

  // --- Exposure against the limits admission will actually apply -----------
  //
  // Compared with `>`, not `>=`. Being exactly AT a limit is a full account,
  // not a broken one: admission itself refuses the next trade and says so,
  // which is the ordinary, well-tested path. Refusing to resume at that point
  // would strand an operator whose session is simply busy.
  const { exposure } = input;
  const over = (label: string, actual: number, limit: number) => {
    if (actual > limit) {
      blockers.push(
        `RESUME_BLOCKED_EXPOSURE: ${label} is ${actual}, above the effective limit of ${limit}. ` +
          "Resuming would admit under limits the current exposure already exceeds."
      );
    }
  };
  over("open positions", exposure.openPositionCount, effectiveLimits.maxOpenPositions);
  over("pending entries", exposure.pendingEntryCount, effectiveLimits.maxPendingEntries);
  over("total active trades", exposure.totalActiveCount, effectiveLimits.maxTotalActiveTrades);

  if (!atMost(exposure.reservedRiskUsd, effectiveLimits.maxTotalPlannedRiskUsd)) {
    blockers.push(
      `RESUME_BLOCKED_EXPOSURE: reserved planned risk is ${exposure.reservedRiskUsd}, ` +
        `above the effective ceiling of ${effectiveLimits.maxTotalPlannedRiskUsd}.`
    );
  }
  if (!atMost(exposure.reservedMaximumMarginUsd, effectiveLimits.maxTotalIsolatedMarginUsd)) {
    blockers.push(
      `RESUME_BLOCKED_EXPOSURE: reserved isolated margin is ${exposure.reservedMaximumMarginUsd}, ` +
        `above the effective ceiling of ${effectiveLimits.maxTotalIsolatedMarginUsd}.`
    );
  }

  return { ready: blockers.length === 0, blockers, effectiveLimits };
}
