import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  DRAIN_CANDIDATE_STATUSES,
  DRAIN_ELIGIBLE_STATES,
  isExposureFreeTerminal,
  judgeDrainPosture,
  judgeShutdownReadiness,
  summarizeDrain,
  type DrainedExecution,
  type ShutdownPosture,
} from "../src/modules/execution/shutdown-drain";
import { PENDING_ENTRY_STATUSES } from "../src/modules/execution/capacity-status";
import { evaluateDurableSafety } from "../src/modules/operator/runtime-launcher";
import {
  CLI_EXIT,
  DRAIN_CONFIRMATION,
  DRAIN_WARNING,
  drainCommand,
  evaluateCommand,
  runShutdownDrainCli,
} from "../src/modules/execution/shutdown-drain-cli";

/**
 * Draining pending ENTRY orders before an intentional shutdown.
 *
 * ## What actually went wrong
 *
 * The launcher was never the hole. It already refuses Stop Runtime while
 * anything is active, and ENTRY_PENDING counts as active — the pinned test
 * below proves it. The laptop was simply closed, which never asked the launcher
 * anything at all.
 *
 * The real gap was that an operator who WANTED to stop safely had no supported
 * way to get there: with a LIMIT entry resting at Binance, the only options
 * were to wait for a fill or to wait out a 24-hour TTL. This is that missing
 * path, and these tests define what it refuses.
 *
 * Everything is synthetic. No live symbol, no runtime database, no exchange.
 */

const BACKEND = path.resolve(__dirname, "..");

function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SAFE: ShutdownPosture = {
  systemState: "SAFE_OFF",
  authorizationState: "REVOKED",
  manualInterventionCount: 0,
  openPositionCount: 0,
};

