import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, resolveTestDatabase } from "./helpers/test-database";
import {
  HistoricalFillCircuitBreakerService,
  readCircuitState,
} from "../src/modules/execution/historical-fill-circuit-breaker.service";
import {
  HistoricalFillCampaignService,
  HistoricalFillCircuitOpenError,
  HistoricalFillCampaignStateError,
} from "../src/modules/execution/historical-fill-campaign.service";
import {
  HistoricalFillWeightBudgetService,
  HISTORICAL_FILL_RESERVATION_WEIGHT,
  type HistoricalFillWeightReservation,
} from "../src/modules/execution/historical-fill-weight-budget.service";

/**
 * The latch ENFORCED, against a REAL Postgres.
 *
 * 3B.1 proved the breaker records the right thing. This file proves the rest of
 * the subsystem obeys it: that an OPEN circuit costs a denied admission exactly
 * nothing, that it cannot be argued past by creating or resuming a campaign,
 * that it never blocks the operator's safety actions, and that the one
 * invariant everything rests on -- OPEN commits => zero ACTIVE campaigns --
 * survives every race that can reach it.
 *
 * Contention runs through INDEPENDENT PrismaClients, because the races worth
 * proving are between WORKERS and a single in-process client would serialize
 * them into something that cannot fail.
 *
 * No Binance client is constructed here or in the code under test, and nothing
 * in this file performs network I/O.
 */

const TAG = "fill-circuit-enforcement-synthetic";

/** Ample minute weight, so the CIRCUIT is what these tests measure. */
const AMPLE_CAP = 500;

/** One observation of this pair opens the latch: HARD_CONFIGURATION, threshold 1. */
const SYSTEMIC = { outcome: "ABANDONED", reasonCode: "AUTH" } as const;

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const maybe = () => (available ? it : it.skip);

const clients: PrismaClient[] = [];
function independentClient(): PrismaClient {
  const client = new PrismaClient({ datasources: { db: { url: resolveTestDatabase().url } } });
  clients.push(client);
  return client;
}

let breaker: HistoricalFillCircuitBreakerService;
let campaigns: HistoricalFillCampaignService;
let budget: HistoricalFillWeightBudgetService;

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

/** A profile with one ACTIVE campaign: the ordinary starting point. */
async function withCampaign(suffix: string, maxDispatches = 10) {
  const executionProfileId = await makeProfile(suffix);
  const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches });
  return { executionProfileId, campaignId: campaign.id };
}

/** Opens the latch the way the runtime will: one systemic observation. */
async function openCircuit(executionProfileId: string, campaignId: string) {
  const observation = await breaker.observeDispatchOutcome({
    executionProfileId,
    campaignId,
    ...SYSTEMIC,
  });
  expect(observation.result).toBe("CIRCUIT_OPENED");
  return observation;
}

function admit(executionProfileId: string, weightCap = AMPLE_CAP) {
  return budget.admitCampaignDispatch({ executionProfileId, weightCap });
}

async function campaignRow(campaignId: string) {
  return prisma!.historicalFillCampaign.findUniqueOrThrow({ where: { id: campaignId } });
}

async function reservationCount(campaignId: string): Promise<number> {
  return prisma!.historicalFillWeightReservation.count({ where: { campaignId } });
}

/** Total unreleased weight standing against a profile's buckets right now. */
async function weightUsed(executionProfileId: string): Promise<number> {
  const buckets = await prisma!.historicalFillWeightBucket.findMany({
    where: { executionProfileId },
    select: { weightUsed: true },
  });
  return buckets.reduce((total, bucket) => total + bucket.weightUsed, 0);
}

/** The breaker epoch a reservation was granted in. */
async function reservationGeneration(reservationId: string): Promise<number> {
  const row = await prisma!.historicalFillWeightReservation.findUniqueOrThrow({
    where: { id: reservationId },
    select: { circuitGeneration: true },
  });
  return row.circuitGeneration;
}

async function activeCount(executionProfileId: string): Promise<number> {
  return prisma!.historicalFillCampaign.count({
    where: { executionProfileId, status: "ACTIVE" },
  });
}

