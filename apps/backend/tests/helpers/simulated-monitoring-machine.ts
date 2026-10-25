import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { AlwaysOnTickOutcome } from "../../src/modules/always-on/always-on-supervisor";
import { drilledProbeFetch, drilledProbeOpen, type DrillProbeFaults } from "../../src/modules/always-on/always-on-drill";
import { publicBinanceReachable, publicStreamReachable, type PublicStreamProbeOutcome } from "../../src/modules/always-on/always-on-machine";
import { scannerRunManifest } from "../../src/modules/always-on/always-on-paths";
import type { MonitoringSpawnPlan } from "../../src/modules/always-on/always-on-roles";
import type { PublicHttpTransport } from "../../src/modules/native-scanner/kline-fetcher";
import type { OpenPublicStream } from "../../src/modules/native-scanner/live-shadow-runner";
import { PublicTransportDrillGate, drillFileOf, drilledOpenStream, drilledPublicTransport, parsePublicTransportDrill } from "../../src/modules/native-scanner/public-transport-drill";
import { LIVE_SHADOW_LOCK_FILE } from "../../src/modules/native-scanner/scanner-lock";
import { engineFingerprintOf } from "../../src/modules/native-scanner/scanner-profile";
import { ALWAYS_ON_DEFAULTS } from "../../src/modules/always-on/always-on-contract";
import { FakeMachine, HEALTHY_UNIVERSE, startSupervisor, testConfig } from "./always-on-fake-machine";
import { SimulatedPublicNetwork, immediateProbeTimers, type ProbeListener, type ProbeSocketLike } from "./simulated-public-network";

/**
 * A probe socket answered by something that is not Binance (a middlebox completing the handshake): it opens and
 * delivers only an unreadable message, whatever the outage — an indeterminate answer. It still checks the URL.
 */
function indeterminateSocket(net: SimulatedPublicNetwork, url: string): ProbeSocketLike {
  net.openProbeSocket(url).close(); // the production URL check, and a probe record
  const listeners = new Map<string, Set<ProbeListener>>();
  let closed = false;
  queueMicrotask(() => {
    for (const [type, event] of [
      ["open", {}],
      ["message", { data: "{not json" }],
    ] as const) {
      if (closed) return;
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    }
  });
  return {
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set<ProbeListener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    close: () => {
      closed = true;
    },
  };
}
import { FIXTURE_TIMELINE, SIM_SYMBOLS, SimulatedClock, SimulatedScanner, simulatedMarket, type SimulatedTimeline } from "./simulated-scanner";

/**
 * THE ALWAYS-ON SUPERVISOR OVER A SIMULATED PUBLIC NETWORK — test-only.
 *
 * The real AlwaysOnSupervisor, with production policy, runs on the fake
 * machine (process table, file system, local backend and planner answers, an
 * autopilot emitter that publishes status for the run it was pinned to). What
 * is NOT faked is everything a network outage touches:
 *
 *   - every scanner child the supervisor spawns is a REAL scanner process
 *     (SimulatedScanner: LiveShadowSupervisor with the production CLI options,
 *     real symbol locks under a real temp root, fenced by the child's pid and
 *     creation time), and its status.json and run manifest are what that
 *     scanner wrote — on the CLI's cadence (first status one interval after
 *     start-up);
 *   - the connectivity probe is the REAL publicBinanceReachable;
 *   - an operator drill (always-on-drill.ts) reaches these processes exactly as in production: each scanner spawned
 *     with a stop file runs the REAL drill gate (polled every second, reading the drill file the real supervisor
 *     wrote) around its process-local transports, and both probes run over the REAL drilled probe transports;
 *   - both go through ONE SimulatedPublicNetwork, so an outage refuses or holds
 *     their requests and drops, silences or refuses their streams.
 *
 * Process semantics: a cooperative stop file runs the CLI's graceful stop
 * (locks released, final status written) and the process exits; a fenced
 * terminate kills it outright — its network access, sockets and timers end
 * with it and its locks stay on disk, exactly as after taskkill /F. Time is
 * one simulated clock: 1 s scanner ticks, Always-On ticks paced by its own
 * nextDelayMs(), timers woken at their instants.
 */

