# Local runtime launcher

Double-click **`Trading Runtime Launcher.cmd`** in the repository root.

It opens a terminal menu for starting and stopping the local dashboard runtime.
It runs on this machine only — the internet-facing backend has no equivalent
endpoint and cannot start processes or edit configuration.

## The two modes

**SAFE** — the runtime cannot arm trading. The three execution gates are shut,
so even an authenticated operator cannot arm from Trading Control. This is the
normal mode.

**LIVE-READY** — the runtime *may* be armed later from the authenticated
Trading Control page. It requires typing `ENABLE LIVE RUNTIME` to select.

> **LIVE-READY does NOT arm trading.**
>
> It only loads the process prerequisites that let Trading Control arm. It
> creates no authorization window, places no order, sends no webhook and makes
> no Binance call. Arming stays a separate, confirmed action on the dashboard.

**Stop Runtime & Return SAFE** — shuts down the local backend, worker and
frontend, then restores the deployment gates to SAFE. This is the normal
end-of-session action.

## What it will not do

- It is **not** a substitute for Trading Control's *Safe Off*. It refuses to
  stop the runtime while executions are active, while manual intervention is
  outstanding, or when it cannot determine either — the worker is what protects
  and reconciles open positions.
- It writes only the three non-secret execution gate values to `.env`.
  Credentials, risk limits, capacity, symbols and strategy are never touched.
  The take-profit modality below is pinned into the started processes rather
  than written to any file.
- It terminates only processes it started and can still positively identify as
  belonging to this repository.

## Take-profit modality

Every start asks one further question. Take profits are placed as conditional
`TAKE_PROFIT_MARKET` orders unless you type `ENABLE LIMIT TAKE PROFIT`, which
places them as resting LIMIT orders for that runtime instead. Pressing Enter
leaves it off.

The choice belongs to **one runtime**. It is pinned into the environment of the
processes the launcher starts, recorded in the launcher state so a supervised
worker restart reproduces the runtime it replaces, and never written to `.env` —
so the next start asks again, and no stale file value can contradict what is
running.

It is pinned explicitly either way. An `EXECUTION_STANDARD_LIMIT_TAKE_PROFIT_ENABLED`
exported in the shell you launch from therefore cannot decide it: `dotenv` does
not overwrite a variable that is already present, so without an explicit pin an
ambient value would silently outrank both `.env` and your intent.

Enabling it affects **new** executions only. An execution that already has a
take profit keeps the modality its own lineage started with, so flipping this
never changes a trade already in flight.

To confirm what a running stack is actually using, read either:

- the launcher's own `Standard LIMIT take profit: ENABLED|DISABLED` line, printed
  at start with the same value handed to the processes; or
- `startupConfiguration.standardLimitTakeProfitEnabled` on
  `GET /api/operator/trading-control/status`.

Both are read-only and startup-scoped: the environment is parsed once per
process, so changing what a runtime does means starting one with a different
answer.

## After switching to LIVE-READY

Open Trading Control, press **Check Readiness**, and arm there if you intend to
trade.
