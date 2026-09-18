import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, resolveTestDatabase } from "./helpers/test-database";
import {
  HistoricalFillBatchDriver,
  FillBatchRefusedError,
  type FillIngestExecutionOutcome,
} from "../src/modules/execution/exchange-fill-batch-driver.service";
import { HistoricalFillWeightBudgetService } from "../src/modules/execution/historical-fill-weight-budget.service";
import { HistoricalFillCampaignGate } from "../src/modules/execution/historical-fill-campaign-gate.service";
import { HistoricalFillCampaignService } from "../src/modules/execution/historical-fill-campaign.service";
import { HistoricalFillCircuitBreakerService } from "../src/modules/execution/historical-fill-circuit-breaker.service";

/**
 * RUNTIME ACTIVATION, against a REAL Postgres.
 *
 * Every slice before this one could refuse work while the latch was open, but
 * nothing could open it: a trip needed a human. This file is the proof that a
 * scheduled loop now stops itself -- that repeated systemic failure closes the
 * circuit, that the pass ends on the failure that caused it rather than one
 * dispatch later, and that the classification stays entirely in the breaker
 * service where the driver cannot quietly grow a second opinion.
 *
 * The bootstrap and executor are scripted; everything between them -- gate,
 * admission, refund, observation, breaker -- is the real implementation on the
 * real database. NO Binance client is constructed here or in the code under
 * test, and nothing performs network I/O.
 */

const TAG = "fill-circuit-activation-synthetic";
const AMPLE_CAP = 500;

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const maybe = () => (available ? it : it.skip);

const clients: PrismaClient[] = [];
function independentClient(): PrismaClient {
  const client = new PrismaClient({ datasources: { db: { url: resolveTestDatabase().url } } });
  clients.push(client);
  return client;
}

let campaigns: HistoricalFillCampaignService;
let breaker: HistoricalFillCircuitBreakerService;

async function makeProfile(suffix: string): Promise<string> {
  const profile = await prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${suffix}`,
      exchange: "BINANCE",
      product: "USD_M_FUTURES",
      environment: "TESTNET",
      accountIdentifier: `${TAG}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
    select: { id: true },
  });
  return profile.id;
}

async function withCampaign(suffix: string, maxDispatches = 10) {
  const executionProfileId = await makeProfile(suffix);
  const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches });
  return { executionProfileId, campaignId: campaign.id };
}

/** A durable executor result, scripted as `OUTCOME:REASON` or just `OUTCOME`. */
type Script = string;

/** One simulated worker: its own client, budget, gate, breaker and driver. */
function workerProcess(options: { executionProfileId: string; script?: Script[]; client?: PrismaClient }) {
  const client = options.client ?? independentClient();
  const queue = [...(options.script ?? [])];

  const executeOne = vi.fn(async () => {
    const next = queue.shift() ?? "NO_WORK";
    const [outcome, reasonCode] = next.split(":");
    return reasonCode === undefined
      ? { outcome: outcome as FillIngestExecutionOutcome }
      : { outcome: outcome as FillIngestExecutionOutcome, reasonCode };
  });

  const bootstrapHistoricalRoots = vi.fn(async () => ({
    outcome: "BOOTSTRAPPED" as const,
    executionProfileId: options.executionProfileId,
    horizonDays: 30,
    symbolCount: 1,
    dayCount: 30,
    expectedRootCount: 30,
    alreadyCompatibleCount: 30,
    createdCount: 0,
    raceReconciledCount: 0,
  }));

  const driver = new HistoricalFillBatchDriver({
    bootstrap: { bootstrapHistoricalRoots } as never,
    executor: { executeOne } as never,
    weightBudget: new HistoricalFillWeightBudgetService(client),
    campaigns: new HistoricalFillCampaignGate({
      prisma: client,
      // Injected because the real binder reads process configuration, which
      // cannot name a synthetic profile. Everything below it is real.
      bindProfile: async () =>
        ({ ok: true, context: { executionProfileId: options.executionProfileId } }) as never,
    }),
    circuitBreaker: new HistoricalFillCircuitBreakerService(client),
  });

  return { driver, executeOne, bootstrapHistoricalRoots };
}

