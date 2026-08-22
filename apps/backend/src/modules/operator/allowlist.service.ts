import type { PrismaClient } from "@prisma/client";

import { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import { CANARY_PREPARE_LOCK_NAMESPACE } from "../execution/canary-authorization.service";
import { TOTAL_ACTIVE_STATUSES } from "../execution/capacity-status";
import { isNaturalWindowAvailable } from "../execution/natural-authorization";
import { profileLockKey } from "../execution/profile-lock";
import { configuredProfileIdentity, resolveExecutionProfile } from "../execution/execution-profile.service";
import {
  validateAllowlist,
  type AllowlistValidation,
  type SymbolMetadataIndex,
} from "./symbol-allowlist";

/**
 * Operator management of the durable symbol allowlist.
 *
 * The allowlist has always lived in exactly one place —
 * `ExecutionSafetyPolicy.allowedSymbols` — and this service does not introduce
 * a second one. It only gives the operator a supervised way to write that same
 * column, so status, readiness, admission and Start Trading keep reading the
 * value they already read.
 *
 * Two operations, deliberately separate:
 *
 *   `validate` answers "what would be saved?" and writes NOTHING.
 *   `save` re-validates from scratch and then writes.
 *
 * `save` never trusts the browser's claim that a list was already checked. The
 * client sends raw text both times; the server is the only thing that decides
 * what a symbol means and whether it is eligible.
 */

export const ALLOWLIST_BLOCKERS = [
  "PROFILE_UNRESOLVED",
  "PROFILE_POLICY_MISSING",
  "NOT_SAFE_OFF",
  "ACTIVE_EXECUTIONS",
  "MANUAL_INTERVENTION",
  "AUTHORIZATION_AVAILABLE",
  "VALIDATION_REFUSED",
  "METADATA_UNAVAILABLE",
] as const;

export type AllowlistBlocker = (typeof ALLOWLIST_BLOCKERS)[number];

export interface AllowlistValidationResult extends AllowlistValidation {
  /** The list currently in force, so the panel can show a before/after. */
  current: string[];
}

export interface AllowlistSaveResult {
  ok: boolean;
  outcome: "SAVED" | "BLOCKED";
  blockers: string[];
  message: string;
  /** Present on success; the durable list as it now stands. */
  allowedSymbols: string[] | null;
  counts: AllowlistValidation["counts"] | null;
  rejected: AllowlistValidation["rejected"];
}

export interface AllowlistServiceOptions {
  /** Injected in tests so no exchange round-trip happens. */
  loadMetadata?: () => Promise<SymbolMetadataIndex>;
}

function refusal(blockers: AllowlistBlocker[], message: string): AllowlistSaveResult {
  return { ok: false, outcome: "BLOCKED", blockers, message, allowedSymbols: null, counts: null, rejected: [] };
}

export class AllowlistService {
  private readonly loadMetadata: () => Promise<SymbolMetadataIndex>;

  constructor(
    private readonly prisma: PrismaClient,
    options: AllowlistServiceOptions = {}
  ) {
    this.loadMetadata =
      options.loadMetadata ?? (() => new BinanceReadOnlyService().listSymbolFilters());
  }

  /**
   * Dry run. Reads exchange metadata and judges the paste, and touches no row.
   *
   * Safe to call while ARMED: it answers a question, so the operator can
   * prepare a list before deciding to go SAFE_OFF in order to save it.
   */
  async validate(raw: unknown): Promise<AllowlistValidationResult> {
    const text = typeof raw === "string" ? raw : "";
    const current = await this.readCurrent();

    let metadata: SymbolMetadataIndex;
    try {
      metadata = await this.loadMetadata();
    } catch (error) {
      // An unreachable exchange is a reason to refuse, never to assume.
      return {
        ok: false,
        counts: { input: 0, normalized: 0, valid: 0, duplicates: 0, rejected: 0 },
        accepted: [],
        rejected: [],
        refusal: `Exchange metadata could not be read, so no symbol could be confirmed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        current,
      };
    }

    return { ...validateAllowlist(text, metadata), current };
  }

  /**
   * Replace the durable allowlist.
   *
   * Guarded on the SAME durable facts the rest of the system uses: the profile
   * must be disabled with its kill switch engaged, and nothing may be active,
   * pending, open or awaiting manual intervention. Reconfiguring the symbols a
   * live position was admitted under is exactly the class of change that must
   * wait for a quiet system.
   *
   * The read of that state and the write share one transaction under the
   * existing profile advisory lock, so a window cannot open underneath it.
   */
  async save(raw: unknown): Promise<AllowlistSaveResult> {
    const validation = await this.validate(raw);
    if (!validation.ok) {
      return {
        ok: false,
        outcome: "BLOCKED",
        blockers: ["VALIDATION_REFUSED"],
        message: validation.refusal ?? "The submitted allowlist did not validate. Nothing was saved.",
        allowedSymbols: null,
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
        // Same namespace and key the authorization service takes, so arming and
        // reconfiguring cannot interleave.
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

        if (fresh.isEnabled || !fresh.safetyPolicy.killSwitchActive) {
          return refusal(
            ["NOT_SAFE_OFF"],
            "The allowlist can only be changed while trading is SAFE OFF. Disarm first; nothing was saved."
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
            `${active} execution(s) are still active. The allowlist cannot change underneath live work; nothing was saved.`
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

        // An AVAILABLE window can admit a trade the moment a runtime goes
        // live, even though the profile flags read SAFE OFF right now — the
        // same reasoning the launcher's durable guard applies. Swapping the
        // allowlist underneath a prepared authorization would let it admit
        // symbols nobody reviewed when preparing it.
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
            "A natural authorization window is still AVAILABLE and could admit a trade under a new allowlist. Revoke it through Trading Control first; nothing was saved."
          );
        }

        // The ONLY field this feature writes. Enabled state, kill switch, risk,
        // margin and capacity are all left exactly as they were, and no
        // authorization is created or revoked.
        const updated = await tx.executionSafetyPolicy.update({
          where: { executionProfileId: profile.id },
          data: { allowedSymbols: accepted, version: { increment: 1 } },
          select: { allowedSymbols: true },
        });

        return {
          ok: true,
          outcome: "SAVED" as const,
          blockers: [],
          message: `Allowlist saved: ${updated.allowedSymbols.length} symbol(s). Nothing was armed.`,
          allowedSymbols: updated.allowedSymbols,
          counts: validation.counts,
          rejected: validation.rejected,
        };
      });
    } catch (error) {
      return refusal(
        ["VALIDATION_REFUSED"],
        `The allowlist could not be saved: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }

  private async readCurrent(): Promise<string[]> {
    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    return resolution.ok ? (resolution.profile.safetyPolicy?.allowedSymbols ?? []) : [];
  }
}
