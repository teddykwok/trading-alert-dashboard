import {
  advanceBarInPlace,
  applyBarInPlace,
  armDisarmInPlace,
  assertBarAcceptable,
  cloneWorkingState,
  createNativeEngineState,
  evaluateLevelConditions,
  isDynamicLifecycle,
  reconstructImmediateCandidates,
  registerLevelInPlace,
  retestInPlace,
  type BarOutputs,
} from "./engine";
import { advanceHtfAggregate, projectPineHistoricalHtf } from "./htf-aggregate";
import {
  NATIVE_DYNAMIC_HISTORICAL_STATE_SEMANTICS,
  NATIVE_HISTORICAL_STATE_SEMANTICS,
  NATIVE_LEVEL_CONDITIONS,
  NativeSignalInputError,
  PINE_V5_FIRST_HISTORY_BAR_NO_EDGE,
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  type NativeConditionFlags,
  type NativeEngineConfig,
  type NativeEngineState,
  type NativeHistoricalInput,
  type NativeHistoricalPeriod,
  type NativeHistoricalReport,
  type NativeHistoricalResult,
  type NativeHistoricalTouch,
  type NativeImmediateCandidate,
  type NativeKline,
  type NativeLevel,
  type NativeLevelCondition,
  type NativeRetestCandidate,
  type NativeSourceTf,
} from "./types";

export interface NativeReplayResult {
  readonly state: NativeEngineState;
  /** Every committed retest, in bar order and, within a bar, oldest level first. */
  readonly candidates: readonly NativeRetestCandidate[];
  /** Every level ever registered, in registration order. */
  readonly registrations: readonly NativeLevel[];
  /** Every level dropped by MAX_LEVELS, in eviction order. */
  readonly evictions: readonly NativeLevel[];
}

/**
 * Runs `bars` through a fresh engine, start to finish.
 *
 * Same input, same output: there is no clock, no randomness and no state that
 * outlives the call. Bars are applied in place for speed, through exactly the
 * function the public `stepNativeEngine` uses, so a replay and a step-by-step
 * run cannot disagree.
 */
export function replayNativeEngine(bars: readonly NativeKline[], config: NativeEngineConfig): NativeReplayResult {
  const working = cloneWorkingState(createNativeEngineState(config));
  const out: BarOutputs = { registered: [], evicted: [], candidates: [] };
  for (const bar of bars) applyBarInPlace(working, bar, out);
  return {
    state: working,
    candidates: out.candidates,
    registrations: out.registered,
    evictions: out.evicted,
  };
}

export interface NativeImmediateReplayResult extends NativeReplayResult {
  /** Every IMMEDIATE INTRABAR candidate, in bar order and, within a bar, oldest level first. */
  readonly immediateCandidates: readonly NativeImmediateCandidate[];
}

/**
 * `replayNativeEngine`, plus the IMMEDIATE INTRABAR candidates of every bar.
 *
 * Each bar's immediate candidates are reconstructed from the state as it stood
 * BEFORE that bar is applied; the bar is then applied exactly as the committed
 * replay applies it. The committed fields are therefore identical to
 * `replayNativeEngine(bars, config)`.
 */
export function replayNativeEngineWithImmediate(
  bars: readonly NativeKline[],
  config: NativeEngineConfig
): NativeImmediateReplayResult {
  const working = cloneWorkingState(createNativeEngineState(config));
  const out: BarOutputs = { registered: [], evicted: [], candidates: [] };
  const immediateCandidates: NativeImmediateCandidate[] = [];
  for (const bar of bars) {
    immediateCandidates.push(...reconstructImmediateCandidates(working, bar));
    applyBarInPlace(working, bar, out);
  }
  return {
    state: working,
    candidates: out.candidates,
    registrations: out.registered,
    evictions: out.evicted,
    immediateCandidates,
  };
}

// ---------------------------------------------------------------------------
// Historical state for either lifecycle
// ---------------------------------------------------------------------------

/**
 * The committed state at the switchover, by the config's lifecycle:
 * PINE_V55_EDGE_FROZEN -> the Pine look-ahead reconstruction (unchanged);
 * TEDDY_DYNAMIC_SOURCE_LEVEL_V1 -> the causal reconstruction.
 */
export function reconstructHistoricalState(input: NativeHistoricalInput): NativeHistoricalResult {
  return isDynamicLifecycle(input.config) ? reconstructCausalHistoricalState(input) : reconstructPineHistoricalState(input);
}

/**
 * TEDDY_DYNAMIC_SOURCE_LEVEL_V1 history: the chart history [historyStart,
 * switchover) replayed FORWARD through `applyBarInPlace` — the same step the
 * live scanner commits with — so history and live can never disagree, and no
 * source extreme exists before it was printed.
 *
 * Context bars only advance each source candle's aggregate, so a candle that
 * began before the history has its real open: they get no bar index and create
 * no candidate, level, arming or retest. Retests on history bars are reported
 * as non-actionable state writes, exactly like the legacy reconstruction.
 */
