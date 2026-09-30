import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ROLE_LOG_ROTATE_BYTES,
  roleLogDirectory,
  roleLogPath,
  rotatedRoleLogPath,
} from "../src/modules/operator/dual-account-topology";
import {
  WORKER_RESTART_MAX_ATTEMPTS,
  WORKER_STARTUP_GRACE_MS,
  decideWorkerSupervision,
  type LeafAccounting,
  type RestartBudget,
} from "../src/modules/operator/worker-supervision";
import {
  classifyLeavesByAncestry,
  parseProcessTreeRows,
  type ObservedProcessNode,
} from "../src/modules/operator/runtime-launcher";
import {
  WORKER_KEEPALIVE_INTERVAL_MS,
  describeFatal,
  installFatalHandlers,
  redactSecrets,
  startWorkerLiveness,
} from "../src/modules/runtime/worker-liveness";

/**
 * The execution-worker liveness incident, and the four things that made it
 * both possible and unrecoverable.
 *
 * Account A's runtime died. Its `tsx watch` wrapper stayed alive, so the
 * launcher's durable root record remained provably OWNED while the process
 * that actually held execution authority was gone. Attestation expired 15
 * seconds later, and from that moment the supervision ladder had no case that
 * matched: `owned && OFF` fell through to "ownership and health disagree", and
 * kept falling through for two hours while 25 executions froze and a position
 * closed on the exchange unobserved.
 *
 * Nothing here touches a process, a socket, a database or a file.
 */

const BACKEND_ROOT = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

const CLI = readFileSync(
  path.join(BACKEND_ROOT, "src/modules/operator/run-runtime-launcher.ts"),
  "utf8"
);

const NOW = 1_800_000_000_000;
const OLD_ENOUGH = NOW - WORKER_STARTUP_GRACE_MS - 1_000;

const EMPTY: RestartBudget = { attempts: 0, lastAttemptAtMs: null, lastHealthyAtMs: null };

/** The incident's exact shape, with one dial per case. */
const incident = (over: Partial<Parameters<typeof decideWorkerSupervision>[0]> = {}) =>
  decideWorkerSupervision({
    record: { role: "worker", pid: 25056, startedAtMs: OLD_ENOUGH },
    ownership: { owned: true },
    workerHealth: "OFF",
    backendHealth: "HEALTHY",
    budget: EMPTY,
    nowMs: NOW,
    hasRuntimeState: true,
    // Our tree is empty; the only runtime on the machine hangs under the
    // other account's owned root.
    leaves: { known: true, underSelected: 0, underOtherOwned: 1, unowned: 0 },
    ...over,
  });

describe("an owned root with no runtime under it", () => {
  it("is a restart-required condition, not a permanent degradation", () => {
    const decision = incident();

    expect(decision.action).toBe("TERMINATE_THEN_RESTART");
    expect(decision.reasonCode).toBe("OWNED_ROOT_WITHOUT_RUNTIME");
    // The whole owned tree is stopped first: the wrapper is ours and alive, and
    // a replacement must not be started beside it.
    expect(decision.terminatePid).toBe(25056);
    // This is the sentence the incident produced. It must no longer be the
    // answer to this state.
    expect(decision.reasonCode).not.toBe("INCONSISTENT_OBSERVATION");
  });

  it("refuses when a runtime is running outside every owned tree", () => {
    // It may be a hand-started worker for this very account. Neither killed
    // nor spawned beside.
    const decision = incident({
      leaves: { known: true, underSelected: 0, underOtherOwned: 1, unowned: 1 },
    });

    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("LEAF_UNEXPLAINED");
    expect(decision.terminatePid).toBeNull();
  });

  it("refuses when OUR OWN tree somehow holds two runtimes", () => {
    const decision = incident({
      leaves: { known: true, underSelected: 2, underOtherOwned: 1, unowned: 0 },
    });

    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("WORKER_DUPLICATE");
    expect(decision.terminatePid).toBeNull();
  });

  it("is unaffected by how many runtimes other owned trees hold", () => {
    // Another account's business. It neither blocks nor enables this repair.
    for (const underOtherOwned of [0, 1, 5]) {
      const decision = incident({
        leaves: { known: true, underSelected: 0, underOtherOwned, unowned: 0 },
      });
      expect(`${underOtherOwned}:${decision.action}`).toBe(`${underOtherOwned}:TERMINATE_THEN_RESTART`);
    }
  });

  it("refuses when the census could not be read at all", () => {
    const decision = incident({
      leaves: { known: false, reason: "the process scan returned unparseable output" },
    });

    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("LEAF_CENSUS_UNKNOWN");
    // UNKNOWN is not ABSENT: an unreadable machine never authorises a kill.
    expect(decision.message).toContain("unreadable machine");
  });

  it("acts when this account is the only one left and nothing is running", () => {
    const decision = incident({
      leaves: { known: true, underSelected: 0, underOtherOwned: 0, unowned: 0 },
    });
    expect(decision.action).toBe("TERMINATE_THEN_RESTART");
  });
});

