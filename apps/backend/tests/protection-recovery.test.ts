import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  RECOVERABLE_PROTECTION_REASON,
  gathered,
  judgeProtectionRecovery,
  unavailable,
  type ProtectionRecoveryEvidence,
} from "../src/modules/execution/protection-recovery-evidence";
/**
 * The posture guard resolves the CONFIGURED profile before it will let `recover`
 * reach the service, and that identity comes from validated env read at import
 * time. Pinning it here keeps these tests independent of whether the machine
 * running them happens to have a developer `.env` — the sibling entry-recovery
 * CLI suite does not, which is exactly why its recover-path tests fail in an
 * isolated worktree.
 */
process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = "protection-recovery-test-account";
process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";

const {
  CLI_EXIT,
  RECOVER_CONFIRMATION,
  evaluateCommand,
  judgeRecoveryPosture,
  recoverCommand,
  runProtectionRecoveryCli,
} = await import("../src/modules/execution/protection-recovery-cli");

/**
 * Explicit operator recovery for a protection intervention the worker will
 * never retry on its own.
 *
 * `TAKE_PROFIT_TRIGGER_INVALID` stays OUT of automatic recovery: price moving
 * past the target does not un-move, so an unattended retry loop would achieve
 * nothing but churn. The stop, however, is usually placeable the whole time —
 * which is exactly how ENJUSDT ended up parked with live exposure and no stop.
 * This is the path a human takes after looking, and these tests define what it
 * refuses.
 *
 * Everything here is synthetic. No live symbol, no runtime database, no
 * exchange call.
 */

const BACKEND = path.resolve(__dirname, "..");

/**
 * Source with comments stripped.
 *
 * The structural pins assert that certain expressions do NOT appear. Several
 * are named in comments explaining why they are wrong, so matching raw text
 * would fail on the documentation rather than on the code.
 */
