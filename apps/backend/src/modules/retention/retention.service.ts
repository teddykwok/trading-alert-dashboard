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
 * Alert relations (re-verified against prisma/schema.prisma):
 *  - TradeReview         1:1, onDelete: Cascade  -> removed with the alert
 *  - TradeJournal        1:1, onDelete: Cascade  -> removed with the alert
 *  - ExtremeRRPlan       1:1, onDelete: Cascade  -> removed with the alert
 *  - SelectedPlanOutcome 1:1, onDelete: Cascade  -> removed with the alert
 *  - TradeExecution      1:N, onDelete: SetNull  -> SURVIVES, alertId nulled
 *  - Asset is a parent reference and is never touched.
 *
 * So deleting an Alert leaves no orphan rows, but it is NOT harmless: the two
 * cascades this list previously omitted carry durable execution lineage. See
 * `executionLineageWhere` — an alert is now protected when its plan is still
 * part of an execution's history.
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
 * Whether deleting this alert would destroy lineage an execution still needs.
 *
 * `ExtremeRRPlan.alertId` cascades, and the plan is where a trade's ORIGIN is
 * kept: `riskTemplateId`, `templateName`, `referenceCapital`, `riskPercent`,
 * `rewardRatio`, the frozen lookback candidates. `TradeExecution` survives the
 * cascade — `extremeRRPlanId` is SetNull — so nothing is orphaned and nothing
 * fails; the execution simply stops being able to say how it was sized, and no
 * later read can recover it. The execution's own frozen block keeps
 * `riskBudgetUsd` and `estimatedRewardRatio`, so the loss is silent: the row
 * still looks complete.
 *
 * `SelectedPlanOutcome` cascades from BOTH the alert and the plan, and carries
 * the admission verdict for that plan, including the `executionId` it reached.
 * The same condition protects it, because it hangs off the same alert.
 *
 * Deliberately narrow. A plan that no execution ever used is disposable: it is
 * a rejected or unexecuted candidate, not history, and keeping its alert alive
 * forever would quietly turn bounded retention into unbounded growth. The test
 * for that case is as load-bearing as the one for this case.
 */
export function executionLineageWhere(): Prisma.AlertWhereInput {
  return { extremeRRPlan: { is: { tradeExecutions: { some: {} } } } };
}

/**
 * The complement: no plan at all, or a plan no execution ever used.
 *
 * Written as an explicit OR rather than `NOT: executionLineageWhere()` so the
 * three possible states — no plan, plan without executions, plan with
 * executions — are enumerated in the query itself, and a nullable relation can
 * never fall through a negation into the wrong branch.
 */
const disposableLineageWhere: Prisma.AlertWhereInput = {
  OR: [
    { extremeRRPlan: { is: null } },
    { extremeRRPlan: { is: { tradeExecutions: { none: {} } } } },
  ],
};

/**
 * The user-state release rule, unchanged: untouched by the user (no review and
 * no journal), or the outcome was finalized.
 */
const releasedByUserWhere: Prisma.AlertWhereInput = {
  OR: [
    { AND: [{ tradeReview: { is: null } }, { tradeJournal: { is: null } }] },
    { tradeReview: { is: { status: { in: [...FINAL_REVIEW_STATUSES] } } } },
  ],
};

/**
 * Alerts old enough AND terminal AND released by the user:
 *  - untouched by the user (no review row and no journal row), or
 *  - the trade outcome was finalized (WIN/LOSS/BREAKEVEN/IGNORED).
 * A review in OPEN or UNREVIEWED state, or a journal without a finalized
 * review, keeps the alert alive past retention until the user concludes it.
 *
 * AND, since this fix, released by EXECUTION HISTORY too: an alert whose plan
 * an execution still points at is never deleted here, whatever its age. Age
 * and user state are unchanged; this is one additional condition, ANDed on.
 */
export function deletableAlertWhere(cutoff: Date): Prisma.AlertWhereInput {
  return {
    createdAt: { lt: cutoff },
    status: { in: [...TERMINAL_ALERT_STATUSES] },
    AND: [releasedByUserWhere, disposableLineageWhere],
  };
}

/**
 * Aged terminal alerts held back ONLY by execution lineage.
 *
 * Counted with the user-state rule applied, so this and `skippedOpenUserState`
 * describe disjoint sets and the residual arithmetic below stays exact. An
 * alert kept for both reasons is reported as open user state, not double
 * counted.
 */
export function lineageProtectedAlertWhere(cutoff: Date): Prisma.AlertWhereInput {
  return {
    createdAt: { lt: cutoff },
    status: { in: [...TERMINAL_ALERT_STATUSES] },
    AND: [releasedByUserWhere, executionLineageWhere()],
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
  /**
   * Old terminal alerts kept ONLY because an execution still needs the plan
   * they would cascade away. Reported separately so "retention deleted less
   * than you expected" can be read as the safety rule working, rather than
   * looking like unfinished user state.
   */
  skippedExecutionLineage: number;
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
    skippedExecutionLineage: 0,
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

      const [agedNonTerminal, agedTerminal, lineageProtected] = await Promise.all([
        tx.alert.count({
          where: { ...agedWhere, status: { notIn: [...TERMINAL_ALERT_STATUSES] } },
        }),
        tx.alert.count({
          where: { ...agedWhere, status: { in: [...TERMINAL_ALERT_STATUSES] } },
        }),
        tx.alert.count({ where: lineageProtectedAlertWhere(alertCutoff) }),
      ]);
      report.skippedNonTerminal = agedNonTerminal;
      report.skippedExecutionLineage = lineageProtected;
      // The residual, with lineage now accounted for separately so it keeps
      // meaning exactly what its name says.
      report.skippedOpenUserState = agedTerminal - deletable.length - lineageProtected;

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

            // TradeReview / TradeJournal / ExtremeRRPlan / SelectedPlanOutcome
            // all go with the alert via onDelete: Cascade (verified in
            // schema) — no orphan rows. Every alert in this batch was proven
            // above to have no plan an execution still points at, so no
            // execution loses its lineage here.
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