export function reconstructCausalHistoricalState(input: NativeHistoricalInput): NativeHistoricalResult {
  const { config, historyStartMs, switchoverMs, contextBars, bars } = input;
  if (!isDynamicLifecycle(config)) refuseHistory("causal history reconstruction is defined for the dynamic source-level lifecycle only");
  if (input.partialPeriodPolicy !== SWITCHOVER_TRUNCATED_CLOSED_BARS) {
    refuseHistory(`partialPeriodPolicy must be ${SWITCHOVER_TRUNCATED_CLOSED_BARS}`);
  }
  if (!Number.isSafeInteger(historyStartMs) || !Number.isSafeInteger(switchoverMs) || historyStartMs >= switchoverMs) {
    refuseHistory("historyStartMs and switchoverMs must be integer times with historyStartMs < switchoverMs");
  }
  if (bars.length === 0 || bars[0].openTimeMs !== historyStartMs) {
    refuseHistory("chart bars must begin exactly at historyStartMs");
  }
  const intervalMs = bars[0].closeTimeMs - bars[0].openTimeMs + 1;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || (switchoverMs - historyStartMs) % intervalMs !== 0) {
    refuseHistory("switchoverMs must be a chart-bar open boundary after historyStartMs");
  }
  const historyBarCount = (switchoverMs - historyStartMs) / intervalMs;
  if (bars.length < historyBarCount) refuseHistory("chart bars end before the switchover");
  const history = bars.slice(0, historyBarCount);

  const working = cloneWorkingState(createNativeEngineState(config));
  // A listing: the symbol's first real bar opens every source period it falls in. Seeding each
  // track with that bar's own candle (marked complete) and then applying the bar is exactly a fresh
  // candle whose real open is known — same open, high, low and close; no bar is added or invented.
  if (input.listingOpenTimeMs !== undefined) {
    const first = contextBars.length > 0 ? contextBars[0] : history[0];
    if (!Number.isSafeInteger(input.listingOpenTimeMs) || first.openTimeMs !== input.listingOpenTimeMs) {
      refuseHistory("listingOpenTimeMs must be the open time of the first bar given (context or history)");
    }
    for (const tf of config.enabledSourceTfs) {
      const track = working.htf[tf]!;
      const fresh = advanceHtfAggregate(null, first, tf, config.calendar);
      working.htf[tf] = { ...track, aggregate: { ...fresh, complete: true } };
    }
  }

  // Context: valid, contiguous, same interval, ending right before the history; aggregates only.
  let context: Pick<NativeEngineState, "config" | "intervalMs" | "lastBar"> = { config, intervalMs: null, lastBar: null };
  for (const bar of contextBars) {
    const contextIntervalMs = assertBarAcceptable(context, bar);
    context = { config, intervalMs: contextIntervalMs, lastBar: { openTimeMs: bar.openTimeMs, closeTimeMs: bar.closeTimeMs, close: bar.close } };
    for (const tf of config.enabledSourceTfs) {
      const track = working.htf[tf]!;
      working.htf[tf] = { ...track, aggregate: advanceHtfAggregate(track.aggregate, bar, tf, config.calendar) };
    }
  }
  if (context.lastBar !== null && (context.intervalMs !== intervalMs || context.lastBar.closeTimeMs + 1 !== historyStartMs)) {
    refuseHistory("context bars must share the chart interval and end immediately before historyStartMs");
  }

  const out: BarOutputs = { registered: [], evicted: [], candidates: [] };
  const touches: NativeHistoricalTouch[] = [];
  for (const bar of history) {
    const before = out.candidates.length;
    applyBarInPlace(working, bar, out);
    for (const c of out.candidates.slice(before)) {
      touches.push({
        actionable: false,
        basis: "HISTORICAL_STATE_WRITE",
        signal: c.signal,
        touchDirection: c.touchDirection,
        levelColor: c.levelColor,
        sourceTf: c.sourceTf,
        levelPrice: c.levelPrice,
        chartBarIndex: c.chartBarIndex,
        chartBarOpenTimeMs: c.chartBarOpenTimeMs,
        chartBarCloseTimeMs: c.chartBarCloseTimeMs,
        level: c.level,
      });
    }
  }

  const report: NativeHistoricalReport = {
    semantics: NATIVE_DYNAMIC_HISTORICAL_STATE_SEMANTICS,
    firstHistoryBar: PINE_V5_FIRST_HISTORY_BAR_NO_EDGE,
    partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
    historyStartMs,
    switchoverMs,
    contextStartMs: contextBars.length > 0 ? contextBars[0].openTimeMs : null,
    contextBarCount: contextBars.length,
    chartBarCount: history.length,
    registrations: out.registered,
    evictions: out.evicted,
    touches,
    firstHistoryBarFlags: [],
    unknownPreviousFlagEdges: [],
    incompletePeriods: [],
    // No projection exists in causal history: the handoff IS the live state.
    handoffPeriods: [],
  };
  return { state: working, report };
}

