import type { AlwaysOnPolicy } from "./always-on-contract";

/**
 * HEALTH, judged from the evidence the monitoring processes ALREADY publish:
 * the scanner's status.json, the emitter's status-commit.json, and the generic
 * backend's read-only GETs (planner status, soak health). Pure: callers read
 * the files and the HTTP answers; nothing here starts, stops or changes
 * anything, and nothing here opens a database, Redis or Binance client.
 *
 * Two rules run through every judge:
 *
 *  - A process being alive is never health. A status counts only when its own
 *    `pid` is a runtime inside the tree the supervisor owns — so a stale file
 *    left by a previous run, or a file written by somebody else's process, can
 *    never vouch for the current one.
 *  - Nothing is compared with a fixed universe size. Binance's active
 *    membership changes legitimately (524 → 522 is healthy); what must hold is
 *    that the scanner's CURRENT selection is coherent and fresh.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A trustworthy instant (not in the future beyond a minute of clock skew), or null. */
function instantOf(value: unknown, nowMs: number): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms <= nowMs + 60_000 ? ms : null;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export type ScannerVerdict =
  /** Coherent, fresh, every selected symbol live. */
  | "HEALTHY"
  /** Coherent and fresh, some symbols quarantined for the current bar (normal after a start or reconnect). */
  | "WARMING"
  /** Ours and running, but something required for health does not hold. */
  | "DEGRADED"
  /** No status from OUR scanner yet (starting up, or the file belongs to another process or run). */
  | "AWAITING_STATUS"
  /** Our scanner reported that its run stopped. */
  | "STOPPED";

export type ScannerIssueCode =
  | "STATUS_STALE"
  | "UNIVERSE_STALE"
  | "CAPACITY_EXCEEDED"
  | "SYMBOLS_FAILED"
  | "SYMBOLS_RECOVERING"
  | "AWAITING_STREAM"
  | "CATCHUP_PENDING"
  | "MEMBERSHIP_INCONSISTENT"
  | "NO_SYMBOLS_SELECTED"
  | "MARKET_DATA_STALE"
  | "REST_HALTED";

export interface ScannerIssue {
  readonly code: ScannerIssueCode;
  readonly detail: string;
}

export interface ScannerHealth {
  readonly verdict: ScannerVerdict;
  readonly issues: readonly ScannerIssue[];
  /** The status's own pid is a runtime in the owned scanner tree. */
  readonly ours: boolean;
  readonly runId: string | null;
  readonly runState: string | null;
  readonly engineFingerprint: string | null;
  readonly startedAt: string | null;
  readonly writtenAt: string | null;
  readonly ageSeconds: number | null;
  readonly universe: {
    readonly exchangeCandidates: number | null;
    readonly generation: number | null;
    readonly stale: boolean | null;
    readonly capacityExceeded: boolean | null;
    readonly selected: number | null;
    readonly liveEligible: number | null;
    readonly quarantined: number | null;
    readonly failed: number | null;
    readonly recovering: number | null;
    readonly awaitingStream: number | null;
    /**
     * Of those, the ones awaiting their first update on a connection that IS delivering: quiet symbols, owned
     * by the scanner's own per-symbol stale timeout. Null when the status carries no per-symbol detail.
     */
    readonly awaitingStreamQuiet: number | null;
    readonly catchupPending: number | null;
    /** When the scanner schedules its next universe refresh (a valid timestamp, as reported; null otherwise). */
    readonly nextRefreshAt: string | null;
  };
  readonly lastMarketDataAt: string | null;
  readonly reconnects: number | null;
  readonly backpressureEvents: number | null;
  readonly restHalted: boolean | null;
  readonly restRequests: number | null;
  /**
   * The scanner's own stream connections: how many it lists, and how many are OPEN and delivered a message within
   * the market-data freshness window. Null when the status carries no per-connection detail.
   */
  readonly stream: { readonly connections: number; readonly delivering: number } | null;
  /**
   * The scanner's own report of an operator drill (public-transport-drill.ts): the drill it last applied and whether it
   * still applies. Absent when the status reports none — every status written before drills existed, or with none.
   */
  readonly drill?: { readonly drillId: string; readonly active: boolean } | null;
}