beforeAll(() => {
  if (!prisma) return;
  breaker = new HistoricalFillCircuitBreakerService(prisma);
  campaigns = new HistoricalFillCampaignService(prisma);
  budget = new HistoricalFillWeightBudgetService(prisma);
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});

describe("a CLOSED or absent latch changes nothing about admission", () => {
  maybe()("admits when the profile has never had a breaker row", async () => {
    const { executionProfileId } = await withCampaign("absent-row");
    // The precondition IS the test: no row at all must be a complete answer.
    expect(
      await prisma!.historicalFillCircuitBreaker.findUnique({ where: { executionProfileId } })
    ).toBeNull();

    const admission = await admit(executionProfileId);
    expect(admission.outcome).toBe("ADMITTED");
  });

  maybe()("admits when a breaker row exists in state CLOSED", async () => {
    const { executionProfileId, campaignId } = await withCampaign("closed-row");
    // A streak that never reached its threshold: row present, latch CLOSED.
    await breaker.observeDispatchOutcome({
      executionProfileId,
      campaignId,
      outcome: "ABANDONED",
      reasonCode: "SERVER",
    });
    const row = await prisma!.historicalFillCircuitBreaker.findUniqueOrThrow({
      where: { executionProfileId },
    });
    expect(row.state).toBe("CLOSED");
    expect(row.consecutiveCount).toBe(1);

    const admission = await admit(executionProfileId);
    expect(admission.outcome).toBe("ADMITTED");
  });

  maybe()("a healthy admission writes NO breaker row", async () => {
    // The healthy path must stay free. A write here would put a row on every
    // profile that ever dispatched, purely so the latch could be read.
    const { executionProfileId } = await withCampaign("healthy-no-write");
    await admit(executionProfileId);
    expect(
      await prisma!.historicalFillCircuitBreaker.findUnique({ where: { executionProfileId } })
    ).toBeNull();
  });
});