// ===========================================================================
// The OTHER failure mode: alive, held alive on purpose, and not working
//
// `isReconciliationHealthy` goes false, the attestation publisher WITHDRAWS,
// the 15s TTL expires to ABSENT -- and the process is still there, now
// deliberately kept alive by its own keepalive. Counting leaves reported this
// account's own runtime as an unexplained stranger and refused forever. Only
// ancestry can tell "our wrapper is empty" from "our worker has stopped
// working".
// ===========================================================================

describe("a worker that is alive but has withdrawn its attestation", () => {
  const withdrawn = (over: Parameters<typeof incident>[0] = {}) =>
    incident({
      // Exactly one runtime, in OUR tree; the other account is healthy with
      // its own.
      leaves: { known: true, underSelected: 1, underOtherOwned: 1, unowned: 0 },
      ...over,
    });

  it("is restarted, not written off", () => {
    const decision = withdrawn();

    expect(decision.action).toBe("TERMINATE_THEN_RESTART");
    expect(decision.reasonCode).toBe("WORKER_RUNTIME_UNHEALTHY");
    // The whole owned tree goes, including the live-but-useless runtime.
    expect(decision.terminatePid).toBe(25056);
    // The reading that made this permanent.
    expect(decision.reasonCode).not.toBe("LEAF_UNEXPLAINED");
  });

  it("recovers even long after the attestation TTL has fully expired", () => {
    // ABSENT, not STALE: there is no record left at all, which is precisely
    // the state the old ladder could not act on.
    const hoursLater = withdrawn({
      nowMs: NOW + 6 * 60 * 60_000,
      record: { role: "worker", pid: 25056, startedAtMs: NOW - 8 * 60 * 60_000 },
      budget: EMPTY,
    });
    expect(hoursLater.action).toBe("TERMINATE_THEN_RESTART");
  });

  it("refuses while the process tree could not be observed", () => {
    const decision = withdrawn({
      leaves: { known: false, reason: "COMMAND_FAILED" },
    });
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("LEAF_CENSUS_UNKNOWN");
  });

  it("refuses when a stranger runtime exists outside every owned tree", () => {
    const decision = withdrawn({
      leaves: { known: true, underSelected: 1, underOtherOwned: 1, unowned: 1 },
    });
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("LEAF_UNEXPLAINED");
  });

  it("refuses while still inside the startup grace", () => {
    const decision = withdrawn({
      record: { role: "worker", pid: 25056, startedAtMs: NOW - 1_000 },
    });
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("STARTUP_GRACE");
  });

  it("refuses when the account's own control plane is not healthy", () => {
    expect(withdrawn({ backendHealth: "OFF" }).reasonCode).toBe("BACKEND_NOT_HEALTHY");
    expect(withdrawn({ backendHealth: "STALE" }).action).toBe("NONE");
  });

  it("names only THIS account's root, so the other account is untouched", () => {
    const decision = withdrawn();
    expect(decision.terminatePid).toBe(25056);
    // The other account's root pid never appears in the decision.
    expect(JSON.stringify(decision)).not.toContain("11136");
  });

  it("keepalive referenced + attestation absent still reaches a restart", () => {
    // The end-to-end claim: a process the keepalive is deliberately holding
    // alive, whose health predicate is false and whose heartbeat is gone, is
    // still recoverable. The keepalive is not consulted anywhere in the
    // decision -- it only explains why the process is still there to restart.
    const liveness = startWorkerLiveness(50);
    try {
      expect(liveness.referenced).toBe(true);
      const decision = withdrawn();
      expect(decision.action).toBe("TERMINATE_THEN_RESTART");
    } finally {
      liveness.stop();
    }
  });
});

describe("a freshly started root is not a dead one", () => {
  it("is left alone inside the startup grace", () => {
    // Plain `tsx` still spawns a child, so for a moment after a start there is
    // legitimately a wrapper with nothing under it and no heartbeat yet.
    // Reading that as failure would make supervision kill every worker it
    // starts, seconds after starting it.
    const decision = incident({
      record: { role: "worker", pid: 25056, startedAtMs: NOW - 1_000 },
    });

    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("STARTUP_GRACE");
  });

  it("is judged once the grace expires", () => {
    const justInside = incident({
      record: { role: "worker", pid: 25056, startedAtMs: NOW - WORKER_STARTUP_GRACE_MS + 500 },
    });
    const justOutside = incident({
      record: { role: "worker", pid: 25056, startedAtMs: NOW - WORKER_STARTUP_GRACE_MS - 500 },
    });

    expect(justInside.action).toBe("NONE");
    expect(justOutside.action).toBe("TERMINATE_THEN_RESTART");
  });

  it("the grace is measured from the RECORD, so a Start SAFE root gets it too", () => {
    // A root started by Start SAFE or by an account transition has no restart
    // attempt behind it, so the stabilization gate would never fire for it.
    expect(EMPTY.lastAttemptAtMs).toBeNull();
    const decision = incident({
      record: { role: "worker", pid: 25056, startedAtMs: NOW - 5_000 },
      budget: EMPTY,
    });
    expect(decision.reasonCode).toBe("STARTUP_GRACE");
  });

  it("every existing gate still runs BEFORE the new case", () => {
    // Stabilization, budget and backoff are unchanged and still win.
    expect(
      incident({ budget: { attempts: 1, lastAttemptAtMs: NOW - 1_000, lastHealthyAtMs: null } }).reasonCode
    ).toBe("STABILIZING");
    expect(
      incident({
        budget: {
          attempts: WORKER_RESTART_MAX_ATTEMPTS,
          lastAttemptAtMs: NOW - 10 * 60_000,
          lastHealthyAtMs: null,
        },
      }).reasonCode
    ).toBe("RESTART_BUDGET_EXHAUSTED");
    // And a backend that is not healthy is still not a worker-only fault.
    expect(incident({ backendHealth: "OFF" }).reasonCode).toBe("BACKEND_NOT_HEALTHY");
    // An unreadable heartbeat is still never a stall.
    expect(incident({ workerHealth: "UNKNOWN" }).reasonCode).toBe("HEALTH_UNKNOWN");
  });

  it("a STALE worker still takes the OLD path, not the new one", () => {
    // STALE means the runtime IS there and has gone quiet. Its own leaf is
    // running and unattributed, so routing it through the leaf-accounting case
    // would refuse it as an unexplained leaf and make a stalled worker
    // permanently unrecoverable. The `OFF` guard is what keeps them apart.
    const decision = incident({
      workerHealth: "STALE",
      leaves: { known: true, underSelected: 1, underOtherOwned: 1, unowned: 0 },
    });

    expect(decision.action).toBe("TERMINATE_THEN_RESTART");
    expect(decision.reasonCode).toBe("WORKER_STALE");
    expect(decision.reasonCode).not.toBe("LEAF_UNEXPLAINED");
    expect(decision.terminatePid).toBe(25056);
  });
});

