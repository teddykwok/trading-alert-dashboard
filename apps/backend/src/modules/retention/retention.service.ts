import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { logger } from "../../config/logger";

/**
 * Bounded data retention. The dashboard is a short-lived inspection window
 * (the user records outcomes in Excel outside this app); screenshots expire
 * after a few days and old *terminal* alerts are deleted after a safety
 * buffer. Nothing here archives anything — deletion is the feature.
 *
 * Alert relations (verified against prisma/schema.prisma):
 *  - TradeReview  1:1, onDelete: Cascade  -> removed with the alert
 *  - TradeJournal 1:1, onDelete: Cascade  -> removed with the alert
 *  - Asset is a parent reference and is never touched.
 * So deleting an Alert row cannot leave orphans.
 */

/** Alert pipeline states that are finished. RECEIVED / PROCESSING_* are never touched. */
export const TERMINAL_ALERT_STATUSES = ["ANALYZED", "FAILED"] as const;

/**
 * TradeReview outcomes that count as "user finished with this trade".
 * OPEN (trade still running) and UNREVIEWED (row exists = user engaged but
 * never concluded) both block deletion.
 */
export const FINAL_REVIEW_STATUSES = ["WIN", "LOSS", "BREAKEVEN", "IGNORED"] as const;

/** Arbitrary app-wide advisory-lock key for the retention job. */
export const RETENTION_LOCK_KEY = 823_471_119;

const DELETE_BATCH_SIZE = 200;

