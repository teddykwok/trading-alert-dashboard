import { describe, expect, it, vi } from "vitest";

import { FillIngestHorizonRefusedError } from "../src/modules/execution/exchange-fill-day-roots";
import {
  FillRootBootstrapInvariantError,
  FillRootRaceUnresolvedError,
  FillRootStructuralOverlapError,
  type FillRootBootstrapResult,
} from "../src/modules/execution/exchange-fill-root-bootstrap.service";
import { ExecutionSymbolLineageError } from "../src/modules/execution/exchange-fill-symbol-universe";
import {
  BOOTSTRAP_CLI_EXIT,
  runFillBootstrapCli,
  type FillBootstrapCliDependencies,
} from "../src/modules/execution/fill-bootstrap-cli";

/**
 * The operator boundary of the standalone root bootstrap, without a database.
 *
 * What is proved here is the CONTRACT: that the command takes nothing, that the
 * horizon cannot be chosen from a terminal, that the bound account is never
 * printed, and that a refusal reports a code instead of a message. The durable
 * effects are proved against real Postgres in the integration suite, and the
 * absence of a request-capable graph is proved structurally.
 */

const PROFILE_ID = "clxbootstrapprofile000000001";
const NOW = new Date("2026-09-18T09:15:00.000Z");

const BOOTSTRAPPED: FillRootBootstrapResult = {
  outcome: "BOOTSTRAPPED",
  executionProfileId: PROFILE_ID,
  horizonDays: 3,
  symbolCount: 500,
  dayCount: 3,
  expectedRootCount: 1500,
  alreadyCompatibleCount: 1000,
  createdCount: 500,
  raceReconciledCount: 0,
};

/** The CLI, its output captured, over a bootstrap that answers on cue. */
function cli(
  answer: FillRootBootstrapResult | Error,
  overrides: Partial<FillBootstrapCliDependencies> = {}
) {
  const lines: string[] = [];
  const bootstrapHistoricalRoots = vi.fn(async () =>
    answer instanceof Error ? Promise.reject(answer) : answer
  );
  const deps: FillBootstrapCliDependencies = {
    bootstrap: { bootstrapHistoricalRoots },
    horizonDays: 3,
    now: () => NOW,
    out: (line) => lines.push(line),
    ...overrides,
  };
  return { deps, lines, bootstrapHistoricalRoots };
}

/** The labels of a printed summary, in order, without their values. */
const labelsOf = (lines: string[]) =>
  lines
    .filter((line) => line.startsWith("  "))
    .map((line) => line.trim().replace(/\s{2,}.*$/, ""));

describe("the bootstrap command takes no arguments", () => {
  // Each of these is a flag somebody might reach for to aim this command at a
  // different account, or to widen what it materializes. None may be ignored.
  const REJECTED = [
    ["--profile=other", "a profile selector"],
    ["--execution-profile-id=clx000", "an explicit profile id"],
    ["--account=9912345", "an account selector"],
    ["--force", "a force flag"],
    ["--horizon-days=60", "a horizon override"],
    ["--max-dispatches=1", "a campaign flag borrowed from the sibling CLI"],
    ["status", "a positional subcommand"],
  ] as const;

  for (const [argument, description] of REJECTED) {
    it(`refuses ${description} with a usage failure and never bootstraps`, async () => {
      const { deps, lines, bootstrapHistoricalRoots } = cli(BOOTSTRAPPED);

      const result = await runFillBootstrapCli([argument], deps);

      expect(result.exitCode).toBe(BOOTSTRAP_CLI_EXIT.USAGE);
      // The decisive half: a rejected invocation writes nothing, because the
      // one method that can write was never reached.
      expect(bootstrapHistoricalRoots).not.toHaveBeenCalled();
      expect(lines.join("\n")).toContain("Takes NO arguments");
    });
  }

  it("runs on a completely empty argv", async () => {
    const { deps, bootstrapHistoricalRoots } = cli(BOOTSTRAPPED);

    const result = await runFillBootstrapCli([], deps);

    expect(result.exitCode).toBe(BOOTSTRAP_CLI_EXIT.OK);
    expect(bootstrapHistoricalRoots).toHaveBeenCalledTimes(1);
  });
});

