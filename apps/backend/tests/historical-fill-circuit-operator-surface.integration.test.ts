import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";
import { HistoricalFillOperationalSnapshotService } from "../src/modules/execution/historical-fill-operational-snapshot.service";
import { interpretHistoricalFillOperationalSnapshot } from "../src/modules/execution/historical-fill-operational-interpretation";
import { HistoricalFillCircuitBreakerService } from "../src/modules/execution/historical-fill-circuit-breaker.service";
import { HistoricalFillCampaignService } from "../src/modules/execution/historical-fill-campaign.service";
import {
  runFillCampaignCli,
  CLI_EXIT,
  type FillCampaignCliDependencies,
} from "../src/modules/execution/fill-campaign-cli";

/**
 * THE OPERATOR RECOVERY SURFACE, against a REAL Postgres.
 *
 * Everything before this slice made the circuit correct; this one makes it
 * VISIBLE and CLEARABLE. Two properties carry most of the weight here and
 * neither is obvious from reading the code:
 *
 *   * null means "no circuit has ever been recorded", and is NOT the same as a
 *     circuit that happens to be closed. The breaker service answers an absent
 *     row as logical CLOSED -- correct for admission, wrong for a dashboard --
 *     so the snapshot deliberately does not use that reading.
 *
 *   * acknowledgement clears the latch and NOTHING else. The campaign it paused
 *     stays paused. That separation is the last line of defence against a
 *     recovery action quietly putting an account back to work.
 *
 * No Binance client is constructed here or in the code under test, and nothing
 * performs network I/O.
 */

const TAG = "fill-circuit-operator-synthetic";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const maybe = () => (available ? it : it.skip);

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

/** The snapshot service bound to one synthetic profile. */
function snapshotFor(executionProfileId: string): HistoricalFillOperationalSnapshotService {
  return new HistoricalFillOperationalSnapshotService({
    prisma: prisma!,
    // Injected because the real binder reads process configuration, which
    // cannot name a synthetic profile. Everything below it is real.
    bindProfile: async () => ({ ok: true, context: { executionProfileId } }) as never,
  });
}

async function readySnapshot(executionProfileId: string) {
  const snapshot = await snapshotFor(executionProfileId).capture();
  if (snapshot.outcome !== "READY") throw new Error(`expected READY, got ${snapshot.outcome}`);
  return snapshot;
}

/** Captures CLI output instead of writing to a terminal. */
function cli(executionProfileId: string, bindFails = false) {
  const printed: string[] = [];
  const deps: FillCampaignCliDependencies = {
    prisma: prisma!,
    campaigns: new HistoricalFillCampaignService(prisma!),
    circuit: new HistoricalFillCircuitBreakerService(prisma!),
    bindProfile: async () =>
      (bindFails
        ? { ok: false, reasonCode: "PROFILE_NOT_CONFIGURED" }
        : { ok: true, context: { executionProfileId } }) as never,
    out: (line) => printed.push(line),
  };
  return { deps, printed, text: () => printed.join("\n") };
}

/** Opens the latch the way the runtime does: one hard-configuration failure. */
async function openCircuit(executionProfileId: string, campaignId: string) {
  const observation = await breaker.observeDispatchOutcome({
    executionProfileId,
    campaignId,
    outcome: "RETRY_SCHEDULED",
    reasonCode: "AUTH",
  });
  expect(observation.result).toBe("CIRCUIT_OPENED");
  return observation;
}

/** A streak below its threshold: a persisted row that has never opened. */
async function buildStreak(executionProfileId: string, campaignId: string, times = 2) {
  for (let i = 0; i < times; i += 1) {
    await breaker.observeDispatchOutcome({
      executionProfileId,
      campaignId,
      outcome: "RETRY_SCHEDULED",
      reasonCode: "SERVER",
    });
  }
}

async function campaignRow(campaignId: string) {
  return prisma!.historicalFillCampaign.findUniqueOrThrow({ where: { id: campaignId } });
}

async function breakerRow(executionProfileId: string) {
  return prisma!.historicalFillCircuitBreaker.findUnique({ where: { executionProfileId } });
}

beforeAll(() => {
  if (!prisma) return;
  breaker = new HistoricalFillCircuitBreakerService(prisma);
  campaigns = new HistoricalFillCampaignService(prisma);
});

afterAll(async () => {
  // Nothing to disconnect: every service here shares the suite's client.
});

