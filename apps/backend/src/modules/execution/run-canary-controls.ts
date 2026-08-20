import { PrismaClient } from "@prisma/client";
import { env } from "../../config/env";
import { CanaryPreflightService } from "./canary-preflight.service";
import type { ExecutionCanaryAuthorization } from "@prisma/client";
import {
  currentProcessGateSnapshot,
  readRuntimeAttestationStatusOnce,
  type RuntimeAttestationStatus,
} from "../runtime/runtime-attestation";
import { CANARY_PREPARE_LOCK_NAMESPACE } from "./canary-authorization.service";
import { profileLockKey } from "./profile-lock";
import {
  CanaryAuthorizationAlreadyActiveError,
  CanaryAuthorizationService,
  DEFAULT_AUTHORIZATION_TTL_MINUTES,
  MINIMUM_REMAINING_LIFETIME_MS,
  describeAuthorizationSubject,
  describeAuthorizationWindow,
  NaturalWindowValidationError,
  type PrepareResult,
} from "./canary-authorization.service";
import {
  MAXIMUM_AUTHORIZATION_TTL_MINUTES,
  describeNaturalWindow,
  normalizeNaturalDirections,
} from "./natural-authorization";
import {
  NATURAL_ARM_MINIMUM_REMAINING_MS,
  armNaturalWindow as armNaturalWindowTransactional,
  evaluateNaturalWindowForArm,
} from "./natural-arm";
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

/**
 * Phase 12.4A natural-window writes follow the `execution:set-policy`
 * convention rather than arm's: DRY RUN by default, `--confirm` to apply.
 * Arming keeps its own `--confirm-arm` because it is the one command that
 * starts real trading; preparing a window is a policy-shaped write, so it reads
 * like one.
 *
 * The emergency paths — `close-canary-window` and `disarm-canary` — deliberately
 * take NO flag at all, so reaching safety stays instant.
 *
 * None of the natural commands touches `allowedSymbols`, the Asset table,
 * TradingView or Binance. A natural window authorizes PROFILE + DIRECTION +
 * TIME + CUMULATIVE CLAIM BUDGET, and nothing about a ticker.
 */
const CONFIRM = "--confirm";

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

    // The service's own result type, rather than a hand-written structural
    // one: `prepare` creates an EXACT_SIGNAL row, and restating its shape here
    // would silently drift the moment the model gains a mode.
    let prepared: PrepareResult;
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
/**
 * Phase 12.4D-A.1 — the shared activation interlock.
 *
 * Both arm paths create the identical ARMED pair, so both consult this. It is
 * read BEFORE any Prisma transaction opens: Phase 12.4C forbids network I/O
 * inside the shared advisory-lock critical section, and Redis is network I/O.
 *
 * The residual that ordering leaves is honest and accepted — a runtime can die
 * in the gap between this read and the DB commit. This interlock's job is
 * narrower: make it impossible to KNOWINGLY arm against a runtime that is
 * already missing, stale, duplicated or running a different .env snapshot.
 * Operator CLOSE/DISARM and the runtime's own safety remain the response to a
 * runtime that dies afterwards.
 *
 * Deliberately NOT applied to close-canary-window or disarm-canary: a safety-off
 * action must never depend on the runtime being healthy, or on Redis being
 * reachable at all.
 */
async function evaluateRuntimeAttestation(): Promise<RuntimeAttestationStatus> {
  const identity = configuredProfileIdentity();
  // One-shot client: this is a short-lived CLI, so it must not hold the shared
  // BullMQ connection open or the command would never exit.
  return readRuntimeAttestationStatusOnce({
    identity: { accountIdentifier: identity.accountIdentifier, environment: identity.environment },
    // This command's OWN parsed snapshot. Both runtimes must match it.
    expected: currentProcessGateSnapshot(),
  });
}

