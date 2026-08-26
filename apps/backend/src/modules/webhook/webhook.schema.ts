import { z } from "zod";

import { parseIsoDateStrict } from "../../utils/date";

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
  /**
   * When the alert ACTUALLY fired — the moment the level was touched.
   *
   * Pine sends `timenow` for this, not `time`. The distinction is the whole
   * point: `time` is the SOURCE CANDLE's opening time, so a touch at 11:07 on
   * a 15m candle opened at 11:00 arrived already claiming to be seven minutes
   * old and was refused as ALERT_STALE despite being delivered instantly.
   * Freshness is judged from this field.
   */
  triggeredAt: z
    .string()
    .min(1, "triggeredAt is required")
    // Structural, alongside "required", because an unparseable event time is
    // no more usable than an absent one. Rejecting it here means the sender is
    // told 422 rather than the value being quietly replaced downstream.
    .refine((value) => parseIsoDateStrict(value) !== null, "triggeredAt must be an ISO-8601 timestamp"),
  /**
   * The source candle's OPENING time, kept as separate context.
   *
   * Optional on purpose: alerts produced by an older Pine build do not send
   * it, and a missing bar time says nothing about whether the signal is
   * eligible. Nothing in admission reads it — it exists so the candle context
   * is not lost now that `triggeredAt` no longer carries it.
   */
  barTime: z.string().optional(),
  exchange: z.string().optional(),
  note: z.string().optional(),
  // Phase 11B.0. Present ONLY on a deliberately created canary alert. It is not
  // a Binance credential, but it authorizes a real-money trade, so it is never
  // logged, never returned by an API and never persisted in this raw form.
  canaryAuthorization: z.string().optional(),
});

export type TradingViewWebhookInput = z.infer<typeof tradingViewWebhookSchema>;