export interface ScannerProcess {
  readonly root: number;
  readonly runtime: number;
  readonly runId: string;
  readonly stopFile: string | null;
  readonly scanner: SimulatedScanner;
  readonly spawnedAtMs: number;
  exit: "RUNNING" | "STOPPED" | "KILLED" | "CRASHED";
  exitedAtMs: number | null;
  runningSinceMs: number | null;
  lastStatusMs: number | null;
  manifestWritten: boolean;
  /** Sockets this process opened (closed silently when it is killed). */
  readonly socketIds: number[];
  /** The process's operator-drill gate (null: no stop file, so no drill can ever apply — as in production). */
  readonly gate: PublicTransportDrillGate | null;
}

export interface TickRecord {
  readonly atMs: number;
  readonly outcome: AlwaysOnTickOutcome;
  readonly state: string;
  readonly reasonCode: string;
  readonly roles: Readonly<Record<string, string>>;
}

export interface SimulatedMonitoringOptions {
  /** Default 3, so a handful of symbols spans several connections. */
  readonly symbolsPerConnection?: number;
  /** Default FIXTURE_TIMELINE (the production engine on 1D, short timeline). */
  readonly timeline?: SimulatedTimeline;
  readonly symbols?: readonly string[];
}

export class SimulatedMonitoringMachine {
  readonly m = new FakeMachine();
  readonly clock: SimulatedClock;
  readonly timeline: SimulatedTimeline;
  readonly symbols: readonly string[];
  readonly symbolsPerConnection: number;
  readonly engineFingerprint: string;
  readonly market: ReturnType<typeof simulatedMarket>;
  readonly net: SimulatedPublicNetwork;
  readonly processes: ScannerProcess[] = [];
  readonly ticks: TickRecord[] = [];
  readonly violations: string[] = [];
  readonly spawnPlans: MonitoringSpawnPlan[] = [];
  /** A scanner that ignores its stop file (hung): only the fenced terminate ends it. */
  scannersIgnoreStop = false;
  /**
   * A scanner-LOCAL stream failure for the runs it selects: their stream connections are refused inside the process
   * (a scanner fault), while the public network — and the supervisor's own stream probe — are fine.
   */
  scannerStreamsBroken: (runId: string) => boolean = () => false;
  /**
   * The supervisor's stream probe: the REAL publicStreamReachable over the simulated network, or the same probe whose
   * socket cannot be constructed (THROWS) or answers with something it cannot read (INDETERMINATE).
   */
  streamProbeMode: "REAL" | "THROWS" | "INDETERMINATE" = "REAL";
  supervisor!: Awaited<ReturnType<typeof startSupervisor>>["supervisor"];
  private nextTickAtMs = 0;
  private stopped = false;
  private readonly orphanDrillSince = new Map<string, number>();

  constructor(
    readonly root: string,
    readonly cacheDir: string,
    options: SimulatedMonitoringOptions = {}
  ) {
    this.timeline = options.timeline ?? FIXTURE_TIMELINE;
    this.symbols = options.symbols ?? SIM_SYMBOLS;
    this.symbolsPerConnection = options.symbolsPerConnection ?? 3;
    this.engineFingerprint = engineFingerprintOf(this.timeline.profile);
    this.market = simulatedMarket(this.symbols, this.timeline);
    this.m.now = this.timeline.t0;
    this.clock = new SimulatedClock(
      () => this.m.now,
      (ms) => {
        this.m.now = ms;
      }
    );
    this.net = new SimulatedPublicNetwork(this.clock.nowMs, this.market);
    this.m.scannerBehaviour = "silent"; // the scanner's status comes from the real scanner, never the autopilot
    this.m.scannerUniverse = { ...HEALTHY_UNIVERSE, selected: this.symbols.length, liveEligible: this.symbols.length, exchangeCandidates: this.symbols.length };
    this.m.emitterTracked = this.symbols.length;
  }

  async start(): Promise<void> {
    const { supervisor, started } = await startSupervisor(this.m, testConfig({ engineFingerprint: this.engineFingerprint }), {
      publicConnectivity: (drill: DrillProbeFaults | null) => publicBinanceReachable(5_000, drilledProbeFetch(this.net.fetch, drill)),
      publicStreamConnectivity: (drill: DrillProbeFaults | null) => this.probeStream(drill),
      spawn: (plan) => {
        this.spawnPlans.push(plan);
        return (this.m.adapters().spawn as (p: MonitoringSpawnPlan) => number | null)(plan);
      },
    });
    if (!started.ok) throw new Error(`Always-On refused to start: ${JSON.stringify(started)}`);
    this.supervisor = supervisor;
    this.nextTickAtMs = this.m.now;
  }

