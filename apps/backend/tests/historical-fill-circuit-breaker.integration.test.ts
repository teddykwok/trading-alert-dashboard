import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase, resolveTestDatabase } from "./helpers/test-database";
import {
  HistoricalFillCircuitBreakerService,
  HistoricalFillCircuitInvariantError,
  SYSTEMIC_THRESHOLD,
  classifyDispatchOutcome,
} from "../src/modules/execution/historical-fill-circuit-breaker.service";
import { HistoricalFillCampaignService } from "../src/modules/execution/historical-fill-campaign.service";

/**
 * The profile-level systemic latch, against a REAL Postgres.
 *
 * Everything load-bearing here is durable: that a trip survives the campaign
 * that triggered it, that it survives a campaign being replaced underneath it,
 * and that no later result can quietly rewrite or release it. None of that can
 * be shown against a mock, and the two races this breaker exists for are
 * exactly the ones a single in-process test would never reach — so contention
 * runs through INDEPENDENT PrismaClients.
 *
 * No Binance client is constructed here or in the code under test, and nothing
 * in this file performs network I/O.
 */

const TAG = "fill-circuit-synthetic";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const maybe = () => (available ? it : it.skip);

const clients: PrismaClient[] = [];
function independentClient(): PrismaClient {
  const client = new PrismaClient({ datasources: { db: { url: resolveTestDatabase().url } } });
  clients.push(client);
  return client;
}
function contender(): HistoricalFillCircuitBreakerService {
  return new HistoricalFillCircuitBreakerService(independentClient());
}

let breaker: HistoricalFillCircuitBreakerService;
let campaigns: HistoricalFillCampaignService;

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

/** A profile with one ACTIVE campaign, which is the ordinary starting point. */
async function withCampaign(suffix: string, maxDispatches = 10) {
  const executionProfileId = await makeProfile(suffix);
  const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches });
  return { executionProfileId, campaignId: campaign.id };
}

async function forceStatus(campaignId: string, status: string): Promise<void> {
  await prisma!.$executeRawUnsafe(
    `UPDATE "HistoricalFillCampaign" SET "status" = $1::"HistoricalFillCampaignStatus" WHERE "id" = $2`,
    status,
    campaignId
  );
}

async function breakerRow(executionProfileId: string) {
  return prisma!.historicalFillCircuitBreaker.findUnique({ where: { executionProfileId } });
}

async function campaignStatus(campaignId: string): Promise<string> {
  return (
    await prisma!.historicalFillCampaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { status: true },
    })
  ).status;
}

/** One systemic observation, as the driver will make it in 3B.2. */
function observe(
  svc: HistoricalFillCircuitBreakerService,
  executionProfileId: string,
  campaignId: string,
  outcome: string,
  reasonCode?: string | null
) {
  return svc.observeDispatchOutcome({ executionProfileId, campaignId, outcome, reasonCode });
}

beforeAll(async () => {
  if (!prisma || !available) return;
  breaker = new HistoricalFillCircuitBreakerService(prisma);
  campaigns = new HistoricalFillCampaignService(prisma);
});

afterAll(async () => {
  if (prisma && available) {
    await prisma.historicalFillCircuitBreaker.deleteMany({
      where: { executionProfile: { name: { startsWith: TAG } } },
    });
    await prisma.historicalFillWeightReservation.deleteMany({
      where: { campaign: { executionProfile: { name: { startsWith: TAG } } } },
    });
    await prisma.historicalFillCampaign.deleteMany({
      where: { executionProfile: { name: { startsWith: TAG } } },
    });
    await prisma.executionProfile.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.$disconnect();
  }
  await Promise.all(clients.map((client) => client.$disconnect()));
});

