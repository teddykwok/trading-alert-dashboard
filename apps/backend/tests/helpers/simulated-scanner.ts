import type { NativeKline } from "@trading-alert-dashboard/shared";

import { EXCHANGE_INFO_PATH, buildPublicFuturesUrl } from "../../src/modules/native-scanner/binance-public-futures";
import { GovernedPublicTransport } from "../../src/modules/native-scanner/candidate-rank-runner";
import { KlineCacheStore } from "../../src/modules/native-scanner/kline-cache";
import { BinanceServerClock, PublicRequestController, REQUEST_POLICY_LIMITS } from "../../src/modules/native-scanner/kline-fetcher";
import { LiveShadowSupervisor, NATIVE_RECOVERY_POLICY_VERSION, type SupervisorStatus } from "../../src/modules/native-scanner/live-shadow-supervisor";
import { FAST_RECOVERY_DEFAULTS, parseSupervisorCliArgs, type SupervisorCliOptions } from "../../src/modules/native-scanner/live-shadow-supervisor-cli-args";
import { acquireLiveShadowLock } from "../../src/modules/native-scanner/scanner-lock";
import {
  DEFAULT_UNIVERSE_REFRESH_MS,
  TEDDY_7_ALL_ACTIVE_V1,
  dashboardTimeframes,
  engineTimeframes,
  futureExecutionTimeframes,
  isAllActiveUniverse,
  isDynamicUniverse,
  lineageConfigOf,
  profileSummaryOf,
  type ScannerProfile,
} from "../../src/modules/native-scanner/scanner-profile";
import { runManifestText } from "../../src/modules/native-scanner/supervisor-run-manifest";
import { supervisorLiveDirFor, supervisorRunManifestOf, supervisorSelectionOf } from "../../src/modules/native-scanner/supervisor-run-plan";
import { parseExchangeInfoContracts, selectUsdtPerpetualUniverse, type UniverseSymbolTrust } from "../../src/modules/native-scanner/usdm-universe";
import { syntheticBars } from "./native-recovery-harness";
import type { SimulatedMarket, SimulatedPublicNetwork } from "./simulated-public-network";

/**
 * A REAL live-shadow scanner (LiveShadowSupervisor) wired exactly as the CLI
 * entrypoint wires it — the production option values from the CLI's own
 * parser, FAST_RECOVERY_V1, the dynamic universe, the governed REST budget,
 * real symbol locks fenced by the holder's process identity, the CLI's status
 * document — but with the SIMULATED public network as its only transport and a
 * simulated clock whose timers the test advances. Test-only.
 *
 * Deviations from the CLI, each deliberate: the engine runs the production
 * profile on 1D over a short timeline (NETWORK_FIX, as the fast-recovery suite
 * does) so a start-up replays days, not months; `symbolsPerConnection` can be
 * lowered so a handful of symbols spans several connections; the 1 s tick and
 * the status cadence are driven by the test instead of timers.
 */

export const M15 = 15 * 60_000;
export const D = (d: number, h = 0, m = 0, s = 0) => Date.UTC(2025, 0, d, h, m, s);

/** The production engine (7%, 1%, 5/4/10, dynamic lifecycle, symbol origin, DYNAMIC_UNIVERSE_V1) on 1D over a short timeline. */
export const NETWORK_FIX: ScannerProfile = {
  ...TEDDY_7_ALL_ACTIVE_V1,
  engine: { ...TEDDY_7_ALL_ACTIVE_V1.engine, historyStart: "2025-01-06T00:00:00Z", switchover: "2025-01-10T12:00:00Z", engineSourceTimeframes: engineTimeframes("1D") },
  delivery: { ...TEDDY_7_ALL_ACTIVE_V1.delivery, dashboardSourceTimeframes: dashboardTimeframes("1D") },
  execution: { ...TEDDY_7_ALL_ACTIVE_V1.execution, futureExecutionSourceTimeframes: futureExecutionTimeframes("1D") },
} as ScannerProfile;

/** Simulations start 30 s into a bar, two days after the switchover. */
export const SIM_T0 = D(12, 0, 0, 30);
export const SIM_SYMBOLS = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT", "龙虾USDT"];

/** A deterministic market for SIM_SYMBOLS: listed before the context, bars well past any simulated horizon. */
export function simulatedMarket(symbols: readonly string[] = SIM_SYMBOLS): SimulatedMarket & { listed: string[] } {
  const horizon = (SIM_T0 - D(6)) / M15 + 4 * 96;
  const series = new Map<string, NativeKline[]>(symbols.map((s, i) => [s, syntheticBars(31 + 7 * i, D(6), horizon, 1 + i * 3.5)]));
  const listed = [...symbols];
  return { listed, symbols: () => listed, bars: (s) => series.get(s) ?? [], onboardDateMs: () => D(5) };
}

/**
 * Simulated time. `sleep` (the governed transport's spacing, the fetcher's retry backoff) registers a timer instead
 * of moving the clock; `advanceTo` walks time forward, waking each due timer at its own instant and letting the work
 * it releases run before the next — so a REST backoff never skips the network turns in between.
 */
