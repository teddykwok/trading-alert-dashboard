import { Prisma } from "@prisma/client";
import type { ExecutionSafetyPolicy, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../utils/errors";
import { OptimisticLockError } from "./execution.service";

/**
 * Per-profile safety policy administration — INTERNAL ONLY.
 *
 * There is deliberately no HTTP route for these methods. Loosening a limit or
 * releasing a kill switch is an operator action performed deliberately from a
 * script, never something an unauthenticated request can reach.
 *
 * The policy holds NO credentials: only limits, an optional symbol allowlist
 * and a kill switch.
 */

export interface SafetyPolicyValues {
  killSwitchActive?: boolean;
  maxOpenPositions?: number;
  maxPendingEntries?: number;
  maxTotalActiveTrades?: number;
  /** SOFT admission target; must stay <= maxOpenPositions. */
  softOpenPositionTarget?: number;
  maxTotalPlannedRiskUsd?: string;
  maxTotalIsolatedMarginUsd?: string;
  maxActivePerSymbolSide?: number;
  maxAlertAgeSeconds?: number;
  allowedSymbols?: string[];
}

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const SYMBOL_PATTERN = /^[A-Z0-9._-]{2,32}$/;

function assertPositiveInt(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ValidationError(`${field} must be a positive safe integer.`);
  }
  return value as number;
}

function assertPositiveDecimal(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!DECIMAL_PATTERN.test(text) || !/[1-9]/.test(text)) {
    throw new ValidationError(`${field} must be a positive plain decimal string, e.g. "1.50".`);
  }
  return text;
}

