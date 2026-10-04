import type { PrismaClient } from "@prisma/client";
import type { ExtremeRRPlanDto } from "@trading-alert-dashboard/shared";

import { NATIVE_ALERT_SOURCE } from "../alerts/alert-source";
import { nativeAutoPlanRefusal, type NativeAutoPlanRefusal } from "./native-plan-eligibility";
import type { NativePlanQueue } from "./native-plan-queue";

/**
 * AUTOMATIC NATIVE PLANNING — the consumer half, run only by the dedicated
 * Native planning worker (native-plan.worker.ts).
 *
 * One job = one alert id. The job generates that alert's frozen Extreme RR
 * plan through the SAME planner the manual "Generate plan" uses
 * (ExtremeRRService.generateForAlert): candle cutoff = the alert's own
 * triggeredAt, entry = the stored alert price, one 300-candle snapshot for
 * 50/100/200/300, and no fan-out marker for a NATIVE plan. Then it stops:
 * no Telegram, no screenshot, no AI vision, no adoption, no execution.
 *
 * Prospective only. A job plans an alert only while that alert holds a
 * durable planning intent — a PENDING plan row written by the post-commit
 * request (or an ERROR row being retried by this same job). An alert with no
 * plan row is never planned here, so historical Native alerts stay exactly as
 * they are; a READY or INVALID plan is final and is never regenerated, so a
 * replayed or duplicate job changes nothing and fetches nothing.
 */

/** The planner surface the processor needs. ExtremeRRService satisfies it. */
export interface NativePlanGenerator {
  generateForAlert(alertId: string): Promise<ExtremeRRPlanDto>;
}

export type NativePlanJobOutcome =
  | { readonly kind: "ALERT_NOT_FOUND" }
  | { readonly kind: "REFUSED"; readonly reason: NativeAutoPlanRefusal }
  | { readonly kind: "NO_PLANNING_INTENT" }
  | { readonly kind: "ALREADY_FINAL"; readonly status: "READY" | "INVALID" }
  | { readonly kind: "GENERATED"; readonly status: "READY" | "INVALID" };

/** Thrown after an ERROR plan is recorded, so BullMQ applies its bounded retry. */
export class NativePlanGenerationError extends Error {
  constructor(alertId: string, reason: string | null) {
    super(`Native Extreme RR plan generation for ${alertId} ended in ERROR: ${reason ?? "unknown"}`);
    this.name = "NativePlanGenerationError";
  }
}

export interface NativePlanProcessorDeps {
  readonly prisma: PrismaClient;
  readonly planner: NativePlanGenerator;
}

export async function processNativePlanJob(deps: NativePlanProcessorDeps, alertId: string): Promise<NativePlanJobOutcome> {
  const alert = await deps.prisma.alert.findUnique({
    where: { id: alertId },
    select: {
      id: true,
      source: true,
      signal: true,
      rawPayload: true,
      nativeDelivery: { select: { deliveryKey: true, policyVersion: true, alertId: true } },
      extremeRRPlan: { select: { status: true } },
    },
  });
  // Deleted since the request: its plan row went with it (cascade). Nothing to do.
  if (alert === null) return { kind: "ALERT_NOT_FOUND" };

  const refusal = nativeAutoPlanRefusal(alert);
  if (refusal !== null) {
    // Never planned. A PENDING intent left on a refused NATIVE alert is closed as ERROR with the
    // reason, so it neither reads as "still planning" nor gets re-swept forever. A plan of any
    // other source (a TradingView plan's PENDING row belongs to its own pipeline) is NEVER touched.
    if (alert.source === NATIVE_ALERT_SOURCE && alert.extremeRRPlan?.status === "PENDING") {
      await deps.prisma.extremeRRPlan.updateMany({
        where: { alertId, status: "PENDING", alert: { source: NATIVE_ALERT_SOURCE } },
        // The fan-out marker is never written here (only plan generation owns it); a Native PENDING row never has one.
        data: { status: "ERROR", errorReason: `Not eligible for automatic Native planning (${refusal})` },
      });
    }
    return { kind: "REFUSED", reason: refusal };
  }

  const status = alert.extremeRRPlan?.status ?? null;
  if (status === null) return { kind: "NO_PLANNING_INTENT" };
  if (status === "READY" || status === "INVALID") return { kind: "ALREADY_FINAL", status };

  // PENDING (first attempt) or ERROR (this job's bounded retry).
  const plan = await deps.planner.generateForAlert(alertId);
  if (plan.status === "ERROR" || plan.status === "PENDING") throw new NativePlanGenerationError(alertId, plan.errorReason);
  return { kind: "GENERATED", status: plan.status };
}

