/**
 * Shape of the raw JSON payload TradingView sends to POST /api/webhooks/tradingview.
 * Kept intentionally loose on signal/assetType casing since TradingView alert
 * templates are free-text; the backend normalizes them to the strict enums.
 */
export interface TradingViewWebhookPayload {
  secret: string;
  symbol: string;
  assetType: string;
  timeframe: string;
  price: number;
  signal: string;
  indicatorName?: string;
  indicatorValue?: number;
  triggeredAt: string;
  exchange?: string;
  note?: string;
}

export interface WebhookAcceptedResponse {
  id: string;
  status: string;
}
