import { advanceHtfAggregate, barFitsHtfPeriod, htfPeriodStartMs } from "./htf-aggregate";
import {
  NATIVE_LEVEL_CONDITIONS,
  NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1,
  NativeSignalInputError,
  type NativeConditionFlags,
  type NativeEngineConfig,
  type NativeEngineDiagnosticSnapshot,
  type NativeEngineState,
  type NativeFormingCandidate,
  type NativeFormingCandidates,
  type NativeHtfAggregate,
  type NativeHtfTrack,
  type NativeImmediateCandidate,
  type NativeImmediateStepResult,
  type NativeKline,
  type NativeLevel,
  type NativeLevelCondition,
  type NativeLevelDiagnostic,
  type NativeRetestCandidate,
  type NativeSourceTf,
  type NativeStepResult,
} from "./types";

/**
 * One confirmed chart bar through Pine v5.5, in Pine's order:
 *
 *   1. BAGIAN 3  register levels from the forming HTF candles (lines 201-249)
 *   2. BAGIAN 4A ARM / DISARM on the confirmed close          (lines 264-280)
 *   3. BAGIAN 4B retest -> committed LONG / SHORT              (lines 297-329)
 *
 * Every comparison is written the way Pine writes it, operand for operand,
 * because doubles make `L * (1 + t)` and `L + L * t` different numbers.
 */

/**
 * The four Pine signals on one forming HTF candle (lines 202-209).
 *
 * The asymmetry is Pine's and is kept exactly: ROR divides by `close`, the
 * other three by `open`; GOG measures `high - close`, not `high - open`. A doji
 * (close == open) is neither red nor green and yields nothing.
 *
 * Returns null when the candle's real open is unknown (`complete` false): an
 * invented open would invent a level.
 */
export function evaluateLevelConditions(
  aggregate: NativeHtfAggregate,
  minMovePct: number
): NativeConditionFlags | null {
  if (!aggregate.complete) return null;
  const { open, high, low, close } = aggregate;
  const isRedCandle = close < open;
  const isGreenCandle = close > open;
  return {
    GOR: isRedCandle && Math.abs(high - open) / open >= minMovePct,
    ROR: isRedCandle && Math.abs(close - low) / close >= minMovePct,
    GOG: isGreenCandle && Math.abs(high - close) / open >= minMovePct,
    ROG: isGreenCandle && Math.abs(open - low) / open >= minMovePct,
  };
}

const LEVEL_SHAPE: Readonly<Record<NativeLevelCondition, { color: "GREEN" | "RED"; at: "high" | "low" }>> =
  Object.freeze({
    GOR: { color: "GREEN", at: "high" },
    ROR: { color: "RED", at: "low" },
    GOG: { color: "GREEN", at: "high" },
    ROG: { color: "RED", at: "low" },
  });

/** True for the TEDDY_DYNAMIC_SOURCE_LEVEL_V1 lifecycle. */
export function isDynamicLifecycle(config: Pick<NativeEngineConfig, "lifecycle">): boolean {
  return config.lifecycle === NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1;
}

const NO_CANDIDATES: NativeFormingCandidates = Object.freeze({ GREEN: null, RED: null });

/** A track as it starts: the dynamic lifecycle carries (empty) forming candidates, the legacy one carries none. */
function emptyTrack(config: NativeEngineConfig): NativeHtfTrack {
  return isDynamicLifecycle(config) ? { aggregate: null, previousFlags: null, candidates: NO_CANDIDATES } : { aggregate: null, previousFlags: null };
}

/**
 * Pine 4B's three timer gates for `level` on the bar with index `barIndex`.
 *
 * PINE_V55_EDGE_FROZEN: `barIndex - anchor >= N` (Pine's own comparison). That
 * lets an Immediate alert fire INSIDE the Nth bar, i.e. after only N-1 full
 * bars have completed since the anchoring close.
 *
 * TEDDY_DYNAMIC_SOURCE_LEVEL_V1: N FULL chart bars must complete after the
 * anchoring close, so eligibility starts with bar anchor + N + 1
 * (`barIndex - anchor > N`): on 15m, creation 5 -> 75 min, arming 4 -> 60 min,
 * cooldown 10 -> ten complete bars (150 min) after the alerting bar.
 */
