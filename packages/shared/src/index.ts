// Explicit named re-exports (rather than `export *`) so bundlers that
// statically analyze the compiled CommonJS output (e.g. Vite/Rollup) can
// correctly detect named exports — `export *` compiles to a dynamic
// for-in loop that static analysis can't always see through.
export type {
  AssetType,
  SignalType,
  AlertStatus,
  AiRiskNote,
  AiVisionResult,
  Alert,
  Asset,
} from "./alert-types";

export type { AlertStats } from "./alert-stats-types";

export type { TradingViewWebhookPayload, WebhookAcceptedResponse } from "./webhook-types";

export type {
  AlertContext,
  AlertEventType,
  LevelColor,
  ParsedAlertNote,
  SourceTimeframe,
  TouchDirection,
} from "./alert-context";
export {
  ALERT_EVENT_TYPES,
  LEVEL_COLORS,
  SOURCE_TIMEFRAMES,
  TOUCH_DIRECTIONS,
  HIGHER_SOURCE_TIMEFRAMES,
  parseAlertNote,
  hasLevelMetadata,
  isHigherSourceTimeframe,
  normalizeSourceTimeframe,
} from "./alert-context";

export {
  SOCKET_EVENTS,
  ASSET_TYPES,
  SIGNAL_TYPES,
  ALERT_STATUSES,
  VISION_ANALYSIS_QUEUE_NAME,
  TRADE_REVIEW_STATUSES,
} from "./constants";

export type {
  TradeReview,
  TradeReviewStats,
  TradeReviewStatus,
  TradeReviewWithPlan,
} from "./trade-review-types";

export type {
  FuturesRiskPlan,
  FuturesRiskPlanInput,
  PlanDirection,
  TradeMarginMode,
} from "./futures-risk";
export {
  calculateFuturesRiskPlan,
  TRADE_MARGIN_MODES,
  HIGH_LEVERAGE_WARNING_THRESHOLD,
  NON_DIRECTIONAL_PLAN_MESSAGE,
  ISOLATED_MARGIN_WARNING,
  LIQUIDATION_BEFORE_STOP_WARNING,
  LIQUIDATION_BEFORE_STOP_WARNING_SHORT,
  CROSS_MARGIN_WARNING,
  HIGH_LEVERAGE_WARNING,
} from "./futures-risk";

export type {
  TradeChecklist,
  TradeChecklistKey,
  TradeChecklistSummary,
  TradeDisciplineStats,
  TradeEmotion,
  TradeJournal,
  TradeJournalWithSummary,
} from "./trade-journal";
export {
  TRADE_CHECKLIST_ITEMS,
  TRADE_CONFIDENCE_MAX,
  TRADE_CONFIDENCE_MIN,
  TRADE_EMOTIONS,
  TRADE_EMOTION_LABELS,
  TRADE_JOURNAL_TEXT_LIMITS,
  summarizeChecklist,
} from "./trade-journal";

export type { ChartPriceFormat } from "./format-price";
export { formatDynamicPrice, priceDecimalsFor, pricePrecisionFor } from "./format-price";

export { SYMBOL_INPUT_MAX_LENGTH, getSymbolInputError } from "./symbol-validation";

export type {
  DynamicLeveragePlan,
  DynamicLeveragePlanInput,
  LeverageCandidateSummary,
  LiquidationEstimate,
  LiquidationEstimateInput,
  MarginPlanLeverageBracket,
  MarginPlanReason,
  MarginPlanStatus,
  MarginPlanSymbolFilters,
  MarginSelectionMode,
  ResolvedBracketSummary,
  StopLossSource,
} from "./binance-margin-engine";
export {
  MARGIN_ENGINE_DEFAULTS,
  MARGIN_PLAN_REASONS,
  MARGIN_PLAN_STATUSES,
  MARGIN_SELECTION_MODES,
  STOP_LOSS_SOURCES,
  STOP_PRICE_NORMALIZED_TO_TICK,
  SUPPORTED_CONTRACT_TYPES,
  calculateDynamicLeveragePlan,
  estimateIsolatedLiquidationPrice,
} from "./binance-margin-engine";

export type { RiskTemplate, RiskTemplateAmounts } from "./risk-template";
export { calculateRiskTemplateAmounts } from "./risk-template";

export type {
  ExtremeCandidateGeometry,
  ExtremeCandidateInput,
  ExtremeLeverageAnalysis,
  ExtremeLeverageOption,
  ExtremeMoney,
  ExtremeMoneyInput,
  ExtremeRRCandidate,
  ExtremeRRLeverage,
  ExtremeRRLookback,
  ExtremeRRPlanDto,
  SelectedPlanAccountOutcomeDto,
  SelectedPlanOutcomeDto,
  ExtremeRRPlanStatus,
  ExtremeRRTemplateSnapshot,
  ExtremeType,
} from "./extreme-rr";
export {
  EXTREME_RR_DEFAULT_LOOKBACK,
  EXTREME_RR_LEVERAGE_PRESETS,
  EXTREME_RR_LEVERAGE_UNVERIFIED_NOTE,
  EXTREME_RR_LOOKBACKS,
  isExtremeRRLookback,
  EXTREME_RR_MARGIN_DISCLAIMER,
  EXTREME_RR_PREFERRED_MARGIN_MAX,
  EXTREME_RR_PREFERRED_MARGIN_MIN,
  EXTREME_RR_QUEUE_NAME,
  EXTREME_RR_STATUSES,
  EXTREME_RR_UNROUNDED_NOTE,
  buildLeverageAnalysis,
  calculateExtremeCandidate,
  calculateExtremeMoney,
  extremeOfDecimalStrings,
} from "./extreme-rr";

export { subtractDecimalStrings, isNegativeDecimalString } from "./decimal-compare";

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
  NativeReplayResult,
  NativeRetestCandidate,
  NativeSignal,
  NativeSignalInputErrorCode,
  NativeSourceTf,
  NativeStepResult,
  NativeTimingMode,
  NativeTouchDirection,
} from "./native-signal/index";
export {
  DEFAULT_CALENDAR_ALIGNMENT,
  NATIVE_LEVEL_CONDITIONS,
  NATIVE_SOURCE_TF_ORDER,
  NATIVE_TIMING_MODES,
  NativeSignalInputError,
  PINE_V55_INPUT_DEFAULTS,
  advanceHtfAggregate,
  barFitsHtfPeriod,
  createNativeEngineConfig,
  createNativeEngineState,
  evaluateLevelConditions,
  htfPeriodStartMs,
  pinePercentInputToFraction,
  replayNativeEngine,
  stepNativeEngine,
} from "./native-signal/index";
