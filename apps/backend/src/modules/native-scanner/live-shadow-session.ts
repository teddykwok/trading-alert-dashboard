import {
  reconstructHistoricalState,
  reconstructImmediateCandidates,
  stepNativeEngine,
  type NativeEngineConfig,
  type NativeEngineState,
  type NativeKline,
  type NativePartialPeriodPolicy,
} from "@trading-alert-dashboard/shared";

import { intervalMsOf, type ScannerChartInterval, type ScannerMarketType } from "./binance-public-futures";
import { engineStateSha256, selectCompatReplayBars } from "./compat-replay";
import { classifyCandidate } from "./historical-replay";
import { serializeKlines, sha256Hex } from "./kline-cache";
import type { LiveKlineUpdate } from "./live-kline-stream";
import {
  LIVE_CHECKPOINT_SCHEMA,
  LiveShadowError,
  type LiveCheckpointBody,
  type LiveCheckpointFile,
  type LiveCheckpointStore,
} from "./live-shadow-checkpoint";
import {
  SHADOW_EVENT_SCHEMA,
  commitEventId,
  observationEventId,
  type BarCloseCommitRecord,
  type LiveImmediateObservation,
  type LiveShadowEventStore,
  type ShadowClassification,
} from "./live-shadow-store";
import { buildScannerLineage, type ScannerLineage } from "./scanner-lineage";

/**
 * LIVE SHADOW scanner core: restart preparation and the live session.
 *
 * Restart: rebuild the lineage's state at the switchover exactly as the
 * compatibility replay does, replay every trusted CLOSED causal bar, and verify
 * the previous checkpoint against it (lineage, causal bytes through its HWM,
 * state at its HWM). Everything replayed is REPLAYED_NON_ACTIONABLE.
 *
 * Live: the committed state stays at the last closed bar until the current bar
 * closes. Each partial update is evaluated with the approved Slice 1b Immediate
 * reconstruction against that committed pre-bar state, with the bar's OHLC so
 * far; nothing is committed until the close, and then exactly once. The bar in
 * which readiness is established is never live: QUARANTINED_CURRENT_BAR.
 *
 * Nothing here is actionable. The output is local shadow evidence.
 */

export interface LiveShadowRequest {
  readonly symbol: string;
  readonly marketType: ScannerMarketType;
  readonly chartInterval: ScannerChartInterval;
  readonly historyStartMs: number;
  readonly switchoverMs: number;
  readonly engine: NativeEngineConfig;
  readonly partialPeriodPolicy: NativePartialPeriodPolicy;
  /** When given, the rebuilt lineage must hash to exactly this ID. */
  readonly expectedLineageId: string | null;
}

export type CheckpointStatus = "CREATED" | "VERIFIED_UNCHANGED" | "VERIFIED_AND_EXTENDED";

export interface LiveShadowPlan {
  readonly lineage: ScannerLineage;
  readonly lineageId: string;
  readonly stateSha256AtSwitchover: string;
  readonly state: NativeEngineState;
  readonly causalBars: NativeKline[];
  readonly hwmOpenTimeMs: number;
  readonly checkpointStatus: CheckpointStatus;
  readonly checkpointBody: LiveCheckpointBody;
  /** Causal bars replayed at start-up that the previous checkpoint did not cover. */
  readonly catchUp: { readonly fromMs: number; readonly toMs: number; readonly bars: number };
  /** Committed candidates seen during replay: REPLAYED_NON_ACTIONABLE, never written as live evidence. */
  readonly replayedNonActionableCandidates: number;
}

export function checkpointBodyFor(input: {
  lineageId: string;
  marketType: ScannerMarketType;
  symbol: string;
  chartInterval: ScannerChartInterval;
  switchoverMs: number;
  stateSha256AtSwitchover: string;
  causalBars: readonly NativeKline[];
  state: NativeEngineState;
}): LiveCheckpointBody {
  const intervalMs = intervalMsOf(input.chartInterval);
  const hwmOpenTimeMs = input.switchoverMs + input.causalBars.length * intervalMs;
  return {
    schema: LIVE_CHECKPOINT_SCHEMA,
    lineageId: input.lineageId,
    marketType: input.marketType,
    symbol: input.symbol,
    chartInterval: input.chartInterval,
    compatibilitySwitchoverMs: input.switchoverMs,
    stateSha256AtSwitchover: input.stateSha256AtSwitchover,
    hwmOpenTimeMs,
    lastCommittedBarOpenTimeMs: hwmOpenTimeMs - intervalMs,
    causalBarCount: input.causalBars.length,
    causalInputSha256ThroughHwm: sha256Hex(serializeKlines(input.causalBars)),
    stateSha256: engineStateSha256(input.state),
  };
}

