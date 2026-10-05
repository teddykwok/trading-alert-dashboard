# Native pre-execution safety

Two safeguards that have to be in place before any future Native execution
canary. **Neither of them enables execution.** Native execution stays
hard-disabled in code (`nativeExecutionEnabled` is `false`, and
`alerts/alert-source.ts` refuses every alert that is not TRADINGVIEW).

1. **Execution data integrity.** A Native alert can only ever become eligible
   for execution once the scanner's final evidence for its source 15m bar is
   clean.
2. **An official non-watch generic backend.** The launcher can start the built
   backend, which has no file watcher.

---

## 1. Native execution data integrity

### Alerts and planning stay immediate

Nothing changes in how a Native alert is produced or planned. The flow is still:

> live observation → durable Alert → Socket.IO → plan PENDING → READY

and each step happens immediately. The integrity rule does not delay delivery,
the dashboard or Native Extreme RR planning.

### Execution eligibility waits for the source bar's final integrity

An alert comes from a live observation on operational 15m bar **B** while that
bar is still forming. Execution eligibility is a separate, later question: what
did the scanner finally record for B?

`evaluateNativeExecutionIntegrity(alert, scannerEvidence)` is defined in
`apps/backend/src/modules/native-integrity/native-execution-integrity.ts`. It
answers that question from durable evidence only:

- **The alert's own provenance.** These rawPayload fields are already written
  for every V2 Native alert: `delivery.lineageId`, `delivery.shadowEventId`,
  `delivery.barStart` / `barTime`, `delivery.levelKey`,
  `profile.profileId` and `profile.engineFingerprint`. The shadow event id is
  re-derived from the bar, signal, level and lineage, so it has to agree with
  them.
