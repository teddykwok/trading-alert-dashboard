import type { ExecutionSafetyPolicy, PrismaClient } from "@prisma/client";

import { env } from "../../config/env";
import { CANARY_PREPARE_LOCK_NAMESPACE } from "../execution/canary-authorization.service";
import { TOTAL_ACTIVE_STATUSES } from "../execution/capacity-status";
import { isNaturalWindowAvailable } from "../execution/natural-authorization";
import { profileLockKey } from "../execution/profile-lock";
import { configuredProfileIdentity, resolveExecutionProfile } from "../execution/execution-profile.service";
import { SafetyPolicyService, type SafetyPolicyValues } from "../execution/safety-policy.service";
import { mergeCapacityLimits } from "../execution/safety-engine";

/**
 * Operator editing of the durable execution policy LIMITS.
 *
 * ## What this is not
 *
 * It introduces no second policy store. The limits have always lived in
 * `ExecutionSafetyPolicy`, and every value written here goes through
 * `SafetyPolicyService` — the same validator, the same cross-field invariants
 * and the same refusal messages the existing `set-policy` operator CLI uses.
 * Admission, status and readiness keep reading exactly the row they read now.
 *
 * It also cannot touch CURRENT STATE. Open positions, pending entries, total
 * active, reserved risk and reserved margin are all COUNTED from
 * `TradeExecution` rows by the safety engine. There is no column to set them
 * to and no endpoint here that could: a policy edit changes what admission
 * will allow NEXT, never what is already true.
 *
 * ## The env ceiling, reported rather than hidden
 *
 * `mergeCapacityLimits` takes `Math.min(env, policy)` for every limit — the
 * stricter side always wins, and the environment can only tighten. So raising
 * a stored limit above its env ceiling changes the row and changes nothing
 * else. That would be a genuinely confusing edit, so every field is reported
 * as `stored` alongside `effective` and `envCeiling`, following the same
 * shape the existing `rrLookback` status block uses. Reported, never repaired.
 *
 * ## Why saving requires SAFE OFF
 *
 * Identical reasoning, and identical guards, to `allowlist.service.ts`:
 * reconfiguring the limits a live position was admitted under is the class of
 * change that waits for a quiet system. Validation is a dry run and stays
 * available while armed, so an operator can prepare an edit before deciding to
 * go safe.
 */

export const POLICY_EDITOR_BLOCKERS = [
  "PROFILE_UNRESOLVED",
  "PROFILE_POLICY_MISSING",
  "NOT_SAFE_OFF",
  "ACTIVE_EXECUTIONS",
  "MANUAL_INTERVENTION",
  "AUTHORIZATION_AVAILABLE",
  "VALIDATION_REFUSED",
  "VERSION_CONFLICT",
] as const;

export type PolicyEditorBlocker = (typeof POLICY_EDITOR_BLOCKERS)[number];

/**
 * The limits this editor may write.
 *
 * Deliberately a subset of `SafetyPolicyValues`. `killSwitchActive` is a
 * TRADING CONTROL, not a limit, and is owned by Start Trading / Safe Off;
 * `allowedSymbols` has its own reviewed editor. Neither is reachable here, and
 * an unknown key is refused rather than ignored.
 */
export const EDITABLE_POLICY_FIELDS = [
  "softOpenPositionTarget",
  "maxOpenPositions",
  "maxPendingEntries",
  "maxTotalActiveTrades",
  "maxActivePerSymbolSide",
  "maxTotalPlannedRiskUsd",
  "maxTotalIsolatedMarginUsd",
] as const;

export type EditablePolicyField = (typeof EDITABLE_POLICY_FIELDS)[number];

/** One limit, as stored and as actually enforced. */
export interface PolicyFieldView {
  stored: string;
  effective: string;
  /** The environment's ceiling for this limit. */
  envCeiling: string;
  /**
   * True when the environment is stricter than the stored value, so raising
   * the stored limit further would change nothing an operator could observe.
   */
  cappedByEnv: boolean;
}

export interface PolicyEditorReadResult {
  ok: boolean;
  /** Optimistic-lock token; the save must echo it back. */
  version: number | null;
  fields: Record<EditablePolicyField, PolicyFieldView> | null;
  /** Empty when the policy may be saved right now. */
  blockers: string[];
  editable: boolean;
  message: string;
}

export interface PolicyEditorValidationResult {
  ok: boolean;
  /** Field-by-field before/after for the review step. Only actual changes. */
  changes: { field: EditablePolicyField; from: string; to: string }[];
  refusal: string | null;
}

