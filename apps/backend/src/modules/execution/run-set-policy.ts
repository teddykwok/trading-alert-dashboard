import { PrismaClient } from "@prisma/client";
import { env } from "../../config/env";
import { OptimisticLockError } from "./execution.service";
import { CANARY_POLICY, effectiveCanaryLimits, type CanaryPolicyLimits } from "./canary-readiness";
import { configuredProfileIdentity, resolveExecutionProfile } from "./execution-profile.service";
import { SafetyPolicyService, type SafetyPolicyValues } from "./safety-policy.service";

/**
 * Operator tool for the profile's MONETARY safety limits.
 *
 *   pnpm --filter @trading-alert-dashboard/backend execution:set-policy -- \
 *     --max-total-isolated-margin-usd=8.00
 *
 * DRY RUN unless `--confirm` is passed. The dry run resolves the profile, reads
 * the row, validates the request through the same service the write uses, and
 * prints current / proposed / effective — then states plainly that nothing was
 * written.
 *
 * SCOPE — deliberately two fields:
 *
 *   --max-total-isolated-margin-usd
 *   --max-total-planned-risk-usd
 *
 * `SafetyPolicyService` also validates the four capacity counts, the alert-age
 * limit, `allowedSymbols` and `killSwitchActive`, and this CLI exposes none of
 * them. Capacity is pinned at 1/1/1/1 for the canary; `allowedSymbols` is owned
 * by execution:prepare-canary, which writes it inside the same transaction as
 * the authorization; and the kill switch is the arming path, which already has
 * its own commands with their own preconditions. Widening this tool to those
 * fields would put "relax a limit" and "release a safety interlock" behind the
 * same flag, so it does not.
 *
 * It contacts NO Binance endpoint, creates no execution, touches no
 * authorization and cannot arm anything. Every write goes through
 * `SafetyPolicyService.updateForProfile`, including its optimistic lock — there
 * is no Prisma mutation in this file. There is no --force and no way to skip
 * the version check.
 */

const CONFIRM = "--confirm";

/**
 * Only the fields this CLI is allowed to touch.
 *
 * `kind` is PARSING only — how the flag text becomes the type
 * `SafetyPolicyValues` declares. Every rule about what is acceptable still
 * belongs to SafetyPolicyService; a malformed integer is turned into NaN here
 * precisely so the service rejects it by name rather than this file inventing
 * a second opinion.
 *
 * Still deliberately absent: killSwitchActive (the arming path has its own
 * commands), allowedSymbols (owned by execution:prepare-canary, which writes
 * it in the same transaction as the authorization) and maxAlertAgeSeconds.
 */
const SUPPORTED_FIELDS = [
  { flag: "soft-open-position-target", field: "softOpenPositionTarget", kind: "integer" },
  { flag: "max-open-positions", field: "maxOpenPositions", kind: "integer" },
  { flag: "max-pending-entries", field: "maxPendingEntries", kind: "integer" },
  { flag: "max-total-active-trades", field: "maxTotalActiveTrades", kind: "integer" },
  { flag: "max-active-per-symbol-side", field: "maxActivePerSymbolSide", kind: "integer" },
  { flag: "max-total-planned-risk-usd", field: "maxTotalPlannedRiskUsd", kind: "decimal" },
  { flag: "max-total-isolated-margin-usd", field: "maxTotalIsolatedMarginUsd", kind: "decimal" },
] as const satisfies ReadonlyArray<{
  flag: string;
  field: keyof SafetyPolicyValues & keyof CanaryPolicyLimits;
  kind: "integer" | "decimal";
}>;

/**
 * Flag text -> the declared type, with NO coercion of anything questionable.
 *
 * Only a plain optionally-signed run of digits becomes a number; "2.5", "1e3",
 * "0x10", " 3 " and "" all become NaN, which `assertPositiveInt` rejects with
 * the field name. Decimals are passed through verbatim for the service to
 * judge, exactly as before.
 */
function parseFlag(raw: string, kind: "integer" | "decimal"): string | number {
  return kind === "decimal" ? raw : /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
}