/** Prints the attestation block shown by both arm commands. */
function reportRuntimeAttestation(status: RuntimeAttestationStatus): void {
  console.log("Runtime attestation");
  for (const role of [status.backend, status.worker]) {
    line(`  ${role.role.toLowerCase()} instances`, `${role.freshCount} fresh / ${role.staleCount} stale`);
    if (role.gates) {
      line("    globalKillSwitch", role.gates.globalKillSwitch);
      line("    liveEntryEnabled", role.gates.liveEntryEnabled);
      line("    protectionReady", role.gates.protectionReady);
      line("    accountSetupMutations", role.gates.accountSetupMutationsEnabled);
      line("    testOrderEnabled", role.gates.testOrderEnabled);
      line("    autoAddMarginEnabled", role.gates.autoAddMarginEnabled);
      line("    emergencyCloseMode", role.gates.emergencyCloseMode);
    } else {
      line("    gates", "— (no fresh attestation)");
    }
  }
  line("  result", status.ok ? "PASS" : "BLOCKED");
  if (!status.ok) line("  reason", `${status.reasonCode}: ${status.message}`);
  console.log("");
}


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

    // Phase 12.4D-A.1: exact arm opens the SAME armed pair as natural arm, so it
    // carries the SAME interlock. Read before the transaction — never inside the
    // advisory lock. Nothing about token or one-shot semantics changes.
    const attestation = await evaluateRuntimeAttestation();
    if (!attestation.ok) blockers.push(`${attestation.reasonCode}: ${attestation.message}`);

    console.log("Preconditions");
    line("profile", `${profile.accountIdentifier} (${profile.environment})`);
    line("authorization", active ? describeAuthorizationSubject(active) : "none");
    line("active authorization count", activeCount);
    line("expiresAt", active ? active.expiresAt.toISOString() : null);
    line("env gates armed", environmentIsArmed());
    line("Binance positions", preflight.gathered.binance.nonZeroPositionCount);
    line("Binance open orders", preflight.gathered.binance.openOrderCount);
    line("local active", preflight.gathered.local.activeExecutionCount);
    line("local recovery", preflight.gathered.local.recoveryRequiredCount);
    line("confirmation flag", confirmed);
    console.log("");
    reportRuntimeAttestation(attestation);

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

    // --- Serialized, authoritative activation ----------------------------
    // The advisory lock is taken FIRST and every value that justifies arming
    // is re-read under it. Adding the lock around the pre-lock snapshot would
    // be decorative: a concurrent disarm revokes the authorization and leaves
    // the policy row byte-identical, so nothing about the stale snapshot could
    // reveal it. Only a post-lock re-read can.
    //
    // The Binance preflight above deliberately stays OUTSIDE this block: no
    // network call may run while the operator lock is held.
    const armOutcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CANARY_PREPARE_LOCK_NAMESPACE}::int, ${profileLockKey(
        profile.id
      )}::int)`;

      const fresh = await tx.executionProfile.findUnique({
        where: { id: profile.id },
        include: { safetyPolicy: true },
      });
      if (!fresh) return { ok: false as const, reason: "the execution profile no longer exists." };
      const freshPolicy = fresh.safetyPolicy;
      if (!freshPolicy) return { ok: false as const, reason: "the profile has no safety policy row." };

      const now = new Date();
      const freshActive = await authorizations.findActive(profile.id, now, tx);
      const freshCount = await authorizations.countActive(profile.id, now, tx);

      if (!freshActive) {
        return {
          ok: false as const,
          reason: "no active unexpired authorization remains — it was revoked, consumed or expired while arming.",
        };
      }
      if (freshActive.id !== active!.id) {
        return { ok: false as const, reason: "the active authorization changed while arming." };
      }
      if (freshCount > 1) {
        return { ok: false as const, reason: `${freshCount} authorizations are active; exactly one is required.` };
      }
      if (freshActive.expiresAt.getTime() - now.getTime() < MINIMUM_REMAINING_LIFETIME_MS) {
        return { ok: false as const, reason: "the authorization is too close to expiry; prepare a fresh one." };
      }
      // The historical exact contract, unchanged: the allowlist must name
      // exactly the authorized symbol. A natural window's allowedSymbol is
      // null, so this still refuses one without exact arm knowing what a
      // natural window is.
      const allow = freshPolicy.allowedSymbols;
      if (allow.length !== 1 || allow[0] !== freshActive.allowedSymbol) {
        return { ok: false as const, reason: "the symbol allowlist no longer matches the authorization exactly." };
      }

      await tx.executionProfile.update({ where: { id: profile.id }, data: { isEnabled: true } });
      await tx.executionSafetyPolicy.update({
        where: { executionProfileId: profile.id },
        data: { killSwitchActive: false },
      });
      return { ok: true as const };
    });

    if (!armOutcome.ok) {
      console.log(`BLOCKED — ${armOutcome.reason}`);
      console.log("The profile was NOT armed.");
      process.exitCode = 1;
      return;
    }

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

    // FIRST action, before anything is reported — and serialized against every
    // other operator mutation on this profile. Without the lock an in-flight
    // arm could release the kill switch AFTER this engaged it, silently undoing
    // the fastest safety action the operator has.
    //
    // The bounded wait is deliberate: waiting briefly for an in-flight arm and
    // then authoritatively engaging safety beats returning fast with a write
    // that can be overwritten. Only DB work happens under the lock.
    const [active, recovery, authorization] = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CANARY_PREPARE_LOCK_NAMESPACE}::int, ${profileLockKey(
        profile.id
      )}::int)`;

      await tx.executionSafetyPolicy.update({
        where: { executionProfileId: profile.id },
        data: { killSwitchActive: true },
      });

      return Promise.all([
      tx.tradeExecution.count({
        where: {
          executionProfileId: profile.id,
          status: {
            in: ["PLAN_READY", "PREFLIGHT", "ENTRY_SUBMITTING", "ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "PROTECTED"],
          },
        },
      }),
      tx.tradeExecution.count({
        where: {
          executionProfileId: profile.id,
          OR: [
            { status: { in: ["ENTRY_SUBMITTING", "PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "MANUAL_INTERVENTION"] } },
            { requiresManualIntervention: true },
          ],
        },
      }),
      // Read inside the lock, so the report describes the state the close
      // actually committed rather than one a concurrent operator moved.
      new CanaryAuthorizationService(prisma).listForProfile(profile.id, tx),
      ]);
    });

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

    // The WHOLE shutdown is one serialized operation. It used to be three
    // unsynchronized statements, which let an in-flight arm interleave and
    // re-enable the profile after the operator had disarmed it. The ordering
    // inside is unchanged — kill switch first, then revoke, then the
    // conditional disable — it is simply atomic now.
    const { revoked, outstanding, outcome } = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CANARY_PREPARE_LOCK_NAMESPACE}::int, ${profileLockKey(
        profile.id
      )}::int)`;

      // 1. Kill switch FIRST.
      await tx.executionSafetyPolicy.update({
        where: { executionProfileId: profile.id },
        data: { killSwitchActive: true },
      });

      // 2. Revoke anything unused. Deliberately authorization-type agnostic:
      // an open NATURAL_WINDOW is revoked exactly like an unused exact one.
      // Claims already spent are never refunded and the row is never deleted.
      const revokedCount = await new CanaryAuthorizationService(prisma).revokeUnused(profile.id, new Date(), tx);

      // 3. Only then consider disabling the profile.
      const outstandingCount = await tx.tradeExecution.count({
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

      if (outstandingCount > 0) {
        // The profile stays intact: reconciliation and protection need it.
        return { revoked: revokedCount, outstanding: outstandingCount, outcome: "CANARY_DISARMED_NEW_WORK_BLOCKED_RECOVERY_CONTINUES" };
      }
      await tx.executionProfile.update({ where: { id: profile.id }, data: { isEnabled: false } });
      return { revoked: revokedCount, outstanding: outstandingCount, outcome: "CANARY_DISARMED_CLEAN" };
    });

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

// ---------------------------------------------------------------------------
// Phase 12.4A — natural-window operator controls
// ---------------------------------------------------------------------------

/** Parses `--directions=LONG,SHORT`. Returns null for anything unusable. */
function parseDirections(raw: string | null): string[] | null {
  if (raw === null || raw.trim() === "") return null;
  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
}

/**
 * Opens ONE natural window: directions, a cumulative claim budget and a bounded
 * expiry. No token is generated, because natural mode has no secret.
 */
export async function prepareNaturalWindow(): Promise<void> {
  const confirmed = process.argv.includes(CONFIRM);
  const rawDirections = parseDirections(arg("directions"));
  const rawMaxClaims = arg("max-claims");
  const rawTtl = arg("ttl-minutes");

  console.log("PREPARE NATURAL WINDOW (Phase 12.4A) — authorizes a direction and a budget, never a symbol.");
  console.log("");

  if (rawDirections === null || rawMaxClaims === null) {
    console.log(
      "Usage: execution:prepare-natural-window -- --directions=LONG[,SHORT] --max-claims=5 " +
        `[--ttl-minutes=${DEFAULT_AUTHORIZATION_TTL_MINUTES}] [${CONFIRM}]`
    );
    process.exitCode = 1;
    return;
  }

  // Validated through the SAME domain helpers the service uses, so the dry run
  // can never report a proposal the write would reject.
  const directions = normalizeNaturalDirections(rawDirections);
  if (directions === null) {
    console.log("BLOCKED — --directions must be a non-empty list of LONG and/or SHORT. Empty admits nothing.");
    process.exitCode = 1;
    return;
  }
  const maxClaims = Number(rawMaxClaims);
  if (!Number.isSafeInteger(maxClaims) || maxClaims < 1) {
    console.log("BLOCKED — --max-claims must be a whole number of at least 1. There is no unlimited mode.");
    process.exitCode = 1;
    return;
  }
  const ttlMinutes = rawTtl === null ? DEFAULT_AUTHORIZATION_TTL_MINUTES : Number(rawTtl);
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > MAXIMUM_AUTHORIZATION_TTL_MINUTES) {
    console.log(`BLOCKED — --ttl-minutes must be between 1 and ${MAXIMUM_AUTHORIZATION_TTL_MINUTES}.`);
    process.exitCode = 1;
    return;
  }

  await withPrisma(async (prisma) => {
    const resolution = await resolveExecutionProfile(prisma, configuredProfileIdentity());
    if (!resolution.ok) {
      console.log(`BLOCKED — ${resolution.reasonCode}: ${resolution.message}`);
      process.exitCode = 1;
      return;
    }
    const profile = resolution.profile;

    console.log("Proposed natural window");
    line("environment", profile.environment === "MAINNET" ? "MAINNET — REAL FUNDS" : profile.environment);
    line("authorizationType", "NATURAL_WINDOW");
    line("allowedDirections", `[${directions.join(", ")}]`);
    line("maxClaims", `${maxClaims} (cumulative; never refunded)`);
    line("claimedCount", 0);
    line("version", 1);
    line("ttlMinutes", ttlMinutes);
    // Projected, NOT reserved. The authoritative expiry is computed by the
    // service at apply time from ttlMinutes, so this line must not read as a
    // timestamp the operator already holds.
    line(
      "expiresAt (projected)",
      `${new Date(Date.now() + ttlMinutes * 60_000).toISOString()} — nothing is reserved until ${CONFIRM}`
    );
    line("allowedSymbol", "null — a window names no symbol");
    line("token", "none — natural authorization is server-side");
    line("profile isEnabled", profile.isEnabled);
    line("profile killSwitch", profile.safetyPolicy?.killSwitchActive ?? null);
    console.log("");

    if (!confirmed) {
      console.log("DRY RUN");
      console.log(`  NO DATABASE WRITE WAS PERFORMED. Re-run with ${CONFIRM} to apply.`);
      return;
    }

    let window: ExecutionCanaryAuthorization;
    try {
      // Exclusivity, validation and the write all belong to the Phase-2
      // service. Reproducing any of it here would create a second set of rules.
      window = await new CanaryAuthorizationService(prisma).prepareNaturalWindow({
        executionProfileId: profile.id,
        allowedDirections: directions,
        maxClaims,
        ttlMinutes,
      });
    } catch (error) {
      if (error instanceof CanaryAuthorizationAlreadyActiveError) {
        console.log(`NOT APPLIED — ${error.reasonCode}: ${error.message}`);
        console.log("  Nothing was changed. An open window must expire or be revoked first.");
        process.exitCode = 1;
        return;
      }
      if (error instanceof NaturalWindowValidationError) {
        console.log(`NOT APPLIED — ${error.reasonCode}: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    console.log("APPLIED.");
    line("authorization id", window.id);
    line("allowedDirections", `[${window.allowedDirections.join(", ")}]`);
    line("maxClaims", window.maxClaims);
    line("claimedCount", window.claimedCount);
    line("version", window.version);
    line("expiresAt", window.expiresAt.toISOString());
    console.log("");
    console.log("No token exists for a natural window; nothing goes into TradingView.");
    console.log("allowedSymbols, the profile gates and the safety policy were NOT touched.");
  });
}

