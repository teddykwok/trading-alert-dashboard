import type { PrismaClient } from "@prisma/client";

/**
 * Recovery for alerts that were persisted but never queued.
 *
 * ## The window this closes
 *
 * `handleTradingViewWebhook` creates the Alert row and only then calls
 * `enqueueVisionAnalysis`. That call is awaited and NOT wrapped, so if Redis is
 * unavailable the exception escapes the handler, the webhook answers 5xx — and
 * the alert row is already committed. Nothing ever retries it.
 *
 * A redelivery does not save it either, and that is the part that turns a blip
 * into a permanent loss. A retry arriving inside
 * DUPLICATE_SUPPRESSION_WINDOW_SECONDS matches `findRecentDuplicate`, so the
 * webhook increments `duplicateCount` on the ORIGINAL row and returns
 * IGNORED_DUPLICATE without enqueueing anything. The stranded alert is the very
 * row the retry was suppressed against.
 *
 * ## What this is NOT
 *
 * It is not a second queue, an outbox, a claim table or a lock. Idempotency is
 * already available natively: `enqueueVisionAnalysis` now passes the alert id
 * as the BullMQ `jobId`, and BullMQ's add script resolves a duplicate id
 * atomically inside Redis. This module only has to FIND stranded alerts; making
 * the enqueue safe is the queue's job, not ours.
 *
 * It also never writes to the Alert row. A recovered alert stays RECEIVED until
 * a real worker picks it up and moves it to PROCESSING_SCREENSHOT, so the
 * status keeps meaning what it always meant and no error evidence is cleared.
 */

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * How old a RECEIVED alert must be before a sweep will touch it.
 *
 * The normal webhook path persists the row and enqueues microseconds later, so
 * anything younger than this is almost certainly still in flight. With a
 * deterministic jobId a race would be harmless anyway — Redis would collapse
 * the two adds into one — so this is not the correctness mechanism. It exists
 * so the sweep does not spend its bounded batch on rows that need no help, and
 * so the logs describe genuine strandings rather than routine timing.
 *
 * One minute matches DUPLICATE_SUPPRESSION_WINDOW_SECONDS' default: past it,
 * a redelivery would no longer be suppressed, which is exactly the point at
 * which an un-queued alert has become permanently stuck on its own.
 */
export const ALERT_QUEUE_RECOVERY_GRACE_MS = 60_000;

/**
 * Rows inspected per sweep. Matches the bounded-batch convention used by
 * execution reconciliation (`EXECUTION_RECONCILE_BATCH_SIZE`, max 50).
 *
 * A backlog drains over successive ticks rather than in one unbounded pass:
 * the Aug 26 incident left 2494 stranded rows, and reading all of them in a
 * single query — every minute, forever — would be a worse problem than the one
 * being fixed.
 */
export const ALERT_QUEUE_RECOVERY_BATCH_SIZE = 25;

/**
 * How often a sweep runs. Same cadence and reasoning as the execution
 * notification scheduler: this is repair, not a trading signal, so a stranded
 * alert being recovered up to a minute late costs nothing, while a tight
 * interval would poll Postgres and Redis for no benefit.
 */
export const ALERT_QUEUE_RECOVERY_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// The queue surface this needs
// ---------------------------------------------------------------------------

/**
 * Exactly the two queue calls a sweep makes. A test seam, not an abstraction:
 * the real `Queue` satisfies it, and a fake can model an unavailable Redis
 * without one being installed.
 */
export interface RecoverableJobQueue {
  /** Resolves to null when no job with that id exists in Redis. */
  getJob(jobId: string): Promise<{ id?: string | null } | null | undefined>;
  /** Idempotent per jobId — see `visionAnalysisJobId`. */
  add(alertId: string): Promise<void>;
}

export type RecoveryDisposition =
  /** No job existed; one was created. */
  | "RECOVERED"
  /** A job already exists in any state; nothing to do. */
  | "ALREADY_QUEUED"
  /** The queue could not be reached. Left for a later sweep. */
  | "QUEUE_UNAVAILABLE";