/**
 * Rebuilds the committed state through `trustedEndMs` (exclusive; every bar
 * before it is closed and verified) and verifies any previous checkpoint
 * against it. Refuses — never overwrites — on any mismatch.
 */
export function prepareLiveShadowState(
  klines: readonly NativeKline[],
  request: LiveShadowRequest,
  trustedEndMs: number,
  previous: LiveCheckpointFile | null
): LiveShadowPlan {
  if (!(trustedEndMs > request.switchoverMs)) {
    throw new LiveShadowError("INVALID_STATE", "no closed bar exists after the switchover yet; the live scanner starts after the first one closes");
  }
  const bars = selectCompatReplayBars(klines, { ...request, endMs: trustedEndMs });
  const { lineage, lineageId } = buildScannerLineage({
    marketType: request.marketType,
    symbol: request.symbol,
    chartInterval: request.chartInterval,
    historyStartMs: request.historyStartMs,
    compatibilitySwitchoverMs: request.switchoverMs,
    engineConfig: request.engine,
    partialPeriodPolicy: request.partialPeriodPolicy,
    bootstrapInputSha256: sha256Hex(serializeKlines([...bars.contextBars, ...bars.historyBars])),
  });
  if (request.expectedLineageId !== null && request.expectedLineageId !== lineageId) {
    throw new LiveShadowError("LINEAGE_MISMATCH", `the configured inputs and bytes build lineage ${lineageId}, not the expected ${request.expectedLineageId}`);
  }
  // The lifecycle decides: Pine look-ahead history (legacy) or causal history (dynamic).
  const historical = reconstructHistoricalState({
    config: lineage.engineConfig,
    historyStartMs: request.historyStartMs,
    switchoverMs: request.switchoverMs,
    contextBars: bars.contextBars,
    bars: bars.historyBars,
    partialPeriodPolicy: request.partialPeriodPolicy,
  });
  const stateSha256AtSwitchover = engineStateSha256(historical.state);

  if (previous !== null) {
    const body = previous.body;
    if (body.lineageId !== lineageId) {
      throw new LiveShadowError("LINEAGE_MISMATCH", `the checkpoint belongs to lineage ${body.lineageId}, not ${lineageId}`);
    }
    if (body.stateSha256AtSwitchover !== stateSha256AtSwitchover) {
      throw new LiveShadowError("STATE_MISMATCH", "the rebuilt state at the switchover does not match the checkpoint");
    }
    if (body.hwmOpenTimeMs > trustedEndMs) {
      throw new LiveShadowError("CHECKPOINT_AHEAD_OF_DATA", "the checkpoint covers closed bars the verified kline data does not hold; fetch them first");
    }
  }

  let state = historical.state;
  let replayed = 0;
  const causalBars = bars.causalBars;
  for (let i = 0; i <= causalBars.length; i += 1) {
    if (previous !== null && i === previous.body.causalBarCount) {
      // The hash fence: bytes already consumed through the previous HWM must be byte-identical.
      if (sha256Hex(serializeKlines(causalBars.slice(0, i))) !== previous.body.causalInputSha256ThroughHwm) {
        throw new LiveShadowError("HISTORICAL_DATA_DRIFT", "causal kline bytes already consumed through the checkpoint's high-water mark have changed");
      }
      if (engineStateSha256(state) !== previous.body.stateSha256) {
        throw new LiveShadowError("STATE_MISMATCH", "the rebuilt state at the checkpoint's high-water mark does not match the checkpoint");
      }
    }
    if (i === causalBars.length) break;
    const step = stepNativeEngine(state, causalBars[i]);
    replayed += step.candidates.length;
    state = step.state;
  }

  const checkpointBody = checkpointBodyFor({ lineageId, ...request, stateSha256AtSwitchover, causalBars, state });
  const fromMs = previous === null ? request.switchoverMs : previous.body.hwmOpenTimeMs;
  return {
    lineage,
    lineageId,
    stateSha256AtSwitchover,
    state,
    causalBars,
    hwmOpenTimeMs: checkpointBody.hwmOpenTimeMs,
    checkpointStatus: previous === null ? "CREATED" : previous.body.hwmOpenTimeMs === trustedEndMs ? "VERIFIED_UNCHANGED" : "VERIFIED_AND_EXTENDED",
    checkpointBody,
    catchUp: { fromMs, toMs: trustedEndMs, bars: (trustedEndMs - fromMs) / intervalMsOf(request.chartInterval) },
    replayedNonActionableCandidates: replayed,
  };
}