describe("a durable record whose root is conclusively GONE", () => {
  it("takes the start-only path instead of being dropped", () => {
    // `ownedRolesAlive` omits a GONE record, and the launcher used to pass
    // `record: null` -- which reads as "nothing is owned" and refuses. The
    // durable record is now carried through with its real verdict.
    const decision = decideWorkerSupervision({
      record: { role: "worker", pid: 25056, startedAtMs: OLD_ENOUGH },
      ownership: { owned: false, reason: "GONE" },
      workerHealth: "OFF",
      backendHealth: "HEALTHY",
      budget: EMPTY,
      nowMs: NOW,
      hasRuntimeState: true,
      leaves: { known: true, underSelected: 0, underOtherOwned: 1, unowned: 0 },
    });

    expect(decision.action).toBe("RESTART");
    expect(decision.reasonCode).toBe("WORKER_EXITED");
    // Start-only: there is nothing left to terminate.
    expect(decision.terminatePid).toBeNull();
  });

  it("UNKNOWN ownership is never treated as GONE", () => {
    for (const reason of ["PID_REUSED", "NOT_THIS_REPO"] as const) {
      const decision = decideWorkerSupervision({
        record: { role: "worker", pid: 25056, startedAtMs: OLD_ENOUGH },
        ownership: { owned: false, reason },
        workerHealth: "OFF",
        backendHealth: "HEALTHY",
        budget: EMPTY,
        nowMs: NOW,
        hasRuntimeState: true,
        leaves: { known: true, underSelected: 0, underOtherOwned: 0, unowned: 0 },
      });
      expect(`${reason}:${decision.action}`).toBe(`${reason}:NONE`);
      expect(decision.reasonCode).toBe("OWNERSHIP_UNPROVEN");
    }
  });

  it("the launcher re-probes rather than inferring GONE from an absent alive record", () => {
    const supervise = CLI.slice(
      CLI.indexOf("async function superviseAccountWorker"),
      CLI.indexOf("async function superviseGenericAnalysis")
    );
    expect(supervise).toContain("const durable = state?.processes.find((entry) => entry.role === workerRole) ?? null;");
    expect(supervise).toContain("verifyOwnership(durable, probed.value.get(durable.pid) ?? null, state.repoRoot)");
    // An unobservable machine returns WITHOUT a verdict rather than guessing.
    expect(supervise).toContain("if (!probed.ok) {");
    expect(supervise).toContain("ownership: ownershipVerdict,");
    // The old shape, which discarded the evidence, is gone.
    expect(supervise).not.toContain("ownership: record === null ? null : { owned: true }");
  });
});

describe("the launcher attributes leaves only to proven-healthy siblings", () => {
  const supervise = CLI.slice(
    CLI.indexOf("async function superviseAccountWorker"),
    CLI.indexOf("async function superviseGenericAnalysis")
  );

  it("traces each runtime to the tree it hangs in", () => {
    expect(supervise).toContain("classifyLeavesByAncestry({");
    expect(supervise).toContain("selectedRootPid: durable.pid,");
    expect(supervise).toContain("otherOwnedRootPids: alive");
  });

  it("never decides ownership by arithmetic", () => {
    // Both readings that failed: one leaf per alive root, and
    // observed-minus-attributed.
    expect(supervise).not.toContain("attributedToOthers");
    expect(supervise).not.toContain("alive.length");
  });

  it("an unreadable tree is UNKNOWN, never an empty one", () => {
    expect(supervise).toContain("!tree.ok");
    expect(supervise).toContain("{ known: false, reason: tree.reason }");
  });

  it("excludes cmd wrappers, whose command line also carries the entrypoint", () => {
    // `cmd /c tsx <entrypoint>` matches every text rule the runtime matches.
    expect(supervise).toContain('node.executable.toLowerCase() === "node.exe" &&');
    expect(supervise).toContain("classifyEntrypoint(node.commandLine) === entrypoint");
  });

  it("reads BOTH accounts' attestation, because a leaf carries no account", () => {
    expect(supervise).toContain("const attestation = await readAllAttestation();");
  });
});