/**
 * Read-only authorization status for the configured profile.
 *
 * Prints state, never secrets: a natural window has none, and an exact one has
 * only a hash that must not leave the service.
 */
export async function showAuthorization(): Promise<void> {
  console.log("AUTHORIZATION STATUS — read only. Nothing is prepared, revoked, consumed or claimed.");
  console.log("");

  await withPrisma(async (prisma) => {
    const resolution = await resolveExecutionProfile(prisma, configuredProfileIdentity());
    if (!resolution.ok) {
      console.log(`BLOCKED — ${resolution.reasonCode}: ${resolution.message}`);
      process.exitCode = 1;
      return;
    }
    const profile = resolution.profile;
    const now = new Date();
    const rows = await new CanaryAuthorizationService(prisma).listForProfile(profile.id);

    line("profile", `${profile.accountIdentifier} (${profile.environment})`);
    line("profile isEnabled", profile.isEnabled);
    line("profile killSwitch", profile.safetyPolicy?.killSwitchActive ?? null);
    line("authorizations on record", rows.length);
    console.log("");

    // EXACT rows keep their historical window summary, unchanged.
    const exact = rows.filter((row) => row.authorizationType === "EXACT_SIGNAL");
    const exactStatus = describeAuthorizationWindow(exact, now);
    console.log("EXACT_SIGNAL");
    line("  on record", exact.length);
    line("  prepared (active)", exactStatus.prepared);
    line("  symbol", exactStatus.symbol);
    line("  direction", exactStatus.direction);
    line("  expiresAt", exactStatus.expiresAt);
    line("  consumed", exactStatus.consumed);
    line("  revoked", exactStatus.revoked);
    line("  activeCount", exactStatus.activeCount);
    console.log("");

    const natural = rows.filter((row) => row.authorizationType === "NATURAL_WINDOW");
    console.log("NATURAL_WINDOW");
    line("  on record", natural.length);
    if (natural.length === 0) {
      line("  state", "none prepared");
    }
    for (const row of natural) {
      const status = describeNaturalWindow(row, now);
      console.log("");
      line("  authorization id", row.id);
      line("  state", status.state);
      line("  allowedDirections", `[${status.allowedDirections.join(", ")}]`);
      line("  maxClaims", status.maxClaims);
      line("  claimedCount", status.claimedCount);
      line("  remainingClaims", status.remainingClaims);
      line("  version", status.version);
      line("  createdAt", row.createdAt.toISOString());
      line("  expiresAt", status.expiresAt);
      line("  revokedAt", row.revokedAt ? row.revokedAt.toISOString() : null);
    }
    console.log("");
    console.log("No token or token hash is ever printed.");
  });
}