const runBatch = (driver: HistoricalFillBatchDriver, overrides: Record<string, unknown> = {}) =>
  driver.runHistoricalFillBatch({
    workerId: `${TAG}-worker`,
    now: new Date(),
    horizonDays: 30,
    maxWindows: 5,
    maxUserTradesWeight: 100,
    globalUserTradesWeightPerMinute: AMPLE_CAP,
    ...overrides,
  } as never);

async function campaignRow(campaignId: string) {
  return prisma!.historicalFillCampaign.findUniqueOrThrow({ where: { id: campaignId } });
}

async function circuit(executionProfileId: string) {
  return breaker.readState({ executionProfileId });
}

async function activeCount(executionProfileId: string): Promise<number> {
  return prisma!.historicalFillCampaign.count({ where: { executionProfileId, status: "ACTIVE" } });
}

beforeAll(() => {
  if (!prisma) return;
  campaigns = new HistoricalFillCampaignService(prisma);
  breaker = new HistoricalFillCircuitBreakerService(prisma);
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});

describe("a hard systemic fault stops the account on its first dispatch", () => {
  maybe()("opens the circuit, pauses the campaign and ends the pass", async () => {
    const { executionProfileId, campaignId } = await withCampaign("hard-auth", 10);
    const worker = workerProcess({
      executionProfileId,
      script: ["RETRY_SCHEDULED:AUTH", "COMPLETE", "COMPLETE", "COMPLETE", "COMPLETE"],
    });

    const result = await runBatch(worker.driver);

    // ONE dispatch, not five: the loop had budget for four more and stopped.
    expect(worker.executeOne).toHaveBeenCalledTimes(1);
    expect(result.executionInvocations).toBe(1);
    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    // The triggering result is still counted -- its request reached the exchange.
    expect(result.outcomes.RETRY_SCHEDULED).toBe(1);

    const state = await circuit(executionProfileId);
    expect(state.state).toBe("OPEN");
    expect(state.failureFamily).toBe("HARD_CONFIGURATION");
    expect(state.lastReasonCode).toBe("AUTH");
    expect(state.generation).toBe(1);

    // The campaign is reported as it now IS, not as the pass last saw it.
    expect((await campaignRow(campaignId)).status).toBe("PAUSED");
    expect(result.campaignStatus).toBe("PAUSED");
    expect(await activeCount(executionProfileId)).toBe(0);

    // Exactly one slot and one dispatch's weight were spent.
    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(1);
    expect(result.userTradesWeightUsed).toBe(5);
  });

  maybe()("carries the transition metadata, and only on the transition", async () => {
    const { executionProfileId, campaignId } = await withCampaign("hard-metadata", 10);
    const result = await runBatch(
      workerProcess({ executionProfileId, script: ["RETRY_SCHEDULED:AUTH"] }).driver
    );
    if (result.outcome !== "SYSTEMIC_CIRCUIT_OPEN") throw new Error("unreachable");

    expect(result.circuitOpened).not.toBeNull();
    expect(result.circuitOpened).toEqual({
      campaignId,
      failureFamily: "HARD_CONFIGURATION",
      lastReasonCode: "AUTH",
      consecutiveCount: 1,
      threshold: 1,
      openedAt: (await circuit(executionProfileId)).openedAt,
    });
    // No generation, no account identifier anywhere in it.
    expect(Object.keys(result.circuitOpened!).sort()).toEqual([
      "campaignId",
      "consecutiveCount",
      "failureFamily",
      "lastReasonCode",
      "openedAt",
      "threshold",
    ]);
  });

  maybe()("the NEXT pass is refused by the gate, before the bootstrap", async () => {
    const { executionProfileId } = await withCampaign("hard-next-pass", 10);
    await runBatch(workerProcess({ executionProfileId, script: ["RETRY_SCHEDULED:AUTH"] }).driver);

    const next = workerProcess({ executionProfileId, script: ["COMPLETE"] });
    const result = await runBatch(next.driver);

    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    expect(result.bootstrap).toBeNull();
    expect(result.executionInvocations).toBe(0);
    expect(next.bootstrapHistoricalRoots).not.toHaveBeenCalled();
    expect(next.executeOne).not.toHaveBeenCalled();
    // Discovering an open latch is not a transition, so nothing to log twice.
    if (result.outcome !== "SYSTEMIC_CIRCUIT_OPEN") throw new Error("unreachable");
    expect(result.circuitOpened).toBeNull();
  });

  maybe()("a FINAL-slot fault leaves the campaign EXHAUSTED, never PAUSED", async () => {
    // The campaign ended by spending its last slot; the fault must not rewrite
    // that into a pause, which would misreport why the backfill stopped.
    const { executionProfileId, campaignId } = await withCampaign("final-slot", 1);
    const worker = workerProcess({ executionProfileId, script: ["RETRY_SCHEDULED:AUTH", "COMPLETE"] });

    const result = await runBatch(worker.driver);

    expect(worker.executeOne).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    expect((await campaignRow(campaignId)).status).toBe("EXHAUSTED");
    expect(result.campaignStatus).toBe("EXHAUSTED");
    expect(await activeCount(executionProfileId)).toBe(0);

    const state = await circuit(executionProfileId);
    expect(state.state).toBe("OPEN");
    expect(state.generation).toBe(1);

    // And the next pass does nothing at all.
    const next = workerProcess({ executionProfileId, script: ["COMPLETE"] });
    const after = await runBatch(next.driver);
    expect(after.executionInvocations).toBe(0);
    expect(next.bootstrapHistoricalRoots).not.toHaveBeenCalled();
  });
});