function codeOf(relative: string): string {
  return readFileSync(path.join(BACKEND, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// The ENJ incident, as evidence
// ---------------------------------------------------------------------------

/** ENJUSDT SHORT exactly as the incident left it: parked, open, stop placeable. */
function enjEvidence(overrides: Partial<ProtectionRecoveryEvidence> = {}): ProtectionRecoveryEvidence {
  return {
    executionStatus: gathered("MANUAL_INTERVENTION"),
    requiresManualIntervention: gathered(true),
    protectionState: gathered("MANUAL_INTERVENTION"),
    protectionReasonCode: gathered(RECOVERABLE_PROTECTION_REASON),
    environmentMatches: gathered(true),
    positionQuantity: gathered("2631"),
    recordedFillQuantity: gathered("2631"),
    activeStopQuantity: gathered("0"),
    activeTakeProfitQuantity: gathered("0"),
    ambiguousProtectionSubmission: gathered(false),
    frozenStopTrigger: gathered("0.02868"),
    stopTriggerPlaceable: gathered(true),
    ...overrides,
  };
}

describe("A. the ENJ incident evaluates as SAFE_TO_RECOVER", () => {
  it("passes every check on clean evidence", () => {
    const verdict = judgeProtectionRecovery(enjEvidence());
    expect(verdict.safe).toBe(true);
    expect(verdict.checks).toContain("statusIsManualIntervention");
    expect(verdict.checks).toContain("reasonIsTakeProfitTriggerInvalid");
    expect(verdict.checks).toContain("positionMatchesRecordedFill");
    expect(verdict.checks).toContain("stopTriggerPlaceable");
  });

  it("reports that no stop is active yet — which is the whole problem", () => {
    const verdict = judgeProtectionRecovery(enjEvidence());
    expect(verdict.alreadyStopped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// N/G/H/I. The refusal matrix
// ---------------------------------------------------------------------------

describe("the refusal matrix", () => {
  const cases: [string, Partial<ProtectionRecoveryEvidence>, string][] = [
    ["wrong execution status", { executionStatus: gathered("PROTECTED") }, "RECOVERY_PRECONDITION_FAILED"],
    ["requiresManualIntervention false", { requiresManualIntervention: gathered(false) }, "RECOVERY_PRECONDITION_FAILED"],
    ["protection row not parked by the lifecycle", { protectionState: gathered("PROTECTION_INCOMPLETE") }, "RECOVERY_PRECONDITION_FAILED"],
    ["wrong intervention reason", { protectionReasonCode: gathered("STOP_NOT_VERIFIED") }, "RECOVERY_PRECONDITION_FAILED"],
    ["environment mismatch", { environmentMatches: gathered(false) }, "RECOVERY_PRECONDITION_FAILED"],
    ["no open position", { positionQuantity: gathered("0") }, "RECOVERY_PRECONDITION_FAILED"],
    ["position quantity mismatch", { positionQuantity: gathered("1000") }, "RECOVERY_PRECONDITION_FAILED"],
    ["ambiguous protection submission", { ambiguousProtectionSubmission: gathered(true) }, "RECOVERY_PRECONDITION_FAILED"],
    ["stop trigger not placeable", { stopTriggerPlaceable: gathered(false) }, "RECOVERY_PRECONDITION_FAILED"],
    ["no usable frozen stop", { frozenStopTrigger: gathered("0") }, "RECOVERY_PRECONDITION_FAILED"],
    // Unreadable evidence outranks a failing check: "we could not look" is a
    // weaker position than "we looked and it does not hold".
    ["unknown position state", { positionQuantity: unavailable("position read failed") }, "EVIDENCE_INCOMPLETE"],
    ["unknown stop coverage", { activeStopQuantity: unavailable("algo read failed") }, "EVIDENCE_INCOMPLETE"],
    ["unknown take-profit coverage", { activeTakeProfitQuantity: unavailable("algo read failed") }, "EVIDENCE_INCOMPLETE"],
    ["unknown stop placeability", { stopTriggerPlaceable: unavailable("mark price unreadable") }, "EVIDENCE_INCOMPLETE"],
    ["missing protection row", { protectionState: unavailable("no protection row exists") }, "EVIDENCE_INCOMPLETE"],
    ["missing recorded fill", { recordedFillQuantity: unavailable("no filled quantity") }, "EVIDENCE_INCOMPLETE"],
  ];

  for (const [label, override, expected] of cases) {
    it(`refuses: ${label}`, () => {
      const verdict = judgeProtectionRecovery(enjEvidence(override));
      expect(verdict.safe, label).toBe(false);
      if (!verdict.safe) {
        expect(verdict.reasonCode, label).toBe(expected);
        expect(verdict.blockers.length, label).toBeGreaterThan(0);
      }
    });
  }

  it("a blank quantity is UNKNOWN, never silently zero", () => {
    // Number("") is 0, so a blank would otherwise read as a flat position.
    const verdict = judgeProtectionRecovery(enjEvidence({ positionQuantity: gathered("   ") }));
    expect(verdict.safe).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C. An existing stop must not become a duplicate
// ---------------------------------------------------------------------------

describe("C. a position that is already stopped", () => {
  it("is still safe to re-admit, and says so", () => {
    // Refusing here would leave a correctly-stopped position parked for no
    // reason; the lifecycle reconciles and places nothing.
    const verdict = judgeProtectionRecovery(enjEvidence({ activeStopQuantity: gathered("2631") }));
    expect(verdict.safe).toBe(true);
    expect(verdict.alreadyStopped).toBe(true);
  });

  it("is not reported as already stopped when coverage is partial", () => {
    const verdict = judgeProtectionRecovery(enjEvidence({ activeStopQuantity: gathered("1000") }));
    expect(verdict.alreadyStopped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// J/K/L/M. Operator-state gating
// ---------------------------------------------------------------------------

describe("the durable posture guard", () => {
  it("K/L. permits exactly SAFE_OFF and SAFE_RECOVERY", () => {
    // SAFE_OFF: disabled + kill switch. SAFE_RECOVERY: enabled + kill switch —
    // the state a real incident actually leaves behind.
    expect(judgeRecoveryPosture({ isEnabled: false, killSwitchActive: true, availableWindows: 0 })).toMatchObject({
      allowed: true,
      systemState: "SAFE_OFF",
    });
    expect(judgeRecoveryPosture({ isEnabled: true, killSwitchActive: true, availableWindows: 0 })).toMatchObject({
      allowed: true,
      systemState: "SAFE_RECOVERY",
    });
  });

  it("J. REFUSES while ARMED", () => {
    const verdict = judgeRecoveryPosture({ isEnabled: true, killSwitchActive: false, availableWindows: 0 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.systemState).toBe("ARMED");
  });

  it("REFUSES an unreadable or incoherent posture — 'could not tell' is not permission", () => {
    for (const input of [
      { isEnabled: false, killSwitchActive: false },
      { isEnabled: null, killSwitchActive: true },
      { isEnabled: undefined, killSwitchActive: undefined },
    ]) {
      expect(judgeRecoveryPosture({ ...input, availableWindows: 0 }).allowed).toBe(false);
    }
  });

  it("M. REFUSES while a natural window is still AVAILABLE", () => {
    const verdict = judgeRecoveryPosture({ isEnabled: true, killSwitchActive: true, availableWindows: 1 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/natural authorization window/i);
  });

  it("does NOT require zero active executions — the stranded row is itself active", () => {
    expect(judgeRecoveryPosture({ isEnabled: true, killSwitchActive: true, availableWindows: 0 }).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The CLI boundary
// ---------------------------------------------------------------------------

const EXECUTION_ID = "cmt82ziwr000e7y9jnas7l14q";

/** The profile this fake process is bound to. */
const BOUND_PROFILE_ID = "profile-1";

function deps(overrides: { evaluate?: unknown; recover?: unknown; execution?: unknown } = {}) {
  const calls = { evaluate: 0, recover: 0 };
  const execution =
    overrides.execution === undefined
      ? {
          id: EXECUTION_ID,
          symbol: "ENJUSDT",
          positionSide: "SHORT",
          status: "MANUAL_INTERVENTION",
          version: 280,
          decisionReasonCode: RECOVERABLE_PROTECTION_REASON,
        }
      : overrides.execution;

  return {
    calls,
    prisma: {
      // Selected by id AND by the bound profile, in one predicate. The fake
      // HONOURS the predicate, so dropping it fails these tests rather than
      // passing unnoticed.
      tradeExecution: {
        findFirst: async (args: { where?: { executionProfileId?: string } }) =>
          args?.where?.executionProfileId === BOUND_PROFILE_ID ? execution : null,
        count: async () => (execution ? 1 : 0),
      },
      executionCanaryAuthorization: { findMany: async () => [] },
      // The posture guard resolves the configured profile before it will let
      // `recover` reach the service, so the fake has to answer that too.
      executionProfile: {
        findMany: async () => [
          {
            id: "profile-1",
            isEnabled: true,
            // enabled + kill switch = SAFE_RECOVERY, the state a real incident
            // leaves behind and the one this command must work in.
            safetyPolicy: { killSwitchActive: true },
          },
        ],
      },
    } as never,
    recovery: {
      // What the CLI prints about ownership comes from the service, never
      // from a second resolution of its own.
      boundExecutionProfileId: BOUND_PROFILE_ID,
      evaluate: async () => {
        calls.evaluate += 1;
        return overrides.evaluate ?? { verdict: judgeProtectionRecovery(enjEvidence()), evidence: enjEvidence() };
      },
      recover: async () => {
        calls.recover += 1;
        return (
          overrides.recover ?? {
            ok: true,
            outcome: "RECOVERY_ATTEMPTED",
            executionId: EXECUTION_ID,
            message: "Stop is verified; the take profit was not placeable.",
            checks: ["stopTriggerPlaceable"],
            blockers: [],
            status: "PLACING_PROTECTION",
            protectionState: "PROTECTION_INCOMPLETE",
            protectionReasonCode: RECOVERABLE_PROTECTION_REASON,
          }
        );
      },
    } as never,
    protection: {} as never,
  };
}

describe("evaluate is read-only and takes exactly one id", () => {
  it("requires exactly one execution id", async () => {
    const d = deps();
    expect((await evaluateCommand([], d)).exitCode).toBe(CLI_EXIT.USAGE);
    expect((await evaluateCommand([EXECUTION_ID, "extra"], d)).exitCode).toBe(CLI_EXIT.USAGE);
    expect(d.calls.evaluate).toBe(0);
  });

  it("calls evaluate once and NEVER recover", async () => {
    const d = deps();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await evaluateCommand([EXECUTION_ID], d);
    spy.mockRestore();
    expect(d.calls.evaluate).toBe(1);
    expect(d.calls.recover).toBe(0);
  });

  it("exits NON-ZERO when recovery is not safe, so it works as a check", async () => {
    const blocked = judgeProtectionRecovery(enjEvidence({ stopTriggerPlaceable: gathered(false) }));
    const d = deps({ evaluate: { verdict: blocked, evidence: enjEvidence() } });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await evaluateCommand([EXECUTION_ID], d);
    spy.mockRestore();
    expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
  });
});

describe("recover requires the exact token and posture", () => {
  it("REFUSES with no token, a wrong token, or a generic affirmative", async () => {
    for (const token of [undefined, "yes", "y", "true", "--force", "--confirm"]) {
      const d = deps();
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const argv = token === undefined ? [EXECUTION_ID] : [EXECUTION_ID, token];
      const result = await recoverCommand(argv, d);
      spy.mockRestore();
      expect(result.exitCode, String(token)).toBe(CLI_EXIT.REFUSED);
      expect(d.calls.recover, String(token)).toBe(0);
    }
  });

  it("the token states the claim being made and is not guessable", () => {
    expect(RECOVER_CONFIRMATION).toBe("--confirm-protection-recovery");
    expect(RECOVER_CONFIRMATION.length).toBeGreaterThan(20);
  });

  it("REFUSES to reach the service without the protection lifecycle wired", async () => {
    // `evaluate` is never handed it, so a mis-wired call cannot mutate.
    const d = { ...deps(), protection: undefined };
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await recoverCommand([EXECUTION_ID, RECOVER_CONFIRMATION], d);
    spy.mockRestore();
    expect(result.exitCode).toBe(CLI_EXIT.REFUSED);
    expect(d.calls.recover).toBe(0);
  });

  it("the exact token with a permitted posture proceeds to the service", async () => {
    const d = deps();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await recoverCommand([EXECUTION_ID, RECOVER_CONFIRMATION], d);
    spy.mockRestore();
    expect(result.exitCode).toBe(CLI_EXIT.OK);
    expect(d.calls.recover).toBe(1);
  });

  it("D. a second run calls the service again and reports its idempotent result", async () => {
    // The CLI does not memoise. Idempotency is the lifecycle's job, and it
    // reports "already covered" rather than placing a second stop.
    const d = deps({
      recover: {
        ok: true,
        outcome: "RECOVERY_ATTEMPTED",
        executionId: EXECUTION_ID,
        message: "Aggregate coverage matches exposure.",
        checks: [],
        blockers: [],
        status: "PROTECTED",
        protectionState: "PROTECTED",
        protectionReasonCode: "PROTECTION_VERIFIED",
      },
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await recoverCommand([EXECUTION_ID, RECOVER_CONFIRMATION], d);
    await recoverCommand([EXECUTION_ID, RECOVER_CONFIRMATION], d);
    spy.mockRestore();
    expect(d.calls.recover).toBe(2);
  });

  it("an unrecognised subcommand prints usage and exits 2", async () => {
    const d = deps();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const argv of [[], ["list"], ["recover-all"], ["--force"]]) {
      expect((await runProtectionRecoveryCli(argv, d)).exitCode).toBe(CLI_EXIT.USAGE);
    }
    spy.mockRestore();
    expect(d.calls.recover).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// O/U/P. Structural guarantees
// ---------------------------------------------------------------------------

describe("structural guarantees", () => {
  const service = codeOf("src/modules/execution/protection-recovery.service.ts");
  const cli = codeOf("src/modules/execution/protection-recovery-cli.ts");
  const runner = codeOf("src/modules/execution/run-protection-recovery.ts");
  const lifecycle = codeOf("src/modules/execution/protection-lifecycle.service.ts");

  it("O/U. automatic recovery is UNCHANGED — the reason stays off the list", () => {
    const list = lifecycle.slice(
      lifecycle.indexOf("RECOVERABLE_INTERVENTION_REASON_CODES: readonly"),
      lifecycle.indexOf("function isRecoverableInterventionReason")
    );
    expect(list).toContain("STOP_NOT_VERIFIED");
    expect(list).toContain("STOP_IDENTITY_MISMATCH");
    expect(list).toContain("STOP_SUBMISSION_RESULT_UNKNOWN");
    // The whole point: a scheduled tick must still refuse this reason.
    expect(list).not.toContain("TAKE_PROFIT_TRIGGER_INVALID");
  });

  it("the operator authorization only counts for the reason it names", () => {
    // It can never turn some OTHER intervention into a recoverable one.
    expect(lifecycle).toContain("input.operatorApproval.reasonCode === protection.reasonCode");
    expect(lifecycle).toContain("!isRecoverableInterventionReason(protection.reasonCode) && !operatorApproved");
  });

  it("the evaluator cannot place or cancel an order", () => {
    // It holds only the read-only client; the mutation client is not imported.
    for (const forbidden of ["BinanceUsdMExecutionClient", "placeOrder", "cancelOrder", "newOrder", "submitOrder"]) {
      expect(`service ${forbidden}:${service.includes(forbidden)}`).toBe(`service ${forbidden}:false`);
      expect(`cli ${forbidden}:${cli.includes(forbidden)}`).toBe(`cli ${forbidden}:false`);
    }
  });

  it("the mutation client is built ONLY for recover", () => {
    // Read-only-ness of `evaluate` is a property of the wiring, not of a code
    // path remembering to be careful.
    expect(runner).toContain('argv[0] === "recover"');
    expect(runner).toContain("BinanceUsdMExecutionClient");
  });

  it("P. recovery does not force a status — the lifecycle decides", () => {
    // No status is written by this feature; `attemptProtectionRecovery` and
    // `ensureProtectionForExposure` own that, so a PROTECTED claim can only
    // come from measured coverage.
    for (const forbidden of ['status: "PROTECTED"', "markExecutionProtected", "tradeExecution.update"]) {
      expect(`${forbidden}:${service.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    expect(service).toContain("attemptProtectionRecovery(");
  });

  it("has no bulk, wildcard or force mode", () => {
    for (const forbidden of ["--all", "--yes", "--skip", "argv.includes", "argv.some", "findMany({ where: { status"]) {
      expect(`cli ${forbidden}:${cli.includes(forbidden)}`).toBe(`cli ${forbidden}:false`);
    }
  });

  it("delegates evidence to the pure judge rather than re-deciding", () => {
    expect(service).toContain("judgeProtectionRecovery(");
    expect(cli).not.toContain("judgeProtectionRecovery(");
  });

  it("never prints a secret or a raw payload", () => {
    for (const forbidden of ["apiKey", "apiSecret", "OPERATOR_API_TOKEN", "DATABASE_URL", "tokenHash", "rawPayload"]) {
      expect(`cli ${forbidden}:${cli.includes(forbidden)}`).toBe(`cli ${forbidden}:false`);
      expect(`service ${forbidden}:${service.includes(forbidden)}`).toBe(`service ${forbidden}:false`);
    }
  });

  it("is registered as an execution: script, matching repository convention", () => {
    const pkg = readFileSync(path.join(BACKEND, "package.json"), "utf8");
    expect(pkg).toContain('"execution:protection-recovery": "tsx src/modules/execution/run-protection-recovery.ts"');
  });
});
