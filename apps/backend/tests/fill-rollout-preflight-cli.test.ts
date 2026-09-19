import { describe, expect, it, vi } from "vitest";

import {
  PREFLIGHT_CLI_EXIT,
  blockersFor,
  projectRollout,
  runFillRolloutPreflightCli,
  type PreflightCliDependencies,
  type PreflightConfig,
  type PreflightState,
} from "../src/modules/execution/fill-rollout-preflight-cli";

/**
 * The operator boundary of the rollout preflight, without a database.
 *
 * What is proved here is the CONTRACT: the command takes nothing, every gate
 * refuses independently, the projections are the minimum of EVERY restrictive
 * factor, and nothing that reaches a terminal identifies the bound account.
 */

const PROFILE_ID = "clxpreflightprofile000000001";

/** A configuration that satisfies every configuration-side gate. */
const READY_CONFIG: PreflightConfig = {
  runtimeEnabled: true,
  horizonDays: 3,
  horizonSource: "EXPLICIT",
  intervalSeconds: 60,
  maxWindowsPerTick: 5,
  maxUserTradesWeightPerTick: 25,
  sharedUserTradesWeightPerMinute: 5,
  userTradesWeightPerRequest: 5,
};

/** Durable state that satisfies every database-side gate. */
const READY_STATE: PreflightState = {
  symbolUniverseCount: 500,
  pendingTotal: 1993,
  pendingClaimableNow: 1993,
  pendingOutsideHorizon: 499,
  oldestPendingUtcDay: "2026-09-15",
  campaignStatus: "ACTIVE",
  campaignMaxDispatches: 1,
  campaignDispatchesUsed: 0,
  circuitState: "CLOSED",
  attemptExhaustedCount: 0,
};

function cli(
  config: PreflightConfig = READY_CONFIG,
  state: PreflightState = READY_STATE,
  overrides: Partial<PreflightCliDependencies> = {}
) {
  const lines: string[] = [];
  const readState = vi.fn(async () => state);
  const deps: PreflightCliDependencies = {
    prisma: {} as never,
    config,
    readState,
    bindProfile: async () =>
      ({ ok: true, context: { executionProfileId: PROFILE_ID, environment: "TESTNET" } }) as never,
    out: (line) => lines.push(line),
    ...overrides,
  };
  return { deps, lines, readState };
}

const labelsOf = (lines: string[]) =>
  lines.filter((line) => line.startsWith("  ")).map((line) => line.trim().replace(/\s{2,}.*$/, ""));

describe("the preflight takes no arguments", () => {
  const REJECTED = [
    "--profile=other", "--profile-id=x", "--execution-profile-id=x",
    "--account=9912345", "--account-id=9912345", "--force", "--confirm",
    "--window-id=cmu1", "--limit=10", "--horizon=3", "--weight-cap=5",
    "--campaign-id=abc", "--anything", "status",
  ];

  for (const argument of REJECTED) {
    it(`refuses ${argument} and reads no state`, async () => {
      const { deps, lines, readState } = cli();

      const result = await runFillRolloutPreflightCli([argument], deps);

      expect(result.exitCode).toBe(PREFLIGHT_CLI_EXIT.USAGE);
      // A rejected invocation reaches no database read and renders no verdict.
      expect(readState).not.toHaveBeenCalled();
      expect(lines.join("\n")).toContain("Takes NO arguments");
    });
  }

  it("runs on a completely empty argv and exits READY", async () => {
    const { deps, readState } = cli();

    const result = await runFillRolloutPreflightCli([], deps);

    expect(result.exitCode).toBe(PREFLIGHT_CLI_EXIT.READY);
    expect(readState).toHaveBeenCalledTimes(1);
    expect(readState).toHaveBeenCalledWith(PROFILE_ID);
  });
});