describe("threshold families accumulate through the driver, and trip on time", () => {
  maybe()("three transport failures trip on the THIRD, not the fourth", async () => {
    const { executionProfileId, campaignId } = await withCampaign("threshold-trip", 10);
    const worker = workerProcess({
      executionProfileId,
      // Same family, three different codes -- the streak is per FAMILY.
      script: ["RETRY_SCHEDULED:NETWORK", "RETRY_SCHEDULED:TIMEOUT", "RETRY_SCHEDULED:SERVER", "COMPLETE"],
    });

    const result = await runBatch(worker.driver, { maxWindows: 4 });

    // EXACTLY three. A fourth would be one dispatch past the bound.
    expect(worker.executeOne).toHaveBeenCalledTimes(3);
    expect(result.executionInvocations).toBe(3);
    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    // All three are RETRYABLE Binance kinds, so on a normal attempt the window
    // keeps its budget and each reports RETRY_SCHEDULED. The ACCOUNT does not
    // get the same benefit of the doubt, which is the whole point.
    expect(result.outcomes.RETRY_SCHEDULED).toBe(3);
    expect(result.outcomes.ABANDONED).toBe(0);

    const state = await circuit(executionProfileId);
    expect(state.state).toBe("OPEN");
    expect(state.failureFamily).toBe("TRANSIENT_TRANSPORT");
    expect(state.consecutiveCount).toBe(3);
    expect(state.generation).toBe(1);
    expect((await campaignRow(campaignId)).status).toBe("PAUSED");
  });

  maybe()("a family switch restarts the count at one, through the driver", async () => {
    const { executionProfileId } = await withCampaign("family-switch", 10);
    const worker = workerProcess({
      executionProfileId,
      script: [
        "RETRY_SCHEDULED:NETWORK",
        "RETRY_SCHEDULED:RATE_LIMIT",
        "RETRY_SCHEDULED:RATE_LIMIT",
        "RETRY_SCHEDULED:RATE_LIMIT",
        "COMPLETE",
      ],
    });

    const result = await runBatch(worker.driver, { maxWindows: 5 });

    // NETWORK(1) then RATE_LIMIT 1,2,3 -- the switch reset the count, so the
    // trip lands on the fourth dispatch rather than the third.
    expect(worker.executeOne).toHaveBeenCalledTimes(4);
    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    const state = await circuit(executionProfileId);
    expect(state.failureFamily).toBe("RATE_LIMIT");
    expect(state.consecutiveCount).toBe(3);
  });

  maybe()("a healthy COMPLETE resets the streak through the driver", async () => {
    const { executionProfileId, campaignId } = await withCampaign("healthy-reset", 10);
    const worker = workerProcess({
      executionProfileId,
      script: [
        "RETRY_SCHEDULED:NETWORK",
        "RETRY_SCHEDULED:TIMEOUT",
        "COMPLETE",
        "RETRY_SCHEDULED:NETWORK",
        "RETRY_SCHEDULED:TIMEOUT",
      ],
    });

    const result = await runBatch(worker.driver, { maxWindows: 5 });

    // All five ran: the COMPLETE cleared the streak, so the two after it are
    // counts one and two rather than three and four.
    expect(worker.executeOne).toHaveBeenCalledTimes(5);
    expect(result.outcome).toBe("MAX_WINDOWS_REACHED");

    const state = await circuit(executionProfileId);
    expect(state.state).toBe("CLOSED");
    expect(state.consecutiveCount).toBe(2);
    expect(state.generation).toBe(0);
    expect((await campaignRow(campaignId)).status).toBe("ACTIVE");
  });

  maybe()("a request-contract fault trips on its own family", async () => {
    const { executionProfileId } = await withCampaign("request-contract", 10);
    const worker = workerProcess({
      executionProfileId,
      script: ["ABANDONED:REQUEST_INVALID", "ABANDONED:REQUEST_INVALID", "ABANDONED:REQUEST_INVALID", "COMPLETE"],
    });

    const result = await runBatch(worker.driver, { maxWindows: 4 });

    expect(worker.executeOne).toHaveBeenCalledTimes(3);
    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    expect((await circuit(executionProfileId)).failureFamily).toBe("REQUEST_CONTRACT");
  });

  maybe()("a malformed-response fault trips on its own family", async () => {
    const { executionProfileId } = await withCampaign("malformed", 10);
    const worker = workerProcess({
      executionProfileId,
      script: [
        "RETRY_SCHEDULED:MALFORMED_RESPONSE",
        "ABANDONED:USER_TRADES_SYMBOL_MISMATCH",
        "ABANDONED:USER_TRADES_ROW_COUNT_EXCEEDS_LIMIT",
        "COMPLETE",
      ],
    });

    const result = await runBatch(worker.driver, { maxWindows: 4 });

    expect(worker.executeOne).toHaveBeenCalledTimes(3);
    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    expect((await circuit(executionProfileId)).failureFamily).toBe("MALFORMED");
  });
});

