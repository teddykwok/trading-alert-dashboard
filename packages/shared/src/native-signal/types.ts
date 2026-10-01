import type { LevelColor, SourceTimeframe } from "../alert-context";

/**
 * Teddy native signal engine — Slice 1: the PURE engine.
 *
 * A deterministic re-statement of `docs/pine/teddy-v5.5-current.pine` over
 * closed Binance-style klines. Nothing in this folder performs I/O, reads the
 * environment, consults a clock or holds hidden state: every output is a
 * function of (bars, config) alone, so the same input always replays to the
 * same levels and the same candidates.
 *
 * ## Which Pine semantics, exactly
 *
 * "Pine v5.5, continuous-realtime, committed state". TradingView evaluates the
 * script differently on historical and realtime bars, and only one of the two
 * can be reproduced honestly:
 *
 *  - On HISTORICAL bars, `request.security(..., lookahead=barmerge.lookahead_on)`
 *    hands every chart bar of a higher-timeframe period that period's FINAL
 *    high, low and signal flags — a monthly level appears on the 1st, at a
 *    high the month has not printed yet. That is future data. It is NOT
 *    reproduced here, and must never be.
 *
 *  - On REALTIME bars the same call returns the FORMING higher-timeframe
 *    candle. At each chart-bar close that candle is exactly
 *      open  = open of the period's first sub-bar
 *      high  = max high so far, low = min low so far
 *      close = this chart bar's close
 *    which this engine rebuilds from the chart bars themselves.
 *
 *  - "Committed": Pine rolls `var` state back on every realtime tick and keeps
 *    only what the closing tick computed. Arming, cooldown and registration are
 *    therefore functions of CLOSED bars, and are identical for the
 *    "Immediate" and "Bar Close" timing modes. The modes differ only in WHEN
 *    an alert is emitted; that intrabar emission is out of scope here.
 */

/** The six level-origin timeframes. One vocabulary with `alert-context`. */
export type NativeSourceTf = SourceTimeframe;
export type NativeLevelColor = LevelColor;

/**
 * Registration order across timeframes: Pine's BAGIAN 3 call order
 * (`f_processTimeframe` for "D","W","M","3M","6M","12M", lines 244-249).
 */
export const NATIVE_SOURCE_TF_ORDER: readonly NativeSourceTf[] = Object.freeze([
  "1D",
  "1W",
  "1M",
  "3M",
  "6M",
  "12M",
] as const);

/**
 * The four level conditions, in Pine's order within one timeframe
 * (lines 220, 225, 230, 235). GOR/GOG register GREEN at the HTF high; ROR/ROG
 * register RED at the HTF low.
 */
export const NATIVE_LEVEL_CONDITIONS = ["GOR", "ROR", "GOG", "ROG"] as const;
export type NativeLevelCondition = (typeof NATIVE_LEVEL_CONDITIONS)[number];

/** Pine `touchAlertTiming` (line 89), spelled exactly as the webhook note does. */
export type NativeTimingMode = "Immediate" | "Bar Close";
export const NATIVE_TIMING_MODES: readonly NativeTimingMode[] = Object.freeze(["Immediate", "Bar Close"] as const);

export type NativeSignal = "LONG" | "SHORT";
export type NativeTouchDirection = "FROM_ABOVE" | "FROM_BELOW";

/**
 * One CLOSED chart bar.
 *
 * Plain JavaScript numbers on purpose: Pine computes in IEEE-754 doubles, so
 * doubles are what reproduce its comparisons — a decimal type would disagree
 * with TradingView at exactly the knife-edge cases parity cares about.
 *
 * Times follow Binance's kline convention: `closeTimeMs = openTimeMs +
 * interval - 1`.
 */
