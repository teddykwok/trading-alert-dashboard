import type { FastifyInstance } from "fastify";

const SAMPLE_PAYLOAD = {
  secret: "your-webhook-secret",
  symbol: "BTCUSDT",
  assetType: "crypto",
  timeframe: "1h",
  price: 64250.5,
  signal: "LONG",
  indicatorName: "My Custom Indicator",
  indicatorValue: 87.2,
  triggeredAt: "2026-07-02T10:30:00Z",
  exchange: "BINANCE",
  note: "Bullish reversal zone detected",
};

/**
 * Informational endpoint backing the frontend SettingsPage: the webhook URL
 * to paste into a TradingView alert, a sample payload, and a reminder that
 * the WEBHOOK_SECRET must match the backend's .env value. No secret value is
 * ever returned here.
 */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/webhook-info", async (request) => {
    const webhookPath = "/api/webhooks/tradingview";
    return {
      webhookUrl: `${request.protocol}://${request.hostname}${webhookPath}`,
      webhookPath,
      samplePayload: SAMPLE_PAYLOAD,
      reminder:
        "Set WEBHOOK_SECRET in apps/backend/.env and use the same value as the \"secret\" field in your TradingView alert message.",
    };
  });
}