describe("neutral outcomes and unknown throws stay outside the classifier", () => {
  maybe()("STALE_CLAIM neither counts nor resets, and writes no breaker row", async () => {
    const { executionProfileId } = await withCampaign("neutral-stale", 10);
    const worker = workerProcess({
      executionProfileId,
      script: ["STALE_CLAIM:FILL_INGEST_STALE_CLAIM",
        "STALE_CLAIM:FILL_INGEST_STALE_CLAIM",
        "STALE_CLAIM:FILL_INGEST_STALE_CLAIM",
        "STALE_CLAIM:FILL_INGEST_STALE_CLAIM",
        "STALE_CLAIM:FILL_INGEST_STALE_CLAIM"],
    });

    const result = await runBatch(worker.driver, { maxWindows: 5 });

    expect(result.outcome).toBe("MAX_WINDOWS_REACHED");
    expect(worker.executeOne).toHaveBeenCalledTimes(5);
    // Local contention says nothing about the exchange, so it may not even
    // bring a breaker row into existence.
    expect(
      await prisma!.historicalFillCircuitBreaker.findUnique({ where: { executionProfileId } })
    ).toBeNull();
  });

  maybe()("a ledger-race retry and an unsupported symbol are both neutral", async () => {
    const { executionProfileId } = await withCampaign("neutral-reasons", 10);
    const worker = workerProcess({
      executionProfileId,
      script: [
        "RETRY_SCHEDULED:FILL_LEDGER_INSERT_RACE",
        "ABANDONED:UNSUPPORTED_SYMBOL",
        "RETRY_SCHEDULED:FILL_LEDGER_RACE_UNRESOLVED",
        "ABANDONED:UNSUPPORTED_SYMBOL",
        "ABANDONED:UNSUPPORTED_SYMBOL",
      ],
    });

    const result = await runBatch(worker.driver, { maxWindows: 5 });

    expect(result.outcome).toBe("MAX_WINDOWS_REACHED");
    expect(worker.executeOne).toHaveBeenCalledTimes(5);
    expect(
      await prisma!.historicalFillCircuitBreaker.findUnique({ where: { executionProfileId } })
    ).toBeNull();
  });

  maybe()("a neutral outcome does not clear a streak a real fault is building", async () => {
    const { executionProfileId } = await withCampaign("neutral-no-reset", 10);
    const worker = workerProcess({
      executionProfileId,
      script: [
        "RETRY_SCHEDULED:NETWORK",
        "STALE_CLAIM:FILL_INGEST_STALE_CLAIM",
        "RETRY_SCHEDULED:TIMEOUT",
        "ABANDONED:UNSUPPORTED_SYMBOL",
        "RETRY_SCHEDULED:SERVER",
      ],
    });

    const result = await runBatch(worker.driver, { maxWindows: 5 });

    // The neutrals passed through without resetting, so the third transport
    // failure still trips -- on the fifth dispatch.
    expect(worker.executeOne).toHaveBeenCalledTimes(5);
    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    const state = await circuit(executionProfileId);
    expect(state.state).toBe("OPEN");
    expect(state.consecutiveCount).toBe(3);
  });

  maybe()("NO_WORK is neutral, still refunds, and still completes the campaign", async () => {
    // The proven zero-dispatch path: refund BEFORE completion, observation in
    // between, and nothing about the circuit disturbed.
    const { executionProfileId, campaignId } = await withCampaign("neutral-no-work", 10);
    const result = await runBatch(
      workerProcess({ executionProfileId, script: ["NO_WORK"] }).driver
    );

    expect(result.outcome).toBe("NO_WORK");
    expect(result.executionInvocations).toBe(1);
    // Refunded: the slot came back and no weight was kept.
    expect(result.userTradesWeightUsed).toBe(0);
    const campaign = await campaignRow(campaignId);
    expect(campaign.dispatchesUsed).toBe(0);
    // The queue was empty, so the campaign was declared finished.
    expect(campaign.status).toBe("COMPLETED");
    expect(
      await prisma!.historicalFillCircuitBreaker.findUnique({ where: { executionProfileId } })
    ).toBeNull();
  });

  maybe()("an executor THROW records nothing and propagates", async () => {
    // Uncertain dispatch stays uncertain: no invented reason code, no
    // observation, no refund, and the batch fails rather than continuing.
    const { executionProfileId, campaignId } = await withCampaign("unknown-throw", 10);
    const client = independentClient();
    const executeOne = vi.fn(async () => {
      throw new Error("executor exploded");
    });
    const driver = new HistoricalFillBatchDriver({
      bootstrap: {
        bootstrapHistoricalRoots: vi.fn(async () => ({
          outcome: "BOOTSTRAPPED" as const,
          executionProfileId,
          horizonDays: 30,
          symbolCount: 1,
          dayCount: 30,
          expectedRootCount: 30,
          alreadyCompatibleCount: 30,
          createdCount: 0,
          raceReconciledCount: 0,
        })),
      } as never,
      executor: { executeOne } as never,
      weightBudget: new HistoricalFillWeightBudgetService(client),
      campaigns: new HistoricalFillCampaignGate({
        prisma: client,
        bindProfile: async () => ({ ok: true, context: { executionProfileId } }) as never,
      }),
      circuitBreaker: new HistoricalFillCircuitBreakerService(client),
    });

    await expect(runBatch(driver)).rejects.toThrow("executor exploded");

    // No breaker row: nothing was classified from an outcome that never existed.
    expect(
      await prisma!.historicalFillCircuitBreaker.findUnique({ where: { executionProfileId } })
    ).toBeNull();
    // The slot and its weight stay spent -- the conservative direction.
    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(1);
    expect(executeOne).toHaveBeenCalledTimes(1);
  });

  maybe()("a campaign-governed driver cannot be built without an observer", async () => {
    const client = independentClient();
    const driver = new HistoricalFillBatchDriver({
      bootstrap: { bootstrapHistoricalRoots: vi.fn() } as never,
      executor: { executeOne: vi.fn() } as never,
      weightBudget: new HistoricalFillWeightBudgetService(client),
      campaigns: new HistoricalFillCampaignGate({ prisma: client }),
    });

    await expect(runBatch(driver)).rejects.toBeInstanceOf(FillBatchRefusedError);
  });
});

