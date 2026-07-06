# Trading Alert Dashboard

A personal dashboard that receives TradingView webhook alerts, stores them, generates a chart
screenshot, sends the screenshot to an AI Vision analysis step, and pushes everything to the
browser in real time.

> **Not financial advice.** The AI Vision output describes chart *structure* only (possible
> reversal/continuation, support/resistance behavior, momentum quality, uncertainty and
> invalidation notes). It never issues buy/sell instructions and should be treated as a research
> assistant, not a trading signal.

## Project overview

- TradingView fires a webhook on your custom alert condition.
- The backend validates and authenticates the payload, saves it immediately, and responds fast.
- A background worker renders a candlestick chart screenshot and runs it through an AI Vision
  step, updating the alert's status as it goes.
- The frontend dashboard reflects every step live via Socket.IO — no polling.

## Architecture (text diagram)

```
                         ┌─────────────────────┐
TradingView Alert  ───▶  │  POST /api/webhooks  │  (Fastify, Zod validation, secret check)
                         │      /tradingview     │
                         └──────────┬────────────┘
                                    │ 1. save Alert (status=RECEIVED)
                                    │ 2. emit "new_alert" (Socket.IO via Redis)
                                    │ 3. enqueue BullMQ job {alertId}
                                    ▼
                         ┌─────────────────────┐
                         │   Redis (BullMQ +    │
                         │   Socket.IO adapter) │
                         └──────────┬────────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │  vision-analysis      │  (separate worker process)
                         │  worker                │
                         │  1. status=PROCESSING_SCREENSHOT
                         │  2. mock OHLCV fetch
                         │  3. render chart (Lightweight Charts + Playwright)
                         │  4. save screenshotUrl
                         │  5. status=ANALYZING_WITH_AI
                         │  6. ai-vision.service (mock provider)
                         │  7. save AI result, status=ANALYZED
                         │  8. emit "alert_updated"
                         └──────────┬────────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │   PostgreSQL (Prisma) │
                         └─────────────────────┘

Frontend (React + Vite) ◀── Socket.IO (new_alert / alert_updated / alert_failed) ── Backend
Frontend ── REST (GET/PATCH/DELETE /api/alerts, /api/assets, /api/settings) ──▶ Backend
```

The webhook route never runs screenshot generation or AI analysis inline — it only validates,
persists, broadcasts, and enqueues. All slow work happens in `apps/backend/src/modules/jobs/vision-analysis.worker.ts`,
which runs as its own process (`pnpm dev:worker`).

## Monorepo layout

```
trading-alert-dashboard/
├── apps/backend    Fastify + Prisma + BullMQ + Socket.IO API and worker
├── apps/frontend   React + Vite + Tailwind dashboard
├── packages/shared Shared TypeScript types/constants used by both apps
└── docs            Architecture, webhook payload, TradingView setup, AI prompt notes
```

## Setup instructions

### 1. Prerequisites

- Node.js 18.18+
- pnpm 8+ (`corepack enable` is the easiest way to get it)
- Docker (for local Postgres + Redis) — or your own Postgres/Redis instances

### 2. Install dependencies

```bash
pnpm install
```

This also builds `packages/shared` once (via a `postinstall` script) so both apps can resolve it.

### 3. Start Postgres + Redis

```bash
docker compose up -d
```

### 4. Configure environment variables

```bash
cp .env.example apps/backend/.env
cp apps/frontend/.env.example apps/frontend/.env
```

