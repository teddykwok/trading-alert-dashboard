import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import { env } from "../../config/env";
import { logger } from "../../config/logger";
import type { BoundExecutionProfileProjection } from "../execution/exchange-runtime-binding";
import type { SelectedPlanExecutor, SelectedPlanOutcome } from "../execution/selected-plan-executor";
import type { ExtremeRRService } from "../extreme-rr/extreme-rr.service";

/**
 * Phase 11E — how ONE account decides about a plan the whole system shares.
 *
 * ## What this replaces, and why
 *
 * An alert used to produce one generic `extreme-rr-plan` BullMQ job, and
 * whichever worker dequeued it created the single TradeExecution stamped with
 * that worker's own profile. BullMQ queues are competing consumers -- proved
 * from `moveToActive-11.lua`, whose `RPOPLPUSH wait -> active` guarantees "no
 * other worker picks this job again" -- so with two accounts the one that
 * traded a signal would be decided by a race, and the other would never learn
 * the opportunity existed.
 *
 * Plan GENERATION stays exactly where it was: it is shared analysis, one row
 * per alert, owned by no account. What moves here is the account's decision.
 * Each execution worker polls for plans its OWN profile has not yet evaluated
 * and evaluates them independently, so the same plan can legitimately produce
 * "admitted" for one account and "refused" for another.
 *
 * ## Why a claim, and why it comes first
 *
 * `TradeExecution @@unique([alertId, executionProfileId])` already makes a
 * duplicate execution impossible. It is not sufficient on its own, because
 * `SelectedPlanExecutor` reaches the margin planner -- signed `account` and
 * `leverageBracket` reads -- BEFORE it creates that row. Two workers for one
 * profile would both spend request weight and only then discover the race.
 *
 * So the claim is the earlier fence. It is a row insert, which means the
 * unique index decides the winner in one atomic statement, with no read to
 * race against.
 *
 * ## Why refusals are terminal
 *
 * Under the queue architecture a refusal was evaluated once: the handler
 * RETURNS an outcome rather than throwing, so the job completed and BullMQ's
 * `attempts: 2` never applied. Recording refusals as COMPLETED preserves that
 * exactly, per account. It also stops `MARGIN_PLAN_NOT_READY` -- the one
 * refusal reached only after signed reads -- from re-spending weight forever.
 */

/**
 * How long a claim stays valid before another worker for the same profile may
 * take it over.
 *
 * Generous relative to the work: the longest path is a margin plan plus an
 * admission, both already bounded by their own deadlines. A lease shorter than
 * the work would hand the plan to a second worker while the first was still
 * using it, which the fencing token would catch but only after the wasted
 * reads this claim exists to prevent.
 */
export const ADOPTION_CLAIM_LEASE_MS = 120_000;

/** Plans examined per tick. Bounded so a backlog cannot become one long pass. */
export const ADOPTION_BATCH_SIZE = 10;

export interface SelectedPlanAdoptionDependencies {
  prisma: PrismaClient;
  /** The profile this worker owns, projected from its bound runtime. */
  boundProfile: BoundExecutionProfileProjection;
  executor: SelectedPlanExecutor;
  plans: ExtremeRRService;
  /** Operational identity of this worker. Never a credential or an alias. */
  workerId: string;
}

export interface AdoptionPassSummary {
  discovered: number;
  claimed: number;
  completed: number;
  skipped: number;
}

/** A plan this profile has not finished evaluating. */
interface AdoptionCandidate {
  planId: string;
  alertId: string;
  /// The alert's symbol, read with the plan so evaluation needs no second
  /// service and no second round trip.
  symbol: string;
  /** Null when no adoption row exists yet; set when reclaiming a stale lease. */
  adoptionId: string | null;
  attempts: number;
}

export class SelectedPlanAdoptionService {
  constructor(private readonly deps: SelectedPlanAdoptionDependencies) {}

  /**
   * The eligibility fence, and the reason a brand-new execution worker does
   * not treat the whole historical plan table as fresh work.
   *
   * `cutoffAt` is the alert's own trigger instant (`extreme-rr.service.ts` sets
   * `const cutoff = alert.triggeredAt`), so it is ALWAYS in the past -- it is a
   * candle cutoff, not a deadline. The repository's actual signal-lifetime rule
   * is `EXECUTION_MAX_ALERT_AGE_SECONDS`, which the entry lifecycle already
   * enforces against the same instant: a signal older than that is refused with
   * "the signal is Ns old, beyond the Ns limit".
   *
   * Using the same instant and the same limit here means adoption offers a plan
   * only while the system would still be willing to trade it. Every plan that
   * existed before this worker was introduced is far older, so none is adopted.
   */
  private freshnessFloor(now: Date): Date {
    return new Date(now.getTime() - env.EXECUTION_MAX_ALERT_AGE_SECONDS * 1000);
  }