function entry(overrides: Partial<DrainedExecution> = {}): DrainedExecution {
  return {
    executionId: "exec-1",
    symbol: "LUMIAUSDT",
    positionSide: "SHORT",
    statusBefore: "ENTRY_PENDING",
    statusAfter: "ENTRY_EXPIRED",
    outcome: "CANCELED_CLEAN",
    reasonCode: "ENTRY_TTL_EXPIRED",
    detail: "Entry order cancelled with no fill.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The existing launcher guard — verified, not assumed
// ---------------------------------------------------------------------------

describe("the launcher already refused; this feature does not weaken it", () => {
  it("ENTRY_PENDING is counted as active, so shutdown was already refused", () => {
    // The audit claim, pinned: the launcher reads capacity.totalActive, and
    // ENTRY_PENDING is in the canonical pending set that feeds it.
    expect(PENDING_ENTRY_STATUSES).toContain("ENTRY_PENDING");
    const verdict = evaluateDurableSafety(
      { systemState: "SAFE_OFF", activeExecutions: 1, manualIntervention: 0, authorizationState: "REVOKED", warnings: [] },
      "SHUTDOWN"
    );
    expect(verdict.safe).toBe(false);
  });

  it("still refuses for every pre-existing reason", () => {
    const base = { systemState: "SAFE_OFF", activeExecutions: 0, manualIntervention: 0, authorizationState: "REVOKED", warnings: [] as string[] };
    // Unreadable state, not SAFE_OFF, open window, manual intervention, and
    // recovery warnings — each must still block, unchanged by this branch.
    expect(evaluateDurableSafety({ ...base, systemState: null }, "SHUTDOWN").safe).toBe(false);
    expect(evaluateDurableSafety({ ...base, systemState: "ARMED" }, "SHUTDOWN").safe).toBe(false);
    expect(evaluateDurableSafety({ ...base, systemState: "SAFE_RECOVERY" }, "SHUTDOWN").safe).toBe(false);
    expect(evaluateDurableSafety({ ...base, authorizationState: "AVAILABLE" }, "SHUTDOWN").safe).toBe(false);
    expect(evaluateDurableSafety({ ...base, manualIntervention: 1 }, "SHUTDOWN").safe).toBe(false);
    expect(evaluateDurableSafety({ ...base, warnings: ["FILLED_WITHOUT_VERIFIED_PROTECTION"] }, "SHUTDOWN").safe).toBe(false);
  });

  it("A. a clean state still permits shutdown", () => {
    expect(
      evaluateDurableSafety(
        { systemState: "SAFE_OFF", activeExecutions: 0, manualIntervention: 0, authorizationState: "REVOKED", warnings: [] },
        "SHUTDOWN"
      ).safe
    ).toBe(true);
  });

  it("the launcher change is a message only — no verdict moved", () => {
    const launcher = codeOf("src/modules/operator/runtime-launcher.ts");
    // It still never mutates, and the drain lives outside it.
    expect(launcher).not.toContain("cancelReservedEntryOrder");
    expect(launcher).not.toContain("ShutdownDrainService");
    expect(launcher).toContain("execution:prepare-shutdown");
  });
});

// ---------------------------------------------------------------------------
// Posture gating
// ---------------------------------------------------------------------------

describe("K/L/M. the drain may only begin from a safe posture", () => {
  it("M. permits SAFE_OFF and SAFE_RECOVERY", () => {
    expect(DRAIN_ELIGIBLE_STATES).toEqual(["SAFE_OFF", "SAFE_RECOVERY"]);
    expect(judgeDrainPosture(SAFE).allowed).toBe(true);
    expect(judgeDrainPosture({ ...SAFE, systemState: "SAFE_RECOVERY" }).allowed).toBe(true);
  });

  it("L. REFUSES while ARMED, and says what to do", () => {
    const verdict = judgeDrainPosture({ ...SAFE, systemState: "ARMED" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/Safe Off/);
  });

  it("REFUSES an unreadable posture — it is never assumed safe", () => {
    for (const posture of [
      { ...SAFE, systemState: null },
      { ...SAFE, manualInterventionCount: null },
      { ...SAFE, openPositionCount: null },
    ]) {
      expect(judgeDrainPosture(posture).allowed).toBe(false);
    }
  });

  it("K. REFUSES while a natural window is AVAILABLE", () => {
    expect(judgeDrainPosture({ ...SAFE, authorizationState: "AVAILABLE" }).allowed).toBe(false);
  });

  it("J. REFUSES while any execution requires manual intervention", () => {
    // Cleaning that up is a separate, deliberate operator action.
    const verdict = judgeDrainPosture({ ...SAFE, manualInterventionCount: 1 });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/manual intervention/i);
  });
});

// ---------------------------------------------------------------------------
// B–H, N, O. Shutdown readiness over drain outcomes
// ---------------------------------------------------------------------------

describe("shutdown readiness", () => {
  it("A. nothing pending and nothing open — ready", () => {
    const verdict = judgeShutdownReadiness({ posture: SAFE, drained: [] });
    expect(verdict.shutdownReady).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("B. one entry cancelled clean — ready", () => {
    const verdict = judgeShutdownReadiness({ posture: SAFE, drained: [entry()] });
    expect(verdict.shutdownReady).toBe(true);
  });

  it("C/D. a fill or partial fill won the race — REFUSED", () => {
    for (const statusAfter of ["ENTRY_FILLED", "PARTIALLY_FILLED"]) {
      const verdict = judgeShutdownReadiness({
        posture: SAFE,
        drained: [entry({ statusAfter, outcome: "EXPOSURE_PRESENT", detail: "A fill landed before the cancel." })],
      });
      expect(verdict.shutdownReady, statusAfter).toBe(false);
      expect(verdict.reasons[0]).toMatch(/EXPOSURE_PRESENT/);
    }
  });

  it("E/F/H. an ambiguous or timed-out cancellation — REFUSED", () => {
    const verdict = judgeShutdownReadiness({
      posture: SAFE,
      drained: [entry({ outcome: "AMBIGUOUS", detail: "Cancellation result could not be established." })],
    });
    expect(verdict.shutdownReady).toBe(false);
  });

  it("G. an entry with no cancellable order is not resolved either", () => {
    // PREFLIGHT holds capacity but has no exchange order; the worker owns it.
    const verdict = judgeShutdownReadiness({
      posture: SAFE,
      drained: [entry({ statusBefore: "PREFLIGHT", statusAfter: "PREFLIGHT", outcome: "NOT_DRAINABLE" })],
    });
    expect(verdict.shutdownReady).toBe(false);
  });

  it("N. several entries all clean — ready", () => {
    const verdict = judgeShutdownReadiness({
      posture: SAFE,
      drained: [entry({ executionId: "a" }), entry({ executionId: "b", symbol: "ENJUSDT" }), entry({ executionId: "c" })],
    });
    expect(verdict.shutdownReady).toBe(true);
  });

  it("O. ONE ambiguous among many refuses the WHOLE shutdown", () => {
    // There is no partial success: stopping with one order still resting is
    // exactly the failure this feature exists to prevent.
    const verdict = judgeShutdownReadiness({
      posture: SAFE,
      drained: [
        entry({ executionId: "a" }),
        entry({ executionId: "b", symbol: "ENJUSDT", outcome: "AMBIGUOUS", detail: "unknown" }),
        entry({ executionId: "c" }),
      ],
    });
    expect(verdict.shutdownReady).toBe(false);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toMatch(/ENJUSDT/);
  });

  it("I. an open position refuses shutdown, and is never closed", () => {
    const verdict = judgeShutdownReadiness({ posture: { ...SAFE, openPositionCount: 1 }, drained: [] });
    expect(verdict.shutdownReady).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/never closes a position/);
  });

  it("a bad posture alone refuses even with nothing pending", () => {
    expect(judgeShutdownReadiness({ posture: { ...SAFE, systemState: "ARMED" }, drained: [] }).shutdownReady).toBe(false);
  });

  it("summarizes with counts only, never a payload", () => {
    const summary = summarizeDrain(judgeShutdownReadiness({ posture: SAFE, drained: [entry()] }));
    expect(summary).toMatch(/shutdown READY/);
    expect(summary).not.toMatch(/exec-1/);
  });
});

// ---------------------------------------------------------------------------
// P. Idempotency and the canonical status set
// ---------------------------------------------------------------------------

describe("P. a second run is safe", () => {
  it("an already-terminal execution is clean without re-cancelling", () => {
    for (const status of ["ENTRY_EXPIRED", "CANCELED", "CLOSED_TP", "FAILED"]) {
      expect(isExposureFreeTerminal(status), status).toBe(true);
    }
  });

  it("a still-pending or parked execution is NOT treated as finished", () => {
    for (const status of ["ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FILLED", "PROTECTED", "MANUAL_INTERVENTION"]) {
      expect(isExposureFreeTerminal(status), status).toBe(false);
    }
  });

  it("uses the CANONICAL pending set rather than a second hand-written list", () => {
    expect(DRAIN_CANDIDATE_STATUSES).toBe(PENDING_ENTRY_STATUSES);
  });
});

// ---------------------------------------------------------------------------
// The CLI boundary
// ---------------------------------------------------------------------------

function deps(overrides: { evaluate?: unknown; drain?: unknown; posture?: ShutdownPosture } = {}) {
  const calls = { evaluate: 0, drain: 0 };
  const posture = overrides.posture ?? SAFE;
  return {
    calls,
    prisma: {} as never,
    readPosture: async () => posture,
    drain: {
      evaluate: async () => {
        calls.evaluate += 1;
        return overrides.evaluate ?? { posture, verdict: judgeShutdownReadiness({ posture, drained: [] }), readOnly: true };
      },
      drain: async () => {
        calls.drain += 1;
        return overrides.drain ?? { posture, verdict: judgeShutdownReadiness({ posture, drained: [entry()] }), readOnly: false };
      },
    } as never,
    entry: {} as never,
  };
}

describe("the operator boundary", () => {
  it("evaluate cancels nothing", async () => {
    const d = deps();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await evaluateCommand([], d);
    spy.mockRestore();
    expect(d.calls.evaluate).toBe(1);
    expect(d.calls.drain).toBe(0);
  });

  it("REFUSES drain with no token, a wrong token, or a generic affirmative", async () => {
    for (const token of [undefined, "yes", "y", "true", "--force", "--confirm"]) {
      const d = deps();
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const result = await drainCommand(token === undefined ? [] : [token], d);
      spy.mockRestore();
      expect(result.exitCode, String(token)).toBe(CLI_EXIT.REFUSED);
      expect(d.calls.drain, String(token)).toBe(0);
    }
  });

  it("H. states exactly what the confirmation authorizes, and what it does not", () => {
    expect(DRAIN_WARNING).toMatch(/CANCEL Teddy-owned pending ENTRY orders/);
    expect(DRAIN_WARNING).toMatch(/NOT close open positions/);
    expect(DRAIN_WARNING).toMatch(/NOT cancel protection stops or take/);
  });

  it("the exact token proceeds, and reports readiness", async () => {
    const d = deps();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await drainCommand([DRAIN_CONFIRMATION], d);
    spy.mockRestore();
    expect(result.exitCode).toBe(CLI_EXIT.OK);
    expect(d.calls.drain).toBe(1);
  });

  it("exits NON-ZERO and says to stay online when not ready", async () => {
    const posture = SAFE;
    const d = deps({
      drain: {
        posture,
        verdict: judgeShutdownReadiness({ posture, drained: [entry({ outcome: "AMBIGUOUS" })] }),
        readOnly: false,
      },
    });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line) => void lines.push(String(line)));
    const result = await drainCommand([DRAIN_CONFIRMATION], d);
    spy.mockRestore();
    expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
    expect(lines.join("\n")).toMatch(/must STAY ONLINE/);
  });

  it("REFUSES when the entry lifecycle is not wired", async () => {
    const d = { ...deps(), entry: undefined };
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await drainCommand([DRAIN_CONFIRMATION], d);
    spy.mockRestore();
    expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
    expect(d.calls.drain).toBe(0);
  });

  it("an unrecognised subcommand prints usage and exits 2", async () => {
    const d = deps();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const argv of [[], ["cancel-all"], ["drain", "--force"], ["evaluate", "BTCUSDT"]]) {
      expect((await runShutdownDrainCli(argv, d)).exitCode).not.toBe(CLI_EXIT.OK);
    }
    spy.mockRestore();
    expect(d.calls.drain).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Q/R/S/T. Structural guarantees
// ---------------------------------------------------------------------------

describe("structural guarantees", () => {
  const service = codeOf("src/modules/execution/shutdown-drain.service.ts");
  const cli = codeOf("src/modules/execution/shutdown-drain-cli.ts");
  const runner = codeOf("src/modules/execution/run-shutdown-drain.ts");

  it("Q. never cancels a protection STOP or TAKE_PROFIT", () => {
    // The only cancellation it can reach is the ENTRY lifecycle's.
    for (const forbidden of ["STOP_LOSS", "TAKE_PROFIT", "cancelAlgoOrder", "clientAlgoId"]) {
      expect(`${forbidden}:${service.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    expect(service).toContain("expireEntryOrderIfDue");
  });

  it("R/S. can only reach orders this system created, by persisted identity", () => {
    // No symbol argument, no exchange order id, no broad cancel. Rows come from
    // tradeExecution, and the lifecycle mints the cancel from the reservation.
    // `symbol` is REPORTED on each result, which is fine; the guarantee is that
    // none is ever ACCEPTED as input or used to select what to cancel.
    for (const forbidden of ["cancelAllOpenOrders", "getOpenOrders", "exchangeOrderId", "where: { symbol"]) {
      expect(`${forbidden}:${service.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    expect(service).toContain("this.prisma.tradeExecution.findMany");
    // Rows are selected by STATUS from the canonical set, never by a ticker.
    expect(service).toContain("status: { in: [...DRAIN_CANDIDATE_STATUSES]");
  });

  it("never closes a position or flattens exposure", () => {
    for (const forbidden of ["closePosition", "emergencyClose", "reduceOnly", "MARKET"]) {
      expect(`service ${forbidden}:${service.includes(forbidden)}`).toBe(`service ${forbidden}:false`);
    }
  });

  it("T. changes no authorization or capacity accounting", () => {
    for (const forbidden of ["claimNaturalWindow", "claimedCount", "executionCanaryAuthorization", "riskBudgetUsd"]) {
      expect(`service ${forbidden}:${service.includes(forbidden)}`).toBe(`service ${forbidden}:false`);
    }
  });

  it("writes no status of its own — the lifecycle drives local state", () => {
    for (const forbidden of ["tradeExecution.update", "tradeExecution.updateMany", 'status: "CANCELED"']) {
      expect(`${forbidden}:${service.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("builds the mutation client ONLY for drain", () => {
    expect(runner).toContain('argv[0] === "drain"');
    expect(runner).toContain("BinanceUsdMExecutionClient");
    expect(`cli:${cli.includes("BinanceUsdMExecutionClient")}`).toBe("cli:false");
  });

  it("has no bulk, wildcard or force mode", () => {
    // `--force` DOES appear in the refusal text — as a statement that it does
    // not exist — so the guarantee is about handling, not about wording.
    for (const forbidden of ["--all", "--yes", "--skip", "argv.includes", "argv.some"]) {
      expect(`cli ${forbidden}:${cli.includes(forbidden)}`).toBe(`cli ${forbidden}:false`);
    }
    expect(cli).toContain("There is no --force");
  });

  it("states the sleep limitation honestly rather than overclaiming", () => {
    // It must never be read as protection against closing the lid.
    // Read RAW: the statement lives in documentation, which is exactly where an
    // operator meets it, and `codeOf` strips comments by design.
    const cliRaw = readFileSync(path.join(BACKEND, "src/modules/execution/shutdown-drain-cli.ts"), "utf8");
    const runnerRaw = readFileSync(path.join(BACKEND, "src/modules/execution/run-shutdown-drain.ts"), "utf8");
    const pureRaw = readFileSync(path.join(BACKEND, "src/modules/execution/shutdown-drain.ts"), "utf8");
    expect(cliRaw).toMatch(/cannot protect against the/i);
    expect(runnerRaw).toMatch(/LIMITATION/);
    expect(pureRaw).toMatch(/cannot make an unexpected one\s+\* safe/);
  });

  it("never prints a secret", () => {
    for (const forbidden of ["apiKey", "apiSecret", "OPERATOR_API_TOKEN", "DATABASE_URL", "WEBHOOK_SECRET"]) {
      expect(`cli ${forbidden}:${cli.includes(forbidden)}`).toBe(`cli ${forbidden}:false`);
      expect(`runner ${forbidden}:${runner.includes(forbidden)}`).toBe(`runner ${forbidden}:false`);
    }
  });

  it("is registered as an execution: script, matching repository convention", () => {
    const pkg = readFileSync(path.join(BACKEND, "package.json"), "utf8");
    expect(pkg).toContain('"execution:prepare-shutdown": "tsx src/modules/execution/run-shutdown-drain.ts"');
  });
});
