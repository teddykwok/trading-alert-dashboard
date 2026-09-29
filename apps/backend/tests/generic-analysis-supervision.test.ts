import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ROLE_CONTRACTS,
  censusOf,
  classifyEntrypoint,
  dualSpawnPlan,
  projectTopology,
  type ObservedListener,
  type ObservedProcess,
} from "../src/modules/operator/dual-account-topology";
import {
  GENERIC_ANALYSIS_ROLE,
  decideGenericAnalysisSupervision,
  genericAnalysisHealth,
  genericBackendHealth,
  leafRuntimeCount,
  renderGenericAnalysisSupervision,
} from "../src/modules/operator/generic-analysis-supervision";
import {
  EMPTY_RESTART_BUDGET,
  WORKER_RESTART_MAX_ATTEMPTS,
  WORKER_RESTART_STABILIZATION_MS,
  observeWorkerHealth,
  recordRestartAttempt,
  workerRestartQuietPeriodMs,
  type RestartBudget,
  decideWorkerSupervision,
  executeWorkerRestart,
  type ProcessProbe,
} from "../src/modules/operator/worker-supervision";

/**
 * Supervision for the generic analysis role.
 *
 * ## The incident, in one sentence
 *
 * On 2026-09-28 at 07:26:49Z the vision-analysis LEAF runtime exited mid-job
 * and its `tsx watch` wrapper did not, so the launcher's ownership record kept
 * verifying against a tree with nothing inside it for fifty minutes while two
 * queues and four schedulers stayed dead.
 *
 * Everything below is pure. No process is probed, spawned or terminated, no
 * database or Redis client is constructed, and no exchange call is reachable.
 */

const ANALYSIS = ROLE_CONTRACTS[GENERIC_ANALYSIS_ROLE].entrypoint;
const BACKEND_ENTRY = ROLE_CONTRACTS["generic-backend"].entrypoint;
const REPO = path.join("C:", "repo");

/** A LEAF runtime: the tsx child, which is what actually does the work. */
function leaf(entrypoint: string, pid: number): ObservedProcess {
  return {
    pid,
    startedAtMs: 1_000,
    commandLine: `"C:\\Program Files\\nodejs\\node.exe" --require preflight.cjs ${entrypoint}`,
  };
}

/** The tsx WATCHER: carries the entrypoint, supervises it, and is not it. */
function watcher(entrypoint: string, pid: number): ObservedProcess {
  return {
    pid,
    startedAtMs: 1_000,
    commandLine: `node "C:\\repo\\apps\\backend\\node_modules\\.bin\\..\\tsx\\dist\\cli.mjs" "watch" "${entrypoint}"`,
  };
}

/** The pnpm wrapper above the watcher. Also carries the entrypoint. */
function pnpmWrapper(entrypoint: string, pid: number): ObservedProcess {
  return {
    pid,
    startedAtMs: 1_000,
    commandLine: `"node.exe" C:/Users/x/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.mjs exec tsx watch ${entrypoint}`,
  };
}

const LISTENERS: ObservedListener[] = [{ port: 4000, address: "0.0.0.0", pid: 11 }];

function statusOf(processes: ObservedProcess[], ownedRoles: string[] = []) {
  return projectTopology({
    census: censusOf(processes, LISTENERS),
    ownedRoles: ownedRoles as never,
    attestation: {},
  });
}

/** The healthy generic half: one backend leaf, one analysis leaf. */
const HEALTHY_PROCESSES = [leaf(BACKEND_ENTRY, 11), leaf(ANALYSIS, 12)];

/**
 * THE INCIDENT: the backend leaf is fine, and the analysis role is a pnpm
 * wrapper plus a tsx watcher with NO child.
 */
const WRAPPER_ONLY_PROCESSES = [
  leaf(BACKEND_ENTRY, 11),
  pnpmWrapper(ANALYSIS, 90),
  watcher(ANALYSIS, 91),
];

const RECORD = { pid: 90, startedAtMs: 1_000 };
const OWNED = { owned: true } as const;

