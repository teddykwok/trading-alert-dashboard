import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { alwaysOnPaths } from "../src/modules/always-on/always-on-paths";
import { renderAlwaysOnStatus, type AlwaysOnStatusDto } from "../src/modules/always-on/always-on-status";
import { createAlwaysOnLauncher } from "../src/modules/operator/always-on-launcher";
import { observed } from "../src/modules/operator/runtime-launcher";

/**
 * ALWAYS-ON STATUS BACKWARD COMPATIBILITY. A status artifact written by an
 * older supervisor (schema v1, before the stream probe) has no
 * `network.stream`. Both readers — `monitoring:always-on status` and the
 * runtime launcher's status view (item 17) — must render it without throwing,
 * show the stream path as NOT RECORDED (never as healthy), and never write to
 * it. The fixture mirrors the structure of a real pre-stream-probe artifact;
 * every value is synthetic.
 */

const NOW = Date.UTC(2026, 9, 25, 3, 0, 0);
const BACKEND = path.resolve(__dirname, "..");

const role = (name: string, extra: Record<string, unknown>) => ({
  role: name,
  label: name,
  state: "OFF",
  reasonCode: "STOPPED",
  reason: "stopped",
  owned: null,
  restarts: 0,
  attempts: 0,
  nextAttemptAt: null,
  latched: false,
  lastExit: { at: "2026-10-24T21:05:01.349Z", code: 0 },
  externalPids: [],
  ...extra,
});

/** A schema-v1 artifact as a pre-stream-probe supervisor wrote it: `network` has no `stream`. */
function statusV1(): Record<string, unknown> {
  return {
    schema: "teddy.native-monitoring.always-on-status.v1",
    notice: ["MONITORING ONLY", "NO ACCOUNT EXECUTION", "NATIVE EXECUTION HARD-DISABLED"],
    authority: "MONITORING_ONLY",
    nativeExecutionEnabled: false,
    accountExecution: "NONE",
    state: "STOPPED",
    reasonCode: "OPERATOR_STOP_REQUEST",
    reason: "every owned role was stopped; nothing is owned",
    generation: 2,
    supervisor: { pid: 9724, startedAt: "2026-10-24T20:21:21.135Z", instancePort: 4019, profile: "teddy-7-all-active", roles: ["backend", "scanner", "emitter", "planner"] },
    startedAt: "2026-10-24T20:21:21.135Z",
    writtenAt: "2026-10-24T21:05:04.752Z",
    lastEndToEndHealthyAt: "2026-10-24T21:03:09.394Z",
    lastRecovery: null,
    backoff: null,
    dataStore: "AVAILABLE",
    network: { reachable: true, lastProbeAt: "2026-10-24T20:21:21.200Z", unavailableSince: null },
    roles: {
      backend: role("backend", { healthOk: true }),
      scanner: role("scanner", {
        runId: "20261024T202126Z-50c02623",
        engineFingerprint: "35f1a32d82ac2786ee67dd4c5146760bf1f29d5025cafe01da5394b79a9b47fb",
        runBindable: true,
        // A pre-stream-probe ScannerHealth: no `stream`, no `universe.nextRefreshAt`.
        health: {
          ours: true,
          runId: "20261024T202126Z-50c02623",
          runState: "RUNNING",
          engineFingerprint: "35f1a32d82ac2786ee67dd4c5146760bf1f29d5025cafe01da5394b79a9b47fb",
          startedAt: "2026-10-24T20:21:27.396Z",
          writtenAt: "2026-10-24T21:04:59.556Z",
          ageSeconds: 5,
          universe: { exchangeCandidates: 522, generation: 8, stale: false, capacityExceeded: false, selected: 522, liveEligible: 522, quarantined: 0, failed: 0, recovering: 0, awaitingStream: 0, awaitingStreamQuiet: 0, catchupPending: 0 },
          lastMarketDataAt: "2026-10-24T21:04:58.000Z",
          reconnects: 0,
          backpressureEvents: 0,
          restHalted: false,
          restRequests: 593,
          verdict: "HEALTHY",
          issues: [],
        },
      }),
      emitter: role("emitter", { pinnedRunId: null, health: null }),
      planner: role("planner", { baseline: { jobsFailed: 3, plansError: 3, establishedAt: "2026-10-24T20:21:58.000Z" }, health: null }),
    },
    external: { soakMonitorPids: [], otherSupervisorPids: [] },
    counters: { ticks: 161, scannerRecoveries: 0, restarts: { backend: 0, scanner: 0, emitter: 0, planner: 0 } },
    recentIncidents: [],
  };
}

/** The same artifact as the current supervisor writes it: `network.stream` present. */
function statusCurrent(stream: { unreachableSince: string | null; lastProbeAt: string | null; lastProbeOutcome: string | null }): Record<string, unknown> {
  const s = statusV1();
  return { ...s, network: { ...(s.network as object), stream } };
}

const networkLine = (lines: readonly string[]) => lines.find((l) => l.includes("public network")) as string;

