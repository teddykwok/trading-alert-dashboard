import { PrismaClient } from "@prisma/client";

/**
 * One-time removal of the synthetic Phase 11 fixture graph that survived a
 * crashed test run and landed in the RUNTIME database.
 *
 * This exists because integration tests used to share the runtime database.
 * They no longer do — `tests/helpers/test-database.ts` refuses to — so this
 * should never be needed again, and it is written to be safe if it is.
 *
 * It deletes a profile only when BOTH hold:
 *   environment === "TESTNET"  AND  accountIdentifier starts with "phase11-real-"
 *
 * Anything else — MAINNET, `mainnet-canary-usdm`, any real alert, execution or
 * Binance state — is unreachable from here. It sends no Binance request, and it
 * prints counts and the environment only.
 */

const REQUIRED_PREFIX = "phase11-real-";
const REQUIRED_ENVIRONMENT = "TESTNET";
const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const candidates = await prisma.executionProfile.findMany({
      where: { accountIdentifier: { startsWith: REQUIRED_PREFIX }, environment: REQUIRED_ENVIRONMENT },
      select: { id: true, accountIdentifier: true, environment: true },
    });

    console.log("LEAKED TEST FIXTURE CLEANUP — runtime database, test-owned rows only.");
    console.log(`  candidates                     ${candidates.length}`);

    if (candidates.length === 0) {
      console.log("Nothing matches the test namespace. Nothing to do.");
      return;
    }

    // Re-assert both conditions on every candidate individually. The query
    // above already filtered, but this is the check that must never be skipped.
    for (const profile of candidates) {
      const namespaceMatch = profile.accountIdentifier.startsWith(REQUIRED_PREFIX);
      const environmentMatch = profile.environment === REQUIRED_ENVIRONMENT;
      const owned = await prisma.tradeExecution.count({ where: { executionProfileId: profile.id } });

      console.log("  ---");
      console.log(`  profile environment            ${profile.environment}`);
      console.log(`  test namespace match           ${namespaceMatch}`);
      console.log(`  owned execution count          ${owned}`);

      if (!namespaceMatch || !environmentMatch) {
        console.log("STOP — a candidate failed a safety check. Nothing was deleted.");
        process.exitCode = 1;
        return;
      }
    }

    if (!APPLY) {
      console.log("");
      console.log("DRY RUN — re-run with --apply to delete the graphs listed above.");
      return;
    }

    const profileIds = candidates.map((profile) => profile.id);
    const executionIds = (
      await prisma.tradeExecution.findMany({
        where: { executionProfileId: { in: profileIds } },
        select: { id: true },
      })
    ).map((row) => row.id);

    if (executionIds.length > 0) {
      const owned = { tradeExecutionId: { in: executionIds } };
      await prisma.executionNotificationCheckpoint.deleteMany({
        where: {
          OR: [
            { executionEvent: { tradeExecutionId: { in: executionIds } } },
            { protectionVerification: { tradeExecutionId: { in: executionIds } } },
          ],
        },
      });
      await prisma.executionNotification.deleteMany({ where: owned });
      await prisma.criticalAlert.deleteMany({ where: owned });
      await prisma.executionProtectionVerification.deleteMany({ where: owned });
      await prisma.marginAdjustmentIntent.deleteMany({ where: owned });
      await prisma.safetyAdmission.deleteMany({ where: owned });
      await prisma.binanceOrder.deleteMany({ where: owned });
      await prisma.executionProtectionState.deleteMany({ where: owned });
      await prisma.executionEvent.deleteMany({ where: owned });
      await prisma.tradeExecution.deleteMany({ where: { id: { in: executionIds } } });
    }

    await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: { in: profileIds } } });
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: { in: profileIds } } });
    await prisma.executionProfile.deleteMany({ where: { id: { in: profileIds } } });

    const remaining = await prisma.executionProfile.count({
      where: { accountIdentifier: { startsWith: REQUIRED_PREFIX } },
    });
    console.log("");
    console.log(`  remaining test profiles        ${remaining}`);
    console.log(remaining === 0 ? "CLEAN — the test namespace is empty." : "INCOMPLETE — inspect before continuing.");
    if (remaining !== 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
