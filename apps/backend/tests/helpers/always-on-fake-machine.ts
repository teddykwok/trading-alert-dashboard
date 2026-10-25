import path from "node:path";

import { ALWAYS_ON_DEFAULTS, type AlwaysOnPolicy, type AlwaysOnRole } from "../../src/modules/always-on/always-on-contract";
import { alwaysOnPaths, emitterCommitStatus, scannerRunManifest, type AlwaysOnPaths } from "../../src/modules/always-on/always-on-paths";
import type { PublicStreamProbeOutcome } from "../../src/modules/always-on/always-on-machine";
import type { MonitoringSpawnPlan } from "../../src/modules/always-on/always-on-roles";
import { AlwaysOnSupervisor, type AlwaysOnAdapters, type AlwaysOnConfig } from "../../src/modules/always-on/always-on-supervisor";
import type { BuildVerdict } from "../../src/modules/operator/generic-backend-nonwatch-launcher";
import type { MutationAction, WithAuthorityResult } from "../../src/modules/operator/mutation-lock";
import { observed, unobserved, type ObservedProcessNode } from "../../src/modules/operator/runtime-launcher";
import { engineFingerprintOf, resolveScannerProfile } from "../../src/modules/native-scanner/scanner-profile";
import { makeRunId } from "../../src/modules/native-scanner/supervisor-run-manifest";

/**
 * A FAKE MACHINE for the Always-On supervisor: an in-memory process table with
 * real parent links (cmd.exe roots, node.exe runtimes), an in-memory file
 * system, fake HTTP answers for the local backend, a switchable public
 * network, and a manual clock. "Autopilot" children publish status the way the
 * real processes do (the scanner its status.json + manifest, the emitter its
 * status-commit.json, the backend /health, the planner its readiness), and
 * honour cooperative stop files — each behaviour switchable per scenario.
 */

export const REPO = "C:\\repo";
export const LOCAL = "C:\\local";
export const SUPERVISOR_PID = 50;
export const PROFILE = "teddy-7-all-active";
export const ENGINE = engineFingerprintOf(resolveScannerProfile(PROFILE));

const ENTRY: Readonly<Record<AlwaysOnRole, string>> = {
  backend: "dist/src/server.js",
  scanner: "src/modules/native-scanner/run-live-shadow-supervisor.ts",
  emitter: "src/modules/native-alerts/run-native-multi-emitter.ts",
  planner: "src/modules/native-planning/native-plan.worker.ts",
};

/** The supervisor's inherited environment: deliberately FULL of credentials, in mixed case. */
export const DIRTY_ENV: NodeJS.ProcessEnv = {
  LOCALAPPDATA: LOCAL,
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
  PATH: "C:\\Windows",
  BINANCE_API_KEY: "never-inherited-key",
  binance_api_secret: "never-inherited-secret",
  API_KEY: "never-inherited",
  Api_Secret: "never-inherited",
  EXECUTION_PROFILE_ACCOUNT_IDENTIFIER: "account-a-identifier",
  EXECUTION_PROFILE_ENVIRONMENT: "MAINNET",
  DATABASE_URL: "postgresql://shell-value",
  DOTENV_CONFIG_PATH: "C:\\elsewhere\\account-a.env",
};

export type ScannerBehaviour = "healthy" | "degraded-until-restart" | "crash" | "silent" | "network-dependent" | "degraded";

export interface ScannerShape {
  selected: number;
  liveEligible: number;
  quarantined: number;
  failed: number;
  recovering: number;
  awaitingStream: number;
  exchangeCandidates: number;
  stale: boolean;
  capacityExceeded: boolean;
}

export const HEALTHY_UNIVERSE: ScannerShape = { selected: 524, liveEligible: 524, quarantined: 0, failed: 0, recovering: 0, awaitingStream: 0, exchangeCandidates: 524, stale: false, capacityExceeded: false };
export const OUTAGE_UNIVERSE: ScannerShape = { selected: 524, liveEligible: 396, quarantined: 0, failed: 128, recovering: 0, awaitingStream: 0, exchangeCandidates: 524, stale: false, capacityExceeded: false };

