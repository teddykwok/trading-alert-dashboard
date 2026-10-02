import path from "node:path";
import { SWITCHOVER_TRUNCATED_CLOSED_BARS, type NativeKline } from "@trading-alert-dashboard/shared";

import { SCANNER_MARKET_TYPE, ScannerDataError, intervalMsOf } from "./binance-public-futures";
import { GovernedPublicTransport, fillClosedBarCache, mapBounded, type KlineCacheLike } from "./candidate-rank-runner";
import { CompatReplayError } from "./compat-replay";
import { KlineCacheError, mergeClosedKlines } from "./kline-cache";
import { fetchClosedFuturesKlines, type PublicFetchDeps } from "./kline-fetcher";
import {
  LiveStreamError,
  MAX_STREAMS_PER_COMBINED_CONNECTION,
  buildPublicCombinedKlineStreamUrl,
  parseCombinedStreamEnvelope,
  parseKlineStreamPayload,
} from "./live-kline-stream";
import { LiveCheckpointStore, LiveShadowError } from "./live-shadow-checkpoint";
import type { LineageConfig } from "./live-shadow-cli-args";
import { STREAM_OPEN_TIMEOUT_MS, STREAM_READINESS_TIMEOUT_MS, STREAM_STALE_TIMEOUT_MS, type OpenPublicStream, type StreamConnection } from "./live-shadow-runner";
import { LiveShadowSession, prepareLiveShadowState } from "./live-shadow-session";
import { LiveShadowEventStore } from "./live-shadow-store";
import { REPLAY_PAGE_LIMIT, REPLAY_SETTLE_MS } from "./replay-cli-args";
import { deriveHtfContextStartMs } from "./scanner-lineage";
import { ScannerLockError, type ScannerLock } from "./scanner-lock";
import { SymbolStreamChannel } from "./symbol-stream-channel";

/**
 * MULTI-SYMBOL NATIVE LIVE-SHADOW SUPERVISOR — SHADOW ONLY.
 *
 * One process, many symbols, a few multiplexed public WebSocket connections.
 * Every symbol keeps the exact single-symbol machinery, unchanged: its own
 * LiveShadowSession (readiness, quarantine, commit, gap recovery), its own
 * checkpoint and event log under live-shadow/<market>/<symbol>/<interval>/,
 * its own lineage, and the shared SymbolStreamChannel the single-symbol
 * runner also uses. The supervisor adds only transport, scheduling and
 * isolation:
 *
 *  - symbols are assigned to connections deterministically (sorted, chunked);
 *  - a malformed message, a gap, a stale symbol or lag on ONE symbol detaches
 *    that symbol alone: it recovers its closed gap (REPLAYED_NON_ACTIONABLE)
 *    through the governed REST transport and re-arms readiness, so its current
 *    bar is quarantined; its neighbours on the connection are untouched;
 *  - a connection failure takes every symbol on it out of live eligibility at
 *    once; each then recovers independently before the connection returns;
 *  - every REST request of the run goes through one governor (serial, spaced,
 *    budgeted); a 418/429 halts all further REST for the run;
 *  - each connection has a BOUNDED queue. Overflow is never a silent drop: the
 *    connection is failed closed and its symbols recover and re-quarantine.
 *
 * Nothing here can create an Alert, reach a database, a queue, an account or
 * a signed endpoint. Every record it writes is the session's own, actionable: false.
 */

export type SymbolStatus = "PENDING" | "ATTACHED" | "RECOVERING" | "FAILED";

export interface SupervisorConfig {
  readonly lineage: LineageConfig;
  /** The selected symbols. The supervisor sorts them; assignment never depends on input order. */
  readonly symbols: readonly string[];
  readonly symbolsPerConnection: number;
  readonly maxConnections: number;
  /** Concurrent catch-ups and recoveries (their REST still goes through the one serial governor). */
  readonly restConcurrency: number;
  /** Raw messages a connection may hold unprocessed before it is failed closed. */
  readonly queueCapacity: number;
  /** A symbol whose update is older than this when processed is failed closed (detached, recovered). */
  readonly maxProcessingLagMs: number;
  /**
   * A symbol with no valid update for this long on an OPEN connection is stale.
   * Silence alone is not an error: Binance pushes a kline only when it changes,
   * so an illiquid symbol can be quiet for minutes. A missed bar is caught by
   * the session's own gap rule; this only catches a subscription gone dead.
   */
  readonly staleSymbolMs: number;
  /** Recovery attempts for one detachment before the symbol is FAILED for the run. */
  readonly maxRecoveryAttempts: number;
  /** The live-shadow directory of a symbol (live-shadow/<market>/<symbol>/<interval>). */
  readonly liveDirFor: (symbol: string) => string;
}