describe("classification is a pure, exhaustive judgement", () => {
  it.each([
    "MISSING_CREDENTIALS", "AUTH", "PERMISSION", "IP_BANNED",
    "IP_RESTRICTED", "FUTURES_NOT_ENABLED", "DISABLED", "READ_ONLY_VIOLATION",
  ])("%s is HARD_CONFIGURATION with a threshold of one", (reason) => {
    const c = classifyDispatchOutcome("RETRY_SCHEDULED", reason);
    expect(c).toEqual({ kind: "SYSTEMIC", family: "HARD_CONFIGURATION", threshold: 1 });
  });

  it.each([
    ["SERVER", "TRANSIENT_TRANSPORT"],
    ["NETWORK", "TRANSIENT_TRANSPORT"],
    ["TIMEOUT", "TRANSIENT_TRANSPORT"],
    ["RATE_LIMIT", "RATE_LIMIT"],
    ["TIMESTAMP", "TIMESTAMP"],
    ["MALFORMED_RESPONSE", "MALFORMED"],
    ["USER_TRADES_SYMBOL_MISMATCH", "MALFORMED"],
    ["USER_TRADES_ROW_COUNT_EXCEEDS_LIMIT", "MALFORMED"],
    ["REQUEST_INVALID", "REQUEST_CONTRACT"],
  ])("%s is family %s at the shared threshold", (reason, family) => {
    expect(classifyDispatchOutcome("RETRY_SCHEDULED", reason)).toEqual({
      kind: "SYSTEMIC",
      family,
      threshold: SYSTEMIC_THRESHOLD,
    });
  });

  it.each(["COMPLETE", "SPLIT", "INCOMPLETE_SKIPPED_ROWS", "SATURATED_SINGLE_MILLISECOND"])(
    "%s proves the pipeline works end to end",
    (outcome) => {
      expect(classifyDispatchOutcome(outcome, null)).toEqual({ kind: "EXCHANGE_HEALTHY" });
    }
  );

  it.each([
    ["NO_WORK", null],
    ["PROFILE_UNAVAILABLE", "PROFILE_NOT_FOUND"],
    ["STALE_CLAIM", "FILL_INGEST_STALE_CLAIM"],
    ["ABANDONED", "UNSUPPORTED_SYMBOL"],
    ["ABANDONED", "ORDER_NOT_FOUND"],
    ["ABANDONED", "ORDER_REJECTED"],
    ["RETRY_SCHEDULED", "FILL_LEDGER_INSERT_RACE"],
    ["RETRY_SCHEDULED", "FILL_LEDGER_RACE_UNRESOLVED"],
    ["RETRY_SCHEDULED", "SOMETHING_NOBODY_HAS_CLASSIFIED"],
  ])("%s / %s is neutral: it neither counts nor resets", (outcome, reason) => {
    expect(classifyDispatchOutcome(outcome, reason)).toEqual({ kind: "NEUTRAL" });
  });

  it("does not treat a rejection as proof of health", () => {
    // A rejection proves connectivity but produces no data and still spends a
    // slot, which is precisely the burn this breaker exists to stop.
    expect(classifyDispatchOutcome("ABANDONED", "UNSUPPORTED_SYMBOL")).not.toEqual({
      kind: "EXCHANGE_HEALTHY",
    });
    expect(classifyDispatchOutcome("ABANDONED", "REQUEST_INVALID")).toMatchObject({
      kind: "SYSTEMIC",
    });
  });
});