  /** The real stream probe over the simulated network (through the real drilled opener), or one of its uncertain variants. */
  probeStream(drill: DrillProbeFaults | null = null): Promise<PublicStreamProbeOutcome> {
    if (this.streamProbeMode === "THROWS") {
      return publicStreamReachable({
        open: () => {
          throw new Error("cannot construct a WebSocket");
        },
        timers: immediateProbeTimers,
      });
    }
    if (this.streamProbeMode === "INDETERMINATE") {
      return publicStreamReachable({ open: (url) => indeterminateSocket(this.net, url), timers: immediateProbeTimers });
    }
    return publicStreamReachable({ open: drilledProbeOpen(this.net.openProbeSocket, drill), timers: immediateProbeTimers });
  }

  /** Runs the whole machine for `ms` of simulated time. */
  async runFor(ms: number): Promise<void> {
    await this.runUntil(() => false, ms);
  }

  /** Runs until `predicate` holds (checked every simulated second) or `maxMs` elapses; returns whether it held. */
  async runUntil(predicate: () => boolean, maxMs: number): Promise<boolean> {
    const end = this.m.now + maxMs;
    while (this.m.now < end) {
      if (predicate()) return true;
      await this.step();
    }
    return predicate();
  }

  /** One simulated second: timers, a network turn, the scanner processes, then Always-On when its delay has passed. */
  async step(): Promise<void> {
    await this.clock.advanceTo(this.m.now + 1_000, () => this.settleAll());
    this.net.pump();
    await this.superviseProcesses();
    if (!this.stopped && this.m.now >= this.nextTickAtMs) {
      const outcome = await this.supervisor.tick();
      const s = this.supervisor.status();
      this.ticks.push({ atMs: this.m.now, outcome, state: s.state, reasonCode: s.reasonCode, roles: Object.fromEntries(Object.entries(s.roles).map(([k, v]) => [k, `${v.state}/${v.reasonCode}`])) });
      if (outcome === "STOPPED") this.stopped = true;
      this.nextTickAtMs = this.m.now + this.supervisor.nextDelayMs();
    }
    this.checkInvariants();
  }

  /** The graceful stop an operator requests: everything owned stops, in order, through the real supervisor. */
  async shutdown(maxMs = 15 * 60_000): Promise<boolean> {
    if (this.stopped) return true;
    this.supervisor.requestShutdown("OPERATOR_STOP_REQUEST");
    return this.runUntil(() => this.stopped, maxMs);
  }

  get supervisorStopped(): boolean {
    return this.stopped;
  }

  /** The live scanner process (started, not exited), if any. */
  liveScanner(): ScannerProcess | null {
    return this.processes.find((p) => p.exit === "RUNNING") ?? null;
  }

