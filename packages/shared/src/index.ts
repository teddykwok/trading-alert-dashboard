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

export type { RiskTemplate, RiskTemplateAmounts } from "./risk-template";
export { calculateRiskTemplateAmounts } from "./risk-template";