describe("streaks accumulate per family", () => {
  maybe()("counts NETWORK, TIMEOUT and SERVER as ONE transport streak", async () => {
    // The case that defeats an exact-code streak: one outage that alternates
    // between three transport codes must still be recognised as one outage.
    const { executionProfileId, campaignId } = await withCampaign("family-transport");

    const first = await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "NETWORK");
    expect(first.result).toBe("STREAK_UPDATED");
    expect(first.circuit.consecutiveCount).toBe(1);

    const second = await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "TIMEOUT");
    expect(second.result).toBe("STREAK_UPDATED");
    expect(second.circuit.consecutiveCount).toBe(2);
    expect(second.circuit.failureFamily).toBe("TRANSIENT_TRANSPORT");

    const third = await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "SERVER");
    expect(third.result).toBe("CIRCUIT_OPENED");
    expect(third.circuit.state).toBe("OPEN");
    expect(third.circuit.consecutiveCount).toBe(3);
    expect(third.circuit.lastReasonCode).toBe("SERVER");
    expect(third.circuit.openedAt).toBeInstanceOf(Date);
  });

  maybe()("restarts at one, never zero, when the family changes", async () => {
    // A systemic failure is never evidence of health. Resetting to zero on a
    // family change would let a fault that alternates families run forever.
    const { executionProfileId, campaignId } = await withCampaign("family-switch");
    await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "NETWORK");
    await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "NETWORK");

    const switched = await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "RATE_LIMIT");
    expect(switched.result).toBe("STREAK_UPDATED");
    expect(switched.circuit.consecutiveCount).toBe(1);
    expect(switched.circuit.failureFamily).toBe("RATE_LIMIT");
    expect(switched.circuit.state).toBe("CLOSED");

    const again = await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "TIMESTAMP");
    expect(again.circuit.consecutiveCount).toBe(1);
    expect(again.circuit.failureFamily).toBe("TIMESTAMP");
  });

  maybe()("keeps the streak start while the family holds", async () => {
    const { executionProfileId, campaignId } = await withCampaign("family-firstat");
    const first = await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "NETWORK");
    const second = await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "TIMEOUT");
    expect(second.circuit.firstFailureAt?.getTime()).toBe(first.circuit.firstFailureAt?.getTime());
    expect(second.circuit.lastFailureAt!.getTime()).toBeGreaterThanOrEqual(
      first.circuit.lastFailureAt!.getTime()
    );
  });

  maybe().each([
    "MISSING_CREDENTIALS", "AUTH", "PERMISSION", "IP_BANNED",
    "IP_RESTRICTED", "FUTURES_NOT_ENABLED", "DISABLED", "READ_ONLY_VIOLATION",
  ])("%s opens the circuit on its FIRST occurrence", async (reason) => {
    const { executionProfileId, campaignId } = await withCampaign(`hard-${reason}`);

    const result = await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", reason);

    expect(result.result).toBe("CIRCUIT_OPENED");
    expect(result.circuit.state).toBe("OPEN");
    expect(result.circuit.failureFamily).toBe("HARD_CONFIGURATION");
    expect(result.circuit.lastReasonCode).toBe(reason);
    expect(result.circuit.consecutiveCount).toBe(1);
    // And the profile has no ACTIVE campaign left.
    expect(await campaignStatus(campaignId)).toBe("PAUSED");
  });

  maybe().each(["REQUEST_INVALID", "MALFORMED_RESPONSE", "USER_TRADES_SYMBOL_MISMATCH"])(
    "%s needs three occurrences, not one",
    async (reason) => {
      const { executionProfileId, campaignId } = await withCampaign(`thr-${reason}`);
      expect((await observe(breaker, executionProfileId, campaignId, "ABANDONED", reason)).result).toBe(
        "STREAK_UPDATED"
      );
      expect((await observe(breaker, executionProfileId, campaignId, "ABANDONED", reason)).result).toBe(
        "STREAK_UPDATED"
      );
      expect((await observe(breaker, executionProfileId, campaignId, "ABANDONED", reason)).result).toBe(
        "CIRCUIT_OPENED"
      );
    }
  );
});

describe("healthy and neutral results", () => {
  maybe().each(["COMPLETE", "SPLIT", "INCOMPLETE_SKIPPED_ROWS", "SATURATED_SINGLE_MILLISECOND"])(
    "%s clears a CLOSED streak",
    async (outcome) => {
      const { executionProfileId, campaignId } = await withCampaign(`reset-${outcome}`);
      await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "NETWORK");
      await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "NETWORK");

      const reset = await observe(breaker, executionProfileId, campaignId, outcome, null);

      expect(reset.result).toBe("STREAK_RESET");
      expect(reset.circuit).toMatchObject({
        state: "CLOSED",
        consecutiveCount: 0,
        failureFamily: null,
        lastReasonCode: null,
        firstFailureAt: null,
        lastFailureAt: null,
        openedAt: null,
      });
    }
  );

  maybe()("writes nothing at all on the healthy path when no row exists", async () => {
    // The common case. A breaker that had to write a row per successful
    // dispatch would be a write amplifier on the path that matters least.
    const { executionProfileId, campaignId } = await withCampaign("healthy-norow");
    const result = await observe(breaker, executionProfileId, campaignId, "COMPLETE", null);
    expect(result.result).toBe("NO_CHANGE");
    expect(await breakerRow(executionProfileId)).toBeNull();
  });

  maybe().each([
    ["NO_WORK", null],
    ["PROFILE_UNAVAILABLE", "PROFILE_NOT_FOUND"],
    ["STALE_CLAIM", "FILL_INGEST_STALE_CLAIM"],
    ["ABANDONED", "UNSUPPORTED_SYMBOL"],
    ["ABANDONED", "ORDER_NOT_FOUND"],
    ["ABANDONED", "ORDER_REJECTED"],
    ["RETRY_SCHEDULED", "FILL_LEDGER_INSERT_RACE"],
    ["RETRY_SCHEDULED", "FILL_LEDGER_RACE_UNRESOLVED"],
  ])("%s / %s leaves an existing streak exactly where it was", async (outcome, reason) => {
    const { executionProfileId, campaignId } = await withCampaign(`neutral-${outcome}-${reason}`);
    await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "NETWORK");
    await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "NETWORK");
    const before = await breakerRow(executionProfileId);

    const neutral = await observe(breaker, executionProfileId, campaignId, outcome, reason);

    expect(neutral.result).toBe("NO_CHANGE");
    const after = await breakerRow(executionProfileId);
    expect(after).toEqual(before);
    expect(after!.consecutiveCount).toBe(2);
  });
});