describe("every gate blocks independently", () => {
  const CONFIG_CASES: ReadonlyArray<readonly [Partial<PreflightConfig>, string, string]> = [
    [{ runtimeEnabled: false }, "RUNTIME_DISABLED", "the runtime is still off"],
    [{ horizonSource: "DEFAULT" }, "HORIZON_DEFAULTED", "nobody chose the horizon"],
    [
      { sharedUserTradesWeightPerMinute: undefined },
      "SHARED_WEIGHT_CAP_MISSING",
      "no shared ceiling is configured",
    ],
  ];

  for (const [patch, blocker, description] of CONFIG_CASES) {
    it(`blocks when ${description}`, async () => {
      const { deps, lines } = cli({ ...READY_CONFIG, ...patch });

      const result = await runFillRolloutPreflightCli([], deps);

      expect(result.exitCode).toBe(PREFLIGHT_CLI_EXIT.BLOCKED);
      expect(lines.join("\n")).toContain(blocker);
      expect(lines.join("\n")).toContain("outcome                          BLOCKED");
    });
  }

  const STATE_CASES: ReadonlyArray<readonly [Partial<PreflightState>, string, string]> = [
    [{ campaignStatus: null }, "NO_ACTIVE_CAMPAIGN", "no campaign exists"],
    [{ campaignStatus: "PAUSED" }, "NO_ACTIVE_CAMPAIGN", "the campaign is paused"],
    [{ campaignStatus: "EXHAUSTED" }, "NO_ACTIVE_CAMPAIGN", "the campaign is exhausted"],
    [{ campaignStatus: "ABORTED" }, "NO_ACTIVE_CAMPAIGN", "the campaign is aborted"],
    [{ campaignStatus: "COMPLETED" }, "NO_ACTIVE_CAMPAIGN", "the campaign is completed"],
    [
      { campaignDispatchesUsed: 1, campaignMaxDispatches: 1 },
      "CAMPAIGN_BUDGET_EXHAUSTED",
      "an ACTIVE campaign has no remaining budget",
    ],
    [{ circuitState: "OPEN" }, "CIRCUIT_OPEN", "the circuit is open"],
    [
      { attemptExhaustedCount: 1 },
      "ATTEMPT_EXHAUSTED_WINDOWS_PRESENT",
      "an unclaimable exhausted window remains",
    ],
  ];

  for (const [patch, blocker, description] of STATE_CASES) {
    it(`blocks when ${description}`, async () => {
      const { deps, lines } = cli(READY_CONFIG, { ...READY_STATE, ...patch });

      const result = await runFillRolloutPreflightCli([], deps);

      expect(result.exitCode).toBe(PREFLIGHT_CLI_EXIT.BLOCKED);
      expect(lines.join("\n")).toContain(blocker);
    });
  }

  it("reports EVERY failing gate at once, not just the first", async () => {
    const { deps, lines } = cli(
      { ...READY_CONFIG, runtimeEnabled: false, horizonSource: "DEFAULT" },
      { ...READY_STATE, circuitState: "OPEN", attemptExhaustedCount: 4 }
    );

    await runFillRolloutPreflightCli([], deps);
    const text = lines.join("\n");

    for (const blocker of [
      "RUNTIME_DISABLED",
      "HORIZON_DEFAULTED",
      "CIRCUIT_OPEN",
      "ATTEMPT_EXHAUSTED_WINDOWS_PRESENT",
    ]) {
      expect(text).toContain(blocker);
    }
  });

  it("blocks and reads no state when the profile cannot be bound", async () => {
    const { deps, lines, readState } = cli(READY_CONFIG, READY_STATE, {
      bindProfile: async () => ({ ok: false, reasonCode: "PROFILE_NOT_FOUND" }) as never,
    });

    const result = await runFillRolloutPreflightCli([], deps);

    expect(result.exitCode).toBe(PREFLIGHT_CLI_EXIT.BLOCKED);
    expect(readState).not.toHaveBeenCalled();
    expect(labelsOf(lines)).toEqual(["outcome", "blocker", "reason"]);
    expect(lines.join("\n")).toContain("PROFILE_UNAVAILABLE");
  });

  it("is READY only when every gate passes, and exits 0", async () => {
    const { deps, lines } = cli();

    const result = await runFillRolloutPreflightCli([], deps);

    expect(result.exitCode).toBe(PREFLIGHT_CLI_EXIT.READY);
    expect(blockersFor(READY_CONFIG, READY_STATE)).toEqual([]);
    expect(lines.join("\n")).toContain("outcome                          READY");
    expect(labelsOf(lines)).not.toContain("blocker");
  });
});

