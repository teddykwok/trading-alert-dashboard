import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * The exhausted-window repair end to end, against a REAL Postgres.
 *
 * The service method is the audited one, unchanged; what is under test is that
 * the operator command drives it correctly and that its eligibility rules hold
 * against real rows -- including the ones it must refuse to touch, which is
 * where a repair command does its damage if it is wrong.
 *
 * The last test closes the loop the whole slice exists for: once the zombie is
 * finalized, the EXISTING drained-queue check can complete a campaign that
 * could not previously complete. The CLI never calls that check itself.
 */

const TAG = "finalize-exh";
const SYMBOL = "FINEXHUSDT";
const DAY = 86_400_000;
const DAY_START = Date.UTC(2026, 8, 15);

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { ExchangeFillIngestWindowService, MAX_INGEST_ATTEMPTS, INGEST_CLAIM_LEASE_MS } =
  await import("../src/modules/execution/exchange-fill-ingest-window.service");
const { HistoricalFillCampaignGate } = await import(
  "../src/modules/execution/historical-fill-campaign-gate.service"
);
const { HistoricalFillCampaignService } = await import(
  "../src/modules/execution/historical-fill-campaign.service"
);
const { FINALIZE_CLI_EXIT, runFillFinalizeExhaustedCli } = await import(
  "../src/modules/execution/fill-finalize-exhausted-cli"
);

const maybe = () => (available ? it : it.skip);

/** Well past any lease, so "stale" is never a matter of timing luck. */
const STALE = () => new Date(Date.now() - INGEST_CLAIM_LEASE_MS - 600_000);
/** Inside the lease by a wide margin, so "live" is equally unambiguous. */
const LIVE = () => new Date(Date.now() - 1_000);

let work: InstanceType<typeof ExchangeFillIngestWindowService>;
let sequence = 0;