/**
 * Shuts one natural window. Future admissions only — an already-admitted
 * execution keeps its reservation, its protection and its spent claim.
 */
export async function revokeNaturalWindow(): Promise<void> {
  const confirmed = process.argv.includes(CONFIRM);
  const id = arg("id");

  console.log("REVOKE NATURAL WINDOW — blocks FUTURE admissions. Nothing already admitted is affected.");
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

    // Default to the open window so the operator does not have to paste an id
    // in the ordinary case; an explicit --id always wins.
    const target = id ?? (await authorizations.findNaturalWindow(profile.id))?.id ?? null;
    if (target === null) {
      console.log("BLOCKED — no open natural window for this profile. Pass --id=<authorization id> to target one.");
      process.exitCode = 1;
      return;
    }

    const before = await prisma.executionCanaryAuthorization.findUnique({ where: { id: target } });
    if (!before || before.executionProfileId !== profile.id || before.authorizationType !== "NATURAL_WINDOW") {
      console.log("BLOCKED — that id is not a natural window belonging to this profile.");
      process.exitCode = 1;
      return;
    }

    line("environment", profile.environment === "MAINNET" ? "MAINNET — REAL FUNDS" : profile.environment);
    line("authorization id", before.id);
    line("state", describeNaturalWindow(before, new Date()).state);
    line("allowedDirections", `[${before.allowedDirections.join(", ")}]`);
    line("claimedCount", `${before.claimedCount}/${before.maxClaims} (preserved; never refunded)`);
    console.log("");

    if (!confirmed) {
      console.log("DRY RUN");
      console.log(`  NO DATABASE WRITE WAS PERFORMED. Re-run with ${CONFIRM} to apply.`);
      return;
    }

    const revoked = await authorizations.revokeNaturalWindow(profile.id, target);
    const after = await prisma.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: target } });

    console.log(revoked ? "APPLIED." : "ALREADY REVOKED — nothing changed.");
    line("revokedAt", after.revokedAt ? after.revokedAt.toISOString() : null);
    line("claimedCount", after.claimedCount);
    line("maxClaims", after.maxClaims);
    line("allowedDirections", `[${after.allowedDirections.join(", ")}]`);
    console.log("");
    console.log("The row was kept. Revocation stops NEW admissions and refunds no claim.");
  });
}