describe("the backlog fields report and never judge", () => {
  // B6. The verdict must depend on exactly the seven pre-existing gates.
  const BACKLOGS: ReadonlyArray<readonly [string, Partial<PreflightState>]> = [
    ["no pending work at all", { pendingTotal: 0, pendingClaimableNow: 0, pendingOutsideHorizon: 0, oldestPendingUtcDay: null }],
    ["everything inside the horizon", { pendingTotal: 1500, pendingClaimableNow: 1500, pendingOutsideHorizon: 0, oldestPendingUtcDay: "2026-09-16" }],
    ["a large backlog entirely outside the horizon", { pendingTotal: 15000, pendingClaimableNow: 15000, pendingOutsideHorizon: 15000, oldestPendingUtcDay: "2026-08-20" }],
    ["a backlog none of which is claimable right now", { pendingTotal: 900, pendingClaimableNow: 0, pendingOutsideHorizon: 900, oldestPendingUtcDay: "2026-09-01" }],
  ];

  for (const [description, patch] of BACKLOGS) {
    it(`stays READY with ${description}`, async () => {
      const state = { ...READY_STATE, ...patch };
      const { deps, lines } = cli(READY_CONFIG, state);

      const result = await runFillRolloutPreflightCli([], deps);

      expect(result.exitCode).toBe(PREFLIGHT_CLI_EXIT.READY);
      expect(blockersFor(READY_CONFIG, state)).toEqual([]);
      expect(labelsOf(lines)).not.toContain("blocker");
    });

    it(`stays BLOCKED for the same single reason with ${description}`, async () => {
      // One pre-existing blocker, and the backlog must neither add nor mask one.
      const state = { ...READY_STATE, ...patch, circuitState: "OPEN" };
      const { deps } = cli(READY_CONFIG, state);

      const result = await runFillRolloutPreflightCli([], deps);

      expect(result.exitCode).toBe(PREFLIGHT_CLI_EXIT.BLOCKED);
      expect(blockersFor(READY_CONFIG, state)).toEqual(["CIRCUIT_OPEN"]);
    });
  }

  it("renders an absent oldest pending day as the null marker", async () => {
    const { deps, lines } = cli(READY_CONFIG, {
      ...READY_STATE, pendingTotal: 0, pendingClaimableNow: 0,
      pendingOutsideHorizon: 0, oldestPendingUtcDay: null,
    });

    await runFillRolloutPreflightCli([], deps);

    expect(lines.join("\n")).toContain("oldest pending UTC day           \u2014");
    expect(lines.join("\n")).toContain("pending total                    0");
  });

  it("prints the backlog it was given, verbatim", async () => {
    const { deps, lines } = cli();

    await runFillRolloutPreflightCli([], deps);
    const text = lines.join("\n");

    expect(text).toContain("pending total                    1993");
    expect(text).toContain("pending claimable now            1993");
    expect(text).toContain("pending outside current horizon  499");
    expect(text).toContain("oldest pending UTC day           2026-09-15");
  });
});

