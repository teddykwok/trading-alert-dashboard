import { describe, expect, it, vi } from "vitest";

import {
  CANARY_CLI_EXIT,
  runFillWindowCanaryCli,
  type CanaryCliDependencies,
} from "../src/modules/execution/fill-window-canary-cli";
import type { TargetedCanaryResult } from "../src/modules/execution/historical-fill-targeted-canary.service";

/**
 * The operator boundary of the targeted canary, without a database.
 *
 * What is proved here is the CONTRACT: exactly one flag and it names a window,
 * no selector can choose an account or a campaign, and nothing that reaches a
 * terminal identifies the bound profile or carries internal fencing state.
 */

const PROFILE_ID = "clxcanaryprofile00000000001";
const WINDOW_ID = "cmu7760zf00arzooafrci7873";

const EXECUTED: TargetedCanaryResult = {
  outcome: "EXECUTED",
  windowId: WINDOW_ID,
  symbol: "SKYUSDT",
  startTimeMs: 1_789_430_400_000,
  endTimeMs: 1_789_516_799_999,
  ineligibility: null,
  profileReasonCode: null,
  executorOutcome: "COMPLETE",
  executorReasonCode: null,
  userTradesRequests: 1,
  userTradesWeightUsed: 5,
  campaignStatus: "EXHAUSTED",
  dispatchesUsed: 1,
  maxDispatches: 1,
  circuit: {
    state: "CLOSED",
    failureFamily: null,
    lastReasonCode: null,
    consecutiveCount: 0,
    firstFailureAt: null,
    lastFailureAt: null,
    openedAt: null,
    // INTERNAL fencing state. Present on the snapshot, and it must never print.
    generation: 424242,
  } as never,
  circuitOpened: false,
};

function cli(result: TargetedCanaryResult = EXECUTED) {
  const lines: string[] = [];
  const run = vi.fn(async () => result);
  const deps: CanaryCliDependencies = {
    canary: { run } as never,
    workerId: "historical-fill-canary:test",
    out: (line) => lines.push(line),
  };
  return { deps, lines, run };
}

const labelsOf = (lines: string[]) =>
  lines.filter((line) => line.startsWith("  ")).map((line) => line.trim().replace(/\s{2,}.*$/, ""));

describe("the canary takes exactly one window id", () => {
  const REJECTED: ReadonlyArray<readonly [string[], string]> = [
    [[], "no arguments at all"],
    [[`--window-id=${WINDOW_ID}`, `--window-id=${WINDOW_ID}`], "a duplicated window id"],
    [["--window-id="], "an empty window id"],
    [[WINDOW_ID], "a bare positional id"],
    [["--profile=other", `--window-id=${WINDOW_ID}`], "a profile selector"],
    [["--execution-profile-id=x", `--window-id=${WINDOW_ID}`], "an explicit profile id"],
    [["--account=9912345", `--window-id=${WINDOW_ID}`], "an account selector"],
    [["--campaign-id=abc", `--window-id=${WINDOW_ID}`], "a campaign selector"],
    [["--symbol=SKYUSDT", `--window-id=${WINDOW_ID}`], "a symbol selector"],
    [["--date=2026-09-15", `--window-id=${WINDOW_ID}`], "a date selector"],
    [["--force", `--window-id=${WINDOW_ID}`], "a force flag"],
    [["--yes", `--window-id=${WINDOW_ID}`], "a confirmation flag"],
    [["--max-dispatches=1", `--window-id=${WINDOW_ID}`], "a campaign flag from a sibling CLI"],
  ];

  for (const [argv, description] of REJECTED) {
    it(`refuses ${description} and never runs the canary`, async () => {
      const { deps, lines, run } = cli();

      const result = await runFillWindowCanaryCli([...argv], deps);

      expect(result.exitCode).toBe(CANARY_CLI_EXIT.USAGE);
      // The decisive half: a rejected invocation reaches no campaign, no claim
      // and no exchange, because the canary was never entered.
      expect(run).not.toHaveBeenCalled();
      expect(lines.join("\n")).toContain("--window-id=<id>");
    });
  }

  it("accepts exactly one window id and passes it through verbatim", async () => {
    const { deps, run } = cli();

    const result = await runFillWindowCanaryCli([`--window-id=${WINDOW_ID}`], deps);

    expect(result.exitCode).toBe(CANARY_CLI_EXIT.OK);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      workerId: "historical-fill-canary:test",
      windowId: WINDOW_ID,
    });
  });
});

