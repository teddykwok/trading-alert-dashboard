import {
  SIGNAL_QUALITY_HORIZONS,
  SIGNAL_QUALITY_PLAN_WINDOW_MINUTES,
  type SignalQualityHorizonKey,
  type SignalQualityHorizonState,
  type SignalQualityPlanOutcome,
} from "@trading-alert-dashboard/shared";

/**
 * NATIVE SIGNAL QUALITY: what happened to price after ONE Native alert, and
 * how its EXISTING selected plan would have resolved. Pure: no clock, no
 * network, no database. The caller supplies the market data already read and
 * the evaluation instant; the same inputs always give the same output.
 *
 * Time, explicitly:
 *  - The outcome starts at the FIRST FULL MINUTE at or after triggeredAt
 *    (S = triggeredAt rounded UP to the minute; equal to it when aligned). The
 *    minute containing the trigger also holds prices from BEFORE it, so it is
 *    never part of any excursion or return. Up to 59.999 s after the trigger
 *    are therefore unobserved: a documented precision limit of 1-minute data.
 *  - A minute counts only once CLOSED by `evaluationEndMs` (open + 60 s <=
 *    evaluationEndMs). Nothing after the evaluation instant is ever used.
 *  - A horizon of H minutes is [S, S + H). MATURED needs every one of its
 *    minutes; anything less is PENDING, PARTIAL or DATA_GAP, never a zero.
 *
 * Plan resolution walks the closed minutes from S, inside a 24-hour window.
 * The first minute touching TP or SL decides; a minute touching both is
 * AMBIGUOUS_SAME_BAR (never guessed). Because the trigger minute holds prices
 * from both sides of the trigger, a trigger minute that already touched TP or
 * SL makes the order unknowable too. A missing minute before any resolution is
 * a DATA_GAP. Entry is taken as the alert itself (the level touch); fills,
 * fees and slippage are not modelled.
 */

export const MINUTE_MS = 60_000;