export interface SupervisorDeps {
  readonly openStream: OpenPublicStream;
  readonly governor: GovernedPublicTransport;
  readonly fetchDeps: PublicFetchDeps;
  readonly cache: KlineCacheLike;
  readonly acquireLock: (dir: string) => ScannerLock;
  readonly nowMs: () => number;
  readonly nowIso: () => string;
  /** Runs `fn` later on the event loop (setImmediate in the CLI; a manual queue in tests). */
  readonly schedule: (fn: () => void) => void;
  readonly log: (line: string) => void;
}

/** Reconnect delays per consecutive failure of one connection. */
export const SUPERVISOR_RECONNECT_DELAYS_MS = [5_000, 10_000, 30_000, 60_000];
/** Messages processed per drain turn before yielding the event loop. */
export const DRAIN_BATCH = 500;
/** After a failed recovery attempt, wait this long before the next. */
export const RECOVERY_RETRY_MS = 15_000;
/** Hard ceilings, whatever is configured. */
export const SUPERVISOR_LIMITS = Object.freeze({ maxConnections: 32, maxSymbols: 2_000, maxQueueCapacity: 100_000 });

export class SupervisorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorConfigError";
  }
}

interface SymbolCounters {
  observations: number;
  commitsLive: number;
  commitsQuarantined: number;
  commitsReplayed: number;
  refused: number;
  ignoredWhileDetached: number;
  recoveries: number;
  laggedUpdates: number;
}

interface SymbolWorker {
  readonly symbol: string;
  readonly connection: number;
  readonly dir: string;
  status: SymbolStatus;
  failure: string | null;
  lock: ScannerLock | null;
  session: LiveShadowSession | null;
  channel: SymbolStreamChannel | null;
  lineageId: string | null;
  lastValidMessageAtMs: number | null;
  /** When the symbol was last (re-)armed on a stream: the staleness baseline restarts here. */
  armedAtMs: number;
  recoveryAttempts: number;
  recoveryNotBeforeMs: number;
  recoveryInFlight: boolean;
  readonly counters: SymbolCounters;
}

interface Connection {
  readonly index: number;
  /** Every symbol ASSIGNED here (the deterministic assignment), attached or not. */
  readonly symbols: readonly string[];
  socket: StreamConnection | null;
  generation: number;
  lifecycle: "IDLE" | "CONNECTING" | "OPEN" | "CLOSED";
  connectStartedAtMs: number | null;
  openedAtMs: number | null;
  lastMessageAtMs: number | null;
  reconnectNotBeforeMs: number;
  consecutiveFailures: number;
  reconnects: number;
  overflows: number;
  unknownStream: number;
  readonly queue: string[];
  draining: boolean;
  url: string | null;
}

/**
 * Deterministic symbol -> connection assignment: sorted symbols, chunked in
 * order. It depends only on the selected set, never on arrival order, and a
 * symbol's state never depends on which connection carries it.
 */
export function assignConnections(symbols: readonly string[], perConnection: number, maxConnections: number): string[][] {
  if (!Number.isSafeInteger(perConnection) || perConnection < 1 || perConnection > MAX_STREAMS_PER_COMBINED_CONNECTION) {
    throw new SupervisorConfigError(`symbols per connection must be 1..${MAX_STREAMS_PER_COMBINED_CONNECTION}`);
  }
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > SUPERVISOR_LIMITS.maxConnections) {
    throw new SupervisorConfigError(`max connections must be 1..${SUPERVISOR_LIMITS.maxConnections}`);
  }
  const sorted = [...new Set(symbols)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.length !== symbols.length) throw new SupervisorConfigError("the selection repeats a symbol");
  const groups: string[][] = [];
  for (let i = 0; i < sorted.length; i += perConnection) groups.push(sorted.slice(i, i + perConnection));
  if (groups.length > maxConnections) {
    throw new SupervisorConfigError(`${sorted.length} symbols need ${groups.length} connections at ${perConnection} per connection; the limit is ${maxConnections}`);
  }
  return groups;
}

