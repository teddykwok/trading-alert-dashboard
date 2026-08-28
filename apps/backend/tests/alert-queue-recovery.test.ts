import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ALERT_QUEUE_RECOVERY_BATCH_SIZE,
  ALERT_QUEUE_RECOVERY_GRACE_MS,
  ALERT_QUEUE_RECOVERY_INTERVAL_MS,
  runAlertQueueRecoverySweep,
  type RecoverableJobQueue,
} from "../src/modules/jobs/alert-queue-recovery.service";
import { resetRecoverySweepGuardForTests } from "../src/modules/jobs/alert-queue-recovery.scheduler";

/**
 * Recovery for alerts persisted before their vision job existed.
 *
 * ## The exact hole
 *
 * `handleTradingViewWebhook` commits the Alert row, then awaits
 * `enqueueVisionAnalysis` — un-wrapped, unlike the Extreme RR enqueue below it.
 * A Redis blip therefore throws out of the handler: the webhook answers 5xx
 * while the row is already committed.
 *
 * A redelivery does not repair it, and that is what makes the loss permanent.
 * A retry inside DUPLICATE_SUPPRESSION_WINDOW_SECONDS matches
 * `findRecentDuplicate`, so the webhook bumps `duplicateCount` on the ORIGINAL
 * row and returns IGNORED_DUPLICATE without enqueueing. The alert the retry was
 * suppressed against is the stranded one.
 *
 * ## Why there is no lock, outbox or claim table here
 *
 * BullMQ already provides the idempotency. `addStandardJob-9.lua` checks
 * `EXISTS jobIdKey` and, when the id is present, returns the existing job via
 * `handleDuplicatedJob` instead of creating a second one — atomically, inside
 * one Lua script. Passing the alert id as `jobId` therefore makes "webhook and
 * recovery both enqueue" safe by construction rather than by timing. Most of
 * what follows tests that this property actually holds end to end.
 */

const SERVICE_PATH = path.resolve(__dirname, "../src/modules/jobs/alert-queue-recovery.service.ts");
const SERVICE_SOURCE = readFileSync(SERVICE_PATH, "utf8");

/**
 * Source with its comments removed.
 *
 * The structural bans below are about what the CODE can reach, and the comments
 * legitimately name the very things being banned — this module explains at
 * length why a suppressed retry bumps `duplicateCount` on the original row, and
 * why it must never write one itself. Scanning raw text would turn an accurate
 * explanation into a failure and push the next author towards deleting the
 * explanation rather than keeping the guarantee.
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const SERVICE_CODE = codeOf(SERVICE_SOURCE);

const NOW = new Date("2026-08-28T12:00:00.000Z");
const now = () => NOW;
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

afterEach(() => resetRecoverySweepGuardForTests());

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface StoredAlert {
  id: string;
  status: string;
  createdAt: Date;
}

/**
 * A Prisma stand-in that honours the parts of the query the sweep relies on:
 * the status filter, the age cutoff, the ordering and the batch limit. A fake
 * that ignored them would make the bounded-scan tests meaningless.
 */
