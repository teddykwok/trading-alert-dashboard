import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ACCOUNT_IDENTITY_KEYS } from "../src/config/account-env";
import { verifyOwnership } from "../src/modules/operator/runtime-launcher";
import {
  ACCOUNT_SENSITIVE_KEYS,
  DUAL_ROLES,
  LIVE_READY_UNAVAILABLE,
  ROLE_CONTRACTS,
  RUNTIME_ACCOUNTS,
  SAFE_GATE_CONTRACT,
  accountIdentitiesAreDistinct,
  buildProcessProbeQuery,
  censusOf,
  describeEnvFileFailure,
  classifyEntrypoint,
  dualSpawnPlan,
  envFilePathFor,
  evaluateAccountProfileProof,
  evaluateDualShutdownSafety,
  evaluateDualStartPreconditions,
  evaluateSafeGatePosture,
  parseProcessProbeRows,
  projectTopology,
  sanitizedChildEnv,
  parseEnvFileStrict,
  validateEnvFiles,
  verifyDualTopology,
  type AccountAttestationView,
  type AccountProfileProof,
  type AccountShutdownState,
  type DualRole,
  type EnvFileVerdict,
  type ObservedListener,
  type ObservedProcess,
} from "../src/modules/operator/dual-account-topology";

/**
 * Phase 11I -- the launcher understands two accounts, or it is not allowed to
 * act.
 *
 * The defect that opened this phase was a reporting one: six healthy processes
 * read as six OFF lines, because the tool asked its own state file and nothing
 * else. The dangerous half is quieter. A launcher that cannot tell Account A
 * from Account B can stop A's worker while A holds exposure, hand B's worker
 * A's credentials, or restart "the worker" and mean the wrong one -- and every
 * one of those looks like success on the screen.
 *
 * So these tests are mostly about DISTINCTION: which account a role belongs to,
 * which file it may read, which process the tool is allowed to kill, and which
 * account must answer before anything stops.
 */

const BACKEND_ROOT = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

const CLI = readFileSync(
  path.join(BACKEND_ROOT, "src/modules/operator/run-runtime-launcher.ts"),
  "utf8"
);
const MODULE = readFileSync(
  path.join(BACKEND_ROOT, "src/modules/operator/dual-account-topology.ts"),
  "utf8"
);

/** A synthetic machine: no real LOCALAPPDATA, no real files, no real secrets. */
const FAKE_ENV: NodeJS.ProcessEnv = {
  LOCALAPPDATA: path.join("C:", "fake", "AppData", "Local"),
  ComSpec: "cmd.exe",
  PATH: "/usr/bin",
};

const REPO = path.join("C:", "repo");

function processOn(entrypoint: string, pid: number): ObservedProcess {
  return {
    pid,
    startedAtMs: 1_000,
    commandLine: `"C:\\\\Program Files\\\\nodejs\\\\node.exe" --require preflight.cjs ${entrypoint}`,
  };
}

function listener(port: number, address: string, pid: number): ObservedListener {
  return { port, address, pid };
}

const HEALTHY: AccountAttestationView = {
  backendFresh: 1,
  backendStale: 0,
  workerFresh: 1,
  workerStale: 0,
  effectiveGates: { globalKillSwitch: true, liveEntryEnabled: false, protectionReady: false },
};

/** The six-role topology as it actually runs in production, none of it owned. */
function externalSixRoleCensus() {
  return censusOf(
    [
      processOn("src/server.ts", 11),
      processOn("src/modules/jobs/vision-analysis.worker.ts", 12),
      processOn("src/account-control.server.ts", 13),
      processOn("src/account-control.server.ts", 14),
      processOn("src/modules/jobs/execution.worker.ts", 15),
      processOn("src/modules/jobs/execution.worker.ts", 16),
    ],
    [listener(4000, "0.0.0.0", 11), listener(4001, "127.0.0.1", 13), listener(4002, "127.0.0.1", 14)]
  );
}

const SAFE_ACCOUNT = (account: "ACCOUNT_A" | "ACCOUNT_B"): AccountShutdownState => ({
  account,
  present: true,
  systemState: "SAFE_OFF",
  activeExecutions: 0,
  manualIntervention: 0,
  warnings: [],
});

// ===========================================================================
// 1-4, 18. The spawn plan, and the file each role is allowed to read
// ===========================================================================

describe("the six-role SAFE spawn plan", () => {
  it("1. names exactly six roles, generic first and each control before its worker", () => {
    expect([...DUAL_ROLES]).toEqual([
      "generic-backend",
      "generic-analysis",
      "account-a-control",
      "account-a-worker",
      "account-b-control",
      "account-b-worker",
    ]);
  });

  it("2. gives both generic roles generic.env", () => {
    for (const role of ["generic-backend", "generic-analysis"] as const) {
      const plan = dualSpawnPlan(role, REPO, FAKE_ENV);
      expect(`${role} -> ${path.basename(String(plan.options.env.DOTENV_CONFIG_PATH))}`).toBe(
        `${role} -> generic.env`
      );
    }
  });

  it("3. gives both Account A roles account-a.env", () => {
    for (const role of ["account-a-control", "account-a-worker"] as const) {
      const plan = dualSpawnPlan(role, REPO, FAKE_ENV);
      expect(`${role} -> ${path.basename(String(plan.options.env.DOTENV_CONFIG_PATH))}`).toBe(
        `${role} -> account-a.env`
      );
    }
  });

  it("4. gives both Account B roles account-b.env", () => {
    for (const role of ["account-b-control", "account-b-worker"] as const) {
      const plan = dualSpawnPlan(role, REPO, FAKE_ENV);
      expect(`${role} -> ${path.basename(String(plan.options.env.DOTENV_CONFIG_PATH))}`).toBe(
        `${role} -> account-b.env`
      );
    }
  });

  it("5. passes no account credential to a generic role, whatever the shell holds", () => {
    const contaminated: NodeJS.ProcessEnv = {
      ...FAKE_ENV,
      BINANCE_API_KEY: "shell-key",
      BINANCE_API_SECRET: "shell-secret",
      EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "shell-account",
      EXECUTION_PROFILE_ENVIRONMENT: "MAINNET",
    };
    for (const role of ["generic-backend", "generic-analysis"] as const) {
      const plan = dualSpawnPlan(role, REPO, contaminated);
      for (const key of ACCOUNT_IDENTITY_KEYS) {
        expect(`${role}/${key} -> ${plan.options.env[key] === undefined ? "absent" : "PRESENT"}`).toBe(
          `${role}/${key} -> absent`
        );
      }
    }
  });

  it("6 and 7. never lets one account's inherited values follow the other's role", () => {
    // The shell holds Account A's values; a B role is started from it. Neither
    // dotenv nor Prisma overwrites a key that is already set, so leaving them
    // in place is exactly how a process runs as the wrong account.
    const holdingA: NodeJS.ProcessEnv = {
      ...FAKE_ENV,
      BINANCE_API_KEY: "a-key",
      EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "account-a",
    };
    for (const role of ["account-b-control", "account-b-worker"] as const) {
      const plan = dualSpawnPlan(role, REPO, holdingA);
      expect(plan.options.env.BINANCE_API_KEY).toBeUndefined();
      expect(plan.options.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER).toBeUndefined();
      expect(path.basename(String(plan.options.env.DOTENV_CONFIG_PATH))).toBe("account-b.env");
    }
    const holdingB: NodeJS.ProcessEnv = {
      ...FAKE_ENV,
      BINANCE_API_KEY: "b-key",
      EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "account-b",
    };
    for (const role of ["account-a-control", "account-a-worker"] as const) {
      const plan = dualSpawnPlan(role, REPO, holdingA ? holdingB : holdingB);
      expect(plan.options.env.BINANCE_API_KEY).toBeUndefined();
      expect(path.basename(String(plan.options.env.DOTENV_CONFIG_PATH))).toBe("account-a.env");
    }
  });

  it("18. derives the env file from the ROLE, so a restart cannot change account", () => {
    // Supervision restarts by role. There is no parameter it could get wrong.
    expect(path.basename(envFilePathFor("account-a-worker", FAKE_ENV))).toBe("account-a.env");
    expect(path.basename(envFilePathFor("account-b-worker", FAKE_ENV))).toBe("account-b.env");
    expect(path.basename(envFilePathFor("generic-analysis", FAKE_ENV))).toBe("generic.env");
    // Both supervisors hand their role to ONE shared restart path, and that
    // path is the only place a replacement is spawned. The role travels as an
    // argument from the top of each pass, so no alias can be substituted.
    // Every supervised start builds its plan from the ROLE it was handed, and
    // goes through the one helper that gives the child a durable log sink.
    expect(CLI).toContain("spawnRoleWithDurableLog(role, dualSpawnPlan(role, REPO_ROOT))");
    // Both supervisors restart from the decision they RE-PROVED while holding
    // mutation authority, never from the one that merely started the pass.
    expect(CLI).toContain("restartOwnedRole(now.decision, workerRole, now.budget.attempts + 1)");
    expect(CLI).toContain("restartOwnedRole(now.decision, GENERIC_ANALYSIS_ROLE, now.budget.attempts + 1)");
  });

  it("strips exactly the bootstrap's own account key list, not a second copy", () => {
    expect([...ACCOUNT_SENSITIVE_KEYS]).toEqual([...ACCOUNT_IDENTITY_KEYS]);
    expect(MODULE).toContain('import { ACCOUNT_IDENTITY_KEYS } from "../../config/account-env"');
  });

  it("uses the proven cmd shape and never a shell string", () => {
    const plan = dualSpawnPlan("generic-backend", REPO, FAKE_ENV);
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(plan.args).toContain("-C");
    expect(plan.args).toContain(REPO);
    expect(JSON.stringify(plan.options)).not.toContain('"shell"');
  });
});

// ===========================================================================
// 8-10, 24. Refusing to start over something that already exists
// ===========================================================================

