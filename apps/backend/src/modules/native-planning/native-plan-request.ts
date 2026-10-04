import type { Alert, PrismaClient } from "@prisma/client";

import { nativeAutoPlanRefusal } from "./native-plan-eligibility";
import type { NativePlanQueue } from "./native-plan-queue";

/**
 * AUTOMATIC NATIVE PLANNING — the request half, run by the Native emitter
 * strictly AFTER a V2 delivery has committed its Alert and ledger row.
 *
 * It does two small things and never plans anything itself:
 *  1. records the durable planning INTENT: a PENDING ExtremeRRPlan row for the
 *     alert, created only if no plan row exists (ON CONFLICT DO NOTHING — an
 *     existing plan of any status is never touched or overwritten);
 *  2. enqueues one job on the DEDICATED Native planning queue, whose id is the
 *     alert id (idempotent in Redis).
 *
 * No candle is fetched here and no HTTP request is made: the delivery
 * transaction has already committed and never waits on planning. A failure is
 * reported as an outcome and never thrown, so it cannot undo the Alert, delay
 * or suppress the live dashboard push, or stop the emitter. A missed enqueue is
 * recovered by the worker's sweep from the PENDING row; a missed PENDING row
 * leaves the alert unplanned but visible, and the manual "Generate plan" stays
 * available.
 *
 * Planning is not execution: the PENDING row carries no fan-out marker, and
 * every execution path refuses a NATIVE plan by source.
 */

export type NativePlanRequestOutcome =
  /** PENDING intent recorded (or already present) and the job enqueued. */
  | "REQUESTED"
  /** Not an auto-plannable Native alert: nothing written, nothing enqueued. */
  | "REFUSED"
  /** The PENDING intent could not be written: nothing enqueued; the alert stays visible. */
  | "INTENT_FAILED"
  /** Intent recorded, enqueue failed or timed out: the worker's sweep re-enqueues it. */
  | "ENQUEUE_FAILED";

/** Bounded like the live push: a Redis that is down never holds the emitter. */
export const NATIVE_PLAN_REQUEST_TIMEOUT_MS = 2_000;

export interface NativePlanRequesterDeps {
  readonly prisma: PrismaClient;
  readonly queue: NativePlanQueue;
  /** The plan's INITIAL global selected lookback: the same deployment policy manual generation uses. */
  readonly resolveLookback: () => number | Promise<number>;
  /** Content-free: an outcome, an alert id and an error NAME — never a payload, URL or secret. */
  readonly log: (line: string) => void;
  readonly timeoutMs?: number;
}

export interface NativePlanRequester {
  /** Never throws. */
  requestCommitted(alert: Alert): Promise<NativePlanRequestOutcome>;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

export function createNativePlanRequester(deps: NativePlanRequesterDeps): NativePlanRequester {
  const timeoutMs = deps.timeoutMs ?? NATIVE_PLAN_REQUEST_TIMEOUT_MS;
  return {
    async requestCommitted(alert) {
      try {
        const nativeDelivery = await deps.prisma.nativeAlertDelivery.findUnique({
          where: { alertId: alert.id },
          select: { deliveryKey: true, policyVersion: true, alertId: true },
        });
        const refusal = nativeAutoPlanRefusal({ ...alert, nativeDelivery });
        if (refusal !== null) {
          deps.log(`native auto-planning refused for ${alert.id} (${refusal})`);
          return "REFUSED";
        }
        // Validated by the refusal check above.
        const direction = alert.signal as "LONG" | "SHORT";
        await deps.prisma.extremeRRPlan.createMany({
          data: [
            {
              alertId: alert.id,
              status: "PENDING",
              direction,
              entryPrice: String(alert.price),
              cutoffAt: alert.triggeredAt,
              timeframe: alert.timeframe,
              selectedLookback: await deps.resolveLookback(),
            },
          ],
          // Never overwrite: an existing plan row of any status stays exactly as it is.
          skipDuplicates: true,
        });
      } catch (error) {
        deps.log(`native auto-planning intent not recorded for ${alert.id} (${errorName(error)}); the alert is committed and can be planned manually`);
        return "INTENT_FAILED";
      }
      try {
        await withTimeout(deps.queue.add(alert.id), timeoutMs);
        return "REQUESTED";
      } catch (error) {
        deps.log(`native auto-planning enqueue failed for ${alert.id} (${errorName(error)}); the PENDING plan is recovered by the planning worker's sweep`);
        return "ENQUEUE_FAILED";
      }
    },
  };
}

/**
 * The emitter's two post-commit follow-ups for one committed Native alert: the
 * live dashboard push and the planning request. They run CONCURRENTLY and
 * independently — the push never waits on planning, and neither can fail the
 * other or the committed delivery.
 */
export async function afterNativeAlertCommitted(
  alert: Alert,
  live: { publishCommitted(alert: Alert): Promise<unknown> },
  planning: NativePlanRequester
): Promise<void> {
  await Promise.allSettled([live.publishCommitted(alert), planning.requestCommitted(alert)]);
}

/**
 * The emitter process's requester, on its OWN bounded Redis connection
 * (COMMIT only; a dry run never loads this module). `close` releases it.
 */
export async function openNativePlanRequester(
  prisma: PrismaClient,
  log: (line: string) => void
): Promise<{ requester: NativePlanRequester; close: () => Promise<void> }> {
  const { env } = await import("../../config/env");
  const { default: IORedis } = await import("ioredis");
  const { openNativePlanQueue } = await import("./native-plan-queue");
  const { resolveInitialLookback } = await import("../extreme-rr/extreme-rr.service");
  // Bounded: a Redis that is down fails an enqueue quickly instead of queueing it forever.
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  connection.on("error", () => undefined);
  const { queue, close } = openNativePlanQueue(connection);
  const requester = createNativePlanRequester({ prisma, queue, resolveLookback: resolveInitialLookback, log });
  return {
    requester,
    close: async () => {
      await close().catch(() => undefined);
      connection.disconnect();
    },
  };
}