export interface NativeKline {
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/**
 * How higher-timeframe periods are cut, stated rather than assumed.
 *
 * All boundaries are UTC. Days start at 00:00 UTC. Weeks start at 00:00 UTC on
 * `weekStartsOnUtcDay` (0 = Sunday ... 6 = Saturday). 3M, 6M and 12M periods
 * are calendar blocks of months starting at `multiMonthAnchorMonth`
 * (0 = January), so the default gives quarters Jan/Apr/Jul/Oct, halves Jan/Jul
 * and calendar years. 1M is always the calendar month.
 *
 * The defaults are what Binance uses for 1w/1M klines. That TradingView cuts
 * BINANCE perpetual 3M/6M/12M candles the same way is UNVERIFIED, which is why
 * this is a parameter and not a constant.
 */
export interface CalendarAlignment {
  readonly weekStartsOnUtcDay: number;
  readonly multiMonthAnchorMonth: number;
}

export const DEFAULT_CALENDAR_ALIGNMENT: CalendarAlignment = Object.freeze({
  weekStartsOnUtcDay: 1,
  multiMonthAnchorMonth: 0,
});

/**
 * Every Pine input that changes what the engine computes.
 *
 * Fractions, not percentage points: Pine divides its percentage inputs by 100
 * once (lines 30 and 80), and so should the caller — see
 * `pinePercentInputToFraction`, which performs that same IEEE division.
 */
export interface NativeEngineConfig {
  /** `minPercentInput` (line 30) as a fraction. REQUIRED: there is no default. */
  readonly minMovePct: number;
  /** `touchTolerancePct` (line 80) as a fraction. Band = level·(1 ± this). */
  readonly touchTolerancePct: number;
  /** `touchCooldownBars` (line 81), in chart bars. */
  readonly touchCooldownBars: number;
  /** `minBarsAfterCreation` (line 82), in chart bars. */
  readonly minBarsAfterCreation: number;
  /** `minBarsAfterArming` (line 85), in chart bars. */
  readonly minBarsAfterArming: number;
  /** `MAX_LEVELS` (line 165). The oldest level is dropped beyond this. */
  readonly maxLevels: number;
  /**
   * The `show{D1,W1,M1,M3,M6,M12}` inputs (lines 60-71). In Pine these display
   * toggles also gate level REGISTRATION (`if show and ...`), so a hidden
   * timeframe produces no levels and no signals. Always held in canonical order.
   */
  readonly enabledSourceTfs: readonly NativeSourceTf[];
  /**
   * `enableWebhookAlerts and enableLevelTouchedAlerts and webhookSecret != ""`
   * (line 297). False skips the whole retest loop — no candidates AND no
   * cooldown commits — while arming still updates (line 262).
   */
  readonly retestEnabled: boolean;
  /** `touchAlertTiming` (line 89). Does not change committed state; see file header. */
  readonly timing: NativeTimingMode;
  readonly calendar: CalendarAlignment;
}

/**
 * Pine v5.5's input defaults for everything EXCEPT the move threshold.
 *
 * `minMovePct` is absent deliberately. Pine defaults it to 15%, but the
 * preserved production evidence ran at 7%; a default here would silently pick
 * one of them. The caller must state it.
 */
export const PINE_V55_INPUT_DEFAULTS = Object.freeze({
  touchTolerancePct: 0.01,
  touchCooldownBars: 10,
  minBarsAfterCreation: 5,
  minBarsAfterArming: 4,
  maxLevels: 500,
  retestEnabled: true,
  timing: "Immediate" as NativeTimingMode,
});

export type NativeEngineConfigInput = Pick<NativeEngineConfig, "minMovePct"> &
  Partial<Omit<NativeEngineConfig, "minMovePct">>;

/** Pine's own conversion: a percentage-point input divided by 100, once. */
export function pinePercentInputToFraction(percentPoints: number): number {
  return percentPoints / 100;
}

/** One registered level ("sinar"), with Pine's per-level parallel-array state. */
export interface NativeLevel {
  /** Registration ordinal. Never reused, so it survives MAX_LEVELS eviction. */
  readonly id: number;
  readonly price: number;
  readonly color: NativeLevelColor;
  readonly sourceTf: NativeSourceTf;
  readonly condition: NativeLevelCondition;
  /** Start of the HTF period whose forming candle produced this level. */
  readonly htfPeriodStartMs: number;
  readonly createdBarIndex: number;
  readonly createdBarOpenTimeMs: number;
  /** `lvlLastTouchBar`: -1 until a committed retest fires. */
  readonly lastTouchBarIndex: number;
  readonly armed: boolean;
  /** `lvlArmedBar`: set on the unarmed -> armed transition only; -1 otherwise. */
  readonly armedBarIndex: number;
}

/** The forming higher-timeframe candle as of the latest chart-bar close. */
export interface NativeHtfAggregate {
  readonly periodStartMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /**
   * True only when the period's FIRST sub-bar was observed, i.e. `open` is the
   * period's real open. A period that began before the first replayed bar has
   * an unknown open, so its flags are unknown rather than guessed.
   */
  readonly complete: boolean;
}

export type NativeConditionFlags = Readonly<Record<NativeLevelCondition, boolean>>;

export interface NativeHtfTrack {
  readonly aggregate: NativeHtfAggregate | null;
  /**
   * The flags projected onto the PREVIOUS chart bar — Pine's `tf_sX[1]`. Null
   * means unknown (no previous bar, or an incomplete period), and an unknown
   * previous value never enables an edge.
   */
  readonly previousFlags: NativeConditionFlags | null;
}

export interface NativeEngineState {
  readonly config: NativeEngineConfig;
  /** Index the NEXT bar will receive; equals the number of bars processed. */
  readonly barIndex: number;
  readonly lastBar: { readonly openTimeMs: number; readonly closeTimeMs: number; readonly close: number } | null;
  readonly intervalMs: number | null;
  readonly htf: Readonly<Partial<Record<NativeSourceTf, NativeHtfTrack>>>;
  /** Oldest first — Pine's array order, and therefore the retest loop order. */
  readonly levels: readonly NativeLevel[];
  readonly nextLevelId: number;
}

/**
 * A committed retest: the closing-tick evaluation of Pine's 4B loop fired and
 * `lvlLastTouchBar` was written.
 *
 * In "Bar Close" mode this is exactly the alert Pine sends. In "Immediate" mode
 * Pine may additionally have sent an intrabar alert that the closing tick did
 * not confirm; those are not modelled in Slice 1.
 */
export interface NativeRetestCandidate {
  readonly basis: "COMMITTED_BAR_CLOSE";
  readonly signal: NativeSignal;
  readonly touchDirection: NativeTouchDirection;
  readonly levelColor: NativeLevelColor;
  readonly sourceTf: NativeSourceTf;
  readonly levelPrice: number;
  readonly chartBarIndex: number;
  readonly chartBarOpenTimeMs: number;
  readonly chartBarCloseTimeMs: number;
  /** Everything a later slice needs to build a stable event key. */
  readonly level: {
    readonly id: number;
    readonly condition: NativeLevelCondition;
    readonly htfPeriodStartMs: number;
    readonly createdBarIndex: number;
    readonly createdBarOpenTimeMs: number;
  };
}

export interface NativeStepResult {
  readonly state: NativeEngineState;
  /** Levels registered on this bar, as they were at registration. */
  readonly registered: readonly NativeLevel[];
  /** Levels dropped by MAX_LEVELS on this bar. */
  readonly evicted: readonly NativeLevel[];
  readonly candidates: readonly NativeRetestCandidate[];
}

export type NativeSignalInputErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_KLINE"
  | "INCONSISTENT_INTERVAL"
  | "NON_CONTIGUOUS_BARS"
  | "BAR_STRADDLES_HTF_PERIOD";

/**
 * Refusal to compute over input the engine cannot reason about honestly.
 *
 * Thrown rather than skipped: a bar that is malformed, out of order or missing
 * would silently shift every bar-count rule in Pine, and a quietly wrong level
 * is worse than no level.
 */
export class NativeSignalInputError extends Error {
  constructor(
    readonly code: NativeSignalInputErrorCode,
    message: string
  ) {
    super(message);
    this.name = "NativeSignalInputError";
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function refuseConfig(message: string): never {
  throw new NativeSignalInputError("INVALID_CONFIG", message);
}

/** Validates and freezes a configuration. Every value is checked; none is clamped. */
export function createNativeEngineConfig(input: NativeEngineConfigInput): NativeEngineConfig {
  if (input === null || typeof input !== "object") refuseConfig("config must be an object");
  if (typeof input.minMovePct !== "number" || !Number.isFinite(input.minMovePct) || input.minMovePct < 0) {
    refuseConfig("minMovePct is required and must be a finite fraction >= 0 (Pine input / 100)");
  }

  const touchTolerancePct = input.touchTolerancePct ?? PINE_V55_INPUT_DEFAULTS.touchTolerancePct;
  if (!Number.isFinite(touchTolerancePct) || touchTolerancePct < 0 || touchTolerancePct >= 1) {
    refuseConfig("touchTolerancePct must be a finite fraction in [0, 1)");
  }

  // Pine declares minval=1 for all three (lines 81, 82, 85).
  const touchCooldownBars = input.touchCooldownBars ?? PINE_V55_INPUT_DEFAULTS.touchCooldownBars;
  const minBarsAfterCreation = input.minBarsAfterCreation ?? PINE_V55_INPUT_DEFAULTS.minBarsAfterCreation;
  const minBarsAfterArming = input.minBarsAfterArming ?? PINE_V55_INPUT_DEFAULTS.minBarsAfterArming;
  const maxLevels = input.maxLevels ?? PINE_V55_INPUT_DEFAULTS.maxLevels;
  for (const [name, value] of [
    ["touchCooldownBars", touchCooldownBars],
    ["minBarsAfterCreation", minBarsAfterCreation],
    ["minBarsAfterArming", minBarsAfterArming],
    ["maxLevels", maxLevels],
  ] as const) {
    if (!isPositiveInteger(value)) refuseConfig(`${name} must be an integer >= 1`);
  }

  const requested = input.enabledSourceTfs ?? NATIVE_SOURCE_TF_ORDER;
  if (!Array.isArray(requested)) refuseConfig("enabledSourceTfs must be an array");
  const seen = new Set<string>();
  for (const tf of requested) {
    if (!(NATIVE_SOURCE_TF_ORDER as readonly string[]).includes(tf)) {
      refuseConfig(`enabledSourceTfs contains an unknown timeframe: ${String(tf)}`);
    }
    if (seen.has(tf)) refuseConfig(`enabledSourceTfs lists ${tf} twice`);
    seen.add(tf);
  }
  // Canonical order regardless of how the caller listed them: registration
  // order is Pine's, never the caller's.
  const enabledSourceTfs = Object.freeze(NATIVE_SOURCE_TF_ORDER.filter((tf) => seen.has(tf)));

  const retestEnabled = input.retestEnabled ?? PINE_V55_INPUT_DEFAULTS.retestEnabled;
  if (typeof retestEnabled !== "boolean") refuseConfig("retestEnabled must be a boolean");

  const timing = input.timing ?? PINE_V55_INPUT_DEFAULTS.timing;
  if (!NATIVE_TIMING_MODES.includes(timing)) refuseConfig(`timing must be one of: ${NATIVE_TIMING_MODES.join(", ")}`);

  const calendar = input.calendar ?? DEFAULT_CALENDAR_ALIGNMENT;
  if (
    !Number.isInteger(calendar.weekStartsOnUtcDay) ||
    calendar.weekStartsOnUtcDay < 0 ||
    calendar.weekStartsOnUtcDay > 6
  ) {
    refuseConfig("calendar.weekStartsOnUtcDay must be an integer 0..6");
  }
  if (
    !Number.isInteger(calendar.multiMonthAnchorMonth) ||
    calendar.multiMonthAnchorMonth < 0 ||
    calendar.multiMonthAnchorMonth > 11
  ) {
    refuseConfig("calendar.multiMonthAnchorMonth must be an integer 0..11");
  }

  return Object.freeze({
    minMovePct: input.minMovePct,
    touchTolerancePct,
    touchCooldownBars,
    minBarsAfterCreation,
    minBarsAfterArming,
    maxLevels,
    enabledSourceTfs,
    retestEnabled,
    timing,
    calendar: Object.freeze({
      weekStartsOnUtcDay: calendar.weekStartsOnUtcDay,
      multiMonthAnchorMonth: calendar.multiMonthAnchorMonth,
    }),
  });
}
