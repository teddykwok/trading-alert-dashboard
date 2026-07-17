import { prisma } from "../../plugins/prisma";
import { env } from "../../config/env";
import { ensureScreenshotDir } from "../../utils/file";
import { runRetentionCleanup } from "./retention.service";

/**
 * Manual retention runner.
 *
 *   pnpm --filter @trading-alert-dashboard/backend retention:dry-run
 *   pnpm --filter @trading-alert-dashboard/backend retention:apply
 *
 * DRY-RUN IS THE DEFAULT: without the --apply flag nothing is deleted and no
 * database row is modified — the report only shows what a real pass would do.
 * Runs regardless of DATA_RETENTION_ENABLED (an explicit manual invocation is
 * its own consent); the flag only governs the daily schedule.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;

  console.log(
    dryRun
      ? "Retention DRY-RUN — reporting only, nothing will be deleted."
      : "Retention APPLY — expired screenshots and eligible old alerts WILL be deleted."
  );
  console.log(
    `Config: screenshots > ${env.SCREENSHOT_RETENTION_DAYS}d, alerts > ${env.ALERT_RETENTION_DAYS}d (terminal + user-released only)`
  );

  const screenshotDir = await ensureScreenshotDir();
  const report = await runRetentionCleanup(prisma, {
    dryRun,
    screenshotDir,
    screenshotRetentionDays: env.SCREENSHOT_RETENTION_DAYS,
    alertRetentionDays: env.ALERT_RETENTION_DAYS,
  });

  console.log(JSON.stringify(report, null, 2));

  if (!report.lockAcquired) {
    console.log("Another cleanup is currently running — nothing was done.");
  }
}

main()
  .catch((error) => {
    console.error("Retention run failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