// ---------------------------------------------------------------------------
// Live session
// ---------------------------------------------------------------------------

export type LiveSessionPhase = "DISCONNECTED" | "READY" | "RECOVERY_REQUIRED";
export type LiveBarStatus = "NOT_READY" | "QUARANTINED_CURRENT_BAR" | "LIVE_ELIGIBLE" | "RECOVERY_REQUIRED";

export interface LiveSessionDeps {
  readonly plan: LiveShadowPlan;
  readonly checkpoints: LiveCheckpointStore;
  readonly events: LiveShadowEventStore;
  /** Local wall clock: readiness, quarantine and provenance only — never strategy. */
  readonly nowMs: () => number;
  readonly nowIso: () => string;
  /** Persists a committed closed bar into the verified kline cache before the checkpoint moves. */
  readonly persistClosedBar: (bar: NativeKline) => void;
}

export interface LiveUpdateOutcome {
  readonly status: LiveBarStatus;
  readonly observations: readonly LiveImmediateObservation[];
  readonly commit: BarCloseCommitRecord | null;
  readonly ignored: string | null;
}

interface CurrentBar {
  readonly openTimeMs: number;
  readonly open: number;
  high: number;
  low: number;
  close: number;
  eventTimeMs: number;
  updates: number;
  readonly observed: Map<string, LiveImmediateObservation>;
}

export class LiveShadowSession {
  private state: NativeEngineState;
  private readonly causalBars: NativeKline[];
  private hwm: number;
  private sessionPhase: LiveSessionPhase = "DISCONNECTED";
  private eligibleFrom: number | null = null;
  private current: CurrentBar | null = null;
  private reason: string | null = null;
  readonly intervalMs: number;

  constructor(private readonly deps: LiveSessionDeps) {
    this.state = deps.plan.state;
    this.causalBars = [...deps.plan.causalBars];
    this.hwm = deps.plan.hwmOpenTimeMs;
    this.intervalMs = intervalMsOf(deps.plan.lineage.chartInterval);
  }

  get phase(): LiveSessionPhase {
    return this.sessionPhase;
  }
  get hwmOpenTimeMs(): number {
    return this.hwm;
  }
  get liveEligibleFromMs(): number | null {
    return this.eligibleFrom;
  }
  get recoveryReason(): string | null {
    return this.reason;
  }
  /** The committed state: always the state after the last CLOSED bar. */
  get committedState(): NativeEngineState {
    return this.state;
  }

  barStatus(openTimeMs: number): LiveBarStatus {
    if (this.sessionPhase === "RECOVERY_REQUIRED") return "RECOVERY_REQUIRED";
    if (this.sessionPhase !== "READY" || this.eligibleFrom === null) return "NOT_READY";
    return openTimeMs >= this.eligibleFrom ? "LIVE_ELIGIBLE" : "QUARANTINED_CURRENT_BAR";
  }

  /**
   * Readiness is established by the FIRST valid stream update. That update
   * belongs to a bar that was already open, so that bar is always quarantined:
   * live eligibility starts at the next boundary after both the local clock
   * and the update's own bar.
   */
  markStreamReady(first: LiveKlineUpdate): LiveBarStatus {
    if (this.sessionPhase !== "DISCONNECTED") return this.barStatus(first.openTimeMs);
    if (first.openTimeMs > this.hwm) {
      this.enterRecovery(`closed bars from ${new Date(this.hwm).toISOString()} are missing before the stream's current bar`);
      return "RECOVERY_REQUIRED";
    }
    if (first.openTimeMs < this.hwm) return "NOT_READY"; // a stale message cannot establish readiness
    const now = this.deps.nowMs();
    const nextLocalBoundary = Math.ceil(now / this.intervalMs) * this.intervalMs;
    this.eligibleFrom = Math.max(nextLocalBoundary, first.openTimeMs + this.intervalMs);
    this.sessionPhase = "READY";
    return this.barStatus(first.openTimeMs);
  }

  /** Continuity is uncertain from this moment: nothing is live until a fresh boundary after reconnecting. */
  onDisconnect(): void {
    if (this.sessionPhase === "READY") this.sessionPhase = "DISCONNECTED";
    this.eligibleFrom = null;
    this.current = null;
  }

