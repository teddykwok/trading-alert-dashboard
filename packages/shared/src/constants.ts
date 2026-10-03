export const SOCKET_EVENTS = {
  NEW_ALERT: "new_alert",
  ALERT_UPDATED: "alert_updated",
  ALERT_FAILED: "alert_failed",
  ALERT_DUPLICATE: "alert_duplicate",
} as const;

export const ASSET_TYPES = ["CRYPTO", "STOCK"] as const;

export const SIGNAL_TYPES = ["LONG", "SHORT", "WATCH", "EXIT"] as const;

/**
 * The two independent alert sources: an actual TradingView webhook delivery,
 * and Native scanner evidence (dashboard-only, never executed).
 */
export const ALERT_SOURCES = ["TRADINGVIEW", "NATIVE"] as const;

export const ALERT_STATUSES = [
  "RECEIVED",
  "PROCESSING_SCREENSHOT",
  "ANALYZING_WITH_AI",
  "ANALYZED",
  "FAILED",
  "IGNORED_DUPLICATE",
] as const;

export const VISION_ANALYSIS_QUEUE_NAME = "vision-analysis";

export const TRADE_REVIEW_STATUSES = [
  "UNREVIEWED",
  "IGNORED",
  "OPEN",
  "WIN",
  "LOSS",
  "BREAKEVEN",
] as const;