describe("the snapshot reports the latch, and null when there has never been one", () => {
  maybe()("no persisted row means null, and creates none", async () => {
    const executionProfileId = await makeProfile("snapshot-absent");

    const snapshot = await readySnapshot(executionProfileId);

    // NOT a synthesized CLOSED block. Null says "no circuit has ever been
    // recorded here", which is a different fact from "the circuit is closed".
    expect(snapshot.circuitBreaker).toBeNull();
    // And reading the snapshot did not bring a row into existence.
    expect(await breakerRow(executionProfileId)).toBeNull();
    expect(interpretHistoricalFillOperationalSnapshot(snapshot).state).toBe("NORMAL");
  });

  maybe()("a persisted CLOSED streak is reported with its context, and is NOT an issue", async () => {
    const executionProfileId = await makeProfile("snapshot-streak");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await buildStreak(executionProfileId, campaign.id, 2);

    const snapshot = await readySnapshot(executionProfileId);

    expect(snapshot.circuitBreaker).not.toBeNull();
    expect(snapshot.circuitBreaker!.state).toBe("CLOSED");
    expect(snapshot.circuitBreaker!.failureFamily).toBe("TRANSIENT_TRANSPORT");
    expect(snapshot.circuitBreaker!.lastReasonCode).toBe("SERVER");
    expect(snapshot.circuitBreaker!.consecutiveCount).toBe(2);
    expect(snapshot.circuitBreaker!.firstFailureAt).not.toBeNull();
    expect(snapshot.circuitBreaker!.lastFailureAt).not.toBeNull();
    // Still CLOSED, so nothing opened: the CHECK constraint guarantees this.
    expect(snapshot.circuitBreaker!.openedAt).toBeNull();

    // A streak is the system NOTICING, not the system stopped.
    const interpretation = interpretHistoricalFillOperationalSnapshot(snapshot);
    expect(interpretation.state).toBe("NORMAL");
    expect(interpretation.issues).toEqual([]);
  });

  maybe()("OPEN is reported with its opening cause, and needs a human", async () => {
    const executionProfileId = await makeProfile("snapshot-open");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    const opened = await openCircuit(executionProfileId, campaign.id);

    const snapshot = await readySnapshot(executionProfileId);

    expect(snapshot.circuitBreaker).toEqual({
      state: "OPEN",
      failureFamily: "HARD_CONFIGURATION",
      lastReasonCode: "AUTH",
      consecutiveCount: 1,
      firstFailureAt: opened.circuit.firstFailureAt,
      lastFailureAt: opened.circuit.lastFailureAt,
      openedAt: opened.circuit.openedAt,
    });

    const interpretation = interpretHistoricalFillOperationalSnapshot(snapshot);
    expect(interpretation.state).toBe("NEEDS_ATTENTION");
    expect(interpretation.issues).toEqual([
      { code: "HISTORICAL_FILL_SYSTEMIC_CIRCUIT_OPEN", count: 1 },
    ]);
  });

  maybe()("never exposes the internal epoch counter", async () => {
    const executionProfileId = await makeProfile("snapshot-no-generation");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await openCircuit(executionProfileId, campaign.id);

    const snapshot = await readySnapshot(executionProfileId);

    // The row HAS a generation; the snapshot must not.
    expect((await breakerRow(executionProfileId))!.generation).toBe(1);
    expect(Object.keys(snapshot.circuitBreaker!).sort()).toEqual([
      "consecutiveCount",
      "failureFamily",
      "firstFailureAt",
      "lastFailureAt",
      "lastReasonCode",
      "openedAt",
      "state",
    ]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("generation");
    expect(serialized).not.toContain("updatedAt");
  });

  maybe()("stays visible when the profile has NO campaign at all", async () => {
    // Profile-level, and this is the case that matters most: a systemic fault
    // that stopped an account often leaves nothing live behind to ask about.
    const executionProfileId = await makeProfile("snapshot-open-no-campaign");
    const seed = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await openCircuit(executionProfileId, seed.id);
    await campaigns.abortCampaign(seed.id);

    const snapshot = await readySnapshot(executionProfileId);

    expect(snapshot.campaign!.status).toBe("ABORTED");
    expect(snapshot.circuitBreaker!.state).toBe("OPEN");
    expect(interpretHistoricalFillOperationalSnapshot(snapshot).state).toBe("NEEDS_ATTENTION");
  });

  maybe()("stays visible beside a terminal EXHAUSTED campaign", async () => {
    const executionProfileId = await makeProfile("snapshot-open-exhausted");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await prisma!.$executeRawUnsafe(
      `UPDATE "HistoricalFillCampaign" SET "status" = 'EXHAUSTED' WHERE "id" = $1`,
      campaign.id
    );
    await openCircuit(executionProfileId, campaign.id);

    const snapshot = await readySnapshot(executionProfileId);

    expect(snapshot.campaign!.status).toBe("EXHAUSTED");
    expect(snapshot.circuitBreaker!.state).toBe("OPEN");
    expect(interpretHistoricalFillOperationalSnapshot(snapshot).state).toBe("NEEDS_ATTENTION");
  });

  maybe()("a PAUSED campaign alone is still NORMAL", async () => {
    // The 2B.3 invariant, re-proven now that a second issue exists: a campaign
    // somebody deliberately paused is a decision, not a condition.
    const executionProfileId = await makeProfile("snapshot-paused-normal");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await campaigns.pauseCampaign(campaign.id);

    const snapshot = await readySnapshot(executionProfileId);

    expect(snapshot.campaign!.status).toBe("PAUSED");
    expect(snapshot.circuitBreaker).toBeNull();
    const interpretation = interpretHistoricalFillOperationalSnapshot(snapshot);
    expect(interpretation.state).toBe("NORMAL");
    expect(interpretation.issues).toEqual([]);
  });
});

describe("the status CLI shows the circuit, campaign or no campaign", () => {
  maybe()("reports a concise CLOSED line when no row has ever been persisted", async () => {
    const executionProfileId = await makeProfile("cli-status-absent");
    const { deps, text } = cli(executionProfileId);

    const result = await runFillCampaignCli(["status"], deps);

    expect(result.exitCode).toBe(CLI_EXIT.OK);
    expect(text()).toContain("no persisted breaker state");
    // Reading status must never bring a row into existence.
    expect(await breakerRow(executionProfileId)).toBeNull();
  });

  maybe()("reports a persisted CLOSED streak with its context", async () => {
    const executionProfileId = await makeProfile("cli-status-streak");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await buildStreak(executionProfileId, campaign.id, 2);
    const { deps, text } = cli(executionProfileId);

    await runFillCampaignCli(["status"], deps);

    const out = text();
    expect(out).toContain("Historical fill circuit:");
    expect(out).toContain("CLOSED");
    expect(out).toContain("TRANSIENT_TRANSPORT");
    expect(out).toContain("SERVER");
    // Not open, so no recovery instructions are offered.
    expect(out).not.toContain("execution:fill-circuit-acknowledge");
  });

  maybe()("shows an OPEN circuit beside a PAUSED campaign, with the next step", async () => {
    const executionProfileId = await makeProfile("cli-status-paused-open");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    const opened = await openCircuit(executionProfileId, campaign.id);
    expect(opened.pausedCampaignId).toBe(campaign.id);
    const { deps, text } = cli(executionProfileId);

    await runFillCampaignCli(["status"], deps);

    const out = text();
    expect(out).toContain("Live historical fill campaign:");
    expect(out).toContain("PAUSED");
    expect(out).toContain("OPEN");
    expect(out).toContain("HARD_CONFIGURATION");
    expect(out).toContain("execution:fill-circuit-acknowledge");
    expect(out).toContain("Acknowledging clears the latch only");
  });

  maybe()("shows an OPEN circuit beside an EXHAUSTED campaign", async () => {
    const executionProfileId = await makeProfile("cli-status-exhausted-open");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await prisma!.$executeRawUnsafe(
      `UPDATE "HistoricalFillCampaign" SET "status" = 'EXHAUSTED' WHERE "id" = $1`,
      campaign.id
    );
    await openCircuit(executionProfileId, campaign.id);
    const { deps, text } = cli(executionProfileId);

    await runFillCampaignCli(["status"], deps);

    const out = text();
    // EXHAUSTED is not live, so the campaign half says so -- and the circuit is
    // still reported underneath it.
    expect(out).toContain("No live historical fill campaign");
    expect(out).toContain("Historical fill circuit:");
    expect(out).toContain("OPEN");
  });

  maybe()("shows an OPEN circuit even with NO campaign to report", async () => {
    // THE CASE THAT MUST NOT EARLY-RETURN. An operator whose account stopped
    // and whose campaign was aborted has nothing else to look at.
    const executionProfileId = await makeProfile("cli-status-no-campaign-open");
    const seed = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await openCircuit(executionProfileId, seed.id);
    await campaigns.abortCampaign(seed.id);
    const { deps, text } = cli(executionProfileId);

    const result = await runFillCampaignCli(["status"], deps);

    expect(result.exitCode).toBe(CLI_EXIT.OK);
    const out = text();
    expect(out).toContain("No live historical fill campaign");
    expect(out).toContain("Historical fill circuit:");
    expect(out).toContain("OPEN");
    expect(out).toContain("execution:fill-circuit-acknowledge");
  });

  maybe()("prints no epoch counter and nothing secret-shaped", async () => {
    const executionProfileId = await makeProfile("cli-status-safety");
    const campaign = await campaigns.createCampaign({
      executionProfileId,
      maxDispatches: 10,
      note: "operator typed this",
    });
    await openCircuit(executionProfileId, campaign.id);
    const { deps, text } = cli(executionProfileId);

    await runFillCampaignCli(["status"], deps);

    const out = text();
    expect((await breakerRow(executionProfileId))!.generation).toBe(1);
    for (const forbidden of [
      "generation",
      executionProfileId,
      "operator typed this",
      "apiKey",
      "apiSecret",
      "BINANCE_API",
      "DATABASE_URL",
      "postgres://",
      "postgresql://",
      "redis://",
      "token",
    ]) {
      expect(out).not.toContain(forbidden);
    }
    // Classifications are not secrets and must still be visible.
    expect(out).toContain("HARD_CONFIGURATION");
    expect(out).toContain("AUTH");
  });
});

describe("acknowledgement clears the latch, and only the latch", () => {
  maybe()("OPEN + PAUSED: acknowledges, and the campaign STAYS paused", async () => {
    // The load-bearing operator flow. If this ever resumed the campaign, an
    // operator clearing a latch would silently put the account back to work.
    const executionProfileId = await makeProfile("ack-paused");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await openCircuit(executionProfileId, campaign.id);
    expect((await campaignRow(campaign.id)).status).toBe("PAUSED");
    const { deps, text } = cli(executionProfileId);

    const result = await runFillCampaignCli(["acknowledge-circuit"], deps);

    expect(result.exitCode).toBe(CLI_EXIT.OK);
    expect(text()).toContain("ACKNOWLEDGED and CLOSED");
    expect(text()).toContain("No campaign was started, resumed or changed");

    const row = await breakerRow(executionProfileId);
    expect(row!.state).toBe("CLOSED");
    expect(row!.openedAt).toBeNull();
    expect(row!.failureFamily).toBeNull();
    expect(row!.consecutiveCount).toBe(0);
    // The epoch is retained: it is what fences a late refund from reopening a
    // campaign after this acknowledgement.
    expect(row!.generation).toBe(1);

    // NOTHING RESUMED.
    expect((await campaignRow(campaign.id)).status).toBe("PAUSED");
    expect(
      await prisma!.historicalFillCampaign.count({ where: { executionProfileId, status: "ACTIVE" } })
    ).toBe(0);
  });

  maybe()("OPEN + EXHAUSTED: acknowledges, and the campaign STAYS exhausted", async () => {
    const executionProfileId = await makeProfile("ack-exhausted");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await prisma!.$executeRawUnsafe(
      `UPDATE "HistoricalFillCampaign" SET "status" = 'EXHAUSTED' WHERE "id" = $1`,
      campaign.id
    );
    await openCircuit(executionProfileId, campaign.id);
    const { deps } = cli(executionProfileId);

    const result = await runFillCampaignCli(["acknowledge-circuit"], deps);

    expect(result.exitCode).toBe(CLI_EXIT.OK);
    expect((await breakerRow(executionProfileId))!.state).toBe("CLOSED");
    expect((await campaignRow(campaign.id)).status).toBe("EXHAUSTED");
  });

  maybe()("ALREADY_CLOSED is an idempotent no-op, not an error", async () => {
    const executionProfileId = await makeProfile("ack-idempotent");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await openCircuit(executionProfileId, campaign.id);
    await runFillCampaignCli(["acknowledge-circuit"], cli(executionProfileId).deps);

    const { deps, text } = cli(executionProfileId);
    const result = await runFillCampaignCli(["acknowledge-circuit"], deps);

    expect(result.exitCode).toBe(CLI_EXIT.OK);
    expect(text()).toContain("already CLOSED");
    expect(text()).toContain("Nothing was changed");
    expect((await breakerRow(executionProfileId))!.generation).toBe(1);
  });

  maybe()("creates no breaker row when none exists", async () => {
    const executionProfileId = await makeProfile("ack-absent");
    const { deps, text } = cli(executionProfileId);

    const result = await runFillCampaignCli(["acknowledge-circuit"], deps);

    expect(result.exitCode).toBe(CLI_EXIT.OK);
    expect(text()).toContain("already CLOSED");
    // Acknowledging nothing must not manufacture something.
    expect(await breakerRow(executionProfileId)).toBeNull();
  });
});

describe("acknowledgement refuses what it must, and leaks nothing", () => {
  maybe()("REFUSES while an ACTIVE campaign exists beside an OPEN circuit", async () => {
    // Unreachable in ordinary operation -- opening pauses the ACTIVE campaign
    // in the same transaction -- so reaching it means something bypassed that.
    // Clearing the latch would expose runnable work to an uninvestigated fault.
    const executionProfileId = await makeProfile("ack-corrupt");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await openCircuit(executionProfileId, campaign.id);
    await prisma!.$executeRawUnsafe(
      `UPDATE "HistoricalFillCampaign" SET "status" = 'ACTIVE' WHERE "id" = $1`,
      campaign.id
    );
    const { deps, text } = cli(executionProfileId);

    const result = await runFillCampaignCli(["acknowledge-circuit"], deps);

    expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
    const out = text();
    expect(out).toContain("Refused:");
    expect(out).toContain("still OPEN and nothing was changed");
    // Not softened into ALREADY_CLOSED, and not repaired automatically.
    expect(out).not.toContain("already CLOSED");
    expect((await breakerRow(executionProfileId))!.state).toBe("OPEN");
    expect((await campaignRow(campaign.id)).status).toBe("ACTIVE");
    // No Prisma stack or connection string reached the operator.
    for (const forbidden of ["postgresql://", "PrismaClient", "at async", "DATABASE_URL"]) {
      expect(out).not.toContain(forbidden);
    }
  });

  maybe()("rejects every argument and flag, including a profile selector", async () => {
    const executionProfileId = await makeProfile("ack-args");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await openCircuit(executionProfileId, campaign.id);

    for (const argv of [
      ["--profile=other"],
      ["--execution-profile-id=abc"],
      ["--force"],
      ["--yes"],
      ["--campaign-id=whatever"],
      ["some-positional"],
    ]) {
      const { deps } = cli(executionProfileId);
      const result = await runFillCampaignCli(["acknowledge-circuit", ...argv], deps);
      expect(`${argv[0]}:${result.exitCode}`).toBe(`${argv[0]}:${CLI_EXIT.USAGE}`);
    }
    // Every refusal left the latch exactly as it was.
    expect((await breakerRow(executionProfileId))!.state).toBe("OPEN");
  });

  maybe()("fails closed when the configured profile cannot be bound", async () => {
    const executionProfileId = await makeProfile("ack-unbound");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await openCircuit(executionProfileId, campaign.id);
    const { deps, text } = cli(executionProfileId, true);

    const result = await runFillCampaignCli(["acknowledge-circuit"], deps);

    expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
    expect(text()).toContain("could not be bound");
    expect(text()).toContain("Nothing was changed");
    expect(text()).not.toContain(executionProfileId);
    expect((await breakerRow(executionProfileId))!.state).toBe("OPEN");
  });

  maybe()("prints no epoch counter on the recovery path either", async () => {
    const executionProfileId = await makeProfile("ack-no-generation");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await openCircuit(executionProfileId, campaign.id);
    const { deps, text } = cli(executionProfileId);

    await runFillCampaignCli(["acknowledge-circuit"], deps);

    const out = text();
    for (const forbidden of ["generation", executionProfileId, "postgresql://", "apiKey"]) {
      expect(out).not.toContain(forbidden);
    }
  });

  maybe()("after ack, status reports CLOSED with the streak cleared", async () => {
    const executionProfileId = await makeProfile("ack-then-status");
    const campaign = await campaigns.createCampaign({ executionProfileId, maxDispatches: 10 });
    await openCircuit(executionProfileId, campaign.id);
    await runFillCampaignCli(["acknowledge-circuit"], cli(executionProfileId).deps);

    const { deps, text } = cli(executionProfileId);
    await runFillCampaignCli(["status"], deps);

    const out = text();
    expect(out).toContain("Historical fill circuit:");
    expect(out).toContain("CLOSED");
    expect(out).not.toContain("HARD_CONFIGURATION");
    // The campaign is where the latch left it, and resuming stays separate.
    expect(out).toContain("PAUSED");
    expect(out).not.toContain("execution:fill-circuit-acknowledge");
  });
});