describe("worker output has somewhere durable to go", () => {
  it("each role has its own file, outside the repository", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" } as NodeJS.ProcessEnv;
    const a = roleLogPath("account-a-worker", env);
    const b = roleLogPath("account-b-worker", env);

    expect(a).not.toBe(b);
    expect(a.endsWith("account-a-worker.log")).toBe(true);
    expect(b.endsWith("account-b-worker.log")).toBe(true);
    expect(roleLogDirectory(env).endsWith(path.join("trading-alert-dashboard", "logs"))).toBe(true);
    // Never inside a checkout: a git clean must not delete production logs.
    expect(a).not.toContain("Projects");
  });

  it("rotation touches only that role's own two names", () => {
    const env = { LOCALAPPDATA: "C:\\L" } as NodeJS.ProcessEnv;
    expect(rotatedRoleLogPath("account-a-worker", env)).toBe(`${roleLogPath("account-a-worker", env)}.1`);
    // A rotation can therefore never rename or delete another role's log.
    expect(rotatedRoleLogPath("account-a-worker", env)).not.toContain("account-b");
    expect(ROLE_LOG_ROTATE_BYTES).toBeGreaterThan(0);
  });

  it("no credential, token or env value can reach a log path", () => {
    const env = {
      LOCALAPPDATA: "C:\\L",
      OPERATOR_API_TOKEN: "super-secret",
      BINANCE_API_KEY: "key",
      DATABASE_URL: "postgresql://u:p@h/db",
    } as NodeJS.ProcessEnv;
    for (const role of ["account-a-worker", "account-b-worker", "generic-analysis"] as const) {
      const p = roleLogPath(role, env);
      expect(p).not.toContain("super-secret");
      expect(p).not.toContain("postgresql");
      expect(p).not.toMatch(/TOKEN|SECRET|KEY|password/i);
    }
  });

  it("a log that cannot be opened REFUSES the start rather than falling back", () => {
    const helper = CLI.slice(CLI.indexOf("function openRoleLogSink"), CLI.indexOf("function restartOwnedRole"));
    expect(helper).toContain("if (sink === null) {");
    expect(helper).toContain("NOT started");
    // The exact regression this guards: silently reverting to a null sink is
    // what made the incident unexplainable.
    expect(helper).not.toContain('stdio: "ignore"');
  });

  it("the parent always releases its own descriptor", () => {
    const helper = CLI.slice(CLI.indexOf("function spawnRoleWithDurableLog"), CLI.indexOf("function restartOwnedRole"));
    // In a `finally`, so a spawn that returned no pid and a spawn that threw
    // both release it too.
    expect(helper).toContain("} finally {");
    expect(helper).toContain("sink.close();");
    expect(helper.indexOf("} finally {")).toBeLessThan(helper.indexOf("sink.close();"));
    // And `close` really releases the descriptor rather than dropping it.
    const opener = CLI.slice(CLI.indexOf("function openRoleLogSink"), CLI.indexOf("function spawnRoleWithDurableLog"));
    expect(opener).toContain("closeSync(fd)");
  });

  it("every spawn in the tool goes through the one helper", () => {
    expect((CLI.match(/(?<!\w)spawn\(/g) ?? []).length).toBe(1);
    expect((CLI.match(/spawnRoleWithDurableLog\(/g) ?? []).length).toBe(4); // definition + 3 callers
    expect(CLI).toContain('stdio: ["ignore", sink.fd, sink.fd],');
  });
});

describe("a fatal error is recorded before the process leaves", () => {
  it("names the kind, the error and the stack", () => {
    const line = describeFatal("uncaughtException", new TypeError("boom"), "2026-09-30T00:00:00.000Z");

    expect(line).toContain("FATAL uncaughtException: TypeError");
    expect(line).toContain("message: boom");
    expect(line).toContain("stack:");
    expect(line.endsWith("\n")).toBe(true);
  });

  it("normalises a rejection reason that is not an Error", () => {
    for (const [reason, expected] of [
      ["just a string", "string"],
      [{ code: 42 }, "object"],
      [null, "null"],
      [undefined, "undefined"],
    ] as const) {
      const line = describeFatal("unhandledRejection", reason, "T");
      expect(`${String(expected)}:${line.includes(`FATAL unhandledRejection: ${expected}`)}`).toBe(
        `${String(expected)}:true`
      );
      // Never "[object Object]", which records nothing.
      expect(line).not.toContain("[object Object]");
    }
  });

  it("redacts credential-shaped values", () => {
    const dirty =
      "connect postgresql://admin:hunter2@db:5432/x failed; " +
      "GET /api?signature=abcdef123&symbol=BTC; BINANCE_API_SECRET=topsecret";
    const clean = redactSecrets(dirty);

    expect(clean).not.toContain("hunter2");
    expect(clean).not.toContain("abcdef123");
    expect(clean).not.toContain("topsecret");
    // The useful parts survive.
    expect(clean).toContain("postgresql://");
    expect(clean).toContain("symbol=BTC");
  });

  it("redacts through the fatal record itself, not only in the helper", () => {
    const line = describeFatal(
      "uncaughtException",
      new Error("connect postgresql://admin:hunter2@db:5432/x refused"),
      "T"
    );
    expect(line).not.toContain("hunter2");
    expect(line).toContain("postgresql://***:***@");
  });

  it("writes once and exits non-zero, however many fatals arrive", () => {
    const written: string[] = [];
    const exits: number[] = [];
    const handlers: Record<string, (error: unknown) => void> = {};
    const original = process.on.bind(process);
    // Capture rather than install, so the test runner's own process is
    // untouched.
    (process as unknown as { on: typeof process.on }).on = ((event: string, fn: (e: unknown) => void) => {
      if (event === "uncaughtException" || event === "unhandledRejection") handlers[event] = fn;
      else original(event as never, fn as never);
      return process;
    }) as typeof process.on;

    try {
      installFatalHandlers({
        write: (text) => written.push(text),
        exit: (code) => exits.push(code),
        now: () => new Date("2026-09-30T00:00:00.000Z"),
      });
      handlers.uncaughtException?.(new Error("first"));
      handlers.unhandledRejection?.(new Error("second"));
      handlers.uncaughtException?.(new Error("third"));
    } finally {
      (process as unknown as { on: typeof process.on }).on = original;
    }

    // Once only: a cascade must not bury the cause.
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("first");
    expect(written[0]).not.toContain("second");
    expect(exits).toEqual([1]);
  });

  it("still exits when even the diagnostic write fails", () => {
    const exits: number[] = [];
    const handlers: Record<string, (error: unknown) => void> = {};
    const original = process.on.bind(process);
    (process as unknown as { on: typeof process.on }).on = ((event: string, fn: (e: unknown) => void) => {
      if (event === "uncaughtException" || event === "unhandledRejection") handlers[event] = fn;
      else original(event as never, fn as never);
      return process;
    }) as typeof process.on;

    try {
      installFatalHandlers({
        write: () => {
          throw new Error("the sink is gone");
        },
        exit: (code) => exits.push(code),
      });
      handlers.uncaughtException?.(new Error("boom"));
    } finally {
      (process as unknown as { on: typeof process.on }).on = original;
    }

    expect(exits).toEqual([1]);
  });
});

describe("the worker stays alive on purpose, not by accident", () => {
  const liveKeepers: { stop(): void }[] = [];
  afterEach(() => {
    for (const k of liveKeepers.splice(0)) k.stop();
  });

  it("holds a referenced handle while running, and releases it on shutdown", () => {
    const liveness = startWorkerLiveness(50);
    liveKeepers.push(liveness);

    expect(liveness.running).toBe(true);
    // REFERENCED, not merely running: an unref()'d timer would keep nothing
    // alive while looking identical from outside.
    expect(liveness.referenced).toBe(true);
    liveness.stop();
    expect(liveness.running).toBe(false);
    // Idempotent: a second shutdown must not throw.
    liveness.stop();
    expect(liveness.running).toBe(false);
  });

  it("never unrefs its handle, and reports the handle's real ref state", () => {
    // Node offers no public way to ask "is this handle keeping the loop alive"
    // other than `hasRef()`, so the mechanism itself is pinned here: an
    // `unref()`'d timer would satisfy every behavioural assertion above while
    // keeping nothing alive at all, which is the exact bug this module exists
    // to remove.
    const source = readFileSync(
      path.join(BACKEND_ROOT, "src/modules/runtime/worker-liveness.ts"),
      "utf8"
    );
    // The prose explains why unref would be wrong; no CALL to it may exist.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    expect(code).not.toMatch(/\.unref\s*\?*\.?\s*\(/);
    expect(code).toContain("timer.hasRef?.()");
  });

  it("exposes NO health signal of any kind", () => {
    const liveness = startWorkerLiveness(50);
    liveKeepers.push(liveness);
    // Keeping a process alive and saying it is well are different claims.
    expect(Object.keys(liveness).sort()).toEqual(["referenced", "running", "stop"]);
    expect(WORKER_KEEPALIVE_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("attestation health is still coupled to reconciliation, not to the keepalive", () => {
    const worker = readFileSync(
      path.join(BACKEND_ROOT, "src/modules/jobs/execution.worker.ts"),
      "utf8"
    );
    // The publisher's health predicate is unchanged: a stalled scheduler still
    // withdraws attestation, so supervision can still recover a worker that
    // this keepalive is holding alive.
    expect(worker).toContain("healthy: isReconciliationHealthy,");
    const attestationBlock = worker.slice(
      worker.indexOf("const runtimeAttestation = createRuntimeAttestationPublisher("),
      worker.indexOf("runtimeAttestation.start()")
    );
    expect(attestationBlock).not.toContain("liveness");
    expect(attestationBlock).not.toContain("keepalive");
  });

  it("is created only after the lifecycle is up, and released first on shutdown", () => {
    const worker = readFileSync(
      path.join(BACKEND_ROOT, "src/modules/jobs/execution.worker.ts"),
      "utf8"
    );
    // After attestation starts: a startup that failed earlier must exit, not
    // idle forever holding a keepalive.
    expect(worker.indexOf("runtimeAttestation.start()")).toBeLessThan(
      worker.indexOf("const liveness = startWorkerLiveness()")
    );
    const sigterm = worker.slice(worker.indexOf('process.on("SIGTERM"'));
    expect(sigterm.indexOf("liveness.stop();")).toBeLessThan(sigterm.indexOf("runtimeAttestation.stop()"));
  });

  it("a startup failure exits non-zero instead of lingering", () => {
    const worker = readFileSync(
      path.join(BACKEND_ROOT, "src/modules/jobs/execution.worker.ts"),
      "utf8"
    );
    // Both failure paths: an unbindable account, and a bootstrap that threw.
    expect((worker.match(/process\.exitCode = 1;/g) ?? []).length).toBe(2);
    const bindFailure = worker.slice(
      worker.indexOf("Account-bound runtime could not be established"),
      worker.indexOf("const runtime = bound.runtime;")
    );
    expect(bindFailure).toContain("process.exitCode = 1;");
  });

  it("the fatal handlers are installed before anything can reject", () => {
    const worker = readFileSync(
      path.join(BACKEND_ROOT, "src/modules/jobs/execution.worker.ts"),
      "utf8"
    );
    expect(worker.indexOf("installFatalHandlers();")).toBeLessThan(
      worker.indexOf("async function startExecutionRuntime")
    );
  });
});


// ===========================================================================
// Ancestry: the only thing that can tell two identical runtimes apart
// ===========================================================================

describe("reading the process tree", () => {
  const row = (pid: number, parent: number, exe: string, cmd: string) =>
    `${pid}|${parent}|${exe}|1800000000000|${cmd}`;

  it("parses a well-formed listing", () => {
    const parsed = parseProcessTreeRows(
      [row(2, 1, "cmd.exe", "cmd /c pnpm run x"), row(3, 2, "node.exe", "node worker.ts")].join("\r\n")
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.ok === true && parsed.value).toHaveLength(2);
    expect(parsed.ok === true && parsed.value[1].parentPid).toBe(2);
    expect(parsed.ok === true && parsed.value[0].executable).toBe("cmd.exe");
  });

  it("blank lines separate rows, so an empty machine is an empty list", () => {
    const parsed = parseProcessTreeRows("\r\n\r\n");
    expect(parsed.ok === true && parsed.value).toEqual([]);
  });

  it.each([
    ["too few fields", "1|2|node.exe|1800000000000"],
    ["too many fields", "1|2|node.exe|1800000000000|cmd|extra"],
    ["a non-numeric pid", "x|2|node.exe|1800000000000|cmd"],
    ["a non-numeric parent", "1|y|node.exe|1800000000000|cmd"],
    ["a non-numeric creation time", "1|2|node.exe|then|cmd"],
    ["a blank executable", "1|2| |1800000000000|cmd"],
  ])("%s discards the WHOLE observation", (_label, line) => {
    // All-or-nothing: a half-parsed tree leaves a leaf looking parentless, and
    // a parentless leaf reads as somebody else's.
    const parsed = parseProcessTreeRows([row(9, 1, "node.exe", "ok"), line].join("\r\n"));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toBe("UNPARSEABLE");
  });
});

describe("classifying runtimes by the tree they hang in", () => {
  const ENTRY = "src/modules/jobs/execution.worker.ts";
  const node = (pid: number, parentPid: number, executable: string, commandLine: string): ObservedProcessNode => ({
    pid,
    parentPid,
    executable,
    startedAtMs: 1_800_000_000_000,
    commandLine,
  });

  /** The real five-process shape, twice: one tree per account. */
  const machine = (): ObservedProcessNode[] => [
    // Account A: root 100 -> pnpm -> cmd tsx -> tsx cli -> runtime
    node(100, 1, "cmd.exe", `cmd /d /s /c pnpm -C C:/repo --filter backend execution-worker`),
    node(101, 100, "node.exe", "node C:/store/pnpm/bin/../node"),
    node(102, 101, "cmd.exe", `cmd /d /s /c tsx ${ENTRY}`),
    node(103, 102, "node.exe", `node C:/repo/node_modules/tsx/dist/cli.mjs ${ENTRY}`),
    node(104, 103, "node.exe", `node --require C:/repo/node_modules/tsx/dist/preflight.cjs ${ENTRY}`),
    // Account B: the same, under root 200
    node(200, 1, "cmd.exe", `cmd /d /s /c pnpm -C C:/repo --filter backend execution-worker`),
    node(201, 200, "node.exe", "node C:/store/pnpm/bin/../node"),
    node(202, 201, "cmd.exe", `cmd /d /s /c tsx ${ENTRY}`),
    node(203, 202, "node.exe", `node C:/repo/node_modules/tsx/dist/cli.mjs ${ENTRY}`),
    node(204, 203, "node.exe", `node --require C:/repo/node_modules/tsx/dist/preflight.cjs ${ENTRY}`),
  ];

  // The launcher's rule, reproduced: node.exe only, and the census's own
  // entrypoint classification.
  const isLeaf = (p: ObservedProcessNode) =>
    p.executable.toLowerCase() === "node.exe" &&
    !/pnpm\.cjs|pnpm\/bin/.test(p.commandLine.replace(/\\/g, "/")) &&
    !/tsx\/dist\/cli\.mjs/.test(p.commandLine.replace(/\\/g, "/")) &&
    p.commandLine.replace(/\\/g, "/").includes(ENTRY);

  const classify = (processes: ObservedProcessNode[], selected = 100, others = [200]) =>
    classifyLeavesByAncestry({ processes, isLeaf, selectedRootPid: selected, otherOwnedRootPids: others });

  it("finds exactly one runtime in each tree, through two cmd wrappers", () => {
    expect(classify(machine())).toEqual({ underSelected: 1, underOtherOwned: 1, unowned: 0 });
  });

  it("the cmd and tsx-cli wrappers are never mistaken for runtimes", () => {
    // Both carry the entrypoint on their command line; only the executable and
    // the cli.mjs exclusion separate them from the real thing.
    const counted = machine().filter(isLeaf).map((p) => p.pid);
    expect(counted).toEqual([104, 204]);
  });

  it("sees an empty tree when our runtime has died", () => {
    // The original incident: root alive, wrappers alive, leaf gone.
    const withoutOurLeaf = machine().filter((p) => p.pid !== 104);
    expect(classify(withoutOurLeaf)).toEqual({ underSelected: 0, underOtherOwned: 1, unowned: 0 });
  });

  it("a runtime under no owned root is UNOWNED", () => {
    const stranger = [...machine(), node(900, 1, "node.exe", `node --require x/preflight.cjs ${ENTRY}`)];
    expect(classify(stranger)).toEqual({ underSelected: 1, underOtherOwned: 1, unowned: 1 });
  });

  it("a chain that leaves the observed set is UNOWNED, never assumed ours", () => {
    // The intermediate cmd wrapper is missing, so 104 cannot be traced. The
    // conservative reading is the only safe one.
    const broken = machine().filter((p) => p.pid !== 102);
    expect(classify(broken)).toEqual({ underSelected: 0, underOtherOwned: 1, unowned: 1 });
  });

  it("two runtimes in OUR tree are both counted", () => {
    const doubled = [...machine(), node(105, 103, "node.exe", `node --require p/preflight.cjs ${ENTRY}`)];
    expect(classify(doubled).underSelected).toBe(2);
  });

  it("a parent cycle terminates instead of spinning", () => {
    const cyclic = [
      node(300, 301, "node.exe", `node --require p/preflight.cjs ${ENTRY}`),
      node(301, 300, "cmd.exe", "cmd /c loop"),
    ];
    expect(classify(cyclic, 100, [200])).toEqual({ underSelected: 0, underOtherOwned: 0, unowned: 1 });
  });

  it("with no other owned roots, the sibling's runtime becomes UNOWNED", () => {
    // Correct and deliberately conservative: if B is not launcher-owned, its
    // runtime is a stranger and every repair refuses.
    expect(classify(machine(), 100, [])).toEqual({ underSelected: 1, underOtherOwned: 0, unowned: 1 });
  });

  it("never attributes a runtime to the selected root by counting", () => {
    // Same machine, but OUR root is a pid that owns nothing.
    expect(classify(machine(), 999, [200])).toEqual({ underSelected: 0, underOtherOwned: 1, unowned: 1 });
  });
});


// ===========================================================================
// Only a role that RUNS this entrypoint may absorb one of its runtimes
//
// `alive` holds every launcher-owned role: two control planes, two generic
// roles and two account workers. None of the first four is ever supposed to
// have an execution runtime beneath it, so handing all six to the ancestry
// walk as possible owners turns a rogue worker hanging off a control plane
// into somebody's legitimate leaf -- and the repair proceeds over the top of
// it instead of refusing.
// ===========================================================================

describe("which owned roots may absorb an execution runtime", () => {
  const ENTRY = "src/modules/jobs/execution.worker.ts";
  const CONTROL_ENTRY = "src/account-control.server.ts";
  const BACKEND_ENTRY = "src/server.ts";
  const ANALYSIS_ENTRY = "src/modules/jobs/vision-analysis.worker.ts";

  /** Every launcher-owned role, with the root pid each one would record. */
  const OWNED_ROOTS = [
    { role: "generic-backend", pid: 300, entrypoint: BACKEND_ENTRY },
    { role: "generic-analysis", pid: 400, entrypoint: ANALYSIS_ENTRY },
    { role: "account-a-control", pid: 500, entrypoint: CONTROL_ENTRY },
    { role: "account-a-worker", pid: 100, entrypoint: ENTRY },
    { role: "account-b-control", pid: 600, entrypoint: CONTROL_ENTRY },
    { role: "account-b-worker", pid: 200, entrypoint: ENTRY },
  ] as const;

  const node = (pid: number, parentPid: number, executable: string, commandLine: string): ObservedProcessNode => ({
    pid,
    parentPid,
    executable,
    startedAtMs: 1_800_000_000_000,
    commandLine,
  });

  /** An execution runtime hanging under `rootPid`, through the real wrappers. */
  const runtimeUnder = (rootPid: number, base: number): ObservedProcessNode[] => [
    node(rootPid, 1, "cmd.exe", "cmd /d /s /c pnpm -C C:/repo --filter backend some-script"),
    node(base + 1, rootPid, "node.exe", "node C:/store/pnpm/bin/../node"),
    node(base + 2, base + 1, "cmd.exe", `cmd /d /s /c tsx ${ENTRY}`),
    node(base + 3, base + 2, "node.exe", `node C:/repo/node_modules/tsx/dist/cli.mjs ${ENTRY}`),
    node(base + 4, base + 3, "node.exe", `node --require C:/repo/node_modules/tsx/dist/preflight.cjs ${ENTRY}`),
  ];

  const isLeaf = (p: ObservedProcessNode) =>
    p.executable.toLowerCase() === "node.exe" &&
    !/pnpm\.cjs|pnpm\/bin/.test(p.commandLine.replace(/\\/g, "/")) &&
    !/tsx\/dist\/cli\.mjs/.test(p.commandLine.replace(/\\/g, "/")) &&
    p.commandLine.replace(/\\/g, "/").includes(ENTRY);

  /**
   * The launcher's wiring, reproduced exactly: only alive owned roles whose
   * CONTRACT runs this entrypoint may absorb one of its runtimes.
   */
  const otherOwnedRootPids = (
    selectedRole: string,
    aliveRoles: readonly string[] = OWNED_ROOTS.map((r) => r.role)
  ) =>
    OWNED_ROOTS.filter(
      (r) => r.role !== selectedRole && r.entrypoint === ENTRY && aliveRoles.includes(r.role)
    ).map((r) => r.pid);

  const classify = (processes: ObservedProcessNode[], aliveRoles?: readonly string[]) =>
    classifyLeavesByAncestry({
      processes,
      isLeaf,
      selectedRootPid: 100, // account-a-worker
      otherOwnedRootPids: otherOwnedRootPids("account-a-worker", aliveRoles),
    });

  it("1. the OTHER account worker absorbs its own runtime", () => {
    const machine = [...runtimeUnder(100, 1000), ...runtimeUnder(200, 2000)];
    expect(classify(machine)).toEqual({ underSelected: 1, underOtherOwned: 1, unowned: 0 });
  });

  it.each([
    ["2. Account A Control", 500],
    ["3. Account B Control", 600],
    ["4. Generic Backend", 300],
    ["5. Generic Analysis", 400],
  ])("%s cannot absorb an execution runtime", (_label, rogueRoot) => {
    // Owned, alive, and wholly irrelevant: its contract runs a different
    // entrypoint, so a runtime beneath it is nobody's business but an
    // operator's.
    const machine = [...runtimeUnder(100, 1000), ...runtimeUnder(rogueRoot, 3000)];
    const counts = classify(machine);

    expect(counts.underOtherOwned).toBe(0);
    expect(counts.unowned).toBe(1);
    expect(counts.underSelected).toBe(1);
  });

  it("6. an empty selected tree plus a rogue leaf REFUSES, and stops nothing", () => {
    // The original incident shape, with a stranger present.
    const counts = classify([
      ...runtimeUnder(100, 1000).filter((p) => p.pid !== 1004), // our runtime died
      ...runtimeUnder(500, 3000), // rogue under Account A Control
    ]);
    expect(counts).toEqual({ underSelected: 0, underOtherOwned: 0, unowned: 1 });

    const decision = incident({ leaves: { known: true, ...counts } });
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("LEAF_UNEXPLAINED");
    expect(decision.terminatePid).toBeNull();
  });

  it("7. a live-but-unhealthy selected worker plus a rogue leaf REFUSES", () => {
    const counts = classify([...runtimeUnder(100, 1000), ...runtimeUnder(400, 3000)]);
    expect(counts).toEqual({ underSelected: 1, underOtherOwned: 0, unowned: 1 });

    const decision = incident({ leaves: { known: true, ...counts } });
    expect(decision.action).toBe("NONE");
    expect(decision.reasonCode).toBe("LEAF_UNEXPLAINED");
    // The selected tree is NOT terminated while a runtime nobody owns exists.
    expect(decision.terminatePid).toBeNull();
  });

  it("8. a B worker whose ownership is not proven absorbs nothing", () => {
    // Not in `alive`, so not an owner. Its runtime becomes a stranger and the
    // repair refuses -- rather than being waved through on a role name.
    const machine = [...runtimeUnder(100, 1000), ...runtimeUnder(200, 2000)];
    const counts = classify(machine, ["generic-backend", "account-a-control", "account-a-worker"]);

    expect(counts).toEqual({ underSelected: 1, underOtherOwned: 0, unowned: 1 });
    expect(incident({ leaves: { known: true, ...counts } }).action).toBe("NONE");
  });

  it("the launcher narrows by ENTRYPOINT, not by liveness alone", () => {
    const supervise = CLI.slice(
      CLI.indexOf("async function superviseAccountWorker"),
      CLI.indexOf("async function superviseGenericAnalysis")
    );
    expect(supervise).toContain("entry.role !== workerRole &&");
    expect(supervise).toContain("ROLE_CONTRACTS[entry.role].entrypoint === entrypoint");
    // The broad version, which let a control plane absorb a worker runtime.
    expect(supervise).not.toContain(".filter((entry) => entry.role !== workerRole)");
  });
});