export function retestTimerGates(
  config: NativeEngineConfig,
  level: Pick<NativeLevel, "armed" | "armedBarIndex" | "createdBarIndex" | "lastTouchBarIndex">,
  barIndex: number
): { readonly armedReady: boolean; readonly oldEnough: boolean; readonly cooledDown: boolean } {
  const passed = (anchor: number, bars: number) => (isDynamicLifecycle(config) ? barIndex - anchor > bars : barIndex - anchor >= bars);
  return {
    armedReady: level.armed && level.armedBarIndex >= 0 && passed(level.armedBarIndex, config.minBarsAfterArming),
    oldEnough: passed(level.createdBarIndex, config.minBarsAfterCreation),
    cooledDown: level.lastTouchBarIndex < 0 || passed(level.lastTouchBarIndex, config.touchCooldownBars),
  };
}

/** A fresh engine over `config`, before any bar. */
export function createNativeEngineState(config: NativeEngineConfig): NativeEngineState {
  const htf: Partial<Record<NativeSourceTf, NativeHtfTrack>> = {};
  for (const tf of config.enabledSourceTfs) htf[tf] = emptyTrack(config);
  return {
    config,
    barIndex: 0,
    lastBar: null,
    intervalMs: null,
    htf,
    levels: [],
    nextLevelId: 0,
  };
}

// ---------------------------------------------------------------------------
// Working (mutable) state — shared with replay.ts only; neither index exports it
// ---------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** @internal */
export interface WorkingState {
  config: NativeEngineConfig;
  barIndex: number;
  lastBar: { openTimeMs: number; closeTimeMs: number; close: number } | null;
  intervalMs: number | null;
  htf: Partial<Record<NativeSourceTf, NativeHtfTrack>>;
  levels: Mutable<NativeLevel>[];
  nextLevelId: number;
}

/** @internal A deep copy that shares nothing mutable with its source. */
export function cloneWorkingState(state: NativeEngineState): WorkingState {
  const htf: Partial<Record<NativeSourceTf, NativeHtfTrack>> = {};
  for (const tf of state.config.enabledSourceTfs) {
    const track = state.htf[tf];
    htf[tf] = {
      aggregate: track?.aggregate ? { ...track.aggregate } : null,
      previousFlags: track?.previousFlags ? { ...track.previousFlags } : null,
      ...(track?.candidates !== undefined
        ? {
            candidates: {
              GREEN: track.candidates.GREEN === null ? null : { ...track.candidates.GREEN },
              RED: track.candidates.RED === null ? null : { ...track.candidates.RED },
            },
          }
        : {}),
    };
  }
  return {
    config: state.config,
    barIndex: state.barIndex,
    lastBar: state.lastBar ? { ...state.lastBar } : null,
    intervalMs: state.intervalMs,
    htf,
    levels: state.levels.map((level) => ({ ...level })),
    nextLevelId: state.nextLevelId,
  };
}