const NO_UNIVERSE: ScannerHealth["universe"] = {
  exchangeCandidates: null,
  generation: null,
  stale: null,
  capacityExceeded: null,
  selected: null,
  liveEligible: null,
  quarantined: null,
  failed: null,
  recovering: null,
  awaitingStream: null,
  awaitingStreamQuiet: null,
  catchupPending: null,
  nextRefreshAt: null,
};

/** A timestamp string that parses; future instants allowed (callers bound them). */
function timestampOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function awaiting(partial: Partial<ScannerHealth> = {}): ScannerHealth {
  return {
    verdict: "AWAITING_STATUS",
    issues: [],
    ours: false,
    runId: null,
    runState: null,
    engineFingerprint: null,
    startedAt: null,
    writtenAt: null,
    ageSeconds: null,
    universe: NO_UNIVERSE,
    lastMarketDataAt: null,
    reconnects: null,
    backpressureEvents: null,
    restHalted: null,
    restRequests: null,
    stream: null,
    ...partial,
  };
}

/** A drill observation the scanner wrote (its id and whether it is active), or null. */
function drillReportOf(value: unknown): { readonly drillId: string; readonly active: boolean } | null {
  if (!isRecord(value) || typeof value.drillId !== "string" || !/^[0-9a-f]{32}$/.test(value.drillId) || typeof value.active !== "boolean") return null;
  return { drillId: value.drillId, active: value.active };
}