describe("an OPEN latch refuses admission and costs nothing", () => {
  maybe()("returns SYSTEMIC_CIRCUIT_OPEN carrying the locked snapshot", async () => {
    const { executionProfileId, campaignId } = await withCampaign("open-denial");
    const opened = await openCircuit(executionProfileId, campaignId);

    const admission = await admit(executionProfileId);
    expect(admission.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    if (admission.outcome !== "SYSTEMIC_CIRCUIT_OPEN") throw new Error("unreachable");
    expect(admission.circuit.state).toBe("OPEN");
    expect(admission.circuit.failureFamily).toBe("HARD_CONFIGURATION");
    expect(admission.circuit.lastReasonCode).toBe("AUTH");
    expect(admission.circuit.consecutiveCount).toBe(1);
    expect(admission.circuit.openedAt).toEqual(opened.circuit.openedAt);
  });

  maybe()("the denial carries no message, body or account identifier", async () => {
    const { executionProfileId, campaignId } = await withCampaign("open-denial-shape");
    await openCircuit(executionProfileId, campaignId);

    const admission = await admit(executionProfileId);
    if (admission.outcome !== "SYSTEMIC_CIRCUIT_OPEN") throw new Error("unreachable");
    // Exactly the five agreed fields, and nothing that could carry a secret.
    expect(Object.keys(admission.circuit).sort()).toEqual([
      "consecutiveCount",
      "failureFamily",
      "lastReasonCode",
      "openedAt",
      "state",
    ]);
    expect(JSON.stringify(admission.circuit)).not.toContain(executionProfileId);
  });

  maybe()("spends no slot, no weight, no reservation and no timestamp", async () => {
    const { executionProfileId, campaignId } = await withCampaign("open-costs-nothing");
    // The campaign is PAUSED by the trip, so force it back to ACTIVE: this test
    // is about what the DENIAL costs, which needs a campaign that could have
    // been spent from.
    await openCircuit(executionProfileId, campaignId);
    await prisma!.$executeRawUnsafe(
      `UPDATE "HistoricalFillCampaign" SET "status" = 'ACTIVE' WHERE "id" = $1`,
      campaignId
    );
    const before = await campaignRow(campaignId);
    expect(before.status).toBe("ACTIVE");

    const admission = await admit(executionProfileId);
    expect(admission.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");

    const after = await campaignRow(campaignId);
    expect(after.dispatchesUsed).toBe(before.dispatchesUsed);
    expect(after.lastAdmissionAt).toBeNull();
    expect(after.status).toBe("ACTIVE");
    expect(await reservationCount(campaignId)).toBe(0);
    expect(await weightUsed(executionProfileId)).toBe(0);
  });

  maybe()("refuses every subsequent admission once OPEN has committed", async () => {
    // The W-1 semantics from the design proof: already-admitted work may
    // finish, but nothing NEW is ever admitted again.
    const { executionProfileId, campaignId } = await withCampaign("open-latched");
    await openCircuit(executionProfileId, campaignId);
    await prisma!.$executeRawUnsafe(
      `UPDATE "HistoricalFillCampaign" SET "status" = 'ACTIVE' WHERE "id" = $1`,
      campaignId
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await admit(executionProfileId)).outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    }
    expect((await campaignRow(campaignId)).dispatchesUsed).toBe(0);
  });
});

describe("lastAdmissionAt records exactly the admissions that happened", () => {
  maybe()("is null before any admission, and set by the first", async () => {
    const { executionProfileId, campaignId } = await withCampaign("last-admission-first");
    expect((await campaignRow(campaignId)).lastAdmissionAt).toBeNull();

    const before = Date.now();
    const admission = await admit(executionProfileId);
    expect(admission.outcome).toBe("ADMITTED");
    const after = Date.now();

    const stamped = (await campaignRow(campaignId)).lastAdmissionAt;
    expect(stamped).not.toBeNull();
    // Bracketed by the call, so a hard-coded or defaulted value cannot pass.
    expect(stamped!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped!.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  maybe()("advances on every later admission", async () => {
    const { executionProfileId, campaignId } = await withCampaign("last-admission-advances");
    await admit(executionProfileId);
    const first = (await campaignRow(campaignId)).lastAdmissionAt!;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await admit(executionProfileId);
    const second = (await campaignRow(campaignId)).lastAdmissionAt!;

    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  maybe()("names the same instant the final slot ended the campaign", async () => {
    // One resolved `now` for the whole admission, so a final-slot campaign does
    // not carry two timestamps microseconds apart for one event.
    const { executionProfileId, campaignId } = await withCampaign("last-admission-final", 1);
    const admission = await admit(executionProfileId);
    expect(admission.outcome).toBe("ADMITTED");

    const row = await campaignRow(campaignId);
    expect(row.status).toBe("EXHAUSTED");
    expect(row.endedAt).toEqual(row.lastAdmissionAt);
  });

  maybe()("is unchanged by a SYSTEMIC_CIRCUIT_OPEN denial", async () => {
    const { executionProfileId, campaignId } = await withCampaign("last-admission-circuit");
    await admit(executionProfileId);
    const stamped = (await campaignRow(campaignId)).lastAdmissionAt!;

    await openCircuit(executionProfileId, campaignId);
    await prisma!.$executeRawUnsafe(
      `UPDATE "HistoricalFillCampaign" SET "status" = 'ACTIVE' WHERE "id" = $1`,
      campaignId
    );
    expect((await admit(executionProfileId)).outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");

    expect((await campaignRow(campaignId)).lastAdmissionAt).toEqual(stamped);
  });

  maybe()("is rolled back with everything else on a GLOBAL weight denial", async () => {
    // The denial lands AFTER the increment, so this is the one that proves the
    // timestamp travels with the rollback rather than being written early.
    const { executionProfileId, campaignId } = await withCampaign("last-admission-global");
    // ONE dispatch's worth of minute ceiling, used consistently: the bucket
    // stores the cap it was opened with, so admitting under a different one
    // would be refused as a CAP_MISMATCH before the ceiling was ever reached.
    const tightCap = HISTORICAL_FILL_RESERVATION_WEIGHT;
    await admit(executionProfileId, tightCap);
    const stamped = (await campaignRow(campaignId)).lastAdmissionAt!;
    const usedBefore = await weightUsed(executionProfileId);
    expect(usedBefore).toBe(tightCap);

    await new Promise((resolve) => setTimeout(resolve, 5));
    // The minute is now full, so this is denied AFTER the campaign increment --
    // which is exactly what makes it a rollback test.
    const denial = await admit(executionProfileId, tightCap);
    expect(denial.outcome).toBe("GLOBAL_USER_TRADES_WEIGHT_EXHAUSTED");

    const row = await campaignRow(campaignId);
    expect(row.lastAdmissionAt).toEqual(stamped);
    expect(row.dispatchesUsed).toBe(1);
    expect(await weightUsed(executionProfileId)).toBe(usedBefore);
  });

  maybe()("is unchanged by a campaign budget denial", async () => {
    const { executionProfileId, campaignId } = await withCampaign("last-admission-budget", 1);
    await admit(executionProfileId);
    const stamped = (await campaignRow(campaignId)).lastAdmissionAt!;
    // The final slot EXHAUSTED it; force ACTIVE so the budget check is what
    // refuses rather than the absence of an ACTIVE campaign.
    await prisma!.$executeRawUnsafe(
      `UPDATE "HistoricalFillCampaign" SET "status" = 'ACTIVE' WHERE "id" = $1`,
      campaignId
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await admit(executionProfileId)).outcome).toBe("CAMPAIGN_DISPATCH_BUDGET_EXHAUSTED");
    expect((await campaignRow(campaignId)).lastAdmissionAt).toEqual(stamped);
  });

  maybe()("is unchanged when there is no ACTIVE campaign to admit against", async () => {
    const { executionProfileId, campaignId } = await withCampaign("last-admission-none");
    await admit(executionProfileId);
    const stamped = (await campaignRow(campaignId)).lastAdmissionAt!;
    await campaigns.pauseCampaign(campaignId);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await admit(executionProfileId)).outcome).toBe("NO_ACTIVE_FILL_CAMPAIGN");
    expect((await campaignRow(campaignId)).lastAdmissionAt).toEqual(stamped);
  });

  maybe()("is neither cleared nor rewound by a refund", async () => {
    const { executionProfileId, campaignId } = await withCampaign("last-admission-refund");
    const admission = await admit(executionProfileId);
    if (admission.outcome !== "ADMITTED") throw new Error("unreachable");
    const stamped = (await campaignRow(campaignId)).lastAdmissionAt!;

    await budget.releaseCertainNonDispatch(admission.reservation);

    const row = await campaignRow(campaignId);
    expect(row.dispatchesUsed).toBe(0);
    // The slot came back; the FACT that an admission happened did not.
    expect(row.lastAdmissionAt).toEqual(stamped);
  });

  maybe()("is untouched by pause, resume and abort", async () => {
    const { executionProfileId, campaignId } = await withCampaign("last-admission-lifecycle");
    await admit(executionProfileId);
    const stamped = (await campaignRow(campaignId)).lastAdmissionAt!;

    await campaigns.pauseCampaign(campaignId);
    expect((await campaignRow(campaignId)).lastAdmissionAt).toEqual(stamped);
    await campaigns.resumeCampaign(campaignId);
    expect((await campaignRow(campaignId)).lastAdmissionAt).toEqual(stamped);
    await campaigns.abortCampaign(campaignId);
    expect((await campaignRow(campaignId)).lastAdmissionAt).toEqual(stamped);
  });
});

describe("the lifecycle obeys the latch without being trapped by it", () => {
  maybe()("createCampaign refuses while OPEN, and writes no campaign", async () => {
    const { executionProfileId, campaignId } = await withCampaign("create-refused");
    const opened = await openCircuit(executionProfileId, campaignId);
    await campaigns.abortCampaign(campaignId);
    const before = await prisma!.historicalFillCampaign.count({ where: { executionProfileId } });

    const error = await campaigns
      .createCampaign({ executionProfileId, maxDispatches: 5 })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HistoricalFillCircuitOpenError);
    const refusal = error as HistoricalFillCircuitOpenError;
    expect(refusal.reasonCode).toBe("FILL_CAMPAIGN_CIRCUIT_OPEN");
    expect(refusal.failureFamily).toBe("HARD_CONFIGURATION");
    expect(refusal.lastReasonCode).toBe("AUTH");
    expect(refusal.openedAt).toEqual(opened.circuit.openedAt);
    expect(await prisma!.historicalFillCampaign.count({ where: { executionProfileId } })).toBe(
      before
    );
  });

  maybe()("the refusal carries no credential-shaped text", async () => {
    const { executionProfileId, campaignId } = await withCampaign("create-refused-shape");
    await openCircuit(executionProfileId, campaignId);

    const error = (await campaigns
      .createCampaign({ executionProfileId, maxDispatches: 5 })
      .then(() => null)
      .catch((thrown: unknown) => thrown)) as HistoricalFillCircuitOpenError;

    for (const forbidden of ["apiKey", "secret", "Bearer", "postgresql://", "signature"]) {
      expect(error.message).not.toContain(forbidden);
    }
  });

  maybe()("resumeCampaign refuses while OPEN, and the campaign stays PAUSED", async () => {
    const { executionProfileId, campaignId } = await withCampaign("resume-refused");
    // The trip pauses the ACTIVE campaign itself, which is exactly the state an
    // operator would try to resume out of.
    const opened = await openCircuit(executionProfileId, campaignId);
    expect(opened.pausedCampaignId).toBe(campaignId);
    expect((await campaignRow(campaignId)).status).toBe("PAUSED");

    await expect(campaigns.resumeCampaign(campaignId)).rejects.toBeInstanceOf(
      HistoricalFillCircuitOpenError
    );

    expect((await campaignRow(campaignId)).status).toBe("PAUSED");
    // The refusal must not have touched the latch in either direction.
    const circuit = await breaker.readState({ executionProfileId });
    expect(circuit.state).toBe("OPEN");
    expect(circuit.openedAt).toEqual(opened.circuit.openedAt);
  });

  maybe()("a MANUAL pause plus an OPEN latch also stays PAUSED", async () => {
    const { executionProfileId, campaignId } = await withCampaign("manual-pause-open");
    await campaigns.pauseCampaign(campaignId);
    // Nothing ACTIVE to pause, so the trip pauses nothing -- and the invariant
    // still holds because there was already zero ACTIVE.
    const opened = await openCircuit(executionProfileId, campaignId);
    expect(opened.pausedCampaignId).toBeNull();

    await expect(campaigns.resumeCampaign(campaignId)).rejects.toBeInstanceOf(
      HistoricalFillCircuitOpenError
    );
    expect((await campaignRow(campaignId)).status).toBe("PAUSED");
  });

  maybe()("abortCampaign is ALLOWED while OPEN, and leaves the latch alone", async () => {
    // The safety action must never be trapped by the circuit: an operator has
    // to be able to end a campaign during exactly the incident that stopped it.
    const { executionProfileId, campaignId } = await withCampaign("abort-allowed");
    const opened = await openCircuit(executionProfileId, campaignId);

    const aborted = await campaigns.abortCampaign(campaignId, "stopped during incident");
    expect(aborted.status).toBe("ABORTED");

    const circuit = await breaker.readState({ executionProfileId });
    expect(circuit.state).toBe("OPEN");
    expect(circuit.openedAt).toEqual(opened.circuit.openedAt);
  });

  maybe()("pauseCampaign is unaffected while the latch is CLOSED", async () => {
    const { campaignId } = await withCampaign("pause-closed");
    const paused = await campaigns.pauseCampaign(campaignId);
    expect(paused.status).toBe("PAUSED");
  });

  maybe()("a REPLACEMENT campaign is refused after a final-slot fault", async () => {
    // The scenario the breaker exists for: the last slot's request is what
    // failed, so the campaign is already EXHAUSTED and there is nothing left to
    // pause. The latch alone has to stop the operator opening a fresh campaign
    // straight into the same fault.
    const { executionProfileId, campaignId } = await withCampaign("final-slot-replacement", 1);
    const admission = await admit(executionProfileId);
    if (admission.outcome !== "ADMITTED") throw new Error("unreachable");
    expect((await campaignRow(campaignId)).status).toBe("EXHAUSTED");

    const opened = await openCircuit(executionProfileId, campaignId);
    expect(opened.pausedCampaignId).toBeNull();
    expect(await activeCount(executionProfileId)).toBe(0);

    await expect(
      campaigns.createCampaign({ executionProfileId, maxDispatches: 50 })
    ).rejects.toBeInstanceOf(HistoricalFillCircuitOpenError);
  });

  maybe()("acknowledgement alone starts nothing, but unblocks the operator", async () => {
    const { executionProfileId, campaignId } = await withCampaign("acknowledge-unblocks");
    await openCircuit(executionProfileId, campaignId);

    const acknowledged = await breaker.acknowledge({ executionProfileId });
    expect(acknowledged.result).toBe("ACKNOWLEDGED");
    expect(acknowledged.circuit.state).toBe("CLOSED");
    // THE POINT: clearing the latch exposed no runnable work of its own.
    expect(await activeCount(executionProfileId)).toBe(0);

    // And now the operator's two explicit actions work again.
    const resumed = await campaigns.resumeCampaign(campaignId);
    expect(resumed.status).toBe("ACTIVE");
    expect((await admit(executionProfileId)).outcome).toBe("ADMITTED");
  });

  maybe()("resume still refuses a non-PAUSED campaign once the latch is clear", async () => {
    // The circuit guard must not have swallowed the ordinary state machine.
    const { executionProfileId, campaignId } = await withCampaign("resume-state-intact");
    await openCircuit(executionProfileId, campaignId);
    await campaigns.abortCampaign(campaignId);
    await breaker.acknowledge({ executionProfileId });

    await expect(campaigns.resumeCampaign(campaignId)).rejects.toBeInstanceOf(
      HistoricalFillCampaignStateError
    );
  });
});

/**
 * The races, each run through TWO independent connections.
 *
 * Every one of these asserts the INVARIANT rather than a winner. Which side
 * takes the profile lock first is the operating system's business; what the
 * design promises is that no interleaving can end with a stopped account still
 * holding runnable work.
 */
describe("no race can leave an OPEN latch beside an ACTIVE campaign", () => {
  /** Both contenders on their own connection, so the lock is genuinely contended. */
  function contenders() {
    return {
      campaigns: new HistoricalFillCampaignService(independentClient()),
      breaker: new HistoricalFillCircuitBreakerService(independentClient()),
      budget: new HistoricalFillWeightBudgetService(independentClient()),
    };
  }

  maybe()("createCampaign versus the latch opening", async () => {
    for (let round = 0; round < 4; round += 1) {
      const executionProfileId = await makeProfile(`create-race-${round}`);
      // A dead campaign: it blocks no create, and gives the trip its lineage.
      const seed = await campaigns.createCampaign({ executionProfileId, maxDispatches: 3 });
      await campaigns.abortCampaign(seed.id);
      const rivals = contenders();

      const [created] = await Promise.allSettled([
        rivals.campaigns.createCampaign({ executionProfileId, maxDispatches: 5 }),
        rivals.breaker.observeDispatchOutcome({
          executionProfileId,
          campaignId: seed.id,
          ...SYSTEMIC,
        }),
      ]);

      // Either the create was refused outright, or it succeeded and the trip
      // paused what it made. Both are allowed; a third outcome is not.
      if (created.status === "rejected") {
        expect(created.reason).toBeInstanceOf(HistoricalFillCircuitOpenError);
      }
      expect((await breaker.readState({ executionProfileId })).state).toBe("OPEN");
      expect(await activeCount(executionProfileId)).toBe(0);
    }
  });

  maybe()("resumeCampaign versus the latch opening", async () => {
    for (let round = 0; round < 4; round += 1) {
      const { executionProfileId, campaignId } = await withCampaign(`resume-race-${round}`);
      await campaigns.pauseCampaign(campaignId);
      const rivals = contenders();

      const [resumed] = await Promise.allSettled([
        rivals.campaigns.resumeCampaign(campaignId),
        rivals.breaker.observeDispatchOutcome({
          executionProfileId,
          campaignId,
          ...SYSTEMIC,
        }),
      ]);

      if (resumed.status === "rejected") {
        expect(resumed.reason).toBeInstanceOf(HistoricalFillCircuitOpenError);
      }
      expect((await breaker.readState({ executionProfileId })).state).toBe("OPEN");
      expect(await activeCount(executionProfileId)).toBe(0);
      // Whichever way it went, the campaign ends where the operator left it.
      expect((await campaignRow(campaignId)).status).toBe("PAUSED");
    }
  });

  maybe()("admission versus the latch opening, and nothing after it", async () => {
    let admittedRounds = 0;
    let deniedRounds = 0;

    for (let round = 0; round < 6; round += 1) {
      const { executionProfileId, campaignId } = await withCampaign(`admit-race-${round}`);
      const rivals = contenders();

      const [admission] = await Promise.all([
        rivals.budget.admitCampaignDispatch({ executionProfileId, weightCap: AMPLE_CAP }),
        rivals.breaker.observeDispatchOutcome({
          executionProfileId,
          campaignId,
          ...SYSTEMIC,
        }),
      ]);

      const row = await campaignRow(campaignId);
      if (admission.outcome === "ADMITTED") {
        // Won the lock first. One dispatch is allowed to be in flight; the
        // campaign is paused behind it.
        admittedRounds += 1;
        expect(row.dispatchesUsed).toBe(1);
        expect(await reservationCount(campaignId)).toBe(1);
        expect(await weightUsed(executionProfileId)).toBe(HISTORICAL_FILL_RESERVATION_WEIGHT);
      } else {
        // Lost the lock. The denial must have cost nothing whatsoever.
        deniedRounds += 1;
        expect(admission.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
        expect(row.dispatchesUsed).toBe(0);
        expect(row.lastAdmissionAt).toBeNull();
        expect(await reservationCount(campaignId)).toBe(0);
        expect(await weightUsed(executionProfileId)).toBe(0);
      }

      expect((await breaker.readState({ executionProfileId })).state).toBe("OPEN");
      expect(await activeCount(executionProfileId)).toBe(0);

      // THE LATCH HOLDS AFTERWARDS. Whatever happened during the race, nothing
      // new is admitted once OPEN has committed.
      await prisma!.$executeRawUnsafe(
        `UPDATE "HistoricalFillCampaign" SET "status" = 'ACTIVE' WHERE "id" = $1`,
        campaignId
      );
      const after = await admit(executionProfileId);
      expect(after.outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
    }

    // Both orderings must actually have been reached, or this suite proves
    // only one of the two branches it claims to cover.
    expect(admittedRounds + deniedRounds).toBe(6);
  });
});

describe("a refund corrects the books without reopening a stopped account", () => {
  /** Final slot spent, campaign EXHAUSTED, one reservation still outstanding. */
  async function finalSlotOutstanding(suffix: string) {
    const { executionProfileId, campaignId } = await withCampaign(suffix, 1);
    const admission = await admit(executionProfileId);
    if (admission.outcome !== "ADMITTED") throw new Error("unreachable");
    expect((await campaignRow(campaignId)).status).toBe("EXHAUSTED");
    return {
      executionProfileId,
      campaignId,
      reservation: admission.reservation as HistoricalFillWeightReservation,
    };
  }

  maybe()("refunds fully while OPEN, but leaves the campaign EXHAUSTED", async () => {
    const { executionProfileId, campaignId, reservation } =
      await finalSlotOutstanding("refund-while-open");
    const opened = await openCircuit(executionProfileId, campaignId);
    expect(await weightUsed(executionProfileId)).toBe(HISTORICAL_FILL_RESERVATION_WEIGHT);

    await budget.releaseCertainNonDispatch(reservation);

    // THE ACCOUNTING IS CORRECTED IN FULL -- an outage must not cost a
    // permanent overcount.
    expect(await weightUsed(executionProfileId)).toBe(0);
    const row = await campaignRow(campaignId);
    expect(row.dispatchesUsed).toBe(0);
    const released = await prisma!.historicalFillWeightReservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(released.releasedAt).not.toBeNull();

    // AND THE REOPENING IS WITHHELD. This is the load-bearing half: without it
    // the refund would hand the fault a fresh ACTIVE campaign to burn.
    expect(row.status).toBe("EXHAUSTED");
    expect(await activeCount(executionProfileId)).toBe(0);
    const circuit = await breaker.readState({ executionProfileId });
    expect(circuit.state).toBe("OPEN");
    expect(circuit.openedAt).toEqual(opened.circuit.openedAt);
  });

  maybe()("still refuses admission after that refund", async () => {
    // The slot came back, so without the latch this campaign would be
    // dispatchable again the moment anything reactivated it.
    const { executionProfileId, campaignId, reservation } =
      await finalSlotOutstanding("refund-then-admit");
    await openCircuit(executionProfileId, campaignId);
    await budget.releaseCertainNonDispatch(reservation);

    expect((await admit(executionProfileId)).outcome).toBe("SYSTEMIC_CIRCUIT_OPEN");
  });

  maybe()("reopens as before when the latch is CLOSED", async () => {
    // The 2B.2 rule is untouched where no circuit is involved: a proven
    // zero-dispatch final slot still reopens the campaign it paid for.
    const { executionProfileId, campaignId, reservation } =
      await finalSlotOutstanding("refund-closed-reopens");

    await budget.releaseCertainNonDispatch(reservation);

    expect((await campaignRow(campaignId)).status).toBe("ACTIVE");
    expect(await activeCount(executionProfileId)).toBe(1);
  });

  /**
   * THE RACE THIS SUBSYSTEM'S EPOCH COUNTER EXISTS TO CLOSE.
   *
   * Acknowledgement wipes every other column on the breaker row, leaving one
   * that is field-for-field identical to a row from a streak that recovered on
   * its own. So "is the latch open right now" cannot answer this: at refund time
   * it is closed, and without the epoch the reservation would reopen the campaign
   * its final slot paid for -- handing a stopped account runnable work with no
   * start and no resume behind it.
   *
   * The reservation was granted at epoch 0 and the breaker is now at 1, so the
   * refund pays its accounting back in full and stops there.
   */
  maybe()("a refund landing after acknowledgement refunds but does NOT reopen", async () => {
    const { executionProfileId, campaignId, reservation } =
      await finalSlotOutstanding("refund-after-ack");
    expect(await reservationGeneration(reservation.id)).toBe(0);

    await openCircuit(executionProfileId, campaignId);
    expect((await breaker.readState({ executionProfileId })).generation).toBe(1);

    const acknowledged = await breaker.acknowledge({ executionProfileId });
    expect(acknowledged.result).toBe("ACKNOWLEDGED");
    // The epoch is the ONE thing acknowledgement leaves behind.
    expect(acknowledged.circuit.state).toBe("CLOSED");
    expect(acknowledged.circuit.generation).toBe(1);
    expect(await activeCount(executionProfileId)).toBe(0);

    await budget.releaseCertainNonDispatch(reservation);

    // THE ACCOUNTING IS STILL PAID BACK IN FULL.
    const row = await campaignRow(campaignId);
    expect(row.dispatchesUsed).toBe(0);
    expect(await weightUsed(executionProfileId)).toBe(0);
    const released = await prisma!.historicalFillWeightReservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(released.releasedAt).not.toBeNull();

    // AND NOTHING BECAME RUNNABLE. 0 !== 1, so the reopening is vetoed.
    expect(row.status).toBe("EXHAUSTED");
    expect(await activeCount(executionProfileId)).toBe(0);
  });

  maybe()("the refund's veto reads the latch under the refund's own lock", async () => {
    // Ordering proof for the race in the other direction: a trip committing
    // concurrently with a refund cannot land between the veto's read and the
    // reactivation, because both sit inside one locked transaction.
    for (let round = 0; round < 4; round += 1) {
      const { executionProfileId, campaignId, reservation } = await finalSlotOutstanding(
        `refund-open-race-${round}`
      );
      const rivalBudget = new HistoricalFillWeightBudgetService(independentClient());
      const rivalBreaker = new HistoricalFillCircuitBreakerService(independentClient());

      await Promise.all([
        rivalBudget.releaseCertainNonDispatch(reservation),
        rivalBreaker.observeDispatchOutcome({
          executionProfileId,
          campaignId,
          ...SYSTEMIC,
        }),
      ]);

      // Refund first => EXHAUSTED reopens to ACTIVE, then the trip pauses it.
      // Trip first  => the veto holds and it stays EXHAUSTED.
      // Neither may end ACTIVE beside an OPEN latch.
      expect((await breaker.readState({ executionProfileId })).state).toBe("OPEN");
      expect(await activeCount(executionProfileId)).toBe(0);
      expect((await campaignRow(campaignId)).dispatchesUsed).toBe(0);
      expect(await weightUsed(executionProfileId)).toBe(0);
    }
  });
});
