import { z } from "zod";

/**
 * Structural validation of the raw TradingView payload. Deliberately loose
 * on `assetType`/`signal` casing/values here — enum normalization and
 * validation happens in webhook.service.ts so structural errors (422) and
 * semantic/enum errors are reported distinctly.
 */
export const tradingViewWebhookSchema = z.object({
  secret: z.string().min(1, "secret is required"),
  symbol: z.string().min(1, "symbol is required"),
  assetType: z.string().min(1, "assetType is required"),
  timeframe: z.string().min(1, "timeframe is required"),
  price: z.number({ invalid_type_error: "price must be a number" }).positive("price must be positive"),
  signal: z.string().min(1, "signal is required"),
  indicatorName: z.string().optional(),
  indicatorValue: z.number().optional(),
  triggeredAt: z.string().min(1, "triggeredAt is required"),
  exchange: z.string().optional(),
  note: z.string().optional(),
  // Phase 11B.0. Present ONLY on a deliberately created canary alert. It is not
  // a Binance credential, but it authorizes a real-money trade, so it is never
  // logged, never returned by an API and never persisted in this raw form.
  canaryAuthorization: z.string().optional(),
});

export type TradingViewWebhookInput = z.infer<typeof tradingViewWebhookSchema>;
