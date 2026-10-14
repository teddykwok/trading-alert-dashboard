import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { ExtremeRRPlanDto, NativeAccountPlanPolicy, NativeExecutionIntegrityDto } from "@trading-alert-dashboard/shared";

import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { NATIVE_ALERT_SOURCE } from "../alerts/alert-source";
import type { BoundExecutionProfileProjection } from "../execution/exchange-runtime-binding";
import type { SelectedPlanExecutor } from "../execution/selected-plan-executor";
import {
  NATIVE_CANARY_SOURCE_TIMEFRAMES,
  decideNativeAccountACandidate,
  nativeAccountAExecutionPolicy,
  nativeAdoptionDefers,
  nativeCanaryIntegrityOf,
  type NativeAccountAOutcome,
  type NativeAccountGates,
  type NativeAccountSlot,
  type NativeCanaryAlert,
} from "./native-account-a-canary";
import { nativeAccountSlotOf } from "./native-account-slot";
import { nativeFenceRuntimeFromEnv, type NativeFenceRuntime } from "./native-execution-fence";
import { NATIVE_EXECUTION_ENABLED } from "./native-execution-switch";
import { loadNativeOccupancyRows } from "./native-occupancy";
import { nativeSignalLifetimeSpan } from "./native-signal-freshness";

/**
 * NATIVE ACCOUNT A ADOPTION: how Account A would decide about a Native plan.
 *
 * The same per-account adoption model TradingView plans use, on the same
 * table, with the same protocol:
 *
 *  - one SelectedPlanAdoption row per (plan, profile), won by a unique-index
 *    INSERT, so a retry, a restart or a second worker for the same profile can
 *    never produce a second intent;
 *  - the claim is durable BEFORE anything else happens, and a reclaim of an
 *    expired lease re-asserts the `attempts` fencing token it read AND that
 *    the lease really is expired (see `claim`);
 *  - the verdict is terminal: a refusal is recorded once and never re-run.
 *
 * The claim is per PLAN. It does not, and is not meant to, serialize two
 * different plans for the same account + symbol + side: that is
 * `reserveNativeOccupancy`, under its own lock, at execution creation.
 *
 * What differs is eligibility. Discovery offers only READY plans of NATIVE
 * 1D/1W alerts whose trigger instant is inside the Native signal lifetime
 * (native-signal-freshness.ts), and the verdict comes from
 * `decideNativeAccountACandidate`, whose FRESHNESS stage makes the exact
 * freshness judgment and whose last stages are the hard Native fence and the
 * Native risk contract. Only an admitted decision hands a capability to the
 * EXISTING executor; everything else completes the row with a typed refusal.
 *
 * Time: a caller-fixed `now` (tests) is used for every step of a pass;
 * otherwise each step reads the clock afresh, so no candidate is ever judged
 * against an instant older than its own evaluation.
 *
 * DORMANT: `startNativeAccountAAdoptionScheduler` starts nothing unless
 * NATIVE_EXECUTION_ENABLED is true AND this process is exactly Account A.
 * Neither is true today, so no pass ever runs and no row is ever written by
 * this module in production.
 */

/** Same lease as TradingView adoption: generous against margin planning plus admission. */
export const NATIVE_ADOPTION_CLAIM_LEASE_MS = 120_000;

/** Plans examined per pass. */
export const NATIVE_ADOPTION_BATCH_SIZE = 10;

/** How often a pass runs, when it runs at all. */
export const NATIVE_ADOPTION_INTERVAL_MS = 5_000;