export interface PolicyEditorSaveResult {
  ok: boolean;
  outcome: "SAVED" | "BLOCKED";
  blockers: string[];
  message: string;
  changes: { field: EditablePolicyField; from: string; to: string }[];
  version: number | null;
}

function refusal(blockers: PolicyEditorBlocker[], message: string): PolicyEditorSaveResult {
  return { ok: false, outcome: "BLOCKED", blockers, message, changes: [], version: null };
}

/** The environment ceiling for each editable limit, as a comparable string. */
function envCeilingFor(field: EditablePolicyField): string {
  switch (field) {
    case "softOpenPositionTarget":
      return String(env.EXECUTION_SOFT_OPEN_POSITION_TARGET);
    case "maxOpenPositions":
      return String(env.EXECUTION_MAX_OPEN_POSITIONS);
    case "maxPendingEntries":
      return String(env.EXECUTION_MAX_PENDING_ENTRIES);
    case "maxTotalActiveTrades":
      return String(env.EXECUTION_MAX_TOTAL_ACTIVE_TRADES);
    case "maxActivePerSymbolSide":
      return String(env.EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE);
    case "maxTotalPlannedRiskUsd":
      return env.EXECUTION_MAX_TOTAL_PLANNED_RISK_USD;
    case "maxTotalIsolatedMarginUsd":
      return env.EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD;
  }
}

/** The stored value of one limit, as a string, whatever its column type. */
function storedValueOf(policy: ExecutionSafetyPolicy, field: EditablePolicyField): string {
  const raw = policy[field];
  return typeof raw === "object" && raw !== null ? raw.toString() : String(raw);
}

/**
 * The effective limits, through the SAME min-merge admission applies. Not a
 * second calculation — a call into the engine's own function.
 */
function effectiveLimitsFor(policy: ExecutionSafetyPolicy) {
  return mergeCapacityLimits(
    {
      maxOpenPositions: env.EXECUTION_MAX_OPEN_POSITIONS,
      maxPendingEntries: env.EXECUTION_MAX_PENDING_ENTRIES,
      maxTotalActiveTrades: env.EXECUTION_MAX_TOTAL_ACTIVE_TRADES,
      maxActivePerSymbolSide: env.EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE,
      maxAlertAgeSeconds: env.EXECUTION_MAX_ALERT_AGE_SECONDS,
      softOpenPositionTarget: env.EXECUTION_SOFT_OPEN_POSITION_TARGET,
      maxTotalPlannedRiskUsd: env.EXECUTION_MAX_TOTAL_PLANNED_RISK_USD,
      maxTotalIsolatedMarginUsd: env.EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD,
    },
    {
      maxOpenPositions: policy.maxOpenPositions,
      maxPendingEntries: policy.maxPendingEntries,
      maxTotalActiveTrades: policy.maxTotalActiveTrades,
      maxActivePerSymbolSide: policy.maxActivePerSymbolSide,
      maxAlertAgeSeconds: policy.maxAlertAgeSeconds,
      softOpenPositionTarget: policy.softOpenPositionTarget,
      maxTotalPlannedRiskUsd: policy.maxTotalPlannedRiskUsd.toString(),
      maxTotalIsolatedMarginUsd: policy.maxTotalIsolatedMarginUsd.toString(),
    }
  );
}

function viewOf(policy: ExecutionSafetyPolicy): Record<EditablePolicyField, PolicyFieldView> {
  const effective = effectiveLimitsFor(policy);
  const entries = EDITABLE_POLICY_FIELDS.map((field) => {
    const stored = storedValueOf(policy, field);
    const raw = effective[field as keyof typeof effective];
    const effectiveText = typeof raw === "number" ? String(raw) : String(raw);
    return [
      field,
      {
        stored,
        effective: effectiveText,
        envCeiling: envCeilingFor(field),
        // The min-merge already resolved it: if the effective value is not the
        // stored one, the environment is what is actually governing.
        cappedByEnv: effectiveText !== stored,
      },
    ] as const;
  });
  return Object.fromEntries(entries) as Record<EditablePolicyField, PolicyFieldView>;
}

