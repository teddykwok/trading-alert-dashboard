# Native planner worker

The Native planner worker generates the frozen Extreme RR plan (50/100/200/300
candles) for each newly delivered Native alert. It is **planning only**: it
sends no Telegram, takes no screenshot, runs no AI vision, creates no adoption,
no execution and no order, and makes no signed Binance request. Native execution
stays hard-disabled (`nativeExecutionEnabled = false`).

## What it is

| | |
| --- | --- |
| Role | `native-planner`, a separate **generic** process |
| Entrypoint | `apps/backend/src/modules/native-planning/native-plan.worker.ts` |
| Script | `pnpm --filter @trading-alert-dashboard/backend native-alerts:plan-worker` (plain `tsx`, no file watcher) |
| Queue | `native-extreme-rr-plan` (dedicated; the TradingView `extreme-rr-plan` and `vision-analysis` queues are untouched) |
| Environment | `generic.env` only |
| Heartbeat | Redis key `native-planner:heartbeat` (every 15 s, expires after 60 s) |
| Health | `GET /api/native-planner/status` on the generic backend (read-only) |

It is **not** the generic backend, **not** the TradingView analysis worker and
**not** an account worker.

## It is not part of `pnpm dev`

`pnpm dev` starts the backend and frontend only, exactly as before. Your local
dev stack may point at the persistent database, so the planner never starts
implicitly. Start it on purpose:

- **by hand:** `pnpm --filter @trading-alert-dashboard/backend native-alerts:plan-worker`
  (with `DOTENV_CONFIG_PATH` pointing at `generic.env`), or
- **supervised:** from the runtime launcher (`Trading Runtime Launcher.cmd`):
  - `11. Start Native Planner`: starts exactly one planner from `generic.env`.
  - `12. Supervise Native Planner`: restarts it if it exits.
  - `13. Stop Native Planner`: stops only a planner the launcher started.

The launcher treats it as an **optional** role:

- **Start SAFE:** never starts it, and topology verification never requires it.
- **Isolation:** a planner problem can never block or roll back the TradingView
  runtime.
- **Ownership record:** kept in its own state file,
  `%LOCALAPPDATA%\trading-alert-dashboard\runtime-launcher-state.json.native-planner.json`,
  next to the six-role file. Start SAFE, its rollback and Stop Runtime never
  touch it.

## Environment

The planner needs only generic settings:

- `DATABASE_URL`, `REDIS_URL`
- `EXTREME_RR_LOOKBACK_CANDLES` (optional, default 300). This is the plan's
  initial **global** selection, the same deployment default the TradingView
  planner uses. It is not an account preference.

It needs **no** Account A or Account B key, no Binance API key or secret, and no
execution credential. The launcher strips every account identity variable from
the child environment.

`NATIVE_PLAN_DEFAULT_LOOKBACK_A` and `NATIVE_PLAN_DEFAULT_LOOKBACK_B` are
optional display-only preferences read by the generic backend, not by the
worker. When absent they stay `UNSET`; leave them unset unless an operator has
decided on a value.

## Supervision and restart

- **Exactly one consumer.** A start, or a supervised restart, is refused while
  any Native planner is already running, whether the launcher started it or
  someone did by hand.
- **Restart policy.** It uses the same reviewed ladder as the generic analysis
  worker:
  - stabilization window, backoff and restart budget;
  - an owned tree with no runtime inside it is terminated first, then replaced
    once;
  - an exhausted budget stops automatic recovery and says so.
- **Crashes.** A crash is written (redacted) to stderr and the process exits
  non-zero, so supervision sees it.
- **Graceful shutdown (SIGINT/SIGTERM).** In this order:
  1. stop sweeping;
  2. close the BullMQ consumer (it finishes its in-flight job);
  3. withdraw the heartbeat;
  4. close the queue and the Redis connection;
  5. disconnect the database.

  A second signal waits for the first shutdown. On Windows the launcher
  terminates the process tree by PID after proving ownership; that is a hard
  stop, and recovery (below) covers it.

## Recovery semantics (unchanged by supervision)

- **Startup sweep.** Runs when the worker starts, then every 60 s. It
  re-enqueues only **PENDING** Native plans older than 60 s whose job is
  missing.
- **Retries are bounded.** 2 attempts per job; an ERROR plan is never swept
  again.
- **READY is frozen.** A READY (or INVALID) plan is never regenerated, even if
  its job is replayed after a restart.
- **One plan per alert.**
- **No backfill.** Old Native alerts without a PENDING intent are never
  planned.

## Health

`GET /api/native-planner/status` is read-only and exposes no PID, path, host,
secret or account. It returns:

- `worker.state`:
  - `RUNNING`: fresh heartbeat, consumer running.
  - `STALE`: old heartbeat, or consumer not running.
  - `OFF`: no heartbeat.
  - `UNREADABLE`: the heartbeat value could not be parsed.
- `worker.startedAt`, `worker.lastHeartbeatAt`, `worker.ageSeconds`, and
  `worker.lastSweep` (the startup or periodic sweep counts).
- `connectedConsumers` (BullMQ) and `jobs` (waiting, active, delayed, failed,
  completed counts).
- `pendingNativePlans` (database).
- `readiness`:
  - `READY`: everything agrees the worker is healthy.
  - `DEGRADED`: some evidence is missing or contradicts the rest.
  - `DOWN`: no heartbeat and no consumer.

Trading Control's Native plans card shows the same information as a single
"Planner worker" line. The backend being healthy does **not** imply the planner
is running.

## Logs

- **Started by the launcher:**
  `%LOCALAPPDATA%\trading-alert-dashboard\logs\native-planner.log` (the
  launcher's per-role log directory).
- **What the log records:** the role and queue, the startup recovery sweep
  (always, even when it found nothing), each job outcome, and the shutdown.