describe("the horizon comes from configuration, never from the terminal", () => {
  it("passes the configured horizon and the injected clock straight through", async () => {
    const { deps, bootstrapHistoricalRoots } = cli(BOOTSTRAPPED, { horizonDays: 3 });

    await runFillBootstrapCli([], deps);

    expect(bootstrapHistoricalRoots).toHaveBeenCalledWith({ now: NOW, horizonDays: 3 });
  });

  // 1, 3 and 60 are the configured boundary values the env schema admits. The
  // CLI adds no second opinion about any of them -- it forwards what it is
  // given, and the generator refuses what the generator refuses.
  for (const horizonDays of [1, 3, 60]) {
    it(`forwards a configured horizon of ${horizonDays} unchanged`, async () => {
      const { deps, bootstrapHistoricalRoots } = cli(
        { ...BOOTSTRAPPED, horizonDays },
        { horizonDays }
      );

      const result = await runFillBootstrapCli([], deps);

      expect(result.exitCode).toBe(BOOTSTRAP_CLI_EXIT.OK);
      expect(bootstrapHistoricalRoots).toHaveBeenCalledWith({ now: NOW, horizonDays });
    });
  }
});

describe("the printed summary is an exact, safe field set", () => {
  it("prints the eight bootstrap fields and nothing else", async () => {
    const { deps, lines } = cli(BOOTSTRAPPED);

    const result = await runFillBootstrapCli([], deps);

    expect(result.exitCode).toBe(BOOTSTRAP_CLI_EXIT.OK);
    // EXACT, not "contains": a field added by a future spread would fail here
    // before anybody had to notice it in a terminal.
    expect(labelsOf(lines)).toEqual([
      "outcome",
      "horizon days",
      "symbols",
      "days",
      "expected roots",
      "already compatible",
      "created",
      "race reconciled",
    ]);
    expect(lines[0]).toBe("historical root bootstrap");
  });

  it("prints the counts it was given", async () => {
    const { deps, lines } = cli(BOOTSTRAPPED);

    await runFillBootstrapCli([], deps);
    const text = lines.join("\n");

    expect(text).toContain("outcome              BOOTSTRAPPED");
    expect(text).toContain("expected roots       1500");
    expect(text).toContain("already compatible   1000");
    expect(text).toContain("created              500");
    expect(text).toContain("race reconciled      0");
  });

  it("never prints the bound execution profile id", async () => {
    const { deps, lines } = cli(BOOTSTRAPPED);

    await runFillBootstrapCli([], deps);

    // The service result carries it; the operator surface must not.
    expect(BOOTSTRAPPED).toHaveProperty("executionProfileId", PROFILE_ID);
    expect(lines.join("\n")).not.toContain(PROFILE_ID);
  });
});

describe("an unbound profile refuses without bootstrapping anything", () => {
  it("reports the binder's own reason code and exits REFUSED", async () => {
    const { deps, lines } = cli({
      outcome: "PROFILE_UNAVAILABLE",
      reasonCode: "PROFILE_POLICY_MISSING" as never,
    });

    const result = await runFillBootstrapCli([], deps);

    expect(result.exitCode).toBe(BOOTSTRAP_CLI_EXIT.REFUSED);
    expect(labelsOf(lines)).toEqual(["outcome", "reason"]);
    expect(lines.join("\n")).toContain("PROFILE_UNAVAILABLE");
    expect(lines.join("\n")).toContain("PROFILE_POLICY_MISSING");
  });

  it("prints no count fields at all for an unavailable profile", async () => {
    const { deps, lines } = cli({
      outcome: "PROFILE_UNAVAILABLE",
      reasonCode: "PROFILE_NOT_FOUND" as never,
    });

    await runFillBootstrapCli([], deps);

    expect(labelsOf(lines)).not.toContain("created");
    expect(labelsOf(lines)).not.toContain("expected roots");
  });
});

