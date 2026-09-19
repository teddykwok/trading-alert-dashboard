import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import {
  CLI_EXIT,
  RECOVERY_ELIGIBLE_STATES,
  RECOVER_CONFIRMATION,
  evaluateCommand,
  judgeRecoveryPosture,
  recoverCommand,
  runEntryRecoveryCli,
} from "../src/modules/execution/entry-recovery-cli";
import type { EntryRecoveryService } from "../src/modules/execution/entry-recovery.service";

/**
 * The operator boundary for stuck-entry recovery.
 *
 * The decision this CLI fronts is the one irreversible-feeling act in recovery:
 * telling the system an execution can have no exposure. So the boundary itself
 * carries three guarantees, and each is pinned here:
 *
 *   1. it cannot be invoked by accident — exact id, exact confirmation token,
 *      no force, no bulk, no wildcard;
 *   2. it cannot run while trading is ARMED, but MUST run in SAFE_RECOVERY,
 *      because that is the state a real incident leaves behind;
 *   3. it never trusts a previous preview — the mutation re-gathers evidence.
 *
 * No database, no exchange, no runtime: the service is a double throughout.
 */

const BACKEND = process.cwd();

/**
 * Source with comments removed.
 *
 * The structural guarantees below are about what the code DOES. Matching raw
 * text would fail on the very comments that explain why a thing is absent —
 * "there is no --all", "reading environmentIsArmed() here would refuse".
 */
function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const EXECUTION_ID = "exec-stuck-1";
/** The profile this fake process is bound to. */
const BOUND_PROFILE_ID = "profile-1";

function deps(options: {
  execution?: Record<string, unknown> | null;
  evaluate?: unknown;
  recover?: unknown;
  isEnabled?: boolean | null;
  killSwitchActive?: boolean | null;
  windows?: unknown[];
} = {}) {
  const calls = { evaluate: 0, recover: 0 };

  const recovery = {
    // The CLI asks the service which profile it is bound to rather than
    // resolving one of its own, so what it prints can never describe a
    // different profile from the one the service will enforce.
    boundExecutionProfileId: BOUND_PROFILE_ID,
    evaluate: vi.fn(async () => {
      calls.evaluate += 1;
      return options.evaluate === undefined
        ? { verdict: { proven: true, checks: ["exactQueryNotFound", "positionFlat"] }, evidence: {} }
        : options.evaluate;
    }),
    recover: vi.fn(async () => {
      calls.recover += 1;
      return (
        options.recover ?? {
          ok: true,
          outcome: "RECOVERED",
          executionId: EXECUTION_ID,
          message: "Absence proven.",
          checks: ["exactQueryNotFound"],
          blockers: [],
          status: "FAILED",
        }
      );
    }),
  } as unknown as EntryRecoveryService;

  const prisma = {
    tradeExecution: {
      // The CLI selects by id AND by the bound profile, in one predicate. The
      // fake HONOURS that predicate rather than ignoring it, so dropping
      // `executionProfileId` from the query fails these tests instead of
      // passing unnoticed.
      findFirst: vi.fn(async (args: { where?: { executionProfileId?: string } }) => {
        if (args?.where?.executionProfileId !== BOUND_PROFILE_ID) return null;
        return options.execution === undefined
          ? { id: EXECUTION_ID, symbol: "SOLUSDC", positionSide: "SHORT", status: "ENTRY_SUBMITTING", version: 3 }
          : options.execution;
      }),
      // Existence-only probe behind the refusal wording.
      count: vi.fn(async () => (options.execution === null ? 0 : 1)),
    },
    executionProfile: {
      findMany: vi.fn(async () => [
        {
          id: "profile-1",
          isEnabled: options.isEnabled === undefined ? true : options.isEnabled,
          safetyPolicy: {
            killSwitchActive: options.killSwitchActive === undefined ? true : options.killSwitchActive,
          },
        },
      ]),
    },
    executionCanaryAuthorization: { findMany: vi.fn(async () => options.windows ?? []) },
  } as unknown as PrismaClient;

  return { prisma, recovery, calls };
}

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
    logged.push(String(line ?? ""));
  });
});
afterEach(() => vi.restoreAllMocks());
const output = () => logged.join("\n");

// ---------------------------------------------------------------------------
// C. The operator-state guard
// ---------------------------------------------------------------------------