- **The scanner's evidence for that symbol:**
  - the fsynced `events.jsonl`, read with the emitter's strict reader;
  - the hash-verified `checkpoint.json`;

  both under
  `%LOCALAPPDATA%\trading-alert-dashboard\scanner\live-shadow-engines\<fingerprint>\USDM_PERPETUAL\<symbol>\15m\`.

It does not use the wall clock. Fifteen minutes having passed proves nothing,
and process memory is not used either. The rule needed no schema change and no
migration.

| Status | Meaning |
| --- | --- |
| `PENDING_BAR_CLOSE` | B has not been committed yet (the checkpoint is still at B). |
| `ELIGIBLE` | B was committed once, live (`SHADOW_LIVE_ONLY`), right after a committed B−1, and the checkpoint agrees. |
| `INELIGIBLE_REQUARANTINED` | B was finally committed `QUARANTINED_CURRENT_BAR` or `REPLAYED_NON_ACTIONABLE`, for example after backpressure, a detach or a reconnect. |
| `INELIGIBLE_GAP` | No committed bar immediately precedes B. |
| `INELIGIBLE_DUPLICATE` | The log repeats an event identity, or B was committed twice. |
| `INELIGIBLE_CHECKPOINT_MISMATCH` | The checkpoint does not verify, sits behind a commit or the alert's own bar, or disagrees with the newest commit's hashes. |
| `INELIGIBLE_STALE_GENERATION` | Any of these differs from the alert: the engine fingerprint, the profile, the checkpoint's lineage or the log's lineage. |
| `UNREADABLE` | The evidence is missing, cannot be read or is ambiguous (see below). |

`UNREADABLE` covers these cases:

- the payload is old or partial;
- there is no log or no checkpoint;
- the observation is not in the log;
- the strict log validation fails;
- the scanner moved past B without any commit record for it.

### Ambiguous bars stay as history but cannot be executed

A blocked alert is never cancelled or deleted, and neither is its Extreme RR
plan. The dashboard and the plan list keep showing what was observed.

The GRIFFAIN case from the DRY soak is an example. The bar was live when it was
observed, and after backpressure it was finally committed
`QUARANTINED_CURRENT_BAR`. Its alerts remain, but their execution integrity is
`INELIGIBLE_REQUARANTINED`.

### Unknown fails closed

`UNREADABLE` is never eligible. Stage 2 delivered six alerts on the 11:45 bar
and then stopped the scanner before that bar closed. Those alerts read
`PENDING_BAR_CLOSE` while the checkpoint is still at 11:45. If a later
warm-start catch-up commits 11:45 without a live commit record, they read
`UNREADABLE`.

### Where it shows

`GET /api/extreme-rr/native-plans` adds `executionIntegrity` (status, reason and
bar open time) to each Native item. This is read only and changes no row.

Trading Control shows one line per Native plan: **Execution data integrity:
PENDING BAR CLOSE / ELIGIBLE / BLOCKED — RE-QUARANTINED / … / UNREADABLE**.
Even ELIGIBLE says *Data integrity only: Native execution remains disabled.*
There is no new button. The card stays **PLANNING ONLY** and **NATIVE
EXECUTION DISABLED**.

TradingView alerts are never judged by this rule, and the evaluator refuses to
run for them.

### For a future executor

`judgeNativeExecutionAdmission({ nativeExecutionEnabled, integrity })` is the
check a future Native executor must make immediately before its first
irreversible exchange mutation. That means before any canary, signed or private
call, margin change or order, and after every normal admission check.

It requires two things:

- the execution switch is on;
- integrity is `ELIGIBLE`.

The switch is checked first, so integrity can only add a refusal. **Nothing
calls this check today.** The current executor still refuses Native at its
first line, before canary, signed, margin or order code.

---

## 2. Official NON-WATCH generic backend

### Watch versus non-watch

| | Watch (Start SAFE, `pnpm dev`) | Non-watch (launcher menu 14) |
| --- | --- | --- |
| Command | `tsx watch src/server.ts` | `node <repo>\apps\backend\dist\src\server.js` (what the `start` script runs) |
| Restarts on a file change | **yes**: a watched-file event relaunches the child even without a crash | no |
| Restarts on a crash | no | **no**: it stays down, and the status line shows it |
| Needs a build | no | **yes** |
| Status line | `RUNNING — WATCH` | `RUNNING — NON-WATCH` |

The non-watch path is meant for future live and canary operation, where a
silent backend relaunch must not happen.

### Build prerequisite

The launcher never builds. It never runs `pnpm install` or `prisma generate`
either. Before starting, run:

```
pnpm --filter @trading-alert-dashboard/shared build && pnpm --filter @trading-alert-dashboard/backend build
```

Run `prisma generate` yourself if the schema changed.

Menu **14** refuses to start, and prints that build command, if either of these
is true:

- any `apps/backend/src` or `packages/shared/src` TypeScript file has no compiled
  `.js`;
- a source file is newer than its compiled output.

### How to start and stop it

Open `Trading Runtime Launcher.cmd`:

- **14. Start Generic Backend — Non-Watch.** It starts exactly one built backend
  from `generic.env`, under the machine-wide mutation lock, and records it in
  its own state file (`runtime-launcher-state.json.generic-backend-nonwatch.json`).
  It only starts when :4000 is provably free:
  - if a launcher-owned non-watch backend is already running, it reports that;
  - if a watch backend holds :4000, whether Start SAFE's or anyone else's, it
    refuses and tells you to stop that first;
  - if :4000 has any other holder, or a holder it cannot prove, it refuses.
- **15. Stop Generic Backend — Non-Watch.** It stops only the backend this
  launcher started, after proving ownership: the recorded root, its creation
  time and this repository. A reused PID, or a backend started by hand, is
  never terminated.

The launcher works out who holds :4000 from process ancestry, back to the
proved root. A `node.exe` with a matching command line is not enough to count
as owned.

### No auto-restart

Nothing supervises the non-watch backend. If it crashes, the status line reads
`OFF` with an "EXITED … not restarted" notice and points to its log at
`%LOCALAPPDATA%\trading-alert-dashboard\logs\generic-backend-nonwatch.log`. Any
service supervision will be a separate, reviewed change.

### Start SAFE and the six roles are unchanged

Start SAFE still starts the watch backend as one of its six roles. Stop Runtime
never touches the non-watch backend. While a non-watch backend holds :4000,
Start SAFE sees an external generic backend and refuses, as it does today for
any backend it does not own. Account A and B semantics and the TradingView
runtime are unchanged.

### The dashboard UI is separate

The launcher does not manage the Vite dev server, and stopping the non-watch
backend never touches it.

The root `pnpm dev` couples the watch backend and the UI under
`concurrently -k`, so stopping one kills both. Do not use it alongside the
non-watch backend. Instead, run the UI on its own with
`pnpm --filter @trading-alert-dashboard/frontend dev` and start the backend
from menu 14.
