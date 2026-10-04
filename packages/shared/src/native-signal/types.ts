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

/**
 * HOW SOURCE LEVELS LIVE. Two versioned lifecycles, selected per engine config:
 *
 *  PINE_V55_EDGE_FROZEN (the legacy default; the config carries NO `lifecycle`
 *  key, so every legacy config and fingerprint is byte-identical to before):
 *    every FALSE->TRUE qualification edge pushes a level frozen at the running
 *    extreme of that moment; timers count `bars since >= N`.
 *
 *  TEDDY_DYNAMIC_SOURCE_LEVEL_V1 (the Teddy product rule):
 *    one FORMING candidate per (source TF, source period, colour). It is active
 *    while that colour qualifies (GREEN = GOR or GOG, RED = ROR or ROG), its
 *    price follows the period's running high (GREEN) / low (RED), it keeps its
 *    first-qualification anchor through any off/on flicker, and it is never
 *    armed, retested or alerted. When the source candle closes, a candidate that
 *    still qualifies becomes exactly ONE persistent level at the final extreme;
 *    one that does not is discarded. Only persistent levels arm and retest, and
 *    timers require N FULL chart bars after the anchor (`bars since > N`).
 */
export const NATIVE_LIFECYCLE_PINE_V55_EDGE = "PINE_V55_EDGE_FROZEN" as const;
export const NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1 = "TEDDY_DYNAMIC_SOURCE_LEVEL_V1" as const;
export type NativeLevelLifecycle = typeof NATIVE_LIFECYCLE_PINE_V55_EDGE | typeof NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1;
export const NATIVE_LEVEL_LIFECYCLES: readonly NativeLevelLifecycle[] = Object.freeze([NATIVE_LIFECYCLE_PINE_V55_EDGE, NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1] as const);

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
  /**
   * Present ONLY for the dynamic lifecycle. Absent means PINE_V55_EDGE_FROZEN,
   * so a legacy config (and everything hashed from it) is unchanged.
   */
  readonly lifecycle?: typeof NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1;
}