describe("the shared status renderer reads every status generation", () => {
  it("a schema-v1 artifact without network.stream renders, and shows the stream path as NOT RECORDED — never as healthy", () => {
    const lines = renderAlwaysOnStatus(statusV1() as unknown as AlwaysOnStatusDto, NOW);
    const line = networkLine(lines);
    expect(line).toContain("public streams not recorded");
    expect(line).not.toMatch(/public streams (reachable|UNREACHABLE)/);
    expect(lines.length).toBeGreaterThan(10);
  });

  it("a current artifact with a confirmed stream outage shows it", () => {
    const lines = renderAlwaysOnStatus(statusCurrent({ unreachableSince: "2026-10-25T02:40:00.000Z", lastProbeAt: "2026-10-25T02:59:30.000Z", lastProbeOutcome: "UNREACHABLE" }) as unknown as AlwaysOnStatusDto, NOW);
    expect(networkLine(lines)).toContain("public streams UNREACHABLE since 2026-10-25T02:40:00.000Z");
  });

  it("a current artifact whose stream fields are all null (never probed) adds nothing — exactly the current output", () => {
    const lines = renderAlwaysOnStatus(statusCurrent({ unreachableSince: null, lastProbeAt: null, lastProbeOutcome: null }) as unknown as AlwaysOnStatusDto, NOW);
    expect(networkLine(lines)).toBe("  data store   AVAILABLE; public network reachable");
  });
});

// ===========================================================================
// The real CLI: `monitoring:always-on status`, as a child process over a temp LOCALAPPDATA
// ===========================================================================

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function cliStatus(status: Record<string, unknown>) {
  const local = mkdtempSync(path.join(tmpdir(), "aon-status-compat-"));
  dirs.push(local);
  const paths = alwaysOnPaths({ LOCALAPPDATA: local });
  mkdirSync(path.dirname(paths.status), { recursive: true });
  const text = `${JSON.stringify(status, null, 2)}\n`;
  writeFileSync(paths.status, text, "utf8");
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  const run = spawnSync(process.execPath, [path.join(BACKEND, "node_modules", "tsx", "dist", "cli.mjs"), "src/modules/always-on/run-always-on-monitoring.ts", "status"], {
    cwd: BACKEND,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    // Only what a status read needs: no credentials, no env file, and a LOCALAPPDATA that is not the operator's.
    env: { LOCALAPPDATA: local, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
  return { run, unchanged: sha(readFileSync(paths.status, "utf8")) === sha(text), stdout: `${run.stdout ?? ""}`, stderr: `${run.stderr ?? ""}` };
}

describe("monitoring:always-on status (the real CLI) reads an existing artifact without a running supervisor", () => {
  it("a schema-v1 artifact: exit 0, rendered, the stream path NOT RECORDED, the file untouched", () => {
    const { run, unchanged, stdout, stderr } = cliStatus(statusV1());
    expect(stderr).not.toMatch(/TypeError|failed/);
    expect(run.status).toBe(0);
    expect(stdout).toContain("Supervisor: NOT RUNNING");
    expect(stdout).toContain("STOPPED (OPERATOR_STOP_REQUEST)");
    expect(stdout).toContain("public streams not recorded");
    expect(unchanged).toBe(true);
  }, 90_000);

  it("a current artifact with a confirmed stream outage: exit 0 and the outage shown", () => {
    const { run, unchanged, stdout } = cliStatus(statusCurrent({ unreachableSince: "2026-10-25T02:40:00.000Z", lastProbeAt: "2026-10-25T02:59:30.000Z", lastProbeOutcome: "UNREACHABLE" }));
    expect(run.status).toBe(0);
    expect(stdout).toContain("public streams UNREACHABLE since 2026-10-25T02:40:00.000Z");
    expect(unchanged).toBe(true);
  }, 90_000);
});

// ===========================================================================
// The runtime launcher's status view (item 17), through its injected adapters
// ===========================================================================

function launcherStatus(status: Record<string, unknown>) {
  const paths = alwaysOnPaths({ LOCALAPPDATA: "C:\\local" });
  const text = JSON.stringify(status);
  const files = new Map<string, string>([[paths.status, text]]);
  const writes: string[] = [];
  const lines: string[] = [];
  const launcher = createAlwaysOnLauncher({
    repoRoot: "C:\\repo",
    env: { LOCALAPPDATA: "C:\\local" },
    probeProcesses: () => observed(new Map()),
    readText: (file) => files.get(file) ?? null,
    writeTextAtomic: (file) => void writes.push(file),
    startSupervisor: () => {
      throw new Error("a status view never starts anything");
    },
    lockAdapters: () => {
      throw new Error("a status view never takes the mutation lock");
    },
    log: (line) => lines.push(line),
    sleep: async () => undefined,
    now: () => NOW,
  });
  launcher.showStatus();
  return { lines, writes, unchanged: files.get(paths.status) === text };
}

describe("the launcher's status view (item 17) reads an existing artifact without a running supervisor", () => {
  it("a schema-v1 artifact: rendered, the stream path NOT RECORDED, nothing written", () => {
    const { lines, writes, unchanged } = launcherStatus(statusV1());
    expect(lines).toContain("Always-On supervisor: NOT RUNNING");
    expect(lines.some((l) => l.includes("STOPPED (OPERATOR_STOP_REQUEST)"))).toBe(true);
    expect(networkLine(lines)).toContain("public streams not recorded");
    expect(writes).toEqual([]);
    expect(unchanged).toBe(true);
  });

  it("a current artifact with a confirmed stream outage: the outage shown", () => {
    const { lines } = launcherStatus(statusCurrent({ unreachableSince: "2026-10-25T02:40:00.000Z", lastProbeAt: null, lastProbeOutcome: "UNREACHABLE" }));
    expect(networkLine(lines)).toContain("public streams UNREACHABLE since 2026-10-25T02:40:00.000Z");
  });
});
