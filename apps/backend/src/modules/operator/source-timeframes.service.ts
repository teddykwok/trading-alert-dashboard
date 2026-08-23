import type { PrismaClient } from "@prisma/client";
import { SOURCE_TIMEFRAMES } from "@trading-alert-dashboard/shared";

import { CANARY_PREPARE_LOCK_NAMESPACE } from "../execution/canary-authorization.service";
import { TOTAL_ACTIVE_STATUSES } from "../execution/capacity-status";
import { isNaturalWindowAvailable } from "../execution/natural-authorization";
import { profileLockKey } from "../execution/profile-lock";
import { configuredProfileIdentity, resolveExecutionProfile } from "../execution/execution-profile.service";
import {
  describeStoredSelection,
  validateSourceTimeframeSelection,
  type SourceTimeframeValidation,
} from "./source-timeframe-policy";

/**
 * Operator management of the durable SOURCE timeframe execution filter.
 *
 * The policy lives in exactly one place — `ExecutionSafetyPolicy
 * .allowedSourceTimeframes` — and this service does not introduce a second.
 * It only gives the operator a supervised way to write the same column the
 * safety engine already reads, so admission, status and Start Trading keep
 * reading one value.
 *
 * Guarded on the SAME durable facts as the symbol allowlist, through the same
 * advisory-lock namespace, because it is the same class of change: which
 * signals may become money. Reconfiguring eligibility underneath a live
 * position, or underneath a prepared window that could admit one the moment a
 * runtime goes live, is exactly what must wait for a quiet system.
 *
 * Sharing `CANARY_PREPARE_LOCK_NAMESPACE` with arming, Safe Off and the
 * allowlist is deliberate: those mutations serialize against each other, so a
 * window cannot open underneath this write and this write cannot land
 * underneath an arm.
 */

export const SOURCE_TIMEFRAME_BLOCKERS = [
  "PROFILE_UNRESOLVED",
  "PROFILE_POLICY_MISSING",
  "NOT_SAFE_OFF",
  "ACTIVE_EXECUTIONS",
  "MANUAL_INTERVENTION",
  "AUTHORIZATION_AVAILABLE",
  "VALIDATION_REFUSED",
] as const;

export type SourceTimeframeBlocker = (typeof SOURCE_TIMEFRAME_BLOCKERS)[number];

export interface SourceTimeframeReadResult {
  /** Exactly what the durable column holds, unmodified. */
  stored: string[];
  /** The subset that is actually enforceable after normalization. */
  enforceable: string[];
  /** Stored values that no longer normalize; never silently discarded. */
  unrecognized: string[];
  /** False when the stored policy could not admit anything, or is malformed. */
  valid: boolean;
  /** The full canonical vocabulary, so the panel need not hardcode it. */
  supported: string[];
}

export interface SourceTimeframeSaveResult {
  ok: boolean;
  outcome: "SAVED" | "BLOCKED";
  blockers: string[];
  message: string;
  /** Present on success; the durable policy as it now stands. */
  allowedSourceTimeframes: string[] | null;
  counts: SourceTimeframeValidation["counts"] | null;
  rejected: SourceTimeframeValidation["rejected"];
}

function refusal(blockers: SourceTimeframeBlocker[], message: string): SourceTimeframeSaveResult {
  return {
    ok: false,
    outcome: "BLOCKED",
    blockers,
    message,
    allowedSourceTimeframes: null,
    counts: null,
    rejected: [],
  };
}