describe("OPEN is a latch", () => {
  maybe()("no later result rewrites the cause that actually opened it", async () => {
    // Requests admitted before the trip keep landing afterwards. If each could
    // overwrite the family, reason or timestamps, the snapshot an operator
    // reads would describe whichever straggler arrived last rather than the
    // fault that stopped the work.
    const { executionProfileId, campaignId } = await withCampaign("latch-stable");
    const opened = await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "AUTH");
    expect(opened.result).toBe("CIRCUIT_OPENED");
    const frozen = await breakerRow(executionProfileId);

    for (const [outcome, reason] of [
      ["RETRY_SCHEDULED", "NETWORK"],
      ["RETRY_SCHEDULED", "TIMEOUT"],
      ["RETRY_SCHEDULED", "IP_BANNED"],
      ["COMPLETE", null],
      ["SPLIT", null],
      ["NO_WORK", null],
    ] as const) {
      const later = await observe(breaker, executionProfileId, campaignId, outcome, reason);
      expect(later.result).toBe("ALREADY_OPEN");
    }

    // ZERO writes: even updatedAt has not moved.
    expect(await breakerRow(executionProfileId)).toEqual(frozen);
  });

  maybe()("a healthy result never auto-closes it", async () => {
    const { executionProfileId, campaignId } = await withCampaign("latch-no-autoclose");
    await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "AUTH");

    await observe(breaker, executionProfileId, campaignId, "COMPLETE", null);
    await observe(breaker, executionProfileId, campaignId, "COMPLETE", null);

    expect((await breakerRow(executionProfileId))!.state).toBe("OPEN");
  });
});

