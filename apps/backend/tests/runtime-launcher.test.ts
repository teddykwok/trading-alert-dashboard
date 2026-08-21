import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  INVALID_MODE_WARNING,
  LIVE_READY_CONFIRMATION,
  LIVE_READY_GATES,
  MemoryStateStore,
  RUNTIME_GATE_KEYS,
  SAFE_GATES,
  applyGates,
  classifyDiskMode,
  defaultStatePath,
  evaluateDurableSafety,
  evaluateStartPreconditions,
  gatesFor,
  isLiveReadyConfirmed,
  operatorTokenState,
  presentStatus,
  readGates,
  renderStatus,
  verifyOwnership,
  type OwnedProcess,
  type ProcessProbe,
} from "../src/modules/operator/runtime-launcher";

/**
 * The local runtime launcher's pure core.
 *
 * This tool edits a file that holds live credentials and terminates processes
 * on the operator's own machine, so the properties asserted here are the ones
 * that make it safe to run: it changes only three lines, it refuses anything
 * ambiguous, it never emits a secret, and it will not kill a process it cannot
 * positively prove belongs to this repository.
 *
 * Every test works on a TEMPORARY fixture. The real `.env` is never read or
 * written here, no process is started or stopped, and nothing reaches Binance.
 */

const SECRET_LINES = [
  "BINANCE_API_KEY=abcdef0123456789abcdef0123456789",
  "BINANCE_API_SECRET=ZZZZsecretsecretsecretsecretZZZZ",
  "WEBHOOK_SECRET=hunter2-webhook",
  "OPERATOR_API_TOKEN=operator-token-0123456789abcdefgh",
  "DATABASE_URL=postgresql://user:password@localhost:15432/db?schema=public",
  "REDIS_URL=redis://:redispassword@localhost:6379",
];

function envFixture(
  gates: Record<string, string> = SAFE_GATES,
  options: { crlf?: boolean; extraLines?: string[] } = {}
): string {
  const lines = [
    "# Generated fixture — never the real file",
    "",
    ...SECRET_LINES,
    "",
    "# --- execution gates -------------------------------------------------",
    ...RUNTIME_GATE_KEYS.map((key) => `${key}=${gates[key]}`),
    "",
    "EXECUTION_EMERGENCY_CLOSE_MODE=DISABLED",
    "EXECUTION_MAX_TOTAL_PLANNED_RISK_USD=7.50",
    ...(options.extraLines ?? []),
    "",
  ];
  return lines.join(options.crlf ? "\r\n" : "\n");
}

const temporaryDirs: string[] = [];
function temporaryEnvFile(text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "launcher-fixture-"));
  temporaryDirs.push(dir);
  const file = path.join(dir, ".env");
  writeFileSync(file, text, "utf8");
  return file;
}