export class LiveShadowSupervisor {
  private readonly intervalMs: number;
  private readonly workers = new Map<string, SymbolWorker>();
  private readonly connections: Connection[];
  private readonly streamToSymbol = new Map<string, string>();
  /** Closed bars committed live, awaiting their (non-authoritative) cache write. */
  private readonly pendingCacheBars = new Map<string, NativeKline[]>();
  private stopped = false;
  readonly startedAt: string;

  constructor(
    private readonly config: SupervisorConfig,
    private readonly deps: SupervisorDeps
  ) {
    this.intervalMs = intervalMsOf(config.lineage.chartInterval);
    if (config.symbols.length === 0 || config.symbols.length > SUPERVISOR_LIMITS.maxSymbols) {
      throw new SupervisorConfigError(`select 1..${SUPERVISOR_LIMITS.maxSymbols} symbols`);
    }
    for (const [name, value, min, max] of [
      ["queue capacity", config.queueCapacity, 100, SUPERVISOR_LIMITS.maxQueueCapacity],
      ["REST concurrency", config.restConcurrency, 1, 8],
      ["max processing lag", config.maxProcessingLagMs, 1_000, 600_000],
      ["stale symbol timeout", config.staleSymbolMs, 10_000, 14_400_000],
      ["recovery attempts", config.maxRecoveryAttempts, 1, 100],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new SupervisorConfigError(`${name} must be ${min}..${max}`);
    }
    const groups = assignConnections(config.symbols, config.symbolsPerConnection, config.maxConnections);
    this.connections = groups.map((symbols, index) => ({
      index,
      symbols,
      socket: null,
      generation: 0,
      lifecycle: "IDLE",
      connectStartedAtMs: null,
      openedAtMs: null,
      lastMessageAtMs: null,
      reconnectNotBeforeMs: 0,
      consecutiveFailures: 0,
      reconnects: 0,
      overflows: 0,
      unknownStream: 0,
      queue: [],
      draining: false,
      url: null,
    }));
    groups.forEach((symbols, index) => {
      for (const symbol of symbols) {
        this.workers.set(symbol, {
          symbol,
          connection: index,
          dir: config.liveDirFor(symbol),
          status: "PENDING",
          failure: null,
          lock: null,
          session: null,
          channel: null,
          lineageId: null,
          lastValidMessageAtMs: null,
          armedAtMs: 0,
          recoveryAttempts: 0,
          recoveryNotBeforeMs: 0,
          recoveryInFlight: false,
          counters: { observations: 0, commitsLive: 0, commitsQuarantined: 0, commitsReplayed: 0, refused: 0, ignoredWhileDetached: 0, recoveries: 0, laggedUpdates: 0 },
        });
        this.streamToSymbol.set(`${symbol.toLowerCase()}@kline_${config.lineage.chartInterval}`, symbol);
      }
    });
    this.startedAt = deps.nowIso();
  }

  // ---------------------------------------------------------------------------
  // Start-up: lock, catch up (bounded, governed), then connect
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    const workers = [...this.workers.values()];
    await mapBounded(workers, this.config.restConcurrency, async (worker) => {
      try {
        await this.prepare(worker);
      } catch (error) {
        // Whatever went wrong, it went wrong for this symbol only.
        this.fail(worker, "UNEXPECTED_ERROR", error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
      }
    });
    for (const connection of this.connections) this.connect(connection);
  }

  private fail(worker: SymbolWorker, code: string, detail: string): void {
    worker.status = "FAILED";
    worker.failure = `${code}: ${detail}`;
    worker.session?.onDisconnect();
    this.deps.log(`${worker.symbol} FAILED ${code}: ${detail}`);
  }

  private async prepare(worker: SymbolWorker): Promise<void> {
    const { lineage } = this.config;
    try {
      worker.lock = this.deps.acquireLock(worker.dir);
    } catch (error) {
      if (error instanceof ScannerLockError) return this.fail(worker, error.code, error.message);
      throw error;
    }
    const contextStartMs = deriveHtfContextStartMs(lineage.historyStartMs, lineage.engine.enabledSourceTfs, lineage.engine.calendar);
    // Every bar before the one forming now (less the settle margin) is closed: the single-symbol CLI's rule.
    const boundaryMs = Math.floor((this.deps.nowMs() - REPLAY_SETTLE_MS) / this.intervalMs) * this.intervalMs;
    let filled;
    try {
      filled = await fillClosedBarCache({
        symbol: worker.symbol,
        chartInterval: lineage.chartInterval,
        contextStartMs,
        endMs: boundaryMs,
        cache: this.deps.cache,
        fetchDeps: this.deps.fetchDeps,
        governor: this.deps.governor,
        cacheOnly: false,
        nowIso: this.deps.nowIso,
      });
    } catch (error) {
      if (this.deps.governor.halt !== null) return this.fail(worker, "REST_HALTED", this.deps.governor.halt.message);
      throw error;
    }
    if (filled.kind === "SKIP") return this.fail(worker, filled.reason, filled.detail);

    const checkpoints = new LiveCheckpointStore(worker.dir);
    try {
      const plan = prepareLiveShadowState(
        filled.klines,
        {
          symbol: worker.symbol,
          marketType: SCANNER_MARKET_TYPE,
          chartInterval: lineage.chartInterval,
          historyStartMs: lineage.historyStartMs,
          switchoverMs: lineage.switchoverMs,
          engine: lineage.engine,
          partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
          expectedLineageId: null,
        },
        boundaryMs,
        checkpoints.load()
      );
      checkpoints.save(plan.checkpointBody, this.deps.nowIso());
      const events = new LiveShadowEventStore(worker.dir);
      const session = new LiveShadowSession({
        plan,
        checkpoints,
        events,
        nowMs: this.deps.nowMs,
        nowIso: this.deps.nowIso,
        persistClosedBar: (bar) => this.pendingCacheBars.set(worker.symbol, [...(this.pendingCacheBars.get(worker.symbol) ?? []), bar]),
      });
      worker.session = session;
      worker.lineageId = plan.lineageId;
      worker.channel = new SymbolStreamChannel({ session, log: (line) => this.symbolLog(worker, line) });
      worker.status = "ATTACHED";
      this.deps.log(`${worker.symbol} CATCHUP_OK lineage ${plan.lineageId.slice(0, 12)} checkpoint ${plan.checkpointStatus} hwm ${new Date(plan.hwmOpenTimeMs).toISOString()} replayed ${plan.catchUp.bars} bar(s) NON_ACTIONABLE`);
    } catch (error) {
      if (error instanceof LiveShadowError || error instanceof CompatReplayError || error instanceof KlineCacheError || error instanceof ScannerDataError) {
        return this.fail(worker, error.code, error.message);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Connections
  // ---------------------------------------------------------------------------

  private attachedSymbols(connection: Connection): string[] {
    return connection.symbols.filter((s) => (this.workers.get(s) as SymbolWorker).status !== "FAILED");
  }

  private connect(connection: Connection): void {
    if (this.stopped || connection.socket !== null) return;
    const symbols = this.attachedSymbols(connection);
    if (symbols.length === 0) {
      connection.lifecycle = "IDLE";
      return;
    }
    connection.url = buildPublicCombinedKlineStreamUrl(symbols, this.config.lineage.chartInterval);
    connection.lifecycle = "CONNECTING";
    connection.connectStartedAtMs = this.deps.nowMs();
    connection.openedAtMs = null;
    connection.lastMessageAtMs = null;
    connection.queue.length = 0;
    for (const symbol of symbols) {
      const worker = this.workers.get(symbol) as SymbolWorker;
      if (worker.status === "ATTACHED") this.arm(worker);
    }
    const generation = ++connection.generation;
    this.deps.log(`connection ${connection.index} STREAM_CONNECTING (${symbols.length} symbol(s))`);
    connection.socket = this.deps.openStream(connection.url, {
      onOpen: () => {
        if (generation !== connection.generation) return;
        connection.lifecycle = "OPEN";
        connection.openedAtMs = this.deps.nowMs();
        this.deps.log(`connection ${connection.index} STREAM_OPEN`);
      },
      onMessage: (text) => {
        if (generation === connection.generation) this.enqueue(connection, text);
      },
      onError: (reason) => {
        if (generation === connection.generation) this.dropConnection(connection, `STREAM_ERROR: ${reason}`);
      },
      onClose: (reason) => {
        if (generation === connection.generation) this.dropConnection(connection, `STREAM_CLOSED: ${reason}`);
      },
    });
  }

  /** The whole connection is gone: every symbol on it loses live eligibility and must recover its own gap. */
  private dropConnection(connection: Connection, reason: string): void {
    const socket = connection.socket;
    connection.socket = null;
    connection.generation += 1; // anything the dead connection still delivers is ignored
    connection.lifecycle = "CLOSED";
    connection.queue.length = 0;
    connection.consecutiveFailures += 1;
    connection.reconnectNotBeforeMs =
      this.deps.nowMs() + SUPERVISOR_RECONNECT_DELAYS_MS[Math.min(connection.consecutiveFailures - 1, SUPERVISOR_RECONNECT_DELAYS_MS.length - 1)];
    if (socket !== null) socket.close();
    for (const symbol of connection.symbols) {
      const worker = this.workers.get(symbol) as SymbolWorker;
      if (worker.status === "ATTACHED") this.detach(worker, `connection ${connection.index} lost`);
    }
    this.deps.log(`connection ${connection.index} ${reason}: live eligibility OFF for its symbols; each recovers its own gap`);
  }

  private enqueue(connection: Connection, text: string): void {
    connection.lastMessageAtMs = this.deps.nowMs();
    if (connection.queue.length >= this.config.queueCapacity) {
      // Never a silent drop: an update we cannot process could change Immediate semantics.
      connection.overflows += 1;
      this.deps.log(`connection ${connection.index} BACKPRESSURE: queue full (${this.config.queueCapacity}); failing the connection closed`);
      this.dropConnection(connection, "BACKPRESSURE_QUEUE_OVERFLOW");
      return;
    }
    connection.queue.push(text);
    if (!connection.draining) {
      connection.draining = true;
      this.deps.schedule(() => this.drain(connection));
    }
  }

  /** Processes queued messages in order, a bounded batch per turn. */
  drain(connection: Connection): void {
    const generation = connection.generation;
    let processed = 0;
    while (connection.queue.length > 0 && processed < DRAIN_BATCH) {
      if (generation !== connection.generation) break; // the connection was dropped mid-batch
      const text = connection.queue.shift() as string;
      processed += 1;
      this.dispatch(connection, text);
    }
    if (connection.queue.length > 0 && generation === connection.generation) this.deps.schedule(() => this.drain(connection));
    else connection.draining = false;
  }

  private dispatch(connection: Connection, text: string): void {
    try {
      this.dispatchUnsafe(connection, text);
    } catch (error) {
      // An unexpected failure while one symbol processed its update: that symbol alone is failed closed.
      const symbol = (() => {
        try {
          return this.streamToSymbol.get(parseCombinedStreamEnvelope(text).stream);
        } catch {
          return undefined;
        }
      })();
      const worker = symbol === undefined ? undefined : this.workers.get(symbol);
      const why = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
      if (worker !== undefined) this.fail(worker, "UNEXPECTED_ERROR", why);
      else connection.unknownStream += 1;
    }
  }

  private dispatchUnsafe(connection: Connection, text: string): void {
    let envelope;
    try {
      envelope = parseCombinedStreamEnvelope(text);
    } catch (error) {
      if (!(error instanceof LiveStreamError)) throw error;
      connection.unknownStream += 1;
      return;
    }
    const symbol = this.streamToSymbol.get(envelope.stream);
    const worker = symbol === undefined ? undefined : this.workers.get(symbol);
    if (worker === undefined || worker.connection !== connection.index) {
      connection.unknownStream += 1;
      return;
    }
    if (worker.status !== "ATTACHED" || worker.session === null || worker.channel === null) {
      worker.counters.ignoredWhileDetached += 1;
      return;
    }
    let update;
    try {
      update = parseKlineStreamPayload(envelope.data, worker.symbol, this.config.lineage.chartInterval);
    } catch (error) {
      if (!(error instanceof LiveStreamError)) throw error;
      // One malformed message for one symbol: refused and counted for that symbol only.
      worker.counters.refused += 1;
      worker.channel.refuse(error);
      return;
    }
    const lag = this.deps.nowMs() - update.eventTimeMs;
    if (lag > this.config.maxProcessingLagMs) {
      worker.counters.laggedUpdates += 1;
      this.detach(worker, `BACKPRESSURE: update processed ${lag} ms after its exchange time (limit ${this.config.maxProcessingLagMs})`);
      return;
    }
    worker.lastValidMessageAtMs = this.deps.nowMs();
    const result = worker.channel.accept(update);
    if (result.outcome !== null) {
      worker.counters.observations += result.outcome.observations.length;
      const commit = result.outcome.commit;
      if (commit !== null) {
        if (commit.classification === "SHADOW_LIVE_ONLY") worker.counters.commitsLive += 1;
        else worker.counters.commitsQuarantined += 1;
      }
    }
    if (result.recoveryReason !== null) this.detach(worker, `RECOVERY_REQUIRED: ${result.recoveryReason}`);
  }

  /** A fresh attachment: readiness must be re-established, and the staleness clock restarts. */
  private arm(worker: SymbolWorker): void {
    worker.channel?.arm();
    worker.armedAtMs = this.deps.nowMs();
  }

  /** Takes ONE symbol out of live eligibility and queues its own recovery; the connection stays up. */
  private detach(worker: SymbolWorker, reason: string): void {
    if (worker.status !== "ATTACHED") return;
    worker.status = "RECOVERING";
    worker.recoveryAttempts = 0;
    worker.recoveryNotBeforeMs = 0;
    worker.session?.onDisconnect();
    this.deps.log(`${worker.symbol} DETACHED (${reason}): live eligibility OFF; recovering its gap`);
  }

  /** Fills the symbol's fully closed gap (governed REST), commits it REPLAYED_NON_ACTIONABLE, re-arms readiness. */
  private async recover(worker: SymbolWorker): Promise<void> {
    const session = worker.session as LiveShadowSession;
    worker.recoveryInFlight = true;
    worker.recoveryAttempts += 1;
    try {
      const currentBarOpen = Math.floor(this.deps.nowMs() / this.intervalMs) * this.intervalMs;
      const bars =
        currentBarOpen > session.hwmOpenTimeMs
          ? (
              await fetchClosedFuturesKlines(this.deps.fetchDeps, {
                symbol: worker.symbol,
                interval: this.config.lineage.chartInterval,
                startMs: session.hwmOpenTimeMs,
                endMs: currentBarOpen,
                maxBars: Math.max(1, (currentBarOpen - session.hwmOpenTimeMs) / this.intervalMs),
                pageLimit: REPLAY_PAGE_LIMIT,
                settleMs: REPLAY_SETTLE_MS,
              })
            ).klines
          : [];
      const records = session.recoverClosedBars(bars);
      worker.counters.commitsReplayed += records.length;
      for (const record of records) worker.channel?.logCommit(record);
      worker.counters.recoveries += 1;
      worker.status = "ATTACHED";
      this.arm(worker);
      this.deps.log(`${worker.symbol} RECOVERED ${records.length} closed bar(s) NON_ACTIONABLE; re-armed: its current bar will be QUARANTINED`);
    } catch (error) {
      if (this.deps.governor.halt !== null) return this.fail(worker, "REST_HALTED", this.deps.governor.halt.message);
      const why = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
      if (worker.recoveryAttempts >= this.config.maxRecoveryAttempts) return this.fail(worker, "RECOVERY_FAILED", why);
      worker.recoveryNotBeforeMs = this.deps.nowMs() + RECOVERY_RETRY_MS;
      this.deps.log(`${worker.symbol} recovery attempt ${worker.recoveryAttempts} failed (${why}); retrying`);
    } finally {
      worker.recoveryInFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // The periodic tick: timeouts, staleness, recoveries, reconnects, cache writes
  // ---------------------------------------------------------------------------

  /** Called periodically (every second by the CLI). Returns the recoveries it started, for tests to await. */
  tick(): Promise<void>[] {
    if (this.stopped) return [];
    const now = this.deps.nowMs();
    for (const connection of this.connections) {
      if (connection.socket !== null) {
        let reason: string | null = null;
        if (connection.lifecycle === "CONNECTING" && now - (connection.connectStartedAtMs as number) > STREAM_OPEN_TIMEOUT_MS) reason = "STREAM_OPEN_TIMEOUT";
        else if (connection.lifecycle === "OPEN" && connection.lastMessageAtMs === null && now - (connection.openedAtMs as number) > STREAM_READINESS_TIMEOUT_MS) reason = "STREAM_READINESS_TIMEOUT: no message at all";
        else if (connection.lastMessageAtMs !== null && now - connection.lastMessageAtMs > STREAM_STALE_TIMEOUT_MS) reason = "STREAM_STALE: no message on the connection";
        if (reason !== null) this.dropConnection(connection, reason);
        else if (connection.lifecycle === "OPEN" && connection.lastMessageAtMs !== null) connection.consecutiveFailures = 0;
      }
      // Per-symbol staleness on a live connection: that symbol alone recovers.
      if (connection.socket !== null && connection.lifecycle === "OPEN" && connection.openedAtMs !== null) {
        for (const symbol of connection.symbols) {
          const worker = this.workers.get(symbol) as SymbolWorker;
          if (worker.status !== "ATTACHED") continue;
          // Measured from the latest of: the last valid update, the connection opening, the symbol's last (re-)arming.
          const since = Math.max(worker.lastValidMessageAtMs ?? 0, connection.openedAtMs, worker.armedAtMs);
          if (now - since > this.config.staleSymbolMs) this.detach(worker, `STREAM_STALE_SYMBOL: no valid update for ${Math.round((now - since) / 1000)}s`);
        }
      }
    }
    // Recoveries: bounded concurrency; their REST is serialised by the governor anyway.
    const started: Promise<void>[] = [];
    const inFlight = [...this.workers.values()].filter((w) => w.recoveryInFlight).length;
    for (const worker of this.workers.values()) {
      if (started.length + inFlight >= this.config.restConcurrency) break;
      if (worker.status !== "RECOVERING" || worker.recoveryInFlight || now < worker.recoveryNotBeforeMs) continue;
      started.push(this.recover(worker));
    }
    for (const connection of this.connections) {
      if (connection.socket === null && connection.lifecycle !== "IDLE" && now >= connection.reconnectNotBeforeMs) {
        connection.reconnects += 1;
        this.connect(connection);
      }
    }
    this.flushOneCachedSymbol();
    return started;
  }

  /** Writes one symbol's committed closed bars into the public kline cache (a non-authoritative speed-up). */
  flushOneCachedSymbol(): void {
    const next = this.pendingCacheBars.keys().next();
    if (next.done === true) return;
    const symbol = next.value;
    const bars = this.pendingCacheBars.get(symbol) as NativeKline[];
    this.pendingCacheBars.delete(symbol);
    try {
      const current = this.deps.cache.load(SCANNER_MARKET_TYPE, symbol, this.config.lineage.chartInterval)?.klines ?? [];
      this.deps.cache.save(SCANNER_MARKET_TYPE, symbol, this.config.lineage.chartInterval, mergeClosedKlines(current, bars), this.deps.nowIso());
    } catch (error) {
      // The cache is not the checkpoint: a restart re-fetches whatever is missing and re-verifies its hash.
      this.deps.log(`${symbol} cache write skipped (${error instanceof Error ? error.name : "unknown"}); the checkpoint is unaffected`);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const connection of this.connections) {
      const socket = connection.socket;
      connection.socket = null;
      connection.generation += 1;
      connection.lifecycle = "CLOSED";
      socket?.close();
    }
    for (const worker of this.workers.values()) {
      worker.session?.onDisconnect();
      worker.lock?.release();
    }
    while (this.pendingCacheBars.size > 0) this.flushOneCachedSymbol();
  }

  private symbolLog(worker: SymbolWorker, line: string): void {
    this.deps.log(`${worker.symbol} ${line}`);
  }

  // ---------------------------------------------------------------------------
  // Observation only: never changes anything
  // ---------------------------------------------------------------------------

  status() {
    const now = this.deps.nowMs();
    const symbols = [...this.workers.values()].map((w) => {
      const session = w.session;
      const formingBar = Math.floor(now / this.intervalMs) * this.intervalMs;
      const readiness =
        w.status !== "ATTACHED" || session === null ? w.status : session.phase === "READY" ? session.barStatus(formingBar) : session.phase === "RECOVERY_REQUIRED" ? "RECOVERY_REQUIRED" : "AWAITING_STREAM";
      return {
        symbol: w.symbol,
        connection: w.connection,
        status: w.status,
        readiness,
        failure: w.failure,
        lineageId: w.lineageId,
        hwm: session === null ? null : new Date(session.hwmOpenTimeMs).toISOString(),
        liveEligibleFrom: session?.liveEligibleFromMs == null ? null : new Date(session.liveEligibleFromMs).toISOString(),
        lastValidMessageAt: w.lastValidMessageAtMs === null ? null : new Date(w.lastValidMessageAtMs).toISOString(),
        counters: { ...w.counters },
      };
    });
    const count = (pred: (s: (typeof symbols)[number]) => boolean) => symbols.filter(pred).length;
    return {
      schema: "teddy.native-scanner.live-shadow-supervisor-status.v1",
      notice: ["SHADOW ONLY", "NO ALERT AUTHORITY", "NO ORDER AUTHORITY"],
      actionable: false as const,
      startedAt: this.startedAt,
      interval: this.config.lineage.chartInterval,
      totals: {
        selected: symbols.length,
        liveEligible: count((s) => s.readiness === "LIVE_ELIGIBLE"),
        quarantined: count((s) => s.readiness === "QUARANTINED_CURRENT_BAR"),
        awaitingStream: count((s) => s.readiness === "AWAITING_STREAM" || s.readiness === "NOT_READY"),
        recovering: count((s) => s.status === "RECOVERING"),
        failed: count((s) => s.status === "FAILED"),
        catchupPending: count((s) => s.status === "PENDING"),
        liveObservations: symbols.reduce((n, s) => n + s.counters.observations, 0),
        commits: symbols.reduce((n, s) => n + s.counters.commitsLive + s.counters.commitsQuarantined + s.counters.commitsReplayed, 0),
        refusedMessages: symbols.reduce((n, s) => n + s.counters.refused, 0),
        reconnects: this.connections.reduce((n, c) => n + c.reconnects, 0),
        backpressureEvents: this.connections.reduce((n, c) => n + c.overflows, 0) + symbols.reduce((n, s) => n + s.counters.laggedUpdates, 0),
        restRequests: this.deps.governor.requestsMade,
        restHalted: this.deps.governor.halt !== null,
      },
      connections: this.connections.map((c) => ({
        index: c.index,
        lifecycle: c.lifecycle,
        assigned: c.symbols.length,
        queued: c.queue.length,
        reconnects: c.reconnects,
        overflows: c.overflows,
        unknownStreamMessages: c.unknownStream,
        lastMessageAt: c.lastMessageAtMs === null ? null : new Date(c.lastMessageAtMs).toISOString(),
      })),
      symbols,
    };
  }
}

export type SupervisorStatus = ReturnType<LiveShadowSupervisor["status"]>;

/** live-shadow/<market>/<symbol>/<interval> under the scanner root — the single-symbol layout. */
export const liveShadowDir = (scannerRoot: string, symbol: string, interval: string) => path.join(scannerRoot, "live-shadow", SCANNER_MARKET_TYPE, symbol, interval);
