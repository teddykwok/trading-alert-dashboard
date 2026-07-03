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
| `AI_VISION_PROVIDER` | `mock` for now — see [AI Vision](#where-to-plug-in-a-real-ai-vision-provider) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Optional; leave blank to disable Telegram notifications |

Frontend (`apps/frontend/.env`, see `apps/frontend/.env.example`):

| Variable | Description |
| --- | --- |
| `VITE_API_URL` | Backend REST base URL (default `http://localhost:4000`) |
| `VITE_SOCKET_URL` | Backend Socket.IO URL (usually the same as `VITE_API_URL`) |

## TradingView webhook setup

1. Open your TradingView alert creation dialog.
2. Under **Notifications**, enable **Webhook URL** and paste:
   `http://<your-backend-host>:4000/api/webhooks/tradingview`
   (the Settings page in the dashboard shows this URL for your running instance).
3. In the **Message** box, paste JSON matching the shape below, replacing `secret` with your
   `WEBHOOK_SECRET` value. See `docs/tradingview-setup.md` for more detail.

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

## Where to plug in real integrations later

- **Real AI Vision provider**: implement `AiVisionProvider` (see
  `apps/backend/src/modules/ai-vision/ai-vision.types.ts`) in a new class inside
  `ai-vision.service.ts`, wire it up in `getAiVisionProvider()`, and add the new option to the
  `AI_VISION_PROVIDER` env enum in `apps/backend/src/config/env.ts`. The strict system prompt is
  already defined in `ai-vision.prompt.ts` (no financial advice, structure-only, JSON only).
- **Real market data**: `apps/backend/src/modules/market-data/binance.provider.ts` and
  `stocks.provider.ts` currently generate a mock random walk. Replace the body of
  `getRecentCandles` in each with a real REST call (e.g. Binance klines, or a stock market data
  API) — the `MarketDataProvider` interface and the rest of the pipeline don't need to change.

## Notes on AI Vision

The AI Vision step is an **analysis assistant, not financial advice**. It is explicitly
instructed (see `docs/ai-vision-prompt.md`) to avoid buy/sell/trade instructions and to only
describe visually observable chart structure, along with uncertainty and invalidation notes.
Treat its output as one more data point in your own research process.