function decide(over: Partial<Parameters<typeof decideGenericAnalysisSupervision>[0]> = {}) {
  return decideGenericAnalysisSupervision({
    record: RECORD,
    ownership: OWNED,
    status: statusOf(WRAPPER_ONLY_PROCESSES, [GENERIC_ANALYSIS_ROLE]),
    budget: EMPTY_RESTART_BUDGET,
    nowMs: 10_000_000,
    hasRuntimeState: true,
    ...over,
  });
}

// ===========================================================================
// The health signal
// ===========================================================================

describe("the leaf-runtime health signal", () => {
  it("counts LEAF runtimes only — a wrapper is not the role", () => {
    // The pre-existing exclusion this whole feature rests on. If either wrapper
    // kind were ever counted, a dead runtime would read as a live one.
    expect(classifyEntrypoint(leaf(ANALYSIS, 1).commandLine)).toBe(ANALYSIS);
    expect(classifyEntrypoint(watcher(ANALYSIS, 1).commandLine)).toBeNull();
    expect(classifyEntrypoint(pnpmWrapper(ANALYSIS, 1).commandLine)).toBeNull();

    expect(leafRuntimeCount(statusOf(WRAPPER_ONLY_PROCESSES), GENERIC_ANALYSIS_ROLE)).toBe(0);
    expect(leafRuntimeCount(statusOf(HEALTHY_PROCESSES), GENERIC_ANALYSIS_ROLE)).toBe(1);
  });

  it("reads an owned tree with no runtime inside it as STALE, not healthy", () => {
    // `presence` cannot express this: it answers OWNED from the ownership set
    // alone, which is exactly why the incident was invisible.
    const status = statusOf(WRAPPER_ONLY_PROCESSES, [GENERIC_ANALYSIS_ROLE]);
    const view = status.roles.find((role) => role.role === GENERIC_ANALYSIS_ROLE);
    expect(view?.presence).toBe("OWNED");
    expect(genericAnalysisHealth({ status, ownedRootAlive: true })).toBe("STALE");
  });

  it("maps the remaining cases", () => {
    const none = statusOf([leaf(BACKEND_ENTRY, 11)]);
    expect(genericAnalysisHealth({ status: none, ownedRootAlive: false })).toBe("OFF");
    expect(genericAnalysisHealth({ status: statusOf(HEALTHY_PROCESSES), ownedRootAlive: true })).toBe("HEALTHY");
    const two = statusOf([leaf(BACKEND_ENTRY, 11), leaf(ANALYSIS, 12), leaf(ANALYSIS, 13)]);
    expect(genericAnalysisHealth({ status: two, ownedRootAlive: true })).toBe("DUPLICATE");
  });

  it("judges the generic backend the same owner-blind way", () => {
    expect(genericBackendHealth(statusOf(HEALTHY_PROCESSES))).toBe("HEALTHY");
    expect(genericBackendHealth(statusOf([leaf(ANALYSIS, 12)]))).toBe("OFF");
    expect(genericBackendHealth(statusOf([leaf(BACKEND_ENTRY, 11), leaf(BACKEND_ENTRY, 12)]))).toBe("DUPLICATE");
  });
});

// ===========================================================================
// A–H: the decision contract
// ===========================================================================

