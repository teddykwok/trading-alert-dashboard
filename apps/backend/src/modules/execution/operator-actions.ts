import type { ExecutionCanaryAuthorization, PrismaClient } from "@prisma/client";

import { env } from "../../config/env";
import { CANARY_PREPARE_LOCK_NAMESPACE, CanaryAuthorizationService } from "./canary-authorization.service";
import { profileLockKey } from "./profile-lock";

/**
 * The CLOSE and DISARM operations, as callable functions.
 *
 * These transaction bodies used to live inline inside `run-canary-controls.ts`,
 * where only a CLI could reach them. They are lifted here UNCHANGED — same
 * advisory lock, same ordering, same status sets, same outcome codes — so the
 * operator HTTP routes and the operator CLI perform literally the same
 * operation rather than two implementations that can drift.
 *
 * Nothing here reaches Binance, cancels an order or closes a position. Both
 * operations only move durable operator state.
 */

/**
 * Whether the process's OWN environment snapshot is in the armed posture.
 *
 * Moved here from the CLI so the HTTP layer applies the identical rule. These
 * are environment variables, parsed once at import: nothing in this codebase
 * writes them, so `.env` plus a restart remains the only way they move. An
 * operator action that could flip them from a browser would defeat the entire
 * point of having them.
 */
export function environmentIsArmed(): boolean {
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

export interface CloseWindowOutcome {
  active: number;
  recovery: number;
  authorizations: ExecutionCanaryAuthorization[];
}

/**
 * CLOSE: engage the profile kill switch, then report what is still running.
 *
 * The kill switch is engaged FIRST, before anything is reported, and the whole
 * thing is serialized against every other operator mutation on this profile.
 * Without the lock an in-flight arm could release the kill switch AFTER this
 * engaged it, silently undoing the fastest safety action the operator has.
 *
 * The counts are read INSIDE the lock so the report describes the state this
 * close actually committed rather than one a concurrent operator moved.
 *
 * It cancels nothing and closes nothing: existing executions stay under the
 * worker's protection and reconciliation.
 */
export async function closeCanaryWindowOperation(
  prisma: PrismaClient,
  profileId: string
): Promise<CloseWindowOutcome> {
  const [active, recovery, authorizations] = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CANARY_PREPARE_LOCK_NAMESPACE}::int, ${profileLockKey(
      profileId
    )}::int)`;

    await tx.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { killSwitchActive: true },
    });

    return Promise.all([
      tx.tradeExecution.count({
        where: {
          executionProfileId: profileId,
          status: {
            in: ["PLAN_READY", "PREFLIGHT", "ENTRY_SUBMITTING", "ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "PROTECTED"],
          },
        },
      }),
      tx.tradeExecution.count({
        where: {
          executionProfileId: profileId,
          OR: [
            { status: { in: ["ENTRY_SUBMITTING", "PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "MANUAL_INTERVENTION"] } },
            { requiresManualIntervention: true },
          ],
        },
      }),
      new CanaryAuthorizationService(prisma).listForProfile(profileId, tx),
    ]);
  });

  return { active, recovery, authorizations };
}

export type DisarmOutcomeCode =
  | "CANARY_DISARMED_CLEAN"
  | "CANARY_DISARMED_NEW_WORK_BLOCKED_RECOVERY_CONTINUES";

export interface DisarmOutcome {
  revoked: number;
  outstanding: number;
  outcome: DisarmOutcomeCode;
}

/**
 * DISARM: the full return to safety.
 *
 * The WHOLE shutdown is one serialized operation. It used to be three
 * unsynchronized statements, which let an in-flight arm interleave and
 * re-enable the profile after the operator had disarmed it. The ordering is
 * unchanged — kill switch first, then revoke, then the conditional disable —
 * it is simply atomic.
 *
 * The profile is disabled ONLY when nothing is left running: reconciliation and
 * protection need it, so disabling it beneath an open execution would strand
 * live exposure. The symbol allowlist is deliberately never widened, because
 * `[]` means allow ALL, which is the opposite of safe.
 */
export async function disarmCanaryOperation(prisma: PrismaClient, profileId: string): Promise<DisarmOutcome> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CANARY_PREPARE_LOCK_NAMESPACE}::int, ${profileLockKey(
      profileId
    )}::int)`;

    // 1. Kill switch FIRST.
    await tx.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { killSwitchActive: true },
    });

    // 2. Revoke anything unused. Deliberately authorization-type agnostic: an
    // open natural window is revoked exactly like an unused exact one. Claims
    // already spent are never refunded and the row is never deleted.
    const revokedCount = await new CanaryAuthorizationService(prisma).revokeUnused(profileId, new Date(), tx);

    // 3. Only then consider disabling the profile.
    const outstandingCount = await tx.tradeExecution.count({
      where: {
        executionProfileId: profileId,
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
      return {
        revoked: revokedCount,
        outstanding: outstandingCount,
        outcome: "CANARY_DISARMED_NEW_WORK_BLOCKED_RECOVERY_CONTINUES" as const,
      };
    }
    await tx.executionProfile.update({ where: { id: profileId }, data: { isEnabled: false } });
    return { revoked: revokedCount, outstanding: outstandingCount, outcome: "CANARY_DISARMED_CLEAN" as const };
  });
}