interface Child {
  readonly role: AlwaysOnRole;
  readonly root: number;
  readonly runtime: number;
  readonly plan: MonitoringSpawnPlan;
  readonly stopFile: string | null;
  readonly runId: string | null;
  readonly pinnedRunId: string | null;
  readonly index: number;
}

export function plannerStatusBody(over: { state?: string; consumers?: number; failed?: number; pending?: number; lastSweepError?: string | null; readiness?: string } = {}) {
  return {
    generatedAt: "x",
    role: "native-planner",
    queue: "native-extreme-rr-plan",
    nativeExecutionEnabled: false,
    startedBy: "EXPLICIT_COMMAND_OR_LAUNCHER",
    worker: { state: over.state ?? "RUNNING", reason: "", startedAt: null, lastHeartbeatAt: null, ageSeconds: 1, consumerRunning: true, lastSweep: null, lastSweepError: over.lastSweepError ?? null },
    connectedConsumers: over.consumers ?? 1,
    jobs: { waiting: 0, active: 0, delayed: 0, failed: over.failed ?? 2, completed: 40 },
    pendingNativePlans: over.pending ?? 0,
    readiness: over.readiness ?? "READY",
  };
}

export class FakeMachine {
  now = Date.UTC(2026, 9, 23, 0, 0, 0);
  readonly nodes = new Map<number, ObservedProcessNode>();
  readonly files = new Map<string, string>();
  readonly spawns: Child[] = [];
  readonly terminated: number[] = [];
  readonly fsWrites: string[] = [];
  readonly mutations: MutationAction[] = [];
  private nextPid = 1000;
  network = true;
  build: BuildVerdict = { ok: true };
  observable = true;
  lockBusy = false;
  honourStops = true;
  scannerBehaviour: ScannerBehaviour = "healthy";
  scannerUniverse: ScannerShape = HEALTHY_UNIVERSE;
  scannerLastMessageAgoMs = 5_000;
  /** The status's universe.nextRefreshAt, written as given (undefined: absent), so tests can send invalid values too. */
  scannerNextRefreshAt: unknown = undefined;
  /** Null: the compact status. Otherwise the full per-symbol / per-connection detail the real scanner writes. */
  scannerDetail: { silentAwaiting: boolean } | null = null;
  /** The engine fingerprint each scanner run (by its spawn index) reports. */
  scannerEngine: (index: number) => string = () => ENGINE;
  emitterTracked: number | null = null;
  emitterFailedLanes = 0;
  emitterQueue = { depth: 0, capacity: 10_000, max: 0, backlogLanes: 0 };
  emitterSilent = false;
  /** Until this instant the emitter is still re-validating its lanes (initialize()): fresh status, initialization incomplete. */
  emitterInitializingUntilMs: number | null = null;
  plannerOver: Parameters<typeof plannerStatusBody>[0] = {};
  plans: Record<string, number> = { PENDING: 0, READY: 12, INVALID: 0, ERROR: 3 };
  soakStatus = 200;
  backendAnswers = true;
  readonly paths: AlwaysOnPaths = alwaysOnPaths({ LOCALAPPDATA: LOCAL });
  readonly httpCalls: string[] = [];
  connectivityProbes = 0;
  /** What the public stream probe answers (THROWS: the probe itself fails), and when it was asked. */
  streamOutcome: PublicStreamProbeOutcome | "THROWS" = "REACHABLE";
  readonly streamProbes: number[] = [];
  /** The drill faults the supervisor handed each REST / stream probe call (null: no drill — production behaviour). */
  readonly connectivityDrills: unknown[] = [];
  readonly streamProbeDrills: unknown[] = [];
  /** What the Windows ACL check of the drill directories answers, and the directories it was asked about. */
  privateDirectories: { private: true } | { private: false; reason: string } = { private: true };
  readonly aclChecks: (readonly string[])[] = [];
  /** The drill observation a scanner run writes into its status (null: none, exactly as a scanner without a drill). */
  scannerDrill: ((child: { readonly root: number; readonly runId: string | null; readonly stopFile: string | null }) => Record<string, unknown> | null) | null = null;
  /** File-system faults, as Windows produces them (a reader, an editor, an indexer or antivirus holding the file). */
  failWrite: ((file: string) => boolean) | null = null;
  failRead: ((file: string) => boolean) | null = null;
  failRemove: ((file: string) => boolean) | null = null;