function fakePrisma(alerts: StoredAlert[]) {
  const queries: unknown[] = [];
  return {
    queries,
    client: {
      alert: {
        findMany: async (args: {
          where: { status: string; createdAt: { lte: Date } };
          orderBy: unknown;
          take: number;
        }) => {
          queries.push(args);
          return alerts
            .filter(
              (alert) =>
                alert.status === args.where.status && alert.createdAt.getTime() <= args.where.createdAt.lte.getTime()
            )
            .sort(
              (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
            )
            .slice(0, args.take)
            .map((alert) => ({ id: alert.id, createdAt: alert.createdAt }));
        },
      },
    } as never,
  };
}

/**
 * A queue that models BullMQ's real identity rule: an `add` for a jobId that
 * already exists is a no-op returning the existing job.
 */
function fakeQueue(options: { existing?: string[]; unavailable?: boolean } = {}) {
  const jobs = new Map<string, { id: string }>();
  for (const id of options.existing ?? []) jobs.set(id, { id });
  const addCalls: string[] = [];
  const getCalls: string[] = [];

  const queue: RecoverableJobQueue = {
    async getJob(jobId) {
      getCalls.push(jobId);
      if (options.unavailable) throw new Error("connect ECONNREFUSED");
      return jobs.get(jobId) ?? null;
    },
    async add(alertId) {
      addCalls.push(alertId);
      if (options.unavailable) throw new Error("connect ECONNREFUSED");
      // Exactly BullMQ's semantics: an existing id is never duplicated.
      if (!jobs.has(alertId)) jobs.set(alertId, { id: alertId });
    },
  };

  return {
    queue,
    jobs,
    addCalls,
    getCalls,
    get jobCount() {
      return jobs.size;
    },
  };
}

const sweep = (alerts: StoredAlert[], queue: RecoverableJobQueue, batchSize?: number) => {
  const db = fakePrisma(alerts);
  return runAlertQueueRecoverySweep(db.client, queue, { now, ...(batchSize ? { batchSize } : {}) }).then(
    (summary) => ({ summary, queries: db.queries })
  );
};

const received = (id: string, ageMinutes = 10): StoredAlert => ({
  id,
  status: "RECEIVED",
  createdAt: minutesAgo(ageMinutes),
});

// ===========================================================================
// A/B. The webhook boundary
// ===========================================================================

describe("A/B. the DB -> queue boundary", () => {
  const WEBHOOK = readFileSync(
    path.resolve(__dirname, "../src/modules/webhook/webhook.service.ts"),
    "utf8"
  );
  const QUEUE = readFileSync(path.resolve(__dirname, "../src/modules/jobs/queue.ts"), "utf8");

  it("the alert is still committed before the enqueue is attempted", () => {
    // Unchanged, and this is why recovery is needed at all: the row exists
    // whether or not the enqueue succeeds.
    expect(WEBHOOK.indexOf("await alertsService.create(")).toBeLessThan(
      WEBHOOK.indexOf("await enqueueVisionAnalysis(alert.id)")
    );
  });

  it("the enqueue failure still surfaces to the caller — API semantics unchanged", () => {
    // Deliberately NOT wrapped in try/catch. Answering 202 over a lost enqueue
    // would hide the fault; the durable sweep is what closes the hole instead.
    const tail = WEBHOOK.slice(WEBHOOK.indexOf("await notifyNewAlert(alert);"));
    const enqueueLine = tail.slice(0, tail.indexOf("\n", tail.indexOf("enqueueVisionAnalysis")));
    expect(enqueueLine).toContain("await enqueueVisionAnalysis(alert.id);");
    expect(enqueueLine).not.toContain("try");
    // The Extreme RR enqueue below it IS wrapped, and stays that way.
    expect(WEBHOOK).toContain("Extreme RR plan scheduling failed (alert kept)");
  });

  it("the vision job's id is the alert id, which is what makes adds idempotent", () => {
    expect(QUEUE).toContain("export function visionAnalysisJobId(alertId: string): string {");
    expect(QUEUE).toContain("return alertId;");
    expect(QUEUE).toContain('{ jobId: visionAnalysisJobId(alertId) }');
  });

  it("an alert id is a legal BullMQ job id", () => {
    // BullMQ reserves ':' for its own composite ids. cuids never contain one.
    for (const id of ["cmt9laa0v03y113m9zktgjdzz", "clx0000000000000000000000"]) {
      expect(id).toMatch(/^[a-z0-9]+$/);
      expect(id).not.toContain(":");
    }
  });
});

// ===========================================================================
// C/D. Discovering and repairing a genuinely missing job
// ===========================================================================

describe("C/D. a stranded alert is discovered and re-queued exactly once", () => {
  it("enqueues the alert that has no job", async () => {
    const queue = fakeQueue();
    const { summary } = await sweep([received("alert-1")], queue.queue);

    expect(summary.recovered).toBe(1);
    expect(summary.inspected).toBe(1);
    expect(queue.addCalls).toEqual(["alert-1"]);
    expect(summary.outcomes[0]).toMatchObject({ alertId: "alert-1", disposition: "RECOVERED" });
  });

  it("reports the age it observed, so a log shows how long it was stuck", async () => {
    const queue = fakeQueue();
    const { summary } = await sweep([received("alert-1", 90)], queue.queue);
    expect(summary.outcomes[0].ageMs).toBe(90 * 60_000);
  });

  it("repairs several stranded alerts in one pass", async () => {
    const queue = fakeQueue();
    const { summary } = await sweep(
      [received("a", 30), received("b", 20), received("c", 10)],
      queue.queue
    );
    expect(summary.recovered).toBe(3);
    expect(queue.jobCount).toBe(3);
  });
});

// ===========================================================================
// E/F/G/H. Idempotency — the heart of it
// ===========================================================================

describe("E. a webhook enqueue racing a recovery sweep yields one job", () => {
  it("recovery's add is a no-op when the webhook won the race", async () => {
    // The sweep read "no job", and between that read and its add the webhook
    // enqueued. BullMQ resolves the duplicate id inside Redis, so the add
    // cannot create a second job.
    const queue = fakeQueue();
    let raced = false;
    const racing: RecoverableJobQueue = {
      async getJob(jobId) {
        const result = await queue.queue.getJob(jobId);
        if (!raced) {
          raced = true;
          // The webhook lands here, after the check and before the add.
          await queue.queue.add(jobId);
        }
        return result;
      },
      add: (alertId) => queue.queue.add(alertId),
    };

    await sweep([received("alert-1")], racing);

    expect(queue.jobCount).toBe(1);
    expect(queue.jobs.has("alert-1")).toBe(true);
  });
});

describe("F/G/H. repeated and concurrent sweeps never duplicate", () => {
  it("two sweeps running against the same queue produce one job", async () => {
    const queue = fakeQueue();
    const alerts = [received("alert-1")];
    await Promise.all([sweep(alerts, queue.queue), sweep(alerts, queue.queue)]);
    expect(queue.jobCount).toBe(1);
  });

  it("repeated sweeps (startup then periodic, over and over) add nothing further", async () => {
    const queue = fakeQueue();
    const alerts = [received("alert-1"), received("alert-2")];

    const first = await sweep(alerts, queue.queue);
    expect(first.summary.recovered).toBe(2);

    for (let pass = 0; pass < 5; pass += 1) {
      const again = await sweep(alerts, queue.queue);
      expect(again.summary.recovered).toBe(0);
      expect(again.summary.alreadyQueued).toBe(2);
    }
    expect(queue.jobCount).toBe(2);
    expect(queue.addCalls).toEqual(["alert-1", "alert-2"]);
  });

  it("even a forced double add cannot create a second job", async () => {
    // Belt and braces: the fake models BullMQ's rule, so calling add twice
    // directly is still one job.
    const queue = fakeQueue();
    await queue.queue.add("alert-1");
    await queue.queue.add("alert-1");
    expect(queue.jobCount).toBe(1);
  });
});

// ===========================================================================
// I/J/K/L/M. The queue-state matrix
// ===========================================================================

describe("I/J/K. an alert whose job already exists is skipped", () => {
  it("skips regardless of the state that job is in", async () => {
    // getJob resolves for waiting, active, delayed, completed and failed alike.
    // The sweep does not branch on state on purpose: a job that exists is never
    // duplicated, and re-running one could race a worker executing it now.
    const queue = fakeQueue({ existing: ["alert-1"] });
    const { summary } = await sweep([received("alert-1")], queue.queue);

    expect(summary.alreadyQueued).toBe(1);
    expect(summary.recovered).toBe(0);
    expect(queue.addCalls).toEqual([]);
  });

  it("mixes skips and repairs correctly in one batch", async () => {
    const queue = fakeQueue({ existing: ["has-job"] });
    const { summary } = await sweep([received("has-job", 30), received("no-job", 20)], queue.queue);

    expect(summary.alreadyQueued).toBe(1);
    expect(summary.recovered).toBe(1);
    expect(queue.addCalls).toEqual(["no-job"]);
  });
});

describe("L/M. only RECEIVED is ever a candidate", () => {
  it("never selects an alert in any other status", async () => {
    const queue = fakeQueue();
    const alerts: StoredAlert[] = [
      { id: "analyzed", status: "ANALYZED", createdAt: minutesAgo(60) },
      { id: "failed", status: "FAILED", createdAt: minutesAgo(60) },
      { id: "processing", status: "PROCESSING_SCREENSHOT", createdAt: minutesAgo(60) },
      { id: "analyzing", status: "ANALYZING_WITH_AI", createdAt: minutesAgo(60) },
      { id: "duplicate", status: "IGNORED_DUPLICATE", createdAt: minutesAgo(60) },
    ];

    const { summary } = await sweep(alerts, queue.queue);

    expect(summary.inspected).toBe(0);
    expect(queue.addCalls).toEqual([]);
  });

  it("queries RECEIVED specifically, not 'anything unfinished'", async () => {
    const queue = fakeQueue();
    const { queries } = await sweep([received("a")], queue.queue);
    expect(queries).toHaveLength(1);
    expect((queries[0] as { where: { status: string } }).where.status).toBe("RECEIVED");
  });

  it("a FAILED alert is never silently resurrected", async () => {
    // BullMQ already exhausted its bounded attempts and the reason is durable
    // in errorMessage. Re-queueing it here would replace a deliberate terminal
    // state with an unbounded retry loop.
    const queue = fakeQueue();
    const { summary } = await sweep(
      [{ id: "failed", status: "FAILED", createdAt: minutesAgo(120) }],
      queue.queue
    );
    expect(summary.inspected).toBe(0);
    expect(queue.addCalls).toEqual([]);
  });
});

// ===========================================================================
// N. Redis unavailable
// ===========================================================================

describe("N. a sweep during a queue outage changes nothing", () => {
  it("touches no alert row and reports the outage once", async () => {
    const queue = fakeQueue({ unavailable: true });
    const { summary } = await sweep([received("a"), received("b"), received("c")], queue.queue);

    expect(summary.queueUnavailable).toBe(true);
    expect(summary.recovered).toBe(0);
    expect(summary.failed).toBe(1);
  });

  it("stops after the first failure instead of hammering a broken connection", async () => {
    const queue = fakeQueue({ unavailable: true });
    const alerts = Array.from({ length: 20 }, (_, index) => received(`alert-${index}`));
    await sweep(alerts, queue.queue);

    // One attempt, not twenty. The next tick retries a minute later.
    expect(queue.getCalls).toHaveLength(1);
  });

  it("recovers on a later sweep once the queue answers again", async () => {
    const alerts = [received("alert-1")];

    const down = fakeQueue({ unavailable: true });
    const first = await sweep(alerts, down.queue);
    expect(first.summary.recovered).toBe(0);

    const up = fakeQueue();
    const second = await sweep(alerts, up.queue);
    expect(second.summary.recovered).toBe(1);
    expect(up.jobCount).toBe(1);
  });

  it("the service writes to no alert row at all", () => {
    // Matched as CALLS, not as substrings: `alert.create` is also a prefix of
    // the perfectly legitimate `alert.createdAt` this sweep reads.
    for (const forbidden of [
      /alert\.update\s*\(/,
      /alert\.create\s*\(/,
      /alert\.(create|update|delete)Many\s*\(/,
      /\bmarkProcessing/,
      /\bmarkFailed/,
      /\bmarkAnalyzed/,
    ]) {
      expect(`${forbidden}:${forbidden.test(SERVICE_CODE)}`).toBe(`${forbidden}:false`);
    }
    // The ONLY database call it makes is a read.
    expect(SERVICE_CODE).toContain("prisma.alert.findMany");
    expect(SERVICE_CODE.match(/prisma\.\w+\.\w+\s*\(/g) ?? []).toEqual(["prisma.alert.findMany("]);
  });
});

// ===========================================================================
// O/P/Q. Bounded, ordered, and past the race window
// ===========================================================================

describe("O/P. the scan is bounded and deterministic", () => {
  it("never reads more than the batch size", async () => {
    const queue = fakeQueue();
    const alerts = Array.from({ length: 200 }, (_, index) =>
      received(`alert-${String(index).padStart(3, "0")}`, 30)
    );
    const { summary, queries } = await sweep(alerts, queue.queue, 25);

    expect(summary.inspected).toBe(25);
    expect((queries[0] as { take: number }).take).toBe(25);
  });

  it("drains a backlog oldest-first, stable by id", async () => {
    const queue = fakeQueue();
    const alerts = [received("young", 5), received("oldest", 300), received("middle", 100)];
    const { summary, queries } = await sweep(alerts, queue.queue);

    expect(summary.outcomes.map((outcome) => outcome.alertId)).toEqual(["oldest", "middle", "young"]);
    expect((queries[0] as { orderBy: unknown }).orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });

  it("filters on indexed columns only", async () => {
    const queue = fakeQueue();
    const { queries } = await sweep([received("a")], queue.queue);
    const where = (queries[0] as { where: Record<string, unknown> }).where;
    // Alert is indexed on both status and createdAt.
    expect(Object.keys(where).sort()).toEqual(["createdAt", "status"]);
  });
});

describe("Q. the grace period keeps a fresh webhook out of the sweep", () => {
  it("ignores an alert younger than the grace period", async () => {
    const queue = fakeQueue();
    const fresh: StoredAlert = {
      id: "in-flight",
      status: "RECEIVED",
      createdAt: new Date(NOW.getTime() - (ALERT_QUEUE_RECOVERY_GRACE_MS - 1_000)),
    };
    const { summary } = await sweep([fresh], queue.queue);

    expect(summary.inspected).toBe(0);
    expect(queue.addCalls).toEqual([]);
  });

  it("acts once the alert is older than the grace period", async () => {
    const queue = fakeQueue();
    const stale: StoredAlert = {
      id: "stranded",
      status: "RECEIVED",
      createdAt: new Date(NOW.getTime() - (ALERT_QUEUE_RECOVERY_GRACE_MS + 1_000)),
    };
    const { summary } = await sweep([stale], queue.queue);

    expect(summary.recovered).toBe(1);
  });

  it("uses the injected clock, never a real sleep", async () => {
    // The whole suite pins `now`, so nothing here depends on wall-clock timing.
    const queue = fakeQueue();
    const { queries } = await sweep([received("a")], queue.queue);
    const cutoff = (queries[0] as { where: { createdAt: { lte: Date } } }).where.createdAt.lte;
    expect(cutoff.getTime()).toBe(NOW.getTime() - ALERT_QUEUE_RECOVERY_GRACE_MS);
  });
});

// ===========================================================================
// R/S. Duplicate suppression interaction
// ===========================================================================

describe("R/S. a suppressed redelivery cannot strand the original forever", () => {
  const WEBHOOK = readFileSync(
    path.resolve(__dirname, "../src/modules/webhook/webhook.service.ts"),
    "utf8"
  );

  it("duplicate suppression still creates no second alert and no second job", () => {
    // Unchanged semantics, deliberately: the retry bumps the counter on the
    // original and returns early, before the enqueue is ever reached.
    const block = WEBHOOK.slice(
      WEBHOOK.indexOf("if (existingDuplicate) {"),
      WEBHOOK.indexOf("const asset = await prisma.asset.upsert(")
    );
    expect(block).toContain("registerDuplicate");
    expect(block).toContain('status: "IGNORED_DUPLICATE"');
    expect(block).not.toContain("enqueueVisionAnalysis");
    expect(block).not.toContain("alertsService.create");
  });

  it("the sweep repairs precisely the row the retry was suppressed against", async () => {
    // The original is RECEIVED with no job; the retry only incremented its
    // counter. Age is what makes it visible, and by then a redelivery would no
    // longer be suppressed anyway.
    const queue = fakeQueue();
    const { summary } = await sweep([received("original", 5)], queue.queue);

    expect(summary.recovered).toBe(1);
    expect(queue.addCalls).toEqual(["original"]);
  });

  it("recovery reads the alert table and never writes a duplicate row", () => {
    expect(SERVICE_CODE).not.toContain("duplicateCount");
    expect(SERVICE_CODE).not.toContain("registerDuplicate");
  });
});

// ===========================================================================
// T/U. Blast radius
// ===========================================================================

describe("T/U. recovery touches no trading state", () => {
  const SCHEDULER = readFileSync(
    path.resolve(__dirname, "../src/modules/jobs/alert-queue-recovery.scheduler.ts"),
    "utf8"
  );

  it("creates no execution and reaches no trading module", () => {
    for (const source of [SERVICE_CODE, codeOf(SCHEDULER)]) {
      for (const forbidden of [
        "tradeExecution",
        "TradeExecution",
        "SelectedPlanExecutor",
        "naturalWindow",
        "maxClaims",
        "authorization",
        "binance",
        "Binance",
        "protection",
        "admitAndSubmit",
      ]) {
        expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
      }
    }
  });

  it("the service imports nothing beyond a Prisma type", () => {
    const imports = [...SERVICE_CODE.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual(["@prisma/client"]);
  });

  it("the scheduler enqueues through the SAME function the webhook uses", () => {
    // Two enqueue paths would eventually drift apart on the jobId, which is the
    // only thing keeping them idempotent against each other.
    expect(SCHEDULER).toContain("add: (alertId) => enqueueVisionAnalysis(alertId)");
  });

  it("worker supervision is untouched and unrelated", () => {
    const supervision = readFileSync(
      path.resolve(__dirname, "../src/modules/operator/worker-supervision.ts"),
      "utf8"
    );
    // An enqueue failure is not a worker fault and must not spend a restart
    // attempt; supervision has no notion of a queue at all.
    for (const forbidden of [/\benqueue/i, /\bbullmq\b/i, /\bQueue\b/, /\balert\b/i]) {
      expect(`${forbidden}:${forbidden.test(supervision)}`).toBe(`${forbidden}:false`);
    }
  });
});

// ===========================================================================
// V. Observability
// ===========================================================================

describe("V. logging is useful and carries no secret", () => {
  const SCHEDULER = readFileSync(
    path.resolve(__dirname, "../src/modules/jobs/alert-queue-recovery.scheduler.ts"),
    "utf8"
  );

  it("distinguishes the outcomes an operator needs to tell apart", () => {
    expect(SCHEDULER).toContain("could not reach the job queue");
    expect(SCHEDULER).toContain("re-queued alerts that had no vision job");
    expect(SCHEDULER).toContain("found nothing to repair");
    for (const field of ["inspected:", "recovered:", "alreadyQueued:", "alertIds:", "oldestAgeMs:"]) {
      expect(SCHEDULER, field).toContain(field);
    }
  });

  it("logs one line per sweep, not one per stranded alert", () => {
    // A Redis outage with a large backlog would otherwise flood the log every
    // interval. The sweep also stops on the first failure.
    expect(SERVICE_CODE).not.toContain("logger");
  });

  it("never logs a credential, URL or environment", () => {
    for (const forbidden of [
      "REDIS_URL",
      "DATABASE_URL",
      "WEBHOOK_SECRET",
      "OPERATOR_API_TOKEN",
      "TELEGRAM",
      "process.env",
      "Authorization",
      "apiKey",
    ]) {
      expect(`${forbidden}:${SCHEDULER.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

// ===========================================================================
// Wiring and constants
// ===========================================================================

describe("the sweep is wired the way the repo's other schedulers are", () => {
  const WORKER = readFileSync(
    path.resolve(__dirname, "../src/modules/jobs/vision-analysis.worker.ts"),
    "utf8"
  );
  const SCHEDULER = readFileSync(
    path.resolve(__dirname, "../src/modules/jobs/alert-queue-recovery.scheduler.ts"),
    "utf8"
  );

  it("runs at startup AND periodically", () => {
    // Startup alone would leave an alert stranded whenever Redis recovers
    // without anything restarting — which is the common case, because the
    // backend never died and the worker never died either.
    expect(SCHEDULER).toContain('runAlertQueueRecoveryOnce(visionRecoveryQueue, "startup")');
    expect(SCHEDULER).toContain("setInterval(");
    expect(SCHEDULER).toContain('runAlertQueueRecoveryOnce(visionRecoveryQueue, "periodic")');
  });

  it("is started by the worker and cleared on shutdown", () => {
    expect(WORKER).toContain("const alertRecoveryTimer = startAlertQueueRecoveryScheduler();");
    expect(WORKER).toContain("clearInterval(alertRecoveryTimer);");
  });

  it("does not hold the process open by itself", () => {
    expect(SCHEDULER).toContain("timer.unref?.();");
  });

  it("guards against overlapping sweeps like the notification scheduler does", () => {
    expect(SCHEDULER).toContain("sweepInFlight");
    expect(SCHEDULER).toContain("} finally {");
  });

  it("holds the exact shipped constants", () => {
    expect(ALERT_QUEUE_RECOVERY_GRACE_MS).toBe(60_000);
    expect(ALERT_QUEUE_RECOVERY_BATCH_SIZE).toBe(25);
    expect(ALERT_QUEUE_RECOVERY_INTERVAL_MS).toBe(60_000);
  });

  it("keeps the batch within the repo's existing bound", () => {
    // EXECUTION_RECONCILE_BATCH_SIZE is capped at 50; this stays inside it.
    expect(ALERT_QUEUE_RECOVERY_BATCH_SIZE).toBeLessThanOrEqual(50);
    expect(ALERT_QUEUE_RECOVERY_GRACE_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("the queue's retry policy is unchanged", () => {
    const QUEUE = readFileSync(path.resolve(__dirname, "../src/modules/jobs/queue.ts"), "utf8");
    expect(QUEUE).toContain("attempts: 2");
    expect(QUEUE).toContain('backoff: { type: "exponential", delay: 3000 }');
    expect(QUEUE).toContain("removeOnComplete: { count: 200 }");
    expect(QUEUE).toContain("removeOnFail: { count: 500 }");
  });
});