describe("start preconditions", () => {
  const OK_FILES: EnvFileVerdict = { ok: true, failures: [], parsed: new Map() };
  const DISTINCT = { ok: true } as const;

  function preconditions(over: {
    processes?: ObservedProcess[];
    listeners?: ObservedListener[];
    owned?: DualRole[];
    attestation?: Record<string, AccountAttestationView | null>;
    envFiles?: EnvFileVerdict;
    identities?: { ok: true } | { ok: false; reasons: string[] };
  }) {
    const status = projectTopology({
      census: censusOf(over.processes ?? [], over.listeners ?? []),
      ownedRoles: over.owned ?? [],
      attestation: over.attestation ?? {},
    });
    return evaluateDualStartPreconditions({
      status,
      envFiles: over.envFiles ?? OK_FILES,
      ownedAliveCount: 0,
      identities: over.identities ?? DISTINCT,
    });
  }

  it("accepts a genuinely empty machine", () => {
    expect(preconditions({})).toEqual({ ok: true });
  });

  it("8. refuses when 4001 is already held", () => {
    const verdict = preconditions({ listeners: [listener(4001, "127.0.0.1", 99)] });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("4001");
  });

  it("8. refuses when 4002 is already held", () => {
    const verdict = preconditions({ listeners: [listener(4002, "127.0.0.1", 99)] });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("4002");
  });

  it("9. refuses an account control plane bound beyond loopback", () => {
    const verdict = preconditions({ listeners: [listener(4001, "0.0.0.0", 99)] });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("beyond loopback");
  });

  it("10. refuses when a role is already running, owned or not", () => {
    const verdict = preconditions({ processes: [processOn("src/server.ts", 21)] });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("Generic Backend is already running");
  });

  it("10. refuses a duplicate attestation before starting anything", () => {
    const verdict = preconditions({
      attestation: { ACCOUNT_A: { ...HEALTHY, workerFresh: 2 } },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("DUPLICATE");
  });

  it("refuses an environment file that did not validate", () => {
    const verdict = preconditions({
      envFiles: {
        ok: false,
        failures: [{ alias: "account-b", reasonCode: "ENV_FILE_MALFORMED", detail: "line 7" }],
        parsed: new Map(),
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("account-b.env: ENV_FILE_MALFORMED");
  });

  it("24. refuses when both account files name the SAME account", () => {
    const same = accountIdentitiesAreDistinct(() => ({
      accountIdentifier: "the-same-account",
      environment: "MAINNET",
    }));
    expect(same.ok).toBe(false);
    expect(same.ok === false && same.reasons.join(" ")).toContain("attestation keys would collide");
    // And the refusal reaches the start path.
    const verdict = preconditions({ identities: same });
    expect(verdict.ok).toBe(false);
  });

  it("24. accepts two genuinely different accounts, and never returns an identifier", () => {
    const verdict = accountIdentitiesAreDistinct((role) => ({
      accountIdentifier: role === "account-a-control" ? "alpha" : "beta",
      environment: "MAINNET",
    }));
    expect(verdict).toEqual({ ok: true });
    expect(JSON.stringify(verdict)).not.toContain("alpha");
  });

  it("24. refuses an identity it could not read, rather than assuming distinctness", () => {
    const verdict = accountIdentitiesAreDistinct(() => ({
      accountIdentifier: null,
      environment: null,
    }));
    expect(verdict.ok).toBe(false);
  });
});

// ===========================================================================
// 11-12. Status: the defect that opened the phase
// ===========================================================================

describe("status over a manually started topology", () => {
  it("11. reports all six roles ON when none of them is launcher-owned", () => {
    const status = projectTopology({
      census: externalSixRoleCensus(),
      ownedRoles: [],
      attestation: { ACCOUNT_A: HEALTHY, ACCOUNT_B: HEALTHY },
    });
    for (const role of status.roles) {
      expect(`${role.label} -> ${role.presence}`).toBe(`${role.label} -> DETECTED`);
    }
    // This is the regression that opened Phase 11I.
    expect(status.roles.some((role) => role.presence === "OFF")).toBe(false);
  });

  it("12. keeps OWNED and DETECTED apart, because only one of them may be stopped", () => {
    const status = projectTopology({
      census: externalSixRoleCensus(),
      ownedRoles: ["generic-backend"],
      attestation: { ACCOUNT_A: HEALTHY, ACCOUNT_B: HEALTHY },
    });
    const byRole = Object.fromEntries(status.roles.map((role) => [role.role, role.presence]));
    expect(byRole["generic-backend"]).toBe("OWNED");
    expect(byRole["account-a-worker"]).toBe("DETECTED");
    expect(status.anyExternal).toBe(true);
  });

  it("11. tells the two accounts apart by attestation, not by command line", () => {
    // Both control planes run the SAME entrypoint, and both workers do too.
    // Only the identity each publishes distinguishes them.
    const status = projectTopology({
      census: externalSixRoleCensus(),
      ownedRoles: [],
      attestation: { ACCOUNT_A: HEALTHY, ACCOUNT_B: null },
    });
    const byRole = Object.fromEntries(status.roles.map((role) => [role.role, role.attestation]));
    expect(byRole["account-a-worker"]).toBe("HEALTHY");
    // B's reading failed, so B is UNKNOWN -- never silently healthy.
    expect(byRole["account-b-worker"]).toBe("UNKNOWN");
  });

  it("does not mistake a pnpm or tsx supervisor for the role it wraps", () => {
    expect(classifyEntrypoint("node pnpm.cjs --filter backend dev src/server.ts")).toBeNull();
    expect(classifyEntrypoint("node .../tsx/dist/cli.mjs watch src/server.ts")).toBeNull();
    expect(classifyEntrypoint("node --require preflight.cjs src/server.ts")).toBe("src/server.ts");
  });

  it("23. reads A and B attestation independently", () => {
    // B's worker has a record that has gone quiet: fresh 0 WITH a stale count.
    // That is what STALE means; fresh 0 with stale 0 is ABSENT and is covered
    // separately below.
    const status = projectTopology({
      census: externalSixRoleCensus(),
      ownedRoles: [],
      attestation: {
        ACCOUNT_A: HEALTHY,
        ACCOUNT_B: { ...HEALTHY, workerFresh: 0, workerStale: 1 },
      },
    });
    const byRole = Object.fromEntries(status.roles.map((role) => [role.role, role.attestation]));
    expect(byRole["account-a-worker"]).toBe("HEALTHY");
    expect(byRole["account-b-worker"]).toBe("STALE");
    // One account being unhealthy never changes the other's verdict.
    expect(byRole["account-a-control"]).toBe("HEALTHY");
  });
});

describe("topology verification after a start", () => {
  it("passes on exactly six roles with both accounts attesting", () => {
    const status = projectTopology({
      census: externalSixRoleCensus(),
      ownedRoles: [...DUAL_ROLES],
      attestation: { ACCOUNT_A: HEALTHY, ACCOUNT_B: HEALTHY },
    });
    expect(verifyDualTopology(status)).toEqual({ ok: true });
  });

  it("refuses a third execution worker", () => {
    const census = censusOf(
      [
        processOn("src/server.ts", 11),
        processOn("src/modules/jobs/vision-analysis.worker.ts", 12),
        processOn("src/account-control.server.ts", 13),
        processOn("src/account-control.server.ts", 14),
        processOn("src/modules/jobs/execution.worker.ts", 15),
        processOn("src/modules/jobs/execution.worker.ts", 16),
        processOn("src/modules/jobs/execution.worker.ts", 17),
      ],
      [listener(4000, "0.0.0.0", 11), listener(4001, "127.0.0.1", 13), listener(4002, "127.0.0.1", 14)]
    );
    const status = projectTopology({
      census,
      ownedRoles: [...DUAL_ROLES],
      attestation: { ACCOUNT_A: HEALTHY, ACCOUNT_B: HEALTHY },
    });
    const verdict = verifyDualTopology(status);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("3 execution worker processes");
  });

  it("never treats an unreadable attestation as healthy", () => {
    const status = projectTopology({
      census: externalSixRoleCensus(),
      ownedRoles: [...DUAL_ROLES],
      attestation: { ACCOUNT_A: HEALTHY, ACCOUNT_B: null },
    });
    const verdict = verifyDualTopology(status);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("could not be read");
  });
});

// ===========================================================================
// 14-16. Shutdown must satisfy BOTH accounts
// ===========================================================================

describe("shutdown safety across both accounts", () => {
  it("14. allows a stop only when every live account reports SAFE OFF and clean", () => {
    expect(evaluateDualShutdownSafety([SAFE_ACCOUNT("ACCOUNT_A"), SAFE_ACCOUNT("ACCOUNT_B")])).toEqual({
      ok: true,
    });
  });

  it("15. lets an unsafe Account A block the stop even though B is safe", () => {
    const verdict = evaluateDualShutdownSafety([
      { ...SAFE_ACCOUNT("ACCOUNT_A"), activeExecutions: 1 },
      SAFE_ACCOUNT("ACCOUNT_B"),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("ACCOUNT_A");
    expect(verdict.ok === false && verdict.reasons.join(" ")).not.toContain("ACCOUNT_B");
  });

  it("16. lets an unsafe Account B block the stop even though A is safe", () => {
    const verdict = evaluateDualShutdownSafety([
      SAFE_ACCOUNT("ACCOUNT_A"),
      { ...SAFE_ACCOUNT("ACCOUNT_B"), manualIntervention: 2 },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("ACCOUNT_B");
  });

  it("refuses when an account could not be read, rather than assuming it is quiet", () => {
    const verdict = evaluateDualShutdownSafety([
      SAFE_ACCOUNT("ACCOUNT_A"),
      { account: "ACCOUNT_B", present: true, systemState: null, activeExecutions: null, manualIntervention: null, warnings: null },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("could not be read");
  });

  it("refuses when an account was not evaluated at all", () => {
    const verdict = evaluateDualShutdownSafety([SAFE_ACCOUNT("ACCOUNT_A")]);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("not evaluated");
  });

  it("skips an account that has no runtime at all, because there is nothing to stop", () => {
    const verdict = evaluateDualShutdownSafety([
      SAFE_ACCOUNT("ACCOUNT_A"),
      { account: "ACCOUNT_B", present: false, systemState: null, activeExecutions: null, manualIntervention: null, warnings: null },
    ]);
    expect(verdict).toEqual({ ok: true });
  });

  it("treats recovery warnings as outstanding work", () => {
    const verdict = evaluateDualShutdownSafety([
      { ...SAFE_ACCOUNT("ACCOUNT_A"), warnings: ["FILLED_WITHOUT_VERIFIED_PROTECTION"] },
      SAFE_ACCOUNT("ACCOUNT_B"),
    ]);
    expect(verdict.ok).toBe(false);
  });

  it("ignores warnings that merely describe a runtime being down", () => {
    const verdict = evaluateDualShutdownSafety([
      { ...SAFE_ACCOUNT("ACCOUNT_A"), warnings: ["RUNTIME_ATTESTATION_BLOCKED", "NATURAL_AUTHORIZATION_EXPIRED"] },
      SAFE_ACCOUNT("ACCOUNT_B"),
    ]);
    expect(verdict).toEqual({ ok: true });
  });
});

// ===========================================================================
// 13, 17, 25. What the CLI is allowed to touch
// ===========================================================================

describe("the CLI's ownership and rollback fences", () => {
  it("13. terminates only after proving ownership, and never by process name", () => {
    expect(CLI).toContain('"/PID"');
    for (const forbidden of ["/IM", "Stop-Process -Name", "taskkill /f /im"]) {
      expect(`${forbidden}:${CLI.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // Every terminateTree call site is preceded by an ownership check. There
    // are four: rollback, stop, the ONE shared supervised-restart adapter both
    // supervisors use, and the account-transition adapter. The last two prove
    // ownership inside the SAME fenced primitive, which is the point.
    expect((CLI.match(/terminateTree\(/g) ?? []).length).toBe(5); // 1 definition + 4 call sites
    // The rollback proves ownership inside `executeRollback` now, so only
    // Stop Runtime still has an inline kill to fence here.
    for (const block of ["async function stopRuntime"]) {
      const from = CLI.indexOf(block);
      const kill = CLI.indexOf("terminateTree(", from);
      // Ownership is now proved inside `judgeOwnedTree`, which both blocks
      // call before their kill. One shared decision instead of two copies,
      // and it is the thing the behavioural tests exercise.
      const proof = CLI.lastIndexOf("judgeOwnedTree(", kill);
      expect(`${block}: ownership proved before kill -> ${proof > from}`).toBe(
        `${block}: ownership proved before kill -> true`
      );
    }
    // The supervised kill proves ownership inside `executeWorkerRestart`
    // rather than in the adapter, which is what its own behavioural tests
    // exercise. The adapter must therefore do NOTHING but call taskkill.
    const adapter = CLI.slice(CLI.indexOf("function restartOwnedRole"), CLI.indexOf("function recordReplacement"));
    expect(adapter).toContain("terminate: (pid) => {");
    expect((adapter.match(/terminateTree\(/g) ?? []).length).toBe(1);
    expect((adapter.match(/spawnRoleWithDurableLog\(/g) ?? []).length).toBe(1);

    // The account-transition adapter is held to the same rule, for the same
    // reason: its stop is fenced inside `executeFencedStop` and its start
    // inside `executeFencedStart`, so the adapter itself may only call the
    // machine. One kill, one spawn, no decision.
    const transition = CLI.slice(
      CLI.indexOf("function transitionAdapters"),
      CLI.indexOf("async function askAccount")
    );
    expect((transition.match(/terminateTree\(/g) ?? []).length).toBe(1);
    expect((transition.match(/spawnRoleWithDurableLog\(/g) ?? []).length).toBe(1);
    expect(transition).toContain("spawnRoleWithDurableLog(role, dualSpawnPlan(role, REPO_ROOT))");
  });

  it("13. stops only launcher-owned roles, never a detected one", () => {
    const stop = CLI.slice(CLI.indexOf("async function stopRuntime"), CLI.indexOf("async function superviseAccountWorker"));
    // The stop loop iterates `alive`, which is built from the state file and
    // filtered through verifyOwnership. A DETECTED role is never in it.
    expect(stop).toContain("alive.filter((entry) => entry.role === role)");
    expect(stop).toContain("will not terminate them");
  });

  it("25. rolls back only what THIS start spawned, newest first", () => {
    const start = CLI.slice(CLI.indexOf("async function startSafe"), CLI.indexOf("async function stopRuntime"));
    expect(start).toContain("[...started].reverse()");
    expect(start).toContain("Rolling back ONLY the roles this action started");
    // Rollback re-proves ownership for each PID rather than trusting the list.
    expect(start.indexOf("verifyOwnership(record")).toBeLessThan(start.indexOf("terminateTree("));
  });

  it("17. supervises one named account at a time", () => {
    expect(CLI).toContain(
      'const workerRole: DualRole = account === "ACCOUNT_A" ? "account-a-worker" : "account-b-worker";'
    );
    expect(CLI).toContain('await superviseAccountWorker("ACCOUNT_A", ask)');
    expect(CLI).toContain('await superviseAccountWorker("ACCOUNT_B", ask)');
  });
});

// ===========================================================================
// 19, 22. The launcher can no longer arm anything
// ===========================================================================

describe("LIVE-READY is account-scoped, never runtime-wide", () => {
  it("19. loads live gates for ONE account only, and only through the fenced transition", () => {
    // This tool CAN now move one account to LIVE-READY. What must remain
    // impossible is the thing 11I withdrew it for: a whole-runtime arm, a
    // second gate writer, or a start path that could load live gates.
    for (const resurrected of ["gatesFor(", "isLiveReadyConfirmed", "writeEnvText", "startLiveReady"]) {
      expect(`${resurrected}:${CLI.includes(resurrected)}`).toBe(`${resurrected}:false`);
    }

    // Exactly one gate writer, and it rewrites exactly one account's file.
    expect((CLI.match(/applyGates\(/g) ?? []).length).toBe(1);
    const writer = CLI.slice(
      CLI.indexOf("function writeAccountGates"),
      CLI.indexOf("const GATES_FOR =")
    );
    expect(writer).toContain("const { control } = rolesForAccount(account);");
    expect(writer).toContain("const file = envFilePathFor(control);");
    // Both directions come from the shared constants, never from a literal.
    expect(writer).toContain('mode === "SAFE" ? SAFE_GATES : LIVE_READY_GATES');

    // And Start SAFE cannot reach it. A start that could write a gate is a
    // start that could arm, which is exactly what 11I removed.
    const startSafe = CLI.slice(CLI.indexOf("async function startSafe"), CLI.indexOf("async function stopRuntime"));
    for (const forbidden of ["applyGates", "writeAccountGates", "LIVE_READY_GATES", "writeFileSync"]) {
      expect(`startSafe/${forbidden}:${startSafe.includes(forbidden)}`).toBe(`startSafe/${forbidden}:false`);
    }
  });

  it("19. offers the transition for ONE named account, never for both at once", () => {
    const chooser = CLI.slice(CLI.indexOf("async function askAccount"), CLI.indexOf("async function transitionAccount"));
    // Two answers and a cancel. There is deliberately no "both" and no "all".
    expect(chooser).toContain('if (answer === "a") return "ACCOUNT_A";');
    expect(chooser).toContain('if (answer === "b") return "ACCOUNT_B";');
    expect(chooser).toContain("Cancelled. Nothing was changed.");
    for (const forbidden of ["both", "ACCOUNT_A, ACCOUNT_B", "RUNTIME_ACCOUNTS.map"]) {
      expect(`${forbidden}:${chooser.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }

    // The sequence is driven for the chosen account and only its two roles.
    const action = CLI.slice(
      CLI.indexOf("async function transitionAccount"),
      CLI.indexOf("async function recoverIncompleteTransition")
    );
    expect(action).toContain("const { control, worker } = rolesForAccount(account);");
    // The engine is TOLD the proven direction; it never deduces one.
    expect(action).toContain("{ account, fromMode: decision.fromMode, targetMode, startedAtMs: Date.now() }");
  });

  it("19. explains the refusal instead of silently dropping the feature", () => {
    expect(CLI).toContain("LIVE_READY_UNAVAILABLE");
    expect(LIVE_READY_UNAVAILABLE.join(" ")).toContain(
      "Account-scoped LIVE-READY requires the dedicated account arming workflow"
    );
  });

  it("22. writes exactly two files, and each one atomically", () => {
    // The launcher's own state, and ONE account's env file during a
    // transition. Nothing else, and no third writer may appear quietly.
    //
    // The mutation mutex is NOT among them. It was a lock file once, and that
    // was the bug: a file has to be recoverable after a crash, recovery means
    // deleting someone's file, and the filesystem has no "delete only if this
    // is still record L0". It is now an OS-held loopback binding with nothing
    // on disk to recover, delete or race over.
    expect((CLI.match(/writeFileSync\(/g) ?? []).length).toBe(2);
    expect(CLI).toContain("writeFileSync(temporary, JSON.stringify(state, null, 2)");
    expect(CLI).toContain("writeFileSync(temporary, rewritten.text");
    // Both are temp-then-rename, so an interruption leaves the old file or the
    // new one, never half of either.
    expect((CLI.match(/renameSync\(temporary, /g) ?? []).length).toBe(2);
  });

  it("22. the mutation mutex owns no file, and nothing can clear it by hand", () => {
    const block = CLI.slice(CLI.indexOf("function openMutationListener"), CLI.indexOf("function clearState"));
    // No path, no create, no delete, no rename, no owner record. There is
    // nothing an operator or a second launcher could remove to take authority.
    for (const forbidden of [
      "LOCK_PATH",
      "openSync",
      "unlinkSync",
      "renameSync",
      "writeFileSync",
      "readFileSync",
      "instanceId",
      "stale",
    ]) {
      expect(`${forbidden}:${block.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    expect(CLI).not.toContain("mutation-lock.json");
  });

  it("22. touches no execution profile, and builds no exchange client of its own", () => {
    for (const forbidden of [
      "executionProfile",
      "CanaryPreflightService",
      "readReadiness",
      "armNaturalWindow",
      "safeOff(",
      // It must never construct a client, bind credentials or sign a request.
      // Exchange facts reach it ONLY as counts, from the account's own control
      // plane, over authenticated loopback.
      "BinanceReadOnlyClient",
      "BinanceReadOnlyService",
      "bindConfiguredExchangeRuntime",
      "exchangeClientOptionsOf",
      "checkAccountConnection",
      "getPositionRisk",
      "getOpenOrders",
    ]) {
      expect(`${forbidden}:${CLI.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // The one thing it takes from the exchange package is a pure counts
    // parser and a counts TYPE, from the single module it imports there.
    expect(CLI).toContain(
      'import { countsFromWire, type PreShutdownCounts } from "../binance/pre-shutdown-exchange-check";'
    );
    expect((CLI.match(/from "\.\.\/binance\//g) ?? []).length).toBe(1);
    // And that module builds no client either, so no client reaches this
    // process at runtime through it.
    const counts = readFileSync(
      path.join(BACKEND_ROOT, "src/modules/binance/pre-shutdown-exchange-check.ts"),
      "utf8"
    );
    expect(counts).not.toMatch(/new\s+Binance/);
    // Its only binance import is erased at compile time.
    for (const line of counts.split(/\r?\n/).filter((row) => row.includes("./binance"))) {
      expect(`erased: ${line.trim().startsWith("import type")}`).toBe("erased: true");
    }
    // And every control-plane read is a GET on 127.0.0.1.
    for (const match of CLI.matchAll(/fetch\(`([^`]*)`/g)) {
      expect(`fetch target: ${match[1].startsWith("http://127.0.0.1:")}`).toBe("fetch target: true");
    }
    expect(CLI).not.toContain('method: "POST"');
  });
});

// ===========================================================================
// 20, 21. What the operator is shown, and what the tool assumes
// ===========================================================================

describe("the surface the operator sees", () => {
  it("20. never renders a value out of an environment file", () => {
    // `envValue` is the single reader, and every call site asks for a key whose
    // value is used as a header, a port or a Redis key segment -- never printed.
    const readers = CLI.match(/envValue\(/g) ?? [];
    expect(readers.length).toBeGreaterThan(0);
    for (const match of CLI.matchAll(/console\.log\([^\n]*envValue\(/g)) {
      expect(`envValue printed at ${match.index} -> should never happen`).toBe("never");
    }
    // The status line reports gate BOOLEANS, which are safe, and nothing else.
    expect(CLI).toContain('kill=${show("EXECUTION_GLOBAL_KILL_SWITCH")} ');
    for (const secret of ["BINANCE_API_SECRET", "OPERATOR_API_TOKEN}", "accountIdentifier}"]) {
      expect(`${secret} in a log line:${CLI.includes("console.log(`" + secret)}`).toBe(
        `${secret} in a log line:false`
      );
    }
  });

  it("20. state records carry an alias, never an account identifier", () => {
    expect(CLI).toContain("envAlias: string;");
    expect(CLI).toContain("/** The ALIAS of the env file this role was started with.");
    const state = CLI.slice(CLI.indexOf("interface OwnedRole"), CLI.indexOf("function readState"));
    expect(`identifier persisted:${state.includes("accountIdentifier")}`).toBe("identifier persisted:false");
  });

  it("21. assumes no frontend runtime, because the six-role contract has none", () => {
    expect(DUAL_ROLES.some((role) => role.includes("frontend"))).toBe(false);
    expect(`frontend in the launcher:${CLI.includes("frontend")}`).toBe("frontend in the launcher:false");
    expect(`5173 in the launcher:${CLI.includes("5173")}`).toBe("5173 in the launcher:false");
  });

  it("names every role, every port and every account exactly once", () => {
    expect(DUAL_ROLES.length).toBe(6);
    expect(new Set(DUAL_ROLES).size).toBe(6);
    const ports = DUAL_ROLES.map((role) => ROLE_CONTRACTS[role].port).filter((port) => port !== null);
    expect(ports).toEqual([4000, 4001, 4002]);
    expect([...RUNTIME_ACCOUNTS]).toEqual(["ACCOUNT_A", "ACCOUNT_B"]);
    for (const role of ["account-a-control", "account-b-control"] as const) {
      expect(`${role} loopback:${ROLE_CONTRACTS[role].loopbackOnly}`).toBe(`${role} loopback:true`);
    }
  });

  it("validates all three env files, and reports every failure at once", () => {
    // Presence alone is not enough: sanitation needs the file to parse
    // COMPLETELY, so validation reads and parses each one.
    const seen: string[] = [];
    const verdict = validateEnvFiles(FAKE_ENV, (candidate) => {
      seen.push(path.basename(candidate));
      if (candidate.endsWith("generic.env")) return "A=1\n";
      if (candidate.endsWith("account-a.env")) return "this is not an assignment\n";
      const missing = new Error("no such file") as NodeJS.ErrnoException;
      missing.code = "ENOENT";
      throw missing;
    });
    expect(seen).toEqual(["generic.env", "account-a.env", "account-b.env"]);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.map((failure) => `${failure.alias}:${failure.reasonCode}`)).toEqual([
      "account-a:ENV_FILE_MALFORMED",
      "account-b:ENV_FILE_MISSING",
    ]);
    // The one good file is still parsed and available to the caller.
    expect(verdict.parsed.get("generic")?.keys).toEqual(["A"]);
  });
});


// ===========================================================================
// Review finding 1: the selected file is authoritative over the whole shell
// ===========================================================================

describe("child environment sanitation", () => {
  /** The key names a file declares, injected so no real file is read. */
  const declares = (...keys: string[]) => () => keys;

  const STALE_SHELL: NodeJS.ProcessEnv = {
    ...FAKE_ENV,
    EXECUTION_GLOBAL_KILL_SWITCH: "false",
    EXECUTION_LIVE_ENTRY_ENABLED: "true",
    EXECUTION_PROTECTION_READY: "true",
    OPERATOR_API_TOKEN: "stale-account-a-token",
    ACCOUNT_CONTROL_PORT: "4001",
    DATABASE_URL: "postgresql://stale/shell",
    REDIS_URL: "redis://stale-shell:6379",
    EXECUTION_MAX_OPEN_POSITIONS: "99",
    PATH: "/usr/bin",
  };

  it("clears every key the selected file declares, so the file wins", () => {
    // Runtime env application is NON-OVERRIDING at every layer, so any key the
    // shell still holds beats the file. Clearing the file's own key set is what
    // makes "the selected file decides" true rather than aspirational.
    const child = sanitizedChildEnv(
      "account-b-control",
      STALE_SHELL,
      declares(
        "EXECUTION_GLOBAL_KILL_SWITCH",
        "EXECUTION_LIVE_ENTRY_ENABLED",
        "EXECUTION_PROTECTION_READY",
        "OPERATOR_API_TOKEN",
        "ACCOUNT_CONTROL_PORT",
        "DATABASE_URL",
        "REDIS_URL",
        "EXECUTION_MAX_OPEN_POSITIONS"
      )
    );
    for (const key of [
      "EXECUTION_GLOBAL_KILL_SWITCH",
      "EXECUTION_LIVE_ENTRY_ENABLED",
      "EXECUTION_PROTECTION_READY",
      "OPERATOR_API_TOKEN",
      "ACCOUNT_CONTROL_PORT",
      "DATABASE_URL",
      "REDIS_URL",
      "EXECUTION_MAX_OPEN_POSITIONS",
    ]) {
      expect(`${key} -> ${child[key] === undefined ? "cleared" : "LEAKED"}`).toBe(`${key} -> cleared`);
    }
  });

  it("a stale globalKill=false cannot outrank a file that says true", () => {
    const child = sanitizedChildEnv("account-a-worker", STALE_SHELL, declares("EXECUTION_GLOBAL_KILL_SWITCH"));
    expect(child.EXECUTION_GLOBAL_KILL_SWITCH).toBeUndefined();
  });

  it("a stale liveEntry=true cannot outrank a file that says false", () => {
    const child = sanitizedChildEnv("account-a-worker", STALE_SHELL, declares("EXECUTION_LIVE_ENTRY_ENABLED"));
    expect(child.EXECUTION_LIVE_ENTRY_ENABLED).toBeUndefined();
  });

  it("a stale protectionReady=true cannot outrank a file that says false", () => {
    const child = sanitizedChildEnv("account-a-worker", STALE_SHELL, declares("EXECUTION_PROTECTION_READY"));
    expect(child.EXECUTION_PROTECTION_READY).toBeUndefined();
  });

  it("Account A's operator token cannot leak into an Account B process", () => {
    const child = sanitizedChildEnv("account-b-control", STALE_SHELL, declares("OPERATOR_API_TOKEN"));
    expect(child.OPERATOR_API_TOKEN).toBeUndefined();
    expect(JSON.stringify(child)).not.toContain("stale-account-a-token");
  });

  it("Account A's control port cannot leak into an Account B process", () => {
    // Otherwise Control B would try to bind 4001 and collide with Control A.
    const child = sanitizedChildEnv("account-b-control", STALE_SHELL, declares("ACCOUNT_CONTROL_PORT"));
    expect(child.ACCOUNT_CONTROL_PORT).toBeUndefined();
  });

  it("a stale DATABASE_URL or REDIS_URL cannot outrank the file that declares one", () => {
    const child = sanitizedChildEnv("generic-backend", STALE_SHELL, declares("DATABASE_URL", "REDIS_URL"));
    expect(child.DATABASE_URL).toBeUndefined();
    expect(child.REDIS_URL).toBeUndefined();
  });

  it("clears the account identity keys even when the file omits them", () => {
    // A truncated or malformed file must not become a way to smuggle an
    // inherited account in: the bootstrap's integrity contract is fail-closed
    // and this keeps it that way.
    const holdingA: NodeJS.ProcessEnv = {
      ...FAKE_ENV,
      BINANCE_API_KEY: "a-key",
      BINANCE_API_SECRET: "a-secret",
      EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "account-a",
      EXECUTION_PROFILE_ENVIRONMENT: "MAINNET",
    };
    const child = sanitizedChildEnv("account-b-worker", holdingA, declares());
    for (const key of ACCOUNT_IDENTITY_KEYS) {
      expect(`${key} -> ${child[key] === undefined ? "cleared" : "LEAKED"}`).toBe(`${key} -> cleared`);
    }
  });

  it("keeps variables the file does not mention, because a child needs them", () => {
    const child = sanitizedChildEnv("generic-backend", STALE_SHELL, declares("DATABASE_URL"));
    expect(child.PATH).toBe("/usr/bin");
    expect(child.ComSpec).toBe("cmd.exe");
  });

  it("pins DOTENV_CONFIG_PATH last, so clearing can never remove it", () => {
    const child = sanitizedChildEnv(
      "account-b-worker",
      STALE_SHELL,
      declares("DOTENV_CONFIG_PATH", "DATABASE_URL")
    );
    expect(path.basename(String(child.DOTENV_CONFIG_PATH))).toBe("account-b.env");
  });

  it("never mutates the parent environment", () => {
    const parent: NodeJS.ProcessEnv = { ...STALE_SHELL };
    sanitizedChildEnv("account-b-worker", parent, declares("OPERATOR_API_TOKEN", "DATABASE_URL"));
    expect(parent.OPERATOR_API_TOKEN).toBe("stale-account-a-token");
    expect(parent.DATABASE_URL).toBe("postgresql://stale/shell");
  });

  it("the spawn plan uses the sanitised environment", () => {
    const plan = dualSpawnPlan("account-b-worker", REPO, STALE_SHELL, declares("OPERATOR_API_TOKEN"));
    expect(plan.options.env.OPERATOR_API_TOKEN).toBeUndefined();
    expect(path.basename(String(plan.options.env.DOTENV_CONFIG_PATH))).toBe("account-b.env");
  });

  it("reads key NAMES only, and the launcher never prints an env value", () => {
    expect(MODULE).toContain("const parsed = parseEnvFileStrict(envFilePathFor(role, env));");
    expect(MODULE).toContain("return parsed.ok ? parsed.keys : [];");
    // The single value reader exists, and no log line interpolates it.
    for (const match of CLI.matchAll(/console\.log\([^\n]*envValue\(/g)) {
      expect(`envValue printed at ${match.index}`).toBe("never");
    }
    // Nor is any value persisted: state holds an alias.
    const state = CLI.slice(CLI.indexOf("interface OwnedRole"), CLI.indexOf("function readState"));
    for (const forbidden of ["token", "apiKey", "secret", "accountIdentifier"]) {
      expect(`${forbidden} persisted:${state.includes(forbidden)}`).toBe(`${forbidden} persisted:false`);
    }
  });
});

// ===========================================================================
// Review finding 2: Start SAFE must prove SAFE
// ===========================================================================

describe("the SAFE deployment posture", () => {
  const SAFE_DECLARED: Record<string, string> = {
    EXECUTION_GLOBAL_KILL_SWITCH: "true",
    EXECUTION_LIVE_ENTRY_ENABLED: "false",
    EXECUTION_PROTECTION_READY: "false",
  };

  it("takes its contract from the attested gate snapshot, not from invention", () => {
    expect(SAFE_GATE_CONTRACT.map((gate) => gate.key)).toEqual([
      "EXECUTION_GLOBAL_KILL_SWITCH",
      "EXECUTION_LIVE_ENTRY_ENABLED",
      "EXECUTION_PROTECTION_READY",
      "BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED",
      "BINANCE_TEST_ORDER_ENABLED",
      "EXECUTION_AUTO_ADD_MARGIN_ENABLED",
      "EXECUTION_EMERGENCY_CLOSE_MODE",
    ]);
    // Gates that are NOT part of the attested snapshot stay out of it.
    for (const invented of ["BINANCE_READ_ONLY_ENABLED", "EXECUTION_FILL_RUNTIME_ENABLED"]) {
      expect(`${invented} required:${SAFE_GATE_CONTRACT.some((gate) => gate.key === invented)}`).toBe(
        `${invented} required:false`
      );
    }
  });

  it("accepts a file that declares the SAFE posture", () => {
    expect(evaluateSafeGatePosture("account-a", SAFE_DECLARED)).toEqual({ ok: true });
  });

  it("blocks an unsafe Account A file before anything is spawned", () => {
    const verdict = evaluateSafeGatePosture("account-a", {
      ...SAFE_DECLARED,
      EXECUTION_GLOBAL_KILL_SWITCH: "false",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("account-a.env declares");
  });

  it("blocks an unsafe Account B file before anything is spawned", () => {
    const verdict = evaluateSafeGatePosture("account-b", {
      ...SAFE_DECLARED,
      EXECUTION_LIVE_ENTRY_ENABLED: "true",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("EXECUTION_LIVE_ENTRY_ENABLED");
  });

  it("blocks a protectionReady that is open", () => {
    const verdict = evaluateSafeGatePosture("account-b", {
      ...SAFE_DECLARED,
      EXECUTION_PROTECTION_READY: "true",
    });
    expect(verdict.ok).toBe(false);
  });

  it("requires the three operator gates to be DECLARED, not merely absent", () => {
    const verdict = evaluateSafeGatePosture("account-a", {});
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons).toHaveLength(3);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("does not declare");
  });

  it("allows the four defaulted gates to be absent, but not to be wrong", () => {
    expect(evaluateSafeGatePosture("account-a", SAFE_DECLARED)).toEqual({ ok: true });
    const verdict = evaluateSafeGatePosture("account-a", {
      ...SAFE_DECLARED,
      EXECUTION_EMERGENCY_CLOSE_MODE: "ON_UNVERIFIED_STOP",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("EXECUTION_EMERGENCY_CLOSE_MODE");
  });

  it("runs the posture check before any spawn in the CLI", () => {
    const start = CLI.slice(CLI.indexOf("async function startSafe"), CLI.indexOf("async function stopRuntime"));
    expect(start.indexOf("evaluateSafeGatePosture(")).toBeLessThan(
      start.indexOf("spawnRoleWithDurableLog(")
    );
    expect(start.indexOf("evaluateSafeGatePosture(")).toBeLessThan(start.indexOf("await collectStatus()"));
  });
});

describe("proving an account is dormant before its worker starts", () => {
  const DORMANT: AccountProfileProof = {
    account: "ACCOUNT_A",
    healthOk: true,
    surface: "ACCOUNT_CONTROL",
    isEnabled: false,
    killSwitchActive: true,
  };

  it("accepts a control plane that proves both facts", () => {
    expect(evaluateAccountProfileProof(DORMANT)).toEqual({ ok: true });
  });

  it("blocks Worker A when Account A's profile is ENABLED", () => {
    const verdict = evaluateAccountProfileProof({ ...DORMANT, isEnabled: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("ACCOUNT_A: execution profile is ENABLED");
  });

  it("blocks Worker A when Account A's kill switch is not active", () => {
    const verdict = evaluateAccountProfileProof({ ...DORMANT, killSwitchActive: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("kill switch is NOT active");
  });

  it("blocks Worker B when Account B's profile is ENABLED", () => {
    const verdict = evaluateAccountProfileProof({ ...DORMANT, account: "ACCOUNT_B", isEnabled: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("ACCOUNT_B");
  });

  it("blocks Worker B when Account B's kill switch is not active", () => {
    const verdict = evaluateAccountProfileProof({
      ...DORMANT,
      account: "ACCOUNT_B",
      killSwitchActive: false,
    });
    expect(verdict.ok).toBe(false);
  });

  it("refuses an unknown rather than assuming dormancy", () => {
    for (const unknown of [
      { isEnabled: null },
      { killSwitchActive: null },
      { healthOk: false },
      { surface: null },
      { surface: "SOMETHING_ELSE" },
    ]) {
      const verdict = evaluateAccountProfileProof({ ...DORMANT, ...unknown });
      expect(`${JSON.stringify(unknown)} -> ${verdict.ok}`).toBe(`${JSON.stringify(unknown)} -> false`);
    }
  });

  it("is run after the control plane and BEFORE that account's worker", () => {
    const start = CLI.slice(CLI.indexOf("async function startSafe"), CLI.indexOf("async function stopRuntime"));
    // The proof sits inside the per-role loop, guarded on the attesting role,
    // so the loop cannot advance to the worker without it.
    expect(start).toContain('if (contract.attests === "BACKEND") {');
    expect(start).toContain("await proveAccountProfileDormant(account)");
    expect(start.indexOf("proveAccountProfileDormant")).toBeLessThan(start.indexOf("verifyDualTopology("));
    // A failed proof rolls back and RETURNS; the success line is only reached
    // when the verdict held.
    const proofBlock = start.slice(start.indexOf('if (contract.attests === "BACKEND") {'));
    const rollback = proofBlock.indexOf("rollback(");
    const success = proofBlock.indexOf("control plane ACCOUNT_CONTROL, profile disabled");
    expect(rollback).toBeGreaterThan(-1);
    expect(rollback).toBeLessThan(success);
    expect(proofBlock.slice(rollback, success)).toContain("return;");
  });

  it("never prints the raw operator response, a token or an identifier", () => {
    const prover = CLI.slice(
      CLI.indexOf("async function proveAccountProfileDormant"),
      CLI.indexOf("// Attestation, per account")
    );
    expect(`logs in the prover:${prover.includes("console.log")}`).toBe("logs in the prover:false");
    expect(`json logged:${prover.includes("JSON.stringify")}`).toBe("json logged:false");
    // The status DTO it reads carries environment and two booleans; the account
    // identifier never leaves the server, so there is nothing to redact.
    expect(prover).toContain("status.profile?.isEnabled");
    expect(prover).toContain("status.profile?.killSwitchActive");
    expect(`identifier read:${prover.includes("accountIdentifier")}`).toBe("identifier read:false");
  });

  it("rollback after a failed proof stays ownership-scoped", () => {
    const start = CLI.slice(CLI.indexOf("async function startSafe"), CLI.indexOf("async function stopRuntime"));
    expect(start).toContain("[...started].reverse()");
    expect(start.indexOf("verifyOwnership(record")).toBeLessThan(start.indexOf("terminateTree("));
  });
});

// ===========================================================================
// Review findings 3 and 4: wording that matches behaviour
// ===========================================================================

describe("the menu and the status say what is true", () => {
  it("names the stop action for what it does: it requires SAFE, it does not cause it", () => {
    expect(CLI).toContain('console.log("4. Stop Runtime (requires SAFE)");');
    expect(`old wording:${CLI.includes("Stop Runtime & Return SAFE")}`).toBe("old wording:false");
    // And the success line says the same thing.
    expect(CLI).toContain("Nothing was transitioned INTO safe");
  });

  it("labels file-derived gates CONFIGURED and runtime-derived gates EFFECTIVE", () => {
    expect(CLI).toContain("CONFIGURED gates — what each account FILE declares");
    expect(CLI).toContain("EFFECTIVE gates — what each RUNNING control plane attests it loaded");
    expect(CLI).toContain("It is NOT necessarily what a running process has");
  });

  it("carries the effective gates from the attestation, never from a file", () => {
    const reader = CLI.slice(
      CLI.indexOf("async function readAccountAttestation"),
      CLI.indexOf("async function readAllAttestation")
    );
    expect(reader).toContain("const gates = status.backend.gates;");
    expect(reader).toContain("effectiveGates:");
    // The reader touches no file.
    expect(`reads a file:${reader.includes("readFileSync")}`).toBe("reads a file:false");
  });

  it("reports EFFECTIVE as unavailable rather than falling back to the file", () => {
    expect(CLI).toContain('"not attesting (no running control plane, or unreadable)"');
  });
});


// ===========================================================================
// Final review: env files must fail closed BEFORE any spawn
// ===========================================================================

describe("the strict env-file parser", () => {
  const read = (text: string) => () => text;
  const throwing = (code?: string) => () => {
    const error = new Error("boom") as NodeJS.ErrnoException;
    if (code !== undefined) error.code = code;
    throw error;
  };

  it("accepts the ordinary shapes: assignments, comments, blanks and quotes", () => {
    const parsed = parseEnvFileStrict(
      "any",
      read(["# a comment", "", "A=1", 'B="two"', "C='three'", "D=", "  E=5  "].join("\n"))
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.ok === true && parsed.keys).toEqual(["A", "B", "C", "D", "E"]);
    expect(parsed.ok === true && parsed.values.get("B")).toBe("two");
    expect(parsed.ok === true && parsed.values.get("D")).toBe("");
  });

  it("reports ENV_FILE_MISSING for ENOENT and ENV_FILE_UNREADABLE otherwise", () => {
    const missing = parseEnvFileStrict("any", throwing("ENOENT"));
    expect(missing.ok === false && missing.reasonCode).toBe("ENV_FILE_MISSING");
    const unreadable = parseEnvFileStrict("any", throwing("EACCES"));
    expect(unreadable.ok === false && unreadable.reasonCode).toBe("ENV_FILE_UNREADABLE");
  });

  it("refuses a malformed line and names only its NUMBER", () => {
    const parsed = parseEnvFileStrict("any", read("A=1\nthis is not an assignment\nB=2\n"));
    expect(parsed.ok === false && parsed.reasonCode).toBe("ENV_FILE_MALFORMED");
    expect(parsed.ok === false && parsed.detail).toBe("line 2");
  });

  it("refuses an empty key", () => {
    const parsed = parseEnvFileStrict("any", read("=orphaned\n"));
    expect(parsed.ok === false && parsed.reasonCode).toBe("ENV_FILE_MALFORMED");
    expect(parsed.ok === false && parsed.detail).toBe("line 1");
  });

  it("refuses a duplicate key and names only the KEY", () => {
    const parsed = parseEnvFileStrict("any", read("A=1\nB=2\nA=3\n"));
    expect(parsed.ok === false && parsed.reasonCode).toBe("ENV_FILE_DUPLICATE_KEY");
    expect(parsed.ok === false && parsed.detail).toBe("A");
  });

  it("refuses an unterminated quote, which a line parser cannot represent", () => {
    const parsed = parseEnvFileStrict("any", read('A="starts but never ends\nB=2\n'));
    expect(parsed.ok === false && parsed.reasonCode).toBe("ENV_FILE_MALFORMED");
  });

  it("refuses shapes it cannot sanitise against, rather than skipping them", () => {
    for (const line of ["export A=1", "A B=1", "A.B=1", "1A=2", "just-a-word"]) {
      const parsed = parseEnvFileStrict("any", read(`${line}\n`));
      expect(`${line} -> ${parsed.ok ? "ACCEPTED" : parsed.reasonCode}`).toBe(
        `${line} -> ENV_FILE_MALFORMED`
      );
    }
  });

  it("strips a byte-order mark instead of folding it into the first key", () => {
    const parsed = parseEnvFileStrict("any", read("\ufeffA=1\n"));
    expect(parsed.ok === true && parsed.keys).toEqual(["A"]);
  });

  it("never puts a value in a failure", () => {
    const secret = "super-secret-value";
    for (const text of [`A=1\nA=${secret}\n`, `bad line with ${secret}\n`, `="${secret}"\n`]) {
      const parsed = parseEnvFileStrict("any", read(text));
      expect(parsed.ok).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain(secret);
    }
  });

  it("is the ONE parser: validation, key names and value lookup all use it", () => {
    // Three subtly different parsers would eventually disagree about what a
    // file says, and the disagreement would be a key that sanitation misses.
    expect(MODULE).toContain("export function parseEnvFileStrict(");
    expect(MODULE).toContain("const parsed = parseEnvFileStrict(envFilePathFor(role, env));");
    expect(MODULE).toContain("parseEnvFileStrict(join(runtimeEnvDir(env), `${alias}.env`), readFile)");
    expect(CLI).toContain("const parsed = parseEnvFileStrict(envFilePathFor(role));");
    // And no second parser survives in the launcher.
    for (const forbidden of ['from "dotenv"', "readGates("]) {
      expect(`${forbidden} in the CLI:${CLI.includes(forbidden)}`).toBe(`${forbidden} in the CLI:false`);
    }
  });
});

describe("Start SAFE refuses a bad env file before it spawns anything", () => {
  function verdictFor(broken: "generic" | "account-a" | "account-b", text: string) {
    return validateEnvFiles(FAKE_ENV, (candidate) => {
      if (candidate.endsWith(`${broken}.env`)) return text;
      return "EXECUTION_GLOBAL_KILL_SWITCH=true\n";
    });
  }

  it("refuses a malformed generic.env", () => {
    const verdict = verdictFor("generic", "A=1\nnot an assignment\n");
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toEqual({
      alias: "generic",
      reasonCode: "ENV_FILE_MALFORMED",
      detail: "line 2",
    });
  });

  it("refuses a malformed account-a.env", () => {
    const verdict = verdictFor("account-a", "oops\n");
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.map((failure) => failure.alias)).toEqual(["account-a"]);
  });

  it("refuses a malformed account-b.env", () => {
    const verdict = verdictFor("account-b", "oops\n");
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.map((failure) => failure.alias)).toEqual(["account-b"]);
  });

  it("refuses a duplicate key in any of the three", () => {
    const verdict = verdictFor("account-b", "A=1\nA=2\n");
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0].reasonCode).toBe("ENV_FILE_DUPLICATE_KEY");
  });

  it("refuses an unreadable file", () => {
    const verdict = validateEnvFiles(FAKE_ENV, (candidate) => {
      if (candidate.endsWith("account-a.env")) {
        const error = new Error("locked") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return "A=1\n";
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0].reasonCode).toBe("ENV_FILE_UNREADABLE");
  });

  it("validates ALL THREE files before the first spawn, and returns on failure", () => {
    const start = CLI.slice(CLI.indexOf("async function startSafe"), CLI.indexOf("async function stopRuntime"));
    const validate = start.indexOf("validateEnvFiles()");
    const spawnAt = start.indexOf("spawnRoleWithDurableLog(");
    expect(validate).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(spawnAt);
    // Everything else that could refuse also precedes the spawn.
    for (const gate of [
      "evaluateSafeGatePosture(",
      "accountIdentitiesAreDistinct(",
      "evaluateDualStartPreconditions({",
    ]) {
      expect(`${gate} before spawn: ${start.indexOf(gate) < spawnAt}`).toBe(`${gate} before spawn: true`);
    }
    // The validation failure path returns rather than falling through.
    const block = start.slice(validate, start.indexOf("const validatedKeyNames"));
    expect(block).toContain("if (!envFiles.ok) {");
    expect(block).toContain("return;");
  });

  it("spawns with the key names VALIDATION produced, not a second read", () => {
    // No window in which a file could change between being approved and used.
    const start = CLI.slice(CLI.indexOf("async function startSafe"), CLI.indexOf("async function stopRuntime"));
    expect(start).toContain("const validatedKeyNames: EnvKeyNameReader = (role) =>");
    expect(start).toContain("envFiles.parsed.get(ROLE_CONTRACTS[role].envAlias)?.keys ?? []");
    expect(start).toContain("dualSpawnPlan(role, REPO_ROOT, process.env, validatedKeyNames)");
  });

  it("prints reason codes only, never a line's contents", () => {
    const start = CLI.slice(CLI.indexOf("async function startSafe"), CLI.indexOf("async function stopRuntime"));
    expect(start).toContain("describeEnvFileFailure(failure)");
    expect(describeEnvFileFailure({ alias: "account-b", reasonCode: "ENV_FILE_DUPLICATE_KEY", detail: "A" })).toBe(
      "account-b.env: ENV_FILE_DUPLICATE_KEY (A)"
    );
  });

  it("still produces the exact six-role spawn plan when all three files are valid", () => {
    const keys = () => ["DATABASE_URL"];
    const planned = DUAL_ROLES.map((role) => {
      const plan = dualSpawnPlan(role, REPO, FAKE_ENV, keys);
      return `${role} -> ${path.basename(String(plan.options.env.DOTENV_CONFIG_PATH))}`;
    });
    expect(planned).toEqual([
      "generic-backend -> generic.env",
      "generic-analysis -> generic.env",
      "account-a-control -> account-a.env",
      "account-a-worker -> account-a.env",
      "account-b-control -> account-b.env",
      "account-b-worker -> account-b.env",
    ]);
  });
});


// ===========================================================================
// First-start regression: a drained machine must read as OFF, not as STALE
// ===========================================================================

describe("a fully drained machine", () => {
  /** No attestation records at all: the ordinary state before a first start. */
  const NONE: AccountAttestationView = {
    backendFresh: 0,
    backendStale: 0,
    workerFresh: 0,
    workerStale: 0,
    effectiveGates: null,
  };
  /** A record that exists and has gone quiet. A fault, not an absence. */
  const STALE_BACKEND: AccountAttestationView = { ...NONE, backendStale: 2 };
  const STALE_WORKER: AccountAttestationView = { ...NONE, workerStale: 2 };

  const EMPTY = censusOf([], []);

  function drained(attestation: Record<string, AccountAttestationView | null> = {}) {
    return projectTopology({
      census: EMPTY,
      ownedRoles: [],
      attestation: { ACCOUNT_A: NONE, ACCOUNT_B: NONE, ...attestation },
    });
  }

  const verdictOf = (status: ReturnType<typeof projectTopology>) =>
    Object.fromEntries(status.roles.map((role) => [role.role, role.attestation]));
  const presenceOf = (status: ReturnType<typeof projectTopology>) =>
    Object.fromEntries(status.roles.map((role) => [role.role, role.presence]));

  it("1. a BACKEND with no record, no process and a closed port is ABSENT and OFF", () => {
    const status = drained();
    expect(verdictOf(status)["account-a-control"]).toBe("ABSENT");
    expect(presenceOf(status)["account-a-control"]).toBe("OFF");
    // The role has a port, and it is reported closed rather than unknown.
    const role = status.roles.find((entry) => entry.role === "account-a-control");
    expect(role?.portOpen).toBe(false);
  });

  it("2. a WORKER with no record and no process is ABSENT and OFF", () => {
    const status = drained();
    expect(verdictOf(status)["account-b-worker"]).toBe("ABSENT");
    expect(presenceOf(status)["account-b-worker"]).toBe("OFF");
  });

  it("8. all six roles read OFF, and nothing is reported as external", () => {
    const status = drained();
    for (const role of status.roles) {
      expect(`${role.label} -> ${role.presence}`).toBe(`${role.label} -> OFF`);
    }
    expect(status.anyExternal).toBe(false);
  });

  it("3. a stale BACKEND record is STALE, and does NOT imply presence", () => {
    const status = drained({ ACCOUNT_A: STALE_BACKEND });
    expect(verdictOf(status)["account-a-control"]).toBe("STALE");
    // A record that went quiet is a fault worth blocking over, but it is not
    // evidence that a process is running now.
    expect(presenceOf(status)["account-a-control"]).toBe("OFF");
  });

  it("4. a stale WORKER record is STALE, and does NOT imply presence", () => {
    const status = drained({ ACCOUNT_B: STALE_WORKER });
    expect(verdictOf(status)["account-b-worker"]).toBe("STALE");
    expect(presenceOf(status)["account-b-worker"]).toBe("OFF");
  });

  it("3 and 4. a stale record still BLOCKS Start SAFE", () => {
    for (const [label, attestation] of [
      ["BACKEND", { ACCOUNT_A: STALE_BACKEND }],
      ["WORKER", { ACCOUNT_B: STALE_WORKER }],
    ] as const) {
      const verdict = evaluateDualStartPreconditions({
        status: drained(attestation),
        envFiles: { ok: true, failures: [], parsed: new Map() },
        ownedAliveCount: 0,
        identities: { ok: true },
      });
      expect(`${label} blocks: ${verdict.ok === false}`).toBe(`${label} blocks: true`);
      expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("STALE");
    }
  });

  it("5. exactly one fresh external BACKEND is DETECTED", () => {
    const status = projectTopology({
      census: censusOf(
        [processOn("src/account-control.server.ts", 31)],
        [listener(4001, "127.0.0.1", 31)]
      ),
      ownedRoles: [],
      attestation: { ACCOUNT_A: { ...NONE, backendFresh: 1 }, ACCOUNT_B: NONE },
    });
    expect(verdictOf(status)["account-a-control"]).toBe("HEALTHY");
    expect(presenceOf(status)["account-a-control"]).toBe("DETECTED");
    expect(status.anyExternal).toBe(true);
  });

  it("6. exactly one fresh external WORKER is DETECTED, with no port to help", () => {
    // The worker holds no port and shares its command line with the other
    // account's worker, so a fresh attestation is the ONLY thing that can
    // attribute it. It must still count.
    const status = projectTopology({
      census: censusOf([processOn("src/modules/jobs/execution.worker.ts", 32)], []),
      ownedRoles: [],
      attestation: { ACCOUNT_A: NONE, ACCOUNT_B: { ...NONE, workerFresh: 1 } },
    });
    expect(verdictOf(status)["account-b-worker"]).toBe("HEALTHY");
    expect(presenceOf(status)["account-b-worker"]).toBe("DETECTED");
    // And the OTHER account's worker is not claimed by it.
    expect(presenceOf(status)["account-a-worker"]).toBe("OFF");
  });

  it("7. permits a clean start: no records, no ports, no census, no ownership", () => {
    // The regression this whole block exists for. Before the fix this returned
    // eight refusals on a machine with nothing running at all.
    const verdict = evaluateDualStartPreconditions({
      status: drained(),
      envFiles: { ok: true, failures: [], parsed: new Map() },
      ownedAliveCount: 0,
      identities: { ok: true },
    });
    expect(verdict).toEqual({ ok: true });
  });

  it("9. ABSENT FAILS final topology verification, because a started role must attest", () => {
    // Same verdict, opposite meaning either side of a spawn: before a start it
    // is the expected state, after one it means the role never came up.
    const started = projectTopology({
      census: externalSixRoleCensus(),
      ownedRoles: [...DUAL_ROLES],
      attestation: { ACCOUNT_A: HEALTHY, ACCOUNT_B: { ...NONE, backendFresh: 1 } },
    });
    const verdict = verifyDualTopology(started);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain(
      "Account B Execution Worker is not attesting"
    );
  });

  it("9. a fully attesting six-role topology still verifies", () => {
    const started = projectTopology({
      census: externalSixRoleCensus(),
      ownedRoles: [...DUAL_ROLES],
      attestation: { ACCOUNT_A: HEALTHY, ACCOUNT_B: HEALTHY },
    });
    expect(verifyDualTopology(started)).toEqual({ ok: true });
  });

  it("10. renders ABSENT as plain english, and never as external", () => {
    expect(CLI).toContain('role.attestation === "ABSENT"');
    expect(CLI).toContain('"   not attesting"');
    // Presence and the attestation label are rendered from separate fields, so
    // an absent record cannot produce an ON line.
    expect(CLI).toContain('role.presence === "OWNED" ? "ON  (launcher-owned)"');
  });

  it("a count it could not read is UNKNOWN, never ABSENT", () => {
    // Both counts are required to tell absence from staleness, so an
    // unreadable EITHER makes the verdict unknown. Reading a missing stale
    // count as zero would report "nothing here" on no evidence.
    for (const [label, view] of [
      ["stale unreadable", { ...NONE, backendStale: null }],
      ["fresh unreadable", { ...NONE, backendFresh: null }],
      ["both unreadable", { ...NONE, backendFresh: null, backendStale: null }],
    ] as const) {
      const status = drained({ ACCOUNT_A: view });
      expect(`${label} -> ${verdictOf(status)["account-a-control"]}`).toBe(`${label} -> UNKNOWN`);
      // And an unknown is not presence either.
      expect(`${label} presence -> ${presenceOf(status)["account-a-control"]}`).toBe(
        `${label} presence -> OFF`
      );
    }
  });

  it("11. supervision maps ABSENT on an OFF role to OFF, not through STALE", () => {
    const supervision = CLI.slice(CLI.indexOf("const health = (view: RoleStatus | undefined)"));
    expect(supervision).toContain('if (view?.attestation === "HEALTHY") return "HEALTHY";');
    expect(supervision).toContain('if (view.presence === "OFF") return "OFF";');
    expect(supervision).toContain('return view.attestation === "ABSENT" ? "OFF" : "STALE";');
    // Both health inputs come from that one mapping.
    expect(CLI).toContain("workerHealth: health(workerView),");
    expect(CLI).toContain("backendHealth: health(controlView),");
    expect(CLI).toContain("const observedBudget = observeWorkerHealth(from, health(workerView), nowMs);");
  });
});


// ===========================================================================
// Ownership: a launcher-started tree must stay verifiably ours
// ===========================================================================

describe("the ownership PID probe", () => {
  it("3. asks for the requested PIDs and restricts nothing else", () => {
    // The whole defect in one assertion. The census asks `Name='node.exe'`,
    // which is right for finding runtime ROLES; ownership asks about a
    // specific PID, and that PID is the cmd.exe `spawn` returned. Reusing the
    // node-only census here made every ownership probe come back empty.
    const query = buildProcessProbeQuery([7352, 15588]);
    expect(query).not.toBeNull();
    expect(query).toContain("ProcessId=7352");
    expect(query).toContain("ProcessId=15588");
    expect(query).toContain("Get-CimInstance Win32_Process -Filter");
    expect(`Name filter present: ${/Name=/.test(query ?? "")}`).toBe("Name filter present: false");
  });

  it("3. never issues an empty filter, which would match every process", () => {
    expect(buildProcessProbeQuery([])).toBeNull();
  });

  it("3. asks about each PID once, and only about integral non-negative PIDs", () => {
    const query = buildProcessProbeQuery([7352, 7352, -1, 1.5, 15588]) ?? "";
    expect((query.match(/ProcessId=/g) ?? [])).toHaveLength(2);
    expect(query).not.toContain("ProcessId=-1");
    expect(query).not.toContain("ProcessId=1.5");
  });

  it("2. resolves a NON-node.exe process, which is the anchor's actual type", () => {
    // The recorded anchor is `cmd.exe /d /s /c pnpm …`. Parsing must carry it
    // through unchanged so `verifyOwnership` can check the repo path on it.
    const rows = parseProcessProbeRows(
      "7352|1790497694208|cmd.exe /d /s /c pnpm -C C:\\repo --filter pkg dev\r\n"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pid).toBe(7352);
    expect(rows[0].startedAtMs).toBe(1790497694208);
    expect(rows[0].commandLine).toContain("cmd.exe");
    expect(rows[0].commandLine).toContain("C:\\repo");
  });

  it("2. ignores blank and unparseable rows rather than inventing a probe", () => {
    expect(parseProcessProbeRows("")).toEqual([]);
    expect(parseProcessProbeRows("\r\n  \r\n")).toEqual([]);
    expect(parseProcessProbeRows("notanumber|alsonot|x")).toEqual([]);
  });
});

describe("ownership verification over the Windows wrapper chain", () => {
  const REPO = path.join("C:", "repo");
  const ANCHOR = { role: "account-a-worker", pid: 5080, startedAtMs: 1_790_497_710_779 };
  const probe = (over: Partial<{ pid: number; startedAtMs: number; commandLine: string }> = {}) => ({
    pid: ANCHOR.pid,
    startedAtMs: ANCHOR.startedAtMs,
    commandLine: `cmd.exe /d /s /c pnpm -C ${REPO} --filter pkg execution-worker`,
    ...over,
  });

  it("1 and 13. a live cmd.exe anchor from the launcher verifies as OWNED", () => {
    // cmd -> pnpm -> tsx watch -> node: the anchor is the cmd at the head, and
    // it outlives every reload beneath it.
    expect(verifyOwnership(ANCHOR, probe(), REPO)).toEqual({ owned: true });
  });

  it("4. an anchor that is genuinely gone stays GONE, however alive its children are", () => {
    // A surviving descendant is not ownership: the launcher recorded the
    // anchor, and only the anchor can prove the tree is still the one it made.
    expect(verifyOwnership(ANCHOR, null, REPO)).toEqual({ owned: false, reason: "GONE" });
  });

  it("10. a recycled PID is rejected on creation time", () => {
    expect(verifyOwnership(ANCHOR, probe({ startedAtMs: ANCHOR.startedAtMs + 5_000 }), REPO)).toEqual({
      owned: false,
      reason: "PID_REUSED",
    });
    // The existing tolerance is unchanged: a sub-second difference still passes.
    expect(verifyOwnership(ANCHOR, probe({ startedAtMs: ANCHOR.startedAtMs - 750 }), REPO).owned).toBe(true);
  });

  it("11. a process from another checkout is rejected", () => {
    const foreign = probe({ commandLine: "cmd.exe /d /s /c pnpm -C C:\\other-repo --filter pkg execution-worker" });
    expect(verifyOwnership(ANCHOR, foreign, REPO)).toEqual({ owned: false, reason: "NOT_THIS_REPO" });
  });
});

describe("Start SAFE verification requires ownership", () => {
  const HEALTHY_BOTH = { ACCOUNT_A: HEALTHY, ACCOUNT_B: HEALTHY };

  function verified(ownedRoles: DualRole[]) {
    return verifyDualTopology(
      projectTopology({ census: externalSixRoleCensus(), ownedRoles, attestation: HEALTHY_BOTH })
    );
  }

  it("5. six OWNED roles with healthy attestations and correct ports PASS", () => {
    expect(verified([...DUAL_ROLES])).toEqual({ ok: true });
  });

  it("6. five OWNED and one DETECTED FAILS, naming that role", () => {
    const verdict = verified(DUAL_ROLES.filter((role) => role !== "account-b-worker"));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain(
      "Account B Execution Worker is running but this launcher does not own it"
    );
    // The five it does own raise nothing.
    expect(verdict.ok === false && verdict.reasons).toHaveLength(1);
  });

  it("7. six DETECTED roles FAIL even though everything else looks perfect", () => {
    // The exact state the first real Start SAFE produced: right ports, four
    // healthy attestations, six processes — and not one of them ours.
    const verdict = verified([]);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons).toHaveLength(6);
    for (const reason of verdict.ok === false ? verdict.reasons : []) {
      expect(reason).toContain("does not own it");
    }
  });

  it("4. a role whose anchor vanished cannot pass final verification", () => {
    // Ownership was lost between spawn and verification: the role is still
    // running and attesting, but the launcher can no longer prove it started
    // it — which is exactly when it must not report success.
    const verdict = verified(DUAL_ROLES.filter((role) => role !== "account-a-control"));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("Account A Control is running but");
  });

  it("an OFF role still reports as not running, not as unowned", () => {
    const verdict = verifyDualTopology(
      projectTopology({ census: censusOf([], []), ownedRoles: [], attestation: HEALTHY_BOTH })
    );
    expect(verdict.ok).toBe(false);
    // Generic roles publish no attestation and have no process, so they are OFF.
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("Generic Backend is not running.");
    expect(verdict.ok === false && verdict.reasons.join(" ")).not.toContain("Generic Backend is running but");
  });
});

describe("ownership is never inferred", () => {
  it("8. a detected external role is never promoted to OWNED", () => {
    const status = projectTopology({
      census: externalSixRoleCensus(),
      ownedRoles: [],
      attestation: { ACCOUNT_A: HEALTHY, ACCOUNT_B: HEALTHY },
    });
    for (const role of status.roles) {
      expect(`${role.label} -> ${role.presence}`).toBe(`${role.label} -> DETECTED`);
    }
    // Healthy attestation and a held port are presence evidence, never title.
    expect(status.anyExternal).toBe(true);
  });

  it("8. there is no adoption path from detection to ownership", () => {
    // A substring ban on the word would be meaningless here -- plan ADOPTION is
    // a legitimate domain concept elsewhere in the launcher's prose. What must
    // not exist is a MECHANISM that grants ownership to something the launcher
    // did not start.
    for (const forbidden of [/function\s+adopt/, /claimExisting/, /adoptRole/, /claimRole/]) {
      expect(`${forbidden.source}:${forbidden.test(CLI + MODULE)}`).toBe(`${forbidden.source}:false`);
    }
    // OWNED is assigned in exactly one place, from the ownership set alone.
    expect(MODULE).toContain('if (owned.has(role)) presence = "OWNED";');
    expect((MODULE.match(/presence = "OWNED"/g) ?? [])).toHaveLength(1);
    expect(`OWNED assigned in the CLI:${/presence = "OWNED"/.test(CLI)}`).toBe(
      "OWNED assigned in the CLI:false"
    );
  });

  it("9. stop and rollback act only on verified-owned roots", () => {
    const stop = CLI.slice(CLI.indexOf("async function stopRuntime"), CLI.indexOf("async function superviseAccountWorker"));
    expect(stop).toContain("alive.filter((entry) => entry.role === role)");
    // Ownership is judged before the kill. (`indexOf` is compared against a
    // found position on BOTH sides, so a missing call fails rather than
    // passing vacuously on -1.)
    expect(stop.indexOf("judgeOwnedTree(record")).toBeGreaterThanOrEqual(0);
    expect(stop.indexOf("judgeOwnedTree(record")).toBeLessThan(stop.indexOf("terminateTree("));
    const start = CLI.slice(CLI.indexOf("async function startSafe"), CLI.indexOf("async function stopRuntime"));
    expect(start).toContain("[...started].reverse()");
    // The rollback delegates the whole sequence -- judge, terminate, retain --
    // to `executeRollback`, which is covered behaviourally in
    // tests/worker-supervision.test.ts. What must hold HERE is that the CLI
    // persists what that decision returned instead of clearing it away.
    expect(start).toContain("executeRollback([...started].reverse(), REPO_ROOT, {");
    expect(start).toContain("if (complete) {");
    expect(start).toContain("processes: retained });");
    // A record that cannot be proved is reported, never killed.
    expect(stop).toContain("NOT terminated");
  });

  it("12. an A worker record cannot be satisfied by B's worker process", () => {
    // Ownership is keyed by ROLE and anchored to one PID. The two workers share
    // a command line, so nothing else could tell them apart.
    const repo = path.join("C:", "repo");
    const aRecord = { role: "account-a-worker", pid: 5080, startedAtMs: 1_000_000 };
    const bProbe = {
      pid: 24744,
      startedAtMs: 1_000_000,
      commandLine: `cmd.exe /d /s /c pnpm -C ${repo} --filter pkg execution-worker`,
    };
    // The launcher only ever probes the recorded PID; B's PID is not it.
    const probes = new Map([[bProbe.pid, bProbe]]);
    expect(verifyOwnership(aRecord, probes.get(aRecord.pid) ?? null, repo)).toEqual({
      owned: false,
      reason: "GONE",
    });
    // And the state record carries the role, so a B process cannot fill an A slot.
    const status = projectTopology({
      census: censusOf([], []),
      ownedRoles: ["account-b-worker"],
      attestation: {},
    });
    const byRole = Object.fromEntries(status.roles.map((role) => [role.role, role.presence]));
    expect(byRole["account-b-worker"]).toBe("OWNED");
    expect(byRole["account-a-worker"]).toBe("OFF");
  });
});


// ===========================================================================
// The durable marker, where the CLI meets the machine
//
// The DECISIONS about a marker are pure and tested in
// `account-runtime-transition.test.ts`. What is left to prove here is the
// wiring: that every action which starts, stops or supervises a role actually
// consults the gate, and that no writer of the state file can drop the marker.
// ===========================================================================

describe("the transition marker fences the CLI's other actions", () => {
  const blockOf = (fn: string, next: string): string => CLI.slice(CLI.indexOf(fn), CLI.indexOf(next));

  it("Start SAFE consults the gate for all six roles, before anything else", () => {
    const startSafe = blockOf("async function startSafe", "async function stopRuntime");
    expect(startSafe).toContain("if (!transitionGateAllows(DUAL_ROLES)) return;");
    // Before the first spawn, and before the first file is even validated for
    // spawning: an interrupted transition is not something to start over.
    expect(startSafe.indexOf("transitionGateAllows")).toBeLessThan(
      startSafe.indexOf("spawnRoleWithDurableLog(")
    );
  });

  it("Stop Runtime consults it too, since it terminates the fenced pair", () => {
    const stop = blockOf("async function stopRuntime", "function unaccountedLeavesFor");
    expect(stop).toContain("if (!transitionGateAllows(DUAL_ROLES)) return;");
    expect(stop.indexOf("transitionGateAllows")).toBeLessThan(stop.indexOf("terminateTree("));
  });

  it("account supervision is fenced by THAT account's pair only", () => {
    const supervise = blockOf("async function superviseAccountWorker", "async function superviseGenericAnalysis");
    expect(supervise).toContain("const { control: supervisedControl } = rolesForAccount(account);");
    expect(supervise).toContain("if (!transitionGateAllows([supervisedControl, workerRole])) return;");
    // Not DUAL_ROLES: Account B's supervisor must keep working while Account A
    // is mid-transition.
    expect(supervise).not.toContain("transitionGateAllows(DUAL_ROLES)");
  });

  it("generic supervision is fenced only by a marker nobody can read", () => {
    const generic = blockOf("async function superviseGenericAnalysis", "// Account-scoped SAFE <-> LIVE-READY transition");
    expect(generic).toContain("if (!transitionGateAllows([GENERIC_ANALYSIS_ROLE])) return;");
    // The generic role belongs to neither account, so a PENDING marker for one
    // account leaves it alone -- which is the pure gate's rule, not a second
    // copy of it here.
    expect(generic).not.toContain("DUAL_ROLES");
  });

  it("every gate refusal goes through ONE printer, so they all read the same", () => {
    // 1 definition + 5 call sites: Start SAFE, Stop Runtime, account
    // supervision, generic supervision, and the transition action itself.
    expect((CLI.match(/transitionGateAllows\(/g) ?? []).length).toBe(6);
    const printer = blockOf("function transitionGateAllows", "function clearState");
    expect(printer).toContain("BLOCKED — nothing was changed:");
    expect(printer).toContain("return true;");
  });
});

describe("no writer of the launcher state can drop the marker", () => {
  it("only ONE function touches the file, and every writer goes through it", () => {
    // `writeState` is what the process-management paths call, and it carries
    // the marker forward for them. A rollback or a replacement that rewrote
    // the file without it would erase the record of an interrupted transition
    // at exactly the moment it matters most.
    expect((CLI.match(/writeFileSync\(temporary, JSON\.stringify\(state/g) ?? []).length).toBe(1);
    const writeState = CLI.slice(CLI.indexOf("function writeState("), CLI.indexOf("/** The only function that touches the file"));
    expect(writeState).toContain("transition: carriedTransition()");
  });

  it("a state file that cannot be parsed is rewritten WITH a blocking marker", () => {
    // Rewriting it clean would turn "this machine may be mid-transition" into
    // "this machine is idle", which is the one conversion that must never
    // happen silently.
    const carried = CLI.slice(CLI.indexOf("function carriedTransition"), CLI.indexOf("Writes the six role records"));
    expect(carried).toContain("raw.readable ? raw.value : UNREADABLE_MARKER");
    expect(CLI).toContain('const UNREADABLE_MARKER = { corrupt:');
  });

  it("a MISSING state file is a proven absence, not an unreadable one", () => {
    const reader = CLI.slice(CLI.indexOf("function readRawTransition"), CLI.indexOf("const UNREADABLE_MARKER"));
    // ENOENT means nothing has ever been started here. Every OTHER read
    // failure is a question nobody answered.
    expect(reader).toContain('code === "ENOENT"');
    expect(reader).toContain("return { readable: true, value: undefined };");
    expect(reader).toContain("return { readable: false, value: undefined };");
  });

  it("the marker writer THROWS rather than swallowing a failed write", () => {
    // The sequence treats an unwritable marker as a reason to stop. It cannot
    // make that decision if this reports success.
    const writer = CLI.slice(CLI.indexOf("function writeTransitionMarker"), CLI.indexOf("function readTransitionMarker"));
    expect(writer).not.toContain("try {");
    expect(writer).not.toContain("catch");
  });

  it("the marker never carries an environment value, a port or a pid", () => {
    const journal = CLI.slice(CLI.indexOf("journal: (phase: TransitionPhase)"), CLI.indexOf("clearJournal:"));
    for (const forbidden of ["envValue", "port", "pid", "OPERATOR_API_TOKEN", "readFileSync"]) {
      expect(`${forbidden}:${journal.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

describe("the account transition reaches only the selected account", () => {
  const action = CLI.slice(
    CLI.indexOf("async function transitionAccount"),
    CLI.indexOf("async function recoverIncompleteTransition")
  );

  it("reads the selected account's own control plane, never the other's", () => {
    const gather = CLI.slice(
      CLI.indexOf("async function gatherAccountFacts"),
      CLI.indexOf("const printBlocked")
    );
    expect(gather).toContain("readSelectedAccount(account)");
    expect(gather).toContain("readAccountFlatness(account)");
    expect(gather).toContain("diskModeFor(account)");
    expect(gather).toContain("selectedRoleOwnership(account)");
    for (const forbidden of ["ACCOUNT_B", "account-b", "RUNTIME_ACCOUNTS", "readAllAttestation"]) {
      expect(`${forbidden}:${(gather + action).includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("proves the mode it is moving FROM, and refuses when it cannot", () => {
    expect(action).toContain("if (!first.mode.ok) {");
    expect(action).toContain("decideModeTransition(first.mode.mode, targetMode)");
    expect(action).toContain('if (decision.kind === "ALREADY")');
    // The direction reaching the engine is the proven one, not the opposite of
    // the target. No expression anywhere derives one from the other.
    expect(action).not.toContain('targetMode === "SAFE" ? "LIVE_READY"');
    expect(CLI).not.toContain('fromMode: targetMode === "SAFE"');
  });

  it("re-proves EVERYTHING after the operator types the account name", () => {
    const confirmAt = action.indexOf("confirmation !== account");
    const secondAt = action.indexOf("const second = await gatherAccountFacts(account);");
    const proofAt = action.indexOf("evaluateSecondProof(");
    const runAt = action.indexOf("executeAccountTransition(");

    // Gathered again AFTER the confirmation, judged, and only then run.
    expect(confirmAt).toBeGreaterThan(-1);
    expect(secondAt).toBeGreaterThan(confirmAt);
    expect(proofAt).toBeGreaterThan(secondAt);
    expect(runAt).toBeGreaterThan(proofAt);
    // And a failed second proof returns before the engine is reached.
    expect(action).toContain("if (!settled.ok) {");
    expect(action).toContain(
      "These facts changed while the confirmation was open, so nothing was stopped, written or started."
    );
  });

  it("requires the operator to type the account name before anything moves", () => {
    expect(action).toContain("const confirmation = (await ask(`Type ${account} to proceed: `)).trim();");
    expect(action).toContain("if (confirmation !== account) {");
    // And the confirmation is read BEFORE the sequence runs.
    expect(action.indexOf("confirmation !== account")).toBeLessThan(action.indexOf("executeAccountTransition"));
  });

  it("says plainly that it arms nothing", () => {
    expect(action).toContain("This arms NOTHING: no profile is enabled, no kill switch is released");
    expect(action).toContain("The other account and the two generic roles are not touched.");
    expect(action).toContain("Trading remains OFF until it is armed separately.");
  });

  it("recovery runs the RECOVERY engine, not a fresh transition", () => {
    const recover = CLI.slice(
      CLI.indexOf("async function recoverIncompleteTransition"),
      CLI.indexOf("async function main")
    );
    // A fresh transition would overwrite the marker with its own PRECHECKED
    // and could then clear it on a clean refusal -- erasing the record of the
    // half-moved account it was called to repair.
    expect(recover).toContain("executeTransitionRecovery(");
    expect(recover).not.toContain("executeAccountTransition(");
    // The EXISTING marker is what it plans from: its phase and its proven
    // direction are the only evidence of how far the interrupted run got.
    expect(recover).toContain("const pending = marker.transition;");
    expect(recover).toContain("fromMode: pending.fromMode");
    expect(recover).toContain("startedAtMs: pending.startedAtMs");
    // It never resumes towards LIVE-READY.
    expect(recover).not.toContain('targetMode: "LIVE_READY"');
  });

  it("recovery says plainly that the marker survives an unproven outcome", () => {
    const recover = CLI.slice(
      CLI.indexOf("async function recoverIncompleteTransition"),
      CLI.indexOf("async function main")
    );
    expect(recover).toContain("The marker is cleared ONLY if SAFE is proven afterwards.");
    expect(recover).toContain("The marker was KEPT.");
  });

  it("an unreadable marker names no account, so recovery refuses to guess one", () => {
    const recover = CLI.slice(
      CLI.indexOf("async function recoverIncompleteTransition"),
      CLI.indexOf("async function main")
    );
    expect(recover).toContain('if (marker.status === "UNREADABLE")');
    expect(recover).toContain("It does not say which account it was about");
  });
});


describe("the journal write can never invent an empty runtime", () => {
  it("the marker writer goes through the STRICT reader, which validates", () => {
    const writer = CLI.slice(
      CLI.indexOf("function writeTransitionMarker"),
      CLI.indexOf("function readTransitionMarker")
    );
    expect(writer).toContain("const current = readStateStrict();");
    // The ownership records are carried through exactly; this function's only
    // edit is the marker.
    expect(writer).toContain("processes: current.processes,");
    for (const forbidden of ["?? []", "?? REPO_ROOT", "readState()"]) {
      expect(`${forbidden}:${writer.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("the strict reader refuses instead of defaulting, and delegates its rules", () => {
    const reader = CLI.slice(
      CLI.indexOf("function readStateStrict"),
      CLI.indexOf("/**\r\n * Persists one transition phase")
    );
    expect(reader).toContain("parseLauncherStateStrict(text, REPO_ROOT)");
    expect(reader).toContain("if (!parsed.ok) throw new Error(parsed.reason);");
    // A MISSING file throws from readFileSync rather than becoming a blank
    // state: once a transition is under way, lost records are not an empty
    // runtime.
    expect(reader).toContain('readFileSync(STATE_PATH, "utf8")');
    expect(reader).not.toContain("try {");
  });
});

describe("the account env file is replaced without leaving a credential behind", () => {
  const writer = CLI.slice(CLI.indexOf("function writeAccountGates"), CLI.indexOf("function diskModeFor"));

  it("removes the temp copy when the rename fails", () => {
    // The temp file is a COMPLETE copy of the account environment, API key
    // included. A failed rename must not leave it lying under a name nobody
    // is watching.
    expect(writer).toContain("unlinkSync(temporary)");
    expect(writer.indexOf("unlinkSync(temporary)")).toBeGreaterThan(writer.indexOf("} catch {"));
  });

  it("never logs the file, its path or its contents", () => {
    expect(writer).not.toContain("console.log");
    expect(writer).toContain("environment file could not be replaced");
    // Every reason this function returns is a FIXED string. `${file}` appears
    // in the block, but only to build the temp path -- never inside a message
    // that reaches a terminal scrollback.
    const messages = [...writer.matchAll(/reason: ([^\n]+)/g)].map((match) => match[1]);
    expect(messages.length).toBeGreaterThan(2);
    for (const message of messages) {
      expect(`${message} interpolates: ${message.includes("${") || message.includes("`")}`).toBe(
        `${message} interpolates: false`
      );
    }
  });
});


// ===========================================================================
// The machine-wide mutation lock, where the CLI meets it
//
// The lock's own decisions are exercised in `mutation-lock.test.ts`. What is
// left to prove here is that every action which changes runtime, process or
// environment state actually goes through it -- and that reading status does
// not, because an operator who is blocked must still be able to see why.
// ===========================================================================

describe("every mutating launcher action holds mutation authority", () => {
  const menu = CLI.slice(CLI.indexOf('const choice = (await ask("Choose: ")).trim();'), CLI.length);

  it("Start SAFE and Stop Runtime are wrapped at the menu", () => {
    expect(menu).toContain('await underMutationLock("START_SAFE", startSafe)');
    expect(menu).toContain('await underMutationLock("STOP_RUNTIME", stopRuntime)');
    // Never called bare from the menu.
    expect(menu).not.toContain('choice === "2") await startSafe()');
    expect(menu).not.toContain('choice === "4") await stopRuntime()');
  });

  it("Prepare LIVE-READY and Return to SAFE are wrapped, with the right action", () => {
    const action = CLI.slice(
      CLI.indexOf("async function transitionAccount"),
      CLI.indexOf("async function runAccountTransition")
    );
    expect(action).toContain('targetMode === "SAFE" ? "RETURN_TO_SAFE" : "PREPARE_LIVE_READY"');
    expect(action).toContain("withMutationLock(");
    expect(action).toContain("() => runAccountTransition(account, targetMode, ask)");
  });

  it("Recover an INCOMPLETE transition is wrapped before it reads the marker", () => {
    const action = CLI.slice(
      CLI.indexOf("async function recoverIncompleteTransition"),
      CLI.indexOf("async function runRecoveryAction")
    );
    expect(action).toContain('withMutationLock("RECOVER_TRANSITION"');
    // The marker is read inside the locked body, so the record an operator is
    // shown is the record still there when they confirm.
    expect(action).not.toContain("readTransitionMarker()");
  });

  it("the HUMAN CONFIRMATION happens while the lock is held", () => {
    // The whole reason the lock wraps the action rather than just the mutation:
    // otherwise a second launcher can act during the confirmation gap.
    const locked = CLI.slice(
      CLI.indexOf("async function runAccountTransition"),
      CLI.indexOf("async function recoverIncompleteTransition")
    );
    expect(locked).toContain("await ask(`Type ${account} to proceed: `)");
    expect(locked).toContain("gatherAccountFacts(account)");
    expect(locked).toContain("executeAccountTransition(");

    const recovery = CLI.slice(
      CLI.indexOf("async function runRecoveryAction"),
      CLI.indexOf("async function main")
    );
    expect(recovery).toContain("await ask(`Type ${account} to recover: `)");
    expect(recovery).toContain("executeTransitionRecovery(");
  });

  it("the second proof still runs INSIDE the lock, after the confirmation", () => {
    const locked = CLI.slice(
      CLI.indexOf("async function runAccountTransition"),
      CLI.indexOf("async function recoverIncompleteTransition")
    );
    const confirmAt = locked.indexOf("confirmation !== account");
    const secondAt = locked.indexOf("const second = await gatherAccountFacts(account);");
    const proofAt = locked.indexOf("evaluateSecondProof(");
    expect(secondAt).toBeGreaterThan(confirmAt);
    expect(proofAt).toBeGreaterThan(secondAt);
  });

  it("Show Status takes NO lock, so a blocked operator can still see why", () => {
    expect(menu).toContain('if (choice === "1") continue;');
    // The status path is `collectStatus`, and nothing in it acquires anything.
    const status = CLI.slice(CLI.indexOf("async function collectStatus"), CLI.indexOf("function gateLine"));
    for (const forbidden of ["withMutationLock", "acquireMutationLock", "underMutationLock"]) {
      expect(`status/${forbidden}:${status.includes(forbidden)}`).toBe(`status/${forbidden}:false`);
    }
  });

  it("there are exactly as many lock acquisitions as there are mutating actions", () => {
    // START_SAFE, STOP_RUNTIME, the transition (two modes, one call site),
    // RECOVER_TRANSITION, and the two supervisors' restarts.
    expect((CLI.match(/withMutationLock\(/g) ?? []).length).toBe(5);
    expect((CLI.match(/underMutationLock\(/g) ?? []).length).toBe(3); // 1 definition + 2 uses
    // Nothing takes the lock directly; the acquire/release pair is written once.
    expect(CLI).not.toContain("acquireMutationLock(");
  });
});

describe("supervision takes the lock only when it is about to mutate", () => {
  const supervisors = [
    ["account", "async function superviseAccountWorker", "async function superviseGenericAnalysis"],
    ["generic analysis", "async function superviseGenericAnalysis", "// ---------------------------------------------------------------------------\r\n// Account-scoped SAFE"],
  ] as const;

  it.each(supervisors)("the %s supervisor observes without the lock", (_label, from, to) => {
    const body = CLI.slice(CLI.indexOf(from), CLI.indexOf(to));
    // The first assessment happens before any acquisition, and a decision of
    // NONE returns without ever touching the lock -- so a supervisor sitting
    // open does not block an operator.
    expect(body).toContain("const first = await assess(budget);");
    expect(body.indexOf("const first = await assess(budget);")).toBeLessThan(
      body.indexOf("withMutationLock(")
    );
    expect(body).toContain('if (first.decision.action === "NONE") {');
    const noneBranch = body.slice(
      body.indexOf('if (first.decision.action === "NONE") {'),
      body.indexOf("withMutationLock(")
    );
    expect(noneBranch).not.toContain("withMutationLock");
  });

  it.each(supervisors)("the %s supervisor RE-PROVES the decision under the lock", (_label, from, to) => {
    const body = CLI.slice(CLI.indexOf(from), CLI.indexOf(to));
    const locked = body.slice(body.indexOf("withMutationLock("));
    // A second assessment, inside the locked body, and the restart is driven
    // from THAT decision.
    expect(locked).toContain("const now = await assess(budget);");
    expect(locked).toContain('if (now.decision.action === "NONE") {');
    expect(locked).toContain("restartOwnedRole(now.decision");
    // The stale first decision never reaches a restart.
    expect(locked).not.toContain("restartOwnedRole(first.decision");
  });

  it.each(supervisors)("the %s supervisor spends no attempt when authority is refused", (_label, from, to) => {
    const body = CLI.slice(CLI.indexOf(from), CLI.indexOf(to));
    const refusal = body.slice(body.indexOf("if (held.ran) return held.result;"));
    expect(refusal).toContain("nothing was restarted.");
    // `recordRestartAttempt` lives inside the locked body only, so a refusal
    // cannot burn the restart budget.
    expect(refusal).not.toContain("recordRestartAttempt");
  });

  it("both supervisors use the SUPERVISE_RESTART action", () => {
    expect((CLI.match(/withMutationLock\("SUPERVISE_RESTART"/g) ?? []).length).toBe(2);
  });
});


describe("a long-running supervisor re-reads the marker under the lock", () => {
  const supervisors = [
    ["account", "async function superviseAccountWorker", "async function superviseGenericAnalysis"],
    [
      "generic analysis",
      "async function superviseGenericAnalysis",
      "// ---------------------------------------------------------------------------\r\n// Account-scoped SAFE",
    ],
  ] as const;

  it.each(supervisors)("the %s supervisor proves the marker INSIDE the locked body", (_label, from, to) => {
    const body = CLI.slice(CLI.indexOf(from), CLI.indexOf(to));
    const locked = body.slice(body.indexOf("withMutationLock("));

    // Read again here, not trusted from startup: hours may have passed, and a
    // transition that began and crashed since would have left this account
    // PENDING with the mutex already released by the OS.
    expect(locked).toContain("judgeSupervisedRestart(readTransitionMarker()");
    // Before the health re-assessment, so a blocked tick does no work at all.
    expect(locked.indexOf("judgeSupervisedRestart(")).toBeLessThan(locked.indexOf("await assess(budget)"));
    expect(locked).toContain('if (gate.act === "REFUSE") {');
  });

  it("the account supervisor proves its OWN pair, never the whole topology", () => {
    const body = CLI.slice(
      CLI.indexOf("async function superviseAccountWorker"),
      CLI.indexOf("async function superviseGenericAnalysis")
    );
    expect(body).toContain("judgeSupervisedRestart(readTransitionMarker(), [supervisedControl, workerRole])");
    expect(body).not.toContain("judgeSupervisedRestart(readTransitionMarker(), DUAL_ROLES)");
  });

  it("the generic supervisor proves only the generic role", () => {
    const body = CLI.slice(
      CLI.indexOf("async function superviseGenericAnalysis"),
      CLI.indexOf("// ---------------------------------------------------------------------------\r\n// Account-scoped SAFE")
    );
    expect(body).toContain("judgeSupervisedRestart(readTransitionMarker(), [GENERIC_ANALYSIS_ROLE])");
  });

  it.each(supervisors)("a blocked %s tick spends no attempt and touches nothing", (_label, from, to) => {
    const body = CLI.slice(CLI.indexOf(from), CLI.indexOf(to));
    const locked = body.slice(body.indexOf("withMutationLock("));
    const refusal = locked.slice(
      locked.indexOf('if (gate.act === "REFUSE") {'),
      locked.indexOf("const now = await assess(budget);")
    );
    // It returns before anything: no assess, no restart, no budget charge.
    expect(refusal).toContain("return null;");
    for (const forbidden of ["restartOwnedRole", "recordRestartAttempt", "recordReplacement", "assess("]) {
      expect(`${forbidden}:${refusal.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("the startup check remains, but it is not the authority", () => {
    // Convenience only: it tells an operator immediately rather than after the
    // first tick. The under-lock read is what decides.
    const body = CLI.slice(
      CLI.indexOf("async function superviseAccountWorker"),
      CLI.indexOf("async function superviseGenericAnalysis")
    );
    expect(body).toContain("if (!transitionGateAllows([supervisedControl, workerRole])) return;");
    expect(body.indexOf("transitionGateAllows")).toBeLessThan(body.indexOf("judgeSupervisedRestart"));
  });
});