afterEach(() => {
  while (temporaryDirs.length > 0) rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mode classification
// ---------------------------------------------------------------------------

describe("runtime launcher: disk mode", () => {
  it("classifies the SAFE combination", () => {
    expect(classifyDiskMode(SAFE_GATES)).toBe("SAFE");
  });

  it("classifies the LIVE-READY combination", () => {
    expect(classifyDiskMode(LIVE_READY_GATES)).toBe("LIVE_READY");
  });

  it.each([
    ["kill switch released alone", { ...SAFE_GATES, EXECUTION_GLOBAL_KILL_SWITCH: "false" }],
    ["live entry alone", { ...SAFE_GATES, EXECUTION_LIVE_ENTRY_ENABLED: "true" }],
    ["protection alone", { ...SAFE_GATES, EXECUTION_PROTECTION_READY: "true" }],
    ["live minus protection", { ...LIVE_READY_GATES, EXECUTION_PROTECTION_READY: "false" }],
    ["empty", {}],
  ])("calls %s INVALID", (_label, values) => {
    // Half-open is never silently normalized: it means the file was edited by
    // hand or a write failed partway, and hiding that would be worse than
    // showing it.
    expect(classifyDiskMode(values)).toBe("INVALID");
  });

  it("returns the exact gate set for each mode", () => {
    expect(gatesFor("SAFE")).toEqual({
      EXECUTION_GLOBAL_KILL_SWITCH: "true",
      EXECUTION_LIVE_ENTRY_ENABLED: "false",
      EXECUTION_PROTECTION_READY: "false",
    });
    expect(gatesFor("LIVE_READY")).toEqual({
      EXECUTION_GLOBAL_KILL_SWITCH: "false",
      EXECUTION_LIVE_ENTRY_ENABLED: "true",
      EXECUTION_PROTECTION_READY: "true",
    });
  });
});

// ---------------------------------------------------------------------------
// Reading gates
// ---------------------------------------------------------------------------

describe("runtime launcher: reading gates", () => {
  it("reads the three gates and nothing else", () => {
    const result = readGates(envFixture());
    expect(result).toEqual({ ok: true, values: SAFE_GATES });
  });

  it("refuses a missing gate key", () => {
    // Writing it in would mean inventing configuration for a real-money
    // deployment.
    const text = envFixture().replace("EXECUTION_PROTECTION_READY=false\n", "");
    const result = readGates(text);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("missing gate key");
  });

  it("refuses a duplicated gate key", () => {
    // dotenv would take one of them and this tool would rewrite the other,
    // leaving the file saying one thing and the runtime believing another.
    const result = readGates(`${envFixture()}\nEXECUTION_LIVE_ENTRY_ENABLED=true\n`);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("duplicate gate key");
  });

  it("refuses a non-boolean gate value", () => {
    const result = readGates(envFixture({ ...SAFE_GATES, EXECUTION_PROTECTION_READY: "maybe" }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("non-boolean");
  });

  it("ignores commented-out gate lines", () => {
    const result = readGates(`# EXECUTION_LIVE_ENTRY_ENABLED=true\n${envFixture()}`);
    expect(result).toEqual({ ok: true, values: SAFE_GATES });
  });

  it("never returns a secret", () => {
    const result = readGates(envFixture());
    const serialized = JSON.stringify(result);
    for (const secret of ["abcdef0123456789", "ZZZZsecret", "hunter2", "operator-token", "postgresql://", "redis://"]) {
      expect(`${secret}:${serialized.includes(secret)}`).toBe(`${secret}:false`);
    }
  });
});

// ---------------------------------------------------------------------------
// Rewriting gates
// ---------------------------------------------------------------------------

describe("runtime launcher: rewriting gates", () => {
  it("changes ONLY the three gate lines", () => {
    const before = envFixture();
    const result = applyGates(before, LIVE_READY_GATES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const beforeLines = before.split("\n");
    const afterLines = result.text.split("\n");
    expect(afterLines.length).toBe(beforeLines.length);

    const changed = beforeLines
      .map((line, index) => (line === afterLines[index] ? null : index))
      .filter((index): index is number => index !== null);
    expect(changed.length).toBe(3);
    for (const index of changed) {
      expect(RUNTIME_GATE_KEYS.some((key) => afterLines[index].startsWith(`${key}=`))).toBe(true);
    }
  });

  it("preserves every secret and unrelated line byte for byte", () => {
    const result = applyGates(envFixture(), LIVE_READY_GATES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const line of [...SECRET_LINES, "EXECUTION_EMERGENCY_CLOSE_MODE=DISABLED", "EXECUTION_MAX_TOTAL_PLANNED_RISK_USD=7.50"]) {
      expect(`${line}:${result.text.includes(line)}`).toBe(`${line}:true`);
    }
    expect(result.text).toContain("# --- execution gates ---");
  });

  it("keeps a CRLF file CRLF", () => {
    // The real file is CRLF. Rewriting it as LF would show every line as
    // changed in any diff and is exactly the kind of collateral edit this tool
    // must not make.
    const before = envFixture(SAFE_GATES, { crlf: true });
    const result = applyGates(before, LIVE_READY_GATES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const crlf = (text: string) => (text.match(/\r\n/g) ?? []).length;
    expect(crlf(result.text)).toBe(crlf(before));
    expect(result.text).not.toMatch(/\r\r/);
  });

  it("round-trips SAFE -> LIVE-READY -> SAFE back to the original bytes", () => {
    const original = envFixture(SAFE_GATES, { crlf: true });
    const live = applyGates(original, LIVE_READY_GATES);
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    const back = applyGates(live.text, SAFE_GATES);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.text).toBe(original);
  });

  it("refuses to write when the file is ambiguous", () => {
    // No partial write, no guess.
    for (const broken of [
      `${envFixture()}\nEXECUTION_PROTECTION_READY=false\n`,
      envFixture().replace("EXECUTION_GLOBAL_KILL_SWITCH=true\n", ""),
    ]) {
      expect(applyGates(broken, LIVE_READY_GATES).ok).toBe(false);
    }
  });

  it("writes through a real temporary file without touching anything else", () => {
    const file = temporaryEnvFile(envFixture(SAFE_GATES, { crlf: true }));
    const before = readFileSync(file, "utf8");
    const result = applyGates(before, LIVE_READY_GATES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    writeFileSync(file, result.text, "utf8");

    const after = readFileSync(file, "utf8");
    expect(readGates(after)).toEqual({ ok: true, values: LIVE_READY_GATES });
    for (const line of SECRET_LINES) expect(after).toContain(line);
  });
});

// ---------------------------------------------------------------------------
// Operator token
// ---------------------------------------------------------------------------

describe("runtime launcher: operator token", () => {
  it("reports CONFIGURED without revealing the value", () => {
    expect(operatorTokenState(envFixture())).toBe("CONFIGURED");
  });

  it("reports NOT CONFIGURED when empty or absent", () => {
    expect(operatorTokenState(envFixture().replace(/OPERATOR_API_TOKEN=.*/, "OPERATOR_API_TOKEN="))).toBe(
      "NOT CONFIGURED"
    );
    expect(operatorTokenState("FOO=bar")).toBe("NOT CONFIGURED");
  });

  it("returns only the two words, never a fragment of the token", () => {
    const state = operatorTokenState(envFixture());
    expect(["CONFIGURED", "NOT CONFIGURED"]).toContain(state);
    expect(state).not.toContain("operator-token");
  });
});

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

describe("runtime launcher: LIVE-READY confirmation", () => {
  it("accepts only the exact phrase", () => {
    expect(isLiveReadyConfirmed(LIVE_READY_CONFIRMATION)).toBe(true);
    expect(LIVE_READY_CONFIRMATION).toBe("ENABLE LIVE RUNTIME");
  });

  it.each([
    ["empty", ""],
    ["lowercase", "enable live runtime"],
    ["padded", " ENABLE LIVE RUNTIME "],
    ["truncated", "ENABLE LIVE"],
    ["yes", "y"],
    ["undefined", undefined],
    ["a truthy object", { confirm: true }],
  ])("rejects %s", (_label, typed) => {
    expect(isLiveReadyConfirmed(typed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Process ownership
// ---------------------------------------------------------------------------

describe("runtime launcher: process ownership", () => {
  const REPO = "C:\\Projects\\trading-alert-dashboard";
  const record: OwnedProcess = { role: "backend", pid: 4242, startedAtMs: 1_700_000_000_000 };
  const probe = (overrides: Partial<ProcessProbe> = {}): ProcessProbe => ({
    pid: 4242,
    startedAtMs: 1_700_000_000_000,
    commandLine: `node C:\\Projects\\trading-alert-dashboard\\apps\\backend\\node_modules\\tsx\\dist\\cli.mjs watch src/server.ts`,
    ...overrides,
  });

  it("accepts a process that still exists, started when recorded, in this repo", () => {
    expect(verifyOwnership(record, probe(), REPO)).toEqual({ owned: true });
  });

  it("refuses a PID that no longer exists", () => {
    expect(verifyOwnership(record, null, REPO)).toEqual({ owned: false, reason: "GONE" });
  });

  it("refuses a REUSED pid", () => {
    // The single most dangerous failure this tool could have: a recycled PID
    // now belonging to something else on the operator's machine.
    const reused = probe({ startedAtMs: record.startedAtMs + 60_000 });
    expect(verifyOwnership(record, reused, REPO)).toEqual({ owned: false, reason: "PID_REUSED" });
  });

  it("refuses a process from a different program", () => {
    const unrelated = probe({ commandLine: "node C:\\Users\\someone\\other-project\\server.js" });
    expect(verifyOwnership(record, unrelated, REPO)).toEqual({ owned: false, reason: "NOT_THIS_REPO" });
  });

  it("refuses an unrelated Node process that merely shares the start time", () => {
    const coincidence = probe({ commandLine: "node C:\\Windows\\some-other-tool.js" });
    expect(verifyOwnership(record, coincidence, REPO).owned).toBe(false);
  });

  it("tolerates coarse creation-time resolution", () => {
    // Windows reports creation time at a coarser resolution than we record, so
    // an exact-equality check would reject our own processes.
    expect(verifyOwnership(record, probe({ startedAtMs: record.startedAtMs + 400 }), REPO).owned).toBe(true);
  });

  it("matches the repo path regardless of slash direction or case", () => {
    const mixed = probe({ commandLine: "node c:/projects/TRADING-ALERT-DASHBOARD/apps/backend/x.ts" });
    expect(verifyOwnership(record, mixed, REPO).owned).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Runtime state file
// ---------------------------------------------------------------------------

describe("runtime launcher: runtime state", () => {
  it("lives outside the repository", () => {
    const statePath = defaultStatePath({ LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" } as NodeJS.ProcessEnv);
    // Machine state, not source: a PID file inside a worktree is one
    // `git add -A` away from being committed.
    expect(statePath).toContain("AppData");
    expect(statePath.toLowerCase()).not.toContain("projects\\trading-alert-dashboard\\apps");
  });

  it("round-trips through the in-memory store", () => {
    const store = new MemoryStateStore();
    expect(store.read()).toBeNull();
    const state = {
      repoRoot: "C:\\Projects\\trading-alert-dashboard",
      mode: "SAFE" as const,
      startedAtMs: 1,
      processes: [{ role: "backend" as const, pid: 1, startedAtMs: 1 }],
    };
    store.write(state);
    expect(store.read()).toEqual(state);
    store.clear();
    expect(store.read()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Start preconditions
// ---------------------------------------------------------------------------

describe("runtime launcher: start preconditions", () => {
  it("allows a start on a quiet machine", () => {
    expect(
      evaluateStartPreconditions({ recordedProcessesAlive: 0, backendPortOpen: false, frontendPortOpen: false })
    ).toEqual({ ok: true });
  });

  it("refuses a duplicate stack", () => {
    // Two stacks would fight for the ports and, far worse, publish a second
    // runtime attestation — which the ARM interlock treats as a duplicate and
    // refuses.
    const verdict = evaluateStartPreconditions({
      recordedProcessesAlive: 2,
      backendPortOpen: true,
      frontendPortOpen: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("already running");
  });

  it("refuses when a port is held by something it does not own", () => {
    const verdict = evaluateStartPreconditions({
      recordedProcessesAlive: 0,
      backendPortOpen: true,
      frontendPortOpen: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("does not own");
  });
});

// ---------------------------------------------------------------------------
// Durable trading state
// ---------------------------------------------------------------------------

describe("runtime launcher: durable trading state", () => {
  const clean = {
    systemState: "SAFE_OFF",
    activeExecutions: 0,
    manualIntervention: 0,
    authorizationState: null as string | null,
    warnings: [] as string[],
  };
  const actions = ["LIVE_READY", "SHUTDOWN"] as const;

  it.each(actions)("allows %s when the durable state is SAFE OFF and clean", (action) => {
    expect(evaluateDurableSafety(clean, action)).toEqual({ safe: true });
  });

  it.each(actions)("refuses %s while the profile is ARMED", (action) => {
    // The defect this guard exists for: an armed profile with the runtime off
    // becomes executable again the moment a live-ready worker starts, with no
    // fresh Start Trading action on the dashboard.
    const verdict = evaluateDurableSafety({ ...clean, systemState: "ARMED" }, action);
    expect(verdict.safe).toBe(false);
    expect(verdict.safe === false && verdict.reason).toContain("not durably SAFE OFF");
  });

  it("refuses SHUTDOWN on ARMED even with zero executions", () => {
    // "Zero active executions" is NOT "durably disarmed".
    const verdict = evaluateDurableSafety(
      { ...clean, systemState: "ARMED", activeExecutions: 0, manualIntervention: 0 },
      "SHUTDOWN"
    );
    expect(verdict.safe).toBe(false);
    expect(verdict.safe === false && verdict.reason).toContain("ARMED");
  });

  it.each(actions)("refuses %s in SAFE_RECOVERY", (action) => {
    expect(evaluateDurableSafety({ ...clean, systemState: "SAFE_RECOVERY" }, action).safe).toBe(false);
  });

  it.each(actions)("refuses %s in INVALID", (action) => {
    expect(evaluateDurableSafety({ ...clean, systemState: "INVALID" }, action).safe).toBe(false);
  });

  it.each(actions)("refuses %s in UNKNOWN", (action) => {
    expect(evaluateDurableSafety({ ...clean, systemState: "UNKNOWN" }, action).safe).toBe(false);
  });

  it.each(actions)("refuses %s while an AVAILABLE authorization window exists", (action) => {
    // An open window can admit a trade the moment a runtime is live, whatever
    // the profile flags currently say.
    const verdict = evaluateDurableSafety({ ...clean, authorizationState: "AVAILABLE" }, action);
    expect(verdict.safe).toBe(false);
    expect(verdict.safe === false && verdict.reason).toContain("AVAILABLE");
    expect(verdict.safe === false && verdict.reason).toContain("Trading Control");
  });

  it.each(["EXPIRED", "REVOKED", "EXHAUSTED"])("allows a %s window, which cannot admit anything", (state) => {
    expect(evaluateDurableSafety({ ...clean, authorizationState: state }, "LIVE_READY")).toEqual({ safe: true });
  });

  it.each(actions)("refuses %s while an execution is active", (action) => {
    const verdict = evaluateDurableSafety({ ...clean, activeExecutions: 2 }, action);
    expect(verdict.safe).toBe(false);
    expect(verdict.safe === false && verdict.reason).toContain("still active");
  });

  it.each(actions)("refuses %s while manual intervention is outstanding", (action) => {
    const verdict = evaluateDurableSafety({ ...clean, manualIntervention: 1 }, action);
    expect(verdict.safe).toBe(false);
    expect(verdict.safe === false && verdict.reason).toContain("manual intervention");
  });

  it.each(actions)("refuses %s on outstanding recovery work", (action) => {
    // FILLED_WITHOUT_VERIFIED_PROTECTION is the recovery-required signal the
    // reviewed status service already computes.
    const verdict = evaluateDurableSafety({ ...clean, warnings: ["FILLED_WITHOUT_VERIFIED_PROTECTION"] }, action);
    expect(verdict.safe).toBe(false);
    expect(verdict.safe === false && verdict.reason).toContain("recovery work");
  });

  it("ignores warnings that are expected while the runtime is down", () => {
    // Attestation is always blocked with the runtime off -- which is exactly
    // when this tool runs -- and an expired window is already closed. Treating
    // either as a blocker would make the launcher unusable without making it
    // safer.
    const verdict = evaluateDurableSafety(
      { ...clean, warnings: ["RUNTIME_ATTESTATION_BLOCKED", "NATURAL_AUTHORIZATION_EXPIRED"] },
      "LIVE_READY"
    );
    expect(verdict).toEqual({ safe: true });
  });

  it.each([
    ["systemState", { systemState: null }],
    ["activeExecutions", { activeExecutions: null }],
    ["manualIntervention", { manualIntervention: null }],
    ["warnings", { warnings: null }],
  ])("refuses when %s is unreadable", (_label, overrides) => {
    // "We could not reach the database" and "there is nothing outstanding" are
    // different facts, and only one of them is safe to act on.
    for (const action of actions) {
      const verdict = evaluateDurableSafety({ ...clean, ...overrides }, action);
      expect(`${action}:${verdict.safe}`).toBe(`${action}:false`);
      expect(verdict.safe === false && verdict.reason).toContain("could not be read");
    }
  });

  it("tells the operator to use Trading Control rather than offering a shortcut", () => {
    for (const action of actions) {
      const verdict = evaluateDurableSafety({ ...clean, systemState: "ARMED" }, action);
      expect(verdict.safe === false && verdict.reason).toContain("Safe Off");
    }
  });

  it("words the two actions differently", () => {
    const live = evaluateDurableSafety({ ...clean, systemState: "ARMED" }, "LIVE_READY");
    const stop = evaluateDurableSafety({ ...clean, systemState: "ARMED" }, "SHUTDOWN");
    expect(live.safe === false && live.reason).toContain("before starting LIVE-READY");
    expect(stop.safe === false && stop.reason).toContain("before stopping the runtime");
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe("runtime launcher: status", () => {
  const base = {
    running: { backend: true, worker: true, frontend: true },
    backendPortOpen: true,
    frontendPortOpen: true,
    operatorToken: "CONFIGURED" as const,
  };

  it.each(["SAFE", "LIVE_READY"] as const)("shows %s without a warning", (diskMode) => {
    const view = presentStatus({ ...base, diskMode });
    expect(view.diskMode).toBe(diskMode);
    expect(view.diskModeWarning).toBeNull();
  });

  it("shows INVALID prominently", () => {
    const view = presentStatus({ ...base, diskMode: "INVALID" });
    expect(view.diskModeWarning).toBe(INVALID_MODE_WARNING);
    expect(renderStatus(view).join("\n")).toContain("WARNING:");
  });

  it("reports each role independently", () => {
    const view = presentStatus({
      ...base,
      diskMode: "SAFE",
      running: { backend: true, worker: false, frontend: true },
    });
    expect(`${view.backend}/${view.worker}/${view.frontend}`).toBe("ON/OFF/ON");
  });

  it("renders ports as status only", () => {
    const rendered = renderStatus(presentStatus({ ...base, diskMode: "SAFE" })).join("\n");
    expect(rendered).toContain("4000 open");
    expect(rendered).toContain("5173 open");
  });

  it("never renders a secret", () => {
    const rendered = renderStatus(
      presentStatus({ ...base, diskMode: "LIVE_READY", attestation: "BLOCKED" })
    ).join("\n");
    for (const secret of ["abcdef0123456789", "ZZZZsecret", "hunter2", "operator-token", "postgresql://", "redis://", "password"]) {
      expect(`${secret}:${rendered.includes(secret)}`).toBe(`${secret}:false`);
    }
    // Only the two-word token state, never a value.
    expect(rendered).toContain("Operator token: CONFIGURED");
  });
});

// ---------------------------------------------------------------------------
// Structural: this tool cannot trade
// ---------------------------------------------------------------------------

describe("runtime launcher: structural guarantees", () => {
  const codeOf = (relative: string) =>
    readFileSync(path.join(process.cwd(), relative), "utf8")
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");

  const core = () => codeOf("src/modules/operator/runtime-launcher.ts");
  const cli = () => codeOf("src/modules/operator/run-runtime-launcher.ts");

  it("cannot arm, authorize or trade", () => {
    // The whole safety case for a double-clickable tool: it is a deployment
    // launcher, and there is no code path from it to a trade.
    for (const source of [core(), cli()]) {
      for (const forbidden of [
        "armNaturalWindow",
        "prepareNaturalWindow",
        "claimNaturalWindow",
        "startTrading",
        "TradingControlActionsService",
        "executionProfile.update",
        "executionSafetyPolicy.update",
        "executionCanaryAuthorization",
        "BinanceExecutionClient",
        "placeOrder",
        "cancelOrder",
        // The dashboard owns the durable transitions. The launcher must not be
        // able to perform ANY of them, including the safe-looking ones: a
        // deployment tool that can silently disarm is a deployment tool an
        // operator will start trusting instead of Trading Control.
        "stopNewTrades",
        "safeOff",
        "closeCanaryWindowOperation",
        "disarmCanaryOperation",
      ]) {
        expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
      }
    }
  });

  it("writes nothing to the database", () => {
    for (const source of [core(), cli()]) {
      for (const forbidden of [".create(", ".update(", ".upsert(", ".delete(", "deleteMany", "$executeRaw", "$transaction"]) {
        expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
      }
    }
  });

  it("owns exactly three environment keys", () => {
    // Any other key appearing as a write target would mean the tool had grown
    // the ability to edit credentials or risk policy.
    expect(RUNTIME_GATE_KEYS).toEqual([
      "EXECUTION_GLOBAL_KILL_SWITCH",
      "EXECUTION_LIVE_ENTRY_ENABLED",
      "EXECUTION_PROTECTION_READY",
    ]);
    for (const forbidden of [
      "BINANCE_API_KEY",
      "BINANCE_API_SECRET",
      "WEBHOOK_SECRET",
      "DATABASE_URL",
      "REDIS_URL",
      "EXECUTION_MAX_TOTAL_PLANNED_RISK_USD",
      "EXECUTION_EMERGENCY_CLOSE_MODE",
      "allowedSymbols",
    ]) {
      expect(`${forbidden}:${core().includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("names the operator token only to answer CONFIGURED, never to write it", () => {
    // The key IS mentioned, in `operatorTokenState`, which measures length and
    // discards the value. What must not exist is any path that rewrites it.
    const source = core();
    const rewrite = source.slice(source.indexOf("export function applyGates"), source.indexOf("export function operatorTokenState"));
    expect(rewrite).not.toContain("OPERATOR_API_TOKEN");
    const reader = source.slice(
      source.indexOf("export function operatorTokenState"),
      source.indexOf("export const LIVE_READY_CONFIRMATION")
    );
    // EVERY return in the reader yields one of the two literals. The token
    // value is measured and discarded, never handed back.
    const returns = reader.match(/return [^;]+;/g) ?? [];
    expect(returns.length).toBeGreaterThan(0);
    for (const statement of returns) {
      const onlyLiterals = /^return [^;]*"(CONFIGURED|NOT CONFIGURED)"[^;]*;$/.test(statement.trim());
      expect(`${statement.trim()}:${onlyLiterals}`).toBe(`${statement.trim()}:true`);
    }
  });

  it("terminates only by verified PID, never by process name", () => {
    // No name-based sweep can exist here: `taskkill /IM node.exe` on a
    // developer's machine is unacceptable.
    const source = cli();
    expect(source).toContain("verifyOwnership");
    expect(source).toContain('"/PID"');
    for (const forbidden of ["/IM", "node.exe", "Stop-Process -Name", "taskkill /f /im"]) {
      expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("checks the durable state BEFORE writing a gate or spawning anything", () => {
    // Ordering is the whole point: a refusal that arrives after .env has been
    // rewritten, or after the worker is live, has already done the damage.
    const source = cli();
    const liveReady = source.slice(
      source.indexOf("async function startLiveReady"),
      source.indexOf("async function stopRuntime")
    );
    expect(liveReady.length).toBeGreaterThan(0);
    const guard = liveReady.indexOf("evaluateDurableSafety");
    expect(guard).toBeGreaterThan(-1);
    // Before the typed confirmation, and therefore before startRuntime, which
    // is the only place a gate is written or a process is spawned.
    expect(guard).toBeLessThan(liveReady.indexOf("isLiveReadyConfirmed"));
    expect(guard).toBeLessThan(liveReady.indexOf("startRuntime("));
    // And startRuntime itself never consults it, so the check cannot be
    // "satisfied" by a later call.
    const start = source.slice(source.indexOf("async function startRuntime"), source.indexOf("async function startLiveReady"));
    expect(start).not.toContain("evaluateDurableSafety");
  });

  it("checks the durable state BEFORE terminating any process", () => {
    const source = cli();
    const stop = source.slice(source.indexOf("async function stopRuntime"), source.indexOf("async function main"));
    expect(stop.length).toBeGreaterThan(0);
    expect(stop.indexOf("evaluateDurableSafety")).toBeLessThan(stop.indexOf("terminateTree("));
    // And the gates are only restored after the processes are gone.
    expect(stop.indexOf("terminateTree(")).toBeLessThan(stop.indexOf("applyGates("));
  });

  it("reads the durable state without a preflight or an exchange call", () => {
    // The cheap DB/Redis status path, not a second readiness engine.
    const source = cli();
    for (const forbidden of ["CanaryPreflightService", "readReadiness", "checkAccountConnection", "binance"]) {
      expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("checks outstanding work through the existing read-only service", () => {
    // Not a second definition of "is anything still running".
    const source = cli();
    expect(source).toContain("TradingControlService");
    expect(source).toContain("readStatus()");
    expect(source).toContain("evaluateDurableSafety");
  });

  it("adds no HTTP surface", () => {
    // This must never become a web API: the internet-facing backend must not
    // gain the ability to edit .env, restart itself or toggle deployment gates.
    for (const source of [core(), cli()]) {
      for (const forbidden of ["fastify", "app.post(", "app.get(", "createServer", "listen("]) {
        expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
      }
    }
    // And no operator ROUTE PATH exposes runtime or environment control. Route
    // paths only: `import ... from "../config/env"` is not an endpoint.
    const routes = codeOf("src/routes/operator.routes.ts");
    const paths = (routes.match(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g) ?? []).map((entry) =>
      entry.replace(/[\s\S]*"/, "").replace(/"$/, "")
    );
    expect(paths.length).toBeGreaterThan(0);
    for (const forbidden of ["runtime", "env", "launcher", "gate", "restart"]) {
      const offenders = paths.filter((route) => route.toLowerCase().includes(forbidden));
      expect(`${forbidden}:${offenders.join(",")}`).toBe(`${forbidden}:`);
    }
  });

  it("writes .env atomically", () => {
    // A failed write must leave the previous file, never a truncated one that
    // would parse as a different deployment mode.
    const source = cli();
    expect(source).toContain("renameSync");
    expect(source).toContain(".tmp");
  });
});