/** Only the supplied, recognised fields, as `SafetyPolicyValues`. */
function pickDraft(raw: unknown): { values: SafetyPolicyValues; unknownKeys: string[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { values: {}, unknownKeys: [] };
  }
  const source = raw as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  const unknownKeys: string[] = [];
  for (const key of Object.keys(source)) {
    if ((EDITABLE_POLICY_FIELDS as readonly string[]).includes(key)) values[key] = source[key];
    else unknownKeys.push(key);
  }
  return { values: values as SafetyPolicyValues, unknownKeys };
}

export class PolicyEditorService {
  private readonly policies: SafetyPolicyService;

  constructor(private readonly prisma: PrismaClient) {
    this.policies = new SafetyPolicyService(prisma);
  }

  /** Current limits plus whether they may be edited right now. Writes nothing. */
  async read(): Promise<PolicyEditorReadResult> {
    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    if (!resolution.ok) {
      return {
        ok: false,
        version: null,
        fields: null,
        blockers: ["PROFILE_UNRESOLVED"],
        editable: false,
        message: resolution.message,
      };
    }
    const policy = resolution.profile.safetyPolicy;
    if (!policy) {
      return {
        ok: false,
        version: null,
        fields: null,
        blockers: ["PROFILE_POLICY_MISSING"],
        editable: false,
        message: "The profile has no safety policy row to edit.",
      };
    }

    const blockers = await this.editBlockers(resolution.profile.id, policy);
    return {
      ok: true,
      version: policy.version,
      fields: viewOf(policy),
      blockers,
      editable: blockers.length === 0,
      message:
        blockers.length === 0
          ? "Policy limits may be edited."
          : "Policy limits can only be changed while trading is SAFE OFF and quiet.",
    };
  }

  /**
   * Dry run: what would change, and would it be accepted?
   *
   * Runs the REAL validator, so a proposal this accepts is one the write
   * accepts. Writes nothing and stays available while armed, so an operator
   * can prepare an edit before going safe.
   */
  async validate(raw: unknown): Promise<PolicyEditorValidationResult> {
    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    if (!resolution.ok) return { ok: false, changes: [], refusal: resolution.message };
    const policy = resolution.profile.safetyPolicy;
    if (!policy) return { ok: false, changes: [], refusal: "The profile has no safety policy row to edit." };

    const { values, unknownKeys } = pickDraft(raw);
    if (unknownKeys.length > 0) {
      // Refused, never ignored: silently dropping a field the operator typed
      // would report success for an edit that did not happen.
      return {
        ok: false,
        changes: [],
        refusal: `Unrecognised policy field(s): ${unknownKeys.sort().join(", ")}. Nothing was changed.`,
      };
    }
    if (Object.keys(values).length === 0) {
      return { ok: false, changes: [], refusal: "No policy values were supplied." };
    }

    try {
      const normalized = this.policies.normalizeAndValidate(values, policy);
      return { ok: true, changes: this.diff(policy, normalized), refusal: null };
    } catch (error) {
      return {
        ok: false,
        changes: [],
        refusal: error instanceof Error ? error.message : "The proposed policy was refused.",
      };
    }
  }