// ---------------------------------------------------------------------------
// Slice 2B-1 — Pine-compatible HISTORICAL state reconstruction
// ---------------------------------------------------------------------------

function refuseHistory(message: string): never {
  throw new NativeSignalInputError("INVALID_HISTORY_RANGE", message);
}

/**
 * Rebuilds the committed state TradingView holds at `switchoverMs` after
 * computing the chart history [historyStartMs, switchoverMs) — Pine's
 * historical execution, not the causal engine's.
 *
 * Per historical chart bar, in Pine's order:
 *   1. registration from the HISTORICAL projection (each period's final, or
 *      switchover-truncated, candle), edge `tf_s and not tf_s[1]` on the chart
 *      series, D -> 12M and GOR -> ROR -> GOG -> ROG;
 *   2. ARM / DISARM — the causal engine's own transition;
 *   3. the retest loop — the causal engine's own transition. Every qualifying
 *      level gets its cooldown written; each write is reported as a
 *      NativeHistoricalTouch (actionable: false). TradingView delivers nothing
 *      for historical bars, so nothing here is a candidate.
 *
 * The first history bar creates no edge (PINE_V5_FIRST_HISTORY_BAR_NO_EDGE).
 * An unknown projected flag never creates one either. Only bars before the
 * switchover are read: `bars` is cut by COUNT, so a bar at or after the
 * switchover is never inspected. The returned state continues in the causal
 * engine at the bar opening at `switchoverMs` — same levels, same order, same
 * ids, cooldowns, arming and bar index, and the HTF tracks the causal engine
 * would hold after the last historical bar.
 */