describe("generic analysis supervision decisions", () => {
  it("A. a healthy launcher-owned runtime is a NOOP — nothing killed, nothing spawned", () => {
    const decision = decide({
      status: statusOf(HEALTHY_PROCESSES, [GENERIC_ANALYSIS_ROLE]),
    });
    expect(decision.action).toBe("NONE");
    expect(decision.state).toBe("WORKER_HEALTHY");
    expect(decision.reasonCode).toBe("HEALTHY");
    expect(decision.terminatePid).toBeNull();
  });

  it("B. THE PRODUCTION INCIDENT: owned wrapper, no leaf -> bounded restart", () => {
    // Owned root alive, zero analysis leaves, generic backend fine. This is the
    // exact 07:26:49Z state, and before this slice nothing acted on it.
    const decision = decide();
    expect(decision.action).toBe("TERMINATE_THEN_RESTART");
    expect(decision.state).toBe("WORKER_STALE");
    expect(decision.reasonCode).toBe("WORKER_STALE");
    // The owned tree is terminated first, so the replacement cannot become a
    // second consumer on the same queues.
    expect(decision.terminatePid).toBe(RECORD.pid);
    expect(decision.message).toContain("wrapper survived");
  });

  it("B. a tree that is entirely gone is restarted without terminating anything", () => {
    const decision = decide({
      ownership: { owned: false, reason: "GONE" },
      status: statusOf([leaf(BACKEND_ENTRY, 11)]),
    });
    expect(decision.action).toBe("RESTART");
    expect(decision.reasonCode).toBe("WORKER_EXITED");
    expect(decision.terminatePid).toBeNull();
  });

  it("C. an EXTERNAL analysis runtime is never killed and never duplicated", () => {
    // A leaf is running; this launcher has no record of it. Supervision owns
    // nothing, so it must not stop it, adopt it, or start a second one.
    const decision = decide({
      record: null,
      ownership: null,
      status: statusOf(HEALTHY_PROCESSES, []),
    });
    expect(decision.action).toBe("NONE");
    expect(decision.terminatePid).toBeNull();
    expect(decision.reasonCode).toBe("NO_WORKER_RECORDED");
    expect(decision.message).toContain("did not start it");
    expect(decision.message).toContain("not be stopped, adopted or duplicated");
  });

  it("C. an external leaf beside an owned wrapper still blocks a restart", () => {
    // The dangerous shape: our tree is hollow, but somebody else's runtime is
    // already draining the queue. Counting leaves owner-blind is what stops a
    // second consumer being added here.
    const decision = decide({
      status: statusOf([...WRAPPER_ONLY_PROCESSES, leaf(ANALYSIS, 77)], [GENERIC_ANALYSIS_ROLE]),
    });
    expect(decision.action).toBe("NONE");
    expect(decision.state).toBe("WORKER_HEALTHY");
  });

  it("C. our tree is GONE but somebody else is running one -> still no spawn", () => {
    // The duplicate-consumer trap, and the one an owner-aware leaf count would
    // walk straight into: our recorded tree has exited, so there is nothing to
    // terminate and the ladder would happily RESTART -- except that a runtime
    // IS already draining these queues. Counting leaves owner-blind is the only
    // thing standing between this state and two competing consumers.
    const decision = decide({
      ownership: { owned: false, reason: "GONE" },
      status: statusOf([leaf(BACKEND_ENTRY, 11), leaf(ANALYSIS, 77)], []),
    });
    expect(decision.action).toBe("NONE");
    expect(decision.state).toBe("WORKER_HEALTHY");
    expect(decision.terminatePid).toBeNull();
  });

  it("C. two leaves are never resolved by adding or removing one", () => {
    const decision = decide({
      status: statusOf([leaf(BACKEND_ENTRY, 11), leaf(ANALYSIS, 12), leaf(ANALYSIS, 13)], [GENERIC_ANALYSIS_ROLE]),
    });
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("WORKER_DUPLICATE");
    expect(decision.message).toContain("2 generic analysis runtimes");
  });

  it("D. a stale/reused ownership PID fails closed — no kill, no spawn", () => {
    for (const reason of ["PID_REUSED", "NOT_THIS_REPO"] as const) {
      const decision = decide({ ownership: { owned: false, reason } });
      expect(`${reason}:${decision.action}`).toBe(`${reason}:NONE`);
      expect(decision.reasonCode).toBe("OWNERSHIP_UNPROVEN");
      expect(decision.terminatePid).toBeNull();
      expect(decision.message).toContain("Nothing was terminated and nothing was started");
    }
  });

  it("D. no runtime state at all means nothing is owned and nothing is done", () => {
    const decision = decide({ hasRuntimeState: false, record: null, ownership: null });
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("NO_RUNTIME_RECORDED");
  });

  it("refuses to repair half a runtime when the generic backend is down", () => {
    const decision = decide({
      status: statusOf([pnpmWrapper(ANALYSIS, 90), watcher(ANALYSIS, 91)], [GENERIC_ANALYSIS_ROLE]),
    });
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("BACKEND_NOT_HEALTHY");
  });

  it("G/H. a replacement that never produces a leaf exhausts the budget and stops", () => {
    // Bounded recovery: each pass restarts once, waits out stabilization and
    // backoff, and after the reviewed maximum gives an explicit failure rather
    // than looping forever.
    let budget: RestartBudget = EMPTY_RESTART_BUDGET;
    let nowMs = 10_000_000;
    const actions: string[] = [];

    for (let pass = 0; pass < 12; pass += 1) {
      const decision = decide({ budget, nowMs });
      actions.push(decision.action);
      if (decision.action !== "NONE") {
        budget = recordRestartAttempt(budget, nowMs);
      }
      if (decision.state === "WORKER_RECOVERY_FAILED") break;
      // The leaf never appears, so every observation breaks the healthy streak.
      budget = observeWorkerHealth(budget, "STALE", nowMs);
      nowMs += workerRestartQuietPeriodMs(budget.attempts + 1) + 1_000;
    }

    expect(actions.filter((a) => a !== "NONE")).toHaveLength(WORKER_RESTART_MAX_ATTEMPTS);
    const final = decide({ budget, nowMs });
    expect(final.action).toBe("NONE");
    expect(final.state).toBe("WORKER_RECOVERY_FAILED");
    expect(final.reasonCode).toBe("RESTART_BUDGET_EXHAUSTED");
    expect(final.message).toContain(String(WORKER_RESTART_MAX_ATTEMPTS));
  });

  it("H. a freshly started replacement is left alone inside its stabilization window", () => {
    const budget = recordRestartAttempt(EMPTY_RESTART_BUDGET, 10_000_000);
    const decision = decide({ budget, nowMs: 10_000_000 + WORKER_RESTART_STABILIZATION_MS - 1 });
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("STABILIZING");
  });

  it("H. and then waits out the backoff before spending the next attempt", () => {
    const budget = recordRestartAttempt(EMPTY_RESTART_BUDGET, 10_000_000);
    const decision = decide({ budget, nowMs: 10_000_000 + WORKER_RESTART_STABILIZATION_MS + 1 });
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("BACKOFF_PENDING");
  });

  it("renders state and attempts, and never a path or a secret", () => {
    const decision = decide();
    const lines = renderGenericAnalysisSupervision(decision, { attempts: 2, lastAttemptAtMs: 1, healthySinceMs: null });
    expect(lines[0]).toContain("Generic Analysis Worker supervision: WORKER_STALE");
    expect(lines[0]).toContain(`restart attempts 2/${WORKER_RESTART_MAX_ATTEMPTS}`);
    for (const line of lines) {
      expect(line).not.toMatch(/[A-Za-z]:\\|\/Users\/|BINANCE_|OPERATOR_API_TOKEN|postgres|redis/i);
    }
  });
});