export function judgeScannerHealth(input: {
  readonly statusText: string | null;
  readonly nowMs: number;
  /** Runtime pids inside the owned scanner tree (empty when none is owned). */
  readonly ownedRuntimePids: readonly number[];
  readonly policy: Pick<AlwaysOnPolicy, "scannerStatusFreshMs" | "marketDataFreshMs">;
}): ScannerHealth {
  const parsed = parseObject(input.statusText);
  if (parsed === null || typeof parsed.schema !== "string" || !parsed.schema.startsWith("teddy.native-scanner.live-shadow-supervisor-status.")) return awaiting();
  const pid = num(parsed.pid);
  const ours = pid !== null && input.ownedRuntimePids.includes(pid);
  if (!ours) return awaiting({ runId: str(parsed.runId), runState: str(parsed.runState) });

  const totals = isRecord(parsed.totals) ? parsed.totals : {};
  const universeRaw = isRecord(parsed.universe) ? parsed.universe : null;
  const capacity = universeRaw && isRecord(universeRaw.capacity) ? universeRaw.capacity : null;
  const writtenAtMs = instantOf(parsed.writtenAt, input.nowMs);
  let lastMarketMs: number | null = null;
  if (Array.isArray(parsed.symbols)) {
    for (const symbol of parsed.symbols as unknown[]) {
      const at = isRecord(symbol) ? instantOf(symbol.lastValidMessageAt, input.nowMs) : null;
      if (at !== null && (lastMarketMs === null || at > lastMarketMs)) lastMarketMs = at;
    }
  }
  const universe: ScannerHealth["universe"] = {
    exchangeCandidates: universeRaw ? num(universeRaw.exchangeCandidates) : null,
    generation: universeRaw ? num(universeRaw.generation) : null,
    stale: universeRaw ? bool(universeRaw.stale) : null,
    capacityExceeded: capacity ? bool(capacity.exceeded) : null,
    selected: num(totals.selected),
    liveEligible: num(totals.liveEligible),
    quarantined: num(totals.quarantined),
    failed: num(totals.failed),
    recovering: num(totals.recovering),
    awaitingStream: num(totals.awaitingStream),
    awaitingStreamQuiet: null,
    catchupPending: num(totals.catchupPending),
    nextRefreshAt: universeRaw ? timestampOf(universeRaw.nextRefreshAt) : null,
  };
  const base = {
    ours: true,
    runId: str(parsed.runId),
    runState: str(parsed.runState),
    engineFingerprint: str(parsed.engineFingerprint),
    startedAt: str(parsed.startedAt),
    writtenAt: writtenAtMs === null ? null : new Date(writtenAtMs).toISOString(),
    ageSeconds: writtenAtMs === null ? null : Math.max(0, Math.round((input.nowMs - writtenAtMs) / 1000)),
    universe,
    lastMarketDataAt: lastMarketMs === null ? null : new Date(lastMarketMs).toISOString(),
    reconnects: num(totals.reconnects),
    backpressureEvents: num(totals.backpressureEvents),
    restHalted: bool(totals.restHalted),
    restRequests: num(totals.restRequests),
    ...((): { drill?: { readonly drillId: string; readonly active: boolean } } => {
      const drill = drillReportOf(parsed.drill);
      return drill === null ? {} : { drill };
    })(),
  };
  if (parsed.runState === "STOPPED") return { ...base, stream: null, verdict: "STOPPED", issues: [] };

  const issues: ScannerIssue[] = [];
  if (writtenAtMs === null || input.nowMs - writtenAtMs > input.policy.scannerStatusFreshMs) {
    issues.push({ code: "STATUS_STALE", detail: writtenAtMs === null ? "the status has no trustworthy timestamp" : `status last written ${base.ageSeconds}s ago` });
  }
  if (universe.stale === true) issues.push({ code: "UNIVERSE_STALE", detail: "the exchange universe has not refreshed for two intervals" });
  if (universe.capacityExceeded === true) issues.push({ code: "CAPACITY_EXCEEDED", detail: "the active universe exceeds the connection capacity" });
  const positive = (value: number | null) => value !== null && value > 0;
  const detail = readinessDetail(parsed, input.nowMs, input.policy.marketDataFreshMs);
  if (positive(universe.failed)) issues.push({ code: "SYMBOLS_FAILED", detail: `${universe.failed} symbol(s) failed` });
  if (positive(universe.recovering)) issues.push({ code: "SYMBOLS_RECOVERING", detail: `${universe.recovering} symbol(s) recovering` });
  if (detail === null) {
    // An older status with no per-symbol detail: no way to tell a quiet symbol from a dead stream — strict.
    if (positive(universe.awaitingStream)) issues.push({ code: "AWAITING_STREAM", detail: `${universe.awaitingStream} symbol(s) awaiting their stream` });
  } else if (detail.awaitingSilent > 0) {
    // A symbol whose connection delivers nothing at all has no stream: that is a failure, whatever its bar.
    issues.push({ code: "AWAITING_STREAM", detail: `${detail.awaitingSilent} symbol(s) awaiting their stream on a connection that delivers nothing` });
  }
  if (positive(universe.catchupPending)) issues.push({ code: "CATCHUP_PENDING", detail: `${universe.catchupPending} symbol(s) waiting for catch-up` });
  const selected = universe.selected;
  if (selected === null || selected === 0) {
    issues.push({ code: "NO_SYMBOLS_SELECTED", detail: "the run has no selected symbols" });
  } else {
    // Membership is the scanner's whole partition of its placed symbols; each state above is reported once, by its own code.
    // The compact fallback (a status without per-symbol detail) has totals only, and totals.failed also counts symbols
    // that failed before placement: there a gap can be offset by such a failure. Diagnostic only — any failure is
    // SYMBOLS_FAILED and DEGRADED regardless — and current scanners always write the detail.
    const why =
      detail !== null
        ? detail.placed !== selected
          ? `selected ${selected} ≠ ${detail.placed} placed symbol(s) listed`
          : detail.unexplained.length > 0
            ? `${detail.unexplained.length} placed symbol(s) in no known state (${[...new Set(detail.unexplained)].slice(0, 5).join(", ")})`
            : null
        : (universe.liveEligible ?? 0) + (universe.quarantined ?? 0) > selected ||
            (universe.liveEligible ?? 0) + (universe.quarantined ?? 0) + (universe.awaitingStream ?? 0) + (universe.recovering ?? 0) + (universe.catchupPending ?? 0) + (universe.failed ?? 0) < selected
          ? `selected ${selected} ≠ live ${universe.liveEligible ?? "?"} + quarantined ${universe.quarantined ?? "?"} + awaiting ${universe.awaitingStream ?? "?"} + recovering ${universe.recovering ?? "?"} + pending ${universe.catchupPending ?? "?"} + failed ${universe.failed ?? "?"}`
          : null;
    if (why !== null) issues.push({ code: "MEMBERSHIP_INCONSISTENT", detail: why });
  }
  if (selected !== null && selected > 0 && (lastMarketMs === null || input.nowMs - lastMarketMs > input.policy.marketDataFreshMs)) {
    issues.push({ code: "MARKET_DATA_STALE", detail: lastMarketMs === null ? "no market data has been received" : `newest market data is ${Math.round((input.nowMs - lastMarketMs) / 1000)}s old` });
  }
  if (base.restHalted === true) issues.push({ code: "REST_HALTED", detail: "Binance rate-limited the scanner (418/429): its REST is halted for the run" });

  // WARMING: normal after a start or reconnect (current-bar quarantine, quiet symbols awaiting their first update on a
  // delivering connection). The supervisor bounds how long it may last; the scanner's own per-symbol stale timeout acts first.
  const warming = (universe.quarantined ?? 0) > 0 || (detail?.awaitingQuiet ?? 0) > 0;
  const verdict: ScannerVerdict = issues.length > 0 ? "DEGRADED" : warming ? "WARMING" : "HEALTHY";
  return {
    ...base,
    universe: { ...universe, awaitingStreamQuiet: detail === null ? null : detail.awaitingQuiet },
    stream: detail === null ? null : { connections: detail.connections, delivering: detail.deliveringConnections },
    verdict,
    issues,
  };
}