describe("entry recovery CLI: the durable posture guard", () => {
  it("C1. permits exactly SAFE_OFF and SAFE_RECOVERY", () => {
    expect([...RECOVERY_ELIGIBLE_STATES]).toEqual(["SAFE_OFF", "SAFE_RECOVERY"]);
    // Both mean killSwitchActive === true: new entry is durably blocked.
    expect(judgeRecoveryPosture({ isEnabled: false, killSwitchActive: true, availableWindows: 0 })).toMatchObject({
      allowed: true,
      systemState: "SAFE_OFF",
    });
    expect(judgeRecoveryPosture({ isEnabled: true, killSwitchActive: true, availableWindows: 0 })).toMatchObject({
      allowed: true,
      systemState: "SAFE_RECOVERY",
    });
  });

  it("C2. REFUSES while ARMED", () => {
    const verdict = judgeRecoveryPosture({ isEnabled: true, killSwitchActive: false, availableWindows: 0 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.systemState).toBe("ARMED");
    expect(verdict.reason).toContain("ARMED");
  });

  it("C3. REFUSES an unreadable or incoherent posture — 'could not tell' is not permission", () => {
    for (const input of [
      { isEnabled: null, killSwitchActive: true },
      { isEnabled: true, killSwitchActive: undefined },
      { isEnabled: false, killSwitchActive: false }, // INVALID
    ]) {
      const verdict = judgeRecoveryPosture({ ...input, availableWindows: 0 } as never);
      expect(`${JSON.stringify(input)}:${verdict.allowed}`).toBe(`${JSON.stringify(input)}:false`);
    }
  });

  it("C4. REFUSES while a natural window is still AVAILABLE", () => {
    const verdict = judgeRecoveryPosture({ isEnabled: true, killSwitchActive: true, availableWindows: 1 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("AVAILABLE");
  });

  it("C5. does NOT require zero active executions — the stuck row is itself active", () => {
    // Requiring a quiet system would make recovery impossible in the only
    // situation it exists for.
    const source = codeOf("src/modules/execution/entry-recovery-cli.ts");
    const guard = source.slice(source.indexOf("export function judgeRecoveryPosture"), source.indexOf("export async function readRecoveryPosture"));
    expect(guard).not.toMatch(/TOTAL_ACTIVE|activeExecutions|totalActive/);
    // And it judges the DURABLE state, never the deployment gates — which stay
    // LIVE_READY during a real incident.
    expect(source).not.toContain("environmentIsArmed");
  });
});

// ---------------------------------------------------------------------------
// A. evaluate — read-only
// ---------------------------------------------------------------------------

describe("entry recovery CLI: evaluate", () => {
  it("A1. requires exactly one execution id", async () => {
    for (const argv of [[], ["a", "b"]]) {
      const d = deps();
      const result = await evaluateCommand(argv, d);
      expect(result.exitCode).toBe(CLI_EXIT.USAGE);
      expect(d.calls.evaluate).toBe(0);
    }
  });

  it("A2. calls evaluate once and never recover", async () => {
    const d = deps();
    await evaluateCommand([EXECUTION_ID], d);
    expect(d.calls.evaluate).toBe(1);
    expect(d.calls.recover).toBe(0);
  });

  it("A3. renders SAFE_TO_RECOVER with its checks, and exits zero", async () => {
    const d = deps();
    const result = await evaluateCommand([EXECUTION_ID], d);
    expect(result.exitCode).toBe(CLI_EXIT.OK);
    expect(output()).toContain("SAFE_TO_RECOVER");
    expect(output()).toContain("exactQueryNotFound");
    expect(output()).toContain("SOLUSDC");
    // It tells the operator the preview is not carried into the mutation.
    expect(output()).toContain("re-gathers this evidence itself");
  });

  it("A4. renders blockers and exits NON-ZERO when absence is not proven", async () => {
    const d = deps({
      evaluate: {
        verdict: { proven: false, reasonCode: "EVIDENCE_INCOMPLETE", checks: [], blockers: ["positionFlat: timeout"] },
        evidence: {},
      },
    });
    const result = await evaluateCommand([EXECUTION_ID], d);
    expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
    expect(output()).toContain("EVIDENCE_INCOMPLETE");
    expect(output()).toContain("positionFlat: timeout");
    expect(output()).toContain("Recovery is NOT safe");
  });

  it("A5. refuses an unknown execution and a non-recoverable status", async () => {
    expect((await evaluateCommand([EXECUTION_ID], deps({ execution: null }))).exitCode).toBe(CLI_EXIT.REFUSED);
    // `evaluate` returns null when the status is not ENTRY_SUBMITTING.
    const d = deps({ evaluate: null });
    expect((await evaluateCommand([EXECUTION_ID], d)).exitCode).toBe(CLI_EXIT.REFUSED);
    expect(output()).toContain("NOT_APPLICABLE");
  });
});

// ---------------------------------------------------------------------------
// B. recover — confirmation
// ---------------------------------------------------------------------------

describe("entry recovery CLI: the confirmation token", () => {
  it("B1. REFUSES with no token, a wrong token, or a generic affirmative", async () => {
    for (const token of [undefined, "yes", "y", "true", "--force", "--confirm", "RECOVER", "--confirm-arm"]) {
      const d = deps();
      const argv = token === undefined ? [EXECUTION_ID] : [EXECUTION_ID, token];
      const result = await recoverCommand(argv, d);
      expect(`${String(token)}:${result.exitCode}`).toBe(`${String(token)}:${CLI_EXIT.REFUSED}`);
      // The decisive assertion: nothing reached the service.
      expect(`${String(token)}:${d.calls.recover}`).toBe(`${String(token)}:0`);
    }
    expect(output()).toContain("no --force");
  });

  it("B2. the exact token proceeds to the service", async () => {
    const d = deps();
    const result = await recoverCommand([EXECUTION_ID, RECOVER_CONFIRMATION], d);
    expect(result.exitCode).toBe(CLI_EXIT.OK);
    expect(d.calls.recover).toBe(1);
    expect(output()).toContain("RECOVERED");
  });

  it("B3. the token states the claim being made, and is not guessable", () => {
    expect(RECOVER_CONFIRMATION).toBe("--confirm-recover-proven-absent");
    for (const weak of ["yes", "y", "true", "--force", "-f"]) {
      expect(RECOVER_CONFIRMATION).not.toBe(weak);
    }
  });

  it("B4. requires the id too, and rejects extra arguments", async () => {
    const d = deps();
    expect((await recoverCommand([], d)).exitCode).toBe(CLI_EXIT.USAGE);
    expect((await recoverCommand([EXECUTION_ID, RECOVER_CONFIRMATION, "extra"], d)).exitCode).toBe(CLI_EXIT.USAGE);
    expect(d.calls.recover).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C/D. Guard enforcement and fresh evidence
// ---------------------------------------------------------------------------

describe("entry recovery CLI: recover", () => {
  it("C6. REFUSES to reach the service while ARMED", async () => {
    const d = deps({ isEnabled: true, killSwitchActive: false });
    const result = await recoverCommand([EXECUTION_ID, RECOVER_CONFIRMATION], d);
    expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
    expect(d.calls.recover).toBe(0);
    expect(output()).toContain("ARMED");
  });

  it("C7. RUNS in SAFE_RECOVERY — the state a real incident leaves behind", async () => {
    const d = deps({ isEnabled: true, killSwitchActive: true });
    const result = await recoverCommand([EXECUTION_ID, RECOVER_CONFIRMATION], d);
    expect(result.exitCode).toBe(CLI_EXIT.OK);
    expect(d.calls.recover).toBe(1);
    expect(output()).toContain("SAFE_RECOVERY");
  });

  it("C8. REFUSES to reach the service while a window is AVAILABLE", async () => {
    const d = deps({
      windows: [
        {
          id: "w",
          authorizationType: "NATURAL_WINDOW",
          // A natural window carries NO exact-signal identity; the predicate
          // rejects a row where these are anything but null.
          allowedSymbol: null,
          allowedDirection: null,
          tokenHash: null,
          allowedDirections: ["LONG", "SHORT"],
          maxClaims: 5,
          claimedCount: 0,
          version: 1,
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
    });
    const result = await recoverCommand([EXECUTION_ID, RECOVER_CONFIRMATION], d);
    expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
    expect(d.calls.recover).toBe(0);
  });

  it("D1. NEVER carries a preview into the mutation — it re-gathers evidence", async () => {
    // A preview that said SAFE_TO_RECOVER, followed by a service that now finds
    // an order. The CLI must report the SERVICE's answer, not the preview's.
    const d = deps({
      evaluate: { verdict: { proven: true, checks: ["exactQueryNotFound"] }, evidence: {} },
      recover: {
        ok: false,
        outcome: "BLOCKED",
        executionId: EXECUTION_ID,
        message: "Absence is not proven (EXPOSURE_EVIDENCE_PRESENT); nothing was released.",
        checks: [],
        blockers: ["an open order matches this entry"],
        status: "ENTRY_SUBMITTING",
      },
    });
    await evaluateCommand([EXECUTION_ID], d);
    const result = await recoverCommand([EXECUTION_ID, RECOVER_CONFIRMATION], d);

    expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
    expect(output()).toContain("an open order matches this entry");
    expect(output()).toContain("ENTRY_SUBMITTING");
  });

  it("D2. structurally passes NO evidence from the CLI into recover", () => {
    // `recover` takes an id and nothing else, so there is no parameter through
    // which a stale reading could travel.
    const source = codeOf("src/modules/execution/entry-recovery-cli.ts");
    expect(source).toContain("deps.recovery.recover(executionId)");
    expect(source).not.toMatch(/recover\([^)]*evidence/);
    expect(source).not.toMatch(/recover\([^)]*verdict/);
  });

  it("E1. reports a CAS/state conflict as a refusal and does not retry", async () => {
    const d = deps({
      recover: {
        ok: false,
        outcome: "BLOCKED",
        executionId: EXECUTION_ID,
        message: "The execution changed while its evidence was being evaluated; nothing was released.",
        checks: [],
        blockers: ["version or status changed during evaluation"],
        status: "ENTRY_SUBMITTING",
      },
    });
    const result = await recoverCommand([EXECUTION_ID, RECOVER_CONFIRMATION], d);
    expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
    expect(d.calls.recover).toBe(1); // exactly once — no blind retry
    expect(output()).toContain("version or status changed");
  });

  it("G1. an already-terminal execution reports ALREADY_RESOLVED, not a second release", async () => {
    const d = deps({
      recover: {
        ok: true,
        outcome: "ALREADY_RESOLVED",
        executionId: EXECUTION_ID,
        message: "The execution is FAILED; only ENTRY_SUBMITTING is recoverable here.",
        checks: [],
        blockers: [],
        status: "FAILED",
      },
    });
    const result = await recoverCommand([EXECUTION_ID, RECOVER_CONFIRMATION], d);
    expect(result.exitCode).toBe(CLI_EXIT.OK);
    expect(output()).toContain("ALREADY_RESOLVED");
  });
});

// ---------------------------------------------------------------------------
// H. Structural guarantees
// ---------------------------------------------------------------------------

describe("entry recovery CLI: structure", () => {
  const cli = codeOf("src/modules/execution/entry-recovery-cli.ts");
  const runner = codeOf("src/modules/execution/run-entry-recovery.ts");

  it("H1. has no bulk, wildcard or force mode", () => {
    // No bulk selector and no flag parsing beyond the confirmation token.
    // `--force` DOES appear in the refusal message — as a statement that it
    // does not exist — so the guarantee is about handling, not about text.
    for (const forbidden of ["--all", "--yes", "--skip", "argv.includes", "argv.some", "flags"]) {
      expect(`${forbidden}:${cli.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // The token is compared by exact equality — never parsed, never fuzzy.
    expect(cli).toContain("confirmation !== RECOVER_CONFIRMATION");
    // Both commands read exactly one id from argv[0].
    expect(cli).toContain("const executionId = argv[0]");
  });

  it("H2. cannot place or cancel an order — the mutation client is not imported", () => {
    for (const forbidden of [
      "binance-execution.client",
      "BinanceUsdMExecutionClient",
      "submitLimitEntry",
      "authorizeLiveEntry",
      "cancelOrder",
      "binance-account-setup",
    ]) {
      expect(`cli ${forbidden}:${cli.includes(forbidden)}`).toBe(`cli ${forbidden}:false`);
      expect(`runner ${forbidden}:${runner.includes(forbidden)}`).toBe(`runner ${forbidden}:false`);
    }
    // Only the read-only connector reaches Binance from here.
    expect(runner).toContain("BinanceReadOnlyService");
  });

  it("H3. delegates to EntryRecoveryService rather than duplicating evidence logic", () => {
    expect(cli).toContain("deps.recovery.evaluate(executionId)");
    expect(cli).toContain("deps.recovery.recover(executionId)");
    // No second copy of the absence rules.
    for (const rule of ["judgeEntryAbsence", "NOT_FOUND_CONFIRMED", "positionAmt", "userTrades"]) {
      expect(`${rule}:${cli.includes(rule)}`).toBe(`${rule}:false`);
    }
  });

  it("H4. never prints a secret or a raw payload", () => {
    for (const forbidden of [
      "BINANCE_API_KEY",
      "BINANCE_API_SECRET",
      "OPERATOR_API_TOKEN",
      "WEBHOOK_SECRET",
      "DATABASE_URL",
      "signature",
      "JSON.stringify(evidence",
    ]) {
      expect(`${forbidden}:${cli.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("H5. an unrecognised subcommand prints usage and exits 2", async () => {
    const d = deps();
    for (const argv of [[], ["nope", EXECUTION_ID], ["--help"]]) {
      const result = await runEntryRecoveryCli(argv, d);
      expect(result.exitCode).toBe(CLI_EXIT.USAGE);
    }
    expect(d.calls.evaluate + d.calls.recover).toBe(0);
  });

  it("H6. is registered as an execution: script, matching repository convention", () => {
    const pkg = JSON.parse(readFileSync(path.join(BACKEND, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["execution:entry-recovery"]).toBe("tsx src/modules/execution/run-entry-recovery.ts");
  });
});