describe("opening the circuit leaves the profile with ZERO active campaigns", () => {
  maybe()("pauses the campaign that is ACTIVE right now, not the triggering one", async () => {
    // THE load-bearing race. Campaign A takes its final slot and becomes
    // EXHAUSTED; before its AUTH response lands, the operator starts campaign B.
    // Pausing the TRIGGERING campaign would leave B running into the same fault.
    const { executionProfileId, campaignId: a } = await withCampaign("race-final-slot", 1);
    await forceStatus(a, "EXHAUSTED");
    const b = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });

    const opened = await observe(breaker, executionProfileId, a, "RETRY_SCHEDULED", "AUTH");

    expect(opened.result).toBe("CIRCUIT_OPENED");
    expect(opened.pausedCampaignId).toBe(b.id);
    // A is never resurrected; B is stopped.
    expect(await campaignStatus(a)).toBe("EXHAUSTED");
    expect(await campaignStatus(b.id)).toBe("PAUSED");
    expect(
      await prisma!.historicalFillCampaign.count({ where: { executionProfileId, status: "ACTIVE" } })
    ).toBe(0);
  });

  maybe()("opens with no campaign to pause when the triggering one is already EXHAUSTED", async () => {
    const { executionProfileId, campaignId } = await withCampaign("final-slot-alone", 1);
    await forceStatus(campaignId, "EXHAUSTED");

    const opened = await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "AUTH");

    expect(opened.result).toBe("CIRCUIT_OPENED");
    expect(opened.pausedCampaignId).toBeNull();
    expect(await campaignStatus(campaignId)).toBe("EXHAUSTED");
    expect(
      await prisma!.historicalFillCampaign.count({ where: { executionProfileId, status: "ACTIVE" } })
    ).toBe(0);
  });

  maybe()("records the trip even though the campaign was manually PAUSED first", async () => {
    // The second defect the profile scope exists to fix: under campaign-local
    // state this observation was a no-op and the evidence was discarded.
    const { executionProfileId, campaignId } = await withCampaign("race-manual-pause");
    await campaigns.pauseCampaign(campaignId);

    const opened = await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "AUTH");

    expect(opened.result).toBe("CIRCUIT_OPENED");
    expect(opened.circuit.state).toBe("OPEN");
    expect(opened.pausedCampaignId).toBeNull();
    expect(await campaignStatus(campaignId)).toBe("PAUSED");
  });

  maybe().each(["ABORTED", "EXHAUSTED"])(
    "never resurrects a %s triggering campaign",
    async (status) => {
      const { executionProfileId, campaignId } = await withCampaign(`terminal-${status}`);
      await forceStatus(campaignId, status);

      const opened = await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "AUTH");

      expect(opened.result).toBe("CIRCUIT_OPENED");
      expect(await campaignStatus(campaignId)).toBe(status);
    }
  );

  maybe()("refuses a triggering campaign that belongs to another profile", async () => {
    const mine = await makeProfile("lineage-mine");
    const theirs = await withCampaign("lineage-theirs");

    await expect(
      observe(breaker, mine, theirs.campaignId, "RETRY_SCHEDULED", "AUTH")
    ).rejects.toBeInstanceOf(HistoricalFillCircuitInvariantError);

    // Nothing was written for either profile.
    expect(await breakerRow(mine)).toBeNull();
    expect(await breakerRow(theirs.executionProfileId)).toBeNull();
  });

  maybe()("refuses a triggering campaign that does not exist", async () => {
    const executionProfileId = await makeProfile("lineage-missing");
    await expect(
      observe(breaker, executionProfileId, "no-such-campaign", "RETRY_SCHEDULED", "AUTH")
    ).rejects.toBeInstanceOf(HistoricalFillCircuitInvariantError);
    expect(await breakerRow(executionProfileId)).toBeNull();
  });
});

describe("acknowledgement is the only way back", () => {
  maybe()("clears the latch and leaves a PAUSED campaign paused", async () => {
    // Deliberately NOT a resume. A second, explicit operator action is always
    // required before any work can start again.
    const { executionProfileId, campaignId } = await withCampaign("ack-paused");
    await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "AUTH");
    expect(await campaignStatus(campaignId)).toBe("PAUSED");

    const ack = await breaker.acknowledge({ executionProfileId });

    expect(ack.result).toBe("ACKNOWLEDGED");
    expect(ack.circuit).toMatchObject({
      state: "CLOSED",
      openedAt: null,
      failureFamily: null,
      lastReasonCode: null,
      consecutiveCount: 0,
      firstFailureAt: null,
      lastFailureAt: null,
    });
    expect(await campaignStatus(campaignId)).toBe("PAUSED");
  });

  maybe()("leaves an EXHAUSTED campaign exhausted", async () => {
    const { executionProfileId, campaignId } = await withCampaign("ack-exhausted", 1);
    await forceStatus(campaignId, "EXHAUSTED");
    await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "AUTH");

    await breaker.acknowledge({ executionProfileId });

    expect((await breakerRow(executionProfileId))!.state).toBe("CLOSED");
    expect(await campaignStatus(campaignId)).toBe("EXHAUSTED");
  });

  maybe()("REFUSES while an ACTIVE campaign somehow exists, and stays OPEN", async () => {
    // Unreachable by design — opening pauses the ACTIVE campaign in the same
    // transaction — so reaching it means something bypassed that invariant, and
    // clearing the latch would instantly expose runnable work to the fault.
    const { executionProfileId, campaignId } = await withCampaign("ack-corrupt");
    await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "AUTH");
    await forceStatus(campaignId, "ACTIVE");

    await expect(breaker.acknowledge({ executionProfileId })).rejects.toBeInstanceOf(
      HistoricalFillCircuitInvariantError
    );
    expect((await breakerRow(executionProfileId))!.state).toBe("OPEN");
  });

  maybe()("is a clean no-op when nothing is open", async () => {
    const executionProfileId = await makeProfile("ack-noop");
    const none = await breaker.acknowledge({ executionProfileId });
    expect(none.result).toBe("ALREADY_CLOSED");
    // And it did not invent a row.
    expect(await breakerRow(executionProfileId)).toBeNull();

    const { executionProfileId: withStreak, campaignId } = await withCampaign("ack-noop-closed");
    await observe(breaker, withStreak, campaignId, "RETRY_SCHEDULED", "NETWORK");
    expect((await breaker.acknowledge({ executionProfileId: withStreak })).result).toBe("ALREADY_CLOSED");
  });

  maybe()("allows the circuit to open again after acknowledgement", async () => {
    const { executionProfileId, campaignId } = await withCampaign("ack-reopen");
    await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "AUTH");
    await breaker.acknowledge({ executionProfileId });

    const again = await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "PERMISSION");
    expect(again.result).toBe("CIRCUIT_OPENED");
    expect(again.circuit.lastReasonCode).toBe("PERMISSION");
  });
});