function normalizeAllowedSymbols(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array of symbols.`);
  const normalized = value.map((entry) => String(entry).trim().toUpperCase()).filter((entry) => entry.length > 0);
  for (const symbol of normalized) {
    if (!SYMBOL_PATTERN.test(symbol)) throw new ValidationError(`${field} contains an invalid symbol "${symbol}".`);
  }
  return [...new Set(normalized)].sort();
}

export class SafetyPolicyService {
  constructor(private readonly prisma: PrismaClient) {}

  async getByProfileId(executionProfileId: string): Promise<ExecutionSafetyPolicy | null> {
    return this.prisma.executionSafetyPolicy.findUnique({ where: { executionProfileId } });
  }

  /**
   * Creates the policy for a profile. Every unspecified value keeps its
   * fail-closed schema default (kill switch ACTIVE, all limits 1).
   */
  async createForProfile(
    executionProfileId: string,
    values: SafetyPolicyValues = {}
  ): Promise<ExecutionSafetyPolicy> {
    const profile = await this.prisma.executionProfile.findUnique({ where: { id: executionProfileId } });
    if (!profile) throw new NotFoundError(`Execution profile ${executionProfileId} not found.`);

    const existing = await this.getByProfileId(executionProfileId);
    if (existing) {
      throw new ValidationError(
        `A safety policy already exists for profile ${executionProfileId}; update it instead of recreating it.`
      );
    }

    const data = this.validate(values);

    // Unspecified counts fall back to the schema default of 1, so the same
    // reachability invariant is checked against the effective combination.
    const open = (data.maxOpenPositions as number | undefined) ?? 1;
    const pending = (data.maxPendingEntries as number | undefined) ?? 1;
    const total = (data.maxTotalActiveTrades as number | undefined) ?? 1;
    if (total < open) throw new ValidationError("maxTotalActiveTrades must be >= maxOpenPositions.");
    if (total < pending) throw new ValidationError("maxTotalActiveTrades must be >= maxPendingEntries.");

    return this.prisma.executionSafetyPolicy.create({
      data: { executionProfileId, ...data },
    });
  }

  /**
   * Optimistically-locked update. A stale expectedVersion means another
   * operator changed the policy in between — the write is rejected rather
   * than silently overwriting their limits.
   */
  async updateForProfile(
    executionProfileId: string,
    expectedVersion: number,
    values: SafetyPolicyValues
  ): Promise<ExecutionSafetyPolicy> {
    const existing = await this.getByProfileId(executionProfileId);
    if (!existing) throw new NotFoundError(`No safety policy exists for profile ${executionProfileId}.`);

    const data = this.validate(values);
    if (Object.keys(data).length === 0) throw new ValidationError("No safety policy values were supplied.");

    // A partial update must not create an unreachable combination either, so
    // the invariants are re-checked against the MERGED result, not just the
    // fields present in this call.
    this.assertMergedInvariants(existing, data);

    const updated = await this.prisma.executionSafetyPolicy.updateMany({
      where: { executionProfileId, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });
    if (updated.count === 0) throw new OptimisticLockError(existing.id, expectedVersion);

    return this.prisma.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId } });
  }

  /** Convenience for operators: re-arm the profile kill switch immediately. */
  async engageKillSwitch(executionProfileId: string, expectedVersion: number): Promise<ExecutionSafetyPolicy> {
    return this.updateForProfile(executionProfileId, expectedVersion, { killSwitchActive: true });
  }

  /**
   * Runs the SAME validation a write runs, and writes nothing.
   *
   * Exists so a dry-run operator command can reject a bad proposal without
   * reimplementing the rules — a second validator that drifted from this one
   * would be worse than no dry run at all.
   *
   * Pass `existing` (a dry run always has the row in hand) to also evaluate
   * the cross-field invariants against the FINAL MERGED row. Without it only
   * the supplied fields can be judged, which would let a dry run report a
   * proposal as acceptable that the write then rejects — e.g. lowering
   * maxOpenPositions below a soft target the operator did not mention.
   */
  assertValidValues(values: SafetyPolicyValues, existing?: ExecutionSafetyPolicy): void {
    const data = this.validate(values);
    if (Object.keys(data).length === 0) throw new ValidationError("No safety policy values were supplied.");
    if (existing) this.assertMergedInvariants(existing, data);
  }

  /**
   * The cross-field capacity invariants, evaluated on the row that would
   * RESULT from a partial update.
   *
   * One implementation, called by both the write path and the dry run, so the
   * two can never disagree about whether a proposal is acceptable.
   */
  private assertMergedInvariants(existing: ExecutionSafetyPolicy, data: Record<string, unknown>): void {
    const pick = (key: keyof ExecutionSafetyPolicy) =>
      (data[key] as number | undefined) ?? (existing[key] as number);
    const merged = {
      maxOpenPositions: pick("maxOpenPositions"),
      maxPendingEntries: pick("maxPendingEntries"),
      maxTotalActiveTrades: pick("maxTotalActiveTrades"),
      softOpenPositionTarget: pick("softOpenPositionTarget"),
    };
    if (merged.maxTotalActiveTrades < merged.maxOpenPositions) {
      throw new ValidationError("maxTotalActiveTrades must be >= maxOpenPositions.");
    }
    if (merged.maxTotalActiveTrades < merged.maxPendingEntries) {
      throw new ValidationError("maxTotalActiveTrades must be >= maxPendingEntries.");
    }
    // A soft target above the hard cap is unreachable: the hard limit would
    // reject first and the soft gate would never fire, so the row would claim
    // a policy it does not implement. Checked on the MERGED result, so lowering
    // maxOpenPositions alone cannot strand an existing soft target above it.
    if (merged.softOpenPositionTarget > merged.maxOpenPositions) {
      throw new ValidationError("softOpenPositionTarget must be <= maxOpenPositions.");
    }
  }

  private validate(values: SafetyPolicyValues): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    if (values.killSwitchActive !== undefined) {
      if (typeof values.killSwitchActive !== "boolean") {
        throw new ValidationError("killSwitchActive must be a boolean.");
      }
      data.killSwitchActive = values.killSwitchActive;
    }
    if (values.maxOpenPositions !== undefined) {
      data.maxOpenPositions = assertPositiveInt(values.maxOpenPositions, "maxOpenPositions");
    }
    if (values.maxPendingEntries !== undefined) {
      data.maxPendingEntries = assertPositiveInt(values.maxPendingEntries, "maxPendingEntries");
    }
    if (values.maxTotalActiveTrades !== undefined) {
      data.maxTotalActiveTrades = assertPositiveInt(values.maxTotalActiveTrades, "maxTotalActiveTrades");
    }
    if (values.maxActivePerSymbolSide !== undefined) {
      data.maxActivePerSymbolSide = assertPositiveInt(values.maxActivePerSymbolSide, "maxActivePerSymbolSide");
    }
    if (values.softOpenPositionTarget !== undefined) {
      data.softOpenPositionTarget = assertPositiveInt(values.softOpenPositionTarget, "softOpenPositionTarget");
    }
    if (values.maxAlertAgeSeconds !== undefined) {
      data.maxAlertAgeSeconds = assertPositiveInt(values.maxAlertAgeSeconds, "maxAlertAgeSeconds");
    }
    if (values.maxTotalPlannedRiskUsd !== undefined) {
      data.maxTotalPlannedRiskUsd = assertPositiveDecimal(values.maxTotalPlannedRiskUsd, "maxTotalPlannedRiskUsd");
    }
    if (values.maxTotalIsolatedMarginUsd !== undefined) {
      data.maxTotalIsolatedMarginUsd = assertPositiveDecimal(
        values.maxTotalIsolatedMarginUsd,
        "maxTotalIsolatedMarginUsd"
      );
    }
    if (values.allowedSymbols !== undefined) {
      data.allowedSymbols = normalizeAllowedSymbols(values.allowedSymbols, "allowedSymbols");
    }

    // A total-active cap below either individual cap is unreachable and hides
    // a misconfiguration, exactly as in the global env validation.
    const total = (data.maxTotalActiveTrades as number | undefined) ?? undefined;
    const open = (data.maxOpenPositions as number | undefined) ?? undefined;
    const pending = (data.maxPendingEntries as number | undefined) ?? undefined;
    if (total !== undefined && open !== undefined && total < open) {
      throw new ValidationError("maxTotalActiveTrades must be >= maxOpenPositions.");
    }
    if (total !== undefined && pending !== undefined && total < pending) {
      throw new ValidationError("maxTotalActiveTrades must be >= maxPendingEntries.");
    }

    return data as Prisma.ExecutionSafetyPolicyUpdateManyMutationInput;
  }
}