export function reconstructPineHistoricalState(input: NativeHistoricalInput): NativeHistoricalResult {
  if (isDynamicLifecycle(input.config)) {
    refuseHistory("the dynamic source-level lifecycle never uses look-ahead history; use reconstructHistoricalState / reconstructCausalHistoricalState");
  }
  if (input.listingOpenTimeMs !== undefined) refuseHistory("a listing origin is defined for the dynamic source-level lifecycle only");
  const { config, historyStartMs, switchoverMs, contextBars, bars } = input;
  if (input.partialPeriodPolicy !== SWITCHOVER_TRUNCATED_CLOSED_BARS) {
    refuseHistory(`partialPeriodPolicy must be ${SWITCHOVER_TRUNCATED_CLOSED_BARS}`);
  }
  if (!Number.isSafeInteger(historyStartMs) || !Number.isSafeInteger(switchoverMs) || historyStartMs >= switchoverMs) {
    refuseHistory("historyStartMs and switchoverMs must be integer times with historyStartMs < switchoverMs");
  }
  if (bars.length === 0 || bars[0].openTimeMs !== historyStartMs) {
    refuseHistory("chart bars must begin exactly at historyStartMs");
  }
  const intervalMs = bars[0].closeTimeMs - bars[0].openTimeMs + 1;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || (switchoverMs - historyStartMs) % intervalMs !== 0) {
    refuseHistory("switchoverMs must be a chart-bar open boundary after historyStartMs");
  }
  const historyBarCount = (switchoverMs - historyStartMs) / intervalMs;
  if (bars.length < historyBarCount) refuseHistory("chart bars end before the switchover");
  // Cut by count: nothing at or after the switchover is ever read.
  const history = bars.slice(0, historyBarCount);

  // Context: valid, contiguous, same interval, ending right before the history.
  let context: Pick<NativeEngineState, "config" | "intervalMs" | "lastBar"> = { config, intervalMs: null, lastBar: null };
  for (const bar of contextBars) {
    const contextIntervalMs = assertBarAcceptable(context, bar);
    context = {
      config,
      intervalMs: contextIntervalMs,
      lastBar: { openTimeMs: bar.openTimeMs, closeTimeMs: bar.closeTimeMs, close: bar.close },
    };
  }
  if (context.lastBar !== null && (context.intervalMs !== intervalMs || context.lastBar.closeTimeMs + 1 !== historyStartMs)) {
    refuseHistory("context bars must share the chart interval and end immediately before historyStartMs");
  }

  const projection = projectPineHistoricalHtf(contextBars, history, config.enabledSourceTfs, config.calendar, switchoverMs);
  const working = cloneWorkingState(createNativeEngineState(config));
  const out: Pick<BarOutputs, "registered" | "evicted"> = { registered: [], evicted: [] };
  const touches: NativeHistoricalTouch[] = [];
  const firstHistoryBarFlags: { sourceTf: NativeSourceTf; condition: NativeLevelCondition }[] = [];
  const unknownPreviousFlagEdges: { sourceTf: NativeSourceTf; condition: NativeLevelCondition; chartBarIndex: number }[] = [];
  const projectedFlags: Partial<Record<NativeSourceTf, NativeConditionFlags | null>> = {};

  for (let i = 0; i < history.length; i += 1) {
    const bar = history[i];
    const barIntervalMs = assertBarAcceptable(working, bar);
    const barIndex = working.barIndex;

    // ---- 1. historical registration (BAGIAN 3 under lookahead_on) ---------
    for (const tf of config.enabledSourceTfs) {
      const period = (projection.periods[tf] as readonly NativeHistoricalPeriod[])[
        (projection.barPeriodIndex[tf] as readonly number[])[i]
      ];
      const flags = evaluateLevelConditions(period.candle, config.minMovePct);
      if (i === 0) {
        // PINE_V5_FIRST_HISTORY_BAR_NO_EDGE: tf_s[1] is na here, so no edge.
        if (flags !== null) {
          for (const condition of NATIVE_LEVEL_CONDITIONS) {
            if (flags[condition]) firstHistoryBarFlags.push({ sourceTf: tf, condition });
          }
        }
      } else {
        const previous = projectedFlags[tf] ?? null;
        if (flags !== null && previous !== null) {
          for (const condition of NATIVE_LEVEL_CONDITIONS) {
            if (!flags[condition] || previous[condition]) continue;
            registerLevelInPlace(working, tf, condition, period.candle, bar, barIndex, out);
          }
        } else if (flags !== null) {
          for (const condition of NATIVE_LEVEL_CONDITIONS) {
            if (flags[condition]) unknownPreviousFlagEdges.push({ sourceTf: tf, condition, chartBarIndex: barIndex });
          }
        }
      }
      projectedFlags[tf] = flags;
    }

    // ---- 2. BAGIAN 4A -------------------------------------------------------
    armDisarmInPlace(working, bar, barIndex);

    // ---- 3. BAGIAN 4B: state writes only; nothing is delivered --------------
    retestInPlace(working, bar, barIndex, (level, longRetest) => {
      touches.push({
        actionable: false,
        basis: "HISTORICAL_STATE_WRITE",
        signal: longRetest ? "LONG" : "SHORT",
        touchDirection: longRetest ? "FROM_ABOVE" : "FROM_BELOW",
        levelColor: level.color,
        sourceTf: level.sourceTf,
        levelPrice: level.price,
        chartBarIndex: barIndex,
        chartBarOpenTimeMs: bar.openTimeMs,
        chartBarCloseTimeMs: bar.closeTimeMs,
        level: {
          id: level.id,
          condition: level.condition,
          htfPeriodStartMs: level.htfPeriodStartMs,
          createdBarIndex: level.createdBarIndex,
          createdBarOpenTimeMs: level.createdBarOpenTimeMs,
        },
      });
    });

    // ---- 4. advance -----------------------------------------------------------
    advanceBarInPlace(working, bar, barIntervalMs);
  }

  // ---- handoff: the HTF tracks the causal engine holds after the last bar ----
  // The last period's projected candle IS the causal aggregate through the bar
  // before the switchover (truncated if the period contains the switchover),
  // and its flags are tf_s[1] for the switchover bar.
  const handoffPeriods: NativeHistoricalPeriod[] = [];
  const incompletePeriods: { sourceTf: NativeSourceTf; periodStartMs: number }[] = [];
  for (const tf of config.enabledSourceTfs) {
    const list = projection.periods[tf] as readonly NativeHistoricalPeriod[];
    const period = list[list.length - 1];
    working.htf[tf] = { aggregate: period.candle, previousFlags: projectedFlags[tf] ?? null };
    handoffPeriods.push(period);
    for (const p of list) if (!p.candle.complete) incompletePeriods.push({ sourceTf: tf, periodStartMs: p.periodStartMs });
  }

  const report: NativeHistoricalReport = {
    semantics: NATIVE_HISTORICAL_STATE_SEMANTICS,
    firstHistoryBar: PINE_V5_FIRST_HISTORY_BAR_NO_EDGE,
    partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
    historyStartMs,
    switchoverMs,
    contextStartMs: contextBars.length > 0 ? contextBars[0].openTimeMs : null,
    contextBarCount: contextBars.length,
    chartBarCount: history.length,
    registrations: out.registered,
    evictions: out.evicted,
    touches,
    firstHistoryBarFlags,
    unknownPreviousFlagEdges,
    incompletePeriods,
    handoffPeriods,
  };
  return { state: working, report };
}
