// Teddy native signal engine — Slice 1 (pure). See types.ts for the semantics.
// Explicit named exports, matching the package root's convention.

export type {
  CalendarAlignment,
  NativeConditionFlags,
  NativeEngineConfig,
  NativeEngineConfigInput,
  NativeEngineState,
  NativeHistoricalInput,
  NativeHistoricalPeriod,
  NativeHistoricalProjection,
  NativeHistoricalReport,
  NativeHistoricalResult,
  NativeHistoricalTouch,
  NativeHtfAggregate,
  NativeHtfTrack,
  NativeCandidate,
  NativeCandidateBasis,
  NativeImmediateCandidate,
  NativeImmediateStepResult,
  NativeKline,
  NativeLevel,
  NativeLevelColor,
  NativeLevelCondition,
  NativePartialPeriodPolicy,
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
  NATIVE_HISTORICAL_STATE_SEMANTICS,
  NATIVE_LEVEL_CONDITIONS,
  NATIVE_SOURCE_TF_ORDER,
  NATIVE_TIMING_MODES,
  NativeSignalInputError,
  PINE_V55_INPUT_DEFAULTS,
  PINE_V5_FIRST_HISTORY_BAR_NO_EDGE,
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  createNativeEngineConfig,
  pinePercentInputToFraction,
} from "./types";

export { advanceHtfAggregate, barFitsHtfPeriod, htfPeriodStartMs, projectPineHistoricalHtf } from "./htf-aggregate";
export {
  createNativeEngineState,
  evaluateLevelConditions,
  reconstructImmediateCandidates,
  stepNativeEngine,
  stepNativeEngineWithImmediate,
} from "./engine";

export type { NativeImmediateReplayResult, NativeReplayResult } from "./replay";
export { reconstructPineHistoricalState, replayNativeEngine, replayNativeEngineWithImmediate } from "./replay";