describe("an explicit horizon and a defaulted one are different answers", () => {
  it("refuses a DEFAULTED 30 even though 30 is a legal value", async () => {
    const { deps, lines } = cli({ ...READY_CONFIG, horizonDays: 30, horizonSource: "DEFAULT" });

    const result = await runFillRolloutPreflightCli([], deps);

    expect(result.exitCode).toBe(PREFLIGHT_CLI_EXIT.BLOCKED);
    expect(lines.join("\n")).toContain("HORIZON_DEFAULTED");
    expect(lines.join("\n")).toContain("horizon source                   DEFAULT");
  });

  it("accepts an EXPLICIT 30 -- the same number, deliberately chosen", async () => {
    const { deps, lines } = cli({ ...READY_CONFIG, horizonDays: 30, horizonSource: "EXPLICIT" });

    const result = await runFillRolloutPreflightCli([], deps);

    // The value is identical; only the provenance differs, and that is the
    // whole point of the gate.
    expect(result.exitCode).toBe(PREFLIGHT_CLI_EXIT.READY);
    expect(lines.join("\n")).toContain("horizon source                   EXPLICIT");
    expect(lines.join("\n")).toContain("ingest horizon days              30");
  });

  it("accepts an EXPLICIT 3", async () => {
    const { deps, lines } = cli({ ...READY_CONFIG, horizonDays: 3, horizonSource: "EXPLICIT" });

    const result = await runFillRolloutPreflightCli([], deps);

    expect(result.exitCode).toBe(PREFLIGHT_CLI_EXIT.READY);
    expect(lines.join("\n")).toContain("ingest horizon days              3");
  });
});

describe("the projections take the minimum of every restrictive factor", () => {
  it("root upper bound is symbols x horizon, and is labelled a bound", async () => {
    const projection = projectRollout(
      { ...READY_CONFIG, horizonDays: 3 },
      { ...READY_STATE, symbolUniverseCount: 500 }
    );
    expect(projection.rootUpperBound).toBe(1500);

    const { deps, lines } = cli({ ...READY_CONFIG, horizonDays: 3 });
    await runFillRolloutPreflightCli([], deps);
    expect(lines.join("\n")).toContain("projected root upper bound       1500");
  });

  it("requests per UTC minute is floor(sharedCap / requestWeight)", () => {
    for (const [cap, expected] of [[5, 1], [10, 2], [25, 5], [100, 20]] as const) {
      expect(
        projectRollout({ ...READY_CONFIG, sharedUserTradesWeightPerMinute: cap }, READY_STATE)
          .requestsPerUtcMinute
      ).toBe(expected);
    }
  });

  // Each row makes exactly ONE factor the binding constraint, so a projection
  // that ignored that factor would report a larger number here.
  const FACTOR_CASES: ReadonlyArray<
    readonly [string, Partial<PreflightConfig>, Partial<PreflightState>, number]
  > = [
    [
      "maxWindows binds",
      { maxWindowsPerTick: 2, maxUserTradesWeightPerTick: 500, sharedUserTradesWeightPerMinute: 500 },
      { campaignMaxDispatches: 100, campaignDispatchesUsed: 0 },
      2,
    ],
    [
      "per-tick weight binds",
      { maxWindowsPerTick: 100, maxUserTradesWeightPerTick: 15, sharedUserTradesWeightPerMinute: 500 },
      { campaignMaxDispatches: 100, campaignDispatchesUsed: 0 },
      3,
    ],
    [
      "shared cap binds",
      { maxWindowsPerTick: 100, maxUserTradesWeightPerTick: 500, sharedUserTradesWeightPerMinute: 5 },
      { campaignMaxDispatches: 100, campaignDispatchesUsed: 0 },
      1,
    ],
    [
      "campaign remaining binds",
      { maxWindowsPerTick: 100, maxUserTradesWeightPerTick: 500, sharedUserTradesWeightPerMinute: 500 },
      { campaignMaxDispatches: 3, campaignDispatchesUsed: 1 },
      2,
    ],
  ];

  for (const [description, configPatch, statePatch, expected] of FACTOR_CASES) {
    it(`requests per tick when ${description}`, () => {
      const projection = projectRollout(
        { ...READY_CONFIG, ...configPatch },
        { ...READY_STATE, ...statePatch }
      );
      expect(projection.requestsPerFreshCapTick).toBe(expected);
    });
  }

  it("a minimum-legal configuration yields exactly one request per tick and per minute", () => {
    // The smallest values env validation admits: cap 5, per-tick weight 5.
    const projection = projectRollout(
      {
        ...READY_CONFIG,
        maxWindowsPerTick: 1,
        maxUserTradesWeightPerTick: 5,
        sharedUserTradesWeightPerMinute: 5,
      },
      { ...READY_STATE, campaignMaxDispatches: 1, campaignDispatchesUsed: 0 }
    );
    expect(projection.requestsPerFreshCapTick).toBe(1);
    expect(projection.requestsPerUtcMinute).toBe(1);
  });

  it("reports null projections when no shared cap exists", () => {
    const projection = projectRollout(
      { ...READY_CONFIG, sharedUserTradesWeightPerMinute: undefined },
      READY_STATE
    );
    expect(projection.requestsPerUtcMinute).toBeNull();
    expect(projection.requestsPerFreshCapTick).toBeNull();
    // The root bound does NOT depend on the cap -- bootstrap precedes admission.
    expect(projection.rootUpperBound).toBe(1500);
  });

  it("campaign remaining never goes negative", () => {
    expect(
      projectRollout(READY_CONFIG, {
        ...READY_STATE,
        campaignMaxDispatches: 1,
        campaignDispatchesUsed: 4,
      }).campaignDispatchesRemaining
    ).toBe(0);
  });
});