// ===========================================================================
// E/F: replacement semantics
// ===========================================================================

describe("the replacement a restart would spawn", () => {
  it("E/F. binds the GENERIC env file through the existing spawn plan", () => {
    const plan = dualSpawnPlan(GENERIC_ANALYSIS_ROLE, REPO, {
      LOCALAPPDATA: path.join("C:", "Users", "x", "AppData", "Local"),
      ComSpec: "cmd.exe",
    } as NodeJS.ProcessEnv);
    expect(String(plan.options.env?.DOTENV_CONFIG_PATH)).toContain(`generic.env`);
    expect(String(plan.options.env?.DOTENV_CONFIG_PATH)).not.toContain("account-a");
    expect(String(plan.options.env?.DOTENV_CONFIG_PATH)).not.toContain("account-b");
    // The same reviewed pnpm invocation every start uses; no ad-hoc command.
    expect(plan.args).toContain(ROLE_CONTRACTS[GENERIC_ANALYSIS_ROLE].filter);
    expect(plan.args).toContain(ROLE_CONTRACTS[GENERIC_ANALYSIS_ROLE].script);
  });

  it("F. inherited ACCOUNT identity and credentials cannot leak into the replacement", () => {
    const plan = dualSpawnPlan(GENERIC_ANALYSIS_ROLE, REPO, {
      LOCALAPPDATA: path.join("C:", "Users", "x", "AppData", "Local"),
      ComSpec: "cmd.exe",
      BINANCE_API_KEY: "inherited-key",
      BINANCE_API_SECRET: "inherited-secret",
      EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "inherited-account",
    } as NodeJS.ProcessEnv);
    const childEnv = plan.options.env ?? {};
    for (const key of ["BINANCE_API_KEY", "BINANCE_API_SECRET", "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER"]) {
      expect(`${key}=${childEnv[key] ?? "(absent)"}`).toBe(`${key}=(absent)`);
    }
  });
});

