import { Prisma } from "@prisma/client";
import type { ExecutionCanaryAuthorization, ExecutionSafetyPolicy } from "@prisma/client";

import { CANARY_PREPARE_LOCK_NAMESPACE, MINIMUM_REMAINING_LIFETIME_MS } from "./canary-authorization.service";
import { CANARY_NATURAL_MAX_CLAIMS, CANARY_PINNED_LIMITS, CANARY_POLICY } from "./canary-readiness";
import { naturalWindowState, normalizeNaturalDirections } from "./natural-authorization";
import { profileLockKey } from "./profile-lock";

/**
 * Phase 12.4C — the authoritative half of natural activation.
 *
 * `execution:arm-natural-window` is the only command that opens a MAINNET
 * profile for natural admission, so everything here is written to fail closed.
 * Three rules shape the whole file:
 *
 *  1. A dry run proves nothing about a later write. Every value the decision
 *     rests on is RE-READ inside the mutating transaction; nothing captured by
 *     the CLI is trusted.
 *  2. Arming is not admission. This module never touches claimedCount, never
 *     calls claimNaturalWindow, and never writes to the authorization row at
 *     all — the window is a precondition to READ, not a resource to spend.
 *  3. The window must still be the same window. The operator names it by id,
 *     and its version must match the one the readiness evaluation was built on,
 *     so a budget edited underneath us refuses instead of arming stale state.
 *
 * The advisory lock is the CANARY PREPARE namespace, deliberately: prepare and
 * revoke already serialize on it, so an arm can never interleave with the
 * creation or revocation of the very window it is validating.
 */

/** Reused, never reinvented — the same floor `arm-canary` applies to exact windows. */
export const NATURAL_ARM_MINIMUM_REMAINING_MS = MINIMUM_REMAINING_LIFETIME_MS;

export type NaturalArmReasonCode =
  | "WINDOW_NOT_FOUND"
  | "WINDOW_WRONG_PROFILE"
  | "WINDOW_NOT_NATURAL"
  | "WINDOW_REVOKED"
  | "WINDOW_EXPIRED"
  | "WINDOW_EXHAUSTED"
  | "WINDOW_INVALID"
  | "WINDOW_TTL_TOO_LOW"
  | "WINDOW_DIRECTIONS_INVALID"
  | "WINDOW_MAX_CLAIMS_MISMATCH"
  | "WINDOW_VERSION_CHANGED"
  | "POLICY_MISSING"
  | "POLICY_VERSION_CHANGED"
  | "POLICY_ENVELOPE_MISMATCH"
  | "ALLOWED_SYMBOLS_CHANGED"
  | "ARM_NOT_VERIFIED";

export interface NaturalArmInput {
  executionProfileId: string;
  /** The window the operator named explicitly. There is no fuzzy selection. */
  authorizationId: string;
  /** The window version the readiness evaluation was built on. */
  expectedWindowVersion: number;
  /** The policy version the readiness evaluation was built on. */
  expectedPolicyVersion: number;
  /** Observed, never mutated — a changed allowlist invalidates the review. */
  expectedAllowedSymbols: readonly string[];
  now?: Date;
}

export interface NaturalArmSnapshot {
  authorizationId: string;
  windowVersion: number;
  maxClaims: number;
  claimedCount: number;
  allowedDirections: readonly string[];
  expiresAt: Date;
  policyVersion: number;
  allowedSymbols: readonly string[];
  profileIsEnabled: boolean;
  killSwitchActive: boolean;
}

export type NaturalArmResult =
  | { ok: true; alreadyArmed: boolean; snapshot: NaturalArmSnapshot }
  | { ok: false; reasonCode: NaturalArmReasonCode; message: string };

function refuse(reasonCode: NaturalArmReasonCode, message: string): NaturalArmResult {
  return { ok: false, reasonCode, message };
}

/**
 * Judges a natural window for ARMING — a stricter question than "may this
 * window admit a trade".
 *
 * Runtime admission asks only whether the window is open right now. An operator
 * arming a supervised canary is also promising to watch it, so a window with
 * seconds left is refused here while remaining perfectly valid to SafetyAdmission.
 * This deliberately does NOT change runtime expiry semantics.
 */
export function evaluateNaturalWindowForArm(
  window: ExecutionCanaryAuthorization,
  executionProfileId: string,
  expectedVersion: number,
  now: Date
): NaturalArmResult | null {
  if (window.executionProfileId !== executionProfileId) {
    return refuse("WINDOW_WRONG_PROFILE", "the authorization belongs to a different execution profile.");
  }
  if (window.authorizationType !== "NATURAL_WINDOW") {
    return refuse(
      "WINDOW_NOT_NATURAL",
      `the authorization is ${window.authorizationType}; this command arms natural windows only. ` +
        "An EXACT_SIGNAL authorization is armed by execution:arm-canary."
    );
  }

  // The shared domain classifier, never a second opinion re-derived here.
  const state = naturalWindowState(window, now);
  switch (state) {
    case "REVOKED":
      return refuse("WINDOW_REVOKED", "the natural window was revoked. Prepare a fresh one.");
    case "EXPIRED":
      return refuse("WINDOW_EXPIRED", "the natural window has expired. Prepare a fresh one.");
    case "EXHAUSTED":
      return refuse(
        "WINDOW_EXHAUSTED",
        `the natural window has spent its whole budget (${window.claimedCount}/${window.maxClaims ?? "?"}).`
      );
    case "INVALID":
      return refuse("WINDOW_INVALID", "the natural window contradicts its own declared mode.");
    case "AVAILABLE":
      break;
  }

  if (normalizeNaturalDirections(window.allowedDirections) === null) {
    return refuse(
      "WINDOW_DIRECTIONS_INVALID",
      "the window names no usable direction, which admits nothing. It is not repaired here."
    );
  }
  if (window.maxClaims !== CANARY_NATURAL_MAX_CLAIMS) {
    return refuse(
      "WINDOW_MAX_CLAIMS_MISMATCH",
      `maxClaims is ${window.maxClaims ?? "unset"}; the supervised canary is pinned to ${CANARY_NATURAL_MAX_CLAIMS}.`
    );
  }
  if (window.version !== expectedVersion) {
    return refuse(
      "WINDOW_VERSION_CHANGED",
      `the window moved from version ${expectedVersion} to ${window.version} after it was reviewed.`
    );
  }
  if (window.expiresAt.getTime() - now.getTime() < NATURAL_ARM_MINIMUM_REMAINING_MS) {
    return refuse(
      "WINDOW_TTL_TOO_LOW",
      `less than ${NATURAL_ARM_MINIMUM_REMAINING_MS / 60_000} minutes remain; a supervised window ` +
        "must not be armed moments before it closes. Prepare a fresh one."
    );
  }
  return null;
}