describe("the printed report is an exact, safe field set", () => {
  it("prints the rollout fields, in order, with no blocker when READY", async () => {
    const { deps, lines } = cli();

    await runFillRolloutPreflightCli([], deps);

    expect(lines[0]).toBe("historical rollout preflight");
    expect(labelsOf(lines)).toEqual([
      "outcome",
      "runtime enabled",
      "ingest horizon days",
      "horizon source",
      "scheduler interval seconds",
      "max windows per tick",
      "max userTrades weight per tick",
      "shared weight per minute",
      "shared cap source",
      "userTrades weight per request",
      "symbol universe count",
      "pending total",
      "pending claimable now",
      "pending outside current horizon",
      "oldest pending UTC day",
      "projected root upper bound",
      "projected requests per tick",
      "projected requests per minute",
      "campaign status",
      "campaign max dispatches",
      "campaign dispatches used",
      "campaign dispatches remaining",
      "circuit state",
      "pending attempt exhausted",
    ]);
  });

  it("marks an absent shared cap as ABSENT rather than inventing a number", async () => {
    const { deps, lines } = cli({ ...READY_CONFIG, sharedUserTradesWeightPerMinute: undefined });

    await runFillRolloutPreflightCli([], deps);
    const text = lines.join("\n");

    expect(text).toContain("shared cap source                ABSENT");
    expect(text).toContain("shared weight per minute         —");
  });
});

describe("no output identifies the account or carries a credential", () => {
  const FORBIDDEN = [
    /postgres(ql)?:\/\//i,
    /redis:\/\//i,
    /\bDATABASE_URL\b/,
    /\bBINANCE_API_(KEY|SECRET)\b/,
    /\bexecutionProfileId\b/,
    /\baccountIdentifier\b/,
  ];

  it("never prints the bound execution profile id, on any verdict", async () => {
    for (const config of [READY_CONFIG, { ...READY_CONFIG, runtimeEnabled: false }]) {
      const { deps, lines } = cli(config);
      await runFillRolloutPreflightCli([], deps);
      const text = lines.join("\n");
      expect(text).not.toContain(PROFILE_ID);
      for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
    }
  });

  it("emits nothing credential-shaped on usage or binding failure", async () => {
    const usage = cli();
    await runFillRolloutPreflightCli(["--profile=x"], usage.deps);
    const refused = cli(READY_CONFIG, READY_STATE, {
      bindProfile: async () => ({ ok: false, reasonCode: "PROFILE_POLICY_MISSING" }) as never,
    });
    await runFillRolloutPreflightCli([], refused.deps);

    for (const lines of [usage.lines, refused.lines]) {
      const text = lines.join("\n");
      expect(text).not.toContain(PROFILE_ID);
      for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
    }
  });
});