  onUpdate(update: LiveKlineUpdate): LiveUpdateOutcome {
    const ignored = (why: string): LiveUpdateOutcome => ({ status: this.barStatus(update.openTimeMs), observations: [], commit: null, ignored: why });
    if (this.sessionPhase !== "READY") return ignored(`session is ${this.sessionPhase}`);
    if (update.symbol !== this.deps.plan.lineage.symbol || update.interval !== this.deps.plan.lineage.chartInterval) {
      this.enterRecovery("an update for another symbol or interval reached the session");
      return ignored("wrong stream");
    }
    if (update.openTimeMs < this.hwm) {
      const last = this.causalBars[this.causalBars.length - 1];
      if (update.closed && last !== undefined && update.openTimeMs === last.openTimeMs) {
        const same = last.open === update.open && last.high === update.high && last.low === update.low && last.close === update.close;
        if (same) return ignored("duplicate close of the last committed bar");
        this.enterRecovery("a close for an already committed bar contradicts the committed bar");
        return ignored("contradictory close");
      }
      return ignored("stale update for an already committed bar");
    }
    if (update.openTimeMs > this.hwm) {
      this.enterRecovery(`expected bar ${new Date(this.hwm).toISOString()}, received ${new Date(update.openTimeMs).toISOString()}: a bar was skipped`);
      return ignored("skipped bar");
    }

    // ---- the expected bar ------------------------------------------------
    if (this.current === null) {
      this.current = { openTimeMs: update.openTimeMs, open: update.open, high: update.high, low: update.low, close: update.close, eventTimeMs: update.eventTimeMs, updates: 0, observed: new Map() };
    } else {
      const c = this.current;
      if (update.open !== c.open || update.high < c.high || update.low > c.low || update.eventTimeMs < c.eventTimeMs) {
        this.enterRecovery("a kline update went backwards (open changed, high fell, low rose, or event time regressed)");
        return ignored("non-monotonic update");
      }
      c.high = update.high;
      c.low = update.low;
      c.close = update.close;
      c.eventTimeMs = update.eventTimeMs;
    }
    const current = this.current;
    current.updates += 1;

    const status = this.barStatus(current.openTimeMs);
    const observations: LiveImmediateObservation[] = [];
    if (status === "LIVE_ELIGIBLE") {
      const soFar: NativeKline = {
        openTimeMs: current.openTimeMs,
        closeTimeMs: current.openTimeMs + this.intervalMs - 1,
        open: current.open,
        high: current.high,
        low: current.low,
        close: current.close,
      };
      // Slice 1b, unchanged: the committed pre-bar state is only READ here.
      for (const candidate of reconstructImmediateCandidates(this.state, soFar)) {
        const levelKey = `${candidate.sourceTf}:${candidate.level.condition}:${candidate.level.createdBarOpenTimeMs}`;
        const lineage = this.deps.plan.lineage;
        const eventId = observationEventId({
          lineageId: this.deps.plan.lineageId,
          symbol: lineage.symbol,
          barOpenTimeMs: current.openTimeMs,
          signal: candidate.signal,
          sourceTf: candidate.sourceTf,
          levelKey,
        });
        if (current.observed.has(eventId) || this.deps.events.has(eventId)) continue;
        const record: LiveImmediateObservation = {
          schema: SHADOW_EVENT_SCHEMA,
          kind: "LIVE_IMMEDIATE_OBSERVATION",
          eventId,
          lineageId: this.deps.plan.lineageId,
          marketType: lineage.marketType,
          symbol: lineage.symbol,
          chartInterval: lineage.chartInterval,
          barOpenTime: new Date(current.openTimeMs).toISOString(),
          barOpenTimeMs: current.openTimeMs,
          actionable: false,
          classification: "SHADOW_LIVE_ONLY",
          signal: candidate.signal,
          touchDirection: candidate.touchDirection,
          sourceTf: candidate.sourceTf,
          levelColor: candidate.levelColor,
          levelPrice: candidate.levelPrice,
          levelKey,
          level: { ...candidate.level },
          candidateSequence: current.observed.size,
          updateSequence: current.updates,
          exchangeEventTimeMs: current.eventTimeMs,
          firstObservedAtMs: this.deps.nowMs(),
          ohlcSoFar: { open: soFar.open, high: soFar.high, low: soFar.low, close: soFar.close },
          evidence: { basis: "IMMEDIATE_INTRABAR", evidenceClass: classifyCandidate(candidate), proof: { ...candidate.proof } },
        };
        this.deps.events.append(record);
        current.observed.set(eventId, record);
        observations.push(record);
      }
    }

    let commit: BarCloseCommitRecord | null = null;
    if (update.closed) {
      const bar: NativeKline = { openTimeMs: update.openTimeMs, closeTimeMs: update.closeTimeMs, open: update.open, high: update.high, low: update.low, close: update.close };
      commit = this.commitClosedBar(bar, status === "LIVE_ELIGIBLE" ? "SHADOW_LIVE_ONLY" : "QUARANTINED_CURRENT_BAR", current.observed);
    }
    return { status, observations, commit, ignored: null };
  }

