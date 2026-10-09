import path from "node:path";
import { SWITCHOVER_TRUNCATED_CLOSED_BARS, type NativeKline } from "@trading-alert-dashboard/shared";

import { SCANNER_MARKET_TYPE, ScannerDataError, intervalMsOf } from "./binance-public-futures";
import { GovernedPublicTransport, fillClosedBarCache, mapBounded, type GovernorMetrics, type KlineCacheLike } from "./candidate-rank-runner";
import { CompatReplayError } from "./compat-replay";
import { KlineCacheError, mergeClosedKlines } from "./kline-cache";
import { fetchClosedFuturesKlines, type BinanceServerClock, type ClosedKlineFetchOptions, type PublicFetchDeps } from "./kline-fetcher";
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
import { LiveShadowSession, prepareLiveShadowState, type CheckpointStatus } from "./live-shadow-session";
import { LiveShadowEventStore } from "./live-shadow-store";
import { REPLAY_PAGE_LIMIT, REPLAY_SETTLE_MS } from "./replay-cli-args";
import { klineStreamNameOf, symbolPathSegment } from "./exchange-symbol";
import { probeSymbolHistoryOrigin } from "./history-origin";
import { deriveHtfContextStartMs, effectiveHistoryRanges, type SymbolHistoryOrigin, type SymbolOriginInput } from "./scanner-lineage";
import { engineFingerprintOfConfig, engineFingerprintOfLineage, type ProfileSummary } from "./scanner-profile";
import type { RunManifestSymbol } from "./supervisor-run-manifest";
import { ScannerLockError, type ScannerLock } from "./scanner-lock";
import { SymbolStreamChannel } from "./symbol-stream-channel";
import type { UsdmContract, UsdmUniverse } from "./usdm-universe";

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
 * DYNAMIC UNIVERSE (DYNAMIC_UNIVERSE_V1, only with a SYMBOL_FIRST_CLOSED_BAR_V1
 * engine and an ALL_ACTIVE selection): the running supervisor refreshes the
 * public exchangeInfo (one request, fenced: never two at once, never before
 * start-up completes, never after stop) and reconciles its members:
 *  - a NEW target symbol gets exactly one worker and one bootstrap at a time:
 *    first real closed bar -> history replay (non-delivering) -> checkpoint ->
 *    placement on a connection with room (that one connection is rebuilt; the
 *    hwm handshake and REST recovery close any REST/WebSocket gap, and the
 *    session dedupes closed bars by open time) -> readiness -> live;
 *  - a symbol that LEAVES the target universe becomes INACTIVE: no further
 *    observations, its subscription is dropped from the next connect, its
 *    checkpoint and evidence stay exactly as they are;
 *  - an INACTIVE symbol that RETURNS with the same contract identity resumes
 *    its own preserved session (catching up closed bars, non-actionable); a
 *    changed identity is QUARANTINED, never merged;
 *  - a failed or implausible refresh (error, empty, mass removal) keeps the
 *    last-known-good universe and is reported stale; nothing is evicted;
 *  - a universe larger than the connection ceiling admits nobody new and is
 *    reported CAPACITY_EXCEEDED; nothing is truncated silently.
 * Every async step carries the worker's generation token: work that finishes
 * after its symbol was removed, re-added or the supervisor stopped is
 * discarded before it can write a checkpoint, a commit or a membership.
 *
 * Nothing here can create an Alert, reach a database, a queue, an account or
 * a signed endpoint. Every record it writes is the session's own, actionable: false.
 */

export type SymbolStatus =
  | "PENDING"
  | "ATTACHED"
  | "RECOVERING"
  | "FAILED"
  /** Dynamic universe: preparing history (first bar, replay, checkpoint). */
  | "BOOTSTRAPPING"
  /** Dynamic universe: no closed bar to start from yet (retried at the next close). */
  | "WAITING_FIRST_CLOSED_BAR"
  /** Dynamic universe: the first bar or history could not be read (retried later). UNKNOWN, never ABSENT. */
  | "BOOTSTRAP_UNREADABLE"
  /** Dynamic universe: a real post-origin gap, drift, contradiction or identity conflict. Never scanned, never guessed. */
  | "QUARANTINED"
  /** Dynamic universe: left the target universe. State preserved; no new observations. */
  | "INACTIVE";

/** The Binance contract metadata that names ONE contract. A change while the symbol is the same is a different contract. */
export interface ContractIdentity {
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly contractType: string;
  readonly onboardDateMs: number | null;
  readonly underlyingType: string | null;
}

export const contractIdentityOf = (c: UsdmContract): ContractIdentity => ({
  baseAsset: c.baseAsset,
  quoteAsset: c.quoteAsset,
  contractType: c.contractType,
  onboardDateMs: c.onboardDateMs,
  underlyingType: c.underlyingType,
});

const sameIdentity = (a: ContractIdentity, b: ContractIdentity) =>
  a.baseAsset === b.baseAsset && a.quoteAsset === b.quoteAsset && a.contractType === b.contractType && a.onboardDateMs === b.onboardDateMs && a.underlyingType === b.underlyingType;

/** One symbol the supervisor may try, with Binance's advisory listing time. */
export interface SupervisorCandidate {
  readonly symbol: string;
  /** Advisory only; null when unknown. Never proof that a symbol IS eligible. */
  readonly onboardDateMs: number | null;
  /** Named by the operator (--include-symbols): must be accepted, never replaced. */
  readonly required: boolean;
  /** The contract's identity from exchangeInfo (dynamic universe: reactivation must match it). */
  readonly identity?: ContractIdentity | null;
}

/**
 * How the running set is chosen.
 *  EXPLICIT    exactly these symbols (--symbols); an ineligible one is a visible FAILED symbol, never replaced;
 *  TARGET      walk `candidates` in order and accept the first `target` SCANNER-ELIGIBLE ones (backfill);
 *  ALL_ACTIVE  walk every candidate and accept every scanner-eligible one.
 * In TARGET / ALL_ACTIVE, a rejected candidate never joins: no lock, no stream, no runtime slot.
 */
export type SupervisorSelection =
  | { readonly mode: "EXPLICIT"; readonly candidates: readonly SupervisorCandidate[] }
  | { readonly mode: "TARGET"; readonly candidates: readonly SupervisorCandidate[]; readonly target: number }
  | { readonly mode: "ALL_ACTIVE"; readonly candidates: readonly SupervisorCandidate[] };

/**
 * A candidate is skipped as TOO_NEW only when Binance lists it more than this
 * long after the HTF context start. The margin makes the cheap pre-check
 * strictly conservative: anything closer falls through to canonical preparation.
 */
export const ONBOARD_PRECHECK_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

export type SkipClass = "TOO_NEW_PRECHECK" | "INSUFFICIENT_HISTORY" | "OTHER";

export interface SelectionSummary {
  readonly mode: SupervisorSelection["mode"];
  readonly universeActive: number | null;
  readonly targetEligible: number | null;
  readonly candidatesTested: number;
  readonly acceptedEligible: number;
  readonly skippedTooNew: number;
  readonly skippedInsufficientHistory: number;
  readonly skippedOther: number;
  readonly universeExhausted: boolean;
  readonly skipped: readonly { readonly symbol: string; readonly class: SkipClass; readonly reason: string }[];
}

/** The target could not be met: budget spent, REST halted, or a required symbol ineligible. Nothing was started. */
export class TargetNotReachedError extends Error {
  readonly code = "TARGET_NOT_REACHED";

  constructor(
    message: string,
    readonly summary: SelectionSummary & { readonly requestsUsed: number; readonly remainingUniverse: number }
  ) {
    super(message);
    this.name = "TargetNotReachedError";
  }
}

export interface SupervisorConfig {
  readonly lineage: LineageConfig;
  /**
   * Shorthand for an EXPLICIT selection of these symbols (no listing metadata).
   * Give exactly one of `symbols` or `selection`.
   */
  readonly symbols?: readonly string[];
  readonly selection?: SupervisorSelection;
  /** The active universe size, for the report only. */
  readonly universeActive?: number;
  /** TOO_NEW pre-check margin after the context start (default ONBOARD_PRECHECK_MARGIN_MS; 0..30 days). */
  readonly onboardPrecheckMarginMs?: number;
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
  /** The live-shadow directory of a symbol: its engine namespace (profile runs) or the legacy tree. */
  readonly liveDirFor: (symbol: string) => string;
  /** This run's identity (status, manifest). Null in tests that do not care. */
  readonly runId?: string | null;
  /** The profile this run executes, or null for a legacy explicit-flag run. Its engine fingerprint must match `lineage`. */
  readonly profile?: ProfileSummary | null;
  /** DYNAMIC_UNIVERSE_V1: periodic universe refresh and live onboarding. Needs a symbol history origin, ALL_ACTIVE and deps.fetchUniverse. */
  readonly dynamicUniverse?: DynamicUniverseConfig | null;
}