describe("refusals report a code, never a message", () => {
  // Three of these four embed the bound execution profile id in their message
  // text, so printing `error.message` would leak the account on the very path
  // an operator is most likely to paste into a ticket.
  const REFUSALS = [
    [
      new FillRootStructuralOverlapError(PROFILE_ID, [
        {
          symbol: "SKYUSDT",
          desired: { startTimeMs: 1, endTimeMs: 2 },
          overlaps: [],
        },
      ]),
      "FILL_ROOT_STRUCTURAL_OVERLAP",
    ],
    [
      new FillRootRaceUnresolvedError(PROFILE_ID, "SKYUSDT", { startTimeMs: 1, endTimeMs: 2 }),
      "FILL_ROOT_RACE_UNRESOLVED",
    ],
    [new FillIngestHorizonRefusedError("horizon 61 exceeds the maximum"), "FILL_INGEST_HORIZON_REFUSED"],
    [
      new ExecutionSymbolLineageError(PROFILE_ID, ["not a symbol"]),
      "EXECUTION_SYMBOL_LINEAGE_INVALID",
    ],
  ] as const;

  for (const [error, reasonCode] of REFUSALS) {
    it(`reports ${reasonCode} without its message`, async () => {
      const { deps, lines } = cli(error as Error);

      const result = await runFillBootstrapCli([], deps);
      const text = lines.join("\n");

      expect(result.exitCode).toBe(BOOTSTRAP_CLI_EXIT.REFUSED);
      expect(labelsOf(lines)).toEqual(["outcome", "reason"]);
      expect(text).toContain(reasonCode);
      expect(text).not.toContain(PROFILE_ID);
      expect(text).not.toContain((error as Error).message);
    });
  }

  it("re-throws an unclassified failure instead of flattening it to a refusal", async () => {
    // A counting bug is not a refusal. Swallowing it here would report a clean
    // exit for a fault nobody has classified.
    const { deps } = cli(new FillRootBootstrapInvariantError("expected 3 roots but accounted for 2"));

    await expect(runFillBootstrapCli([], deps)).rejects.toBeInstanceOf(
      FillRootBootstrapInvariantError
    );
  });
});

describe("no output on any path resembles a secret", () => {
  const FORBIDDEN = [
    /postgres(ql)?:\/\//i,
    /redis:\/\//i,
    /\bDATABASE_URL\b/,
    /\bBINANCE_API_(KEY|SECRET)\b/,
    /[A-Za-z0-9]{40,}/,
  ];

  it("emits nothing matching a credential shape, on success or refusal", async () => {
    const answers: Array<FillRootBootstrapResult | Error> = [
      BOOTSTRAPPED,
      { outcome: "PROFILE_UNAVAILABLE", reasonCode: "PROFILE_POLICY_MISSING" as never },
      new FillRootRaceUnresolvedError(PROFILE_ID, "SKYUSDT", { startTimeMs: 1, endTimeMs: 2 }),
    ];

    for (const answer of answers) {
      const { deps, lines } = cli(answer);
      await runFillBootstrapCli([], deps);
      const text = lines.join("\n");
      for (const pattern of FORBIDDEN) {
        expect(text).not.toMatch(pattern);
      }
    }
  });

  it("emits usage text free of any credential shape", async () => {
    const { deps, lines } = cli(BOOTSTRAPPED);
    await runFillBootstrapCli(["--profile=x"], deps);
    for (const pattern of FORBIDDEN) {
      expect(lines.join("\n")).not.toMatch(pattern);
    }
  });
});

describe("the dependency surface is one method wide", () => {
  it("accepts a bootstrap exposing nothing but bootstrapHistoricalRoots", async () => {
    // Not decoration: this object is the ENTIRE capability the command is given.
    // It holds no Prisma client, so the CLI cannot read or write any table
    // itself, and no campaign, weight, breaker, executor or reader collaborator
    // exists for it to reach.
    const bootstrap = { bootstrapHistoricalRoots: vi.fn(async () => BOOTSTRAPPED) };
    expect(Object.keys(bootstrap)).toEqual(["bootstrapHistoricalRoots"]);

    const result = await runFillBootstrapCli([], {
      bootstrap,
      horizonDays: 3,
      now: () => NOW,
      out: () => {},
    });

    expect(result.exitCode).toBe(BOOTSTRAP_CLI_EXIT.OK);
  });
});
