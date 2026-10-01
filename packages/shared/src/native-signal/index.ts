// Teddy native signal engine — Slice 1 (pure). See types.ts for the semantics.
// Explicit named exports, matching the package root's convention.

export type {
  CalendarAlignment,
  NativeConditionFlags,
  NativeEngineConfig,
  NativeEngineConfigInput,
  NativeEngineState,
  NativeHtfAggregate,
  NativeHtfTrack,
  NativeKline,
  NativeLevel,
  NativeLevelColor,
  NativeLevelCondition,
  NativeRetestCandidate,
  NativeSignal,
  NativeSignalInputErrorCode,
  NativeSourceTf,
  NativeStepResult,
  NativeTimingMode,
  NativeTouchDirection,
} from "./types";
export {
  DEFAULT_CALENDAR_ALIGNMENT,
  NATIVE_LEVEL_CONDITIONS,
  NATIVE_SOURCE_TF_ORDER,
  NATIVE_TIMING_MODES,
  NativeSignalInputError,
  PINE_V55_INPUT_DEFAULTS,
  createNativeEngineConfig,
  pinePercentInputToFraction,
} from "./types";

export { advanceHtfAggregate, barFitsHtfPeriod, htfPeriodStartMs } from "./htf-aggregate";
export { createNativeEngineState, evaluateLevelConditions, stepNativeEngine } from "./engine";

export type { NativeReplayResult } from "./replay";
export { replayNativeEngine } from "./replay";
