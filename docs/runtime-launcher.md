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
- It changes only the three non-secret execution gate values. Credentials, risk
  limits, capacity, symbols and strategy are never touched.
- It terminates only processes it started and can still positively identify as
  belonging to this repository.

## After switching to LIVE-READY

Open Trading Control, press **Check Readiness**, and arm there if you intend to
trade.