  // ---- process table ----
  private spawnChild(plan: MonitoringSpawnPlan): number {
    const root = this.nextPid++;
    const runtime = this.nextPid++;
    const arg = (name: string) => {
      const i = plan.args.indexOf(name);
      return i >= 0 ? (plan.args[i + 1] as string) : null;
    };
    this.nodes.set(root, { pid: root, parentPid: SUPERVISOR_PID, executable: "cmd.exe", startedAtMs: this.now, commandLine: `cmd.exe ${plan.args.join(" ")}` });
    const index = this.spawns.filter((c) => c.role === plan.role).length;
    const runId = plan.role === "scanner" ? makeRunId(this.now, (0x10000000 + this.spawns.length).toString(16).slice(-8)) : null;
    this.nodes.set(runtime, { pid: runtime, parentPid: root, executable: "node.exe", startedAtMs: this.now, commandLine: `node --import loader.mjs ${REPO}\\apps\\backend\\${ENTRY[plan.role].replace(/\//g, "\\")}` });
    this.spawns.push({ role: plan.role, root, runtime, plan, stopFile: arg("--stop-file"), runId, pinnedRunId: arg("--run-id"), index });
    return root;
  }

  /** An operator's `monitoring:always-on drill start` controller process of this repository (or another command line). */
  addDrillController(commandLine = `"C:\\Program Files\\nodejs\\node.exe" --require ${REPO}\\node_modules\\tsx\\dist\\preflight.cjs src/modules/always-on/run-always-on-monitoring.ts drill start`): { pid: number; startedAtMs: number } {
    const pid = this.nextPid++;
    this.nodes.set(pid, { pid, parentPid: 1, executable: "node.exe", startedAtMs: this.now, commandLine });
    return { pid, startedAtMs: this.now };
  }

  /** A process this supervisor did NOT start (a manual scanner, an old soak monitor, …). */
  addExternal(entrypoint: string): number {
    const root = this.nextPid++;
    const runtime = this.nextPid++;
    this.nodes.set(root, { pid: root, parentPid: 1, executable: "cmd.exe", startedAtMs: this.now, commandLine: `cmd.exe /c pnpm -C C:\\elsewhere ${entrypoint}` });
    this.nodes.set(runtime, { pid: runtime, parentPid: root, executable: "node.exe", startedAtMs: this.now, commandLine: `node C:\\elsewhere\\apps\\backend\\${entrypoint.replace(/\//g, "\\")}` });
    return runtime;
  }

