import { describe, expect, it, vi } from "vitest";

import {
  FINALIZE_CLI_EXIT,
  runFillFinalizeExhaustedCli,
  type FinalizeCliDependencies,
} from "../src/modules/execution/fill-finalize-exhausted-cli";

/**
 * The operator boundary of the exhausted-window repair, without a database.
 *
 * What is proved here is the CONTRACT: the command takes nothing at all, no
 * argument can choose an account or widen the sweep, and nothing that reaches a
 * terminal identifies the bound profile.
 */

const PROFILE_ID = "clxfinalizeprofile0000000001";
const WINDOW_A = "cmu7760zf00arzooafrci7873";
const WINDOW_B = "cmu7760zf00arzooafrci9001";

function cli(finalized: string[] = [WINDOW_A, WINDOW_B]) {
  const lines: string[] = [];
  const finalizeStaleExhausted = vi.fn(async () => finalized);
  const deps: FinalizeCliDependencies = {
    prisma: {} as never,
    work: { finalizeStaleExhausted },
    bindProfile: async () =>
      ({ ok: true, context: { executionProfileId: PROFILE_ID, environment: "TESTNET" } }) as never,
    out: (line) => lines.push(line),
  };
  return { deps, lines, finalizeStaleExhausted };
}

const labelsOf = (lines: string[]) =>
  lines.filter((line) => line.startsWith("  ")).map((line) => line.trim().replace(/\s{2,}.*$/, ""));

describe("the repair takes no arguments at all", () => {
  // Every flag somebody might reach for to aim this at another account, at one
  // window, or at a wider sweep than the audited bound. None may be ignored.
  const REJECTED: ReadonlyArray<readonly [string[], string]> = [
    [["--profile=other"], "a profile selector"],
    [["--profile-id=clx000"], "a short profile id selector"],
    [["--execution-profile-id=clx000"], "an explicit execution profile id"],
    [["--account=9912345"], "an account selector"],
    [["--account-id=9912345"], "an account id selector"],
    [["--window-id=cmu7760zf00arzooafrci7873"], "a window selector"],
    [["--force"], "a force flag"],
    [["--limit=500"], "a batch limit override"],
    [["--yes"], "a confirmation flag"],
    [["--dry-run"], "an unknown flag"],
    [["all"], "a bare positional"],
    [["finalize", "--force"], "a positional plus a flag"],
  ];

  for (const [argv, description] of REJECTED) {
    it(`refuses ${description} and repairs nothing`, async () => {
      const { deps, lines, finalizeStaleExhausted } = cli();

      const result = await runFillFinalizeExhaustedCli([...argv], deps);

      expect(result.exitCode).toBe(FINALIZE_CLI_EXIT.USAGE);
      // The decisive half: a rejected invocation writes nothing, because the
      // one method that can write was never reached.
      expect(finalizeStaleExhausted).not.toHaveBeenCalled();
      expect(lines.join("\n")).toContain("Takes NO arguments");
    });
  }

  it("runs on a completely empty argv", async () => {
    const { deps, finalizeStaleExhausted } = cli();

    const result = await runFillFinalizeExhaustedCli([], deps);

    expect(result.exitCode).toBe(FINALIZE_CLI_EXIT.OK);
    expect(finalizeStaleExhausted).toHaveBeenCalledTimes(1);
  });
});

describe("the bound account decides, and no clock or bound is overridden", () => {
  it("passes only the bound profile id -- no limit, no now", async () => {
    const { deps, finalizeStaleExhausted } = cli();

    await runFillFinalizeExhaustedCli([], deps);

    // EXACT options object. A `limit` or `now` appearing here would mean the
    // CLI had started overriding the audited service contract.
    expect(finalizeStaleExhausted).toHaveBeenCalledWith(deps.prisma, {
      executionProfileId: PROFILE_ID,
    });
    const options = finalizeStaleExhausted.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(options)).toEqual(["executionProfileId"]);
  });

  it("refuses and repairs nothing when the profile cannot be bound", async () => {
    const lines: string[] = [];
    const finalizeStaleExhausted = vi.fn(async () => []);
    const result = await runFillFinalizeExhaustedCli([], {
      prisma: {} as never,
      work: { finalizeStaleExhausted },
      bindProfile: async () => ({ ok: false, reasonCode: "PROFILE_NOT_FOUND" }) as never,
      out: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(FINALIZE_CLI_EXIT.REFUSED);
    expect(finalizeStaleExhausted).not.toHaveBeenCalled();
    expect(labelsOf(lines)).toEqual(["outcome", "reason"]);
    expect(lines.join("\n")).toContain("PROFILE_NOT_FOUND");
  });
});

describe("the printed summary is an exact, safe field set", () => {
  it("prints four fixed fields then one line per finalized window", async () => {
    const { deps, lines } = cli([WINDOW_A, WINDOW_B]);

    const result = await runFillFinalizeExhaustedCli([], deps);

    expect(result.exitCode).toBe(FINALIZE_CLI_EXIT.OK);
    expect(lines[0]).toBe("historical fill exhausted-window finalization");
    // EXACT, not "contains": a field added by a future spread would fail here
    // before anybody had to notice it in a terminal.
    expect(labelsOf(lines)).toEqual([
      "outcome",
      "windows finalized",
      "terminal status",
      "terminal reason",
      "window",
      "window",
    ]);
  });

  it("reports the count and the terminal contract taken from source", async () => {
    const { deps, lines } = cli([WINDOW_A, WINDOW_B]);

    await runFillFinalizeExhaustedCli([], deps);
    const text = lines.join("\n");

    expect(text).toContain("outcome                  FINALIZED");
    expect(text).toContain("windows finalized        2");
    expect(text).toContain("terminal status          ABANDONED");
    expect(text).toContain("terminal reason          ATTEMPT_BUDGET_EXHAUSTED_AFTER_STALE_LEASE");
    expect(text).toContain(WINDOW_A);
    expect(text).toContain(WINDOW_B);
  });

  it("prints no window lines when nothing was eligible", async () => {
    const { deps, lines } = cli([]);

    const result = await runFillFinalizeExhaustedCli([], deps);

    expect(result.exitCode).toBe(FINALIZE_CLI_EXIT.OK);
    expect(labelsOf(lines)).toEqual([
      "outcome",
      "windows finalized",
      "terminal status",
      "terminal reason",
    ]);
    expect(lines.join("\n")).toContain("windows finalized        0");
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

  it("never prints the bound execution profile id", async () => {
    const { deps, lines } = cli();

    await runFillFinalizeExhaustedCli([], deps);

    // The binder handed it over; the terminal must not show it.
    expect(lines.join("\n")).not.toContain(PROFILE_ID);
  });

  it("emits nothing matching a credential shape, on success, refusal or usage", async () => {
    const scenarios: Array<() => Promise<string[]>> = [
      async () => {
        const { deps, lines } = cli();
        await runFillFinalizeExhaustedCli([], deps);
        return lines;
      },
      async () => {
        const { deps, lines } = cli([]);
        await runFillFinalizeExhaustedCli(["--profile=x"], deps);
        return lines;
      },
      async () => {
        const lines: string[] = [];
        await runFillFinalizeExhaustedCli([], {
          prisma: {} as never,
          work: { finalizeStaleExhausted: vi.fn(async () => []) },
          bindProfile: async () =>
            ({ ok: false, reasonCode: "PROFILE_POLICY_MISSING" }) as never,
          out: (line) => lines.push(line),
        });
        return lines;
      },
    ];

    for (const scenario of scenarios) {
      const text = (await scenario()).join("\n");
      for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
    }
  });
});
