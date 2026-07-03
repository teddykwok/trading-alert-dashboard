# Webhook payload

`POST /api/webhooks/tradingview`

## Request body

```json
{
  "secret": "change-me",
  "symbol": "BTCUSDT",
  "assetType": "crypto",
  "timeframe": "1h",
  "price": 64250.5,
  "signal": "LONG",
  "indicatorName": "My Custom Indicator",
  "indicatorValue": 87.2,
  "triggeredAt": "2026-07-02T10:30:00Z",
  "exchange": "BINANCE",
  "note": "Bullish reversal zone detected"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `secret` | string | yes | Must match the backend's `WEBHOOK_SECRET`. Never stored. |
| `symbol` | string | yes | e.g. `BTCUSDT`, `AAPL` |
| `assetType` | string | yes | Case-insensitive; normalized to `CRYPTO` or `STOCK` |
| `timeframe` | string | yes | e.g. `1m`, `15m`, `1h`, `4h`, `1d` |
| `price` | number | yes | Must be positive |
| `signal` | string | yes | Case-insensitive; normalized to `LONG`, `SHORT`, `WATCH`, or `EXIT` |
| `indicatorName` | string | no | Free text |
| `indicatorValue` | number | no | |
| `triggeredAt` | string (ISO 8601) | yes | Falls back to "now" if unparseable |
| `exchange` | string | no | e.g. `BINANCE`, `NASDAQ` |
| `note` | string | no | Free text, stored in `rawPayload` |

## Response

- `202 Accepted` with `{ "id": "<alertId>", "status": "RECEIVED" }` on success.
- `422 Unprocessable Entity` if the payload fails Zod validation or the `assetType`/`signal`
  values don't map to a known enum.
- `401 Unauthorized` if `secret` doesn't match `WEBHOOK_SECRET`.

## What happens after the response

The response is returned as soon as the `Alert` row is created — nothing past that point blocks
the HTTP request. Asynchronously (see `docs/architecture.md`):

1. `new_alert` is broadcast over Socket.IO.
2. A `vision-analysis` job is enqueued with `{ alertId }`.
3. The worker processes the job: `PROCESSING_SCREENSHOT` → mock OHLCV fetch → chart render
   (Lightweight Charts + Playwright) → `screenshotUrl` saved → `ANALYZING_WITH_AI` → AI Vision
   result saved → `ANALYZED`, with `alert_updated` broadcast after each transition (or
   `alert_failed` + `FAILED` status if any step throws).