  kill(root: number): void {
    const doomed = new Set<number>([root]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of this.nodes.values()) {
        if (!doomed.has(node.pid) && doomed.has(node.parentPid)) {
          doomed.add(node.pid);
          grew = true;
        }
      }
    }
    for (const pid of doomed) this.nodes.delete(pid);
  }

  alive(child: Child): boolean {
    return this.nodes.has(child.root);
  }

  live(role: AlwaysOnRole): Child[] {
    return this.spawns.filter((c) => c.role === role && this.alive(c));
  }

  /** The children behave: honour stop files, crash when told to, publish their status. */
  private autopilot(): void {
    for (const child of this.spawns) {
      if (!this.alive(child)) continue;
      if (this.honourStops && child.stopFile !== null && this.files.has(child.stopFile)) {
        this.kill(child.root);
        continue;
      }
      if (child.role === "scanner") this.scannerAutopilot(child);
      if (child.role === "emitter") this.emitterAutopilot(child);
    }
  }

  /**
   * The scanner's per-symbol and per-connection detail, as the real scanner writes it: connection 0 is OPEN and
   * delivering; awaiting symbols sit on it ("quiet") unless `silentAwaiting` puts them on connection 1, which has
   * never delivered anything. A FAILED symbol keeps its connection, as the real scanner's fail() never unplaces it.
   */
  private detailOf(u: ScannerShape, lastMessageAgoMs: number) {
    const detail = this.scannerDetail as { silentAwaiting: boolean };
    const lastValidMessageAt = new Date(this.now - lastMessageAgoMs).toISOString();
    const symbols: { symbol: string; connection: number; status: string; readiness: string; lastValidMessageAt: string | null }[] = [];
    const add = (n: number, readiness: string, connection: number, status = "ATTACHED") => {
      for (let i = 0; i < n; i += 1) symbols.push({ symbol: `${readiness.slice(0, 3)}${symbols.length}USDT`, connection, status, readiness, lastValidMessageAt: readiness === "AWAITING_STREAM" ? null : lastValidMessageAt });
    };
    add(u.liveEligible, "LIVE_ELIGIBLE", 0);
    add(u.quarantined, "QUARANTINED_CURRENT_BAR", 0);
    add(u.awaitingStream, "AWAITING_STREAM", detail.silentAwaiting ? 1 : 0);
    add(u.recovering, "RECOVERING", 0, "RECOVERING");
    add(u.failed, "FAILED", 0, "FAILED");
    return {
      symbols,
      connections: [
        { index: 0, lifecycle: "OPEN", lastMessageAt: lastValidMessageAt },
        { index: 1, lifecycle: "CONNECTING", lastMessageAt: null },
      ],
    };
  }

  private scannerAutopilot(child: Child): void {
    const behaviour = this.scannerBehaviour;
    if (behaviour === "crash") {
      this.kill(child.root);
      return;
    }
    if (behaviour === "silent") return;
    const degraded = behaviour === "degraded" || (behaviour === "degraded-until-restart" && child.index === 0) || (behaviour === "network-dependent" && !this.network);
    this.writeScannerStatus(child, degraded ? OUTAGE_UNIVERSE : this.scannerUniverse, degraded ? 600_000 : this.scannerLastMessageAgoMs);
    this.files.set(scannerRunManifest(this.paths, child.runId as string), "{}");
  }

  writeScannerStatus(child: Child, u: ScannerShape, lastMessageAgoMs: number, runState = "RUNNING", writtenAt = this.now): void {
    this.files.set(
      this.paths.scannerStatus,
      JSON.stringify({
        schema: "teddy.native-scanner.live-shadow-supervisor-status.v3",
        runId: child.runId,
        runState,
        startedAt: new Date(this.now).toISOString(),
        engineFingerprint: this.scannerEngine(child.index),
        pid: child.runtime,
        writtenAt: new Date(writtenAt).toISOString(),
        totals: { selected: u.selected, liveEligible: u.liveEligible, quarantined: u.quarantined, failed: u.failed, recovering: u.recovering, awaitingStream: u.awaitingStream, catchupPending: 0, reconnects: 7, backpressureEvents: 0, restRequests: 600, restHalted: false },
        universe: {
          generation: 3,
          stale: u.stale,
          exchangeCandidates: u.exchangeCandidates,
          capacity: { exceeded: u.capacityExceeded },
          ...(this.scannerNextRefreshAt === undefined ? {} : { nextRefreshAt: this.scannerNextRefreshAt }),
        },
        ...((): Record<string, unknown> => {
          const drill = this.scannerDrill?.(child) ?? null;
          return drill === null ? {} : { drill };
        })(),
        ...(this.scannerDetail === null ? { symbols: [{ symbol: "AAAUSDT", lastValidMessageAt: new Date(this.now - lastMessageAgoMs).toISOString() }] } : this.detailOf(u, lastMessageAgoMs)),
      })
    );
  }

  private emitterAutopilot(child: Child): void {
    if (this.emitterSilent || child.pinnedRunId === null) return;
    const tracked = this.emitterTracked ?? this.scannerUniverse.selected;
    const initializing = this.emitterInitializingUntilMs !== null && this.now < this.emitterInitializingUntilMs;
    this.files.set(
      emitterCommitStatus(this.paths, child.pinnedRunId),
      JSON.stringify({
        schema: "teddy.native-alerts.multi-symbol-emitter-status.v1",
        pid: child.runtime,
        runId: child.pinnedRunId,
        mode: "COMMIT_DASHBOARD_ALERTS",
        writtenAt: new Date(this.now).toISOString(),
        symbolsTracked: tracked,
        symbolsHealthy: tracked - this.emitterFailedLanes,
        symbolsFailed: this.emitterFailedLanes,
        queueDepth: this.emitterQueue.depth,
        queueCapacity: this.emitterQueue.capacity,
        maxQueueDepth: this.emitterQueue.max,
        catchUp: { rounds: 1, recordsAdmitted: 10, backlogLanes: this.emitterQueue.backlogLanes },
        created: 4,
        ledgerDuplicates: 0,
        membership: { dynamic: true, recordsAbsorbed: 0, failure: null },
        initialization: initializing ? { complete: false, lanesBaselined: Math.floor(tracked / 3), lanesTotal: tracked } : { complete: true, lanesBaselined: tracked, lanesTotal: tracked },
      })
    );
  }

  // ---- adapters ----
  adapters(over: Partial<AlwaysOnAdapters> = {}, selfPid = SUPERVISOR_PID): AlwaysOnAdapters {
    const files = this.files;
    return {
      now: () => this.now,
      selfPid,
      selfStartedAtMs: this.now,
      env: DIRTY_ENV,
      paths: this.paths,
      observeTree: () => {
        if (!this.observable) return unobserved("COMMAND_FAILED");
        this.autopilot();
        return observed([...this.nodes.values()]);
      },
      probe: (pid) => {
        if (!this.observable) return { observed: false };
        const node = this.nodes.get(pid);
        return { observed: true, process: node === undefined ? null : { pid: node.pid, commandLine: node.commandLine, startedAtMs: node.startedAtMs } };
      },
      spawn: (plan) => this.spawnChild(plan),
      terminate: (pid) => {
        this.terminated.push(pid);
        this.kill(pid);
        return true;
      },
      exitCodeOf: () => null,
      fs: {
        // The lenient evidence read: a file that cannot be read is null, exactly like the real adapter.
        readText: (file) => (this.failRead?.(file) ? null : (files.get(file) ?? null)),
        readTextStrict: (file) => {
          if (this.failRead?.(file)) throw fsError("EBUSY", "read", file);
          return files.get(file) ?? null;
        },
        writeTextAtomic: (file, text) => {
          if (this.failWrite?.(file)) throw fsError("EPERM", "rename", file);
          this.fsWrites.push(file);
          files.set(file, text);
        },
        appendLine: (file, line) => files.set(file, (files.get(file) ?? "") + line),
        exists: (file) => files.has(file),
        remove: (file) => {
          if (this.failRemove?.(file)) throw fsError("EPERM", "unlink", file);
          files.delete(file);
        },
        ensureDir: () => undefined,
        listDir: (dir) => [...files.keys()].filter((k) => path.dirname(k) === dir).map((k) => path.basename(k)),
      },
      http: {
        getJson: async (url) => {
          this.httpCalls.push(url);
          const backendUp = this.backendAnswers && (this.live("backend").length > 0 || this.externalBackend);
          if (!backendUp) return { ok: false, status: null, body: null };
          if (url.endsWith("/health")) return { ok: true, status: 200, body: { status: "ok" } };
          if (url.endsWith("/api/native-planner/status")) {
            const plannerUp = this.live("planner").length > 0;
            return { ok: true, status: 200, body: plannerUp ? plannerStatusBody(this.plannerOver) : plannerStatusBody({ state: "OFF", consumers: 0, readiness: "DOWN" }) };
          }
          if (url.endsWith("/api/signal-quality/soak-health")) {
            return this.soakStatus === 200 ? { ok: true, status: 200, body: { plans: this.plans } } : { ok: false, status: this.soakStatus, body: null };
          }
          return { ok: false, status: 404, body: null };
        },
      },
      // A drill fault reaches the probe as its transport would: REST refused → unreachable; streams refused → UNREACHABLE,
      // silent → UNKNOWN (exactly what the real probes answer over the drilled transports; see always-on-drill.test.ts).
      publicConnectivity: async (drill?: { readonly rest: string | null } | null) => {
        this.connectivityProbes += 1;
        this.connectivityDrills.push(drill ?? null);
        return drill?.rest === "REFUSED" ? false : this.network;
      },
      publicStreamConnectivity: async (drill?: { readonly stream: string | null } | null) => {
        this.streamProbes.push(this.now);
        this.streamProbeDrills.push(drill ?? null);
        if (drill?.stream === "REFUSED") return "UNREACHABLE";
        if (drill?.stream === "SILENT") return "UNKNOWN";
        const outcome = this.streamOutcome;
        if (outcome === "THROWS") throw new Error("the stream probe could not run");
        return outcome;
      },
      verifyPrivateDirectories: (dirs: readonly string[]) => {
        this.aclChecks.push(dirs);
        return this.privateDirectories;
      },
      buildVerdict: () => this.build,
      genericEnvKeyNames: () => ({ ok: true, keys: ["DATABASE_URL", "REDIS_URL", "BINANCE_FUTURES_REST_BASE_URL"] }),
      mutation: async <T>(action: MutationAction, run: () => Promise<T>): Promise<WithAuthorityResult<T>> => {
        if (this.lockBusy) return { ran: false, outcome: "BUSY", reasons: ["another launcher holds mutation authority"] };
        this.mutations.push(action);
        return { ran: true, result: await run() };
      },
      log: () => undefined,
      ...over,
    };
  }

  externalBackend = false;

  incidents(): { kind: string; role: string | null; reasonCode: string | null; detail: string | null; generation: number }[] {
    return (this.files.get(this.paths.incidents) ?? "")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { kind: string; role: string | null; reasonCode: string | null; detail: string | null; generation: number });
  }

  kinds(): string[] {
    return this.incidents().map((i) => i.kind);
  }
}

