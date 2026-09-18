import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";
import {
  CLI_EXIT,
  abortCommand,
  pauseCommand,
  resumeCommand,
  runFillCampaignCli,
  startCommand,
  statusCommand,
  type FillCampaignCliDependencies,
} from "../src/modules/execution/fill-campaign-cli";
import { HistoricalFillCampaignService } from "../src/modules/execution/historical-fill-campaign.service";
import { HistoricalFillCircuitBreakerService } from "../src/modules/execution/historical-fill-circuit-breaker.service";

/**
 * The operator boundary for bounded backfills, against a REAL Postgres.
 *
 * The decision this CLI fronts is an authorisation to spend a real account's
 * exchange allowance, so the boundary carries three guarantees and each is
 * pinned here:
 *
 *   1. starting requires an explicit ceiling — there is no default, and no
 *      value outside 1..100 is accepted;
 *   2. a lifecycle command cannot land on a campaign the operator did not mean,
 *      including one belonging to another profile;
 *   3. nothing it prints is a credential, an account identifier, or the
 *      operator's own free-text note.
 *
 * The campaign service and the database are real; only the profile binder is
 * injected, because the real one reads process configuration that cannot name
 * a synthetic profile. No exchange client exists in this file.
 */

const TAG = "fill-campaign-cli-synthetic";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const maybe = () => (available ? it : it.skip);