Edit `apps/backend/.env` and set a real `WEBHOOK_SECRET`. See [Environment variables](#environment-variables) below.

### 5. Set up the database

```bash
pnpm db:migrate
pnpm db:seed
```

### 6. Install the Playwright browser (used for chart screenshots)

```bash
pnpm --filter @trading-alert-dashboard/backend playwright:install
```

### 7. Run everything

```bash
pnpm dev          # backend API + frontend dev server
pnpm dev:worker   # in a second terminal — the vision-analysis worker
```

- Backend: http://localhost:4000
- Frontend: http://localhost:5173

## Environment variables

Backend (`apps/backend/.env`, see `.env.example` at the repo root):

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Postgres connection string used by Prisma |
| `REDIS_URL` | Redis connection string used by BullMQ + Socket.IO adapter |
| `BACKEND_PORT` | Port the Fastify server listens on (default `4000`) |
| `FRONTEND_URL` | Used for CORS + Socket.IO origin (default `http://localhost:5173`) |
| `WEBHOOK_SECRET` | Shared secret TradingView must send in the `secret` field |
| `SCREENSHOT_STORAGE_DIR` | Where chart screenshots are written (served at `/screenshots/*`) |
| `AI_VISION_PROVIDER` | `mock` (default) or `openai` — see [Using real AI Vision](#using-real-ai-vision) |
| `OPENAI_API_KEY` | Required when `AI_VISION_PROVIDER=openai`; leave blank for mock |
| `OPENAI_VISION_MODEL` | OpenAI vision-capable model (default `gpt-4o-mini`) |
| `AI_VISION_TIMEOUT_MS` | Abort the AI request after this many ms (default `30000`) |
| `AI_VISION_FALLBACK_TO_MOCK` | See [Using real AI Vision](#using-real-ai-vision) (default `false`) |
| `AI_VISION_MAX_IMAGE_BYTES` | Reject screenshots larger than this before sending to the AI (default `5000000`) |
| `DUPLICATE_SUPPRESSION_WINDOW_SECONDS` | See [Duplicate suppression](#duplicate-suppression) (default `60`) |
| `BINANCE_REST_BASE_URL` | Binance public REST base URL, no API key needed (default `https://api.binance.com`) |
| `MARKET_DATA_PROVIDER` | See [Using real Binance market data](#using-real-binance-market-data) (default `binance`) |
| `MARKET_DATA_FALLBACK_TO_MOCK` | See [Using real Binance market data](#using-real-binance-market-data) (default `false`) |
| `TELEGRAM_NOTIFICATIONS_ENABLED` | Master switch for Telegram — see [Telegram Notifications](#telegram-notifications) (default `false`) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram bot token + target chat id (required when notifications are enabled) |
| `TELEGRAM_SEND_SCREENSHOT` | Send the chart screenshot as a photo, else text-only (default `true`) |
| `TELEGRAM_NOTIFY_ON_FAILED` | Also notify when an alert becomes `FAILED` (default `false`) |
| `TELEGRAM_MIN_CONFIDENCE` | Skip notifications below this AI confidence, 0..1 (default `0` = always) |

Frontend (`apps/frontend/.env`, see `apps/frontend/.env.example`):

| Variable | Description |
| --- | --- |
| `VITE_API_URL` | Backend REST base URL (default `http://localhost:4000`) |
| `VITE_SOCKET_URL` | Backend Socket.IO URL (usually the same as `VITE_API_URL`) |

## Duplicate suppression

TradingView can fire the same alert repeatedly in a short burst (e.g. a noisy indicator re-triggering
on every tick). To avoid spamming the pipeline — a fresh screenshot render + AI analysis job per
duplicate — the webhook route suppresses repeats instead of creating a new alert every time.

An incoming webhook is treated as a duplicate of an existing alert when **all** of these match:

- `symbol`
- `assetType`
- `timeframe`
- `signal`
- `indicatorName`

and that existing alert was created within the last `DUPLICATE_SUPPRESSION_WINDOW_SECONDS` seconds
(default **60**).

When a duplicate is detected:

- No new `Alert` row, screenshot, or `vision-analysis` job is created.
- The existing alert's `duplicateCount` is incremented and `lastDuplicateAt` is updated.
- The webhook still responds `202`, but with a shape that flags the suppression instead of a fresh alert:
  ```json
  { "id": "<existingAlertId>", "status": "IGNORED_DUPLICATE", "duplicate": true, "duplicateCount": 3 }
  ```
- A `alert_duplicate` Socket.IO event is broadcast with the updated alert, so the dashboard reflects
  the new `duplicateCount` live (shown as a "×N duplicates" badge on the alert card) without a page reload.
- No Telegram notification is sent for duplicates — repeated pings would defeat the point of suppressing them.

Once an alert falls outside the window, the next matching webhook is treated as a brand new alert
(new screenshot, new AI analysis) rather than bumping the old one's counter.

## Using real Binance market data

CRYPTO alerts whose `exchange` is `BINANCE` now render their chart screenshot from **real** Binance
candles instead of the mock random-walk generator — a plain `GET /api/v3/klines` call against
Binance's public Spot market data API (no API key required). Everything else about the pipeline is
unchanged: the worker still renders the same Lightweight Charts screenshot, still runs it through
the (still mock) AI Vision step, and the alert still ends up `ANALYZED`.

- **CRYPTO + `exchange: "BINANCE"`** → real Binance klines (`apps/backend/src/modules/market-data/binance.provider.ts`).
- **STOCK**, or crypto on any other/unset exchange → the existing mock candle generator, unchanged.
- The webhook's `timeframe` (`1m`, `5m`, `15m`, `1h`, `4h`, `1d`) maps directly onto Binance's
  interval tokens. Anything else throws `Unsupported Binance interval: <timeframe>`.
- Requests use a 10s timeout (`AbortController`) and retry once on failure before giving up.

**`MARKET_DATA_FALLBACK_TO_MOCK`** controls what happens if the Binance request ultimately fails
(network error, timeout, non-2xx response, bad symbol, etc.):

- `false` (default) — the worker job fails, the alert's status becomes `FAILED`, and `errorMessage`
  starts with `Market data fetch failed: ...`. No screenshot is silently faked.
- `true` — a warning is logged and the pipeline falls back to mock candles, same as before this
  feature existed, so the alert can still reach `ANALYZED`.

For first tests, use real Binance Spot symbols that actually exist — **`BTCUSDT`**, **`ETHUSDT`**,
or **`SOLUSDT`** are good choices. A made-up symbol will fail with Binance's own `Invalid symbol`
error (surfaced as the alert's `errorMessage` unless fallback is enabled).

To sanity-check Binance connectivity/data on its own, without going through the webhook pipeline:

```bash
pnpm test:binance
node scripts/test-binance-candles.js --symbol ETHUSDT --interval 4h --limit 20
```

The chart data feeding the screenshot is now real; the AI analysis of that screenshot can be mock
or real — see the next section.

## Using real AI Vision

The AI Vision step (which looks at the generated chart screenshot and returns a structured opinion)
runs behind a provider abstraction. By default it uses the **mock** provider — a safe, signal-aware
placeholder that never calls any external API. You can switch on a real **OpenAI vision** provider
with two env vars.

**Not financial advice.** Whichever provider is active, the AI is constrained by a strict system
prompt (`apps/backend/src/modules/ai-vision/ai-vision.prompt.ts`) to describe only visible chart
structure (trend continuation/reversal, consolidation, support/resistance behavior, momentum
quality, uncertainty) and its response is validated against an allow-list of `bias` values. It is
forbidden from saying "buy"/"sell"/"enter now"/"guaranteed"/"risk-free" or giving any direct
buy/sell/position instruction, and must always express uncertainty rather than certainty.

### Mock mode (default)

```bash
AI_VISION_PROVIDER=mock
```

No API key, no cost, no network. Alerts get a signal-aware mock analysis tagged `aiProvider: "mock"`
(shown with a yellow **Mock AI** badge and a "for pipeline testing only" warning on the dashboard).

### OpenAI mode

```bash
AI_VISION_PROVIDER=openai
OPENAI_API_KEY=sk-...           # required — startup fails clearly without it
OPENAI_VISION_MODEL=gpt-4o-mini # any vision-capable chat model
AI_VISION_TIMEOUT_MS=30000
AI_VISION_MAX_IMAGE_BYTES=5000000
```

In OpenAI mode the worker reads the chart screenshot from disk, checks it against
`AI_VISION_MAX_IMAGE_BYTES`, base64-encodes it into a data URL, and sends it plus the strict prompt
to OpenAI's Chat Completions API in JSON mode (with a `AI_VISION_TIMEOUT_MS` `AbortController`
timeout). The JSON response is validated; results are tagged `aiProvider: "openai"` and shown with a
green **OpenAI Vision** badge plus the note *"AI vision analysis is informational and based only on
the chart screenshot."*

If `AI_VISION_PROVIDER=openai` but `OPENAI_API_KEY` is empty, the backend **fails to start** with a
clear validation error rather than silently degrading.

### Failure behavior

If the OpenAI request fails (bad key, timeout, non-2xx, or a response that fails validation),
`AI_VISION_FALLBACK_TO_MOCK` decides what happens:

- `false` (default) — the worker job fails, the alert becomes `FAILED`, and `errorMessage` explains
  why. Real analysis is never silently faked.
- `true` — a warning is logged and the pipeline returns a mock result (tagged `aiProvider: "mock"`,
  so the dashboard shows it honestly as mock) so the alert can still reach `ANALYZED`.

### Testing it

Best tested with a real Binance screenshot so the model has genuine structure to read:

```bash
# 1. Mock mode (default) — no key needed
node scripts/test-webhook.js --symbol BTCUSDT --assetType crypto --exchange BINANCE --signal LONG --price 64000 --timeframe 1h
#    -> alert ANALYZED, aiProvider "mock", yellow "Mock AI" badge.

# 2. OpenAI mode — set AI_VISION_PROVIDER=openai and OPENAI_API_KEY in apps/backend/.env, restart the worker, then:
node scripts/test-webhook.js --symbol BTCUSDT --assetType crypto --exchange BINANCE --signal LONG --price 64000 --timeframe 1h
#    -> alert ANALYZED, aiProvider "openai", green "OpenAI Vision" badge, analysis derived from the real chart.

# 3. Missing key failure: set AI_VISION_PROVIDER=openai with OPENAI_API_KEY empty -> backend refuses to start.

# 4. Fallback: AI_VISION_PROVIDER=openai + AI_VISION_FALLBACK_TO_MOCK=true with a bad/missing key at runtime
#    -> worker logs a warning and the alert still reaches ANALYZED as a mock result.
```

## Telegram Notifications

Get a Telegram message when an alert finishes analysis, so you don't have to watch the dashboard.

**When it's sent:** the notification is sent by the **worker**, *after* the alert reaches `ANALYZED`
(screenshot generated + AI analysis done) — never inside the webhook request. This means the message
already contains the AI bias, confidence, summary, and (optionally) the chart screenshot.

**What's never notified:** duplicate alerts. Duplicate suppression exists to reduce spam, so a
suppressed duplicate only bumps the counter and updates the dashboard — it does not send Telegram.

**Failures are non-fatal:** if Telegram is down, misconfigured, or rejects the message, the alert
pipeline is unaffected — the alert still reaches `ANALYZED`; the Telegram error is just logged.

### 1. Create a bot and get your chat id

1. In Telegram, message **@BotFather**, send `/newbot`, and copy the **bot token** it gives you.
2. Send any message to your new bot (bots can't message you until you've talked to them first).
3. Get your **chat id**: open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and
   read `result[].message.chat.id` (or use a chat-id helper bot).

### 2. Configure `apps/backend/.env`

```bash
TELEGRAM_NOTIFICATIONS_ENABLED=true
TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token
TELEGRAM_CHAT_ID=123456789
TELEGRAM_SEND_SCREENSHOT=true    # send the chart image (falls back to text on failure)
TELEGRAM_NOTIFY_ON_FAILED=false  # set true to also get a message on FAILED alerts
TELEGRAM_MIN_CONFIDENCE=0        # e.g. 0.6 to only notify when AI confidence >= 60%
```

With `TELEGRAM_NOTIFICATIONS_ENABLED=false` (the default) nothing is ever sent. If it's `true` but the
token or chat id is missing, the worker logs a clear warning (never the token) and skips sending.

### 3. Verify credentials without the pipeline

```bash
pnpm test:telegram
```

This reads `apps/backend/.env` and sends `"Trading Alert Dashboard Telegram test message"` straight to
your chat, printing success or a helpful error (e.g. "chat not found" / "unauthorized"). The bot token
is never printed in full.

### 4. End-to-end test

Start the stack, then fire a real alert:

```bash
pnpm dev
pnpm dev:worker   # the worker is what sends Telegram — it must be running

node scripts/test-webhook.js --symbol BTCUSDT --assetType crypto --exchange BINANCE --signal LONG --price 64000 --timeframe 1h
```

Watch the alert progress to `ANALYZED` on the dashboard; a Telegram message (with the screenshot, if
enabled) arrives right after. Fire the **same** webhook again within the duplicate window
(`DUPLICATE_SUPPRESSION_WINDOW_SECONDS`, default 60s) — the dashboard shows the duplicate counter tick
up, but **no** second Telegram message is sent.

## TradingView webhook setup

1. Open your TradingView alert creation dialog.
2. Under **Notifications**, enable **Webhook URL** and paste:
   `http://<your-backend-host>:4000/api/webhooks/tradingview`
   (the Settings page in the dashboard shows this URL for your running instance).
3. In the **Message** box, paste JSON matching the shape below, replacing `secret` with your
   `WEBHOOK_SECRET` value. See `docs/tradingview-setup.md` for more detail.

> **Live testing with real TradingView alerts:** TradingView can't reach `localhost`. See
> [docs/tradingview-live-test.md](docs/tradingview-live-test.md) for the full walkthrough using a
> free Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:4000`), including prefixed
> symbols like `BINANCE:BTCUSDT` (normalized automatically) and making Telegram dashboard links
> work on your phone via `PUBLIC_DASHBOARD_URL`.

### Example webhook payload

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

## How to run backend

```bash
pnpm dev:backend    # tsx watch, http://localhost:4000
pnpm --filter @trading-alert-dashboard/backend build && pnpm --filter @trading-alert-dashboard/backend start   # production
```

## How to run frontend

```bash
pnpm dev:frontend   # http://localhost:5173
pnpm --filter @trading-alert-dashboard/frontend build && pnpm --filter @trading-alert-dashboard/frontend preview  # production preview
```

## How to run the worker

```bash
pnpm dev:worker
```

This process must be running for alerts to progress past `RECEIVED` — the webhook route itself
never generates screenshots or calls AI Vision.

## How to test with curl

```bash
curl -X POST http://localhost:4000/api/webhooks/tradingview \
  -H "Content-Type: application/json" \
  -d '{
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
  }'
```

Expect an immediate `202` response like `{"id":"...","status":"RECEIVED"}`. Watch the dashboard
(or the worker's logs) to see the status progress through `PROCESSING_SCREENSHOT` →
`ANALYZING_WITH_AI` → `ANALYZED`.

## Testing webhook without curl on Windows PowerShell

PowerShell aliases `curl` to `Invoke-WebRequest`, which makes sending JSON bodies awkward. Use the
dependency-free Node script at `scripts/test-webhook.js` instead — it reads `WEBHOOK_SECRET` and
`BACKEND_PORT` straight from `apps/backend/.env` and posts a valid payload for you:

```bash
pnpm test:webhook
```

Override any field with CLI flags:

```bash
node scripts/test-webhook.js --symbol ETHUSDT --signal SHORT --price 3500
node scripts/test-webhook.js --symbol ETHUSDT --signal SHORT --price 3500 --timeframe 4h
node scripts/test-webhook.js --symbol AAPL --assetType stock --signal WATCH --price 220 --exchange NASDAQ
```

The script prints the webhook URL, the payload it sent (with the secret masked), the HTTP status,
and the response body, then exits non-zero if the request didn't succeed.

## Batch webhook stress test

To test queue reliability, worker throughput, and dashboard realtime updates under load, use
`scripts/test-webhook-batch.js` — it's the same dependency-free approach as `test-webhook.js`, but
fires a whole batch of requests with a delay between each.

```bash
pnpm test:webhook:batch
```

With no flags it sends 10 requests, 500ms apart, rotating through `BTCUSDT`, `ETHUSDT`, `SOLUSDT`,
`AAPL`, `TSLA` and through `LONG`, `SHORT`, `WATCH`, `EXIT`, with a reasonable (slightly jittered)
price per symbol. Override any of that:

```bash
node scripts/test-webhook-batch.js --count 20 --delayMs 250
node scripts/test-webhook-batch.js --count 50 --delayMs 100
node scripts/test-webhook-batch.js --symbol BTCUSDT --signal LONG --count 10
```

For each request it prints the index, symbol, signal, price, HTTP status, alert id, and response
time; a failed request doesn't stop the batch. At the end it prints a summary (total sent,
successful, failed, average/min/max response time) and exits non-zero if anything failed.

## Where to plug in real integrations later

- **Real AI Vision provider**: a real OpenAI vision provider already exists (see
  [Using real AI Vision](#using-real-ai-vision)). To add another (Anthropic, Gemini, …), implement
  `AiVisionProvider` (see `apps/backend/src/modules/ai-vision/ai-vision.types.ts`) in a new
  `*.provider.ts` file the same way `openai.provider.ts` does, add a case in `getAiVisionProvider()`
  inside `ai-vision.service.ts`, and add the value to the `AI_VISION_PROVIDER` env enum in
  `apps/backend/src/config/env.ts`. The strict system prompt and response validator
  (`ai-vision.prompt.ts` / `ai-vision.schema.ts`) are shared across providers.
- **Real market data**: CRYPTO alerts on the `BINANCE` exchange already use real klines (see
  [Using real Binance market data](#using-real-binance-market-data)). `stocks.provider.ts` still
  generates a mock random walk — replace the body of its `getRecentCandles` with a real REST call
  (e.g. Polygon.io, Alpha Vantage) the same way `binance.provider.ts` does; the `MarketDataProvider`
  interface and the rest of the pipeline don't need to change.

## Notes on AI Vision

The AI Vision step is an **analysis assistant, not financial advice**. It is explicitly
instructed (see `docs/ai-vision-prompt.md`) to avoid buy/sell/trade instructions and to only
describe visually observable chart structure, along with uncertainty and invalidation notes.
Treat its output as one more data point in your own research process.