export interface NativeAccountAAdoptionDependencies {
  prisma: PrismaClient;
  /** The profile this worker owns, projected from its bound runtime. */
  boundProfile: BoundExecutionProfileProjection;
  executor: Pick<SelectedPlanExecutor, "handleNativeAccountACandidate">;
  /** READ-ONLY use: the persisted plan, never a regenerated one. */
  plans: { getForAlert(alertId: string): Promise<ExtremeRRPlanDto | null> };
  /** Operational identity of this worker. Never a credential or an alias. */
  workerId: string;
  /** Which account this process is. Only ACCOUNT_A ever gets past the first stage. */
  accountSlot: NativeAccountSlot;
  /** Account A's Native planner window policy (candles, never dollars). */
  accountPlanPolicy: NativeAccountPlanPolicy;
  /** Where the source bar's scanner evidence is read from. */
  fence: NativeFenceRuntime;
  /** The live-entry gates THIS process loaded. */
  environmentGates: NativeAccountGates["environment"];
}

export interface NativeAdoptionPassSummary {
  discovered: number;
  /** Source bar still forming: left unclaimed, offered again on a later pass. */
  deferred: number;
  claimed: number;
  completed: number;
  skipped: number;
}

interface NativeAdoptionCandidate {
  planId: string;
  alertId: string;
  /** Null when no adoption row exists yet; set when reclaiming an expired lease. */
  adoptionId: string | null;
  attempts: number;
}

const ALERT_SELECT = { id: true, source: true, symbol: true, signal: true, sourceTimeframe: true, triggeredAt: true, rawPayload: true } as const;

export class NativeAccountAAdoptionService {
  constructor(private readonly deps: NativeAccountAAdoptionDependencies) {}

  /**
   * Discovery's window over the plan's cutoff (its alert's trigger instant):
   * only trigger instants that can still be fresh, i.e. no older than the
   * Native absolute cap and not in the future. A superset of the fresh ones;
   * the decision's FRESHNESS stage makes the exact judgment.
   */
  private lifetimeWindow(now: Date): { gte: Date; lte: Date } {
    const span = nativeSignalLifetimeSpan(now.getTime());
    return { gte: new Date(span.earliestTriggeredAtMs), lte: new Date(span.latestTriggeredAtMs) };
  }

  private integrityOf(alert: NativeCanaryAlert): NativeExecutionIntegrityDto | null {
    return nativeCanaryIntegrityOf(alert, this.deps.fence.evidence);
  }