/** The lifecycle a canonical config selects. */
export function nativeLevelLifecycleOf(config: Pick<NativeEngineConfig, "lifecycle">): NativeLevelLifecycle {
  return config.lifecycle === NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1 ? NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1 : NATIVE_LIFECYCLE_PINE_V55_EDGE;
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
  Partial<Omit<NativeEngineConfig, "minMovePct" | "lifecycle">> & { readonly lifecycle?: NativeLevelLifecycle };

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

/**
 * TEDDY_DYNAMIC_SOURCE_LEVEL_V1: the one forming candidate of a colour in the
 * current source period. Engine state only — never persisted as a row, never
 * armed, never retested, never alerted.
 */
export interface NativeFormingCandidate {
  readonly color: NativeLevelColor;
  readonly periodStartMs: number;
  /** The creation anchor: the chart bar whose close FIRST qualified this colour. Never reset by flicker. */
  readonly firstQualifiedBarIndex: number;
  readonly firstQualifiedBarOpenTimeMs: number;
  /** Does the colour qualify at the latest close? Inactive candidates are not tradable. */
  readonly active: boolean;
  /** The period's running high (GREEN) or low (RED) at the latest close. */
  readonly price: number;
  /** The condition qualifying at the latest active close (GOR/GOG or ROR/ROG). */
  readonly condition: NativeLevelCondition;
}

export interface NativeFormingCandidates {
  readonly GREEN: NativeFormingCandidate | null;
  readonly RED: NativeFormingCandidate | null;
}

export interface NativeHtfTrack {
  readonly aggregate: NativeHtfAggregate | null;
  /**
   * The flags projected onto the PREVIOUS chart bar — Pine's `tf_sX[1]`. Null
   * means unknown (no previous bar, or an incomplete period), and an unknown
   * previous value never enables an edge.
   */
  readonly previousFlags: NativeConditionFlags | null;
  /** Dynamic lifecycle only (absent for the legacy one): this period's forming candidates. */
  readonly candidates?: NativeFormingCandidates;
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

/**
 * Slice 1b — an IMMEDIATE INTRABAR candidate.
 *
 * Three different things must never be confused:
 *
 *   1. COMMITTED candidate (`NativeRetestCandidate`): the closing-tick 4B
 *      evaluation fired and `lvlLastTouchBar` was written.
 *   2. IMMEDIATE INTRABAR candidate (this type): reconstructed from the state
 *      committed at the END of the previous bar plus this bar's final OHLC. It
 *      says Pine's Immediate `alert()` COULD have fired during the bar — every
 *      4B condition held from the pre-bar state, and the bar's range entered
 *      the band.
 *   3. A DELIVERED TradingView alert: a fact about the platform. Nothing in
 *      this engine observes delivery, so nothing here claims it.
 *
 * Why the pre-bar state: on realtime ticks Pine runs 4B against `var` state
 * rolled back to the previous close, and 4A (ARM/DISARM) only runs on the
 * confirmed tick. So until the close, arming, armedBar, createdBar and
 * lastTouch are exactly the previous bar's committed values, `close[1]` is the
 * previous close, and only the bar's high/low move — and they only widen.
 *
 * An immediate candidate NEVER commits a cooldown: Pine rolls back the
 * intrabar `lvlLastTouchBar` write, and only the closing evaluation (the
 * committed candidate, if any) leaves one behind.
 */
export interface NativeImmediateCandidate {
  readonly basis: "IMMEDIATE_INTRABAR";
  readonly signal: NativeSignal;
  readonly touchDirection: NativeTouchDirection;
  readonly levelColor: NativeLevelColor;
  readonly sourceTf: NativeSourceTf;
  readonly levelPrice: number;
  readonly chartBarIndex: number;
  readonly chartBarOpenTimeMs: number;
  readonly chartBarCloseTimeMs: number;
  readonly level: NativeRetestCandidate["level"];
  /**
   * What closed OHLC alone can and cannot prove. A candidate is "could have
   * fired"; these flags say whether that is established or merely possible.
   */
  readonly proof: {
    /**
     * True when the bar's OHLC proves the band was entered on an update
     * BEFORE the closing one: the low reached the band either at the open or
     * strictly before the close (low < close), and likewise for the high.
     *
     * False means the band may only have been reached by the closing update
     * itself — and on that update Pine runs 4A first, so the only alert it
     * could send is the committed one. Assumes the bar's opening update is not
     * also its closing update.
     */
    readonly bandEnteredBeforeClosingUpdate: boolean;
    /**
     * True when this level is provably in the registry on EVERY intrabar
     * update. A transient intrabar registration (rolled back afterwards) pushes
     * a level and, past MAX_LEVELS, shifts the oldest out for that update; with
     * the registry near capacity the oldest pre-bar levels may be absent at the
     * very update that touched the band. False = not provable from OHLC.
     */
    readonly levelPresentOnEveryUpdate: boolean;
  };
}

/** Either kind of candidate; `basis` always says which. */
export type NativeCandidate = NativeRetestCandidate | NativeImmediateCandidate;
export type NativeCandidateBasis = NativeCandidate["basis"];

export interface NativeStepResult {
  readonly state: NativeEngineState;
  /** Levels registered on this bar, as they were at registration. */
  readonly registered: readonly NativeLevel[];
  /** Levels dropped by MAX_LEVELS on this bar. */
  readonly evicted: readonly NativeLevel[];
  readonly candidates: readonly NativeRetestCandidate[];
}

/**
 * A step that reports BOTH candidate kinds, in separate fields. `candidates`
 * is exactly what `stepNativeEngine` returns; the immediate ones never
 * influence it.
 */
export interface NativeImmediateStepResult extends NativeStepResult {
  readonly immediateCandidates: readonly NativeImmediateCandidate[];
}

/**
 * One registered level as the NEXT bar's 4B retest would judge it, from the
 * committed state alone. A read-only DIAGNOSTIC: it is not a candidate, never
 * actionable, and nothing in the engine reads it back.
 *
 * Every gate is Pine's 4B condition evaluated exactly as the engine evaluates
 * it, against `nextBarIndex` and the committed `close[1]`. Only `inBand` is
 * missing, because it depends on the next bar's range.
 */
export interface NativeLevelDiagnostic {
  /** 0-based position in the registry, oldest first (the retest loop order). */
  readonly position: number;
  readonly id: number;
  readonly sourceTf: NativeSourceTf;
  readonly color: NativeLevelColor;
  readonly condition: NativeLevelCondition;
  readonly price: number;
  readonly htfPeriodStartMs: number;
  readonly createdBarIndex: number;
  readonly createdBarOpenTimeMs: number;
  readonly armed: boolean;
  readonly armedBarIndex: number;
  readonly lastTouchBarIndex: number;
  /** level * (1 + tolerance) and level * (1 - tolerance), written as the engine writes them. */
  readonly upperBand: number;
  readonly lowerBand: number;
  /** GREEN retests as LONG (touch from above); RED as SHORT (touch from below). */
  readonly retestSignal: NativeSignal;
  readonly gates: {
    /** armed && armedBar >= 0 && nextBar - armedBar >= minBarsAfterArming */
    readonly armedReady: boolean;
    /** nextBar - createdBar >= minBarsAfterCreation */
    readonly oldEnough: boolean;
    /** lastTouch < 0 || nextBar - lastTouch >= touchCooldownBars */
    readonly cooledDown: boolean;
    /** GREEN: close[1] > upperBand. RED: close[1] < lowerBand. False when close[1] is na. */
    readonly approachSide: boolean;
  };
  /** May be pushed out of the registry intrabar by transient registrations (see Slice 1b proof). */
  readonly intrabarEvictionRisk: boolean;
}

export interface NativeEngineDiagnosticSnapshot {
  /** The bar index the NEXT bar will have: the committed state's barIndex. */
  readonly nextBarIndex: number;
  /** The committed `close[1]` for the next bar; null before the first bar. */
  readonly previousClose: number | null;
  readonly lastBarOpenTimeMs: number | null;
  /** False when Pine's 4B loop does not run at all (retest disabled). */
  readonly retestEnabled: boolean;
  readonly timing: NativeTimingMode;
  readonly levels: readonly NativeLevelDiagnostic[];
}

export type NativeSignalInputErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_KLINE"
  | "INCONSISTENT_INTERVAL"
  | "NON_CONTIGUOUS_BARS"
  | "BAR_STRADDLES_HTF_PERIOD"
  | "INVALID_HISTORY_RANGE";

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

  const lifecycle = input.lifecycle ?? NATIVE_LIFECYCLE_PINE_V55_EDGE;
  if (!NATIVE_LEVEL_LIFECYCLES.includes(lifecycle)) refuseConfig(`lifecycle must be one of: ${NATIVE_LEVEL_LIFECYCLES.join(", ")}`);

  return Object.freeze({
    ...(lifecycle === NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1 ? { lifecycle: NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1 } : {}),
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

// ===========================================================================
// Slice 2B-1 — Pine-compatible HISTORICAL state reconstruction
// ===========================================================================
//
// TradingView computes a script's history once, with `request.security(...,
// lookahead=barmerge.lookahead_on)` (Pine lines 211-212). On a historical bar
// that call returns the HTF period's FINAL values, so every historical chart
// bar of a period sees the same candle. Reconstructing the state TradingView
// holds therefore needs that projection for history, and the causal engine
// after a fixed switchover. Nothing here is causal before the switchover, by
// design; nothing here ever reads a bar at or after it.

/** Bumped whenever historical reconstruction semantics change. */
export const NATIVE_HISTORICAL_STATE_SEMANTICS = "pine-v5.5/historical-lookahead-on/v1";

/**
 * TEDDY_DYNAMIC_SOURCE_LEVEL_V1 history: NO look-ahead. The chart history is
 * replayed forward bar by bar through the very same engine step the live
 * scanner uses; context bars only establish each source candle's real open.
 * No HTF extreme can appear before it was printed, and nothing is truncated at
 * the switchover — the switchover is only where live evidence begins.
 */
export const NATIVE_DYNAMIC_HISTORICAL_STATE_SEMANTICS = "teddy-dynamic-source-level/causal-history/v1";
export type NativeHistoricalStateSemantics = typeof NATIVE_HISTORICAL_STATE_SEMANTICS | typeof NATIVE_DYNAMIC_HISTORICAL_STATE_SEMANTICS;

/** The historical semantics a config's lifecycle implies. */
export function historicalStateSemanticsOf(config: Pick<NativeEngineConfig, "lifecycle">): NativeHistoricalStateSemantics {
  return nativeLevelLifecycleOf(config) === NATIVE_LIFECYCLE_TEDDY_DYNAMIC_V1 ? NATIVE_DYNAMIC_HISTORICAL_STATE_SEMANTICS : NATIVE_HISTORICAL_STATE_SEMANTICS;
}

/**
 * Pine v5 at the first chart-history bar: `tf_s[1]` is na, na is false as a
 * condition and propagates through `and`/`not`, so `tf_s and not tf_s[1]`
 * creates NO edge there. Fixed semantics, not an option.
 */
export const PINE_V5_FIRST_HISTORY_BAR_NO_EDGE = "PINE_V5_FIRST_HISTORY_BAR_NO_EDGE";

/**
 * The only approved treatment of an HTF period that contains the switchover:
 * its historical bars see the candle of its CLOSED chart bars before the
 * switchover, never anything later.
 */
export const SWITCHOVER_TRUNCATED_CLOSED_BARS = "SWITCHOVER_TRUNCATED_CLOSED_BARS";
export type NativePartialPeriodPolicy = typeof SWITCHOVER_TRUNCATED_CLOSED_BARS;

/** One HTF period as Pine's historical bars see it. */
export interface NativeHistoricalPeriod {
  readonly sourceTf: NativeSourceTf;
  readonly periodStartMs: number;
  /**
   * The projected candle: the period's FINAL candle, or — when the period
   * contains the switchover — the candle of its closed bars before it.
   * `complete` false means the period's real open is unknown.
   */
  readonly candle: NativeHtfAggregate;
  readonly truncatedAtSwitchover: boolean;
  readonly firstChartBarIndex: number;
  readonly lastChartBarIndex: number;
}

export interface NativeHistoricalProjection {
  readonly switchoverMs: number;
  /** Per enabled timeframe, the periods that contain chart bars, in order. */
  readonly periods: Readonly<Partial<Record<NativeSourceTf, readonly NativeHistoricalPeriod[]>>>;
  /** Per enabled timeframe, for each chart bar, the index of its period in `periods`. */
  readonly barPeriodIndex: Readonly<Partial<Record<NativeSourceTf, readonly number[]>>>;
}

export interface NativeHistoricalInput {
  readonly config: NativeEngineConfig;
  /** Open time of the first chart-history bar (Pine's bar_index 0). */
  readonly historyStartMs: number;
  /**
   * Open time of the first bar that belongs to the causal engine. Bars with
   * open < switchoverMs are reconstructed here; none at or after it is read.
   */
  readonly switchoverMs: number;
  /**
   * Bars immediately before historyStart, used ONLY to know the real open and
   * range of HTF periods that began before the chart history. They get no bar
   * index, arm nothing, retest nothing and register nothing.
   */
  readonly contextBars: readonly NativeKline[];
  /** Chart bars from historyStart. May run past the switchover; those are never read. */
  readonly bars: readonly NativeKline[];
  readonly partialPeriodPolicy: NativePartialPeriodPolicy;
}

/**
 * A level that qualified for a retest on a HISTORICAL bar. Pine wrote its
 * cooldown (`lvlLastTouchBar`); TradingView delivered nothing. This is a
 * diagnostic of that state write — never a candidate, never actionable.
 */
export interface NativeHistoricalTouch {
  readonly actionable: false;
  readonly basis: "HISTORICAL_STATE_WRITE";
  readonly signal: NativeSignal;
  readonly touchDirection: NativeTouchDirection;
  readonly levelColor: NativeLevelColor;
  readonly sourceTf: NativeSourceTf;
  readonly levelPrice: number;
  readonly chartBarIndex: number;
  readonly chartBarOpenTimeMs: number;
  readonly chartBarCloseTimeMs: number;
  readonly level: {
    readonly id: number;
    readonly condition: NativeLevelCondition;
    readonly htfPeriodStartMs: number;
    readonly createdBarIndex: number;
    readonly createdBarOpenTimeMs: number;
  };
}

export interface NativeHistoricalReport {
  readonly semantics: NativeHistoricalStateSemantics;
  readonly firstHistoryBar: typeof PINE_V5_FIRST_HISTORY_BAR_NO_EDGE;
  readonly partialPeriodPolicy: NativePartialPeriodPolicy;
  readonly historyStartMs: number;
  readonly switchoverMs: number;
  /** Open time of the first context bar, or null without context. */
  readonly contextStartMs: number | null;
  readonly contextBarCount: number;
  readonly chartBarCount: number;
  /** Every level registered during reconstruction, in registration order. */
  readonly registrations: readonly NativeLevel[];
  /** Every level dropped by MAX_LEVELS during reconstruction, in order. */
  readonly evictions: readonly NativeLevel[];
  /** Every historical retest state write, in bar order, oldest level first. */
  readonly touches: readonly NativeHistoricalTouch[];
  /** Conditions true on the first history bar, where Pine creates no edge. */
  readonly firstHistoryBarFlags: readonly { readonly sourceTf: NativeSourceTf; readonly condition: NativeLevelCondition }[];
  /** True conditions that could not edge because the previous projected flag was unknown. */
  readonly unknownPreviousFlagEdges: readonly {
    readonly sourceTf: NativeSourceTf;
    readonly condition: NativeLevelCondition;
    readonly chartBarIndex: number;
  }[];
  /** Periods seen by chart bars whose real open is unknown (no or too little context). */
  readonly incompletePeriods: readonly { readonly sourceTf: NativeSourceTf; readonly periodStartMs: number }[];
  /** Per enabled timeframe, the period of the last historical bar — the one handed to the causal engine. */
  readonly handoffPeriods: readonly NativeHistoricalPeriod[];
}

export interface NativeHistoricalResult {
  /** The committed state at the switchover, ready for the causal engine's first bar. */
  readonly state: NativeEngineState;
  readonly report: NativeHistoricalReport;
}