// ===========================================================================
// J: what supervision is structurally unable to reach
// ===========================================================================

describe("generic analysis supervision reaches nothing it should not", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/modules/operator/generic-analysis-supervision.ts"),
    "utf8"
  );
  const cli = readFileSync(
    path.join(process.cwd(), "src/modules/operator/run-runtime-launcher.ts"),
    "utf8"
  );

  /**
   * Source with comments AND string literals removed.
   *
   * This module PRINTS the words `adopted` and `backoff` -- in sentences that
   * promise the opposite -- so a raw substring ban would be satisfied by
   * deleting the explanation instead of the mechanism. These assertions are
   * about code.
   */
  const codeOnly = (text: string): string =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
      .replace(/`(?:[^`\\]|\\.)*`/g, '""')
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, '""');
  const moduleCode = codeOnly(source);

  it("J. the decision module imports no database, queue, exchange or trading module", () => {
    for (const forbidden of [
      "@prisma/client",
      "plugins/prisma",
      "ioredis",
      "bullmq",
      "binance",
      "canary-authorization",
      "safety-policy",
      "safety-admission",
      "trading-session",
      "execution-orchestrator",
    ]) {
      expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("J. and there is no adoption path from a detected process to an owned one", () => {
    // Mechanism, not vocabulary: nothing here may turn a DETECTED process into
    // an owned one, and the only presence promotion lives in the topology
    // module, from the ownership set alone.
    for (const forbidden of ["adopt", "claimExisting", "takeOver", "OWNED"]) {
      expect(`${forbidden}:${moduleCode.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // The only way a record reaches this module is as an input the caller read
    // from launcher state; it never discovers one.
    expect(moduleCode).not.toContain("readState");
    expect(moduleCode).not.toContain("observeProcesses");
  });

  it("7. the launcher action spawns and terminates the generic analysis role ONLY", () => {
    const action = cli.slice(
      cli.indexOf("async function superviseGenericAnalysis"),
      cli.indexOf("// Menu")
    );
    // The action itself no longer spawns or kills anything: it hands its role
    // to the ONE shared, fenced restart path. That is what stops the two
    // supervisors drifting apart again.
    expect(action).toContain("restartOwnedRole(now.decision, GENERIC_ANALYSIS_ROLE, now.budget.attempts + 1)");
    expect(action.match(/spawn\(plan\.command/g) ?? []).toHaveLength(0);
    expect(action.match(/terminateTree\(/g) ?? []).toHaveLength(0);
    for (const otherRole of [
      "generic-backend",
      "account-a-control",
      "account-a-worker",
      "account-b-control",
      "account-b-worker",
    ]) {
      expect(`${otherRole}:${action.includes(otherRole)}`).toBe(`${otherRole}:false`);
    }
    // The re-proof, the refusal to spawn after a failed re-proof, the post-kill
    // exit proof and the fresh pre-spawn census are all inside
    // `executeWorkerRestart` now, where they are proven BEHAVIOURALLY rather
    // than by matching this file's text. The previous review flagged that
    // weakness explicitly; see tests/worker-supervision.test.ts.
    expect(cli).toContain("executeWorkerRestart(");
  });

  it("7. it is its own menu action, not bundled into account supervision", () => {
    expect(cli).toContain('console.log("7. Supervise Generic Analysis");');
    expect(cli).toContain('else if (choice === "7") await superviseGenericAnalysis(ask);');
    // Account supervision still has its own entries and is unchanged.
    expect(cli).toContain('else if (choice === "5") await superviseAccountWorker("ACCOUNT_A", ask);');
    expect(cli).toContain('else if (choice === "6") await superviseAccountWorker("ACCOUNT_B", ask);');
  });

  it("8. the reviewed account ladder is reused, not reimplemented", () => {
    expect(source).toContain('from "./worker-supervision"');
    expect(source).toContain("decideWorkerSupervision(");
    // No second budget, backoff, ceiling or timer is DEFINED here. The words
    // appear in operator text; the declarations must not.
    for (const forbidden of [
      /export\s+const\s+[A-Z_]*MAX_ATTEMPTS/,
      /export\s+const\s+[A-Z_]*BACKOFF/,
      /export\s+const\s+[A-Z_]*STABILIZATION/,
      /setInterval|setTimeout/,
      /function\s+\w*[Bb]ackoff/,
    ]) {
      expect(`${forbidden.source}:${forbidden.test(moduleCode)}`).toBe(`${forbidden.source}:false`);
    }
    // The ceiling it reports is the account supervisor's own constant.
    expect(moduleCode).toContain("WORKER_RESTART_MAX_ATTEMPTS");
  });
});