  /** Commits closed bars that were missed while not live: REPLAYED_NON_ACTIONABLE, never live evidence. */
  recoverClosedBars(bars: readonly NativeKline[]): BarCloseCommitRecord[] {
    if (this.sessionPhase === "READY") throw new LiveShadowError("INVALID_STATE", "disconnect before recovering closed bars");
    const records: BarCloseCommitRecord[] = [];
    for (const bar of bars) {
      if (bar.openTimeMs !== this.hwm) {
        throw new LiveShadowError("RECOVERY_REQUIRED", "recovery bars must continue exactly from the high-water mark");
      }
      records.push(this.commitClosedBar(bar, "REPLAYED_NON_ACTIONABLE", new Map()));
    }
    this.sessionPhase = "DISCONNECTED";
    this.reason = null;
    this.current = null;
    return records;
  }

  private commitClosedBar(bar: NativeKline, classification: ShadowClassification, observed: ReadonlyMap<string, LiveImmediateObservation>): BarCloseCommitRecord {
    // The approved causal engine, exactly once for this bar.
    const step = stepNativeEngine(this.state, bar);
    this.deps.persistClosedBar(bar);
    this.state = step.state;
    this.causalBars.push(bar);
    this.hwm += this.intervalMs;
    const plan = this.deps.plan;
    const body = checkpointBodyFor({
      lineageId: plan.lineageId,
      marketType: plan.lineage.marketType,
      symbol: plan.lineage.symbol,
      chartInterval: plan.lineage.chartInterval,
      switchoverMs: plan.lineage.compatibilitySwitchoverMs,
      stateSha256AtSwitchover: plan.stateSha256AtSwitchover,
      causalBars: this.causalBars,
      state: this.state,
    });
    this.deps.checkpoints.save(body, this.deps.nowIso());

    const observedKeys = new Set([...observed.values()].map((o) => `${o.signal}|${o.sourceTf}|${o.levelKey}`));
    const committedKeys = new Set<string>();
    const committedCandidates = step.candidates.map((c) => {
      const levelKey = `${c.sourceTf}:${c.level.condition}:${c.level.createdBarOpenTimeMs}`;
      committedKeys.add(`${c.signal}|${c.sourceTf}|${levelKey}`);
      return { signal: c.signal, sourceTf: c.sourceTf, levelPrice: c.levelPrice, levelKey, liveObserved: observedKeys.has(`${c.signal}|${c.sourceTf}|${levelKey}`) };
    });
    const record: BarCloseCommitRecord = {
      schema: SHADOW_EVENT_SCHEMA,
      kind: "BAR_CLOSE_COMMIT",
      eventId: commitEventId({ lineageId: plan.lineageId, symbol: plan.lineage.symbol, barOpenTimeMs: bar.openTimeMs }),
      lineageId: plan.lineageId,
      marketType: plan.lineage.marketType,
      symbol: plan.lineage.symbol,
      chartInterval: plan.lineage.chartInterval,
      barOpenTime: new Date(bar.openTimeMs).toISOString(),
      barOpenTimeMs: bar.openTimeMs,
      actionable: false,
      classification,
      finalBar: { open: bar.open, high: bar.high, low: bar.low, close: bar.close },
      committedCandidates,
      liveObservationsNotCommitted: [...observed.values()].filter((o) => !committedKeys.has(`${o.signal}|${o.sourceTf}|${o.levelKey}`)).map((o) => o.levelKey),
      hwmOpenTimeMs: body.hwmOpenTimeMs,
      stateSha256: body.stateSha256,
      causalInputSha256ThroughHwm: body.causalInputSha256ThroughHwm,
    };
    this.deps.events.append(record);
    this.current = null;
    return record;
  }

  private enterRecovery(reason: string): void {
    this.sessionPhase = "RECOVERY_REQUIRED";
    this.eligibleFrom = null;
    this.current = null;
    this.reason = reason;
  }
}