export class SimulatedClock {
  private readonly timers: { atMs: number; seq: number; resolve: () => void }[] = [];
  private seq = 0;

  constructor(
    private readonly get: () => number,
    private readonly set: (ms: number) => void
  ) {}

  static at(startMs: number): SimulatedClock {
    let now = startMs;
    return new SimulatedClock(
      () => now,
      (ms) => {
        now = ms;
      }
    );
  }

  readonly nowMs = (): number => this.get();

  readonly sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      this.timers.push({ atMs: this.get() + Math.max(0, ms), seq: this.seq++, resolve });
    });

  get pendingTimers(): number {
    return this.timers.length;
  }

  async advanceTo(targetMs: number, settle: () => Promise<void>): Promise<void> {
    for (let wakes = 0; ; wakes += 1) {
      if (wakes > 100_000) throw new Error("simulated clock: timers keep re-arming at the same instant");
      this.timers.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
      const next = this.timers[0];
      if (next === undefined || next.atMs > targetMs) break;
      if (next.atMs > this.get()) this.set(next.atMs);
      const now = this.get();
      const due = this.timers.filter((t) => t.atMs <= now);
      this.timers.splice(0, due.length);
      for (const t of due) t.resolve();
      await settle();
    }
    if (targetMs > this.get()) this.set(targetMs);
  }
}

/** The production options exactly as the CLI parses them for the live profile. */
export function productionScannerOptions(): SupervisorCliOptions {
  return parseSupervisorCliArgs(["--profile", "teddy-7-all-active"]);
}

export interface SimulatedScannerInput {
  readonly net: SimulatedPublicNetwork;
  readonly clock: SimulatedClock;
  readonly root: string;
  readonly cacheDir: string;
  readonly runId: string;
  /** The process identity its symbol locks carry, and how the lock fence probes another holder. */
  readonly pid: number;
  readonly processStartedAtMs: number;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly processCreatedAtMs: (pid: number) => number | null;
  readonly symbolsPerConnection?: number;
}

export class SimulatedScanner {
  readonly logs: string[] = [];
  readonly options = productionScannerOptions();
  readonly profile = NETWORK_FIX;
  governor: GovernedPublicTransport | null = null;
  supervisor: LiveShadowSupervisor | null = null;
  /** Set when start-up completed: the run manifest text the CLI writes (wx) after start-up. */
  manifestText: string | null = null;
  startError: unknown = null;
  state: "STARTING" | "RUNNING" | "FAILED" | "STOPPED" = "STARTING";
  private readonly scheduled: Array<() => void> = [];
  private readonly inFlight = new Set<Promise<unknown>>();

  private constructor(readonly input: SimulatedScannerInput) {}

  /**
   * Like starting the CLI process: returns at once while it reads the universe through the governed transport,
   * builds the supervisor and runs its FAST_RECOVERY_V1 start-up in the background (`state` says where it is). A
   * universe read or start-up that fails leaves it FAILED, as the CLI then exits with an error.
   */
  static launch(input: SimulatedScannerInput): SimulatedScanner {
    const scanner = new SimulatedScanner(input);
    scanner.track(
      scanner.boot().then(
        () => {
          if (scanner.state === "STARTING") scanner.state = "RUNNING";
        },
        (error: unknown) => {
          scanner.startError = error;
          if (scanner.state === "STARTING") scanner.state = "FAILED";
        }
      )
    );
    return scanner;
  }