/** One closed 1-minute bar. Prices are the exchange's, as numbers. */
export interface MinuteBar {
  readonly openTimeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/** The bar that opened at `openTimeMs`, or undefined when none is known. */
export type MinuteBarLookup = (openTimeMs: number) => MinuteBar | undefined;

export type OutcomeMarketData =
  | { readonly status: "LOADED"; readonly bars: MinuteBarLookup }
  | { readonly status: "NOT_LOADED" | "UNAVAILABLE"; readonly reason: string };

export interface OutcomeSignal {
  readonly direction: "LONG" | "SHORT";
  readonly triggeredAtMs: number;
  /** The canonical reference price (the Native level price), or null when none exists. Never a current price. */
  readonly referencePrice: number | null;
}

/** The existing selected plan's prices, or why there is none. */
export type OutcomePlan =
  | { readonly available: true; readonly entry: number; readonly stopLoss: number; readonly takeProfit: number }
  | { readonly available: false; readonly reason: string };

export interface HorizonOutcome {
  readonly key: SignalQualityHorizonKey;
  readonly state: SignalQualityHorizonState;
  readonly expectedMinutes: number;
  readonly observedMinutes: number;
  readonly missingMinutes: number;
  readonly mfePct: number | null;
  readonly maePct: number | null;
  readonly returnPct: number | null;
  readonly reason: string | null;
}

export interface PlanOutcome {
  readonly outcome: SignalQualityPlanOutcome;
  readonly rMultiple: number | null;
  readonly resolvedAtMs: number | null;
  readonly reason: string | null;
  /** The plan geometry's own reward:risk (|TP − entry| / |entry − SL|), when the geometry is valid. */
  readonly plannedRewardR: number | null;
}

export interface SignalOutcome {
  /** S: the first full minute at or after triggeredAt. */
  readonly outcomeStartMs: number;
  readonly horizons: readonly HorizonOutcome[];
  readonly plan: PlanOutcome;
  /** True when nothing about this outcome can change any more (24h matured and the plan final). */
  readonly final: boolean;
}

export interface SignalOutcomeInput {
  readonly signal: OutcomeSignal;
  readonly plan: OutcomePlan;
  readonly marketData: OutcomeMarketData;
  readonly evaluationEndMs: number;
}

export const ceilMinute = (ms: number) => Math.ceil(ms / MINUTE_MS) * MINUTE_MS;
export const floorMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
const finitePositive = (value: number) => Number.isFinite(value) && value > 0;

/**
 * A lookup over an array of bars. Misaligned or malformed bars are dropped, and
 * a minute that appears twice is treated as missing: anything doubtful can
 * only become a gap, never evidence.
 */
export function barLookupFromArray(bars: readonly MinuteBar[]): MinuteBarLookup {
  const byOpen = new Map<number, MinuteBar>();
  const duplicated = new Set<number>();
  for (const bar of bars) {
    if (!Number.isSafeInteger(bar.openTimeMs) || bar.openTimeMs % MINUTE_MS !== 0) continue;
    if (byOpen.has(bar.openTimeMs)) duplicated.add(bar.openTimeMs);
    byOpen.set(bar.openTimeMs, bar);
  }
  for (const t of duplicated) byOpen.delete(t);
  return (openTimeMs) => byOpen.get(openTimeMs);
}

/** The bar at `t` if it is usable: closed by the evaluation instant and well formed. */
function usable(lookup: MinuteBarLookup, t: number, evaluationEndMs: number): MinuteBar | undefined {
  if (t + MINUTE_MS > evaluationEndMs) return undefined;
  const bar = lookup(t);
  if (bar === undefined || bar.openTimeMs !== t) return undefined;
  if (![bar.open, bar.high, bar.low, bar.close].every(finitePositive) || bar.high < bar.low) return undefined;
  return bar;
}

/** Minutes of [S, S + cap) closed by the evaluation instant. */
function elapsedMinutes(outcomeStartMs: number, evaluationEndMs: number, cap: number): number {
  if (!Number.isFinite(evaluationEndMs) || evaluationEndMs <= outcomeStartMs) return 0;
  return Math.min(cap, Math.floor((evaluationEndMs - outcomeStartMs) / MINUTE_MS));
}

/** The plan's geometry, or why it cannot be judged. */
export function validatePlanGeometry(direction: "LONG" | "SHORT", plan: OutcomePlan): { ok: true; rewardR: number } | { ok: false; reason: string } {
  if (!plan.available) return { ok: false, reason: plan.reason };
  const { entry, stopLoss, takeProfit } = plan;
  if (![entry, stopLoss, takeProfit].every(finitePositive)) return { ok: false, reason: "the plan prices are not finite positive numbers" };
  const ordered = direction === "LONG" ? stopLoss < entry && entry < takeProfit : takeProfit < entry && entry < stopLoss;
  if (!ordered) return { ok: false, reason: `the plan geometry is not a ${direction} geometry (stop, entry and take-profit out of order)` };
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  if (!(risk > 0) || !(reward > 0)) return { ok: false, reason: "the plan has zero risk or zero reward" };
  const rewardR = reward / risk;
  if (!Number.isFinite(rewardR)) return { ok: false, reason: "the plan reward:risk is not finite" };
  return { ok: true, rewardR };
}

interface Running {
  observed: number;
  maxHigh: number;
  minLow: number;
  lastClose: number | null;
}

function horizonSnapshot(key: SignalQualityHorizonKey, minutes: number, considered: number, running: Running, signal: OutcomeSignal): HorizonOutcome {
  const base = { key, expectedMinutes: minutes, mfePct: null, maePct: null, returnPct: null };
  if (considered === 0) return { ...base, state: "PENDING", observedMinutes: 0, missingMinutes: 0, reason: "no minute of the horizon has closed yet" };
  const missing = considered - running.observed;
  const complete = considered === minutes;
  if (complete && missing > 0) {
    return { ...base, state: "DATA_GAP", observedMinutes: running.observed, missingMinutes: missing, reason: `${missing} of ${minutes} minutes are missing from the market data` };
  }
  const state: SignalQualityHorizonState = complete ? "MATURED" : "PARTIAL";
  const reason = complete ? null : `${considered} of ${minutes} minutes have closed${missing > 0 ? ` (${missing} missing)` : ""}`;
  const ref = signal.referencePrice;
  if (running.observed === 0 || running.lastClose === null) return { ...base, state, observedMinutes: 0, missingMinutes: missing, reason: reason ?? "no minute observed" };
  if (ref === null || !finitePositive(ref)) return { ...base, state, observedMinutes: running.observed, missingMinutes: missing, reason: "no canonical reference price" };
  const pct = (value: number) => (value / ref) * 100;
  const long = signal.direction === "LONG";
  return {
    key,
    state,
    expectedMinutes: minutes,
    observedMinutes: running.observed,
    missingMinutes: missing,
    mfePct: long ? pct(running.maxHigh - ref) : pct(ref - running.minLow),
    maePct: long ? pct(ref - running.minLow) : pct(running.maxHigh - ref),
    returnPct: long ? pct(running.lastClose - ref) : pct(ref - running.lastClose),
    reason,
  };
}

/** The full outcome of one alert at `evaluationEndMs`. Deterministic; one pass over at most 24h of minutes. */
export function evaluateSignalOutcome(input: SignalOutcomeInput): SignalOutcome {
  const { signal, plan, marketData, evaluationEndMs } = input;
  const S = ceilMinute(signal.triggeredAtMs);
  const elapsed = elapsedMinutes(S, evaluationEndMs, SIGNAL_QUALITY_PLAN_WINDOW_MINUTES);
  const long = signal.direction === "LONG";
  const geometry = validatePlanGeometry(signal.direction, plan);

  // --- No market data: nothing is observable beyond "not yet started". -----
  if (marketData.status !== "LOADED") {
    const horizons = SIGNAL_QUALITY_HORIZONS.map((h): HorizonOutcome => {
      const considered = Math.min(h.minutes, elapsed);
      return considered === 0
        ? horizonSnapshot(h.key, h.minutes, 0, { observed: 0, maxHigh: 0, minLow: 0, lastClose: null }, signal)
        : { key: h.key, state: "DATA_UNAVAILABLE", expectedMinutes: h.minutes, observedMinutes: 0, missingMinutes: 0, mfePct: null, maePct: null, returnPct: null, reason: marketData.reason };
    });
    const planOutcome: PlanOutcome = !geometry.ok
      ? { outcome: "PLAN_UNAVAILABLE", rMultiple: null, resolvedAtMs: null, reason: geometry.reason, plannedRewardR: null }
      : elapsed === 0
        ? { outcome: "PENDING", rMultiple: null, resolvedAtMs: null, reason: "no minute of the plan window has closed yet", plannedRewardR: geometry.rewardR }
        : { outcome: "DATA_UNAVAILABLE", rMultiple: null, resolvedAtMs: null, reason: marketData.reason, plannedRewardR: geometry.rewardR };
    return { outcomeStartMs: S, horizons, plan: planOutcome, final: false };
  }
  const lookup = marketData.bars;

  // --- Plan resolution state -------------------------------------------------
  let planOutcome: PlanOutcome | null = null;
  if (!geometry.ok || !plan.available) {
    planOutcome = { outcome: "PLAN_UNAVAILABLE", rMultiple: null, resolvedAtMs: null, reason: geometry.ok ? "no plan" : geometry.reason, plannedRewardR: null };
  }
  const rewardR = geometry.ok ? geometry.rewardR : null;
  const unresolved = (outcome: SignalQualityPlanOutcome, reason: string | null, resolvedAtMs: number | null = null): PlanOutcome => ({ outcome, rMultiple: null, resolvedAtMs, reason, plannedRewardR: rewardR });
  const touchesTp = (bar: MinuteBar) => plan.available && (long ? bar.high >= plan.takeProfit : bar.low <= plan.takeProfit);
  const touchesSl = (bar: MinuteBar) => plan.available && (long ? bar.low <= plan.stopLoss : bar.high >= plan.stopLoss);

  if (planOutcome === null && elapsed > 0) {
    // The trigger minute (when the trigger is not minute-aligned) mixes prices from before and after the trigger.
    const triggerMinute = floorMinute(signal.triggeredAtMs);
    if (triggerMinute !== S) {
      const bar = usable(lookup, triggerMinute, evaluationEndMs);
      if (bar === undefined) planOutcome = unresolved("DATA_GAP", "the minute containing the trigger is missing, so a touch right after the trigger cannot be excluded");
      else if (touchesTp(bar) || touchesSl(bar)) {
        planOutcome = unresolved("AMBIGUOUS_SAME_BAR", "the minute containing the trigger already touched TP or SL; whether that was before or after the trigger is unknowable", triggerMinute);
      }
    }
  }

  // --- One pass over the closed minutes -------------------------------------
  const running: Running = { observed: 0, maxHigh: Number.NEGATIVE_INFINITY, minLow: Number.POSITIVE_INFINITY, lastClose: null };
  const snapshots = new Map<SignalQualityHorizonKey, HorizonOutcome>();
  const considerFor = (minutes: number) => Math.min(minutes, elapsed);
  for (const h of SIGNAL_QUALITY_HORIZONS) if (considerFor(h.minutes) === 0) snapshots.set(h.key, horizonSnapshot(h.key, h.minutes, 0, running, signal));

  for (let m = 0; m < elapsed; m += 1) {
    const at = S + m * MINUTE_MS;
    const bar = usable(lookup, at, evaluationEndMs);
    if (bar !== undefined) {
      running.observed += 1;
      if (bar.high > running.maxHigh) running.maxHigh = bar.high;
      if (bar.low < running.minLow) running.minLow = bar.low;
      running.lastClose = bar.close;
    }
    if (planOutcome === null) {
      if (bar === undefined) planOutcome = unresolved("DATA_GAP", `minute ${new Date(at).toISOString()} is missing before any resolution`);
      else {
        const tp = touchesTp(bar);
        const sl = touchesSl(bar);
        if (tp && sl) planOutcome = unresolved("AMBIGUOUS_SAME_BAR", "one minute touched both TP and SL; the order inside it is unknowable at 1-minute precision", at);
        else if (tp) planOutcome = { outcome: "TP_FIRST", rMultiple: rewardR, resolvedAtMs: at, reason: null, plannedRewardR: rewardR };
        else if (sl) planOutcome = { outcome: "SL_FIRST", rMultiple: -1, resolvedAtMs: at, reason: null, plannedRewardR: rewardR };
      }
    }
    for (const h of SIGNAL_QUALITY_HORIZONS) {
      if (m + 1 === considerFor(h.minutes)) snapshots.set(h.key, horizonSnapshot(h.key, h.minutes, m + 1, running, signal));
    }
  }

  if (planOutcome === null) {
    planOutcome =
      elapsed >= SIGNAL_QUALITY_PLAN_WINDOW_MINUTES
        ? unresolved("NEITHER", "neither TP nor SL was touched in the 24-hour plan window")
        : elapsed === 0
          ? unresolved("PENDING", "no minute of the plan window has closed yet")
          : unresolved("PENDING", `${elapsed} of ${SIGNAL_QUALITY_PLAN_WINDOW_MINUTES} plan-window minutes have closed without a resolution`);
  }
  const horizons = SIGNAL_QUALITY_HORIZONS.map((h) => snapshots.get(h.key) as HorizonOutcome);
  const final = horizons.every((h) => h.state === "MATURED" || h.state === "DATA_GAP") && planOutcome.outcome !== "PENDING";
  return { outcomeStartMs: S, horizons, plan: planOutcome, final };
}

/** The minute range the outcome can use: the trigger minute through the end of the 24-hour window. */
export function outcomeBarRange(triggeredAtMs: number): { readonly fromMs: number; readonly toMs: number } {
  return { fromMs: floorMinute(triggeredAtMs), toMs: ceilMinute(triggeredAtMs) + SIGNAL_QUALITY_PLAN_WINDOW_MINUTES * MINUTE_MS };
}