  /**
   * Plans this profile may still evaluate.
   *
   * The profile predicate is in the QUERY, on both halves: the `none` filter
   * names this profile's COMPLETED rows, and the reclaim filter names this
   * profile's expired leases. Nothing is filtered for ownership in memory.
   */
  private async discover(now: Date, limit: number): Promise<AdoptionCandidate[]> {
    const executionProfileId = this.deps.boundProfile.executionProfileId;
    const staleBefore = new Date(now.getTime() - ADOPTION_CLAIM_LEASE_MS);

    const plans = await this.deps.prisma.extremeRRPlan.findMany({
      where: {
        status: "READY",
        // THE ROLLOUT FENCE, and the reason signal lifetime is not enough.
        //
        // A plan the pre-11E worker already evaluated and refused leaves no
        // TradeExecution and no adoption row, so nothing else here can tell
        // it apart from new work -- and if it is still inside the signal
        // lifetime it would be evaluated a SECOND time, re-spending signed
        // account reads and possibly deciding differently. Correctness must
        // not depend on every production plan happening to be old enough.
        //
        // The marker is written only by the 11E generic READY transition, so
        // its absence is a durable fact about which architecture produced
        // the plan, not a guess about when the deployment happened.
        executionFanoutReadyAt: { not: null },
        cutoffAt: { gt: this.freshnessFloor(now) },
        OR: [
          // Never offered to this profile.
          { selectedPlanAdoptions: { none: { executionProfileId } } },
          // Offered, claimed, and the claimer went away.
          {
            selectedPlanAdoptions: {
              some: {
                executionProfileId,
                status: "PENDING",
                claimedAt: { lt: staleBefore },
              },
            },
          },
        ],
      },
      orderBy: [{ cutoffAt: "asc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        alertId: true,
        alert: { select: { symbol: true } },
        selectedPlanAdoptions: {
          where: { executionProfileId },
          select: { id: true, attempts: true, status: true },
        },
      },
    });

    return plans.map((plan) => {
      const mine = plan.selectedPlanAdoptions[0] ?? null;
      return {
        planId: plan.id,
        alertId: plan.alertId,
        symbol: plan.alert.symbol,
        adoptionId: mine && mine.status === "PENDING" ? mine.id : null,
        attempts: mine?.attempts ?? 0,
      };
    });
  }

  /**
   * Wins the right to evaluate one plan for this profile, or returns null.
   *
   * Two shapes, one meaning. A first claim is an INSERT, so the unique index
   * decides the winner atomically and the loser's P2002 is simply "someone else
   * is doing it". A reclaim is a conditional update that re-asserts the exact
   * `attempts` it read, which is the fencing token: two reclaimers cannot both
   * win, and the loser writes nothing.
   */
  private async claim(candidate: AdoptionCandidate, now: Date): Promise<string | null> {
    const executionProfileId = this.deps.boundProfile.executionProfileId;
    const claimOwner = `${this.deps.workerId}:${randomUUID()}`;

    if (candidate.adoptionId === null) {
      try {
        const created = await this.deps.prisma.selectedPlanAdoption.create({
          data: {
            extremeRRPlanId: candidate.planId,
            executionProfileId,
            status: "PENDING",
            attempts: 1,
            claimedAt: now,
            claimOwner,
          },
          select: { id: true },
        });
        return created.id;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          // Another worker for this profile inserted first. It owns the
          // evaluation; we have spent nothing.
          return null;
        }
        throw error;
      }
    }

    const won = await this.deps.prisma.selectedPlanAdoption.updateMany({
      where: {
        id: candidate.adoptionId,
        // Still unfinished, and still holding the attempts value we read. A
        // reclaimer that beat us has already incremented it.
        status: "PENDING",
        attempts: candidate.attempts,
      },
      data: { attempts: { increment: 1 }, claimedAt: now, claimOwner },
    });
    return won.count === 1 ? candidate.adoptionId : null;
  }