/** An error shaped like Node's own fs errors on Windows. */
export function fsError(code: string, syscall: string, file: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: operation not permitted, ${syscall} '${file}'`);
  error.code = code;
  error.syscall = syscall;
  error.path = file;
  return error;
}

export function testConfig(over: Partial<AlwaysOnConfig> = {}, policy: Partial<AlwaysOnPolicy> = {}): AlwaysOnConfig {
  return {
    repoRoot: REPO,
    profileName: PROFILE,
    engineFingerprint: ENGINE,
    roles: ["backend", "scanner", "emitter", "planner"],
    backendUrl: "http://127.0.0.1:4000",
    emitterQueueCapacity: 10_000,
    emitterActivateAtEof: false,
    scannerExtraArgs: [],
    policy: { ...ALWAYS_ON_DEFAULTS, ...policy },
    commandIdentity: "monitoring:always-on run (test)",
    instancePort: 4019,
    ...over,
  };
}

export async function startSupervisor(m: FakeMachine, config: AlwaysOnConfig = testConfig(), adapters: Partial<AlwaysOnAdapters> = {}, selfPid = SUPERVISOR_PID) {
  const supervisor = new AlwaysOnSupervisor(config, m.adapters(adapters, selfPid));
  const started = await supervisor.start({ strippedCredentialNames: [] });
  return { supervisor, started };
}

/** Ticks `count` times, advancing the clock by `stepMs` after each. */
export async function run(m: FakeMachine, supervisor: AlwaysOnSupervisor, count: number, stepMs = 15_000) {
  const outcomes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    outcomes.push(await supervisor.tick());
    m.now += stepMs;
  }
  return outcomes;
}

/** Ticks until the predicate holds (bounded), advancing the clock by `stepMs` after each tick. */
export async function until(m: FakeMachine, supervisor: AlwaysOnSupervisor, predicate: () => boolean, max = 400, stepMs = 15_000) {
  for (let i = 0; i < max; i += 1) {
    if (predicate()) return i;
    await supervisor.tick();
    m.now += stepMs;
  }
  throw new Error("condition not reached");
}
