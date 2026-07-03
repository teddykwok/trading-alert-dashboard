# Architecture

## Goals

- The webhook endpoint must respond in milliseconds. TradingView expects a fast response and
  will not wait around for chart rendering or an AI call.
- Screenshot generation and AI Vision analysis are slow and potentially flaky (headless browser,
  external API calls) — they must not run inside the HTTP request lifecycle.
- The dashboard should feel live: every status transition should show up in the browser without
  a manual refresh.

## Components

| Component | Responsibility |
| --- | --- |
| `apps/backend` Fastify server | Validates/authenticates webhooks, exposes REST APIs, hosts the Socket.IO server |
| `apps/backend` worker process | Consumes BullMQ jobs, runs the screenshot + AI pipeline |
| PostgreSQL (Prisma) | Source of truth for `Asset`, `Alert`, `Setting` |
| Redis | Backs BullMQ (job queue) and the Socket.IO Redis adapter/emitter |
| `apps/frontend` | React dashboard, subscribes to REST + Socket.IO |

## Request lifecycle

1. `POST /api/webhooks/tradingview` — Fastify route (`src/routes/webhook.routes.ts`) delegates to
   `webhook.service.ts`.
2. `webhook.service.ts`:
   - Validates payload shape with `webhook.schema.ts` (Zod).
   - Verifies `secret` against `WEBHOOK_SECRET` with a constant-time comparison
     (`webhook.security.ts`).
   - Normalizes `assetType`/`signal` to the strict enums.
   - Upserts the `Asset` row (unique on `symbol` + `assetType`).
   - Creates the `Alert` row with `status = RECEIVED` (secret stripped from the stored payload).
   - Emits `new_alert` over Socket.IO (via a Redis-backed emitter, so it works even though the
     worker is a separate process).
   - Enqueues a `vision-analysis` BullMQ job containing just `{ alertId }`.
   - Returns `202 { id, status }`.
3. The worker process (`vision-analysis.worker.ts`) picks the job up independently and runs the
   rest of the pipeline (see `docs/webhook-payload.md` for the full step list), emitting
   `alert_updated` after each status transition and `alert_failed` on error.

## Why a Redis-backed Socket.IO emitter?

The Fastify server and the BullMQ worker are two separate Node processes (`pnpm dev` vs.
`pnpm dev:worker`). Only the Fastify process holds live WebSocket connections to browsers. The
worker can't call `io.emit()` directly because it doesn't have an `io` instance. Instead:

- The Fastify server attaches a Socket.IO server with a **Redis adapter**
  (`@socket.io/redis-adapter`, see `src/plugins/socket.ts`).
- Both the server and the worker publish domain events through a **Redis emitter**
  (`@socket.io/redis-emitter`, see `src/modules/notifications/socket-events.ts`), which is just a
  thin wrapper that publishes to the same Redis pub/sub channel the adapter listens on.
- This decouples "who emits an event" from "who holds the socket connections."

## Failure handling

- Each pipeline step updates `Alert.status` before doing the risky work, so the dashboard shows
  progress even if a later step fails.
- Any thrown error inside the worker's job handler is caught, the alert is marked `FAILED` with
  `errorMessage`, `alert_failed` is emitted, and the error is re-thrown so BullMQ's retry/backoff
  policy (2 attempts, exponential backoff) can kick in.
- `cleanup.worker.ts` runs on an interval inside the worker process and sweeps alerts stuck in an
  intermediate status for too long (e.g. the worker process crashed mid-job), marking them
  `FAILED` so they don't appear to hang forever.
