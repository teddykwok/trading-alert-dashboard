import type { PrismaClient } from "@prisma/client";
import {
  EXTREME_RR_LOOKBACKS,
  isExtremeRRLookback,
  type ExtremeRRLookback,
} from "@trading-alert-dashboard/shared";

import { CANARY_PREPARE_LOCK_NAMESPACE } from "../execution/canary-authorization.service";
import { TOTAL_ACTIVE_STATUSES } from "../execution/capacity-status";
import { isNaturalWindowAvailable } from "../execution/natural-authorization";
import { profileLockKey } from "../execution/profile-lock";
import { configuredProfileIdentity, resolveExecutionProfile } from "../execution/execution-profile.service";

/**
 * Operator management of the durable Extreme RR lookback policy.
 *
 * ## What this value is, and what it is NOT
 *
 * It is the INITIAL `selectedLookback` for a NEW plan — nothing else. Every
 * supported lookback is still calculated and frozen on every plan from one
 * candle dataset, and the per-alert planner can still switch between them
 * afterwards. So this policy:
 *
 *   - never reaches a plan that already exists (their `selectedLookback` is
 *     persisted per row and the regeneration upsert does not write it);
 *   - never reaches an execution (`TradeExecution.selectedLookback` and the
 *     frozen candidate snapshot are written once, at creation);
 *   - is never consulted by protection or reconciliation.
 *
 * Guarded on the SAME durable facts as the symbol allowlist and the source
 * timeframe filter, through the same advisory-lock namespace, because it is the
 * same class of change: which numbers a future trade will be built from.
 */

export const RR_LOOKBACK_BLOCKERS = [
  "PROFILE_UNRESOLVED",
  "PROFILE_POLICY_MISSING",
  "NOT_SAFE_OFF",
  "ACTIVE_EXECUTIONS",
  "MANUAL_INTERVENTION",
  "AUTHORIZATION_AVAILABLE",
  "VALIDATION_REFUSED",
] as const;

export type RrLookbackBlocker = (typeof RR_LOOKBACK_BLOCKERS)[number];

export interface RrLookbackReadResult {
  /** Exactly what the durable column holds, unmodified. */
  stored: number;
  /** The value planning will actually use; null when the stored one is invalid. */
  effective: ExtremeRRLookback | null;
  /** False when the stored value is not one of the supported lookbacks. */
  valid: boolean;
  /** The full vocabulary, so the panel need not hardcode it. */
  supported: number[];
}

export interface RrLookbackSaveResult {
  ok: boolean;
  outcome: "SAVED" | "BLOCKED";
  blockers: string[];
  message: string;
  /** Present on success; the durable policy as it now stands. */
  extremeRrLookbackCandles: number | null;
}

function refusal(blockers: RrLookbackBlocker[], message: string): RrLookbackSaveResult {
  return { ok: false, outcome: "BLOCKED", blockers, message, extremeRrLookbackCandles: null };
}

/**
 * Judges a stored value without repairing it.
 *
 * A row that does not name a supported lookback is INVALID configuration, and
 * saying so is the whole job. Coercing it to 300 here would be the one failure
 * this control exists to prevent: silently planning a trade against a window
 * nobody selected.
 */
export function describeStoredLookback(stored: unknown): RrLookbackReadResult {
  const valid = isExtremeRRLookback(stored);
  return {
    stored: typeof stored === "number" ? stored : Number.NaN,
    effective: valid ? stored : null,
    valid,
    supported: [...EXTREME_RR_LOOKBACKS],
  };
}

export class ExtremeRrLookbackService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The policy in force. Read-only, so it stays available while ARMED — the
   * operator must be able to SEE what governs new planning without being able
   * to change it.
   */
  async read(): Promise<RrLookbackReadResult> {
    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    const stored = resolution.ok
      ? resolution.profile.safetyPolicy?.extremeRrLookbackCandles
      : undefined;
    return describeStoredLookback(stored);
  }

  /**
   * Replace the durable lookback policy.
   *
   * The read of the safety state and the write share ONE transaction under the
   * profile advisory lock, so nothing checked can change before the write
   * lands. Every guard re-reads inside the lock; anything read before it is a
   * guess.
   */
  async save(raw: unknown): Promise<RrLookbackSaveResult> {
    if (!isExtremeRRLookback(raw)) {
      return refusal(
        ["VALIDATION_REFUSED"],
        `The lookback must be one of ${EXTREME_RR_LOOKBACKS.join(", ")} candles. Nothing was saved.`
      );
    }
    const requested: ExtremeRRLookback = raw;

    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    if (!resolution.ok) return refusal(["PROFILE_UNRESOLVED"], resolution.message);
    const profile = resolution.profile;
    if (!profile.safetyPolicy) {
      return refusal(["PROFILE_POLICY_MISSING"], "The profile has no safety policy row to update.");
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Same namespace and key arming, Safe Off, the allowlist and the source
        // timeframe policy take, so none of them can interleave with this.
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
            "The Extreme RR lookback can only be changed while trading is SAFE OFF. Disarm first; nothing was saved."
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
            `${active} execution(s) are still active. Planning parameters cannot change underneath live work; nothing was saved.`
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
        // even though the profile flags read SAFE OFF right now. Changing how a
        // new plan is built underneath a prepared authorization would let it
        // admit a trade shaped by numbers nobody reviewed when preparing it.
        const openWindows = await tx.executionCanaryAuthorization.findMany({
          where: {
            executionProfileId: profile.id,
            authorizationType: "NATURAL_WINDOW",
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        });
        if (openWindows.some((row) => isNaturalWindowAvailable(row, new Date()))) {
          return refusal(
            ["AUTHORIZATION_AVAILABLE"],
            "A natural authorization window is still AVAILABLE and could admit a trade under a new lookback. Revoke it through Trading Control first; nothing was saved."
          );
        }

        // The ONLY field this feature writes. Risk, margin, capacity, the
        // symbol allowlist and the source timeframes are untouched, and no
        // authorization is created or revoked.
        const updated = await tx.executionSafetyPolicy.update({
          where: { executionProfileId: profile.id },
          data: { extremeRrLookbackCandles: requested, version: { increment: 1 } },
          select: { extremeRrLookbackCandles: true },
        });

        return {
          ok: true,
          outcome: "SAVED" as const,
          blockers: [],
          message: `Extreme RR lookback saved: ${updated.extremeRrLookbackCandles} candles. Existing plans and executions are unchanged.`,
          extremeRrLookbackCandles: updated.extremeRrLookbackCandles,
        };
      });
    } catch (error) {
      return refusal(
        ["VALIDATION_REFUSED"],
        `The Extreme RR lookback could not be saved: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }
}