  /**
   * Writes the terminal verdict, fenced on the claim we still hold.
   *
   * `attempts` is re-asserted so a stalled previous owner cannot overwrite the
   * result a reclaimer wrote, and `status: "PENDING"` is re-asserted so a
   * COMPLETED row is never rewritten -- terminal means terminal.
   */
  private async complete(
    adoptionId: string,
    attempts: number,
    outcome: SelectedPlanOutcome,
    evaluatedAt: Date
  ): Promise<boolean> {
    const won = await this.deps.prisma.selectedPlanAdoption.updateMany({
      where: { id: adoptionId, status: "PENDING", attempts },
      data: {
        status: "COMPLETED",
        handled: outcome.handled,
        reasonCode: outcome.reasonCode,
        message: outcome.handled ? null : outcome.message.slice(0, 1000),
        executionId: outcome.handled ? outcome.executionId : null,
        evaluatedAt,
        completedAt: new Date(),
        claimedAt: null,
        claimOwner: null,
      },
    });
    return won.count === 1;
  }

  /**
   * One bounded pass: discover, claim, evaluate, record.
   *
   * At-least-once discovery with per-profile idempotency, never distributed
   * exactly-once. A crash between the claim and the terminal write leaves a
   * PENDING row whose lease expires, and the next worker for this profile
   * finishes it -- adopting the TradeExecution if one was already created,
   * because `createExecutionFromReadyPlan` returns the existing row rather than
   * creating a second, and `admitAndSubmit` replays per version rather than
   * submitting again.
   */
  async runOnce(limit: number = ADOPTION_BATCH_SIZE): Promise<AdoptionPassSummary> {
    const now = new Date();
    const summary: AdoptionPassSummary = { discovered: 0, claimed: 0, completed: 0, skipped: 0 };

    const candidates = await this.discover(now, limit);
    summary.discovered = candidates.length;

    for (const candidate of candidates) {
      const adoptionId = await this.claim(candidate, now);
      if (adoptionId === null) {
        summary.skipped += 1;
        continue;
      }
      summary.claimed += 1;
      const heldAttempts = candidate.attempts + 1;

      // Only now, behind the claim, does anything expensive or signed happen.
      const evaluatedAt = new Date();
      let outcome: SelectedPlanOutcome;
      try {
        // READ-ONLY. `getForAlert` returns the persisted plan; regenerating
        // one here would make an execution worker do the generic worker's
        // analysis, which is exactly the split this slice exists to make.
        const plan = await this.deps.plans.getForAlert(candidate.alertId);
        if (!plan) {
          summary.skipped += 1;
          continue;
        }
        outcome = await this.deps.executor.handleSelectedPlan(plan, candidate.symbol);
      } catch (error) {
        // The claim's lease is what recovers this: the row stays PENDING and a
        // later pass retries it, exactly as a thrown BullMQ job would have been
        // retried. Sanitized message only.
        logger.error(
          {
            planId: candidate.planId,
            error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
          },
          "Selected-plan adoption threw — the claim lease will release it for retry"
        );
        continue;
      }

      if (await this.complete(adoptionId, heldAttempts, outcome, evaluatedAt)) {
        summary.completed += 1;
        logger.info(
          {
            planId: candidate.planId,
            handled: outcome.handled,
            reasonCode: outcome.reasonCode,
          },
          "Selected plan adopted for this profile"
        );
      } else {
        // Another worker reclaimed while we evaluated. Its result stands.
        summary.skipped += 1;
      }
    }

    return summary;
  }
}

/**
 * How often a bound execution worker looks for plans its profile has not yet
 * evaluated.
 *
 * Faster than reconciliation because this is the admission path for a fresh
 * signal, and a signal is only tradeable for EXECUTION_MAX_ALERT_AGE_SECONDS.
 */
export const ADOPTION_INTERVAL_MS = 5_000;

/** Process-local single-flight, matching every other scheduler in this module. */
let passInFlight = false;

export function startSelectedPlanAdoptionScheduler(
  service: SelectedPlanAdoptionService,
  intervalMs: number = ADOPTION_INTERVAL_MS
): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (passInFlight) return;
    passInFlight = true;
    void service
      .runOnce()
      .catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
          "Selected-plan adoption pass failed — the next tick retries"
        );
      })
      .finally(() => {
        passInFlight = false;
      });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

/** Test-only: clears the single-flight guard between cases. */
export function resetAdoptionPassGuardForTests(): void {
  passInFlight = false;
}
