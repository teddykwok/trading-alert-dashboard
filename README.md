# Trading Alert Dashboard

A personal dashboard that receives TradingView webhook alerts, stores them, renders a candlestick
chart screenshot, runs the screenshot through an AI (or mock) vision analysis step, and pushes every
change to the browser in real time over Socket.IO. It can optionally send a Telegram message when an
alert finishes analysis.

It is intended primarily as a **personal, single-operator trading alert monitoring system**, not a
multi-tenant product.

> **Not financial advice.** The AI Vision step describes chart *structure* only (possible
> reversal/continuation, support/resistance behavior, momentum quality, uncertainty and invalidation
> notes). It never issues buy/sell instructions and should be treated as a research assistant, not a
> trading signal. Understand the mock/fallback behavior (below) before relying on any analysis.

## Overview

The end-to-end flow:

```
TradingView webhook
  -> backend validation + secret check + persistence (responds fast, 202)
  -> Redis / BullMQ job queued
  -> worker: market data (Binance or mock) + chart screenshot (Playwright)
  -> worker: AI vision analysis (mock or OpenAI)
  -> Socket.IO realtime update to the dashboard
  -> optional Telegram notification (after ANALYZED)
```

The webhook route itself never renders screenshots or calls AI — it only validates, authenticates,
persists, broadcasts, and enqueues. All slow work happens in the separate worker process
(`pnpm dev:worker`), so an alert must be able to reach the queue **and** the worker must be running
for it to progress past `RECEIVED`.

## Current Features

All items below are implemented in this repository:

- **TradingView webhook ingestion** — `POST /api/webhooks/tradingview` (`apps/backend/src/routes/webhook.routes.ts`).
- **Webhook secret validation** — the payload `secret` must match `WEBHOOK_SECRET`; mismatches are rejected.
- **Structural payload validation** — Zod schema (`apps/backend/src/modules/webhook/webhook.schema.ts`).
- **Symbol normalization** — prefixed/perpetual symbols like `BINANCE:BTCUSDT` or `BINANCE:GRASSUSDT.P` are normalized (the original is preserved in `rawPayload`).
- **Duplicate alert suppression** — repeated identical alerts within a time window bump a counter instead of creating new alerts (see [Duplicate suppression](#duplicate-suppression)).
- **Binance market data** — CRYPTO alerts on the `BINANCE` exchange render from real Binance klines (Spot, plus USD‑M futures for `.P` perpetuals); other assets use a mock candle generator.
- **Supported asset types** — `CRYPTO`, `STOCK`. **Signals** — `LONG`, `SHORT`, `WATCH`, `EXIT`.
- **Alert status pipeline** — `RECEIVED` → `PROCESSING_SCREENSHOT` → `ANALYZING_WITH_AI` → `ANALYZED`, plus `FAILED` and `IGNORED_DUPLICATE`.
- **Chart screenshot generation** — Lightweight Charts rendered headlessly with Playwright (Chromium), served at `/screenshots/*`.
- **Mock and OpenAI Vision providers** — provider abstraction with a safe signal-aware mock (default) and a real OpenAI vision provider, both constrained by a strict prompt.
- **Telegram notifications** — optional message (with screenshot) sent by the worker after `ANALYZED`.
- **Realtime Socket.IO updates** — `new_alert`, `alert_updated`, `alert_failed`, `alert_duplicate` events; no polling.
- **Alert filtering and details** — filter by status, symbol, signal, asset type, source timeframe, and level color; per-alert detail page.
- **Screenshot display** — thumbnails on cards and full screenshot on the detail page.
- **Trade outcome tracking** — manual per-alert review (`IGNORED` / `OPEN` / `WIN` / `LOSS` / `BREAKEVEN`) with entry/exit prices and notes.
- **Futures Risk Planner** — position sizing / risk / liquidation calculations derived from stored inputs (never persisted as derived values).
- **Trade checklist & psychology journal** — a pre-trade checklist plus optional emotion/confidence/notes per alert.
- **Touch-signal / level context metadata** — the Pine "touch" indicator sends `eventType`, `levelColor`, `sourceTf`, and `touchDirection` in the note; these are parsed and shown as badges.
- **Pine indicator integration** — reference Pine scripts live in [`docs/pine/`](docs/pine/).

## Architecture

Monorepo managed with pnpm workspaces (`pnpm-workspace.yaml` includes `apps/*` and `packages/*`):

```
trading-alert-dashboard/
├── apps/backend      Fastify API + Prisma + BullMQ worker + Socket.IO
├── apps/frontend     React + Vite + Tailwind dashboard
├── packages/shared   Shared TypeScript types + constants used by both apps
├── scripts           Node test/utility scripts (webhook, batch, Binance, Telegram)
└── docs              Architecture, webhook payload, TradingView setup, AI prompt, Pine scripts
```

Text architecture diagram:

```
                         ┌───────────────────────────┐
 TradingView Alert ────▶ │ POST /api/webhooks/        │  Fastify + Zod + secret check
                         │      tradingview           │
                         └─────────────┬──────────────┘
                                       │ 1. save Alert (status=RECEIVED)
                                       │ 2. emit "new_alert" (Socket.IO via Redis)
                                       │ 3. enqueue BullMQ job {alertId}
                                       ▼
                         ┌───────────────────────────┐
                         │ Redis (BullMQ queue +      │
                         │ Socket.IO Redis adapter)   │
                         └─────────────┬──────────────┘
                                       ▼
                         ┌───────────────────────────┐
                         │ vision-analysis worker     │  separate process (pnpm dev:worker)
                         │ 1. PROCESSING_SCREENSHOT   │
                         │ 2. market data (Binance/    │
                         │    mock candles)           │
                         │ 3. render chart (Lightweight│
                         │    Charts + Playwright)     │
                         │ 4. save screenshotUrl       │
                         │ 5. ANALYZING_WITH_AI        │
                         │ 6. AI vision (mock/openai)  │
                         │ 7. save result -> ANALYZED  │
                         │ 8. emit "alert_updated"     │
                         │ 9. optional Telegram send   │
                         └─────────────┬──────────────┘
                                       ▼
                         ┌───────────────────────────┐
                         │ PostgreSQL (Prisma)        │
                         └───────────────────────────┘

Frontend (React + Vite) ◀── Socket.IO (new_alert / alert_updated / alert_failed / alert_duplicate)
Frontend ── REST /api/alerts, /api/assets, /api/settings, /api/alerts/:id/trade-review,
            /api/alerts/:id/trade-journal, /api/trade-reviews/stats, /api/trade-journals/stats ──▶ Backend
```

Stack:

- **Frontend** — React 18 + Vite 5 + Tailwind, `socket.io-client`, `react-router-dom`.
- **Backend** — Node + TypeScript, Fastify 4, `@fastify/cors`, `@fastify/static`, `@fastify/rate-limit`.
- **Database** — PostgreSQL via Prisma 5.
- **Queue / realtime** — Redis with BullMQ (jobs) and the Socket.IO Redis adapter/emitter (so the worker process can broadcast to connected dashboards).
- **Screenshots** — Playwright (Chromium) rendering Lightweight Charts.
- **Market data** — provider abstraction; Binance REST for crypto, mock generator otherwise.
- **AI vision** — provider abstraction; `mock` (default) or `openai`.

For a deeper design write-up see [`docs/architecture.md`](docs/architecture.md).

## Prerequisites

Versions come from repository configuration where specified; otherwise use a current stable release.

- **Node.js** — `>=18.18.0` (root `package.json` `engines`).
- **pnpm** — `8.15.4` is pinned via `packageManager`; `corepack enable` is the easiest way to get it.
- **Docker Desktop** — for local PostgreSQL 16 and Redis 7 (`docker-compose.yml`). Optional if you supply your own Postgres/Redis.
- **Git**.
- **Playwright Chromium** — installed via `pnpm --filter @trading-alert-dashboard/backend playwright:install` (needed for chart screenshots).
- **Tailscale** (optional) — for private remote access to the dashboard.
- **cloudflared** (optional) — for exposing the webhook publicly so real TradingView alerts can reach your machine.

## First-Time Local Setup

Run these once on a fresh clone. Commands are PowerShell-friendly and run from the repo root unless noted.

```powershell
# 1. Clone and enter the repo
git clone <repository-url> trading-alert-dashboard
cd trading-alert-dashboard

# 2. Install dependencies (also builds packages/shared via postinstall)
pnpm install

# 3. Create local env files from the examples
Copy-Item .env.example apps/backend/.env
Copy-Item apps/frontend/.env.example apps/frontend/.env

# 4. Configure environment variables (see the Environment Variables section)
#    - Set a real WEBHOOK_SECRET in apps/backend/.env
#    - IMPORTANT: set DATABASE_URL to host port 15432 (see note below)

# 5. Start PostgreSQL + Redis
docker compose up -d

# 6. Create/apply the database schema
pnpm db:migrate

# 7. Seed a few example assets (optional; safe to re-run — see note)
pnpm db:seed

# 8. Install the Playwright browser used for screenshots
pnpm --filter @trading-alert-dashboard/backend playwright:install

# 9. Start the API + frontend
pnpm dev

# 10. In a SECOND terminal, start the worker (required for alerts to progress)
pnpm dev:worker
```

What each step does:

- **`pnpm install`** — installs all workspace deps and builds `packages/shared` (via `postinstall`) so both apps can resolve it.
- **env files** — `apps/backend/.env` and `apps/frontend/.env` are gitignored local config.
- **`docker compose up -d`** — starts `trading-alert-postgres` (host port **15432**) and `trading-alert-redis` (host port **6379**).
- **`pnpm db:migrate`** — runs `prisma migrate dev`, which creates/applies all database tables.
- **`pnpm db:seed`** — inserts a few example assets (BTCUSDT, ETHUSDT, AAPL). The seed uses upserts, so it is **idempotent** — re-running it will not duplicate rows. It is only really needed on a new/empty database.
- **`playwright:install`** — downloads the Chromium build Playwright uses to render screenshots.
- **`pnpm dev`** — runs the backend API (`http://localhost:4000`) and the frontend dev server (`http://localhost:5173`) together.
- **`pnpm dev:worker`** — runs the vision-analysis worker that renders screenshots and runs AI analysis.

> **Database port note:** `docker-compose.yml` maps PostgreSQL to host port **`15432`** (`"15432:5432"`).
> The committed `.env.example` currently sets `DATABASE_URL` to port `55432` (a stale value; some
> inline comments also say 55432). Set your `DATABASE_URL` host port to **`15432`** to match the
> running container, otherwise Prisma cannot connect. Example:
> `postgresql://postgres:postgres@localhost:15432/trading_alert_dashboard?schema=public`

## Normal Daily Startup

Once the database has been migrated and Playwright is installed, daily startup is short.

Terminal 1:

```powershell
docker compose up -d
pnpm dev
```

Terminal 2:

```powershell
pnpm dev:worker
```

- Backend: `http://localhost:4000`
- Frontend: `http://localhost:5173`

You only need `pnpm db:migrate` again after a **fresh database** or after **pulling new migrations**.
`pnpm db:seed` is not part of daily startup.

## Normal Shutdown

- Press **Ctrl+C** in the `pnpm dev` terminal to stop the API + frontend.
- Press **Ctrl+C** in the `pnpm dev:worker` terminal to stop the worker.
- Optionally stop the containers:

```powershell
docker compose stop
```

Container lifecycle wording (based on this repo's `docker-compose.yml`, which declares named volumes
`trading-alert-postgres-data` and `trading-alert-redis-data`):

- `docker compose stop` — stops the containers but keeps them and their data.
- `docker compose down` — removes the containers and the default network, but **preserves** the named
  volumes, so your local database data survives.
- `docker compose down -v` — **also removes the named volumes**, which **deletes local database and
  Redis data**. Only use this when you intentionally want a clean slate.

## Environment Variables

Local env files (`apps/backend/.env`, `apps/frontend/.env`, `apps/frontend/.env.local`) are
**gitignored**. Never commit secrets, API keys, bot tokens, or private URLs. The backend template is
the root `.env.example` (identical to `apps/backend/.env.example`); the frontend template is
`apps/frontend/.env.example`.

### Backend — database & Redis

| Variable | Description | Default in example |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection string used by Prisma. Set host port to **15432** to match `docker-compose.yml`. | `...localhost:55432...` (change to 15432) |
| `REDIS_URL` | Redis connection string used by BullMQ + the Socket.IO adapter. | `redis://localhost:6379` |

### Backend — server

| Variable | Description | Default |
| --- | --- | --- |
| `BACKEND_PORT` | Port the Fastify server listens on (binds `0.0.0.0`). | `4000` |
| `FRONTEND_URL` | Allowed CORS origin + Socket.IO origin. | `http://localhost:5173` |
| `PUBLIC_DASHBOARD_URL` | Optional base URL for dashboard links shared outside the app (e.g. Telegram messages opened on a phone). Empty — or any localhost/127.0.0.1 value — means "no public dashboard", and notifications omit the link section instead of sending an unopenable URL. | _(empty)_ |

### Backend — webhook

| Variable | Description | Default |
| --- | --- | --- |
| `WEBHOOK_SECRET` | Shared secret TradingView must send in the payload `secret` field. **Set your own.** | `change-me` |

### Backend — market data

| Variable | Description | Default |
| --- | --- | --- |
| `MARKET_DATA_PROVIDER` | Crypto market-data provider. Only `binance` is implemented today. | `binance` |
| `MARKET_DATA_FALLBACK_TO_MOCK` | If the real Binance fetch fails: `true` logs a warning and falls back to mock candles; `false` fails the job (alert → `FAILED`). | `false` |
| `BINANCE_REST_BASE_URL` | Binance public Spot REST base URL (no API key needed). | `https://api.binance.com` |
| `BINANCE_FUTURES_REST_BASE_URL` | Binance USD‑M Futures REST base URL, used for `.P` perpetual symbols and by the read-only connector below. | `https://fapi.binance.com` |

### Backend — Binance read-only connector (Phase 2)

Strictly read-only account inspection. It can only issue `GET` requests to an
allowlisted set of documented USDⓈ-M endpoints — it cannot place or cancel
orders, change leverage, margin type or position mode, writes nothing to the
database, and is **not** wired into the alert pipeline. See
[docs/binance-execution-policy.md](docs/binance-execution-policy.md).

| Variable | Description | Default |
| --- | --- | --- |
| `BINANCE_READ_ONLY_ENABLED` | Enables the connector. While `false`, the backend starts with no Binance credentials at all. | `false` |
| `BINANCE_API_KEY` | Binance API key. Required **only** when the connector is enabled. Use a key with *Enable Reading* permission only. | _(empty)_ |
| `BINANCE_API_SECRET` | Binance API secret. Required only when the connector is enabled. | _(empty)_ |
| `BINANCE_RECV_WINDOW_MS` | Signed-request validity window. Binance maximum is `60000`. | `5000` |
| `BINANCE_TARGET_MARGIN_MULTIPLIER` | Preferred isolated margin = risk budget × this. Decimal string. | `2.5` |
| `BINANCE_MAX_MARGIN_MULTIPLIER` | Hard isolated-margin ceiling = risk budget × this. Must be ≥ the target multiplier. | `3.333333` |
| `BINANCE_LIQUIDATION_BUFFER_RATIO` | Liquidation must sit at least `stopDistance × ratio` beyond the stop loss. | `0.5` |
| `BINANCE_MAX_AUTOMATION_LEVERAGE` | User-side automation leverage ceiling (integer, max 125). Usable leverage = min(Binance bracket maximum, this). Recommendation only — never applied to the account. | `25` |

Phase 3 adds a **calculation-only** dynamic leverage / isolated margin planner.
It reuses the same GET-only connector, recommends a leverage without ever
applying it, and touches no order, leverage, margin type or position mode:

```bash
# <SYMBOL> <LONG|SHORT> <entry> <stopLoss> [riskBudgetUsd]
pnpm --filter @trading-alert-dashboard/backend binance:margin-plan -- BTCUSDT LONG 64000 63500 1.50

# Compare the liquidation estimator against Binance's reported values
pnpm --filter @trading-alert-dashboard/backend binance:liquidation-check
```

Run the health check (optionally for one symbol):

```bash
pnpm --filter @trading-alert-dashboard/backend binance:read-only-check
pnpm --filter @trading-alert-dashboard/backend binance:read-only-check BTCUSDT
```

It prints connection status, measured clock offset, position mode, USDT
balance, open positions and orders, and — with a symbol — that symbol's
filters and leverage brackets. Credentials are never printed.

### Backend — execution safety and capacity limits (Phase 5)

Admission control for planned executions: it decides whether a plan may
proceed and reserves its capacity **locally**. It reads Binance only through
the GET-only connector above and submits nothing.

**The kill switch blocks NEW admissions only.** It never cancels an order,
closes a position, changes the status of an existing execution or deletes a
capacity record — engaging it mid-flight leaves everything already running
exactly as it is. The effective switch is active when **either** the global
variable or the per-profile `ExecutionSafetyPolicy.killSwitchActive` is active,
and every other limit resolves to the **stricter** of the two.

| Variable | Description | Default |
| --- | --- | --- |
| `EXECUTION_GLOBAL_KILL_SWITCH` | `true` = kill switch **ACTIVE**, every admission rejected. Only the exact string `false` releases it. | `true` |
| `EXECUTION_MAX_OPEN_POSITIONS` | Concurrent open positions per profile. | `1` |
| `EXECUTION_MAX_PENDING_ENTRIES` | Concurrent pending entries per profile. | `1` |
| `EXECUTION_MAX_TOTAL_ACTIVE_TRADES` | Union of open + pending. Must be ≥ both limits above or startup fails. | `1` |
| `EXECUTION_MAX_TOTAL_PLANNED_RISK_USD` | Ceiling on summed reserved risk budgets. Decimal string. | `1.50` |
| `EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD` | Ceiling on summed reserved **maximum** isolated margins. Decimal string. | `5.00` |
| `EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE` | Active executions per symbol **and** side. | `1` |
| `EXECUTION_MAX_ALERT_AGE_SECONDS` | Freshness ceiling, measured from the original signal time. | `300` |
| `EXECUTION_SIGNAL_FUTURE_TOLERANCE_SECONDS` | Tolerance for a signal timestamp slightly ahead of local time (clock skew). | `5` |

Reaching a limit skips **only the requesting execution** — existing
executions, positions and orders are never touched. A `SKIP` is terminal
(`SKIPPED`), but an `UNAVAILABLE` — a connector failure, a rate limit, an
un-inspectable symbol — is **not**: the execution stays `PLAN_READY` and can be
retried with the incremented version. Permanently missing frozen data (no
signal time, no plan snapshot) is a terminal `SKIP` instead, so it is never
retried forever. Full rules, the capacity classification table, the
decision lifecycle and the atomicity model are in
[docs/binance-execution-policy.md](docs/binance-execution-policy.md).

### Backend — AI vision

| Variable | Description | Default |
| --- | --- | --- |
| `AI_VISION_PROVIDER` | `mock` (no API calls) or `openai` (real vision). | `mock` |
| `OPENAI_API_KEY` | Required when `AI_VISION_PROVIDER=openai` (startup fails clearly if missing). Leave blank for mock. | *(empty)* |
| `OPENAI_VISION_MODEL` | Vision-capable chat model. | `gpt-4o-mini` |
| `AI_VISION_TIMEOUT_MS` | Abort the AI request after this many ms. | `30000` |
| `AI_VISION_FALLBACK_TO_MOCK` | If the real AI call fails: `true` returns a mock result; `false` fails the job. | `false` |
| `AI_VISION_MAX_IMAGE_BYTES` | Reject screenshots larger than this before sending to the AI. | `5000000` |

### Backend — duplicate suppression

| Variable | Description | Default |
| --- | --- | --- |
| `DUPLICATE_SUPPRESSION_WINDOW_SECONDS` | Matching alerts within this many seconds are suppressed as duplicates. | `60` |

### Backend — Telegram

| Variable | Description | Default |
| --- | --- | --- |
| `TELEGRAM_NOTIFICATIONS_ENABLED` | Master switch; nothing is sent unless `true`. | `false` |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather (required when enabled). **Secret.** | *(empty)* |
| `TELEGRAM_CHAT_ID` | Target chat id (required when enabled). | *(empty)* |
| `TELEGRAM_SEND_SCREENSHOT` | Send the chart screenshot as a photo (falls back to text on failure). | `true` |
| `TELEGRAM_NOTIFY_ON_FAILED` | Also notify when an alert becomes `FAILED`. | `false` |
| `TELEGRAM_MIN_CONFIDENCE` | Skip notifications below this AI confidence (0..1). `0` = always. | `0` |

### Backend — screenshot / Playwright

| Variable | Description | Default |
| --- | --- | --- |
| `SCREENSHOT_STORAGE_DIR` | Where chart screenshots are written (served at `/screenshots/*`), relative to `apps/backend`. | `src/storage/screenshots` |

(The Playwright browser itself is installed via `pnpm --filter @trading-alert-dashboard/backend playwright:install`; there is no env var for it.)

### Frontend

`apps/frontend/.env` and `apps/frontend/.env.local` are gitignored local config.

| Variable | Description | Default in example |
| --- | --- | --- |
| `VITE_API_URL` | Backend REST base URL. **Leave empty** for same-origin requests through the Vite dev proxy (recommended, and required for Tailscale remote access). Set an absolute URL only to target a separate API host. | *(empty)* |
| `VITE_SOCKET_URL` | Socket.IO URL. **Leave empty** to connect to the current browser origin (via the Vite proxy). | *(empty)* |
| `VITE_DEV_ALLOWED_HOSTS` | Comma-separated extra hostnames the Vite dev server may respond to. Put your private Tailscale hostname here (typically in `apps/frontend/.env.local`). localhost and IPs are always allowed. | *(empty)* |

> `VITE_API_URL`/`VITE_SOCKET_URL` empty = same-origin mode: the browser calls `/api` and `/socket.io`
> on its own origin, which the Vite dev server proxies to the backend. This is what makes private
> remote access work without hardcoding any machine-specific URL. Never commit webhook secrets, API
> keys, Telegram bot tokens, or private hostnames.

### Duplicate suppression

An incoming webhook is treated as a duplicate of an existing alert when **all** of these match:
`symbol`, `assetType`, `timeframe`, `signal`, `indicatorName` — and that alert was created within the
last `DUPLICATE_SUPPRESSION_WINDOW_SECONDS` (default 60). When suppressed, no new alert/screenshot/job
is created; instead the existing alert's `duplicateCount` is incremented, `lastDuplicateAt` is updated,
the webhook responds `202` with `{"status":"IGNORED_DUPLICATE","duplicate":true,...}`, an
`alert_duplicate` Socket.IO event is broadcast, and **no** Telegram notification is sent.

## Testing the Local Webhook

PowerShell aliases `curl` to `Invoke-WebRequest`, which makes JSON bodies awkward, so use the
dependency-free Node script. It reads `WEBHOOK_SECRET` and `BACKEND_PORT` from `apps/backend/.env` and
posts a valid payload:

```powershell
node scripts/test-webhook.js `
  --symbol BTCUSDT `
  --assetType crypto `
  --exchange BINANCE `
  --signal LONG `
  --price 64000 `
  --timeframe 1h
```

Or with defaults: `pnpm test:webhook`. Expected result: HTTP **202** with a body like
`{"id":"...","status":"RECEIVED"}`. The script prints the URL, the sent payload (secret masked), the
status, and the response body.

With the worker running, the alert then progresses `RECEIVED` → `PROCESSING_SCREENSHOT` →
`ANALYZING_WITH_AI` → `ANALYZED` (or `FAILED`), visible live on the dashboard and in the worker logs.

Other scripts in `scripts/` (see [Development Commands](#development-commands)):

- **Batch stress test** — `pnpm test:webhook:batch` fires multiple webhooks with a delay to exercise
  the queue, worker, and realtime updates. Override with flags, e.g.
  `node scripts/test-webhook-batch.js --count 20 --delayMs 250`.
- **Binance connectivity** — `pnpm test:binance` (or `node scripts/test-binance-candles.js --symbol ETHUSDT --interval 4h --limit 20`).
- **Telegram credentials** — `pnpm test:telegram` sends a test message using `apps/backend/.env` (the bot token is never printed in full).

## Private Dashboard Access with Tailscale

For private remote access, Tailscale Serve proxies a private HTTPS hostname to the local Vite dev
server:

```
https://your-device.your-tailnet.ts.net/   ->   http://localhost:5173
```

The Vite dev server is configured (`apps/frontend/vite.config.ts`) to make this work end-to-end:

- **Explicitly allows** the configured Tailscale host(s) via `VITE_DEV_ALLOWED_HOSTS` → `server.allowedHosts` (never `allowedHosts: true`).
- **Proxies `/api`** to the backend at `http://127.0.0.1:4000`.
- **Proxies `/socket.io`** with WebSocket support (`ws: true`).
- **Proxies `/screenshots`** to the backend (so screenshots load remotely).
- The frontend uses **same-origin** API/socket behavior (`VITE_API_URL`/`VITE_SOCKET_URL` empty), so
  the remote browser only ever talks to its own origin — it never needs to reach `localhost:4000`.

Set the private hostname in `apps/frontend/.env.local` (gitignored):

```
VITE_DEV_ALLOWED_HOSTS=your-device.your-tailnet.ts.net
```

Tailscale Serve commands vary slightly by version — confirm with `tailscale serve --help`. Common usage:

```powershell
# Proxy the local frontend port over HTTPS in the background
tailscale serve --bg 5173

# Inspect the current Serve configuration
tailscale serve status

# Clear the Serve configuration
tailscale serve reset
```

Only devices signed in to the same tailnet (and authorized) can reach a Tailscale Serve URL — it is
**not** public. This repo does **not** use Tailscale Funnel.

## Public TradingView Webhook via Cloudflare Tunnel

TradingView cannot reach `localhost`, so to receive **real** TradingView alerts the backend is exposed
temporarily with a Cloudflare quick tunnel:

```powershell
cloudflared tunnel --url http://localhost:4000
```

This prints a public `https://<random>.trycloudflare.com` URL that forwards to the backend on port
4000. Use it as your TradingView webhook base:
`https://<random>.trycloudflare.com/api/webhooks/tradingview`.

Important:

- The quick-tunnel URL **changes every time you restart `cloudflared`**. Update the TradingView alert's
  webhook URL whenever it changes.
- **Cloudflare** is used here for the **public TradingView webhook**; **Tailscale Serve** is used for
  the **private dashboard**. They serve different purposes.
- **Stopping `cloudflared` stops public webhook delivery** — TradingView alerts will not arrive until
  the tunnel is running again with an updated URL.

> **Security warning:** the quick tunnel currently points at the whole backend on port 4000. Do not
> expose more routes than necessary in any permanent setup. A future dedicated webhook gateway or a
> restricted public ingress (only the webhook path) is preferred over exposing the entire backend.

See [`docs/tradingview-live-test.md`](docs/tradingview-live-test.md) for the full live-testing
walkthrough (including prefixed symbols and phone-friendly dashboard links via `PUBLIC_DASHBOARD_URL`).

## TradingView Webhook Payload

`POST /api/webhooks/tradingview`. Schema: `apps/backend/src/modules/webhook/webhook.schema.ts`
(see also [`docs/webhook-payload.md`](docs/webhook-payload.md) and [`docs/tradingview-setup.md`](docs/tradingview-setup.md)).

Required fields:

- `secret` (string) — must equal your `WEBHOOK_SECRET`.
- `symbol` (string) — e.g. `BTCUSDT` or `BINANCE:BTCUSDT` (prefix normalized).
- `assetType` (string) — normalized to `CRYPTO` / `STOCK`.
- `timeframe` (string) — e.g. `1m`, `5m`, `15m`, `1h`, `4h`, `1d`.
- `price` (number, positive).
- `signal` (string) — normalized to `LONG` / `SHORT` / `WATCH` / `EXIT`.
- `triggeredAt` (string) — ISO 8601 timestamp.

Optional fields:

- `indicatorName` (string)
- `indicatorValue` (number)
- `exchange` (string) — e.g. `BINANCE`, `NASDAQ`.
- `note` (string) — free text; the Pine "touch" indicator encodes `eventType`, `levelColor`, `sourceTf`, and `touchDirection` here.

Example (replace `secret` with your own value; do not commit real secrets):

```json
{
  "secret": "your-webhook-secret",
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

## Development Commands

Run from the repo root. Only scripts that actually exist are listed.

| Command | What it does |
| --- | --- |
| `pnpm install` | Install deps; builds `packages/shared` via `postinstall`. |
| `pnpm dev` | Run backend API + frontend dev server together. |
| `pnpm dev:backend` | Backend only (`tsx watch`, `http://localhost:4000`). |
| `pnpm dev:frontend` | Frontend only (Vite, `http://localhost:5173`). |
| `pnpm dev:worker` | Vision-analysis worker (required for alerts to progress past `RECEIVED`). |
| `pnpm build` | Build shared, backend, and frontend. |
| `pnpm db:migrate` | Apply Prisma migrations (`prisma migrate dev`). |
| `pnpm db:seed` | Seed example assets (idempotent upserts). |
| `pnpm test` | Run backend tests (Vitest). |
| `pnpm test:webhook` | Fire a single local webhook (`scripts/test-webhook.js`). |
| `pnpm test:webhook:batch` | Fire a batch of local webhooks (`scripts/test-webhook-batch.js`). |
| `pnpm test:binance` | Check Binance klines connectivity (`scripts/test-binance-candles.js`). |
| `pnpm test:telegram` | Send a Telegram test message (`scripts/test-telegram.js`). |
| `pnpm --filter @trading-alert-dashboard/backend binance:read-only-check [SYMBOL]` | Read-only Binance account/symbol health check (no orders, no account changes). |
| `pnpm --filter @trading-alert-dashboard/backend binance:margin-plan -- <SYMBOL> <LONG\|SHORT> <entry> <stop> [risk]` | Calculation-only dynamic leverage / isolated margin plan (recommends, never applies). |
| `pnpm --filter @trading-alert-dashboard/backend binance:liquidation-check` | Validates the liquidation estimator against Binance-reported values for ISOLATED positions. |
| `pnpm --filter @trading-alert-dashboard/backend playwright:install` | Install the Chromium build used for screenshots. |

## Troubleshooting

### `P2021: The table public.Alert does not exist`

PostgreSQL is reachable but the schema has not been migrated. Run:

```powershell
pnpm db:migrate
```

On a brand-new empty database you can also seed example assets with `pnpm db:seed` (idempotent).

### Port 5173 already in use

Vite runs with `strictPort: true`, so it **exits instead of moving to 5174** — this keeps Tailscale
Serve pointed at the right port. Find and stop whatever holds 5173:

```powershell
Get-NetTCPConnection -LocalPort 5173 -State Listen | Select-Object -ExpandProperty OwningProcess
# then, using that PID:
Stop-Process -Id <PID> -Force
```

### Port 4000 unavailable

Check whether the backend port is reachable / already taken:

```powershell
Test-NetConnection 127.0.0.1 -Port 4000
```

If something else owns it, stop that process (same `Get-NetTCPConnection` approach as above) or change
`BACKEND_PORT`.

### Dashboard works locally but the remote page shows "Disconnected"

The remote browser is trying to reach the API/Socket.IO on its own machine. Fix by using same-origin
mode: leave `VITE_API_URL` and `VITE_SOCKET_URL` **empty** so the browser calls `/api` and `/socket.io`
on the current origin, which the Vite proxy forwards to the backend. Confirm the proxy entries for
`/api`, `/socket.io` (with `ws: true`), and `/screenshots` exist in `apps/frontend/vite.config.ts`,
then restart `pnpm dev`.

### Vite blocked the Tailscale hostname

If Vite responds "This host is not allowed", add the hostname to `VITE_DEV_ALLOWED_HOSTS` (in
`apps/frontend/.env.local`); it feeds `server.allowedHosts`. Restart `pnpm dev`. Do **not** use
`allowedHosts: true`.

### Webhook script returns "fetch failed"

The backend is not reachable on port 4000. Make sure `pnpm dev` (or `pnpm dev:backend`) is running and
check `Test-NetConnection 127.0.0.1 -Port 4000`.

### Worker does not process `RECEIVED` alerts

Alerts stay at `RECEIVED` when the worker isn't consuming the queue. Check that:

- `pnpm dev:worker` is running (it is a separate process from `pnpm dev`).
- Redis is up (`docker compose ps`) and `REDIS_URL` is correct.
- PostgreSQL is up and `DATABASE_URL` is correct (host port **15432**).
- The worker logs show jobs being picked up (look for errors there).

### Cloudflare URL no longer works

Quick-tunnel URLs are temporary. Restart the tunnel and update the TradingView webhook URL:

```powershell
cloudflared tunnel --url http://localhost:4000
```

### Tailscale dashboard does not load

Check, in order:

- Tailscale is connected on both devices (`tailscale status`).
- Serve is configured (`tailscale serve status`).
- The frontend is actually running (`pnpm dev`, port 5173).
- You are using the exact private hostname and it is listed in `VITE_DEV_ALLOWED_HOSTS`.

## Security Notes

- **Never commit `.env` files or secrets.** `apps/backend/.env`, `apps/frontend/.env`, and
  `apps/frontend/.env.local` are gitignored — keep it that way.
- **Rotate any exposed credentials** (webhook secret, OpenAI key, Telegram bot token) if they ever
  leak.
- **Tailscale Serve is private; a Cloudflare quick tunnel is public.** Treat the tunnel URL as an
  open door to whatever it points at.
- **Do not permanently expose the whole backend.** The quick tunnel currently targets all of port
  4000; prefer a restricted webhook-only ingress for anything long-lived.
- **Avoid `allowedHosts: true`** — always list explicit hostnames.
- **Avoid `docker compose down -v`** unless you intentionally want to delete local database/Redis data.
- **Understand AI mock/fallback behavior** before relying on any analysis: in `mock` mode (default) the
  analysis is a placeholder; with `*_FALLBACK_TO_MOCK=true`, a real failure silently degrades to mock.

## Current Development Limitations

- Private remote access currently relies on the **Vite development proxy** (`pnpm dev`). A production
  static build (`vite build`) would need a production reverse proxy or explicit
  `VITE_API_URL`/`VITE_SOCKET_URL` configuration to route `/api`, `/socket.io`, and `/screenshots`.
- The **Cloudflare quick-tunnel URL is temporary** and changes on restart; the TradingView webhook URL
  must be updated each time.
- **AI analysis may run in mock mode** depending on configuration (`AI_VISION_PROVIDER`,
  `AI_VISION_FALLBACK_TO_MOCK`).
- For continuous operation, the host machine and its processes must stay running: **backend, worker,
  Docker (Postgres + Redis)**, and — for remote/public access — **Tailscale** and/or **cloudflared**.

## License

No `LICENSE` file is present and the root `package.json` declares `"private": true` with no `license`
field. This is a personal project; all rights are reserved by the owner by default. Add a license file
if/when you decide to license it.