/**
 * The placed symbols' readiness states a status may list; each is reported by its own code. A symbol that fails after
 * it was placed keeps its connection (fail() does not unplace it) and is reported as SYMBOLS_FAILED; one that fails
 * before it was ever placed (during its bootstrap) has no connection and is not a placed symbol here.
 */
const KNOWN_PLACED_STATES: ReadonlySet<string> = new Set(["LIVE_ELIGIBLE", "QUARANTINED_CURRENT_BAR", "AWAITING_STREAM", "NOT_READY", "RECOVERING", "PENDING", "FAILED"]);

/**
 * The scanner's per-symbol and per-connection detail (it lists every symbol with its connection and readiness,
 * and every connection with its lifecycle and last message). Null when the status carries none.
 */
function readinessDetail(
  parsed: Record<string, unknown>,
  nowMs: number,
  freshMs: number
): { placed: number; awaitingQuiet: number; awaitingSilent: number; unexplained: string[]; connections: number; deliveringConnections: number } | null {
  if (!Array.isArray(parsed.symbols) || !Array.isArray(parsed.connections)) return null;
  const delivering = new Map<number, boolean>();
  for (const c of parsed.connections as unknown[]) {
    if (!isRecord(c) || num(c.index) === null) return null;
    const last = instantOf(c.lastMessageAt, nowMs);
    delivering.set(num(c.index) as number, c.lifecycle === "OPEN" && last !== null && nowMs - last <= freshMs);
  }
  const result = {
    placed: 0,
    awaitingQuiet: 0,
    awaitingSilent: 0,
    unexplained: [] as string[],
    connections: delivering.size,
    deliveringConnections: [...delivering.values()].filter(Boolean).length,
  };
  for (const s of parsed.symbols as unknown[]) {
    if (!isRecord(s) || num(s.connection) === null || typeof s.readiness !== "string") return null;
    const connection = num(s.connection) as number;
    if (connection < 0) continue;
    result.placed += 1;
    if (!KNOWN_PLACED_STATES.has(s.readiness)) result.unexplained.push(s.readiness);
    else if (s.readiness === "AWAITING_STREAM" || s.readiness === "NOT_READY") {
      if (delivering.get(connection) === true) result.awaitingQuiet += 1;
      else result.awaitingSilent += 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

export type EmitterVerdict =
  | "HEALTHY"
  /** Healthy and working through a backlog (bounded catch-up): not a failure. */
  | "CATCHING_UP"
  /** Ours and writing fresh status, still re-validating its lanes up to their cursors: alive, not yet healthy. */
  | "INITIALIZING"
  | "DEGRADED"
  /** Ours, but its status is too old to prove it is still working. */
  | "STALE"
  /** No status from OUR emitter for its pinned run yet. */
  | "AWAITING_STATUS";

export type EmitterIssueCode = "WRONG_MODE" | "LANES_FAILED" | "MEMBERSHIP_INVALID" | "LEDGER_DUPLICATES_OBSERVED";

export interface EmitterHealth {
  readonly verdict: EmitterVerdict;
  readonly issues: readonly { readonly code: EmitterIssueCode; readonly detail: string }[];
  readonly ours: boolean;
  readonly mode: string | null;
  readonly runId: string | null;
  readonly writtenAt: string | null;
  readonly ageSeconds: number | null;
  readonly lanesTracked: number | null;
  readonly lanesHealthy: number | null;
  readonly lanesFailed: number | null;
  readonly queueDepth: number | null;
  readonly queueCapacity: number | null;
  readonly maxQueueDepth: number | null;
  readonly backlogLanes: number | null;
  readonly created: number | null;
  readonly ledgerDuplicates: number | null;
  /**
   * The emitter tracks every lane the RUN ever bound (manifest + journal
   * joins); the scanner reports its CURRENT selection. After delists or
   * removals the two legitimately differ — historical lanes, not corruption.
   */
  readonly laneNote: "MATCHES_SCANNER_SELECTION" | "HISTORICAL_LANES_BEYOND_CURRENT_SELECTION" | "FEWER_LANES_THAN_SELECTION" | "UNKNOWN";
  readonly largeBacklog: boolean;
  /** Start-up progress while the emitter is still initializing; null once complete (or from an emitter that predates it). */
  readonly initialization: { readonly lanesBaselined: number | null; readonly lanesTotal: number | null } | null;
}

export function judgeEmitterHealth(input: {
  readonly statusText: string | null;
  readonly nowMs: number;
  readonly ownedRuntimePids: readonly number[];
  readonly expectedRunId: string;
  /** The scanner's current selection (for the lane note only; never a failure on its own). */
  readonly scannerSelected: number | null;
  readonly policy: Pick<AlwaysOnPolicy, "emitterStatusFreshMs" | "largeBacklogFraction">;
}): EmitterHealth {
  const empty: EmitterHealth = {
    verdict: "AWAITING_STATUS",
    issues: [],
    ours: false,
    mode: null,
    runId: null,
    writtenAt: null,
    ageSeconds: null,
    lanesTracked: null,
    lanesHealthy: null,
    lanesFailed: null,
    queueDepth: null,
    queueCapacity: null,
    maxQueueDepth: null,
    backlogLanes: null,
    created: null,
    ledgerDuplicates: null,
    laneNote: "UNKNOWN",
    largeBacklog: false,
    initialization: null,
  };
  const parsed = parseObject(input.statusText);
  if (parsed === null || typeof parsed.schema !== "string") return empty;
  const pid = num(parsed.pid);
  if (pid === null || !input.ownedRuntimePids.includes(pid) || parsed.runId !== input.expectedRunId) return empty;
  const writtenAtMs = instantOf(parsed.writtenAt, input.nowMs);
  const catchUp = isRecord(parsed.catchUp) ? parsed.catchUp : {};
  const membership = isRecord(parsed.membership) ? parsed.membership : {};
  const init = isRecord(parsed.initialization) && parsed.initialization.complete === false ? parsed.initialization : null;
  const lanesTracked = num(parsed.symbolsTracked);
  const queueDepth = num(parsed.queueDepth);
  const queueCapacity = num(parsed.queueCapacity);
  const backlogLanes = num(catchUp.backlogLanes);
  const largeBacklog =
    (queueDepth !== null && queueCapacity !== null && queueCapacity > 0 && queueDepth >= queueCapacity * input.policy.largeBacklogFraction) || (backlogLanes !== null && backlogLanes > 0);
  const laneNote: EmitterHealth["laneNote"] =
    lanesTracked === null || input.scannerSelected === null
      ? "UNKNOWN"
      : lanesTracked === input.scannerSelected
        ? "MATCHES_SCANNER_SELECTION"
        : lanesTracked > input.scannerSelected
          ? "HISTORICAL_LANES_BEYOND_CURRENT_SELECTION"
          : "FEWER_LANES_THAN_SELECTION";
  const health: EmitterHealth = {
    ...empty,
    ours: true,
    mode: str(parsed.mode),
    runId: str(parsed.runId),
    writtenAt: writtenAtMs === null ? null : new Date(writtenAtMs).toISOString(),
    ageSeconds: writtenAtMs === null ? null : Math.max(0, Math.round((input.nowMs - writtenAtMs) / 1000)),
    lanesTracked,
    lanesHealthy: num(parsed.symbolsHealthy),
    lanesFailed: num(parsed.symbolsFailed),
    queueDepth,
    queueCapacity,
    maxQueueDepth: num(parsed.maxQueueDepth),
    backlogLanes,
    created: num(parsed.created),
    ledgerDuplicates: num(parsed.ledgerDuplicates),
    laneNote,
    largeBacklog,
    initialization: init === null ? null : { lanesBaselined: num(init.lanesBaselined), lanesTotal: num(init.lanesTotal) },
  };
  if (writtenAtMs === null || input.nowMs - writtenAtMs > input.policy.emitterStatusFreshMs) return { ...health, verdict: "STALE" };
  if (init !== null) return { ...health, verdict: "INITIALIZING" };
  const issues: { code: EmitterIssueCode; detail: string }[] = [];
  if (parsed.mode !== "COMMIT_DASHBOARD_ALERTS") issues.push({ code: "WRONG_MODE", detail: `the emitter runs in ${String(parsed.mode)}, not COMMIT` });
  if ((health.lanesFailed ?? 0) > 0) issues.push({ code: "LANES_FAILED", detail: `${health.lanesFailed} lane(s) failed closed (a restart does not repair evidence; see the emitter log)` });
  if (typeof membership.failure === "string" && membership.failure.length > 0) issues.push({ code: "MEMBERSHIP_INVALID", detail: "the run's membership journal stopped verifying; no new symbol is bound" });
  if (issues.length > 0) return { ...health, verdict: "DEGRADED", issues };
  return { ...health, verdict: largeBacklog ? "CATCHING_UP" : "HEALTHY" };
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

/** Cumulative counters as observed when Always-On observation began (or re-baselined after they went backwards). */
export interface PlannerBaseline {
  readonly jobsFailed: number;
  readonly plansError: number;
  readonly establishedAt: string;
}

export type PlannerVerdict = "HEALTHY" | "DEGRADED" | "UNKNOWN";
export type PlannerIssueCode = "WORKER_NOT_RUNNING" | "NO_CONSUMER" | "NEW_JOB_FAILURES" | "NEW_PLAN_ERRORS" | "PENDING_BACKLOG_PERSISTENT" | "LAST_SWEEP_ERROR";

export interface PlannerHealth {
  readonly verdict: PlannerVerdict;
  readonly issues: readonly { readonly code: PlannerIssueCode; readonly detail: string }[];
  readonly readiness: string | null;
  readonly workerState: string | null;
  readonly consumers: number | null;
  readonly pending: number | null;
  readonly jobsFailed: number | null;
  readonly plansError: number | null;
  readonly plansPending: number | null;
  readonly lastSweepError: boolean;
  readonly delta: { readonly jobsFailed: number | null; readonly plansError: number | null };
  /** True when the worker's heartbeat says it is not running (OFF/STALE/UNREADABLE) — the evidence for a hung or dead consumer. */
  readonly heartbeatMissing: boolean;
}

/**
 * The planner, judged on NEW failures only. Cumulative counters (BullMQ's
 * failed jobs, ERROR plans) carry history from before observation began; a
 * baseline of three historical ERROR plans is healthy as long as the delta is
 * zero. Nothing here resets, retries or deletes a historical failure.
 */
export function judgePlannerHealth(input: {
  /** GET /api/native-planner/status body, or null when the backend could not be asked. */
  readonly plannerStatus: unknown;
  /** soak-health `plans` (counts by plan status), or null. */
  readonly plans: unknown;
  readonly baseline: PlannerBaseline | null;
  readonly nowMs: number;
  /** Since when pending Native plans have been continuously present (tracked by the caller), or null. */
  readonly pendingSinceMs: number | null;
  readonly policy: Pick<AlwaysOnPolicy, "plannerPendingPersistentMs">;
}): PlannerHealth {
  const status = isRecord(input.plannerStatus) ? input.plannerStatus : null;
  const plans = isRecord(input.plans) ? input.plans : null;
  const worker = status && isRecord(status.worker) ? status.worker : null;
  const jobs = status && isRecord(status.jobs) ? status.jobs : null;
  const jobsFailed = jobs ? num(jobs.failed) : null;
  const plansError = plans ? num(plans.ERROR) : null;
  const workerState = worker ? str(worker.state) : null;
  const facts = {
    readiness: status ? str(status.readiness) : null,
    workerState,
    consumers: status ? num(status.connectedConsumers) : null,
    pending: status ? num(status.pendingNativePlans) : null,
    jobsFailed,
    plansError,
    plansPending: plans ? num(plans.PENDING) : null,
    lastSweepError: worker !== null && typeof worker.lastSweepError === "string" && worker.lastSweepError.length > 0,
    delta: {
      jobsFailed: input.baseline !== null && jobsFailed !== null ? jobsFailed - input.baseline.jobsFailed : null,
      plansError: input.baseline !== null && plansError !== null ? plansError - input.baseline.plansError : null,
    },
    heartbeatMissing: workerState !== null && workerState !== "RUNNING",
  };
  if (status === null) return { ...facts, verdict: "UNKNOWN", issues: [] };
  const issues: { code: PlannerIssueCode; detail: string }[] = [];
  if (workerState !== "RUNNING") issues.push({ code: "WORKER_NOT_RUNNING", detail: `the planner heartbeat reads ${workerState ?? "nothing"}` });
  if (facts.consumers !== null && facts.consumers === 0) issues.push({ code: "NO_CONSUMER", detail: "no connected consumer on the Native planning queue" });
  if (facts.delta.jobsFailed !== null && facts.delta.jobsFailed > 0) issues.push({ code: "NEW_JOB_FAILURES", detail: `${facts.delta.jobsFailed} planning job(s) failed since observation began` });
  if (facts.delta.plansError !== null && facts.delta.plansError > 0) issues.push({ code: "NEW_PLAN_ERRORS", detail: `${facts.delta.plansError} Native plan(s) entered ERROR since observation began` });
  if (input.pendingSinceMs !== null && input.nowMs - input.pendingSinceMs >= input.policy.plannerPendingPersistentMs) {
    issues.push({ code: "PENDING_BACKLOG_PERSISTENT", detail: `pending Native plans present for ${Math.round((input.nowMs - input.pendingSinceMs) / 60_000)} min` });
  }
  if (facts.lastSweepError) issues.push({ code: "LAST_SWEEP_ERROR", detail: "the planner's last recovery sweep reported an error" });
  return { ...facts, verdict: issues.length > 0 ? "DEGRADED" : "HEALTHY", issues };
}

/**
 * The next planner baseline: established the first time both cumulative
 * counters are known, and re-established when either goes BACKWARDS (BullMQ
 * failed-job retention or a cleared queue) — never to hide an increase.
 */
export function nextPlannerBaseline(current: PlannerBaseline | null, observed: { readonly jobsFailed: number | null; readonly plansError: number | null }, nowIso: string): { readonly baseline: PlannerBaseline | null; readonly event: "ESTABLISHED" | "RESET_COUNTERS_WENT_BACKWARDS" | null } {
  if (observed.jobsFailed === null || observed.plansError === null) return { baseline: current, event: null };
  if (current === null) return { baseline: { jobsFailed: observed.jobsFailed, plansError: observed.plansError, establishedAt: nowIso }, event: "ESTABLISHED" };
  if (observed.jobsFailed < current.jobsFailed || observed.plansError < current.plansError) {
    return {
      baseline: { jobsFailed: Math.min(observed.jobsFailed, current.jobsFailed), plansError: Math.min(observed.plansError, current.plansError), establishedAt: nowIso },
      event: "RESET_COUNTERS_WENT_BACKWARDS",
    };
  }
  return { baseline: current, event: null };
}