  /** Native plans this profile has not finished evaluating. The profile predicate is in the query. */
  private async discover(now: Date, limit: number): Promise<NativeAdoptionCandidate[]> {
    const executionProfileId = this.deps.boundProfile.executionProfileId;
    const staleBefore = new Date(now.getTime() - NATIVE_ADOPTION_CLAIM_LEASE_MS);

    const plans = await this.deps.prisma.extremeRRPlan.findMany({
      where: {
        status: "READY",
        cutoffAt: this.lifetimeWindow(now),
        alert: { source: NATIVE_ALERT_SOURCE, sourceTimeframe: { in: [...NATIVE_CANARY_SOURCE_TIMEFRAMES] } },
        OR: [
          { selectedPlanAdoptions: { none: { executionProfileId } } },
          { selectedPlanAdoptions: { some: { executionProfileId, status: "PENDING", claimedAt: { lt: staleBefore } } } },
        ],
      },
      orderBy: [{ cutoffAt: "asc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        alertId: true,
        alert: { select: { source: true } },
        selectedPlanAdoptions: { where: { executionProfileId }, select: { id: true, attempts: true, status: true } },
      },
    });

    // Defense in depth: re-check the row the query actually returned.
    return plans
      .filter((plan) => plan.alert.source === NATIVE_ALERT_SOURCE)
      .map((plan) => {
        const mine = plan.selectedPlanAdoptions[0] ?? null;
        return {
          planId: plan.id,
          alertId: plan.alertId,
          adoptionId: mine && mine.status === "PENDING" ? mine.id : null,
          attempts: mine?.attempts ?? 0,
        };
      });
  }

  /** Wins the right to evaluate one plan for this profile, or returns null. */
  private async claim(candidate: NativeAdoptionCandidate, now: Date): Promise<string | null> {
    const executionProfileId = this.deps.boundProfile.executionProfileId;
    const claimOwner = `${this.deps.workerId}:${randomUUID()}`;

    if (candidate.adoptionId === null) {
      try {
        const created = await this.deps.prisma.selectedPlanAdoption.create({
          data: { extremeRRPlanId: candidate.planId, executionProfileId, status: "PENDING", attempts: 1, claimedAt: now, claimOwner },
          select: { id: true },
        });
        return created.id;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
        throw error;
      }
    }

    // A reclaim must re-assert that the lease it is taking really EXPIRED.
    // Discovery's relation read is a separate query from its WHERE, so it can
    // return a claim another worker made a moment ago; fencing on `attempts`
    // alone would then steal a LIVE lease and evaluate the plan twice at once.
    const won = await this.deps.prisma.selectedPlanAdoption.updateMany({
      where: {
        id: candidate.adoptionId,
        status: "PENDING",
        attempts: candidate.attempts,
        claimedAt: { lt: new Date(now.getTime() - NATIVE_ADOPTION_CLAIM_LEASE_MS) },
      },
      data: { attempts: { increment: 1 }, claimedAt: now, claimOwner },
    });
    return won.count === 1 ? candidate.adoptionId : null;
  }

  /** Writes the terminal verdict, fenced on the claim still held. COMPLETED is never rewritten. */
  private async complete(adoptionId: string, attempts: number, outcome: NativeAccountAOutcome, evaluatedAt: Date): Promise<boolean> {
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
   * Reads every fact, decides at `evaluatedAt`, and hands an admitted
   * candidate to the existing executor with a fresh instant from `clock`.
   */
  private async evaluate(alertId: string, evaluatedAt: Date, clock: () => Date): Promise<NativeAccountAOutcome> {
    const executionProfileId = this.deps.boundProfile.executionProfileId;
    const alert = await this.deps.prisma.alert.findUnique({ where: { id: alertId }, select: ALERT_SELECT });
    if (alert === null) return { handled: false, reasonCode: "AMBIGUOUS_STATE", message: `Alert ${alertId} no longer exists.` };

    const plan = await this.deps.plans.getForAlert(alertId);
    const integrity = this.integrityOf(alert);
    // An early, advisory read. The authoritative re-read happens under the
    // (profile, symbol, side) lock when the execution row is created.
    const occupancy = await loadNativeOccupancyRows(this.deps.prisma, executionProfileId, alert.symbol);
    const profile = await this.deps.prisma.executionProfile.findUnique({
      where: { id: executionProfileId },
      select: { isEnabled: true, safetyPolicy: { select: { killSwitchActive: true } } },
    });

    const decision = decideNativeAccountACandidate({
      accountSlot: this.deps.accountSlot,
      executionProfileId,
      alert,
      plan,
      accountPlanPolicy: this.deps.accountPlanPolicy,
      integrity,
      occupancy,
      accountGates: {
        environment: this.deps.environmentGates,
        profile: profile === null ? null : { isEnabled: profile.isEnabled, killSwitchActive: profile.safetyPolicy?.killSwitchActive ?? null },
      },
      nowMs: evaluatedAt.getTime(),
    });
    if (!decision.admitted) {
      return { handled: false, reasonCode: decision.reasonCode, message: `${decision.stage}: ${decision.detail}` };
    }
    // Only an admitted decision gets here, and only it can carry a hand-off.
    return this.deps.executor.handleNativeAccountACandidate(decision.handoff, clock());
  }

  /**
   * One bounded pass: discover, defer a still-forming source bar, claim,
   * evaluate, record. At-least-once discovery with per-profile idempotency.
   */
  async runOnce(limit: number = NATIVE_ADOPTION_BATCH_SIZE, now?: Date): Promise<NativeAdoptionPassSummary> {
    const clock = () => now ?? new Date();
    const summary: NativeAdoptionPassSummary = { discovered: 0, deferred: 0, claimed: 0, completed: 0, skipped: 0 };
    const candidates = await this.discover(clock(), limit);
    summary.discovered = candidates.length;

    for (const candidate of candidates) {
      // A bar that has not closed yet is not a refusal while its signal is
      // still fresh: it is not decidable yet. Nothing is written, and a later
      // pass offers it again. Once the signal is no longer fresh it is never
      // deferred: the decision records its terminal FRESHNESS refusal.
      const preview = await this.deps.prisma.alert.findUnique({ where: { id: candidate.alertId }, select: ALERT_SELECT });
      if (preview !== null && nativeAdoptionDefers(preview, this.integrityOf(preview), clock().getTime())) {
        summary.deferred += 1;
        continue;
      }

      const adoptionId = await this.claim(candidate, clock());
      if (adoptionId === null) {
        summary.skipped += 1;
        continue;
      }
      summary.claimed += 1;
      const heldAttempts = candidate.attempts + 1;

      const evaluatedAt = clock();
      let outcome: NativeAccountAOutcome;
      try {
        outcome = await this.evaluate(candidate.alertId, evaluatedAt, clock);
      } catch (error) {
        // The lease recovers this: the row stays PENDING and a later pass retries it.
        logger.error(
          { planId: candidate.planId, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
          "Native Account A adoption threw; the claim lease will release it for retry"
        );
        continue;
      }

      if (await this.complete(adoptionId, heldAttempts, outcome, evaluatedAt)) {
        summary.completed += 1;
        logger.info({ planId: candidate.planId, handled: outcome.handled, reasonCode: outcome.reasonCode }, "Native plan evaluated for Account A");
      } else {
        summary.skipped += 1;
      }
    }
    return summary;
  }
}

/** Process-local single-flight. */
let nativePassInFlight = false;

export interface NativeAccountASchedulerInput {
  prisma: PrismaClient;
  boundProfile: BoundExecutionProfileProjection;
  executor: Pick<SelectedPlanExecutor, "handleNativeAccountACandidate">;
  plans: NativeAccountAAdoptionDependencies["plans"];
  workerId: string;
  /** This process's launch environment, from which its account and gates are read. */
  processEnv: NodeJS.ProcessEnv;
  intervalMs?: number;
}

/**
 * Starts Native Account A adoption, or returns null and starts NOTHING.
 *
 * Two guards, both required, both checked before anything is constructed:
 * Native execution must be enabled in code, and this process must be exactly
 * Account A. Today the first is false, so this always returns null.
 */
export async function startNativeAccountAAdoptionScheduler(input: NativeAccountASchedulerInput): Promise<NodeJS.Timeout | null> {
  if (!NATIVE_EXECUTION_ENABLED) return null;
  const accountSlot = nativeAccountSlotOf(input.processEnv);
  if (accountSlot !== "ACCOUNT_A") return null;
  // Fixed in code. The account process's own environment can only make this
  // refuse (a disagreeing override), never choose a different window.
  const accountPlanPolicy = nativeAccountAExecutionPolicy(input.processEnv.NATIVE_PLAN_DEFAULT_LOOKBACK_A);

  const service = new NativeAccountAAdoptionService({
    prisma: input.prisma,
    boundProfile: input.boundProfile,
    executor: input.executor,
    plans: input.plans,
    workerId: input.workerId,
    accountSlot,
    accountPlanPolicy,
    fence: nativeFenceRuntimeFromEnv(input.processEnv),
    environmentGates: {
      globalKillSwitch: env.EXECUTION_GLOBAL_KILL_SWITCH,
      liveEntryEnabled: env.EXECUTION_LIVE_ENTRY_ENABLED,
      protectionReady: env.EXECUTION_PROTECTION_READY,
    },
  });
  const timer = setInterval(() => {
    if (nativePassInFlight) return;
    nativePassInFlight = true;
    void service
      .runOnce()
      .catch((error) => {
        logger.error({ error: error instanceof Error ? error.message.slice(0, 300) : "unknown" }, "Native Account A adoption pass failed; the next tick retries");
      })
      .finally(() => {
        nativePassInFlight = false;
      });
  }, input.intervalMs ?? NATIVE_ADOPTION_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