  /**
   * Persist the whole validated draft, or nothing.
   *
   * Atomic by construction: one `updateMany` carrying every field, guarded by
   * the row's `version`. There is no path on which some limits land and others
   * do not.
   *
   * The read of runtime state and the write share one transaction under the
   * existing profile advisory lock, so an authorization cannot open underneath
   * the check. Existing executions are never read for mutation and never
   * touched: lowering a limit governs the NEXT admission, and the positions
   * already open stay open and protected.
   */
  async save(raw: unknown, expectedVersion: unknown): Promise<PolicyEditorSaveResult> {
    const version = Number(expectedVersion);
    if (!Number.isSafeInteger(version) || version < 1) {
      return refusal(["VERSION_CONFLICT"], "A valid policy version must be supplied. Nothing was saved.");
    }

    const validation = await this.validate(raw);
    if (!validation.ok) {
      return {
        ok: false,
        outcome: "BLOCKED",
        blockers: ["VALIDATION_REFUSED"],
        message: validation.refusal ?? "The proposed policy was refused. Nothing was saved.",
        changes: [],
        version: null,
      };
    }

    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    if (!resolution.ok) return refusal(["PROFILE_UNRESOLVED"], resolution.message);
    const profile = resolution.profile;
    if (!profile.safetyPolicy) {
      return refusal(["PROFILE_POLICY_MISSING"], "The profile has no safety policy row to update.");
    }

    const { values } = pickDraft(raw);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Same namespace and key the authorization service takes, so arming
        // and reconfiguring cannot interleave.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CANARY_PREPARE_LOCK_NAMESPACE}::int, ${profileLockKey(
          profile.id
        )}::int)`;

        // Re-read INSIDE the lock. Anything checked before it is a guess.
        const fresh = await tx.executionProfile.findUnique({
          where: { id: profile.id },
          include: { safetyPolicy: true },
        });
        if (!fresh?.safetyPolicy) {
          return refusal(["PROFILE_POLICY_MISSING"], "The profile has no safety policy row to update.");
        }

        const blockers = await this.editBlockers(profile.id, fresh.safetyPolicy, tx);
        if (blockers.length > 0) {
          return refusal(
            blockers as PolicyEditorBlocker[],
            "Policy limits can only be changed while trading is SAFE OFF and quiet. Nothing was saved."
          );
        }

        // Re-validated against the row as it stands inside the lock, so a
        // proposal judged against a stale row cannot be written.
        let normalized: Record<string, unknown>;
        try {
          normalized = this.policies.normalizeAndValidate(values, fresh.safetyPolicy);
        } catch (error) {
          return {
            ok: false,
            outcome: "BLOCKED" as const,
            blockers: ["VALIDATION_REFUSED"],
            message: error instanceof Error ? error.message : "The proposed policy was refused.",
            changes: [],
            version: null,
          };
        }

        const changes = this.diff(fresh.safetyPolicy, normalized);

        // ONE statement carrying every field. Either the whole policy lands or
        // none of it does; a stale version means somebody else edited in
        // between and the write is refused rather than overwriting them.
        const written = await tx.executionSafetyPolicy.updateMany({
          where: { executionProfileId: profile.id, version },
          data: { ...normalized, version: { increment: 1 } },
        });
        if (written.count === 0) {
          return refusal(
            ["VERSION_CONFLICT"],
            "The policy changed since it was loaded. Reload and review the current values; nothing was saved."
          );
        }

        const after = await tx.executionSafetyPolicy.findUniqueOrThrow({
          where: { executionProfileId: profile.id },
          select: { version: true },
        });

        return {
          ok: true,
          outcome: "SAVED" as const,
          blockers: [],
          message: `Policy saved: ${changes.length} limit(s) changed. Nothing was armed.`,
          changes,
          version: after.version,
        };
      });
    } catch (error) {
      return refusal(
        ["VALIDATION_REFUSED"],
        `The policy could not be saved: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }

  /**
   * The durable facts that decide whether limits may change.
   *
   * The SAME set the allowlist editor applies, for the same reason: an
   * AVAILABLE window can admit a trade the moment a runtime goes live, so a
   * profile that merely reads SAFE OFF right now is not enough.
   */
  private async editBlockers(
    profileId: string,
    policy: ExecutionSafetyPolicy,
    client: Pick<PrismaClient, "tradeExecution" | "executionCanaryAuthorization" | "executionProfile"> = this
      .prisma
  ): Promise<string[]> {
    const blockers: string[] = [];

    const profile = await client.executionProfile.findUnique({ where: { id: profileId } });
    if (!profile || profile.isEnabled || !policy.killSwitchActive) blockers.push("NOT_SAFE_OFF");

    const active = await client.tradeExecution.count({
      where: { executionProfileId: profileId, status: { in: [...TOTAL_ACTIVE_STATUSES] as never } },
    });
    if (active > 0) blockers.push("ACTIVE_EXECUTIONS");

    const manual = await client.tradeExecution.count({
      where: {
        executionProfileId: profileId,
        OR: [{ status: "MANUAL_INTERVENTION" }, { requiresManualIntervention: true }],
      },
    });
    if (manual > 0) blockers.push("MANUAL_INTERVENTION");

    const now = new Date();
    const windows = await client.executionCanaryAuthorization.findMany({
      where: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });
    if (windows.some((row) => isNaturalWindowAvailable(row, now))) blockers.push("AUTHORIZATION_AVAILABLE");

    return blockers;
  }

  /** Only the limits that actually move, as before/after strings. */
  private diff(
    existing: ExecutionSafetyPolicy,
    normalized: Record<string, unknown>
  ): { field: EditablePolicyField; from: string; to: string }[] {
    const changes: { field: EditablePolicyField; from: string; to: string }[] = [];
    for (const field of EDITABLE_POLICY_FIELDS) {
      if (!(field in normalized)) continue;
      const from = storedValueOf(existing, field);
      const to = String(normalized[field]);
      if (from !== to) changes.push({ field, from, to });
    }
    return changes;
  }
}