// ---------------------------------------------------------------------------
// Recovery sweep: PENDING Native intents whose job is missing
// ---------------------------------------------------------------------------

/** Same policy as the TradingView vision recovery: grace, bounded batch, cadence. */
export const NATIVE_PLAN_RECOVERY_GRACE_MS = 60_000;
export const NATIVE_PLAN_RECOVERY_BATCH_SIZE = 25;
export const NATIVE_PLAN_RECOVERY_INTERVAL_MS = 60_000;

export type NativePlanRecoveryDisposition =
  /** No job existed; one was enqueued. */
  | "RECOVERED"
  /** A job is waiting, active or delayed; nothing to do. */
  | "ALREADY_QUEUED"
  /** The job ended (failed, or completed) without recording an outcome: the intent is closed as ERROR. */
  | "CLOSED_AS_ERROR"
  /** The queue could not be reached. Left for a later sweep. */
  | "QUEUE_UNAVAILABLE";

export interface NativePlanRecoverySummary {
  inspected: number;
  recovered: number;
  alreadyQueued: number;
  closedAsError: number;
  queueUnavailable: boolean;
  outcomes: { alertId: string; disposition: NativePlanRecoveryDisposition }[];
}

/**
 * One bounded pass over PENDING plans of NATIVE alerts older than the grace.
 * Only PENDING: ERROR is final once its job's bounded retries are spent (no
 * infinite retry), READY / INVALID are final, and an alert with no plan row
 * was never requested — so historical alerts are never picked up.
 */
export async function runNativePlanRecoverySweep(
  prisma: PrismaClient,
  queue: NativePlanQueue,
  options: { batchSize?: number; graceMs?: number; now?: () => Date } = {}
): Promise<NativePlanRecoverySummary> {
  const now = (options.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - (options.graceMs ?? NATIVE_PLAN_RECOVERY_GRACE_MS));
  const summary: NativePlanRecoverySummary = { inspected: 0, recovered: 0, alreadyQueued: 0, closedAsError: 0, queueUnavailable: false, outcomes: [] };

  const pending = await prisma.extremeRRPlan.findMany({
    where: { status: "PENDING", createdAt: { lte: cutoff }, alert: { source: NATIVE_ALERT_SOURCE } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: options.batchSize ?? NATIVE_PLAN_RECOVERY_BATCH_SIZE,
    select: { alertId: true },
  });

  for (const { alertId } of pending) {
    summary.inspected += 1;
    let state;
    try {
      state = await queue.stateOf(alertId);
      if (state === "missing") {
        await queue.add(alertId);
        summary.recovered += 1;
        summary.outcomes.push({ alertId, disposition: "RECOVERED" });
        continue;
      }
    } catch {
      // Almost always an unreachable Redis: stop the pass; the row is untouched and the next tick retries.
      summary.queueUnavailable = true;
      summary.outcomes.push({ alertId, disposition: "QUEUE_UNAVAILABLE" });
      break;
    }
    if (state === "failed" || state === "completed") {
      // The job is over and still no outcome was recorded (e.g. the database was unreachable on
      // every attempt). Close the intent truthfully rather than showing "planning" forever or
      // retrying without bound. The manual "Generate plan" remains available.
      await prisma.extremeRRPlan.updateMany({
        where: { alertId, status: "PENDING", alert: { source: NATIVE_ALERT_SOURCE } },
        data: { status: "ERROR", errorReason: `Automatic Native planning job ${state} without recording a plan` },
      });
      summary.closedAsError += 1;
      summary.outcomes.push({ alertId, disposition: "CLOSED_AS_ERROR" });
      continue;
    }
    summary.alreadyQueued += 1;
    summary.outcomes.push({ alertId, disposition: "ALREADY_QUEUED" });
  }
  return summary;
}