/** The persisted limits must still be exactly the reviewed envelope. */
export function policyMatchesReviewedEnvelope(policy: ExecutionSafetyPolicy): boolean {
  return CANARY_PINNED_LIMITS.every((name) => {
    const required = CANARY_POLICY[name];
    const actual = policy[name];
    // Decimal-exact for the money limits; never a float comparison.
    if (typeof required === "string") return new Prisma.Decimal(required).equals(actual as Prisma.Decimal);
    return required === actual;
  });
}

function sameSymbols(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * The one mutating path. Everything is re-read under an advisory lock and the
 * kill-switch release is a compare-and-set, so a concurrent policy write or a
 * window that closed since the dry run loses rather than arms.
 */
export async function armNaturalWindow(
  client: Prisma.TransactionClient,
  input: NaturalArmInput
): Promise<NaturalArmResult> {
  const now = input.now ?? new Date();

  await client.$executeRaw`SELECT pg_advisory_xact_lock(${CANARY_PREPARE_LOCK_NAMESPACE}::int, ${profileLockKey(
    input.executionProfileId
  )}::int)`;

  // --- Re-read EVERYTHING. The dry run's values are not evidence. -----------
  const window = await client.executionCanaryAuthorization.findUnique({ where: { id: input.authorizationId } });
  if (!window) return refuse("WINDOW_NOT_FOUND", "no authorization exists with that id.");

  const rejection = evaluateNaturalWindowForArm(window, input.executionProfileId, input.expectedWindowVersion, now);
  if (rejection) return rejection;

  const policy = await client.executionSafetyPolicy.findUnique({
    where: { executionProfileId: input.executionProfileId },
  });
  if (!policy) return refuse("POLICY_MISSING", "the profile has no safety policy row; effective limits cannot be proven.");

  if (policy.version !== input.expectedPolicyVersion) {
    return refuse(
      "POLICY_VERSION_CHANGED",
      `the safety policy moved from version ${input.expectedPolicyVersion} to ${policy.version} after it was reviewed.`
    );
  }
  if (!policyMatchesReviewedEnvelope(policy)) {
    return refuse("POLICY_ENVELOPE_MISMATCH", "the persisted limits are no longer the reviewed canary envelope.");
  }
  if (!sameSymbols(policy.allowedSymbols, input.expectedAllowedSymbols)) {
    return refuse(
      "ALLOWED_SYMBOLS_CHANGED",
      `allowedSymbols changed from [${input.expectedAllowedSymbols.join(", ")}] to [${policy.allowedSymbols.join(", ")}].`
    );
  }

  const profile = await client.executionProfile.findUniqueOrThrow({ where: { id: input.executionProfileId } });

  const snapshot: NaturalArmSnapshot = {
    authorizationId: window.id,
    windowVersion: window.version,
    maxClaims: window.maxClaims as number,
    claimedCount: window.claimedCount,
    allowedDirections: window.allowedDirections,
    expiresAt: window.expiresAt,
    policyVersion: policy.version,
    allowedSymbols: policy.allowedSymbols,
    profileIsEnabled: profile.isEnabled,
    killSwitchActive: policy.killSwitchActive,
  };

  // --- Idempotency: already armed is a state, not a second arming ----------
  if (profile.isEnabled && policy.killSwitchActive === false) {
    return { ok: true, alreadyArmed: true, snapshot };
  }

  // --- CAS: the kill switch releases only from the exact row we validated ---
  // version is asserted but NOT incremented: releasing a kill switch is not a
  // policy edit, and `arm-canary` leaves version alone for the same reason.
  const released = await client.executionSafetyPolicy.updateMany({
    where: {
      executionProfileId: input.executionProfileId,
      version: input.expectedPolicyVersion,
      killSwitchActive: true,
    },
    data: { killSwitchActive: false },
  });
  if (released.count !== 1) {
    return refuse(
      "POLICY_VERSION_CHANGED",
      "the safety policy row changed while arming; the kill switch was not released."
    );
  }

  await client.executionProfile.updateMany({
    where: { id: input.executionProfileId },
    data: { isEnabled: true },
  });

  // Never trust the write — read it back, exactly as arm-canary does.
  const verified = await client.executionProfile.findUniqueOrThrow({
    where: { id: input.executionProfileId },
    include: { safetyPolicy: true },
  });
  const armed = verified.isEnabled && verified.safetyPolicy?.killSwitchActive === false;
  if (!armed) return refuse("ARM_NOT_VERIFIED", "the profile did not read back as armed.");

  return {
    ok: true,
    alreadyArmed: false,
    snapshot: { ...snapshot, profileIsEnabled: true, killSwitchActive: false },
  };
}
