import {
  applyBarInPlace,
  cloneWorkingState,
  createNativeEngineState,
  reconstructImmediateCandidates,
  type BarOutputs,
} from "./engine";
import type {
  NativeEngineConfig,
  NativeEngineState,
  NativeImmediateCandidate,
  NativeKline,
  NativeLevel,
  NativeRetestCandidate,
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