  /** Every live-shadow lock under the root: its holder pid. */
  lockHolders(): number[] {
    const holders: number[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === LIVE_SHADOW_LOCK_FILE) holders.push((JSON.parse(readFileSync(full, "utf8")) as { pid: number }).pid);
      }
    };
    walk(this.root);
    return holders;
  }

  // ---------------------------------------------------------------------------

  private async settleAll(): Promise<void> {
    for (const p of this.processes) if (p.exit === "RUNNING") await p.scanner.settle();
  }

  private async superviseProcesses(): Promise<void> {
    const m = this.m;
    for (const child of m.spawns) {
      if (child.role !== "scanner" || this.processes.some((p) => p.root === child.root)) continue;
      if (!m.alive(child)) continue;
      this.processes.push(this.launch(child.root, child.runtime, child.runId as string, child.stopFile));
    }
    for (const p of this.processes) {
      if (p.exit !== "RUNNING") continue;
      const alive = m.nodes.has(p.root);
      if (!alive) {
        // Terminated (taskkill /F): no graceful stop, nothing more runs, its locks stay on disk.
        this.kill(p, "KILLED");
        continue;
      }
      if (p.stopFile !== null && m.files.has(p.stopFile) && !this.scannersIgnoreStop) {
        // The cooperative stop: exactly the CLI's graceful stop, then the process exits.
        p.scanner.stop();
        if (p.scanner.supervisor !== null) m.files.set(m.paths.scannerStatus, p.scanner.statusDocument(p.runtime, this.drillReport(p)));
        p.exit = "STOPPED";
        p.exitedAtMs = m.now;
        m.kill(p.root);
        continue;
      }
      if (p.scanner.state === "FAILED") {
        this.kill(p, "CRASHED");
        m.kill(p.root);
        continue;
      }
      // The CLI's once-a-second drill poll, then its tick.
      p.gate?.poll();
      await p.scanner.step();
      if (p.scanner.state === "RUNNING") {
        p.runningSinceMs ??= m.now;
        if (!p.manifestWritten && p.scanner.manifestText !== null) {
          m.files.set(scannerRunManifest(m.paths, p.runId), p.scanner.manifestText);
          p.manifestWritten = true;
        }
        const every = p.scanner.options.statusEverySeconds * 1_000;
        if (m.now - (p.lastStatusMs ?? p.runningSinceMs) >= every) {
          m.files.set(m.paths.scannerStatus, p.scanner.statusDocument(p.runtime, this.drillReport(p)));
          p.lastStatusMs = m.now;
        }
      }
    }
  }

  /** What the CLI adds to its status: the drill observation, once this process has seen a drill. */
  private drillReport(p: ScannerProcess): Record<string, unknown> {
    const drill = p.gate?.observation() ?? null;
    return drill === null ? {} : { drill };
  }

  private launch(root: number, runtime: number, runId: string, stopFile: string | null): ScannerProcess {
    const m = this.m;
    const net = this.net;
    const socketIds: number[] = [];
    const holder: { process: ScannerProcess | null } = { process: null };
    const alive = () => holder.process?.exit === "RUNNING";
    // The process's own view of the network: it ends when the process does.
    const rest: PublicHttpTransport = (url, init) => (alive() ? net.rest(url, init) : Promise.reject(new Error("the process has exited")));
    const openStream: OpenPublicStream = (url, handlers) => {
      if (!alive()) throw new Error("the process has exited");
      if (this.scannerStreamsBroken(runId)) {
        // A scanner-local fault: the connection fails inside the process; the public network never sees it.
        let closed = false;
        queueMicrotask(() => {
          if (closed || !alive()) return;
          handlers.onError("local stream failure");
          handlers.onClose("code 1006");
        });
        return {
          close: () => {
            closed = true;
          },
        };
      }
      const connection = net.openStream(url, {
        onOpen: () => alive() && handlers.onOpen(),
        onMessage: (text) => alive() && handlers.onMessage(text),
        onError: (reason) => alive() && handlers.onError(reason),
        onClose: (reason) => alive() && handlers.onClose(reason),
      });
      socketIds.push(net.sockets[net.sockets.length - 1].id);
      return connection;
    };
    // Exactly as the CLI: a gate only for a run spawned with a stop file, wrapping the process's own transports.
    const gate =
      stopFile === null
        ? null
        : new PublicTransportDrillGate({ file: drillFileOf(stopFile), runId, readText: (f) => m.files.get(f) ?? null, nowMs: this.clock.nowMs, monoMs: this.clock.nowMs, log: () => undefined });
    const drilled = gate === null ? null : drilledOpenStream(openStream, gate, (fn) => queueMicrotask(() => alive() && fn()));
    const processNet = Object.assign(Object.create(net) as SimulatedPublicNetwork, {
      rest: gate === null ? rest : drilledPublicTransport(rest, gate),
      openStream: drilled?.openStream ?? openStream,
    });
    const processClock = new SimulatedClock(this.clock.nowMs, () => undefined);
    // Timers of an exited process never fire.
    const sleep = (ms: number) => (alive() ? this.clock.sleep(ms) : new Promise<void>(() => undefined));
    Object.assign(processClock, { sleep, advanceTo: this.clock.advanceTo.bind(this.clock) });
    const startedAtMs = m.nodes.get(runtime)?.startedAtMs ?? m.now;
    const scanner = SimulatedScanner.launch({
      net: processNet,
      clock: processClock,
      root: this.root,
      cacheDir: this.cacheDir,
      runId,
      pid: runtime,
      processStartedAtMs: startedAtMs,
      isProcessAlive: (pid) => m.nodes.has(pid),
      processCreatedAtMs: (pid) => m.nodes.get(pid)?.startedAtMs ?? null,
      symbolsPerConnection: this.symbolsPerConnection,
      profile: this.timeline.profile,
    });
    const process: ScannerProcess = { root, runtime, runId, stopFile, scanner, spawnedAtMs: m.now, exit: "RUNNING", exitedAtMs: null, runningSinceMs: null, lastStatusMs: null, manifestWritten: false, socketIds, gate };
    holder.process = process;
    return process;
  }

  private kill(p: ScannerProcess, exit: "KILLED" | "CRASHED"): void {
    p.exit = exit;
    p.exitedAtMs = this.m.now;
    for (const id of p.socketIds) {
      const socket = this.net.sockets.find((s) => s.id === id);
      if (socket !== undefined && socket.state !== "CLOSED") {
        socket.state = "CLOSED";
        socket.closedAtMs = this.m.now;
        socket.closeReason = "process exited";
      }
    }
  }

  /** Breaches are recorded (never thrown mid-supervision) and asserted empty by the tests. */
  private checkInvariants(): void {
    const at = new Date(this.m.now).toISOString();
    const running = this.processes.filter((p) => p.exit === "RUNNING");
    if (running.length > 1) this.violations.push(`${at} ${running.length} scanner processes alive at once (${running.map((p) => p.runId).join(", ")})`);
    // Every lock is held by the one live scanner, or is a stale lock of an exited process (its pid gone).
    const livePids = new Set(running.map((p) => p.runtime));
    for (const pid of new Set(this.lockHolders())) {
      if (this.m.nodes.has(pid) && !livePids.has(pid)) this.violations.push(`${at} a live process ${pid} that is not the running scanner holds symbol locks`);
    }
    if (running.length === 1) {
      const foreign = this.lockHolders().filter((pid) => pid !== running[0].runtime && this.m.nodes.has(pid));
      if (foreign.length > 0) this.violations.push(`${at} concurrent writers: locks held by ${[...new Set(foreign)].join(", ")}`);
    }
    // An emitter is only ever pinned to a run whose scanner process is still alive.
    for (const emitter of this.m.live("emitter")) {
      const pinned = emitter.pinnedRunId;
      if (pinned === null) this.violations.push(`${at} an unpinned emitter is running`);
      else if (!running.some((p) => p.runId === pinned)) this.violations.push(`${at} the emitter is pinned to ${pinned}, whose scanner is not running`);
    }
    for (const plan of this.spawnPlans) {
      if (!["backend", "scanner", "emitter", "planner"].includes(plan.role)) this.violations.push(`${at} spawned a non-monitoring role ${plan.role}`);
    }
    if (this.net.violations.length > 0) this.violations.push(...this.net.violations.splice(0).map((v) => `${at} network: ${v}`));
    // An operator drill never outlives its window: no gate active past its expiry, no drill file left more than one
    // supervision pass (at most a poll interval) after it, and only ever the drill file of a running scanner's stop file.
    for (const p of running) {
      const report = p.gate?.observation() ?? null;
      const file = p.stopFile === null ? null : drillFileOf(p.stopFile);
      const parsed = file === null ? null : parsePublicTransportDrill(this.m.files.get(file) ?? null, p.runId);
      if (report?.active && parsed?.kind === "VALID" && this.m.now >= parsed.drill.expiresAtMs) this.violations.push(`${at} drill ${report.drillId} still active past its expiry`);
    }
    for (const file of [...this.m.files.keys()].filter((f) => f.endsWith(".drill"))) {
      const owner = running.find((p) => p.stopFile !== null && drillFileOf(p.stopFile) === file);
      const parsed = owner === undefined ? null : parsePublicTransportDrill(this.m.files.get(file) ?? null, owner.runId);
      const expiresAtMs = parsed?.kind === "VALID" ? parsed.drill.expiresAtMs : null;
      if (expiresAtMs !== null && this.m.now > expiresAtMs + ALWAYS_ON_DEFAULTS.pollMs + 2_000) this.violations.push(`${at} drill file ${path.basename(file)} left past its expiry`);
      if (owner === undefined) {
        this.orphanDrillSince.set(file, this.orphanDrillSince.get(file) ?? this.m.now);
        if (this.m.now - (this.orphanDrillSince.get(file) as number) > ALWAYS_ON_DEFAULTS.pollMs + 2_000) this.violations.push(`${at} drill file ${path.basename(file)} of no running scanner`);
      } else this.orphanDrillSince.delete(file);
    }
  }
}
