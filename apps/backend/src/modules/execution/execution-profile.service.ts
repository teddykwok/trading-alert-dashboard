import type { ExecutionProfile, ExecutionSafetyPolicy, PrismaClient } from "@prisma/client";
import { env } from "../../config/env";

/**
 * Phase 11A.1 — resolution and idempotent bootstrap of the ONE execution
 * profile the production orchestrator uses.
 *
 * Two rules drive this module:
 *
 *  1. The profile is resolved by explicit configured identity, never by
 *     "whatever row is first". An ambiguous or missing profile fails closed —
 *     silently adopting an arbitrary profile would mean trading against
 *     capacity limits nobody chose.
 *  2. A freshly created profile admits nothing: `isEnabled` is false and the
 *     policy's `killSwitchActive` is true, both straight from the schema
 *     defaults. Bootstrap creates capacity, never permission.
 *
 * Stores no credential of any kind. `accountIdentifier` is a non-secret
 * operator-chosen alias.
 */

export type ProfileResolution =
  | { ok: true; profile: ExecutionProfile & { safetyPolicy: ExecutionSafetyPolicy | null } }
  | { ok: false; reasonCode: ProfileResolutionFailure; message: string };

export type ProfileResolutionFailure =
  | "PROFILE_NOT_CONFIGURED"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_AMBIGUOUS"
  | "PROFILE_POLICY_MISSING";

export interface ProfileIdentity {
  accountIdentifier: string;
  environment: "TESTNET" | "MAINNET";
}

export function configuredProfileIdentity(): ProfileIdentity {
  return {
    accountIdentifier: env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER.trim(),
    environment: env.EXECUTION_PROFILE_ENVIRONMENT,
  };
}

/**
 * Resolves the configured profile, or explains why it cannot.
 *
 * Every failure is a hard stop for the orchestrator: without a profile there is
 * no safety policy, and without a safety policy there is no capacity limit,
 * kill switch or risk ceiling to enforce.
 */
export async function resolveExecutionProfile(
  prisma: PrismaClient,
  identity: ProfileIdentity = configuredProfileIdentity()
): Promise<ProfileResolution> {
  if (identity.accountIdentifier === "") {
    return {
      ok: false,
      reasonCode: "PROFILE_NOT_CONFIGURED",
      message:
        "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER is empty. No profile is selected, so no execution can be admitted.",
    };
  }

  const matches = await prisma.executionProfile.findMany({
    where: {
      accountIdentifier: identity.accountIdentifier,
      environment: identity.environment,
      exchange: "BINANCE",
      product: "USD_M_FUTURES",
    },
    include: { safetyPolicy: true },
  });

  if (matches.length === 0) {
    return {
      ok: false,
      reasonCode: "PROFILE_NOT_FOUND",
      message: "No execution profile matches the configured identity. Run execution:ensure-profile to create it.",
    };
  }
  if (matches.length > 1) {
    // The schema's composite unique should make this impossible; treating it
    // as fatal rather than picking one keeps that assumption honest.
    return {
      ok: false,
      reasonCode: "PROFILE_AMBIGUOUS",
      message: `${matches.length} profiles match the configured identity; refusing to guess which one to trade.`,
    };
  }
  if (!matches[0].safetyPolicy) {
    return {
      ok: false,
      reasonCode: "PROFILE_POLICY_MISSING",
      message: "The profile has no safety policy, so no capacity limit or kill switch exists. Refusing to proceed.",
    };
  }

  return { ok: true, profile: matches[0] };
}

export interface BootstrapResult {
  created: boolean;
  profileId: string;
  /** Always true for a newly created policy. */
  killSwitchActive: boolean;
  isEnabled: boolean;
  policy: {
    maxOpenPositions: number;
    maxPendingEntries: number;
    maxTotalActiveTrades: number;
    maxTotalPlannedRiskUsd: string;
    maxTotalIsolatedMarginUsd: string;
  };
}

/**
 * Creates the profile and its safety policy if absent. Idempotent: a second run
 * returns the existing rows untouched.
 *
 * Deliberately relies on the SCHEMA DEFAULTS for every limit and for both
 * switches rather than restating them — one source of truth, and a future
 * change to the canary policy cannot drift between schema and bootstrap.
 *
 * Never disables a kill switch, never enables a profile, never creates a
 * TradeExecution and never contacts Binance.
 */
export async function ensureExecutionProfile(
  prisma: PrismaClient,
  identity: ProfileIdentity = configuredProfileIdentity()
): Promise<BootstrapResult> {
  if (identity.accountIdentifier === "") {
    throw new Error("EXECUTION_PROFILE_ACCOUNT_IDENTIFIER must be set before bootstrapping a profile.");
  }

  const existing = await prisma.executionProfile.findUnique({
    where: {
      exchange_environment_accountIdentifier: {
        exchange: "BINANCE",
        environment: identity.environment,
        accountIdentifier: identity.accountIdentifier,
      },
    },
    include: { safetyPolicy: true },
  });

  const profile =
    existing ??
    (await prisma.executionProfile.create({
      data: {
        name: `Binance USDⓈ-M ${identity.environment}`,
        accountIdentifier: identity.accountIdentifier,
        environment: identity.environment,
        // isEnabled stays false: bootstrap grants capacity, not permission.
      },
      include: { safetyPolicy: true },
    }));

  const policy =
    profile.safetyPolicy ??
    (await prisma.executionSafetyPolicy.create({
      // Every limit and killSwitchActive=true come from the schema defaults.
      data: { executionProfileId: profile.id },
    }));

  return {
    created: existing === null,
    profileId: profile.id,
    killSwitchActive: policy.killSwitchActive,
    isEnabled: profile.isEnabled,
    policy: {
      maxOpenPositions: policy.maxOpenPositions,
      maxPendingEntries: policy.maxPendingEntries,
      maxTotalActiveTrades: policy.maxTotalActiveTrades,
      maxTotalPlannedRiskUsd: policy.maxTotalPlannedRiskUsd.toFixed(),
      maxTotalIsolatedMarginUsd: policy.maxTotalIsolatedMarginUsd.toFixed(),
    },
  };
}
