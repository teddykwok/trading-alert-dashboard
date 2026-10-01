import { advanceHtfAggregate, barFitsHtfPeriod } from "./htf-aggregate";
import {
  NATIVE_LEVEL_CONDITIONS,
  NativeSignalInputError,
  type NativeConditionFlags,
  type NativeEngineConfig,
  type NativeEngineState,
  type NativeHtfAggregate,
  type NativeHtfTrack,
  type NativeKline,
  type NativeLevel,
  type NativeLevelCondition,
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

/** A fresh engine over `config`, before any bar. */
export function createNativeEngineState(config: NativeEngineConfig): NativeEngineState {
  const htf: Partial<Record<NativeSourceTf, NativeHtfTrack>> = {};
  for (const tf of config.enabledSourceTfs) htf[tf] = { aggregate: null, previousFlags: null };
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
 * Refuses a bar the engine cannot reason about. Nothing is repaired: a bar that
 * is malformed, out of order or missing would shift every bar-count rule.
 */
function assertBarAcceptable(state: WorkingState, bar: NativeKline): number {
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
 * @internal Applies one confirmed bar to `state` IN PLACE. Used only by the
 * engine's own `step` and `replay`; the public step clones first.
 */
export function applyBarInPlace(state: WorkingState, bar: NativeKline, out: BarOutputs): void {
  const intervalMs = assertBarAcceptable(state, bar);
  const { config } = state;
  const barIndex = state.barIndex;
  const tolerance = config.touchTolerancePct;

  // ---- 1. BAGIAN 3: registration ------------------------------------------
  // Timeframes in canonical order; within each, GOR -> ROR -> GOG -> ROG.
  // Pine: `if show and tf_sX and not tf_sX[1]` — the previous CHART bar's
  // projected flag, which must be KNOWN false for an edge.
  for (const tf of config.enabledSourceTfs) {
    const track = state.htf[tf] as NativeHtfTrack;
    const aggregate = advanceHtfAggregate(track.aggregate, bar, tf, config.calendar);
    const flags = evaluateLevelConditions(aggregate, config.minMovePct);
    const previous = track.previousFlags;

    if (flags !== null && previous !== null) {
      for (const condition of NATIVE_LEVEL_CONDITIONS) {
        if (!flags[condition] || previous[condition]) continue;
        const shape = LEVEL_SHAPE[condition];
        // f_registerLevel (lines 178-195): push, then drop exactly the oldest.
        const level: Mutable<NativeLevel> = {
          id: state.nextLevelId,
          price: shape.at === "high" ? aggregate.high : aggregate.low,
          color: shape.color,
          sourceTf: tf,
          condition,
          htfPeriodStartMs: aggregate.periodStartMs,
          createdBarIndex: barIndex,
          createdBarOpenTimeMs: bar.openTimeMs,
          lastTouchBarIndex: -1,
          armed: false,
          armedBarIndex: -1,
        };
        state.nextLevelId += 1;
        state.levels.push(level);
        out.registered.push({ ...level });
        if (state.levels.length > config.maxLevels) {
          const dropped = state.levels.shift() as Mutable<NativeLevel>;
          out.evicted.push({ ...dropped });
        }
      }
    }
    state.htf[tf] = { aggregate, previousFlags: flags };
  }

  // ---- 2. BAGIAN 4A: ARM / DISARM on the confirmed close ------------------
  // armedBar moves only on a transition, so minBarsAfterArming measures the
  // age of the arming, not of the latest bar that held above it.
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

  // ---- 3. BAGIAN 4B: retest, oldest level first ---------------------------
  // `close[1]` is na on the first bar, so nothing can retest there.
  const previousClose = state.lastBar === null ? null : state.lastBar.close;
  if (config.retestEnabled && previousClose !== null) {
    for (const level of state.levels) {
      const upperBand = level.price * (1 + tolerance);
      const lowerBand = level.price * (1 - tolerance);
      const armedReady =
        level.armed && level.armedBarIndex >= 0 && barIndex - level.armedBarIndex >= config.minBarsAfterArming;
      const oldEnough = barIndex - level.createdBarIndex >= config.minBarsAfterCreation;
      const cooledDown =
        level.lastTouchBarIndex < 0 || barIndex - level.lastTouchBarIndex >= config.touchCooldownBars;
      const inBand = bar.low <= upperBand && bar.high >= lowerBand;
      const longRetest = level.color === "GREEN" && previousClose > upperBand && inBand;
      const shortRetest = level.color === "RED" && previousClose < lowerBand && inBand;

      if ((longRetest || shortRetest) && armedReady && oldEnough && cooledDown) {
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
        // Written ONLY when a retest fires: a wrong-side touch starts no cooldown.
        level.lastTouchBarIndex = barIndex;
      }
    }
  }

  // ---- 4. advance ----------------------------------------------------------
  state.lastBar = { openTimeMs: bar.openTimeMs, closeTimeMs: bar.closeTimeMs, close: bar.close };
  state.intervalMs = intervalMs;
  state.barIndex = barIndex + 1;
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