describe("durability and concurrency", () => {
  maybe()("concurrent failures cannot lose an increment", async () => {
    // Starting at one, two simultaneous failures must reach three and OPEN —
    // not two, which is what a lost update would produce.
    const { executionProfileId, campaignId } = await withCampaign("race-counter");
    await observe(breaker, executionProfileId, campaignId, "RETRY_SCHEDULED", "NETWORK");

    const [a, b] = [contender(), contender()];
    await Promise.all([
      observe(a, executionProfileId, campaignId, "RETRY_SCHEDULED", "TIMEOUT"),
      observe(b, executionProfileId, campaignId, "RETRY_SCHEDULED", "SERVER"),
    ]);

    const row = await breakerRow(executionProfileId);
    expect(row!.consecutiveCount).toBe(3);
    expect(row!.state).toBe("OPEN");
    expect(await campaignStatus(campaignId)).toBe("PAUSED");
  });

  maybe()("six concurrent hard failures open it exactly once", async () => {
    const { executionProfileId, campaignId } = await withCampaign("race-hard");
    const contenders = Array.from({ length: 6 }, () => contender());

    const results = await Promise.all(
      contenders.map((c) => observe(c, executionProfileId, campaignId, "RETRY_SCHEDULED", "AUTH"))
    );

    expect(results.filter((r) => r.result === "CIRCUIT_OPENED")).toHaveLength(1);
    expect(results.filter((r) => r.result === "ALREADY_OPEN")).toHaveLength(5);
    const row = await breakerRow(executionProfileId);
    expect(row!.state).toBe("OPEN");
    // The opening cause was never rewritten by the five that followed.
    expect(row!.consecutiveCount).toBe(1);
  });

  maybe()("state survives the client that wrote it", async () => {
    const { executionProfileId, campaignId } = await withCampaign("durability");
    const writer = independentClient();
    await new HistoricalFillCircuitBreakerService(writer).observeDispatchOutcome({
      executionProfileId,
      campaignId,
      outcome: "RETRY_SCHEDULED",
      reasonCode: "AUTH",
    });

    const reader = new HistoricalFillCircuitBreakerService(independentClient());
    expect((await reader.readState({ executionProfileId })).state).toBe("OPEN");

    await writer.$disconnect();

    // A completely fresh client, after the writer is gone.
    const fresh = new HistoricalFillCircuitBreakerService(independentClient());
    const seen = await fresh.readState({ executionProfileId });
    expect(seen.state).toBe("OPEN");
    expect(seen.failureFamily).toBe("HARD_CONFIGURATION");
    expect(seen.openedAt).toBeInstanceOf(Date);
  });

  maybe()("profiles do not interfere with each other", async () => {
    const one = await withCampaign("isolation-a");
    const two = await withCampaign("isolation-b");

    await observe(breaker, one.executionProfileId, one.campaignId, "RETRY_SCHEDULED", "AUTH");

    expect((await breaker.readState({ executionProfileId: one.executionProfileId })).state).toBe("OPEN");
    expect((await breaker.readState({ executionProfileId: two.executionProfileId })).state).toBe("CLOSED");
    expect(await campaignStatus(two.campaignId)).toBe("ACTIVE");
  });
});