describe("the printed summary is an exact, safe field set", () => {
  it("prints exactly the twenty operator fields, in order", async () => {
    const { deps, lines } = cli();

    await runFillWindowCanaryCli([`--window-id=${WINDOW_ID}`], deps);

    expect(lines[0]).toBe("targeted historical window canary");
    expect(labelsOf(lines)).toEqual([
      "outcome",
      "window id",
      "symbol",
      "start time ms",
      "end time ms",
      "ineligibility",
      "profile reason",
      "executor outcome",
      "executor reason",
      "userTrades requests",
      "userTrades weight",
      "campaign status",
      "dispatches used",
      "max dispatches",
      "circuit state",
      "circuit family",
      "circuit reason",
      "circuit count",
      "circuit opened at",
      "circuit opened now",
    ]);
  });

  it("reports the request and weight actually spent", async () => {
    const { deps, lines } = cli();

    await runFillWindowCanaryCli([`--window-id=${WINDOW_ID}`], deps);
    const text = lines.join("\n");

    expect(text).toContain("outcome                  EXECUTED");
    expect(text).toContain("userTrades requests      1");
    expect(text).toContain("userTrades weight        5");
    expect(text).toContain("campaign status          EXHAUSTED");
    expect(text).toContain("circuit state            CLOSED");
  });

  it("exits REFUSED on every non-executed outcome", async () => {
    for (const outcome of [
      "TARGET_NOT_FOUND",
      "TARGET_NOT_ELIGIBLE",
      "NO_ACTIVE_FILL_CAMPAIGN",
      "CAMPAIGN_NOT_CANARY_SHAPED",
      "SYSTEMIC_CIRCUIT_OPEN",
      "GLOBAL_WEIGHT_CAP_UNAVAILABLE",
      "TARGET_LOST_AFTER_ADMISSION",
    ] as const) {
      const { deps } = cli({ ...EXECUTED, outcome, userTradesRequests: 0 });
      const result = await runFillWindowCanaryCli([`--window-id=${WINDOW_ID}`], deps);
      expect(result.exitCode).toBe(CANARY_CLI_EXIT.REFUSED);
    }
  });
});

describe("no output identifies the account or carries fencing state", () => {
  const FORBIDDEN = [
    /postgres(ql)?:\/\//i,
    /redis:\/\//i,
    /\bDATABASE_URL\b/,
    /\bBINANCE_API_(KEY|SECRET)\b/,
    /generation/i,
    /[A-Za-z0-9]{40,}/,
  ];

  it("never prints the bound execution profile id", async () => {
    const { deps, lines } = cli({ ...EXECUTED, symbol: "SKYUSDT" });

    await runFillWindowCanaryCli([`--window-id=${WINDOW_ID}`], deps);

    expect(lines.join("\n")).not.toContain(PROFILE_ID);
  });

  it("never prints the breaker generation, which the snapshot does carry", async () => {
    const { deps, lines } = cli();

    await runFillWindowCanaryCli([`--window-id=${WINDOW_ID}`], deps);

    // The snapshot handed to the CLI HAS it; the terminal must not.
    // A distinctive value, so this asserts the generation's absence rather than
    // the absence of a digit that window ids and timestamps legitimately carry.
    expect((EXECUTED.circuit as unknown as { generation: number }).generation).toBe(424242);
    expect(lines.join("\n")).not.toContain("424242");
    expect(labelsOf(lines).join(" ")).not.toMatch(/generation/i);
  });

  it("emits nothing matching a credential shape, on success, refusal or usage", async () => {
    const cases: Array<() => Promise<string[]>> = [
      async () => {
        const { deps, lines } = cli();
        await runFillWindowCanaryCli([`--window-id=${WINDOW_ID}`], deps);
        return lines;
      },
      async () => {
        const { deps, lines } = cli({ ...EXECUTED, outcome: "SYSTEMIC_CIRCUIT_OPEN" });
        await runFillWindowCanaryCli([`--window-id=${WINDOW_ID}`], deps);
        return lines;
      },
      async () => {
        const { deps, lines } = cli();
        await runFillWindowCanaryCli(["--profile=x"], deps);
        return lines;
      },
    ];

    for (const scenario of cases) {
      const text = (await scenario()).join("\n");
      for (const pattern of FORBIDDEN) {
        expect(text).not.toMatch(pattern);
      }
    }
  });
});