function refuse(code: NativeSignalInputError["code"], message: string): never {
  throw new NativeSignalInputError(code, message);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * @internal Refuses a bar the engine cannot reason about. Nothing is repaired: a bar that
 * is malformed, out of order or missing would shift every bar-count rule.
 */
export function assertBarAcceptable(
  state: Pick<NativeEngineState, "config" | "intervalMs" | "lastBar">,
  bar: NativeKline
): number {
  if (bar === null || typeof bar !== "object") refuse("INVALID_KLINE", "bar must be an object");
  const { openTimeMs, closeTimeMs, open, high, low, close } = bar;
  if (!Number.isSafeInteger(openTimeMs) || !Number.isSafeInteger(closeTimeMs) || closeTimeMs <= openTimeMs) {
    refuse("INVALID_KLINE", "bar times must be integers with closeTimeMs > openTimeMs");
  }
  if (![open, high, low, close].every(isPositiveFinite)) {
    refuse("INVALID_KLINE", "bar prices must be finite and > 0");
  }
  if (low > high || low > Math.min(open, close) || high < Math.max(open, close)) {
    refuse("INVALID_KLINE", "bar must satisfy low <= open,close <= high");
  }

  const intervalMs = closeTimeMs - openTimeMs + 1;
  if (state.intervalMs !== null && intervalMs !== state.intervalMs) {
    refuse("INCONSISTENT_INTERVAL", `bar interval ${intervalMs}ms differs from ${state.intervalMs}ms`);
  }
  if (state.lastBar !== null && openTimeMs !== state.lastBar.closeTimeMs + 1) {
    refuse(
      "NON_CONTIGUOUS_BARS",
      `bar opening at ${openTimeMs} does not follow the bar that closed at ${state.lastBar.closeTimeMs}`
    );
  }
  for (const tf of state.config.enabledSourceTfs) {
    if (!barFitsHtfPeriod(bar, tf, state.config.calendar)) {
      refuse("BAR_STRADDLES_HTF_PERIOD", `chart bar opening at ${openTimeMs} spans a ${tf} period boundary`);
    }
  }
  return intervalMs;
}

/** @internal */
export interface BarOutputs {
  registered: NativeLevel[];
  evicted: NativeLevel[];
  candidates: NativeRetestCandidate[];
}

/**
 * @internal Pine's `f_registerLevel` (lines 178-195): push one level, then drop
 * exactly the oldest once the registry exceeds MAX_LEVELS.
 *
 * `source` is the HTF candle the registering projection saw: the causal
 * forming candle here, or the period's projected candle during historical
 * reconstruction (replay.ts).
 */
export function registerLevelInPlace(
  state: WorkingState,
  tf: NativeSourceTf,
  condition: NativeLevelCondition,
  source: Pick<NativeHtfAggregate, "periodStartMs" | "high" | "low">,
  bar: NativeKline,
  barIndex: number,
  out: Pick<BarOutputs, "registered" | "evicted">
): void {
  const shape = LEVEL_SHAPE[condition];
  pushLevelInPlace(
    state,
    {
      price: shape.at === "high" ? source.high : source.low,
      color: shape.color,
      sourceTf: tf,
      condition,
      htfPeriodStartMs: source.periodStartMs,
      createdBarIndex: barIndex,
      createdBarOpenTimeMs: bar.openTimeMs,
    },
    out
  );
}

/** Pushes one persistent level (new id, unarmed, never touched), then applies MAX_LEVELS. */
function pushLevelInPlace(
  state: WorkingState,
  fields: Pick<NativeLevel, "price" | "color" | "sourceTf" | "condition" | "htfPeriodStartMs" | "createdBarIndex" | "createdBarOpenTimeMs">,
  out: Pick<BarOutputs, "registered" | "evicted">
): void {
  const level: Mutable<NativeLevel> = {
    id: state.nextLevelId,
    price: fields.price,
    color: fields.color,
    sourceTf: fields.sourceTf,
    condition: fields.condition,
    htfPeriodStartMs: fields.htfPeriodStartMs,
    createdBarIndex: fields.createdBarIndex,
    createdBarOpenTimeMs: fields.createdBarOpenTimeMs,
    lastTouchBarIndex: -1,
    armed: false,
    armedBarIndex: -1,
  };
  state.nextLevelId += 1;
  state.levels.push(level);
  out.registered.push({ ...level });
  if (state.levels.length > state.config.maxLevels) {
    const dropped = state.levels.shift() as Mutable<NativeLevel>;
    out.evicted.push({ ...dropped });
  }
}

/**
 * @internal TEDDY_DYNAMIC_SOURCE_LEVEL_V1: one source timeframe's forming
 * candidates after this bar's close, then — if this bar closes the source
 * candle — finalization.
 *
 *  - GREEN qualifies when GOR or GOG holds; RED when ROR or ROG holds. A body
 *    colour change (GOR -> GOG) is the SAME GREEN candidate.
 *  - A qualifying colour without a candidate creates one, anchored at this bar
 *    (its first qualification). An existing candidate's price follows the
 *    running high / low on every close, and `active` mirrors qualification:
 *    flicker off/on never creates a second candidate and never moves the anchor.
 *  - On the source candle's LAST chart bar (the next bar opens a new period) an
 *    active candidate becomes exactly one persistent level at the final
 *    extreme; an inactive one is discarded. Either way the period's candidates
 *    are then cleared.
 *
 * GREEN before RED within a timeframe; timeframes in canonical order (caller).
 */
function advanceDynamicCandidatesInPlace(
  state: WorkingState,
  tf: NativeSourceTf,
  aggregate: NativeHtfAggregate,
  flags: NativeConditionFlags | null,
  bar: NativeKline,
  barIndex: number,
  out: Pick<BarOutputs, "registered" | "evicted">
): NativeFormingCandidates {
  const previous = (state.htf[tf] as NativeHtfTrack).candidates ?? NO_CANDIDATES;
  const next: { GREEN: NativeFormingCandidate | null; RED: NativeFormingCandidate | null } = { GREEN: null, RED: null };
  for (const color of ["GREEN", "RED"] as const) {
    // A candidate belongs to exactly one source period: a new period starts with none.
    const held = previous[color] !== null && previous[color]!.periodStartMs === aggregate.periodStartMs ? previous[color] : null;
    const condition: NativeLevelCondition | null =
      flags === null ? null : color === "GREEN" ? (flags.GOR ? "GOR" : flags.GOG ? "GOG" : null) : flags.ROR ? "ROR" : flags.ROG ? "ROG" : null;
    const price = color === "GREEN" ? aggregate.high : aggregate.low;
    if (held === null) {
      next[color] =
        condition === null
          ? null
          : { color, periodStartMs: aggregate.periodStartMs, firstQualifiedBarIndex: barIndex, firstQualifiedBarOpenTimeMs: bar.openTimeMs, active: true, price, condition };
    } else {
      next[color] = { ...held, active: condition !== null, price, condition: condition ?? held.condition };
    }
  }

  // Finalization: this bar closes the source candle when the next bar opens a new period.
  const closesPeriod = htfPeriodStartMs(tf, bar.closeTimeMs + 1, state.config.calendar) !== aggregate.periodStartMs;
  if (!closesPeriod) return next;
  for (const color of ["GREEN", "RED"] as const) {
    const candidate = next[color];
    if (candidate === null || !candidate.active) continue; // no qualification at the close: no level at all
    pushLevelInPlace(
      state,
      {
        price: candidate.price,
        color,
        sourceTf: tf,
        condition: candidate.condition,
        htfPeriodStartMs: candidate.periodStartMs,
        createdBarIndex: candidate.firstQualifiedBarIndex,
        createdBarOpenTimeMs: candidate.firstQualifiedBarOpenTimeMs,
      },
      out
    );
  }
  return NO_CANDIDATES;
}

/**
 * @internal BAGIAN 4A (lines 264-280): ARM / DISARM on the confirmed close.
 * armedBar moves only on a transition, so minBarsAfterArming measures the age
 * of the arming, not of the latest bar that held above it.
 */
export function armDisarmInPlace(state: WorkingState, bar: NativeKline, barIndex: number): void {
  const tolerance = state.config.touchTolerancePct;
  for (const level of state.levels) {
    const upperBand = level.price * (1 + tolerance);
    const lowerBand = level.price * (1 - tolerance);
    const isGreen = level.color === "GREEN";
    const armNow = isGreen ? bar.close > upperBand : bar.close < lowerBand;
    const breakNow = isGreen ? bar.close < lowerBand : bar.close > upperBand;
    if (!level.armed && armNow) {
      level.armed = true;
      level.armedBarIndex = barIndex;
    } else if (level.armed && breakNow) {
      level.armed = false;
      level.armedBarIndex = -1;
    }
  }
}

/**
 * @internal BAGIAN 4B (lines 297-329): the retest loop, oldest level first.
 *
 * For each qualifying level `onRetest` is told first, then that level's
 * `lvlLastTouchBar` is written — for EVERY qualifying level, exactly as Pine's
 * loop runs `array.set` after each `alert()` call and never breaks. What a
 * qualifying level means to the caller (a committed candidate, or a historical
 * state write) is the caller's business; the state write is not.
 */
export function retestInPlace(
  state: WorkingState,
  bar: NativeKline,
  barIndex: number,
  onRetest: (level: Readonly<NativeLevel>, longRetest: boolean) => void
): void {
  const { config } = state;
  const tolerance = config.touchTolerancePct;
  // `close[1]` is na on the first bar, so nothing can retest there.
  const previousClose = state.lastBar === null ? null : state.lastBar.close;
  if (config.retestEnabled && previousClose !== null) {
    for (const level of state.levels) {
      const upperBand = level.price * (1 + tolerance);
      const lowerBand = level.price * (1 - tolerance);
      const { armedReady, oldEnough, cooledDown } = retestTimerGates(config, level, barIndex);
      const inBand = bar.low <= upperBand && bar.high >= lowerBand;
      const longRetest = level.color === "GREEN" && previousClose > upperBand && inBand;
      const shortRetest = level.color === "RED" && previousClose < lowerBand && inBand;

      if ((longRetest || shortRetest) && armedReady && oldEnough && cooledDown) {
        onRetest(level, longRetest);
        // Written ONLY when a retest fires: a wrong-side touch starts no cooldown.
        level.lastTouchBarIndex = barIndex;
      }
    }
  }
}

/** @internal Step 4: this bar becomes `close[1]` for the next one. */
export function advanceBarInPlace(state: WorkingState, bar: NativeKline, intervalMs: number): void {
  state.lastBar = { openTimeMs: bar.openTimeMs, closeTimeMs: bar.closeTimeMs, close: bar.close };
  state.intervalMs = intervalMs;
  state.barIndex += 1;
}

/**
 * @internal Applies one confirmed bar to `state` IN PLACE. Used only by the
 * engine's own `step` and `replay`; the public step clones first.
 */
export function applyBarInPlace(state: WorkingState, bar: NativeKline, out: BarOutputs): void {
  const intervalMs = assertBarAcceptable(state, bar);
  const { config } = state;
  const barIndex = state.barIndex;
  const dynamic = isDynamicLifecycle(config);

  // Dynamic lifecycle: the levels an IMMEDIATE alert may have been emitted for
  // during this bar, from the pre-bar committed state (exactly what the live
  // session evaluates). Their cooldown is written below AFTER the close-tick
  // steps, so a later same-bar disarm can never erase an emitted alert.
  const immediateLevelIds = dynamic ? new Set(reconstructImmediateCandidates(state, bar).map((c) => c.level.id)) : null;

  // ---- 1. Source levels ------------------------------------------------------
  // Timeframes in canonical order.
  //  Legacy: within each, GOR -> ROR -> GOG -> ROG, Pine's `if show and tf_sX and
  //   not tf_sX[1]` — the previous CHART bar's projected flag, which must be
  //   KNOWN false for an edge.
  //  Dynamic: update this period's forming candidates, finalize on the period's
  //   last bar (advanceDynamicCandidatesInPlace).
  for (const tf of config.enabledSourceTfs) {
    const track = state.htf[tf] as NativeHtfTrack;
    const aggregate = advanceHtfAggregate(track.aggregate, bar, tf, config.calendar);
    const flags = evaluateLevelConditions(aggregate, config.minMovePct);
    if (dynamic) {
      const candidates = advanceDynamicCandidatesInPlace(state, tf, aggregate, flags, bar, barIndex, out);
      state.htf[tf] = { aggregate, previousFlags: flags, candidates };
      continue;
    }
    const previous = track.previousFlags;

    if (flags !== null && previous !== null) {
      for (const condition of NATIVE_LEVEL_CONDITIONS) {
        if (!flags[condition] || previous[condition]) continue;
        registerLevelInPlace(state, tf, condition, aggregate, bar, barIndex, out);
      }
    }
    state.htf[tf] = { aggregate, previousFlags: flags };
  }

  // ---- 2. BAGIAN 4A: ARM / DISARM on the confirmed close ------------------
  armDisarmInPlace(state, bar, barIndex);

  // ---- 3. BAGIAN 4B: retest -> committed candidates -----------------------
  retestInPlace(state, bar, barIndex, (level, longRetest) => {
    out.candidates.push({
      basis: "COMMITTED_BAR_CLOSE",
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

  // ---- 3b. Dynamic: an emitted Immediate alert always consumes its cooldown --
  if (immediateLevelIds !== null && immediateLevelIds.size > 0) {
    for (const level of state.levels) if (immediateLevelIds.has(level.id)) level.lastTouchBarIndex = barIndex;
  }

  // ---- 4. advance ----------------------------------------------------------
  advanceBarInPlace(state, bar, intervalMs);
}

/**
 * Pure: one confirmed bar in, a new state out. `state` is never modified, so a
 * caller can keep the previous state and compare.
 */
export function stepNativeEngine(state: NativeEngineState, bar: NativeKline): NativeStepResult {
  const working = cloneWorkingState(state);
  const out: BarOutputs = { registered: [], evicted: [], candidates: [] };
  applyBarInPlace(working, bar, out);
  return { state: working, registered: out.registered, evicted: out.evicted, candidates: out.candidates };
}

// ---------------------------------------------------------------------------
// Slice 1b — IMMEDIATE INTRABAR candidates
// ---------------------------------------------------------------------------

/**
 * How many of the OLDEST pre-bar levels might be missing from the registry on
 * some intrabar update.
 *
 * On a realtime update Pine re-runs BAGIAN 3 before 4B, and a rising HTF flag
 * registers a level for that update (rolled back before the next). Past
 * MAX_LEVELS each such push shifts the oldest level out — for that update. Per
 * update, a timeframe can push at most the two conditions of its forming
 * candle's colour (GOR+ROR when red, GOG+ROG when green), and only conditions
 * whose committed previous flag is KNOWN false can edge at all. That bounds the
 * pushes per update, and therefore how many oldest levels are at risk.
 *
 * An upper bound, deliberately: it never claims a level was present when it
 * might not have been.
 */
function levelsAtIntrabarEvictionRisk(preBar: NativeEngineState): number {
  // Dynamic lifecycle: levels are only ever pushed at a confirmed close (source
  // candle finalization), never transiently intrabar, so no level is at risk.
  if (isDynamicLifecycle(preBar.config)) return 0;
  let maxPushesPerUpdate = 0;
  for (const tf of preBar.config.enabledSourceTfs) {
    const previous = preBar.htf[tf]?.previousFlags ?? null;
    if (previous === null) continue;
    const redPushes = Number(!previous.GOR) + Number(!previous.ROR);
    const greenPushes = Number(!previous.GOG) + Number(!previous.ROG);
    maxPushesPerUpdate += Math.max(redPushes, greenPushes);
  }
  return Math.max(0, preBar.levels.length + maxPushesPerUpdate - preBar.config.maxLevels);
}

/**
 * The IMMEDIATE INTRABAR candidates of `bar`, reconstructed from `preBar` —
 * the state committed at the close of the PREVIOUS bar.
 *
 * Pine's realtime model makes this exact for levels that already existed:
 * before the confirmed tick, 4A has not run, so armed / armedBar / createdBar /
 * lastTouch are the previous close's values, `close[1]` is the previous close,
 * and only the bar's high and low move — monotonically outward. Every 4B
 * condition except `inBand` is therefore fixed for the whole bar, and `inBand`
 * held on some update if and only if it holds for the FINAL range.
 *
 * Deliberately limited:
 *  - Only levels in `preBar` are considered. A level registered during this bar
 *    (transiently intrabar, or at the close) is never reconstructed: its price
 *    and existence depend on the intrabar path, which OHLC does not record. It
 *    could not pass `oldEnough` anyway (minBarsAfterCreation >= 1).
 *  - Every qualifying level is returned, oldest first. Whether TradingView
 *    delivered one alert per bar or one per level is a platform question this
 *    engine does not answer.
 *  - Nothing here commits anything. `preBar` is only read.
 */
export function reconstructImmediateCandidates(
  preBar: NativeEngineState,
  bar: NativeKline
): NativeImmediateCandidate[] {
  assertBarAcceptable(preBar, bar);
  const { config } = preBar;
  // Pine alerts intrabar only in Immediate mode (freq_once_per_bar), and only
  // when the 4B loop runs at all (line 297). `close[1]` is na on the first bar.
  if (config.timing !== "Immediate" || !config.retestEnabled || preBar.lastBar === null) return [];

  const barIndex = preBar.barIndex;
  const previousClose = preBar.lastBar.close;
  const tolerance = config.touchTolerancePct;
  const atRisk = levelsAtIntrabarEvictionRisk(preBar);
  const candidates: NativeImmediateCandidate[] = [];

  for (let position = 0; position < preBar.levels.length; position += 1) {
    const level = preBar.levels[position];
    // Pine's 4B conditions, operand for operand — against the PRE-BAR state.
    const upperBand = level.price * (1 + tolerance);
    const lowerBand = level.price * (1 - tolerance);
    const { armedReady, oldEnough, cooledDown } = retestTimerGates(config, level, barIndex);
    const inBand = bar.low <= upperBand && bar.high >= lowerBand;
    const longRetest = level.color === "GREEN" && previousClose > upperBand && inBand;
    const shortRetest = level.color === "RED" && previousClose < lowerBand && inBand;
    if (!((longRetest || shortRetest) && armedReady && oldEnough && cooledDown)) continue;

    // The low reached the band before the closing update if the bar opened at
    // or below it, or if its low was printed before the close (low < close).
    // Likewise for the high. Both must hold on the same earlier update, which
    // monotonic high/low guarantee once each has been reached.
    const lowBeforeClose = bar.open <= upperBand || bar.low < bar.close;
    const highBeforeClose = bar.open >= lowerBand || bar.high > bar.close;

    candidates.push({
      basis: "IMMEDIATE_INTRABAR",
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
      proof: {
        bandEnteredBeforeClosingUpdate: lowBeforeClose && highBeforeClose,
        levelPresentOnEveryUpdate: position >= atRisk,
      },
    });
  }
  return candidates;
}

/**
 * A read-only DIAGNOSTIC view of `state`: every registered level with each of
 * Pine's 4B gates evaluated for the NEXT bar, exactly as
 * `reconstructImmediateCandidates` and the retest loop evaluate them.
 *
 * `state` is only read. The result is a fresh, frozen structure that shares no
 * object with `state`, so calling this any number of times cannot change a
 * later step, the canonical state, or its hash. No clock, no input beyond
 * `state`.
 */
export function snapshotNativeEngineForNextBar(state: NativeEngineState): NativeEngineDiagnosticSnapshot {
  const { config } = state;
  const barIndex = state.barIndex;
  const tolerance = config.touchTolerancePct;
  const previousClose = state.lastBar === null ? null : state.lastBar.close;
  const atRisk = levelsAtIntrabarEvictionRisk(state);
  const levels: NativeLevelDiagnostic[] = state.levels.map((level, position) => {
    // Pine's 4B conditions, operand for operand, as in reconstructImmediateCandidates.
    const upperBand = level.price * (1 + tolerance);
    const lowerBand = level.price * (1 - tolerance);
    const { armedReady, oldEnough, cooledDown } = retestTimerGates(config, level, barIndex);
    const approachSide =
      previousClose !== null && (level.color === "GREEN" ? previousClose > upperBand : previousClose < lowerBand);
    return Object.freeze({
      position,
      id: level.id,
      sourceTf: level.sourceTf,
      color: level.color,
      condition: level.condition,
      price: level.price,
      htfPeriodStartMs: level.htfPeriodStartMs,
      createdBarIndex: level.createdBarIndex,
      createdBarOpenTimeMs: level.createdBarOpenTimeMs,
      armed: level.armed,
      armedBarIndex: level.armedBarIndex,
      lastTouchBarIndex: level.lastTouchBarIndex,
      upperBand,
      lowerBand,
      retestSignal: level.color === "GREEN" ? "LONG" : "SHORT",
      gates: Object.freeze({ armedReady, oldEnough, cooledDown, approachSide }),
      intrabarEvictionRisk: position < atRisk,
    });
  });
  return Object.freeze({
    nextBarIndex: barIndex,
    previousClose,
    lastBarOpenTimeMs: state.lastBar === null ? null : state.lastBar.openTimeMs,
    retestEnabled: config.retestEnabled,
    timing: config.timing,
    levels: Object.freeze(levels),
  });
}

/**
 * One bar, both candidate kinds, in Pine's order:
 *
 *   A/B. IMMEDIATE INTRABAR candidates, from the state committed at the
 *        previous close — before anything this bar does;
 *   C.   the confirmed-close engine, exactly `stepNativeEngine`;
 *   D.   both, in separate fields.
 *
 * The immediate reconstruction reads `state` and nothing else, so the
 * committed result is identical to `stepNativeEngine(state, bar)`.
 */
export function stepNativeEngineWithImmediate(state: NativeEngineState, bar: NativeKline): NativeImmediateStepResult {
  const immediateCandidates = reconstructImmediateCandidates(state, bar);
  const committed = stepNativeEngine(state, bar);
  return { ...committed, immediateCandidates };
}
