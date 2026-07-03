export const SOCKET_EVENTS = {
  NEW_ALERT: "new_alert",
  ALERT_UPDATED: "alert_updated",
  ALERT_FAILED: "alert_failed",
  ALERT_DUPLICATE: "alert_duplicate",
} as const;

export const ASSET_TYPES = ["CRYPTO", "STOCK"] as const;

export const SIGNAL_TYPES = ["LONG", "SHORT", "WATCH", "EXIT"] as const;

export const ALERT_STATUSES = [
  "RECEIVED",
  "PROCESSING_SCREENSHOT",
  "ANALYZING_WITH_AI",
  "ANALYZED",
  "FAILED",
  "IGNORED_DUPLICATE",
] as const;

export const VISION_ANALYSIS_QUEUE_NAME = "vision-analysis";