async function profile(alias: string) {
  sequence += 1;
  return prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${alias} ${sequence}`,
      accountIdentifier: `${TAG}-${alias}-${sequence}`,
      environment: "TESTNET",
      isEnabled: false,
      safetyPolicy: { create: {} },
    },
  });
}

async function windowRow(
  executionProfileId: string,
  dayOffset: number,
  overrides: Record<string, unknown> = {}
) {
  const start = DAY_START + dayOffset * DAY;
  return prisma!.exchangeFillIngestWindow.create({
    data: {
      executionProfileId,
      symbol: SYMBOL,
      startTimeMs: BigInt(start),
      endTimeMs: BigInt(start + DAY - 1),
      ...overrides,
    },
  });
}

/** The zombie: last attempt claimed, worker died, lease expired. */
const zombie = (executionProfileId: string, dayOffset = 0) =>
  windowRow(executionProfileId, dayOffset, {
    attempts: MAX_INGEST_ATTEMPTS,
    claimedAt: STALE(),
    claimOwner: "dead-worker",
  });

/** The command over the real service, bound to one test's own profile. */
async function run(executionProfileId: string, argv: string[] = []) {
  const lines: string[] = [];
  const result = await runFillFinalizeExhaustedCli(argv, {
    prisma: prisma!,
    work,
    bindProfile: async () =>
      ({ ok: true, context: { executionProfileId, environment: "TESTNET" } }) as never,
    out: (line) => lines.push(line),
  });
  return { ...result, lines, text: lines.join("\n") };
}

const rowOf = (id: string) =>
  prisma!.exchangeFillIngestWindow.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  if (!prisma || !available) return;
  work = new ExchangeFillIngestWindowService(prisma);
});

beforeEach(() => {
  sequence += 1;
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    const profiles = (
      await prisma.executionProfile.findMany({
        where: { accountIdentifier: { startsWith: TAG } },
        select: { id: true },
      })
    ).map((row) => row.id);
    await prisma.historicalFillCampaign.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
    await prisma.exchangeFillIngestWindow.deleteMany({
      where: { executionProfileId: { in: profiles }, parentId: { not: null } },
    });
    await prisma.exchangeFillIngestWindow.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
    await prisma.executionSafetyPolicy.deleteMany({
      where: { executionProfileId: { in: profiles } },
    });
    await prisma.executionProfile.deleteMany({ where: { id: { in: profiles } } });
  }
  await prisma.$disconnect();
});

describe("the zombie is finalized on the existing terminal contract", () => {
  maybe()("moves a stale exhausted PENDING row to ABANDONED and clears its lease", async () => {
    const target = await profile("zombie");
    const stuck = await zombie(target.id);

    const result = await run(target.id);

    expect(result.exitCode).toBe(FINALIZE_CLI_EXIT.OK);
    expect(result.text).toContain("windows finalized        1");
    expect(result.text).toContain(stuck.id);

    const after = await rowOf(stuck.id);
    expect(after.status).toBe("ABANDONED");
    expect(after.lastErrorCode).toBe("ATTEMPT_BUDGET_EXHAUSTED_AFTER_STALE_LEASE");
    expect(after.sanitizedLastError).toBeNull();
    // TERMINAL_CLEARED: the lease is released with the row.
    expect(after.claimedAt).toBeNull();
    expect(after.claimOwner).toBeNull();
    expect(after.nextEligibleAt).toBeNull();
    // The attempt history is evidence and is NOT rewritten.
    expect(after.attempts).toBe(MAX_INGEST_ATTEMPTS);
  });

  maybe()("finalizes nothing on a second invocation", async () => {
    const target = await profile("idempotent");
    const stuck = await zombie(target.id);

    const first = await run(target.id);
    expect(first.text).toContain("windows finalized        1");
    const settled = await rowOf(stuck.id);

    const second = await run(target.id);

    expect(second.exitCode).toBe(FINALIZE_CLI_EXIT.OK);
    expect(second.text).toContain("windows finalized        0");
    // Not merely "still ABANDONED": the row is unchanged field for field.
    expect(await rowOf(stuck.id)).toEqual(settled);
  });
});

describe("every ineligible row is left exactly as it was", () => {
  maybe()("refuses a row whose lease is still live at the attempt ceiling", async () => {
    // That worker still has its full lease to come back and report. Taking the
    // row from it would be the stale-write hazard in reverse.
    const target = await profile("live-lease");
    const held = await windowRow(target.id, 0, {
      attempts: MAX_INGEST_ATTEMPTS,
      claimedAt: LIVE(),
      claimOwner: "live-worker",
    });
    const before = await rowOf(held.id);

    const result = await run(target.id);

    expect(result.text).toContain("windows finalized        0");
    expect(await rowOf(held.id)).toEqual(before);
  });

  maybe()("refuses a pending row below the attempt ceiling", async () => {
    const target = await profile("below-max");
    const retryable = await windowRow(target.id, 0, {
      attempts: MAX_INGEST_ATTEMPTS - 1,
      claimedAt: STALE(),
      claimOwner: "dead-worker",
    });
    const before = await rowOf(retryable.id);

    const result = await run(target.id);

    // Still claimable by the ordinary path, so it is not this command's business.
    expect(result.text).toContain("windows finalized        0");
    expect(await rowOf(retryable.id)).toEqual(before);
  });

  maybe()("refuses another execution profile's stale exhausted row", async () => {
    const mine = await profile("mine");
    const stranger = await profile("stranger");
    const theirs = await zombie(stranger.id);
    const before = await rowOf(theirs.id);

    const result = await run(mine.id);

    expect(result.text).toContain("windows finalized        0");
    expect(await rowOf(theirs.id)).toEqual(before);
    expect((await rowOf(theirs.id)).status).toBe("PENDING");
  });

  const NON_PENDING = ["COMPLETE", "SPLIT", "ABANDONED", "INCOMPLETE_SKIPPED_ROWS"] as const;

  for (const status of NON_PENDING) {
    maybe()(`refuses a ${status} row even at the attempt ceiling`, async () => {
      const target = await profile(`status-${status.toLowerCase()}`);
      const terminal = await windowRow(target.id, 0, {
        status,
        attempts: MAX_INGEST_ATTEMPTS,
        // Both claim columns together: the schema enforces that they agree
        // (`("claimedAt" IS NULL) = ("claimOwner" IS NULL)`), so a lease is
        // never half-written even in a fixture.
        claimedAt: STALE(),
        claimOwner: "dead-worker",
      });
      const before = await rowOf(terminal.id);

      const result = await run(target.id);

      expect(result.text).toContain("windows finalized        0");
      expect(await rowOf(terminal.id)).toEqual(before);
    });
  }

  maybe()("touches nothing at all when the whole profile is healthy", async () => {
    const target = await profile("healthy");
    const pending = await windowRow(target.id, 0);
    const complete = await windowRow(target.id, 1, { status: "COMPLETE" });
    const before = [await rowOf(pending.id), await rowOf(complete.id)];

    const result = await run(target.id);

    expect(result.text).toContain("windows finalized        0");
    expect([await rowOf(pending.id), await rowOf(complete.id)]).toEqual(before);
  });
});

describe("the compare-and-set refuses a row that moved under it", () => {
  /**
   * A client that re-claims the row BETWEEN the candidate read and the write.
   *
   * `finalizeStaleExhausted` touches exactly two delegate methods, so this
   * narrow stand-in drives the one interleaving the lease re-assertion exists
   * for. It is TEST instrumentation through the method's own injectable client;
   * production code is untouched, and there is no sleep or timing assumption.
   */
  function clientReclaimingAfterRead(after: () => Promise<unknown>) {
    return {
      exchangeFillIngestWindow: {
        findMany: async (args: never) => {
          const candidates = await prisma!.exchangeFillIngestWindow.findMany(args);
          await after();
          return candidates;
        },
        updateMany: (args: never) => prisma!.exchangeFillIngestWindow.updateMany(args),
      },
    } as never;
  }

  maybe()("leaves a window a live worker re-claimed after the read", async () => {
    // The hazard in reverse: the row looked abandonable, then its real owner
    // came back and took a fresh lease. Finalizing it now would overwrite a
    // worker that is still entitled to report.
    const target = await profile("cas-reclaim");
    const stuck = await zombie(target.id);
    const revived = new Date();

    const finalized = await work.finalizeStaleExhausted(
      clientReclaimingAfterRead(() =>
        prisma!.exchangeFillIngestWindow.update({
          where: { id: stuck.id },
          data: { claimedAt: revived, claimOwner: "revived-worker" },
        })
      ),
      { executionProfileId: target.id }
    );

    expect(finalized).toEqual([]);
    const after = await rowOf(stuck.id);
    // Still PENDING, still owned by the worker that came back.
    expect(after.status).toBe("PENDING");
    expect(after.claimOwner).toBe("revived-worker");
    expect(after.claimedAt?.toISOString()).toBe(revived.toISOString());
  });
});

describe("one invocation is one bounded pass", () => {
  maybe()("never exceeds the service's own audited batch bound", async () => {
    // Deliberately more eligible rows than the bound, so a command that had
    // quietly become a sweep would show it here.
    const target = await profile("bounded");
    const created: string[] = [];
    for (let index = 0; index < 52; index += 1) {
      created.push((await zombie(target.id, index)).id);
    }

    const first = await run(target.id);

    const finalizedFirst = await prisma!.exchangeFillIngestWindow.count({
      where: { executionProfileId: target.id, status: "ABANDONED" },
    });
    // The audited default bound is 50. Pinned here so widening it becomes a
    // visible test change rather than a silent behaviour change.
    expect(finalizedFirst).toBe(50);
    expect(first.text).toContain("windows finalized        50");
    expect(
      await prisma!.exchangeFillIngestWindow.count({
        where: { executionProfileId: target.id, status: "PENDING" },
      })
    ).toBe(2);

    // The remainder is reachable, but only because a person ran it again.
    const second = await run(target.id);
    expect(second.text).toContain("windows finalized        2");
    expect(
      await prisma!.exchangeFillIngestWindow.count({
        where: { executionProfileId: target.id, status: "PENDING" },
      })
    ).toBe(0);
    expect(created).toHaveLength(52);
  });
});

describe("the repair unblocks completion without performing it", () => {
  maybe()("an otherwise-drained ACTIVE campaign can complete only after the repair", async () => {
    const target = await profile("completion");
    const campaigns = new HistoricalFillCampaignService(prisma!);
    const gate = new HistoricalFillCampaignGate({ prisma: prisma! });
    const campaign = await campaigns.createCampaign({
      executionProfileId: target.id,
      maxDispatches: 1,
    });
    // Everything else is finished; ONE zombie is all that stands in the way.
    await windowRow(target.id, 1, { status: "COMPLETE" });
    const stuck = await zombie(target.id, 0);

    // BEFORE: the drained check counts the zombie and refuses to complete.
    expect(await gate.completeIfDrained(target.id, campaign.id)).toBe("ACTIVE");

    const result = await run(target.id);
    expect(result.text).toContain("windows finalized        1");
    expect((await rowOf(stuck.id)).status).toBe("ABANDONED");

    // The CLI did NOT complete the campaign itself.
    expect((await campaigns.getCampaignStatus(campaign.id))?.status).toBe("ACTIVE");

    // AFTER: the EXISTING check, unchanged, can now finish it.
    expect(await gate.completeIfDrained(target.id, campaign.id)).toBe("COMPLETED");
    expect((await campaigns.getCampaignStatus(campaign.id))?.status).toBe("COMPLETED");
  });
});
