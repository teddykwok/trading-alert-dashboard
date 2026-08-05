# TradingView live webhook testing (Cloudflare Tunnel)

This guide walks through receiving **real TradingView alerts** on your local machine using a free
Cloudflare Quick Tunnel — no account, DNS, or deployment needed.

## 1. Start the stack

Three processes, three terminals (Postgres + Redis via `docker compose up -d` first if not running):

```bash
pnpm dev:backend    # Fastify API on http://localhost:4000
pnpm dev:worker     # REQUIRED — screenshots, AI analysis, Telegram all happen here
pnpm dev:frontend   # dashboard on http://localhost:5173
```

(`pnpm dev` runs backend + frontend together; the worker is always separate.)

## 2. Start a Cloudflare Tunnel for the backend

Install `cloudflared` (e.g. `winget install Cloudflare.cloudflared` on Windows), then:

```bash
cloudflared tunnel --url http://localhost:4000
```

It prints a public URL like:

```
https://random-words-here.trycloudflare.com
```

Your webhook URL is that host plus the normal path:

```
https://random-words-here.trycloudflare.com/api/webhooks/tradingview
```

Sanity-check it from any device before touching TradingView:

```bash
curl https://random-words-here.trycloudflare.com/health
```

> Quick Tunnel URLs change every time you restart `cloudflared` — update your TradingView alert
> when that happens.

## 3. Create the TradingView alert

1. On a TradingView chart, create an Alert with your desired condition.
2. Under **Notifications**, enable **Webhook URL** and paste the tunnel webhook URL above.
3. Set the **Message** to JSON like this (placeholders are filled in by TradingView):

```json
{
  "secret": "YOUR_WEBHOOK_SECRET",
  "symbol": "{{ticker}}",
  "assetType": "crypto",
  "timeframe": "{{interval}}",
  "price": {{close}},
  "signal": "LONG",
  "indicatorName": "TradingView Test Alert",
  "indicatorValue": 0,
  "triggeredAt": "{{time}}",
  "exchange": "BINANCE",
  "note": "TradingView live webhook test"
}
```

- `secret` must exactly match `WEBHOOK_SECRET` in `apps/backend/.env`.
- **Prefixed symbols are fine.** TradingView sometimes sends `BINANCE:BTCUSDT` or `NASDAQ:AAPL`
  instead of a bare ticker. The backend normalizes these automatically: the bare symbol
  (`BTCUSDT`) is used for market data, duplicate suppression, and storage, and the exchange
  prefix is used as the exchange when the payload's `exchange` field is missing. An explicit
  `exchange` field always wins. The original symbol is preserved in the alert's raw payload.
- For stocks, use `"assetType": "stock"` (chart data will be mock candles — only Binance crypto
  uses real market data today).

## 4. Watch it flow

When the alert fires:

1. TradingView POSTs to the tunnel → backend responds `202` immediately.
2. Dashboard (http://localhost:5173) shows the alert live: `RECEIVED` →
   `PROCESSING_SCREENSHOT` → `ANALYZING_WITH_AI` → `ANALYZED`.
3. If Telegram is enabled, the notification arrives after `ANALYZED`.

Re-fires of the same alert within `DUPLICATE_SUPPRESSION_WINDOW_SECONDS` (default 60s) only bump
the duplicate counter — no new analysis, no extra Telegram message. This works even when
TradingView alternates between `BTCUSDT` and `BINANCE:BTCUSDT` forms, because suppression runs on
the normalized symbol.

## 5. Make Telegram links work on your phone

`PUBLIC_DASHBOARD_URL` is optional. While it is empty (or set to a localhost address, which is
useless on a phone), Telegram messages simply leave the link section out. To get tappable links,
expose the frontend too, in another terminal:

```bash
cloudflared tunnel --url http://localhost:5173
```

Then set in `apps/backend/.env` and restart the **worker** (it builds the message):

```bash
PUBLIC_DASHBOARD_URL=https://your-frontend-tunnel.trycloudflare.com
```

## 6. Simulating without TradingView

You can dry-run the exact same path through the tunnel from anywhere:

```bash
node scripts/test-webhook.js --symbol BINANCE:BTCUSDT --assetType crypto --signal LONG --price 64000 --timeframe 1h
```

(The script targets `localhost`, but you can also `curl` the tunnel URL directly with the JSON
above to verify the public path end-to-end.)

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| TradingView shows webhook error | Tunnel not running, or URL changed after `cloudflared` restart |
| `401 Unauthorized` | `secret` in the alert message ≠ `WEBHOOK_SECRET` |
| `422` validation error | Malformed JSON in the alert message (check quotes around `{{close}}` — price must be unquoted) |
| Alert stuck at `RECEIVED` | Worker not running (`pnpm dev:worker`) |
| Alert `FAILED` with market data error | Symbol doesn't exist on Binance Spot, or `MARKET_DATA_FALLBACK_TO_MOCK=false` with Binance unreachable |
| No Telegram message | `TELEGRAM_NOTIFICATIONS_ENABLED` not `true`, worker not restarted after env change, or confidence below `TELEGRAM_MIN_CONFIDENCE` |