describe("many workers failing at once still trip the latch exactly once", () => {
  maybe()("W concurrent hard faults produce one transition and no later admission", async () => {
    const WORKERS = 4;
    const { executionProfileId, campaignId } = await withCampaign("multiworker", 20);

    const workers = Array.from({ length: WORKERS }, () =>
      workerProcess({ executionProfileId, script: ["RETRY_SCHEDULED:AUTH", "COMPLETE"] })
    );

    const results = await Promise.all(workers.map((w) => runBatch(w.driver, { maxWindows: 2 })));

    // The established bound: up to W requests may already be in flight, so at
    // most W systemic dispatches happen. Never more.
    const dispatched = results.reduce((total, r) => total + r.executionInvocations, 0);
    expect(dispatched).toBeGreaterThanOrEqual(1);
    expect(dispatched).toBeLessThanOrEqual(WORKERS);

    // Exactly ONE transition, whoever won it.
    const transitions = results.filter(
      (r) => r.outcome === "SYSTEMIC_CIRCUIT_OPEN" && r.circuitOpened !== null
    );
    expect(transitions).toHaveLength(1);

    const state = await circuit(executionProfileId);
    expect(state.state).toBe("OPEN");
    // One increment, not W.
    expect(state.generation).toBe(1);
    expect(await activeCount(executionProfileId)).toBe(0);

    // And nothing may be admitted afterwards, by anyone.
    const after = workerProcess({ executionProfileId, script: ["COMPLETE"] });
    const afterResult = await runBatch(after.driver);
    expect(afterResult.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    expect(after.executeOne).not.toHaveBeenCalled();
    const spent = (await campaignRow(campaignId)).dispatchesUsed;
    expect(spent).toBe(dispatched);
  });

  maybe()("a circuit opened mid-flight is seen as ALREADY_OPEN, and stops the pass", async () => {
    // The in-flight race: this worker's admission succeeded BEFORE the trip, so
    // its request is legitimately outstanding. Its own observation then finds a
    // latch somebody else closed.
    const { executionProfileId, campaignId } = await withCampaign("in-flight", 10);

    let released: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    // A HANDSHAKE, not a sleep. `executeOne` is only ever reached AFTER the
    // admission has committed, so its entry is proof the reservation exists --
    // which is exactly the precondition this race needs. Timing this with a
    // delay instead made the test lose under load: the trip could land before
    // the admission, turning it into the stale-gate case a different test
    // already covers.
    let entered: (() => void) | null = null;
    const dispatching = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const client = independentClient();
    const executeOne = vi.fn(async () => {
      entered!();
      // Hold the "request" open while another worker trips the breaker.
      await gate;
      return { outcome: "COMPLETE" as FillIngestExecutionOutcome };
    });
    const driver = new HistoricalFillBatchDriver({
      bootstrap: {
        bootstrapHistoricalRoots: vi.fn(async () => ({
          outcome: "BOOTSTRAPPED" as const,
          executionProfileId,
          horizonDays: 30,
          symbolCount: 1,
          dayCount: 30,
          expectedRootCount: 30,
          alreadyCompatibleCount: 30,
          createdCount: 0,
          raceReconciledCount: 0,
        })),
      } as never,
      executor: { executeOne } as never,
      weightBudget: new HistoricalFillWeightBudgetService(client),
      campaigns: new HistoricalFillCampaignGate({
        prisma: client,
        bindProfile: async () => ({ ok: true, context: { executionProfileId } }) as never,
      }),
      circuitBreaker: new HistoricalFillCircuitBreakerService(client),
    });

    const inFlight = runBatch(driver, { maxWindows: 3 });
    // The admission has committed by the time the executor is entered.
    await dispatching;
    const opened = await breaker.observeDispatchOutcome({
      executionProfileId,
      campaignId,
      outcome: "RETRY_SCHEDULED",
      reasonCode: "AUTH",
    });
    expect(opened.result).toBe("CIRCUIT_OPENED");
    released!();

    const result = await inFlight;

    // The in-flight request finished and is counted; the pass then stopped.
    expect(executeOne).toHaveBeenCalledTimes(1);
    expect(result.executionInvocations).toBe(1);
    expect(result.outcomes.COMPLETE).toBe(1);
    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    // It did NOT open the circuit, so it must not claim the transition.
    if (result.outcome !== "SYSTEMIC_CIRCUIT_OPEN") throw new Error("unreachable");
    expect(result.circuitOpened).toBeNull();
    // A healthy COMPLETE arriving while OPEN may not release the latch.
    const state = await circuit(executionProfileId);
    expect(state.state).toBe("OPEN");
    expect(state.generation).toBe(1);
  });

  maybe()("a stale gate is still caught by the admission, with zero invocations", async () => {
    // The OTHER race, retained from 3B.2: the trip lands between this worker's
    // gate read and its admission, so nothing is dispatched at all.
    const { executionProfileId, campaignId } = await withCampaign("stale-gate", 10);
    const worker = workerProcess({ executionProfileId, script: ["COMPLETE"] });

    await breaker.observeDispatchOutcome({
      executionProfileId,
      campaignId,
      outcome: "RETRY_SCHEDULED",
      reasonCode: "AUTH",
    });

    const result = await runBatch(worker.driver);
    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    expect(result.executionInvocations).toBe(0);
    expect(worker.executeOne).not.toHaveBeenCalled();
  });
});

describe("activation does not regress the durable refund fence", () => {
  maybe()("a refund landing after acknowledgement still refuses to reopen", async () => {
    // The 3B.3B guarantee, re-proven through the RUNTIME path rather than by
    // calling the budget service directly: a driver hook must not become a way
    // around the epoch comparison.
    const { executionProfileId, campaignId } = await withCampaign("fence-regression", 1);
    const budget = new HistoricalFillWeightBudgetService(prisma!);

    // Final slot admitted at epoch 0, reservation still outstanding.
    const admission = await budget.admitCampaignDispatch({
      executionProfileId,
      weightCap: AMPLE_CAP,
    });
    if (admission.outcome !== "ADMITTED") throw new Error("unreachable");
    expect((await campaignRow(campaignId)).status).toBe("EXHAUSTED");

    // A driver pass now trips the breaker for the same profile.
    const worker = workerProcess({ executionProfileId, script: ["RETRY_SCHEDULED:AUTH"] });
    const result = await runBatch(worker.driver);
    // The campaign is EXHAUSTED, so the gate refuses before the bootstrap and
    // the trip is raised by the reservation this test still holds.
    expect(result.outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
    const opened = await breaker.observeDispatchOutcome({
      executionProfileId,
      campaignId,
      outcome: "RETRY_SCHEDULED",
      reasonCode: "AUTH",
    });
    expect(opened.result).toBe("CIRCUIT_OPENED");
    expect((await circuit(executionProfileId)).generation).toBe(1);

    await breaker.acknowledge({ executionProfileId });
    expect((await circuit(executionProfileId)).generation).toBe(1);

    await budget.releaseCertainNonDispatch(admission.reservation);

    // Accounting refunded in full...
    const campaign = await campaignRow(campaignId);
    expect(campaign.dispatchesUsed).toBe(0);
    // ...and nothing became runnable: epoch 0 !== epoch 1.
    expect(campaign.status).toBe("EXHAUSTED");
    expect(await activeCount(executionProfileId)).toBe(0);
  });

  maybe()("a reservation admitted through the driver carries the current epoch", async () => {
    const { executionProfileId, campaignId } = await withCampaign("driver-epoch", 10);
    // One episode, acknowledged: the profile is at epoch 1.
    await breaker.observeDispatchOutcome({
      executionProfileId,
      campaignId,
      outcome: "RETRY_SCHEDULED",
      reasonCode: "AUTH",
    });
    await breaker.acknowledge({ executionProfileId });
    await campaigns.resumeCampaign(campaignId);
    expect((await circuit(executionProfileId)).generation).toBe(1);

    await runBatch(workerProcess({ executionProfileId, script: ["COMPLETE"] }).driver, {
      maxWindows: 1,
    });

    const reservations = await prisma!.historicalFillWeightReservation.findMany({
      where: { campaignId },
      select: { circuitGeneration: true },
    });
    expect(reservations).toHaveLength(1);
    // Tagged with the epoch that was running when it was admitted, not zero.
    expect(reservations[0].circuitGeneration).toBe(1);
  });
});

describe("a breaker that cannot be consulted stops the batch", () => {
  maybe()("propagates the failure instead of continuing to the next window", async () => {
    // FAIL CLOSED. If the observation itself fails, the process does not KNOW
    // whether systemic protection was recorded -- and the only safe reading of
    // "I don't know" is to stop. Continuing would admit again against a fault
    // that may have just tripped the latch.
    const { executionProfileId, campaignId } = await withCampaign("observe-fails", 10);
    const client = independentClient();
    const executeOne = vi.fn(async () => ({ outcome: "COMPLETE" as FillIngestExecutionOutcome }));

    const driver = new HistoricalFillBatchDriver({
      bootstrap: {
        bootstrapHistoricalRoots: vi.fn(async () => ({
          outcome: "BOOTSTRAPPED" as const,
          executionProfileId,
          horizonDays: 30,
          symbolCount: 1,
          dayCount: 30,
          expectedRootCount: 30,
          alreadyCompatibleCount: 30,
          createdCount: 0,
          raceReconciledCount: 0,
        })),
      } as never,
      executor: { executeOne } as never,
      weightBudget: new HistoricalFillWeightBudgetService(client),
      campaigns: new HistoricalFillCampaignGate({
        prisma: client,
        bindProfile: async () => ({ ok: true, context: { executionProfileId } }) as never,
      }),
      circuitBreaker: {
        observeDispatchOutcome: async () => {
          throw new Error("breaker unavailable");
        },
      },
    });

    await expect(runBatch(driver, { maxWindows: 5 })).rejects.toThrow("breaker unavailable");

    // ONE window, then the batch died. It did not quietly carry on.
    expect(executeOne).toHaveBeenCalledTimes(1);
    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(1);
  });
});

/**
 * BOTH REAL EXECUTOR STATES for the same systemic fault.
 *
 * A retryable Binance kind does not produce one outcome, it produces two: the
 * window keeps its attempt budget and reports RETRY_SCHEDULED until that budget
 * is spent, and reports ABANDONED on the attempt that spends it. Those are the
 * only two shapes an AUTH failure can ever reach the driver as, and the breaker
 * must behave identically for both -- its judgement is about AUTH, not about
 * whether this particular window has now run out of tries.
 *
 * Proving only one of them would leave the other unexercised, which is exactly
 * how a real activation path goes untested.
 */
describe("a systemic fault trips the latch in either window state", () => {
  maybe()("an attempt-EXHAUSTED AUTH failure opens the circuit too", async () => {
    // What the executor returns once `attempts` has reached MAX_INGEST_ATTEMPTS:
    // the window is terminal, but the account-level fault is unchanged.
    const { executionProfileId, campaignId } = await withCampaign("exhausted-auth", 10);
    const worker = workerProcess({
      executionProfileId,
      script: ["ABANDONED:AUTH", "COMPLETE", "COMPLETE"],
    });

    const result = await runBatch(worker.driver);

    expect(worker.executeOne).toHaveBeenCalledTimes(1);
    expect(result.executionInvocations).toBe(1);
    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    // Counted under its own outcome, which is the terminal one here.
    expect(result.outcomes.ABANDONED).toBe(1);
    expect(result.outcomes.RETRY_SCHEDULED).toBe(0);

    const state = await circuit(executionProfileId);
    expect(state.state).toBe("OPEN");
    expect(state.failureFamily).toBe("HARD_CONFIGURATION");
    expect(state.lastReasonCode).toBe("AUTH");
    expect(state.generation).toBe(1);
    expect((await campaignRow(campaignId)).status).toBe("PAUSED");
  });

  maybe()("a transient family trips the same way once its window is exhausted", async () => {
    const { executionProfileId } = await withCampaign("exhausted-transient", 10);
    const worker = workerProcess({
      executionProfileId,
      // Two scheduled retries, then the attempt that spends the window's budget.
      script: ["RETRY_SCHEDULED:NETWORK", "RETRY_SCHEDULED:TIMEOUT", "ABANDONED:SERVER", "COMPLETE"],
    });

    const result = await runBatch(worker.driver, { maxWindows: 4 });

    expect(worker.executeOne).toHaveBeenCalledTimes(3);
    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    expect(result.outcomes.RETRY_SCHEDULED).toBe(2);
    expect(result.outcomes.ABANDONED).toBe(1);
    const state = await circuit(executionProfileId);
    expect(state.failureFamily).toBe("TRANSIENT_TRANSPORT");
    expect(state.consecutiveCount).toBe(3);
  });

  maybe()("a MALFORMED_RESPONSE trips from its retryable shape as well", async () => {
    const { executionProfileId } = await withCampaign("malformed-retryable", 10);
    const worker = workerProcess({
      executionProfileId,
      script: [
        "RETRY_SCHEDULED:MALFORMED_RESPONSE",
        "RETRY_SCHEDULED:MALFORMED_RESPONSE",
        "RETRY_SCHEDULED:MALFORMED_RESPONSE",
        "COMPLETE",
      ],
    });

    const result = await runBatch(worker.driver, { maxWindows: 4 });

    expect(worker.executeOne).toHaveBeenCalledTimes(3);
    expect(result.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    expect(result.outcomes.RETRY_SCHEDULED).toBe(3);
    expect((await circuit(executionProfileId)).failureFamily).toBe("MALFORMED");
  });
});