export interface DynamicUniverseConfig {
  /** Between two exchangeInfo refreshes (UNIVERSE_REFRESH_LIMITS in scanner-profile.ts). */
  readonly refreshIntervalMs: number;
}

/** One change of the running set after start-up, for the run's append-only membership journal. */
export interface MembershipChange {
  readonly kind: "JOINED" | "REACTIVATED" | "INACTIVE" | "QUARANTINED";
  readonly symbol: string;
  readonly lineageId: string | null;
  readonly bootstrapInputSha256: string | null;
  readonly symbolHistoryOrigin: SymbolHistoryOrigin | null;
  readonly reason: string | null;
  readonly at: string;
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
  /** Dynamic universe: the current public universe (exchangeInfo through the governed transport). Throws on any failure. */
  readonly fetchUniverse?: () => Promise<UsdmUniverse>;
  /** Dynamic universe: called synchronously for every membership change after start-up (the CLI appends the journal). */
  readonly recordMembership?: (change: MembershipChange) => void;
  /**
   * FAST_RECOVERY_V1 request savers for bootstrap, catch-up and recovery. They
   * change how many requests are sent, never which rows arrive or how they are
   * replayed. Absent: every fetch asks Binance's clock itself and pages at the
   * full page size (the original behaviour).
   */
  readonly recoveryFetch?: RecoveryFetchPolicy | null;
}

/** Identifies the recovery fetch policy in status and logs. Not part of any lineage, fingerprint or durable namespace. */
export const NATIVE_RECOVERY_POLICY_VERSION = "FAST_RECOVERY_V1" as const;
export const LEGACY_RECOVERY_POLICY = "LEGACY_SERIAL" as const;

export interface RecoveryFetchPolicy {
  readonly version: typeof NATIVE_RECOVERY_POLICY_VERSION;
  /** One reading of Binance's clock shared by the whole run. */
  readonly serverClock: BinanceServerClock;
  /** Each klines page asks only for the bars the range still needs. */
  readonly sizePagesToRange: boolean;
}

/** One start-up's recovery, as status and the start-up log report it. Observation only. */
export interface StartupRecoverySummary {
  readonly policy: typeof NATIVE_RECOVERY_POLICY_VERSION | typeof LEGACY_RECOVERY_POLICY;
  readonly symbols: number;
  readonly liveReady: number;
  /** Checkpoint verified and extended by the closed bars missed while down. */
  readonly recovered: number;
  /** Checkpoint verified, nothing missed. */
  readonly current: number;
  /** No previous checkpoint: bootstrapped from its history. */
  readonly bootstrapped: number;
  /** Not live-ready (failed, waiting, unreadable, quarantined). */
  readonly notLive: number;
  /** Closed 15m bars replayed NON_ACTIONABLE across recovered symbols (downtime), not counting bootstraps. */
  readonly missingBarsReplayed: number;
  readonly restRequests: number;
  readonly restWeight: number;
  readonly serverClockRequests: number;
  readonly maxRequestsInFlight: number;
  readonly workerConcurrency: number;
  readonly weightWaits: number;
  readonly usedWeightPauses: number;
  /** Highest valid X-MBX-USED-WEIGHT-1M Binance reported during this start-up; null when none arrived (unknown, not 0). */
  readonly peakReportedUsedWeight: number | null;
  readonly elapsedMs: number;
  /** When the start-up recovery walk completed successfully; null when it did not complete (failed or halted). */
  readonly completedAt: string | null;
}

/** Reconnect delays per consecutive failure of one connection. */
export const SUPERVISOR_RECONNECT_DELAYS_MS = [5_000, 10_000, 30_000, 60_000];
/** Messages processed per drain turn before yielding the event loop. */
export const DRAIN_BATCH = 500;
/** After a failed recovery attempt, wait this long before the next. */
export const RECOVERY_RETRY_MS = 15_000;
/** Hard ceilings, whatever is configured. */
export const SUPERVISOR_LIMITS = Object.freeze({ maxConnections: 32, maxSymbols: 2_000, maxQueueCapacity: 100_000 });
/** Dynamic universe: waits after an unreadable bootstrap, per consecutive attempt. */
export const BOOTSTRAP_RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000];
/** Dynamic universe: a quarantined history (real gap, drift, contradiction) is re-checked this rarely. */
export const QUARANTINE_RETRY_MS = 24 * 60 * 60 * 1000;
/**
 * Dynamic universe: a refresh that would remove more than max(MIN, FRACTION x members) symbols at
 * once is refused as implausible (a truncated or wrong payload), keeping the last-known-good universe.
 */
export const MASS_REMOVAL_GUARD = Object.freeze({ min: 25, fraction: 0.25 });

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
  ignoredWhileInactive: number;
}

interface SymbolWorker {
  readonly symbol: string;
  /** Assigned once the running set is known. */
  connection: number;
  readonly dir: string;
  status: SymbolStatus;
  failure: string | null;
  lock: ScannerLock | null;
  session: LiveShadowSession | null;
  channel: SymbolStreamChannel | null;
  lineageId: string | null;
  bootstrapInputSha256: string | null;
  lastValidMessageAtMs: number | null;
  /** When the symbol was last (re-)armed on a stream: the staleness baseline restarts here. */
  armedAtMs: number;
  recoveryAttempts: number;
  recoveryNotBeforeMs: number;
  recoveryInFlight: boolean;
  readonly counters: SymbolCounters;
  /** Fences async work: bumped whenever the symbol is removed, re-added or quarantined. Stale work never lands. */
  generation: number;
  /** The contract identity it was admitted with (dynamic universe). */
  identity: ContractIdentity | null;
  readonly onboardDateMs: number | null;
  origin: SymbolOriginInput | null;
  symbolHistoryOrigin: SymbolHistoryOrigin | null;
  onboardDiscrepancyMs: number | null;
  bootstrapInFlight: boolean;
  bootstrapAttempts: number;
  /** Dynamic universe: the earliest time the next bootstrap may start. */
  nextAttemptAtMs: number;
  inactiveSinceMs: number | null;
  /** Set while an INACTIVE symbol's preserved session catches up after it returned. */
  reactivating: boolean;
  /** True once the symbol has been part of the running set (manifest or journal). */
  joined: boolean;
  /** The last successful preparation's checkpoint outcome and the closed bars it replayed. Observation only. */
  catchUp: { readonly status: CheckpointStatus; readonly bars: number } | null;
}

interface Connection {
  readonly index: number;
  /** Every symbol ASSIGNED here (the deterministic assignment, plus dynamic placements), attached or not. */
  symbols: string[];
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
  /** Controlled rebuilds (a dynamic placement changed its subscription set). */
  rebuilds: number;
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
  private connections: Connection[] = [];
  private readonly selection: SupervisorSelection;
  private selectionSummary: SelectionSummary | null = null;
  /** Every worker created before the running set was known (start-up). */
  private readonly startupWorkers: SymbolWorker[] = [];
  private startupRecovery: StartupRecoverySummary | null = null;
  private readonly streamToSymbol = new Map<string, string>();
  /** Closed bars committed live, awaiting their (non-authoritative) cache write. */
  private readonly pendingCacheBars = new Map<string, NativeKline[]>();
  private stopped = false;
  /** Start-up has completed: the running set is known and connected. Refreshes never run before. */
  private started = false;
  private readonly dynamic: boolean;
  private readonly universeState = {
    generation: 0,
    inFlight: false,
    nextAtMs: 0,
    lastAttemptAtMs: null as number | null,
    lastSuccessAtMs: null as number | null,
    lastResult: null as null | "OK" | "FAILED" | "REJECTED_EMPTY" | "REJECTED_MASS_REMOVAL",
    lastError: null as string | null,
    consecutiveFailures: 0,
    refreshes: 0,
    failures: 0,
    suppressed: 0,
    exchangeCandidates: null as number | null,
    added: [] as string[],
    removed: [] as string[],
    reactivated: [] as string[],
    identityConflicts: [] as string[],
    capacityExceeded: false,
    capacityRequired: null as number | null,
    notAdmitted: [] as string[],
  };
  readonly startedAt: string;
  /** Every accepted symbol's lineage must belong to this engine. */
  readonly engineFingerprint: string;