export interface AlertRecoveryOutcome {
  alertId: string;
  disposition: RecoveryDisposition;
  ageMs: number;
}

export interface RecoverySweepSummary {
  inspected: number;
  recovered: number;
  alreadyQueued: number;
  failed: number;
  /** True when the sweep stopped early because the queue was unreachable. */
  queueUnavailable: boolean;
  outcomes: AlertRecoveryOutcome[];
}

export interface RecoverySweepOptions {
  batchSize?: number;
  graceMs?: number;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * One bounded pass over alerts that are provably still waiting to be queued.
 *
 * ## Why only RECEIVED
 *
 * RECEIVED is the only status that means "the worker has never touched this".
 * The processor's first action is `markProcessingScreenshot`, so anything
 * further along was dequeued at least once and is somebody else's problem:
 *
 *   PROCESSING_SCREENSHOT / ANALYZING_WITH_AI — a job ran and did not finish.
 *       That is BullMQ's stalled-job territory and the vision pipeline's, not
 *       an enqueue failure. Re-adding here would race a live worker.
 *   ANALYZED                                   — finished. Never re-enqueued.
 *   FAILED                                     — BullMQ already exhausted its
 *       bounded attempts and the reason is persisted in `errorMessage`.
 *       Silently resurrecting it would replace a deliberate terminal state
 *       with an unbounded retry loop.
 *   IGNORED_DUPLICATE                          — never had its own job by
 *       design; its counter belongs to the original alert.
 *
 * Narrowing to RECEIVED is therefore not caution for its own sake — it is the
 * only status where "no job exists" and "no job ever ran" are the same claim.
 */
export async function runAlertQueueRecoverySweep(
  prisma: PrismaClient,
  queue: RecoverableJobQueue,
  options: RecoverySweepOptions = {}
): Promise<RecoverySweepSummary> {
  const now = (options.now ?? (() => new Date()))();
  const graceMs = options.graceMs ?? ALERT_QUEUE_RECOVERY_GRACE_MS;
  const batchSize = options.batchSize ?? ALERT_QUEUE_RECOVERY_BATCH_SIZE;
  const cutoff = new Date(now.getTime() - graceMs);

  const summary: RecoverySweepSummary = {
    inspected: 0,
    recovered: 0,
    alreadyQueued: 0,
    failed: 0,
    queueUnavailable: false,
    outcomes: [],
  };

  const stranded = await prisma.alert.findMany({
    where: { status: "RECEIVED", createdAt: { lte: cutoff } },
    // Oldest first, stable by id: a backlog drains in a deterministic order
    // across ticks and no alert can be starved by a newer one.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true, createdAt: true },
  });

  for (const alert of stranded) {
    summary.inspected += 1;
    const ageMs = now.getTime() - alert.createdAt.getTime();

    try {
      const existing = await queue.getJob(alert.id);
      if (existing) {
        // Present in ANY state — waiting, active, delayed, completed or failed.
        // A job that exists is never duplicated and never forced to re-run: an
        // `add` would be a no-op anyway, and removing one could race a worker
        // that is executing it right now.
        summary.alreadyQueued += 1;
        summary.outcomes.push({ alertId: alert.id, disposition: "ALREADY_QUEUED", ageMs });
        continue;
      }

      await queue.add(alert.id);
      summary.recovered += 1;
      summary.outcomes.push({ alertId: alert.id, disposition: "RECOVERED", ageMs });
    } catch {
      // Almost always an unreachable Redis. Stop the pass rather than trying
      // the same broken connection another 24 times: the row is untouched, the
      // next tick retries, and one bounded log line beats a burst of identical
      // failures. The alert's status is deliberately NOT changed - a queue
      // problem is not evidence about the alert.
      summary.failed += 1;
      summary.queueUnavailable = true;
      summary.outcomes.push({ alertId: alert.id, disposition: "QUEUE_UNAVAILABLE", ageMs });
      break;
    }
  }

  return summary;
}