function line(label: string, value: string | number | boolean | null | undefined): void {
  console.log(`  ${label.padEnd(34)} ${value === null || value === undefined ? "—" : String(value)}`);
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const match = process.argv.find((entry) => entry.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : null;
}

/** The env-wide limits this profile's row is merged against. */
function globalLimits(): CanaryPolicyLimits {
  return {
    maxOpenPositions: env.EXECUTION_MAX_OPEN_POSITIONS,
    maxPendingEntries: env.EXECUTION_MAX_PENDING_ENTRIES,
    maxTotalActiveTrades: env.EXECUTION_MAX_TOTAL_ACTIVE_TRADES,
    maxActivePerSymbolSide: env.EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE,
    softOpenPositionTarget: env.EXECUTION_SOFT_OPEN_POSITION_TARGET,
    maxTotalPlannedRiskUsd: env.EXECUTION_MAX_TOTAL_PLANNED_RISK_USD,
    maxTotalIsolatedMarginUsd: env.EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD,
  };
}

async function withPrisma<T>(run: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient();
  try {
    return await run(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

export async function setPolicy(): Promise<void> {
  const confirmed = process.argv.includes(CONFIRM);

  const requested: SafetyPolicyValues = {};
  const requestedFields: Array<(typeof SUPPORTED_FIELDS)[number]> = [];
  for (const supported of SUPPORTED_FIELDS) {
    const raw = arg(supported.flag);
    if (raw === null) continue;
    // The service owns validation; this only turns text into the declared
    // type. Anything it cannot parse becomes NaN so the service rejects it.
    (requested[supported.field] as string | number) = parseFlag(raw, supported.kind);
    requestedFields.push(supported);
  }

  console.log("EXECUTION SAFETY POLICY — operator update. No Binance call is possible from this command.");

  if (requestedFields.length === 0) {
    console.log("");
    console.log("No policy value was requested. Supported flags:");
    for (const supported of SUPPORTED_FIELDS) {
      console.log(`  --${supported.flag}=<${supported.kind === "integer" ? "positive integer" : "decimal"}>`);
    }
    console.log(`Add ${CONFIRM} to write; without it this command only reports.`);
    process.exitCode = 1;
    return;
  }

  await withPrisma(async (prisma) => {
    const identity = configuredProfileIdentity();
    const resolution = await resolveExecutionProfile(prisma, identity);
    if (!resolution.ok) {
      // Fail closed: never create a profile here. execution:ensure-profile owns
      // that, deliberately, so capacity is only ever granted on purpose.
      console.log("");
      console.log(`Profile could not be resolved (${resolution.reasonCode}): ${resolution.message}`);
      process.exitCode = 1;
      return;
    }

    const profile = resolution.profile;
    const policies = new SafetyPolicyService(prisma);
    const current = await policies.getByProfileId(profile.id);
    if (!current) {
      console.log("");
      console.log("No safety policy row exists for this profile. Run execution:ensure-profile first.");
      process.exitCode = 1;
      return;
    }

    section("Target");
    // The environment is the single most important thing on this screen.
    line("environment", profile.environment === "MAINNET" ? "MAINNET — REAL FUNDS" : profile.environment);
    line("profile isEnabled", profile.isEnabled);
    line("killSwitchActive", current.killSwitchActive);
    line("policy row version", current.version);

    // Validate BEFORE any arithmetic on the requested values: the merge below
    // parses them as decimals, and "abc" must be rejected by the service's
    // rules rather than blowing up inside a Decimal constructor.
    try {
      // `current` is passed so the cross-field invariants are evaluated on the
      // FINAL merged row, not just the flags this command happened to supply.
      policies.assertValidValues(requested, current);
    } catch (error) {
      section("NOT APPLIED");
      console.log(`  Requested values are INVALID: ${error instanceof Error ? error.message : String(error)}`);
      console.log("  NO DATABASE WRITE WAS PERFORMED.");
      process.exitCode = 1;
      return;
    }

    const currentLimits: CanaryPolicyLimits = {
      maxOpenPositions: current.maxOpenPositions,
      maxPendingEntries: current.maxPendingEntries,
      maxTotalActiveTrades: current.maxTotalActiveTrades,
      maxActivePerSymbolSide: current.maxActivePerSymbolSide,
      softOpenPositionTarget: current.softOpenPositionTarget,
      maxTotalPlannedRiskUsd: current.maxTotalPlannedRiskUsd.toFixed(),
      maxTotalIsolatedMarginUsd: current.maxTotalIsolatedMarginUsd.toFixed(),
    };
    const proposedLimits: CanaryPolicyLimits = { ...currentLimits };
    for (const supported of requestedFields) {
      (proposedLimits[supported.field] as string | number) = requested[supported.field] as string | number;
    }

    const globals = globalLimits();
    const effectiveNow = effectiveCanaryLimits(globals, currentLimits);
    const effectiveNext = effectiveCanaryLimits(globals, proposedLimits);

    section("Requested change");
    for (const supported of requestedFields) {
      const field = supported.field;
      console.log(`  ${field}`);
      line("    current row", currentLimits[field]);
      line("    proposed row", proposedLimits[field]);
      line("    global (env)", globals[field]);
      line("    effective now", effectiveNow[field]);
      line("    effective after", effectiveNext[field]);
      line("    canary requires", CANARY_POLICY[field]);
    }

    if (!confirmed) {
      section("DRY RUN");
      console.log(`  NO DATABASE WRITE WAS PERFORMED. Re-run with ${CONFIRM} to apply.`);
      return;
    }

    try {
      // The row version read above is supplied verbatim: a concurrent change
      // between the read and this write fails rather than overwriting it.
      const updated = await policies.updateForProfile(profile.id, current.version, requested);
      section("APPLIED");
      line("policy row version", `${current.version} → ${updated.version}`);
      for (const supported of requestedFields) {
        // Read back from the PERSISTED row, never from the request, so the
        // printed value is what the database actually holds.
        const persisted = updated[supported.field];
        line(supported.field, supported.kind === "decimal" ? String(persisted) : (persisted as number));
      }
      console.log("");
      console.log("  Run execution:canary-preflight to confirm the effective policy.");
    } catch (error) {
      section("NOT APPLIED");
      if (error instanceof OptimisticLockError) {
        console.log(
          `  The policy row changed since it was read (version ${current.version} is stale). ` +
            "Nothing was written. Re-run to see the current values."
        );
      } else {
        console.log(`  ${error instanceof Error ? error.message : String(error)}`);
      }
      process.exitCode = 1;
    }
  });
}