export function retentionCutoff(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Maps a stored screenshotUrl ("/screenshots/<file>.png") to an absolute file
 * path INSIDE screenshotDir, or null when it cannot be proven safe. Only the
 * basename of the URL is used, and the resolved path must sit directly inside
 * the screenshot root — so "../", absolute paths, or any other traversal can
 * never delete a file outside the configured directory.
 */
export function resolveScreenshotFile(screenshotDir: string, screenshotUrl: string): string | null {
  const name = path.basename(screenshotUrl.trim());
  if (!name || name === "." || name === "..") return null;

  const root = path.resolve(screenshotDir);
  const resolved = path.resolve(root, name);
  if (path.dirname(resolved) !== root) return null;

  return resolved;
}

/** Terminal alerts whose screenshot is older than the screenshot cutoff. */
export function expiredScreenshotWhere(cutoff: Date): Prisma.AlertWhereInput {
  return {
    screenshotUrl: { not: null },
    createdAt: { lt: cutoff },
    status: { in: [...TERMINAL_ALERT_STATUSES] },
  };
}

/**
 * Alerts old enough AND terminal AND released by the user:
 *  - untouched by the user (no review row and no journal row), or
 *  - the trade outcome was finalized (WIN/LOSS/BREAKEVEN/IGNORED).
 * A review in OPEN or UNREVIEWED state, or a journal without a finalized
 * review, keeps the alert alive past retention until the user concludes it.
 */
export function deletableAlertWhere(cutoff: Date): Prisma.AlertWhereInput {
  return {
    createdAt: { lt: cutoff },
    status: { in: [...TERMINAL_ALERT_STATUSES] },
    OR: [
      { AND: [{ tradeReview: { is: null } }, { tradeJournal: { is: null } }] },
      { tradeReview: { is: { status: { in: [...FINAL_REVIEW_STATUSES] } } } },
    ],
  };
}

export interface RetentionReport {
  dryRun: boolean;
  lockAcquired: boolean;
  screenshotCutoff: string;
  alertCutoff: string;
  /** Screenshot references matching the expiry rule. */
  screenshotsSelected: number;
  /** Physical files deleted (dry-run: files that WOULD be deleted). */
  screenshotFilesDeleted: number;
  /** screenshotUrl references cleared (dry-run: that WOULD be cleared). */
  screenshotRefsCleared: number;
  /** Alerts eligible for deletion (dry-run: that WOULD be deleted). */
  alertsSelected: number;
  alertsDeleted: number;
  /** Old alerts kept because they are not in a terminal pipeline state. */
  skippedNonTerminal: number;
  /** Old terminal alerts kept because of open/unfinalized user-entered state. */
  skippedOpenUserState: number;
  failures: number;
}

export interface RunRetentionOptions {
  dryRun: boolean;
  screenshotDir: string;
  screenshotRetentionDays: number;
  alertRetentionDays: number;
  now?: Date;
}

/** unlink that treats an already-missing file as success=false, not an error. */
async function unlinkIfExists(file: string): Promise<boolean> {
  try {
    await unlink(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs one retention pass. The whole pass executes inside a single
 * interactive transaction whose FIRST statement takes a Postgres advisory
 * transaction lock (pg_try_advisory_xact_lock): if another process is already
 * running a pass, this one reports lockAcquired=false and does nothing. The
 * xact-scoped lock releases automatically on commit/rollback/disconnect, so a
 * crashed run can never leave the lock stuck (the classic pitfall of session
 * locks on pooled connections).
 *
 * Dry-run reports the exact same counts without touching a single file or
 * row. Individual file/record failures are counted and logged but never abort
 * the pass.
 */
export async function runRetentionCleanup(
  prisma: PrismaClient,
  options: RunRetentionOptions
): Promise<RetentionReport> {
  const now = options.now ?? new Date();
  const screenshotCutoff = retentionCutoff(options.screenshotRetentionDays, now);
  const alertCutoff = retentionCutoff(options.alertRetentionDays, now);

  const report: RetentionReport = {
    dryRun: options.dryRun,
    lockAcquired: true,
    screenshotCutoff: screenshotCutoff.toISOString(),
    alertCutoff: alertCutoff.toISOString(),
    screenshotsSelected: 0,
    screenshotFilesDeleted: 0,
    screenshotRefsCleared: 0,
    alertsSelected: 0,
    alertsDeleted: 0,
    skippedNonTerminal: 0,
    skippedOpenUserState: 0,
    failures: 0,
  };

  return prisma.$transaction(
    async (tx) => {
      const lockRows = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${RETENTION_LOCK_KEY}) AS locked
      `;
      if (!lockRows[0]?.locked) {
        report.lockAcquired = false;
        logger.warn("Retention cleanup skipped: another cleanup is already running");
        return report;
      }

      // ---- Phase A: expire old screenshots (files + references) ----
      const expiredShots = await tx.alert.findMany({
        where: expiredScreenshotWhere(screenshotCutoff),
        select: { id: true, screenshotUrl: true },
      });
      report.screenshotsSelected = expiredShots.length;

      for (const shot of expiredShots) {
        try {
          const file = resolveScreenshotFile(options.screenshotDir, shot.screenshotUrl ?? "");
          if (!file) {
            report.failures += 1;
            logger.warn(
              { alertId: shot.id, screenshotUrl: shot.screenshotUrl },
              "Retention: refusing unsafe screenshot path (outside screenshot dir)"
            );
            continue;
          }

          if (options.dryRun) {
            if (existsSync(file)) report.screenshotFilesDeleted += 1;
            report.screenshotRefsCleared += 1;
            continue;
          }

          // Missing file is fine — the reference is cleared either way.
          const removed = await unlinkIfExists(file);
          if (removed) report.screenshotFilesDeleted += 1;
          await tx.alert.update({ where: { id: shot.id }, data: { screenshotUrl: null } });
          report.screenshotRefsCleared += 1;
        } catch (error) {
          report.failures += 1;
          logger.warn({ alertId: shot.id, error }, "Retention: screenshot cleanup failed for one alert");
        }
      }

      // ---- Phase B: delete old terminal alerts released by the user ----
      const agedWhere: Prisma.AlertWhereInput = { createdAt: { lt: alertCutoff } };
      const deletable = await tx.alert.findMany({
        where: deletableAlertWhere(alertCutoff),
        select: { id: true, screenshotUrl: true },
      });
      report.alertsSelected = deletable.length;

      const [agedNonTerminal, agedTerminal] = await Promise.all([
        tx.alert.count({
          where: { ...agedWhere, status: { notIn: [...TERMINAL_ALERT_STATUSES] } },
        }),
        tx.alert.count({
          where: { ...agedWhere, status: { in: [...TERMINAL_ALERT_STATUSES] } },
        }),
      ]);
      report.skippedNonTerminal = agedNonTerminal;
      report.skippedOpenUserState = agedTerminal - deletable.length;

      if (!options.dryRun) {
        for (const batch of chunk(deletable, DELETE_BATCH_SIZE)) {
          try {
            // Best-effort file removal first so deleted alerts never leave
            // orphaned screenshot files behind (e.g. when the screenshot
            // retention window is configured longer than the alert window).
            for (const row of batch) {
              if (!row.screenshotUrl) continue;
              const file = resolveScreenshotFile(options.screenshotDir, row.screenshotUrl);
              if (!file) continue;
              try {
                await unlinkIfExists(file);
              } catch (error) {
                report.failures += 1;
                logger.warn({ alertId: row.id, error }, "Retention: file removal failed for deleted alert");
              }
            }

            // TradeReview / TradeJournal rows go with the alert via
            // onDelete: Cascade (verified in schema) — no orphan rows.
            const result = await tx.alert.deleteMany({
              where: { id: { in: batch.map((row) => row.id) } },
            });
            report.alertsDeleted += result.count;
          } catch (error) {
            report.failures += 1;
            logger.error({ batchSize: batch.length, error }, "Retention: alert deletion batch failed");
          }
        }
      }

      logger.info({ ...report }, options.dryRun ? "Retention dry-run report" : "Retention cleanup report");
      return report;
    },
    // Nightly maintenance on a personal instance: allow a long pass without
    // the default 5s interactive-transaction timeout aborting mid-cleanup.
    { timeout: 10 * 60_000, maxWait: 15_000 }
  );
}