// ===========================================================================
// Restart fencing, exercised for the GENERIC ANALYSIS role specifically
//
// The sequence itself lives in `executeWorkerRestart` and is shared with the
// account workers. These cases prove the generic role reaches it with its own
// role name and gets the same refusals -- so the two supervisors cannot drift
// apart again the way they did before this slice.
// ===========================================================================

describe("generic analysis restart fencing", () => {
  const GENERIC_PID = 7777;
  const STARTED = 1_700_000_000_000;
  const RECORD = { role: GENERIC_ANALYSIS_ROLE, pid: GENERIC_PID, startedAtMs: STARTED };
  const STATE = { repoRoot: REPO, processes: [RECORD] };
  const OURS = {
    pid: GENERIC_PID,
    startedAtMs: STARTED,
    commandLine: `cmd.exe /d /s /c pnpm -C ${REPO} --filter pkg worker`,
  };

  function box(
    options: {
      processes?: Map<number, ProcessProbe>;
      unaccounted?: number | null;
      /** The machine cannot be observed at all. */
      unobservable?: boolean;
    } = {}
  ) {
    const processes = options.processes ?? new Map<number, ProcessProbe>();
    const terminated: number[] = [];
    const spawned: number[] = [];
    return {
      terminated,
      spawned,
      adapters: {
        probe: (pid: number) =>
          options.unobservable
            ? ({ observed: false } as const)
            : ({ observed: true, process: processes.get(pid) ?? null } as const),
        terminate: (pid: number) => {
          terminated.push(pid);
          processes.delete(pid);
          return true;
        },
        unaccountedLeaves: () => (options.unaccounted === undefined ? 0 : options.unaccounted),
        spawnWorker: () => {
          spawned.push(9100);
          // A spawn produces a process the probe can SEE. Without this the
          // fake machine hands back a pid with no creation time, which the
          // fenced start correctly refuses to record as owned -- a property of
          // the harness rather than of the code under test.
          processes.set(9100, {
            pid: 9100,
            startedAtMs: STARTED + 1_000,
            commandLine: `pnpm -C ${REPO} generic-analysis`,
          });
          return 9100;
        },
        log: () => undefined,
      },
    };
  }

  const staleDecision = () =>
    decideWorkerSupervision({
      record: { role: "worker", pid: GENERIC_PID, startedAtMs: STARTED },
      ownership: { owned: true },
      workerHealth: "STALE",
      backendHealth: "HEALTHY",
      budget: EMPTY_RESTART_BUDGET,
      nowMs: STARTED + 600_000,
      hasRuntimeState: true,
    });

  it("3. a non-GONE re-proof terminates NOTHING and spawns NOTHING", () => {
    for (const [label, stranger] of [
      ["PID_REUSED", { ...OURS, startedAtMs: STARTED + 60_000 }],
      ["NOT_THIS_REPO", { ...OURS, commandLine: "cmd.exe /d /s /c pnpm -C C:\\elsewhere --filter pkg worker" }],
    ] as const) {
      const machine = box({ processes: new Map([[GENERIC_PID, stranger as ProcessProbe]]) });
      const result = executeWorkerRestart(
        staleDecision(),
        STATE,
        1,
        machine.adapters,
        GENERIC_ANALYSIS_ROLE
      );
      expect(`${label}:${result.outcome}`).toBe(`${label}:OWNERSHIP_LOST`);
      expect(`${label}:terminated=${machine.terminated.length}`).toBe(`${label}:terminated=0`);
      expect(`${label}:spawned=${machine.spawned.length}`).toBe(`${label}:spawned=0`);
    }
  });

  it("4. a generic tree that survives the kill spawns nothing", () => {
    const processes = new Map([[GENERIC_PID, OURS]]);
    const machine = {
      terminated: [] as number[],
      spawned: [] as number[],
      adapters: {
        probe: (pid: number) => ({ observed: true, process: processes.get(pid) ?? null } as const),
        // The kill "succeeds" but the tree is still there.
        terminate: (pid: number) => {
          machine.terminated.push(pid);
          return true;
        },
        unaccountedLeaves: () => 0,
        spawnWorker: () => {
          machine.spawned.push(9100);
          return 9100;
        },
        log: () => undefined,
      },
    };
    const result = executeWorkerRestart(staleDecision(), STATE, 1, machine.adapters, GENERIC_ANALYSIS_ROLE);
    expect(result.outcome).toBe("TERMINATION_FAILED");
    expect(machine.terminated).toEqual([GENERIC_PID]);
    expect(machine.spawned).toEqual([]);
  });

  it("5. a generic tree proven gone yields exactly one replacement, recorded as generic", () => {
    const machine = box({ processes: new Map([[GENERIC_PID, OURS]]) });
    const result = executeWorkerRestart(staleDecision(), STATE, 1, machine.adapters, GENERIC_ANALYSIS_ROLE);
    expect(result.outcome).toBe("RESTARTED");
    expect(machine.terminated).toEqual([GENERIC_PID]);
    expect(machine.spawned).toHaveLength(1);
    expect(result.record?.role).toBe(GENERIC_ANALYSIS_ROLE);
  });

  it("7. an external analysis runtime appearing before the spawn blocks it", () => {
    // The generic half of the race: our tree is gone, but a vision-analysis
    // leaf somebody else started is already draining the queues.
    const machine = box({ processes: new Map([[GENERIC_PID, OURS]]), unaccounted: 1 });
    const result = executeWorkerRestart(staleDecision(), STATE, 1, machine.adapters, GENERIC_ANALYSIS_ROLE);
    expect(result.outcome).toBe("DUPLICATE_PRESENT");
    expect(machine.spawned).toEqual([]);
  });

  it("an unreadable generic census refuses the spawn", () => {
    const machine = box({ processes: new Map([[GENERIC_PID, OURS]]), unaccounted: null });
    const result = executeWorkerRestart(staleDecision(), STATE, 1, machine.adapters, GENERIC_ANALYSIS_ROLE);
    expect(result.outcome).toBe("CENSUS_UNAVAILABLE");
    expect(machine.spawned).toEqual([]);
  });

  it("G. an unobservable machine refuses for the generic role too", () => {
    // Same primitive, same refusal: the generic supervisor cannot drift from
    // the account one, because there is only one implementation.
    const machine = box({ processes: new Map([[GENERIC_PID, OURS]]), unobservable: true });
    const result = executeWorkerRestart(staleDecision(), STATE, 1, machine.adapters, GENERIC_ANALYSIS_ROLE);
    expect(result.outcome).toBe("OBSERVATION_UNAVAILABLE");
    expect(machine.terminated).toEqual([]);
    expect(machine.spawned).toEqual([]);
  });
});