  constructor(
    private readonly config: SupervisorConfig,
    private readonly deps: SupervisorDeps
  ) {
    this.intervalMs = intervalMsOf(config.lineage.chartInterval);
    if ((config.symbols === undefined) === (config.selection === undefined)) {
      throw new SupervisorConfigError("give exactly one of symbols or selection");
    }
    this.selection =
      config.selection ?? { mode: "EXPLICIT", candidates: (config.symbols as readonly string[]).map((symbol) => ({ symbol, onboardDateMs: null, required: true })) };
    const candidates = this.selection.candidates;
    if (candidates.length === 0 || candidates.length > SUPERVISOR_LIMITS.maxSymbols) {
      throw new SupervisorConfigError(`select 1..${SUPERVISOR_LIMITS.maxSymbols} symbols`);
    }
    if (new Set(candidates.map((c) => c.symbol)).size !== candidates.length) throw new SupervisorConfigError("the selection repeats a symbol");
    for (const [name, value, min, max] of [
      ["queue capacity", config.queueCapacity, 100, SUPERVISOR_LIMITS.maxQueueCapacity],
      ["REST concurrency", config.restConcurrency, 1, 8],
      ["max processing lag", config.maxProcessingLagMs, 1_000, 600_000],
      ["stale symbol timeout", config.staleSymbolMs, 10_000, 14_400_000],
      ["recovery attempts", config.maxRecoveryAttempts, 1, 100],
      ["onboard pre-check margin", config.onboardPrecheckMarginMs ?? ONBOARD_PRECHECK_MARGIN_MS, 0, 30 * 24 * 60 * 60 * 1000],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new SupervisorConfigError(`${name} must be ${min}..${max}`);
    }
    this.dynamic = config.dynamicUniverse != null;
    if (this.dynamic) {
      const refresh = (config.dynamicUniverse as DynamicUniverseConfig).refreshIntervalMs;
      if (!Number.isSafeInteger(refresh) || refresh < 60_000 || refresh > 3_600_000) throw new SupervisorConfigError("the universe refresh interval must be 60000..3600000 ms");
      if (config.lineage.historyOrigin === undefined) throw new SupervisorConfigError("a dynamic universe needs an engine with a symbol history origin");
      if (this.selection.mode !== "ALL_ACTIVE") throw new SupervisorConfigError("a dynamic universe is an ALL_ACTIVE selection");
      if (deps.fetchUniverse === undefined) throw new SupervisorConfigError("a dynamic universe needs a universe source (fetchUniverse)");
    }
    // Capacity is checked up front for everything the run could need, so a valid config can never fail after the walk.
    // ALL_ACTIVE: every candidate the free pre-check cannot rule out might be accepted.
    const capacityNeeded =
      this.selection.mode === "TARGET"
        ? this.selection.target
        : this.selection.mode === "EXPLICIT"
          ? candidates.length
          : Math.max(1, candidates.filter((c) => !this.tooNew(c)).length);
    if (this.selection.mode === "TARGET" && (!Number.isSafeInteger(this.selection.target) || this.selection.target < 1)) {
      throw new SupervisorConfigError("the target must be a positive integer");
    }
    assignConnections(
      Array.from({ length: capacityNeeded }, (_, i) => `S${i}`),
      config.symbolsPerConnection,
      config.maxConnections
    );
    this.engineFingerprint = engineFingerprintOfConfig(config.lineage);
    if (config.profile != null && config.profile.engineFingerprint !== this.engineFingerprint) {
      throw new SupervisorConfigError("the profile's engine fingerprint does not match the run's engine configuration");
    }
    this.startedAt = deps.nowIso();
  }

  // ---------------------------------------------------------------------------
  // Start-up: lock, catch up (bounded, governed), then connect
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    const startedAtMs = this.deps.nowMs();
    const before = this.deps.governor.metrics;
    const clockBefore = this.deps.recoveryFetch?.serverClock.requests ?? 0;
    const usedWeight = this.deps.governor.trackReportedUsedWeight();
    let accepted: SymbolWorker[];
    let completed = false;
    try {
      accepted = this.selection.mode === "EXPLICIT" ? await this.startExplicit() : this.dynamic ? await this.startDynamic() : await this.walkCandidates();
      completed = true;
    } finally {
      usedWeight.stop();
      this.startupRecovery = this.summarizeStartup(startedAtMs, before, clockBefore, completed, usedWeight.peak());
      const r = this.startupRecovery;
      this.deps.log(
        `STARTUP_RECOVERY policy ${r.policy}: ${r.symbols} symbol(s), ${r.liveReady} live-ready (${r.recovered} recovered, ${r.current} current, ${r.bootstrapped} bootstrapped), ${r.notLive} not live; ` +
          `${r.missingBarsReplayed} missed closed bar(s) replayed NON_ACTIONABLE; REST ${r.restRequests} request(s), weight ${r.restWeight}, max ${r.maxRequestsInFlight} in flight, ${r.workerConcurrency} worker(s), ` +
          `${r.weightWaits} weight wait(s), ${r.usedWeightPauses} IP pause(s), peak used weight ${r.peakReportedUsedWeight ?? "unknown"}; ${(r.elapsedMs / 1000).toFixed(1)} s` +
          (r.completedAt === null ? " — DID NOT COMPLETE" : `, completed ${r.completedAt}`)
      );
    }
    this.assign(accepted);
    for (const connection of this.connections) this.connect(connection);
    this.started = true;
    if (this.dynamic) this.universeState.nextAtMs = this.deps.nowMs() + (this.config.dynamicUniverse as DynamicUniverseConfig).refreshIntervalMs;
  }

  private summarizeStartup(startedAtMs: number, before: GovernorMetrics, clockBefore: number, completed: boolean, peakReportedUsedWeight: number | null): StartupRecoverySummary {
    const workers = this.startupWorkers;
    const after = this.deps.governor.metrics;
    const ready = workers.filter((w) => w.status === "ATTACHED" && w.catchUp !== null);
    const policy = this.deps.recoveryFetch ?? null;
    return {
      policy: policy === null ? LEGACY_RECOVERY_POLICY : policy.version,
      symbols: workers.length,
      liveReady: ready.length,
      recovered: ready.filter((w) => w.catchUp?.status === "VERIFIED_AND_EXTENDED").length,
      current: ready.filter((w) => w.catchUp?.status === "VERIFIED_UNCHANGED").length,
      bootstrapped: ready.filter((w) => w.catchUp?.status === "CREATED").length,
      notLive: workers.length - ready.length,
      missingBarsReplayed: ready.filter((w) => w.catchUp?.status === "VERIFIED_AND_EXTENDED").reduce((sum, w) => sum + (w.catchUp?.bars ?? 0), 0),
      restRequests: after.requestsMade - before.requestsMade,
      restWeight: after.weightUsed - before.weightUsed,
      serverClockRequests: (policy?.serverClock.requests ?? 0) - clockBefore,
      maxRequestsInFlight: after.maxInFlightObserved,
      workerConcurrency: this.config.restConcurrency,
      weightWaits: after.weightWaits - before.weightWaits,
      usedWeightPauses: after.usedWeightPauses - before.usedWeightPauses,
      peakReportedUsedWeight,
      elapsedMs: this.deps.nowMs() - startedAtMs,
      completedAt: completed ? this.deps.nowIso() : null,
    };
  }

  /** The request savers for this run's fetches; empty (the original behaviour) without a recovery policy. */
  private fetchOptions(): ClosedKlineFetchOptions {
    const policy = this.deps.recoveryFetch ?? null;
    return policy === null ? {} : { serverClock: policy.serverClock, sizePagesToRange: policy.sizePagesToRange };
  }

  private newWorker(symbol: string, candidate: SupervisorCandidate | null = null): SymbolWorker {
    const worker: SymbolWorker = {
      symbol,
      connection: -1,
      dir: this.config.liveDirFor(symbol),
      status: "PENDING",
      failure: null,
      lock: null,
      session: null,
      channel: null,
      lineageId: null,
      bootstrapInputSha256: null,
      lastValidMessageAtMs: null,
      armedAtMs: 0,
      recoveryAttempts: 0,
      recoveryNotBeforeMs: 0,
      recoveryInFlight: false,
      counters: { observations: 0, commitsLive: 0, commitsQuarantined: 0, commitsReplayed: 0, refused: 0, ignoredWhileDetached: 0, recoveries: 0, laggedUpdates: 0, ignoredWhileInactive: 0 },
      generation: 0,
      identity: candidate?.identity ?? null,
      onboardDateMs: candidate?.onboardDateMs ?? null,
      origin: null,
      symbolHistoryOrigin: null,
      onboardDiscrepancyMs: null,
      bootstrapInFlight: false,
      bootstrapAttempts: 0,
      nextAttemptAtMs: 0,
      inactiveSinceMs: null,
      reactivating: false,
      joined: false,
      catchUp: null,
    };
    if (!this.started) this.startupWorkers.push(worker);
    return worker;
  }