async function makeProfile(suffix: string): Promise<string> {
  const profile = await prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${suffix}`,
      exchange: "BINANCE",
      product: "USD_M_FUTURES",
      environment: "TESTNET",
      accountIdentifier: `${TAG}-SECRET-ACCOUNT-${suffix}-${Date.now()}`,
    },
    select: { id: true },
  });
  return profile.id;
}

/** Captures output instead of writing to a terminal, so it can be asserted on. */
function cli(executionProfileId: string) {
  const printed: string[] = [];
  const deps: FillCampaignCliDependencies = {
    prisma: prisma!,
    campaigns: new HistoricalFillCampaignService(prisma!),
    // The real breaker service. Status reads it and acknowledge writes it, so a
    // stub here would prove nothing about either.
    circuit: new HistoricalFillCircuitBreakerService(prisma!),
    bindProfile: async () => ({ ok: true, context: { executionProfileId } }) as never,
    out: (line) => printed.push(line),
  };
  return { deps, printed, text: () => printed.join("\n") };
}

beforeAll(async () => {
  if (!prisma || !available) return;
});

afterAll(async () => {
  if (prisma && available) {
    await prisma.historicalFillWeightReservation.deleteMany({
      where: { campaign: { executionProfile: { name: { startsWith: TAG } } } },
    });
    await prisma.historicalFillCampaign.deleteMany({
      where: { executionProfile: { name: { startsWith: TAG } } },
    });
    await prisma.executionProfile.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.$disconnect();
  }
});

describe("start demands an explicit ceiling", () => {
  maybe()("refuses with no --max-dispatches, and says there is no default", async () => {
    const executionProfileId = await makeProfile("start-missing");
    const { deps, text } = cli(executionProfileId);

    const result = await startCommand([], deps);

    expect(result.exitCode).toBe(CLI_EXIT.USAGE);
    expect(text()).toContain("has no default");
    expect(
      await prisma!.historicalFillCampaign.count({ where: { executionProfileId } })
    ).toBe(0);
  });

  maybe().each(["0", "-1", "101", "1000", "2.5", "abc", ""])(
    "refuses --max-dispatches=%s and creates nothing",
    async (value) => {
      const executionProfileId = await makeProfile(`start-bad-${value || "empty"}`);
      const { deps } = cli(executionProfileId);

      const result = await startCommand([`--max-dispatches=${value}`], deps);

      expect(result.exitCode).not.toBe(CLI_EXIT.OK);
      expect(
        await prisma!.historicalFillCampaign.count({ where: { executionProfileId } })
      ).toBe(0);
    }
  );

  maybe().each(["1", "50", "100"])("accepts --max-dispatches=%s and opens it ACTIVE", async (value) => {
    const executionProfileId = await makeProfile(`start-ok-${value}`);
    const { deps, text } = cli(executionProfileId);

    const result = await startCommand([`--max-dispatches=${value}`], deps);

    expect(result.exitCode).toBe(CLI_EXIT.OK);
    const campaign = await prisma!.historicalFillCampaign.findFirstOrThrow({
      where: { executionProfileId },
    });
    expect(campaign.status).toBe("ACTIVE");
    expect(campaign.maxDispatches).toBe(Number(value));
    expect(campaign.dispatchesUsed).toBe(0);
    expect(text()).toContain("Historical fill campaign started.");
  });

  maybe().each(["ACTIVE", "PAUSED"])("refuses a second campaign while one is %s", async (status) => {
    const executionProfileId = await makeProfile(`start-second-${status}`);
    const { deps } = cli(executionProfileId);
    await startCommand(["--max-dispatches=5"], deps);
    if (status === "PAUSED") await pauseCommand([], deps);

    const second = await startCommand(["--max-dispatches=5"], deps);

    expect(second.exitCode).toBe(CLI_EXIT.REFUSED);
    expect(
      await prisma!.historicalFillCampaign.count({ where: { executionProfileId } })
    ).toBe(1);
  });
});

describe("lifecycle commands act only on what the operator meant", () => {
  maybe()("pause then resume moves the live campaign and nothing else", async () => {
    const executionProfileId = await makeProfile("lifecycle");
    const { deps } = cli(executionProfileId);
    await startCommand(["--max-dispatches=5"], deps);

    expect((await pauseCommand([], deps)).exitCode).toBe(CLI_EXIT.OK);
    let campaign = await prisma!.historicalFillCampaign.findFirstOrThrow({
      where: { executionProfileId },
    });
    expect(campaign.status).toBe("PAUSED");

    expect((await resumeCommand([], deps)).exitCode).toBe(CLI_EXIT.OK);
    campaign = await prisma!.historicalFillCampaign.findFirstOrThrow({ where: { executionProfileId } });
    expect(campaign.status).toBe("ACTIVE");
  });

  maybe()("abort ends the live campaign", async () => {
    const executionProfileId = await makeProfile("abort");
    const { deps } = cli(executionProfileId);
    await startCommand(["--max-dispatches=5"], deps);

    expect((await abortCommand([], deps)).exitCode).toBe(CLI_EXIT.OK);
    const campaign = await prisma!.historicalFillCampaign.findFirstOrThrow({
      where: { executionProfileId },
    });
    expect(campaign.status).toBe("ABORTED");
    expect(campaign.endedAt).toBeInstanceOf(Date);
  });

  maybe().each(["pause", "resume", "abort"])(
    "%s refuses when the profile has no live campaign, rather than reaching for a terminal one",
    async (verb) => {
      // The load-bearing refusal: an abort landing on a campaign that already
      // ended would look like success while the thing the operator meant to
      // stop kept running.
      const executionProfileId = await makeProfile(`no-live-${verb}`);
      const { deps, text } = cli(executionProfileId);
      await startCommand(["--max-dispatches=5"], deps);
      await abortCommand([], deps);

      const command = { pause: pauseCommand, resume: resumeCommand, abort: abortCommand }[verb]!;
      const result = await command([], deps);

      expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
      expect(text()).toContain("no live campaign");
      const campaign = await prisma!.historicalFillCampaign.findFirstOrThrow({
        where: { executionProfileId },
      });
      expect(campaign.status).toBe("ABORTED");
    }
  );

  maybe()("refuses an explicit campaign id belonging to a different profile", async () => {
    const mine = await makeProfile("mine");
    const theirs = await makeProfile("theirs");
    const theirCli = cli(theirs);
    await startCommand(["--max-dispatches=5"], theirCli.deps);
    const theirCampaign = await prisma!.historicalFillCampaign.findFirstOrThrow({
      where: { executionProfileId: theirs },
    });

    const { deps, text } = cli(mine);
    const result = await abortCommand([`--campaign-id=${theirCampaign.id}`], deps);

    expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
    expect(text()).toContain("different execution profile");
    expect(
      (await prisma!.historicalFillCampaign.findUniqueOrThrow({ where: { id: theirCampaign.id } }))
        .status
    ).toBe("ACTIVE");
  });

  maybe().each(["EXHAUSTED", "COMPLETED", "ABORTED"])(
    "a %s campaign cannot be resumed even when named explicitly",
    async (status) => {
      const executionProfileId = await makeProfile(`no-resume-${status}`);
      const { deps, text } = cli(executionProfileId);
      await startCommand(["--max-dispatches=5"], deps);
      const campaign = await prisma!.historicalFillCampaign.findFirstOrThrow({
        where: { executionProfileId },
      });
      await prisma!.$executeRawUnsafe(
        `UPDATE "HistoricalFillCampaign" SET "status" = $1::"HistoricalFillCampaignStatus" WHERE "id" = $2`,
        status,
        campaign.id
      );

      const result = await resumeCommand([`--campaign-id=${campaign.id}`], deps);

      expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
      expect(text()).toContain("Refused");
      expect(
        (await prisma!.historicalFillCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status
      ).toBe(status);
    }
  );

  maybe()("refuses an unknown campaign id", async () => {
    const executionProfileId = await makeProfile("unknown-id");
    const { deps } = cli(executionProfileId);
    const result = await pauseCommand(["--campaign-id=no-such-campaign"], deps);
    expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
  });
});

describe("status reads and never writes", () => {
  maybe()("says plainly when there is no live campaign", async () => {
    const executionProfileId = await makeProfile("status-none");
    const { deps, text } = cli(executionProfileId);

    const result = await statusCommand([], deps);

    expect(result.exitCode).toBe(CLI_EXIT.OK);
    expect(text()).toContain("No live historical fill campaign");
  });

  maybe()("shows the live campaign and changes nothing", async () => {
    const executionProfileId = await makeProfile("status-live");
    const { deps, text } = cli(executionProfileId);
    await startCommand(["--max-dispatches=7", "--note=backfilling september"], deps);
    const before = await prisma!.historicalFillCampaign.findFirstOrThrow({
      where: { executionProfileId },
    });

    const result = await statusCommand([], deps);

    expect(result.exitCode).toBe(CLI_EXIT.OK);
    expect(text()).toContain(before.id);
    expect(text()).toContain("ACTIVE");
    expect(text()).toContain("0 of 7");
    const after = await prisma!.historicalFillCampaign.findFirstOrThrow({
      where: { executionProfileId },
    });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  maybe()("never prints a credential, an account identifier, or the operator's note", async () => {
    // The note is free text somebody typed at a terminal; the account
    // identifier names a real exchange account. Neither belongs in output that
    // gets pasted into a ticket.
    const executionProfileId = await makeProfile("status-safe");
    const { deps, text } = cli(executionProfileId);
    await startCommand(["--max-dispatches=3", "--note=SECRET-OPERATOR-NOTE"], deps);
    await statusCommand([], deps);

    const printed = text();
    expect(printed).not.toContain("SECRET-OPERATOR-NOTE");
    expect(printed).not.toContain("SECRET-ACCOUNT");
    expect(printed).not.toMatch(/postgres(ql)?:\/\//);
    expect(printed).not.toMatch(/redis:\/\//);
    for (const forbidden of ["apiKey", "apiSecret", "BINANCE_API", "DATABASE_URL", "token"]) {
      expect(printed).not.toContain(forbidden);
    }
  });

  maybe()("the same holds for every other command's output", async () => {
    const executionProfileId = await makeProfile("all-safe");
    const { deps, text } = cli(executionProfileId);
    await startCommand(["--max-dispatches=3", "--note=SECRET-OPERATOR-NOTE"], deps);
    await pauseCommand([], deps);
    await resumeCommand([], deps);
    await abortCommand(["--note=SECOND-SECRET-NOTE"], deps);

    const printed = text();
    expect(printed).not.toContain("SECRET-OPERATOR-NOTE");
    expect(printed).not.toContain("SECOND-SECRET-NOTE");
    expect(printed).not.toContain("SECRET-ACCOUNT");
  });
});

describe("the dispatcher", () => {
  maybe()("routes each subcommand and rejects anything else", async () => {
    const executionProfileId = await makeProfile("dispatch");
    const { deps, text } = cli(executionProfileId);

    expect((await runFillCampaignCli(["status"], deps)).exitCode).toBe(CLI_EXIT.OK);
    expect((await runFillCampaignCli(["start", "--max-dispatches=2"], deps)).exitCode).toBe(
      CLI_EXIT.OK
    );
    expect((await runFillCampaignCli(["pause"], deps)).exitCode).toBe(CLI_EXIT.OK);
    expect((await runFillCampaignCli(["resume"], deps)).exitCode).toBe(CLI_EXIT.OK);
    expect((await runFillCampaignCli(["abort"], deps)).exitCode).toBe(CLI_EXIT.OK);

    expect((await runFillCampaignCli(["destroy-everything"], deps)).exitCode).toBe(CLI_EXIT.USAGE);
    expect((await runFillCampaignCli([], deps)).exitCode).toBe(CLI_EXIT.USAGE);
    expect(text()).toContain("Usage:");
  });

  maybe()("rejects an unrecognised flag rather than ignoring it", async () => {
    // A silently ignored --force would be the worst possible failure mode here.
    const executionProfileId = await makeProfile("unknown-flag");
    const { deps } = cli(executionProfileId);
    expect((await startCommand(["--max-dispatches=2", "--force"], deps)).exitCode).toBe(
      CLI_EXIT.USAGE
    );
    expect((await pauseCommand(["--force"], deps)).exitCode).toBe(CLI_EXIT.USAGE);
  });
});
