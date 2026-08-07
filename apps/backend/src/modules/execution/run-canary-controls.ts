import { PrismaClient } from "@prisma/client";
import { env } from "../../config/env";
import { CanaryPreflightService } from "./canary-preflight.service";
import {
  CanaryAuthorizationAlreadyActiveError,
  CanaryAuthorizationService,
  DEFAULT_AUTHORIZATION_TTL_MINUTES,
  MINIMUM_REMAINING_LIFETIME_MS,
  describeAuthorizationWindow,
} from "./canary-authorization.service";
import { validateCanarySymbol } from "./canary-symbol-validation";
import { configuredProfileIdentity, resolveExecutionProfile } from "./execution-profile.service";

/**
 * Phase 11B.0 — operator controls for the first live canary.
 *
 * Four commands, all operating on EXACTLY the configured profile
 * (`EXECUTION_PROFILE_ACCOUNT_IDENTIFIER` + `EXECUTION_PROFILE_ENVIRONMENT`).
 * None accepts an arbitrary profile id, none edits `.env`, none contacts
 * Binance with anything but a read, and none has a --force, --skip-safety or
 * --ignore-anything flag. A blocker is information, not an obstacle.
 *
 * The asymmetry is deliberate: moving TOWARD danger (arm) demands an explicit
 * confirmation flag and a long list of satisfied preconditions, while moving
 * toward safety (close-window, disarm) requires nothing and should be easy to
 * run in a hurry.
 */

const CONFIRM_ARM = "--confirm-arm";

function line(label: string, value: string | number | boolean | null | undefined): void {
  console.log(`  ${label.padEnd(30)} ${value === null || value === undefined ? "—" : String(value)}`);
}

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const match = process.argv.find((entry) => entry.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : null;
}

/** Every gate that must still be SAFE while preparing. */
function environmentIsStillSafe(): boolean {
  return (
    env.EXECUTION_GLOBAL_KILL_SWITCH &&
    !env.EXECUTION_LIVE_ENTRY_ENABLED &&
    !env.EXECUTION_PROTECTION_READY &&
    !env.BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED &&
    !env.BINANCE_TEST_ORDER_ENABLED
  );
}

/** Every gate that must already be OPEN before arming. */
function environmentIsArmed(): boolean {
  return (
    !env.EXECUTION_GLOBAL_KILL_SWITCH &&
    env.EXECUTION_LIVE_ENTRY_ENABLED &&
    env.EXECUTION_PROTECTION_READY &&
    !env.BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED &&
    !env.BINANCE_TEST_ORDER_ENABLED &&
    !env.EXECUTION_AUTO_ADD_MARGIN_ENABLED &&
    env.EXECUTION_EMERGENCY_CLOSE_MODE === "DISABLED"
  );
}