// ---------------------------------------------------------------------------
// arm natural window (Phase 12.4C)
// ---------------------------------------------------------------------------

/**
 * Opens the profile for NATURAL admission.
 *
 * Deliberately a separate command from `arm-canary` rather than a mode flag on
 * it. Phase 12.4A pinned a regression proving a NATURAL_WINDOW cannot be armed
 * by the historical exact command, and routing both through one entry point
 * would make "which authorization am I arming?" a question of argument parsing
 * on the single command that starts real trading. Explicit intent is cheaper
 * than a careful reader.
 *
 * The operator must name the window by id. Arming "whatever is current" would
 * mean the row that gets armed is chosen by a query the operator never saw.
 */
export async function armNaturalCanary(): Promise<void> {
  const confirmed = process.argv.includes(CONFIRM_ARM);
  const authorizationId = (arg("id") ?? "").trim();

  console.log("ARM NATURAL WINDOW (Phase 12.4C) — opens the profile for natural admission.");
  console.log("");

  if (!authorizationId) {
    console.log(`Usage: execution:arm-natural-window -- --id=<authorization-id> [${CONFIRM_ARM}]`);
    console.log("The window must be named explicitly; there is no fuzzy selection.");
    process.exitCode = 1;
    return;
  }

  await withPrisma(async (prisma) => {
    const resolution = await resolveExecutionProfile(prisma, configuredProfileIdentity());
    if (!resolution.ok) {
      console.log(`BLOCKED — ${resolution.reasonCode}: ${resolution.message}`);
      process.exitCode = 1;
      return;
    }
    const profile = resolution.profile;
    const policy = profile.safetyPolicy;
    if (!policy) {
      console.log("BLOCKED — the profile has no safety policy row; effective limits cannot be proven.");
      process.exitCode = 1;
      return;
    }

    const window = await prisma.executionCanaryAuthorization.findUnique({ where: { id: authorizationId } });
    if (!window) {
      console.log(`BLOCKED — WINDOW_NOT_FOUND: no authorization exists with id ${authorizationId}.`);
      process.exitCode = 1;
      return;
    }

    const now = new Date();
    const blockers: string[] = [];

    // --- The window itself, judged by the shared arm rules ------------------
    const windowRejection = evaluateNaturalWindowForArm(window, profile.id, window.version, now);
    if (windowRejection && !windowRejection.ok) {
      blockers.push(`${windowRejection.reasonCode}: ${windowRejection.message}`);
    }

    // --- Natural preflight, explicitly. Never the default exact mode. -------
    // Which blockers must be clear is NOT "all of them": the profile kill
    // switch is itself a live-activation blocker and is precisely what arming
    // releases, so demanding a READY verdict here would be unsatisfiable. The
    // staged model that `arm-canary` established is preserved — preparation
    // must be complete, and the dimensions arming does NOT resolve
    // (authorization, policy) must already pass.
    const preflight = await new CanaryPreflightService(prisma).run("NATURAL_WINDOW");
    for (const finding of preflight.preparationBlockers) blockers.push(`${finding.code}: ${finding.detail}`);
    for (const finding of preflight.liveActivationBlockers) {
      if (finding.code === "CANARY_BLOCKED_AUTHORIZATION" || finding.code === "CANARY_BLOCKED_POLICY") {
        blockers.push(`${finding.code}: ${finding.detail}`);
      }
    }

    // Environment gates are NOT database state and this command never writes
    // them. `.env` plus a restart is the only way they move, exactly as for
    // exact arm.
    if (!environmentIsArmed()) {
      blockers.push("environment activation gates are not in the required state (edit .env and restart FIRST)");
    }

    // The Phase 4D-A finding: this CLI's own .env snapshot proves nothing about
    // what the RUNNING backend and worker loaded. Read before any transaction.
    const attestation = await evaluateRuntimeAttestation();
    if (!attestation.ok) blockers.push(`${attestation.reasonCode}: ${attestation.message}`);

    const remainingMs = window.expiresAt.getTime() - now.getTime();

    console.log("Proposed natural activation");
    line("environment", `${profile.environment} — REAL FUNDS`);
    line("window id", window.id);
    line("authorizationType", window.authorizationType);
    line("state", describeNaturalWindow(window, now).state);
    line("allowedDirections", `[${window.allowedDirections.join(", ")}]`);
    line("maxClaims", window.maxClaims);
    line("claimedCount", window.claimedCount);
    line("remainingClaims", describeNaturalWindow(window, now).remainingClaims);
    line("window version", window.version);
    line("expiresAt", window.expiresAt.toISOString());
    line("remaining lifetime", `${Math.floor(remainingMs / 1000)}s (minimum ${NATURAL_ARM_MINIMUM_REMAINING_MS / 1000}s)`);
    console.log("");
    line("profile isEnabled", profile.isEnabled);
    line("profile killSwitch", policy.killSwitchActive);
    line("policy row version", policy.version);
    line("allowedSymbols", policy.allowedSymbols.length === 0 ? "[] (ALLOW ALL)" : `[${policy.allowedSymbols.join(", ")}]`);
    line("  (observed only)", "this command never writes allowedSymbols");
    line("env gates armed", environmentIsArmed());
    line("confirmation flag", confirmed);
    console.log("");
    console.log("WOULD MUTATE (nothing else):");
    line("  ExecutionProfile.isEnabled", `${profile.isEnabled} -> true`);
    line("  policy.killSwitchActive", `${policy.killSwitchActive} -> false`);
    line("  authorization row", "UNCHANGED — arming spends no claim");
    console.log("");
    reportRuntimeAttestation(attestation);

    if (blockers.length > 0) {
      console.log("BLOCKED — nothing was changed:");
      for (const blocker of blockers) console.log(`  - ${blocker}`);
      process.exitCode = 1;
      return;
    }
    if (!confirmed) {
      console.log("DRY RUN");
      console.log(`  NO DATABASE WRITE WAS PERFORMED. Re-run with ${CONFIRM_ARM} to arm.`);
      return;
    }

    // --- Authoritative recheck + mutation, in ONE transaction --------------
    // The values printed above are NOT what gets armed on: everything is
    // re-read under the advisory lock, so a window that closed or a policy that
    // moved between the dry run and this call refuses instead of arming.
    const result = await prisma.$transaction((tx) =>
      armNaturalWindowTransactional(tx, {
        executionProfileId: profile.id,
        authorizationId: window.id,
        expectedWindowVersion: window.version,
        expectedPolicyVersion: policy.version,
        expectedAllowedSymbols: policy.allowedSymbols,
      })
    );

    if (!result.ok) {
      console.log(`BLOCKED — ${result.reasonCode}: ${result.message}`);
      console.log("The profile was NOT armed and no authorization was changed.");
      process.exitCode = 1;
      return;
    }

    console.log(result.alreadyArmed ? "ALREADY ARMED — no change was made." : "ARMED.");
    line("profile isEnabled", result.snapshot.profileIsEnabled);
    line("profile killSwitch", result.snapshot.killSwitchActive);
    line("window claimedCount", result.snapshot.claimedCount);
    line("window version", result.snapshot.windowVersion);
    line("allowedSymbols", `[${result.snapshot.allowedSymbols.join(", ")}]`);
    console.log("");
    console.log("No signal was sent, no execution was created and no claim was spent.");
    console.log("Run execution:disarm-canary to return to the safe posture.");
  });
}