  private async boot(): Promise<void> {
    const { options, profile } = this;
    const { clock, net, root, runId } = this.input;
    const governor = new GovernedPublicTransport(net.rest, {
      maxTotalRequests: options.maxTotalRequests,
      minSpacingMs: options.minSpacingMs,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
      maxInFlight: options.maxInFlight,
      weightBudget: { maxWeightPerMinute: options.maxWeightPerMinute as number, usedWeightHighWater: FAST_RECOVERY_DEFAULTS.usedWeightHighWater },
    });
    this.governor = governor;
    const fetchDeps = {
      transport: governor.transport,
      baseUrl: "https://fapi.binance.com",
      policy: { maxRequests: REQUEST_POLICY_LIMITS.maxRequestsCeiling, minSpacingMs: options.minSpacingMs, maxTransientRetries: 2, transientBackoffMs: Math.max(2_000, options.minSpacingMs) },
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    };
    const trust: UniverseSymbolTrust = isAllActiveUniverse(profile.universe) ? (profile.universe.symbolTrust ?? "ASCII") : "ASCII";
    const fetchUniverse = async () =>
      selectUsdtPerpetualUniverse(parseExchangeInfoContracts(await new PublicRequestController(fetchDeps).getJson(buildPublicFuturesUrl(fetchDeps.baseUrl, EXCHANGE_INFO_PATH))), trust);
    const universe = await fetchUniverse();
    if (this.state !== "STARTING") return;
    const summary = profileSummaryOf(profile);
    const supervisor = new LiveShadowSupervisor(
      {
        lineage: lineageConfigOf(profile.engine),
        selection: supervisorSelectionOf(universe, options.selection),
        universeActive: universe.contracts.length,
        symbolsPerConnection: this.input.symbolsPerConnection ?? options.symbolsPerConnection,
        maxConnections: options.maxConnections,
        restConcurrency: options.restConcurrency,
        queueCapacity: options.queueCapacity,
        maxProcessingLagMs: options.maxProcessingLagMs,
        staleSymbolMs: options.staleSymbolMs,
        maxRecoveryAttempts: options.maxRecoveryAttempts,
        liveDirFor: supervisorLiveDirFor(root, summary, "15m"),
        runId,
        profile: summary,
        dynamicUniverse: isDynamicUniverse(profile.universe) ? { refreshIntervalMs: profile.operations?.universeRefreshMs ?? DEFAULT_UNIVERSE_REFRESH_MS } : null,
      },
      {
        openStream: net.openStream,
        governor,
        fetchDeps,
        cache: new KlineCacheStore(this.input.cacheDir),
        acquireLock: (dir) =>
          acquireLiveShadowLock(dir, {
            pid: this.input.pid,
            owner: "scanner:live-shadow-supervisor",
            startedAt: new Date(this.input.processStartedAtMs).toISOString(),
            isProcessAlive: this.input.isProcessAlive,
            processCreatedAtMs: this.input.processCreatedAtMs,
          }),
        nowMs: clock.nowMs,
        nowIso: () => new Date(clock.nowMs()).toISOString(),
        schedule: (fn) => this.scheduled.push(fn),
        log: (line) => this.logs.push(`[${new Date(clock.nowMs()).toISOString()}] ${line}`),
        fetchUniverse,
        recordMembership: () => undefined,
        recoveryFetch: { version: NATIVE_RECOVERY_POLICY_VERSION, serverClock: new BinanceServerClock(fetchDeps, FAST_RECOVERY_DEFAULTS.serverClockMaxAgeMs), sizePagesToRange: true },
      }
    );
    this.supervisor = supervisor;
    await supervisor.start();
    if (this.state !== "STARTING") return;
    this.manifestText = runManifestText(
      supervisorRunManifestOf({
        runId,
        startedAt: supervisor.startedAt,
        gitHead: "simulated",
        chartInterval: "15m",
        engineFingerprint: supervisor.engineFingerprint,
        profile: summary,
        selection: supervisor.status().selection,
        symbols: supervisor.acceptedSymbols(),
        dynamicMembership: true,
      })
    );
  }

  /** One second of the CLI's loop: the supervisor's tick, then its drains and REST settle. */
  async step(): Promise<void> {
    if (this.state === "RUNNING" && this.supervisor !== null) for (const p of this.supervisor.tick()) this.track(p);
    await this.settle();
  }

  /**
   * Runs scheduled drains and lets in-flight work proceed until it is blocked: on a simulated timer, on a request
   * the network holds, or done. One event-loop turn completes any pure promise chain.
   */
  async settle(maxTurns = 40): Promise<void> {
    let quiet = 0;
    for (let i = 0; i < maxTurns && quiet < 2; i += 1) {
      const before = this.inFlight.size;
      const drained = this.scheduled.length > 0;
      while (this.scheduled.length > 0) (this.scheduled.shift() as () => void)();
      await new Promise<void>((resolve) => setImmediate(resolve));
      quiet = !drained && this.scheduled.length === 0 && this.inFlight.size === before ? quiet + 1 : 0;
      if (this.inFlight.size === 0 && this.scheduled.length === 0) return;
    }
  }

  status(): SupervisorStatus {
    if (this.supervisor === null) throw new Error("the scanner has not built its supervisor yet");
    return this.supervisor.status();
  }

  /** Exactly the document the CLI writes to status.json. */
  statusDocument(pid: number = this.input.pid): string {
    return `${JSON.stringify({ ...this.status(), gitHead: "simulated", pid, writtenAt: new Date(this.input.clock.nowMs()).toISOString() }, null, 2)}\n`;
  }

  /** The CLI's graceful stop (Ctrl+C or the cooperative stop file): nothing more lands, locks are released. */
  stop(): void {
    if (this.state === "STOPPED") return;
    this.state = "STOPPED";
    this.supervisor?.stop();
  }

  get pendingWork(): number {
    return this.inFlight.size;
  }

  private track(p: Promise<unknown>): void {
    const tracked: Promise<unknown> = p.catch(() => undefined).finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }
}

/** Drives one scanner for `ms` of simulated time in 1 s steps: timers wake on time, then a network turn, then the CLI's tick. */
export async function runScannerFor(clock: SimulatedClock, net: SimulatedPublicNetwork, scanner: SimulatedScanner, ms: number, each?: () => void): Promise<void> {
  const end = clock.nowMs() + ms;
  while (clock.nowMs() < end) {
    await clock.advanceTo(Math.min(end, clock.nowMs() + 1_000), () => scanner.settle());
    net.pump();
    await scanner.step();
    each?.();
  }
}