export class SourceTimeframeService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The policy in force. Read-only, so it stays available while ARMED — the
   * operator must be able to SEE what governs a live system without being able
   * to change it.
   */
  async read(): Promise<SourceTimeframeReadResult> {
    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    const stored = resolution.ok ? (resolution.profile.safetyPolicy?.allowedSourceTimeframes ?? []) : [];
    const described = describeStoredSelection(stored);
    return {
      stored: [...stored],
      enforceable: described.enforceable,
      unrecognized: described.unrecognized,
      valid: described.valid,
      supported: [...SOURCE_TIMEFRAMES],
    };
  }

  /**
   * Replace the durable source-timeframe policy.
   *
   * The read of the safety state and the write share ONE transaction under the
   * profile advisory lock, so nothing checked can change before the write
   * lands. Every guard re-reads inside the lock; anything read before it is a
   * guess.
   */
  async save(raw: unknown): Promise<SourceTimeframeSaveResult> {
    const validation = validateSourceTimeframeSelection(raw);
    if (!validation.ok) {
      return {
        ok: false,
        outcome: "BLOCKED",
        blockers: ["VALIDATION_REFUSED"],
        message: validation.refusal ?? "The submitted selection did not validate. Nothing was saved.",
        allowedSourceTimeframes: null,
        counts: validation.counts,
        rejected: validation.rejected,
      };
    }

    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    if (!resolution.ok) return refusal(["PROFILE_UNRESOLVED"], resolution.message);
    const profile = resolution.profile;
    if (!profile.safetyPolicy) {
      return refusal(["PROFILE_POLICY_MISSING"], "The profile has no safety policy row to update.");
    }

    const accepted = validation.accepted;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Same namespace and key arming, Safe Off and the allowlist take, so
        // none of them can interleave with this.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CANARY_PREPARE_LOCK_NAMESPACE}::int, ${profileLockKey(
          profile.id
        )}::int)`;

        const fresh = await tx.executionProfile.findUnique({
          where: { id: profile.id },
          include: { safetyPolicy: true },
        });
        if (!fresh?.safetyPolicy) {
          return refusal(["PROFILE_POLICY_MISSING"], "The profile has no safety policy row to update.");
        }

        if (fresh.isEnabled || !fresh.safetyPolicy.killSwitchActive) {
          return refusal(
            ["NOT_SAFE_OFF"],
            "Source timeframes can only be changed while trading is SAFE OFF. Disarm first; nothing was saved."
          );
        }

        const active = await tx.tradeExecution.count({
          where: {
            executionProfileId: profile.id,
            status: { in: [...TOTAL_ACTIVE_STATUSES] as never },
          },
        });
        if (active > 0) {
          return refusal(
            ["ACTIVE_EXECUTIONS"],
            `${active} execution(s) are still active. Execution eligibility cannot change underneath live work; nothing was saved.`
          );
        }

        const manual = await tx.tradeExecution.count({
          where: {
            executionProfileId: profile.id,
            OR: [{ status: "MANUAL_INTERVENTION" }, { requiresManualIntervention: true }],
          },
        });
        if (manual > 0) {
          return refusal(
            ["MANUAL_INTERVENTION"],
            `${manual} execution(s) require manual intervention. Resolve them first; nothing was saved.`
          );
        }

        // An AVAILABLE window can admit a trade the moment a runtime goes live,
        // even though the profile flags read SAFE OFF right now. Swapping
        // eligibility underneath a prepared authorization would let it admit
        // signals nobody reviewed when preparing it.
        const openWindows = await tx.executionCanaryAuthorization.findMany({
          where: {
            executionProfileId: profile.id,
            authorizationType: "NATURAL_WINDOW",
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        });
        const available = openWindows.filter((row) => isNaturalWindowAvailable(row, new Date()));
        if (available.length > 0) {
          return refusal(
            ["AUTHORIZATION_AVAILABLE"],
            "A natural authorization window is still AVAILABLE and could admit a trade under new eligibility. Revoke it through Trading Control first; nothing was saved."
          );
        }

        // The ONLY field this feature writes. Risk, margin, capacity, the
        // symbol allowlist, the kill switch and enabled state are untouched,
        // and no authorization is created or revoked.
        const updated = await tx.executionSafetyPolicy.update({
          where: { executionProfileId: profile.id },
          data: { allowedSourceTimeframes: accepted, version: { increment: 1 } },
          select: { allowedSourceTimeframes: true },
        });

        return {
          ok: true,
          outcome: "SAVED" as const,
          blockers: [],
          message: `Source timeframes saved: ${updated.allowedSourceTimeframes.join(", ")}. Nothing was armed.`,
          allowedSourceTimeframes: updated.allowedSourceTimeframes,
          counts: validation.counts,
          rejected: validation.rejected,
        };
      });
    } catch (error) {
      return refusal(
        ["VALIDATION_REFUSED"],
        `The source timeframes could not be saved: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }
}
