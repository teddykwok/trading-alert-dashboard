import { applyBarInPlace, cloneWorkingState, createNativeEngineState, type BarOutputs } from "./engine";
import type {
  NativeEngineConfig,
  NativeEngineState,
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