  private contextStartMs(): number {
    const { lineage } = this.config;
    return deriveHtfContextStartMs(lineage.historyStartMs, lineage.engine.enabledSourceTfs, lineage.engine.calendar);
  }

  /**
   * The cheap negative pre-check. True only when Binance's listing time is
   * known, plausible (not in the future) and later than the context start by
   * more than the margin: such a symbol cannot hold contiguous data from the
   * context start. Unknown or implausible metadata never excludes anything.
   */
  private tooNew(candidate: SupervisorCandidate): boolean {
    // With a symbol history origin a listing is never "too new": its history starts at its own first bar.
    if (this.config.lineage.historyOrigin !== undefined) return false;
    const onboard = candidate.onboardDateMs;
    if (onboard === null || onboard > this.deps.nowMs()) return false;
    return onboard > this.contextStartMs() + (this.config.onboardPrecheckMarginMs ?? ONBOARD_PRECHECK_MARGIN_MS);
  }

  /** Runs canonical preparation, containing any failure to this symbol. */
  private async prepareContained(worker: SymbolWorker): Promise<void> {
    try {
      await this.prepare(worker);
    } catch (error) {
      // Whatever went wrong, it went wrong for this symbol only.
      this.fail(worker, "UNEXPECTED_ERROR", error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
    }
  }

  /** EXPLICIT: exactly the named symbols; an ineligible one stays visible as FAILED and is never replaced. */
  private async startExplicit(): Promise<SymbolWorker[]> {
    const workers = this.selection.candidates.map((c) => this.newWorker(c.symbol, c));
    await mapBounded(workers, this.config.restConcurrency, async (worker, i) => {
      const candidate = this.selection.candidates[i];
      if (this.tooNew(candidate)) {
        return this.fail(worker, "ONBOARD_AFTER_CONTEXT_START", `listed ${new Date(candidate.onboardDateMs as number).toISOString()}, after the HTF context start`);
      }
      await this.prepareContained(worker);
    });
    const tooNew = workers.filter((w) => w.failure?.startsWith("ONBOARD_AFTER_CONTEXT_START")).length;
    const insufficient = workers.filter((w) => w.failure !== null && /^(INSUFFICIENT_HISTORY|INSUFFICIENT_HTF_CONTEXT|INCOMPLETE_DATA)\b/.test(w.failure)).length;
    const failed = workers.filter((w) => w.status === "FAILED").length;
    this.selectionSummary = {
      mode: "EXPLICIT",
      universeActive: this.config.universeActive ?? null,
      targetEligible: null,
      candidatesTested: workers.length,
      acceptedEligible: workers.length - failed,
      skippedTooNew: tooNew,
      skippedInsufficientHistory: insufficient,
      skippedOther: failed - tooNew - insufficient,
      universeExhausted: true,
      skipped: [],
    };
    return workers;
  }

  /**
   * TARGET / ALL_ACTIVE: walk the candidates in order, a bounded chunk at a
   * time, and accept scanner-eligible symbols IN CANDIDATE ORDER, so the
   * accepted set never depends on which preparation finished first. A chunk is
   * never larger than what is still needed, so nothing is prepared and then
   * thrown away. Rejected candidates release their lock and never join.
   */
  private async walkCandidates(): Promise<SymbolWorker[]> {
    const selection = this.selection as Exclude<SupervisorSelection, { mode: "EXPLICIT" }>;
    const target = selection.mode === "TARGET" ? selection.target : null;
    const accepted: SymbolWorker[] = [];
    const skipped: { symbol: string; class: SkipClass; reason: string }[] = [];
    let tested = 0;
    let next = 0;
    let stop: string | null = null;
    while (next < selection.candidates.length && (target === null || accepted.length < target) && stop === null) {
      const room = target === null ? this.config.restConcurrency : Math.min(this.config.restConcurrency, target - accepted.length);
      const chunk = selection.candidates.slice(next, next + room);
      next += chunk.length;
      const workers = chunk.map((c) => this.newWorker(c.symbol, c));
      await mapBounded(workers, this.config.restConcurrency, async (worker, i) => {
        if (this.tooNew(chunk[i])) {
          worker.status = "FAILED";
          worker.failure = `TOO_NEW_PRECHECK: listed ${new Date(chunk[i].onboardDateMs as number).toISOString()}, too long after the HTF context start to hold its history`;
          return;
        }
        await this.prepareContained(worker);
      });
      // Decide strictly in candidate order.
      for (let i = 0; i < workers.length; i += 1) {
        const worker = workers[i];
        if (worker.status !== "FAILED") {
          tested += 1;
          accepted.push(worker);
          continue;
        }
        worker.lock?.release();
        worker.lock = null;
        const failure = worker.failure ?? "UNKNOWN";
        if (/^(REST_HALTED|REQUEST_BUDGET_EXHAUSTED)\b/.test(failure)) {
          stop = failure;
          // This candidate and the rest of its chunk are released and UNDECIDED: the walk ends here.
          for (const rest of workers.slice(i + 1)) rest.lock?.release();
          break;
        }
        tested += 1;
        const cls: SkipClass = failure.startsWith("TOO_NEW_PRECHECK")
          ? "TOO_NEW_PRECHECK"
          : /^(INSUFFICIENT_HISTORY|INSUFFICIENT_HTF_CONTEXT|INCOMPLETE_DATA)\b/.test(failure)
            ? "INSUFFICIENT_HISTORY"
            : "OTHER";
        skipped.push({ symbol: worker.symbol, class: cls, reason: failure });
        if (chunk[i].required) stop = `REQUIRED_SYMBOL_INELIGIBLE: ${worker.symbol} (${failure}) — an included symbol is never replaced`;
        if (stop !== null) {
          for (const rest of workers.slice(i + 1)) rest.lock?.release();
          break;
        }
      }
    }
    const summary: SelectionSummary = {
      mode: selection.mode,
      universeActive: this.config.universeActive ?? null,
      targetEligible: target,
      candidatesTested: tested,
      acceptedEligible: accepted.length,
      skippedTooNew: skipped.filter((s) => s.class === "TOO_NEW_PRECHECK").length,
      skippedInsufficientHistory: skipped.filter((s) => s.class === "INSUFFICIENT_HISTORY").length,
      skippedOther: skipped.filter((s) => s.class === "OTHER").length,
      universeExhausted: stop === null && next >= selection.candidates.length,
      skipped,
    };
    this.selectionSummary = summary;
    for (const s of skipped) this.deps.log(`${s.symbol} SKIPPED (${s.class}): ${s.reason} — not part of the running set`);
    if (stop !== null) {
      for (const worker of accepted) worker.lock?.release();
      throw new TargetNotReachedError(
        `TARGET_NOT_REACHED: ${stop}. ${target === null ? "The universe was not exhausted" : `${accepted.length} of ${target} eligible accepted`} after testing ${tested}; nothing was started`,
        { ...summary, requestsUsed: this.deps.governor.requestsMade, remainingUniverse: selection.candidates.length - tested }
      );
    }
    if (accepted.length === 0) {
      throw new TargetNotReachedError("TARGET_NOT_REACHED: no scanner-eligible symbol in the walked universe; nothing was started", {
        ...summary,
        requestsUsed: this.deps.governor.requestsMade,
        remainingUniverse: selection.candidates.length - tested,
      });
    }
    return accepted;
  }

  /**
   * DYNAMIC: every target symbol gets one worker and one bootstrap (bounded
   * concurrency, governed REST). Those that are live-ready form the running set
   * (deterministic assignment); the rest stay tracked members in their honest
   * state (waiting, unreadable, quarantined) and are retried by the refresh
   * loop — never "skipped forever". A REST halt or a spent budget leaves the
   * universe unknown: nothing is started.
   */
  private async startDynamic(): Promise<SymbolWorker[]> {
    const candidates = this.selection.candidates;
    const workers = candidates.map((c) => this.newWorker(c.symbol, c));
    await mapBounded(workers, this.config.restConcurrency, async (worker) => {
      worker.status = "BOOTSTRAPPING";
      worker.bootstrapAttempts += 1;
      await this.prepareContained(worker);
    });
    const halted = workers.find((w) => w.failure !== null && /^(REST_HALTED|REQUEST_BUDGET_EXHAUSTED)\b/.test(w.failure));
    const accepted = workers.filter((w) => w.status === "ATTACHED");
    const notAccepted = workers.filter((w) => w.status !== "ATTACHED");
    const classOf = (w: SymbolWorker): SkipClass =>
      w.failure !== null && /^(INSUFFICIENT_HISTORY|INSUFFICIENT_HTF_CONTEXT|INCOMPLETE_DATA)\b/.test(w.failure) ? "INSUFFICIENT_HISTORY" : "OTHER";
    const skipped = notAccepted.map((w) => ({ symbol: w.symbol, class: classOf(w), reason: `${w.status}: ${w.failure ?? "unknown"}` }));
    const summary: SelectionSummary = {
      mode: "ALL_ACTIVE",
      universeActive: this.config.universeActive ?? null,
      targetEligible: null,
      candidatesTested: workers.length,
      acceptedEligible: accepted.length,
      skippedTooNew: 0,
      skippedInsufficientHistory: skipped.filter((x) => x.class === "INSUFFICIENT_HISTORY").length,
      skippedOther: skipped.filter((x) => x.class === "OTHER").length,
      universeExhausted: halted === undefined,
      skipped,
    };
    this.selectionSummary = summary;
    if (halted !== undefined || accepted.length === 0) {
      for (const worker of workers) worker.lock?.release();
      throw new TargetNotReachedError(
        halted !== undefined
          ? `TARGET_NOT_REACHED: ${halted.failure as string}. The universe was not exhausted; nothing was started`
          : "TARGET_NOT_REACHED: no scanner-eligible symbol in the universe; nothing was started",
        { ...summary, requestsUsed: this.deps.governor.requestsMade, remainingUniverse: notAccepted.length }
      );
    }
    for (const s of skipped) this.deps.log(`${s.symbol} NOT YET LIVE (${s.reason}) — tracked; retried by the dynamic universe`);
    for (const worker of notAccepted) this.workers.set(worker.symbol, worker);
    for (const worker of accepted) worker.joined = true;
    return accepted;
  }

  /** The running set is known: deterministic assignment, connections, stream routing. */
  private assign(workers: readonly SymbolWorker[]): void {
    const groups = assignConnections(
      workers.map((w) => w.symbol),
      this.config.symbolsPerConnection,
      this.config.maxConnections
    );
    const byName = new Map(workers.map((w) => [w.symbol, w]));
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
      rebuilds: 0,
    }));
    groups.forEach((symbols, index) => {
      for (const symbol of symbols) {
        const worker = byName.get(symbol) as SymbolWorker;
        worker.connection = index;
        worker.joined = true;
        this.workers.set(symbol, worker);
        this.streamToSymbol.set(klineStreamNameOf(symbol, this.config.lineage.chartInterval), symbol);
      }
    });
  }

  private fail(worker: SymbolWorker, code: string, detail: string): void {
    worker.status = "FAILED";
    worker.failure = `${code}: ${detail}`;
    worker.session?.onDisconnect();
    this.deps.log(`${worker.symbol} FAILED ${code}: ${detail}`);
  }

  /**
   * A non-final outcome of a dynamic bootstrap: retried later in its honest
   * state. Outside a dynamic universe there is no retry, so it is a FAILED
   * symbol exactly as before.
   */
  private defer(worker: SymbolWorker, status: "WAITING_FIRST_CLOSED_BAR" | "BOOTSTRAP_UNREADABLE" | "QUARANTINED", code: string, detail: string, retryAtMs: number): void {
    if (!this.dynamic) return this.fail(worker, code, detail);
    worker.status = status;
    worker.failure = `${code}: ${detail}`;
    worker.nextAttemptAtMs = retryAtMs;
    this.deps.log(`${worker.symbol} ${status} ${code}: ${detail}${Number.isFinite(retryAtMs) ? ` — retry from ${new Date(retryAtMs).toISOString()}` : " — not retried automatically"}`);
  }

  private unreadableRetryAt(worker: SymbolWorker): number {
    return this.deps.nowMs() + BOOTSTRAP_RETRY_DELAYS_MS[Math.min(Math.max(worker.bootstrapAttempts - 1, 0), BOOTSTRAP_RETRY_DELAYS_MS.length - 1)];
  }

  /** True when async work begun under `token` must not land: the symbol moved on, or the supervisor stopped. */
  private isStale(worker: SymbolWorker, token: number): boolean {
    return this.stopped || worker.generation !== token;
  }

  private async prepare(worker: SymbolWorker): Promise<void> {
    const { lineage } = this.config;
    const token = worker.generation;
    if (worker.lock === null) {
      try {
        worker.lock = this.deps.acquireLock(worker.dir);
      } catch (error) {
        if (error instanceof ScannerLockError) return this.fail(worker, error.code, error.message);
        throw error;
      }
    }
    let contextStartMs = this.contextStartMs();
    // Every bar before the one forming now (less the settle margin) is closed: the single-symbol CLI's rule.
    const boundaryMs = Math.floor((this.deps.nowMs() - REPLAY_SETTLE_MS) / this.intervalMs) * this.intervalMs;
    let origin: SymbolOriginInput | null = null;
    if (lineage.historyOrigin !== undefined) {
      // Where this symbol's REAL history begins: from public klines, never the listing date alone.
      let probe;
      try {
        probe = await probeSymbolHistoryOrigin({
          symbol: worker.symbol,
          chartInterval: lineage.chartInterval,
          contextStartMs,
          onboardDateMs: worker.onboardDateMs,
          cache: this.deps.cache,
          fetchDeps: this.deps.fetchDeps,
          settleMs: REPLAY_SETTLE_MS,
          ...(this.deps.recoveryFetch == null ? {} : { serverClock: this.deps.recoveryFetch.serverClock }),
        });
      } catch (error) {
        if (this.isStale(worker, token)) return;
        if (this.deps.governor.halt !== null) return this.fail(worker, "REST_HALTED", this.deps.governor.halt.message);
        if (error instanceof ScannerDataError && error.code === "REQUEST_BUDGET_EXHAUSTED") return this.fail(worker, "REQUEST_BUDGET_EXHAUSTED", error.message);
        throw error;
      }
      if (this.isStale(worker, token)) return;
      if (probe.kind === "WAITING_FIRST_CLOSED_BAR") return this.defer(worker, "WAITING_FIRST_CLOSED_BAR", "WAITING_FIRST_CLOSED_BAR", probe.detail, probe.retryAtMs);
      if (probe.kind === "UNREADABLE") return this.defer(worker, "BOOTSTRAP_UNREADABLE", "BOOTSTRAP_UNREADABLE", probe.detail, this.unreadableRetryAt(worker));
      origin = probe.origin;
      worker.origin = origin;
      worker.onboardDiscrepancyMs = probe.onboardDiscrepancyMs;
      if (probe.onboardDiscrepancyMs !== null) {
        this.deps.log(`${worker.symbol} ONBOARD_DISCREPANCY: first real closed bar is ${probe.onboardDiscrepancyMs / 60_000} min from the exchangeInfo onboardDate; the real bar is used`);
      }
      const ranges = effectiveHistoryRanges({ historyStartMs: lineage.historyStartMs, compatibilitySwitchoverMs: lineage.switchoverMs, htfContextStartMs: contextStartMs, intervalMs: this.intervalMs, origin });
      contextStartMs = ranges.effectiveContextStartMs;
      if (!(boundaryMs > ranges.effectiveSwitchoverMs)) {
        // The lineage needs one history bar and the live checkpoint one closed causal bar after it.
        const readyAt = ranges.effectiveSwitchoverMs + this.intervalMs + REPLAY_SETTLE_MS;
        return this.defer(worker, "WAITING_FIRST_CLOSED_BAR", "WAITING_FIRST_CLOSED_BAR", `needs a closed bar after ${new Date(ranges.effectiveSwitchoverMs - this.intervalMs).toISOString()}`, readyAt);
      }
    }
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
        fetchOptions: this.fetchOptions(),
      });
    } catch (error) {
      if (this.isStale(worker, token)) return;
      if (this.deps.governor.halt !== null) return this.fail(worker, "REST_HALTED", this.deps.governor.halt.message);
      throw error;
    }
    if (this.isStale(worker, token)) return;
    if (filled.kind === "SKIP") {
      if (origin !== null) {
        // From the symbol's own origin, missing bars are a REAL post-origin gap (quarantine) or an unreadable fetch (retry).
        if (filled.reason === "INCOMPLETE_DATA" || filled.reason === "INSUFFICIENT_HISTORY" || filled.reason === "CACHE_UNUSABLE") {
          return this.defer(worker, "QUARANTINED", filled.reason, filled.detail, this.deps.nowMs() + QUARANTINE_RETRY_MS);
        }
        if (filled.reason === "PUBLIC_FETCH_FAILED") return this.defer(worker, "BOOTSTRAP_UNREADABLE", "BOOTSTRAP_UNREADABLE", filled.detail, this.unreadableRetryAt(worker));
      }
      return this.fail(worker, filled.reason, filled.detail);
    }

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
          ...(lineage.historyOrigin === undefined ? {} : { historyOrigin: lineage.historyOrigin, symbolOrigin: origin }),
        },
        boundaryMs,
        checkpoints.load()
      );
      // Defence in depth: a lineage of another engine can never join this run (or touch its checkpoint).
      const lineageEngine = engineFingerprintOfLineage(plan.lineage);
      if (lineageEngine !== this.engineFingerprint) {
        return this.fail(worker, "ENGINE_FINGERPRINT_MISMATCH", `lineage ${plan.lineageId} belongs to engine ${lineageEngine}, not ${this.engineFingerprint}`);
      }
      // The last fence before anything durable: a removed, re-added or stopped symbol never writes a checkpoint.
      if (this.isStale(worker, token)) return;
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
      worker.bootstrapInputSha256 = plan.lineage.bootstrapInputSha256;
      worker.symbolHistoryOrigin = plan.lineage.symbolHistoryOrigin ?? null;
      worker.failure = null;
      worker.catchUp = { status: plan.checkpointStatus, bars: plan.catchUp.bars };
      worker.channel = new SymbolStreamChannel({ session, log: (line) => this.symbolLog(worker, line) });
      worker.status = "ATTACHED";
      this.deps.log(`${worker.symbol} CATCHUP_OK lineage ${plan.lineageId.slice(0, 12)} checkpoint ${plan.checkpointStatus} hwm ${new Date(plan.hwmOpenTimeMs).toISOString()} replayed ${plan.catchUp.bars} bar(s) NON_ACTIONABLE`);
    } catch (error) {
      if (error instanceof LiveShadowError || error instanceof CompatReplayError || error instanceof KlineCacheError || error instanceof ScannerDataError) {
        // From its own origin, a refused rebuild is a history problem: quarantined, never guessed around.
        if (origin !== null) return this.defer(worker, "QUARANTINED", error.code, error.message, this.deps.nowMs() + QUARANTINE_RETRY_MS);
        return this.fail(worker, error.code, error.message);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Connections
  // ---------------------------------------------------------------------------

  private attachedSymbols(connection: Connection): string[] {
    return connection.symbols.filter((s) => {
      const status = (this.workers.get(s) as SymbolWorker).status;
      return status !== "FAILED" && status !== "INACTIVE" && status !== "QUARANTINED";
    });
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
    if (worker !== undefined && worker.status === "INACTIVE") {
      // The generation fence for removed symbols: a late message on the old subscription is never applied.
      worker.counters.ignoredWhileInactive += 1;
      return;
    }
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
    const token = worker.generation;
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
              }, this.fetchOptions())
            ).klines
          : [];
      // Removed, re-added or stopped meanwhile: nothing lands (no commit, no re-attachment).
      if (this.isStale(worker, token) || worker.status !== "RECOVERING") return;
      const records = session.recoverClosedBars(bars);
      worker.counters.commitsReplayed += records.length;
      for (const record of records) worker.channel?.logCommit(record);
      worker.counters.recoveries += 1;
      worker.status = "ATTACHED";
      worker.reactivating = false;
      this.arm(worker);
      this.deps.log(`${worker.symbol} RECOVERED ${records.length} closed bar(s) NON_ACTIONABLE; re-armed: its current bar will be QUARANTINED`);
    } catch (error) {
      if (this.isStale(worker, token)) return;
      if (this.deps.governor.halt !== null) return this.fail(worker, "REST_HALTED", this.deps.governor.halt.message);
      if (worker.reactivating && error instanceof LiveShadowError && error.code === "RECOVERY_REQUIRED") {
        // The returning symbol's bars do not continue from its preserved high-water mark: a real gap. Never bridged.
        worker.reactivating = false;
        return this.quarantine(worker, "HISTORY_GAP_ACROSS_INACTIVITY", error.message, this.deps.nowMs() + QUARANTINE_RETRY_MS);
      }
      const why = error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
      if (worker.recoveryAttempts >= this.config.maxRecoveryAttempts) return this.fail(worker, "RECOVERY_FAILED", why);
      worker.recoveryNotBeforeMs = this.deps.nowMs() + RECOVERY_RETRY_MS;
      this.deps.log(`${worker.symbol} recovery attempt ${worker.recoveryAttempts} failed (${why}); retrying`);
    } finally {
      worker.recoveryInFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Dynamic universe: refresh, bootstrap, placement, removal, reactivation
  // ---------------------------------------------------------------------------

  private bootstrapDue(worker: SymbolWorker, now: number): boolean {
    if (worker.bootstrapInFlight || now < worker.nextAttemptAtMs) return false;
    return worker.status === "PENDING" || worker.status === "WAITING_FIRST_CLOSED_BAR" || worker.status === "BOOTSTRAP_UNREADABLE" || worker.status === "QUARANTINED";
  }

  /** One bootstrap of one symbol. At most one is in flight per symbol; a stale one never lands. */
  private async bootstrap(worker: SymbolWorker): Promise<void> {
    const token = worker.generation;
    worker.bootstrapInFlight = true;
    worker.bootstrapAttempts += 1;
    worker.status = "BOOTSTRAPPING";
    try {
      await this.prepare(worker);
    } catch (error) {
      if (!this.isStale(worker, token)) this.fail(worker, "UNEXPECTED_ERROR", error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
    } finally {
      worker.bootstrapInFlight = false;
    }
    if (this.isStale(worker, token)) return;
    // prepare() moved the status on (narrowing does not see through the await).
    if ((worker.status as SymbolStatus) === "ATTACHED") {
      worker.bootstrapAttempts = 0;
      this.deps.log(`${worker.symbol} BOOTSTRAPPED (${worker.origin?.kind ?? "PROFILE"}${worker.origin?.firstClosedBarOpenTimeMs != null ? ` from ${new Date(worker.origin.firstClosedBarOpenTimeMs).toISOString()}` : ""}): awaiting placement; history replay delivered nothing`);
    }
  }

  /** The connection a new symbol joins: room left, fewest symbols (fewest neighbours disturbed), lowest index; else a new one under the ceiling. */
  private connectionWithRoom(): Connection | null {
    let best: Connection | null = null;
    for (const c of this.connections) {
      if (c.symbols.length >= this.config.symbolsPerConnection) continue;
      if (best === null || c.symbols.length < best.symbols.length) best = c;
    }
    if (best !== null) return best;
    if (this.connections.length >= this.config.maxConnections) return null;
    const created: Connection = {
      index: this.connections.length,
      symbols: [],
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
      rebuilds: 0,
    };
    this.connections.push(created);
    return created;
  }

  /** Live-ready symbols not yet on a connection join one; each touched connection is rebuilt once. */
  private placePending(): void {
    if (this.stopped) return;
    const pending = [...this.workers.values()].filter((w) => w.status === "ATTACHED" && w.connection === -1).sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    if (pending.length === 0) return;
    const touched = new Map<Connection, Set<string>>();
    for (const worker of pending) {
      const connection = this.connectionWithRoom();
      if (connection === null) {
        // Unreachable while admission checks capacity; kept fail-closed and visible all the same.
        this.universeState.capacityExceeded = true;
        this.deps.log(`${worker.symbol} NOT PLACED: every connection is full (${this.config.maxConnections} x ${this.config.symbolsPerConnection}); CAPACITY_EXCEEDED`);
        break;
      }
      connection.symbols.push(worker.symbol);
      connection.symbols.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      worker.connection = connection.index;
      this.streamToSymbol.set(klineStreamNameOf(worker.symbol, this.config.lineage.chartInterval), worker.symbol);
      const kind = worker.joined ? "REACTIVATED" : "JOINED";
      worker.joined = true;
      this.recordChange(kind, worker, null);
      if (!touched.has(connection)) touched.set(connection, new Set());
      (touched.get(connection) as Set<string>).add(worker.symbol);
    }
    for (const [connection, added] of touched) this.rebuild(connection, added);
  }

  /**
   * A CONTROLLED rebuild of one connection whose subscription set changed: the
   * old socket is closed and fenced off (generation), every symbol that was live
   * on it detaches and recovers its own closed gap by REST (none when no bar
   * closed meanwhile), and the new socket re-establishes readiness per symbol —
   * so the bar in progress is quarantined and no closed bar is lost or applied
   * twice (the session sequences closed bars by open time). It is not a
   * failure: no backoff, no failure count.
   */
  private rebuild(connection: Connection, added: ReadonlySet<string>): void {
    if (connection.socket === null) {
      // Idle: just connect. Closed and waiting out a backoff: the next reconnect carries the new set.
      if (connection.lifecycle === "IDLE") this.connect(connection);
      return;
    }
    const socket = connection.socket;
    connection.socket = null;
    connection.generation += 1;
    connection.lifecycle = "CLOSED";
    connection.queue.length = 0;
    connection.rebuilds += 1;
    socket.close();
    for (const symbol of connection.symbols) {
      if (added.has(symbol)) continue;
      const worker = this.workers.get(symbol) as SymbolWorker;
      if (worker.status === "ATTACHED") this.detach(worker, `connection ${connection.index} rebuilt to add ${[...added].join(",")}`);
    }
    this.deps.log(`connection ${connection.index} REBUILD (+${[...added].join(",")}): neighbours re-establish readiness; closed gaps recover by REST`);
    this.connect(connection);
  }

  /** Takes a symbol off its connection (subscription dropped at the next connect; an emptied connection closes). */
  private unplace(worker: SymbolWorker): void {
    if (worker.connection < 0) return;
    const connection = this.connections[worker.connection];
    connection.symbols = connection.symbols.filter((s) => s !== worker.symbol);
    worker.connection = -1;
    if (this.attachedSymbols(connection).length === 0 && connection.socket !== null) {
      const socket = connection.socket;
      connection.socket = null;
      connection.generation += 1;
      connection.queue.length = 0;
      connection.lifecycle = "IDLE";
      socket.close();
    }
  }

  /** Left the target universe: no new observations; checkpoint, evidence and lock kept; nothing deleted. */
  private deactivate(worker: SymbolWorker, reason: string): void {
    worker.generation += 1;
    this.unplace(worker);
    worker.session?.onDisconnect();
    worker.status = "INACTIVE";
    worker.failure = reason;
    worker.inactiveSinceMs = this.deps.nowMs();
    worker.reactivating = false;
    if (worker.joined) this.recordChange("INACTIVE", worker, reason);
    this.deps.log(`${worker.symbol} INACTIVE (${reason}): no longer scanned; checkpoint and evidence preserved`);
  }

  private quarantine(worker: SymbolWorker, code: string, detail: string, retryAtMs: number): void {
    worker.generation += 1;
    this.unplace(worker);
    worker.session?.onDisconnect();
    // A quarantined session is never reused: a later attempt rebuilds and re-verifies from the data.
    worker.session = null;
    worker.channel = null;
    worker.status = "QUARANTINED";
    worker.failure = `${code}: ${detail}`;
    worker.nextAttemptAtMs = retryAtMs;
    if (worker.joined) this.recordChange("QUARANTINED", worker, `${code}: ${detail}`);
    this.deps.log(`${worker.symbol} QUARANTINED ${code}: ${detail}`);
  }

  /** Returned to the target universe: the same contract resumes its own session (catching up its closed bars); a different one is quarantined. */
  private reactivate(worker: SymbolWorker, identity: ContractIdentity): void {
    if (worker.identity !== null && !sameIdentity(worker.identity, identity)) {
      this.universeState.identityConflicts.push(worker.symbol);
      return this.quarantine(worker, "IDENTITY_CONFLICT", "the returning contract's exchangeInfo identity differs from the one scanned", Number.POSITIVE_INFINITY);
    }
    worker.generation += 1;
    worker.identity = identity;
    worker.inactiveSinceMs = null;
    worker.failure = null;
    if (worker.session !== null) {
      worker.status = "RECOVERING";
      worker.reactivating = true;
      worker.recoveryAttempts = 0;
      worker.recoveryNotBeforeMs = 0;
    } else {
      worker.status = "PENDING";
      worker.nextAttemptAtMs = 0;
    }
    this.universeState.reactivated.push(worker.symbol);
    this.deps.log(`${worker.symbol} RETURNED to the universe: ${worker.session !== null ? "its preserved session catches up" : "bootstrapping"}`);
  }

  private recordChange(kind: MembershipChange["kind"], worker: SymbolWorker, reason: string | null): void {
    try {
      this.deps.recordMembership?.({
        kind,
        symbol: worker.symbol,
        lineageId: worker.lineageId,
        bootstrapInputSha256: worker.bootstrapInputSha256,
        symbolHistoryOrigin: worker.symbolHistoryOrigin,
        reason,
        at: this.deps.nowIso(),
      });
    } catch (error) {
      // The journal is how the emitter learns of joins; a failure is loud, never silent.
      this.deps.log(`${worker.symbol} MEMBERSHIP JOURNAL WRITE FAILED (${error instanceof Error ? error.name : "unknown"}): ${kind} not recorded`);
    }
  }

  /**
   * One universe refresh: one public exchangeInfo request, never two at once,
   * never before start-up completed, never landing after stop. A failure, an
   * empty universe or an implausible mass removal keeps the last-known-good
   * universe (nothing evicted) and is reported.
   */
  async refreshUniverse(): Promise<void> {
    if (!this.dynamic || this.stopped || !this.started) return;
    const state = this.universeState;
    if (state.inFlight) {
      state.suppressed += 1;
      return;
    }
    state.inFlight = true;
    const generation = ++state.generation;
    const now = this.deps.nowMs();
    state.lastAttemptAtMs = now;
    state.nextAtMs = now + (this.config.dynamicUniverse as DynamicUniverseConfig).refreshIntervalMs;
    try {
      let universe: UsdmUniverse;
      try {
        universe = await (this.deps.fetchUniverse as () => Promise<UsdmUniverse>)();
      } catch (error) {
        if (this.stopped || generation !== state.generation) return;
        state.failures += 1;
        state.consecutiveFailures += 1;
        state.lastResult = "FAILED";
        state.lastError = error instanceof Error ? `${error.name}${"code" in error ? ` ${String((error as { code: unknown }).code)}` : ""}: ${error.message}` : "unknown";
        this.deps.log(`UNIVERSE REFRESH FAILED (${state.lastError}): the last-known-good universe is kept; retry in ${Math.round((state.nextAtMs - now) / 1000)}s`);
        return;
      }
      if (this.stopped || generation !== state.generation) return;
      this.applyUniverse(universe);
    } finally {
      state.inFlight = false;
    }
  }

  private applyUniverse(universe: UsdmUniverse): void {
    const state = this.universeState;
    const target = new Map(universe.contracts.map((c) => [c.symbol, c]));
    const members = [...this.workers.values()].filter((w) => w.status !== "INACTIVE" && w.status !== "FAILED");
    if (target.size === 0) {
      state.failures += 1;
      state.consecutiveFailures += 1;
      state.lastResult = "REJECTED_EMPTY";
      state.lastError = "exchangeInfo listed no target symbol; refusing to treat that as an empty universe";
      this.deps.log(`UNIVERSE REFRESH REJECTED: ${state.lastError}; nothing evicted`);
      return;
    }
    const leaving = members.filter((w) => !target.has(w.symbol));
    const limit = Math.max(MASS_REMOVAL_GUARD.min, Math.ceil(MASS_REMOVAL_GUARD.fraction * members.length));
    if (leaving.length > limit) {
      state.failures += 1;
      state.consecutiveFailures += 1;
      state.lastResult = "REJECTED_MASS_REMOVAL";
      state.lastError = `the refresh would remove ${leaving.length} of ${members.length} symbols at once (limit ${limit}); treated as implausible`;
      this.deps.log(`UNIVERSE REFRESH REJECTED: ${state.lastError}; nothing evicted`);
      return;
    }
    const capacity = this.config.symbolsPerConnection * this.config.maxConnections;
    state.capacityRequired = target.size;
    state.capacityExceeded = target.size > capacity;
    state.exchangeCandidates = target.size;
    state.added = [];
    state.removed = [];
    state.reactivated = [];
    state.identityConflicts = [];
    state.notAdmitted = [];
    for (const worker of leaving) {
      state.removed.push(worker.symbol);
      this.deactivate(worker, "left the target universe (not TRADING + PERPETUAL + USDT in exchangeInfo)");
    }
    for (const contract of universe.contracts) {
      const identity = contractIdentityOf(contract);
      const worker = this.workers.get(contract.symbol);
      if (worker === undefined || worker.status === "INACTIVE") {
        if (state.capacityExceeded) {
          // Fail closed: nobody new is admitted while the universe does not fit; reported, never truncated silently.
          state.notAdmitted.push(contract.symbol);
          continue;
        }
        if (worker !== undefined) {
          this.reactivate(worker, identity);
          continue;
        }
        const created = this.newWorker(contract.symbol, { symbol: contract.symbol, onboardDateMs: contract.onboardDateMs, required: false, identity });
        this.workers.set(contract.symbol, created);
        state.added.push(contract.symbol);
        this.deps.log(`${contract.symbol} DISCOVERED by universe refresh ${state.generation}: bootstrap scheduled`);
        continue;
      }
      if (worker.status === "FAILED") continue;
      if (worker.identity !== null && !sameIdentity(worker.identity, identity)) {
        state.identityConflicts.push(worker.symbol);
        this.quarantine(worker, "IDENTITY_CONFLICT", "exchangeInfo now describes a different contract under this symbol", Number.POSITIVE_INFINITY);
      }
    }
    if (state.capacityExceeded) {
      this.deps.log(`CAPACITY_EXCEEDED: the universe holds ${target.size} target symbols, the ceiling is ${capacity}; ${state.notAdmitted.length} not admitted — ALL ACTIVE is NOT satisfied`);
    }
    state.refreshes += 1;
    state.consecutiveFailures = 0;
    state.lastResult = "OK";
    state.lastError = null;
    state.lastSuccessAtMs = this.deps.nowMs();
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
    const inFlight = [...this.workers.values()].filter((w) => w.recoveryInFlight || w.bootstrapInFlight).length;
    for (const worker of this.workers.values()) {
      if (started.length + inFlight >= this.config.restConcurrency) break;
      if (worker.status !== "RECOVERING" || worker.recoveryInFlight || now < worker.recoveryNotBeforeMs) continue;
      started.push(this.recover(worker));
    }
    if (this.dynamic && this.started) {
      // Bootstraps share the same bound; one in flight per symbol, at most.
      for (const worker of [...this.workers.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))) {
        if (started.length + inFlight >= this.config.restConcurrency) break;
        if (!this.bootstrapDue(worker, now)) continue;
        started.push(this.bootstrap(worker));
      }
      this.placePending();
      if (!this.universeState.inFlight && now >= this.universeState.nextAtMs) started.push(this.refreshUniverse());
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
    // From here: no refresh, no bootstrap and no recovery can land (generation/stop fences), and none is scheduled.
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

  /** The running set with each symbol's lineage, for the run manifest. Symbols that never prepared are not in it. */
  acceptedSymbols(): RunManifestSymbol[] {
    return [...this.workers.values()]
      .filter((w) => w.lineageId !== null && w.bootstrapInputSha256 !== null && w.joined)
      .map((w) => ({
        symbol: w.symbol,
        lineageId: w.lineageId as string,
        bootstrapInputSha256: w.bootstrapInputSha256 as string,
        ...(w.symbolHistoryOrigin === null ? {} : { symbolHistoryOrigin: w.symbolHistoryOrigin }),
      }))
      .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  }

  /** Observation only. `stale`: no successful refresh for two intervals (or never, past the first). */
  universeStatus(now: number = this.deps.nowMs()) {
    const st = this.universeState;
    const interval = (this.config.dynamicUniverse as DynamicUniverseConfig | null | undefined)?.refreshIntervalMs ?? null;
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const capacity = this.config.symbolsPerConnection * this.config.maxConnections;
    const lastGood = st.lastSuccessAtMs ?? (this.started ? Date.parse(this.startedAt) : null);
    return {
      lifecycle: "DYNAMIC_UNIVERSE_V1" as const,
      refreshIntervalMs: interval,
      generation: st.generation,
      inFlight: st.inFlight,
      lastAttemptAt: iso(st.lastAttemptAtMs),
      lastSuccessAt: iso(st.lastSuccessAtMs),
      lastResult: st.lastResult,
      lastError: st.lastError,
      consecutiveFailures: st.consecutiveFailures,
      stale: interval !== null && lastGood !== null && now - lastGood > 2 * interval,
      nextRefreshAt: this.started && !this.stopped ? iso(st.nextAtMs) : null,
      refreshes: st.refreshes,
      refreshFailures: st.failures,
      refreshesSuppressed: st.suppressed,
      exchangeCandidates: st.exchangeCandidates ?? this.config.universeActive ?? null,
      latest: { added: [...st.added], removed: [...st.removed], reactivated: [...st.reactivated], identityConflicts: [...st.identityConflicts], notAdmitted: [...st.notAdmitted] },
      capacity: {
        symbolsPerConnection: this.config.symbolsPerConnection,
        maxConnections: this.config.maxConnections,
        available: capacity,
        required: st.capacityRequired ?? this.selection.candidates.length,
        exceeded: st.capacityExceeded,
        /** ALL ACTIVE is claimed only while every target symbol fits. */
        allActiveSatisfied: !st.capacityExceeded,
      },
    };
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
        w.status !== "ATTACHED" || session === null
          ? w.status
          : w.connection < 0
            ? "AWAITING_PLACEMENT"
            : session.phase === "READY"
              ? session.barStatus(formingBar)
              : session.phase === "RECOVERY_REQUIRED"
                ? "RECOVERY_REQUIRED"
                : "AWAITING_STREAM";
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
        ...(this.dynamic
          ? {
              stateDir: symbolPathSegment(w.symbol),
              origin: w.origin,
              onboardDiscrepancyMs: w.onboardDiscrepancyMs,
              nextAttemptAt: w.nextAttemptAtMs > now && Number.isFinite(w.nextAttemptAtMs) ? new Date(w.nextAttemptAtMs).toISOString() : null,
              inactiveSince: w.inactiveSinceMs === null ? null : new Date(w.inactiveSinceMs).toISOString(),
            }
          : {}),
      };
    });
    const count = (pred: (s: (typeof symbols)[number]) => boolean) => symbols.filter(pred).length;
    return {
      schema: "teddy.native-scanner.live-shadow-supervisor-status.v3",
      notice: ["SHADOW ONLY", "NO ALERT AUTHORITY", "NO ORDER AUTHORITY"],
      actionable: false as const,
      runId: this.config.runId ?? null,
      runState: this.stopped ? ("STOPPED" as const) : ("RUNNING" as const),
      startedAt: this.startedAt,
      interval: this.config.lineage.chartInterval,
      engineFingerprint: this.engineFingerprint,
      /** Profile identity and policy summaries (null for a legacy explicit-flag run). Future execution policy is modelling only. */
      profile: this.config.profile ?? null,
      /** How the running set was chosen. Skipped candidates never joined and are not runtime failures. */
      selection: this.selectionSummary,
      recovery: this.startupRecovery,
      totals: {
        selected: count((s) => s.connection >= 0),
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
        // Observation only (the governor's lifetime metrics): nothing reads these to decide anything.
        restWeight: this.deps.governor.metrics.weightUsed,
        restWeightWaits: this.deps.governor.metrics.weightWaits,
        restUsedWeightPauses: this.deps.governor.metrics.usedWeightPauses,
        restPeakReportedUsedWeight: this.deps.governor.metrics.peakReportedUsedWeight,
        restHalted: this.deps.governor.halt !== null,
        ...(this.dynamic
          ? {
              bootstrapping: count((s) => s.status === "BOOTSTRAPPING"),
              waitingFirstClosedBar: count((s) => s.status === "WAITING_FIRST_CLOSED_BAR"),
              bootstrapUnreadable: count((s) => s.status === "BOOTSTRAP_UNREADABLE"),
              quarantinedHistory: count((s) => s.status === "QUARANTINED"),
              inactive: count((s) => s.status === "INACTIVE"),
              awaitingPlacement: count((s) => s.readiness === "AWAITING_PLACEMENT"),
              ignoredWhileInactive: symbols.reduce((n, s) => n + s.counters.ignoredWhileInactive, 0),
              connectionsOpen: this.connections.filter((c) => c.socket !== null).length,
              connectionRebuilds: this.connections.reduce((n, c) => n + c.rebuilds, 0),
            }
          : {}),
      },
      /** Dynamic universe telemetry (null for a run whose universe is fixed at start-up). */
      universe: this.dynamic ? this.universeStatus(now) : null,
      connections: this.connections.map((c) => ({
        index: c.index,
        lifecycle: c.lifecycle,
        assigned: c.symbols.length,
        rebuilds: c.rebuilds,
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
export type UniverseRefreshStatus = ReturnType<LiveShadowSupervisor["universeStatus"]>;

/** live-shadow/<market>/<symbol>/<interval> under the scanner root — the single-symbol layout (symbol path-encoded, ASCII unchanged). */
export const liveShadowDir = (scannerRoot: string, symbol: string, interval: string) => path.join(scannerRoot, "live-shadow", SCANNER_MARKET_TYPE, symbolPathSegment(symbol), interval);