async function withPrisma<T>(run: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient();
  try {
    return await run(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

/**
 * Creates the symbol allowlist and ONE short-lived authorization, while
 * everything is still safe. Keeps the profile disabled and its kill switch
 * engaged — preparing is not arming.
 */
export async function prepareCanary(): Promise<void> {
  const symbol = (arg("symbol") ?? "").trim().toUpperCase();
  const direction = (arg("direction") ?? "").trim().toUpperCase();
  const ttlMinutes = Number(arg("ttl-minutes") ?? DEFAULT_AUTHORIZATION_TTL_MINUTES);

  console.log("PREPARE CANARY (Phase 11B.0) — creates an authorization; arms nothing.");
  console.log("");

  if (!symbol || (direction !== "LONG" && direction !== "SHORT")) {
    console.log("Usage: execution:prepare-canary -- --symbol=BTCUSDT --direction=LONG [--ttl-minutes=10]");
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 60) {
    console.log("--ttl-minutes must be between 1 and 60.");
    process.exitCode = 1;
    return;
  }

  await withPrisma(async (prisma) => {
    const identity = configuredProfileIdentity();
    const resolution = await resolveExecutionProfile(prisma, identity);
    if (!resolution.ok) {
      console.log(`BLOCKED — ${resolution.reasonCode}: ${resolution.message}`);
      process.exitCode = 1;
      return;
    }
    const profile = resolution.profile;

    // --- Everything must still be SAFE -----------------------------------
    const blockers: string[] = [];
    if (profile.environment !== "MAINNET") blockers.push(`profile environment is ${profile.environment}, not MAINNET`);
    if (profile.isEnabled) blockers.push("profile is already enabled");
    if (profile.safetyPolicy?.killSwitchActive !== true) blockers.push("profile kill switch is already disengaged");
    if (!environmentIsStillSafe()) blockers.push("environment activation gates are not all still safe");

    const preflight = await new CanaryPreflightService(prisma).run();
    for (const finding of preflight.preparationBlockers) blockers.push(`${finding.code}: ${finding.detail}`);

    if (blockers.length > 0) {
      console.log("BLOCKED — prepare requires a completely safe, clean starting state:");
      for (const blocker of blockers) console.log(`  - ${blocker}`);
      process.exitCode = 1;
      return;
    }

    // --- The symbol must be real, BEFORE anything is written --------------
    // Read-only exchange metadata, the same GETs the Phase 3 planner uses.
    // Nothing below this point can leave a half-applied state, because the
    // allowlist change and the authorization share one transaction.
    const validation = await validateCanarySymbol(symbol);
    if (!validation.ok) {
      console.log(`BLOCKED — ${validation.reasonCode}: ${validation.message}`);
      console.log("Neither allowedSymbols nor any authorization was changed.");
      process.exitCode = 1;
      return;
    }

    let prepared: { authorization: { allowedSymbol: string; allowedDirection: string; expiresAt: Date }; token: string };
    try {
      prepared = await new CanaryAuthorizationService(prisma).prepare(
        {
          executionProfileId: profile.id,
          symbol: validation.symbol,
          direction: direction as "LONG" | "SHORT",
          ttlMinutes,
        },
        // Defence in depth, in the SAME transaction: [] means ALLOW ALL in
        // SafetyAdmissionService, so leaving it empty would be the opposite of
        // what a canary wants.
        async (tx) => {
          await tx.executionSafetyPolicy.update({
            where: { executionProfileId: profile.id },
            data: { allowedSymbols: [validation.symbol] },
          });
        }
      );
    } catch (error) {
      if (error instanceof CanaryAuthorizationAlreadyActiveError) {
        console.log(`BLOCKED — ${error.reasonCode}: ${error.message}`);
        console.log("Nothing was changed. Explicit disarm is required before a new window opens.");
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    const { authorization, token } = prepared;

    console.log("PREPARED.");
    line("symbol", authorization.allowedSymbol);
    line("direction", authorization.allowedDirection);
    line("expiresAt", authorization.expiresAt.toISOString());
    // The VALIDATED symbol, which is what was actually written — not the raw
    // argument, which may have been a prefixed or suffixed ticker.
    line("allowedSymbols", `[${validation.symbol}]`);
    line("profile isEnabled", profile.isEnabled);
    line("profile killSwitch", true);
    console.log("");
    console.log("ONE-TIME AUTHORIZATION — shown once, never stored in this form, never logged:");
    console.log("");
    console.log(`  ${token}`);
    console.log("");
    console.log("Put it in the TradingView alert body as the canaryAuthorization field.");
    console.log("It authorizes ONE signal on that symbol and direction and expires automatically.");
    console.log("No Binance mutation was sent. The profile remains disabled with its kill switch engaged.");
  });
}

// ---------------------------------------------------------------------------
// arm
// ---------------------------------------------------------------------------

/**
 * The FINAL action before a canary. Flips only the two dynamic database
 * values, and only once the operator has already changed `.env` and restarted —
 * so a process start can never trade on its own.
 */
export async function armCanary(): Promise<void> {
  const confirmed = process.argv.includes(CONFIRM_ARM);

  console.log("ARM CANARY (Phase 11B.0) — the final step before a real trade.");
  console.log("");

  await withPrisma(async (prisma) => {
    const resolution = await resolveExecutionProfile(prisma, configuredProfileIdentity());
    if (!resolution.ok) {
      console.log(`BLOCKED — ${resolution.reasonCode}: ${resolution.message}`);
      process.exitCode = 1;
      return;
    }
    const profile = resolution.profile;
    const authorizations = new CanaryAuthorizationService(prisma);
    const active = await authorizations.findActive(profile.id);
    const activeCount = await authorizations.countActive(profile.id);

    const blockers: string[] = [];
    if (!active) blockers.push("no active unexpired authorization is prepared");
    // Prepare now refuses to create a second window, but arming re-checks it
    // independently: this is the last gate before real money, and it should not
    // depend on another command having behaved.
    if (activeCount > 1) {
      blockers.push(`${activeCount} authorizations are active; exactly one is required — run execution:disarm-canary`);
    }
    if (active && active.expiresAt.getTime() - Date.now() < MINIMUM_REMAINING_LIFETIME_MS) {
      // Arming, a final preflight and sending the alert all take time.
      blockers.push("the authorization is too close to expiry; prepare a fresh one");
    }
    if (active && profile.safetyPolicy) {
      const allow = profile.safetyPolicy.allowedSymbols;
      if (allow.length !== 1 || allow[0] !== active.allowedSymbol) {
        blockers.push("the symbol allowlist does not match the authorization exactly");
      }
    }
    if (!environmentIsArmed()) {
      blockers.push("environment activation gates are not in the required state (edit .env and restart FIRST)");
    }

    const preflight = await new CanaryPreflightService(prisma).run();
    for (const finding of preflight.preparationBlockers) blockers.push(`${finding.code}: ${finding.detail}`);

    console.log("Preconditions");
    line("profile", `${profile.accountIdentifier} (${profile.environment})`);
    line("authorization", active ? `${active.allowedSymbol} ${active.allowedDirection}` : "none");
    line("active authorization count", activeCount);
    line("expiresAt", active ? active.expiresAt.toISOString() : null);
    line("env gates armed", environmentIsArmed());
    line("Binance positions", preflight.gathered.binance.nonZeroPositionCount);
    line("Binance open orders", preflight.gathered.binance.openOrderCount);
    line("local active", preflight.gathered.local.activeExecutionCount);
    line("local recovery", preflight.gathered.local.recoveryRequiredCount);
    line("confirmation flag", confirmed);
    console.log("");

    if (blockers.length > 0) {
      console.log("BLOCKED — nothing was changed:");
      for (const blocker of blockers) console.log(`  - ${blocker}`);
      process.exitCode = 1;
      return;
    }
    if (!confirmed) {
      console.log(`DRY RUN — every precondition passed. Re-run with ${CONFIRM_ARM} to arm.`);
      return;
    }

    // --- The two dynamic values, in one transaction ----------------------
    await prisma.$transaction(async (tx) => {
      await tx.executionProfile.update({ where: { id: profile.id }, data: { isEnabled: true } });
      await tx.executionSafetyPolicy.update({
        where: { executionProfileId: profile.id },
        data: { killSwitchActive: false },
      });
    });

    // Never trust the write — read it back.
    const verified = await prisma.executionProfile.findUniqueOrThrow({
      where: { id: profile.id },
      include: { safetyPolicy: true },
    });
    const armed = verified.isEnabled && verified.safetyPolicy?.killSwitchActive === false;

    console.log(armed ? "ARMED." : "ARM NOT VERIFIED — re-check before sending anything.");
    line("profile isEnabled", verified.isEnabled);
    line("profile killSwitch", verified.safetyPolicy?.killSwitchActive);
    console.log("");
    console.log("Send exactly ONE authorized signal, confirm one ENTRY_PENDING, then run");
    console.log("execution:close-canary-window immediately.");
    if (!armed) process.exitCode = 1;
  });
}

// ---------------------------------------------------------------------------
// close window
// ---------------------------------------------------------------------------

/**
 * Stops NEW work instantly. Its first action is the profile kill switch, which
 * is a database value and therefore needs no restart.
 *
 * It touches no execution, cancels nothing, contacts Binance never, and leaves
 * reconciliation and Phase 7 protection running — an existing trade must keep
 * being managed.
 */
export async function closeCanaryWindow(): Promise<void> {
  console.log("CLOSE CANARY WINDOW — blocks new work immediately. Existing trades keep running.");
  console.log("");

  await withPrisma(async (prisma) => {
    const resolution = await resolveExecutionProfile(prisma, configuredProfileIdentity());
    if (!resolution.ok) {
      console.log(`BLOCKED — ${resolution.reasonCode}: ${resolution.message}`);
      process.exitCode = 1;
      return;
    }
    const profile = resolution.profile;

    // FIRST action, before anything is reported.
    await prisma.executionSafetyPolicy.update({
      where: { executionProfileId: profile.id },
      data: { killSwitchActive: true },
    });

    const [active, recovery, authorization] = await Promise.all([
      prisma.tradeExecution.count({
        where: {
          executionProfileId: profile.id,
          status: {
            in: ["PLAN_READY", "PREFLIGHT", "ENTRY_SUBMITTING", "ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "PROTECTED"],
          },
        },
      }),
      prisma.tradeExecution.count({
        where: {
          executionProfileId: profile.id,
          OR: [
            { status: { in: ["ENTRY_SUBMITTING", "PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "MANUAL_INTERVENTION"] } },
            { requiresManualIntervention: true },
          ],
        },
      }),
      new CanaryAuthorizationService(prisma).listForProfile(profile.id),
    ]);

    console.log("CLOSED — profile kill switch is engaged. No new admission is possible.");
    line("active executions", active);
    line("recovery required", recovery);
    const status = describeAuthorizationWindow(authorization);
    line("authorization active", status.prepared);
    line("authorization symbol", status.symbol);
    line("authorization direction", status.direction);
    line("consumed", status.consumed);
    line("revoked", status.revoked);
    line("active authorization count", status.activeCount);
    line("authorizations on record", status.onRecord);
    console.log("");
    if (active > 0 || recovery > 0) {
      console.log("A live execution still exists. It was NOT cancelled and NOT closed.");
      console.log("Leave the worker running: reconciliation and protection must continue.");
    } else {
      console.log("No live execution remains. Safe to restore the environment gates and restart.");
    }
    console.log("Nothing was sent to Binance.");
  });
}

// ---------------------------------------------------------------------------
// disarm
// ---------------------------------------------------------------------------

/**
 * Full return to safety. Engages the kill switch first, revokes anything
 * unused, then disables the profile ONLY when nothing is left running.
 *
 * The symbol allowlist is deliberately left narrow: widening it back to []
 * would mean "allow every symbol", which is the opposite of safe.
 */
export async function disarmCanary(): Promise<void> {
  console.log("DISARM CANARY — returns to the safe posture.");
  console.log("");

  await withPrisma(async (prisma) => {
    const resolution = await resolveExecutionProfile(prisma, configuredProfileIdentity());
    if (!resolution.ok) {
      console.log(`BLOCKED — ${resolution.reasonCode}: ${resolution.message}`);
      process.exitCode = 1;
      return;
    }
    const profile = resolution.profile;

    // 1. Kill switch FIRST.
    await prisma.executionSafetyPolicy.update({
      where: { executionProfileId: profile.id },
      data: { killSwitchActive: true },
    });

    // 2. Revoke anything unused.
    const revoked = await new CanaryAuthorizationService(prisma).revokeUnused(profile.id);

    // 3. Only then consider disabling the profile.
    const outstanding = await prisma.tradeExecution.count({
      where: {
        executionProfileId: profile.id,
        OR: [
          {
            status: {
              in: ["PLAN_READY", "PREFLIGHT", "ENTRY_SUBMITTING", "ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "PROTECTED", "MANUAL_INTERVENTION"],
            },
          },
          { requiresManualIntervention: true },
        ],
      },
    });

    let outcome: string;
    if (outstanding > 0) {
      // The profile stays intact: reconciliation and protection need it.
      outcome = "CANARY_DISARMED_NEW_WORK_BLOCKED_RECOVERY_CONTINUES";
    } else {
      await prisma.executionProfile.update({ where: { id: profile.id }, data: { isEnabled: false } });
      outcome = "CANARY_DISARMED_CLEAN";
    }

    const verified = await prisma.executionProfile.findUniqueOrThrow({
      where: { id: profile.id },
      include: { safetyPolicy: true },
    });

    console.log(outcome);
    line("profile isEnabled", verified.isEnabled);
    line("profile killSwitch", verified.safetyPolicy?.killSwitchActive);
    line("authorizations revoked", revoked);
    line("outstanding executions", outstanding);
    line("allowedSymbols", `[${(verified.safetyPolicy?.allowedSymbols ?? []).join(", ")}]`);
    console.log("");
    if (outstanding > 0) {
      console.log("Work is still outstanding — the profile was NOT disabled and nothing was cancelled.");
      console.log("Keep the worker running until it reaches a terminal state.");
    }
    console.log("The symbol allowlist is left narrow on purpose: [] would mean allow ALL.");
    console.log("Nothing was sent to Binance. No environment variable was changed.");
  });
}
