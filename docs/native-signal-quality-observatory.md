# Native signal-quality observatory (Milestone 6.5)

`NATIVE_SIGNAL_QUALITY_OBSERVATORY_V1` lets an operator inspect every Native
(scanner-produced, `TEDDY_7_ALL_ACTIVE_V1`) alert: was it generated with
consistent evidence, and what did price do after it?

It is **observability only**:

- It changes no strategy rule, threshold, qualification, arming, cooldown,
  touch, direction or planner logic.
- It writes no database row.
- It holds no credential.
- It calls only **public, unsigned** Binance market-data endpoints.
- It adds no execution path, route that mutates, UI control that can trade or
  arm, runtime role, environment key or migration.

Native execution stays hard OFF (`NATIVE_EXECUTION_ENABLED = false as const`).
Native risk for Account A and Account B stays `UNRESOLVED`. Every API response
carries `authority: "NONE"`, `nativeExecutionEnabled: false` and
`monitoringOnly: true`. The page shows a permanent banner:

> **SIGNAL QUALITY OBSERVATORY · MONITORING ONLY · NO EXECUTION AUTHORITY**

---

## 1. The data flow it observes (audited, unchanged)

```
public Binance USD-M klines (websocket + REST)
  → scanner:live-shadow-supervisor   (TEDDY_7_ALL_ACTIVE_V1, dynamic universe, FAST_RECOVERY_V1)
      per-symbol events.jsonl + hash-verified checkpoints under %LOCALAPPDATA%\trading-alert-dashboard\scanner
  → native-alerts:multi-emitter --commit-dashboard-alerts   (NATIVE_DELIVERY_V2, one alert per symbol/bar/source TF, 2 s poll)
      Alert row (source NATIVE) + NativeAlertDelivery ledger row (deliveryKey unique) + Socket.IO new_alert
  → native-alerts:plan-worker        (dedicated native-extreme-rr-plan queue)
      ExtremeRRPlan READY (frozen candidates; selectedLookback, e.g. 100)
  → generic backend (:4000) read-only APIs
  → frontend (:5173)
```

The observatory sits at the end of this chain. It reads, read-only:

- `Alert`: `price` (the level price), `levelColor`, `sourceTimeframe`,
  `touchDirection`, `signal`, `triggeredAt` (exchange event time of the touch),
  `createdAt` (persistence, that is, delivery) and `duplicateCount`;
- the durable V2 payload: `delivery.barStart`, `deliveryKey`, `levelKey`,
  `shadowEventId`, `evidenceClass`/`evidenceBasis`, `candidateSequence`,
  `profile.runId`;
- `ExtremeRRPlan`: the frozen selected candidate;
- the scanner evidence, for execution integrity, rebuilt read-only by the
  canonical evaluator;
- the scanner's and emitter's own `status.json` files;
- public klines.

FAST_RECOVERY never creates alerts: bars replayed after a gap are committed
`REPLAYED_NON_ACTIONABLE`, and delivery takes only live observations. A
pre-soak signal can appear during a soak only through **emitter backlog**,
when a restarted emitter resumes from an older cursor. That is detectable as
a large gap between `triggeredAt` and `createdAt`.

## 2. Three questions, never one score

| Question | What answers it |
| --- | --- |
| **Engine quality**: was the alert generated with internally consistent evidence? | Payload provenance, operational `barStart`, M5 freshness at delivery, execution integrity, evidence class, diagnostic flags. |
| **Signal quality**: after `triggeredAt`, did price move in the alert's direction? | MFE, MAE and signed return at 15m, 1h, 4h, 12h and 24h. |
| **Plan quality**: given the existing selected plan, did TP or SL resolve first? | TP_FIRST / SL_FIRST / … and realized R from the plan's own geometry. |

V1 has **no composite score**, and it never concludes "profitable".

## 3. Metric definitions

**Reference price.** The canonical Native level price (`Alert.price`, the
level the touch hit). It is labelled `CANONICAL_LEVEL_PRICE`, or
`UNAVAILABLE` when absent; then no metric is fabricated. A current market
price is never substituted.

**Evaluation clock.**

- The outcome starts at **S**, the first full minute at or after `triggeredAt`
  (S equals `triggeredAt` when it falls exactly on a minute).
- The minute containing the trigger also holds prices from before the trigger,
  so it never enters an excursion or a return. Up to 59.999 s after the trigger
  are therefore unobserved.
- A minute counts only once **closed by the evaluation instant `asOf`**. Nothing
  after `asOf` is used.
- `asOf` defaults to now (rounded down to 15 s) and may be set earlier for a
  point-in-time view. It is never in the future.

**MFE / MAE / return**, in percent of the reference, over the observed
minutes of the horizon:

| | LONG | SHORT |
| --- | --- | --- |
| MFE (favourable) | (max high − ref) / ref | (ref − min low) / ref |
| MAE (adverse) | (ref − min low) / ref | (max high − ref) / ref |
| Return | (last close − ref) / ref | (ref − last close) / ref |

MFE can be negative when price never revisited the reference in the
favourable direction; it is reported as is. LONG and SHORT are exact mirrors,
and a test proves it.

**Horizons** are 15m, 1h, 4h, 12h and 24h, each the window [S, S + H):

| State | Meaning | In aggregates? |
| --- | --- | --- |
| `MATURED` | every minute of the horizon observed | **yes** |
| `PARTIAL` | started, not finished at `asOf` (values shown with `*`, so far) | no, censored |
| `PENDING` | not one full minute has closed | no, censored |
| `DATA_GAP` | the horizon elapsed but minutes are missing | no |
| `DATA_UNAVAILABLE` | market data not loaded yet, or the provider failed | no |

An incomplete horizon is **never** a zero, a win or a loss.

## 4. Plan resolution (the existing selected plan, never recalculated)

The plan is `selectedPlanSummaryOf` over the persisted plan row: its selected
lookback, entry, stop and TP. The observatory never builds a "better" plan.

- Walk the closed minutes from S, inside a **24-hour plan window**. For a LONG,
  TP is touched when high ≥ TP and SL when low ≤ SL (mirrored for a SHORT).
  Touches are inclusive.
- The first minute that touches exactly one level decides: `TP_FIRST` or
  `SL_FIRST`.
- A minute that touches **both** is `AMBIGUOUS_SAME_BAR`, and the order is
  never guessed.
- If the trigger minute already touched TP or SL, the order is unknowable:
  that minute holds prices from before the trigger. The result is
  `AMBIGUOUS_SAME_BAR` too.
- A missing minute before any resolution is `DATA_GAP`.
- If neither level is touched in the full 24 hours, the result is `NEITHER`.
- If the window is still running, the result is `PENDING`.
- No plan, no selected candidate, or a malformed or zero-risk geometry gives
  `PLAN_UNAVAILABLE`. Malformed plans are flagged `PLAN_MALFORMED`.
- No market data gives `DATA_UNAVAILABLE`.

**R.**

- `TP_FIRST` earns the plan's own reward:risk, `|TP − entry| / |entry − SL|`.
- `SL_FIRST` is −1R.
- Every other outcome has **no realized R**.
- V1 shows no mark-to-market R.

Entry is taken as the alert itself, the level touch. Fills, fees and slippage
are not modelled.

## 5. Aggregates, censoring and denominators

Every rate is shown as `numerator / denominator`, and every statistic with
its sample size `n`. A zero denominator is "—", never NaN or Infinity.

- **Horizon statistics** (MFE, MAE and return: mean and median, plus the
  directional rate) use `MATURED` horizons only. The other states are counted
  next to them.
- **TP before SL** is `TP_FIRST / (TP_FIRST + SL_FIRST)`, for example
  "7 / 19 resolved non-ambiguous plans · 36.8%". Ambiguous, neither, pending,
  gap, unavailable and missing plans are excluded and counted.
- **Average, median and expectancy R** are over resolved plans only.
  Expectancy is the mean realized R per resolved plan.
- **Profit factor** is the sum of winning R over the absolute sum of losing R.
  It is shown as "—" with a reason (`NO_RESOLVED_PLANS`, `NO_LOSSES`) when not
  meaningful.
- **Breakdowns** by source timeframe, side, level colour, timeframe class
  (1D/1W execution-policy versus 1M dashboard-only), integrity and evidence
  class.
- **Alert rate**: alerts and symbols per hour, the busiest rolling 15 minutes,
  and repeated symbols, sides and levels. This is observation only; nothing is
  throttled.

## 6. Diagnostic flags

| Flag | Category | When |
| --- | --- | --- |
| `SUSPICIOUS_DUPLICATE` | DEFECT | the same `deliveryKey` or `shadowEventId` on two alerts, or a non-zero `duplicateCount` |
| `MALFORMED_PAYLOAD` / `MISSING_BAR_START` | DEFECT | the payload is not a V2 Native payload, or has no operational bar start |
| `FUTURE_TIMESTAMP` | DEFECT | `triggeredAt` is later than the persistence instant or than `asOf` |
| `FRESHNESS_EVIDENCE_INVALID` | DEFECT | M5 cannot establish freshness |
| `PLAN_MALFORMED` | DEFECT | malformed stored candidates, or the plan direction disagrees with the alert |
| `INTEGRITY_NOT_ELIGIBLE` | WARNING | the integrity verdict is not ELIGIBLE (the status is in the detail) |
| `STALE_AT_DELIVERY` | WARNING | persisted after the M5 expiry |
| `DELAYED_DELIVERY` | WARNING | persisted more than 60 s after the trigger (backlog or recovery) |
| `TRIGGERED_BEFORE_SOAK` | WARNING | triggered before the soak window, observed during it |
| `SYMBOL_SIDE_BURST` | WARNING | 3 or more alerts on one symbol and side within 60 minutes |
| `PLAN_UNAVAILABLE` | WARNING | no usable selected plan |
| `EXPECTED_REPEAT` | INFO | an earlier alert on the same symbol and side with a different identity: Teddy legitimately re-arms after cooldown |
| `SAME_LEVEL_REPEAT` | INFO | an earlier alert on the same level |

Repeats are information, not bugs. Only a repeated **canonical identity** is
suspicious. Integrity is judged for at most 300 alerts per evaluation, and
the rest read `NOT_JUDGED` (never assumed ELIGIBLE).

## 7. Soak window and recovery

`soakStart` / `soakEnd` (UTC, at most 72 h apart) define the window. Each
alert is:

- `TRIGGERED_DURING_SOAK`: `triggeredAt` is in [soakStart, soakEnd);
- `OBSERVED_DURING_SOAK_TRIGGERED_BEFORE_START`: triggered before soakStart
  but persisted during the soak, which is emitter backlog or recovery evidence.
  These are shown separately and never counted as new real-time soak alerts;
- `OUTSIDE_SOAK`.

The **scope** filter restricts every summary, table and export to one of these.

## 8. Public market data: precision and bounds

- **Precision:** Binance USD-M public **1-minute OHLC** for outcomes, labelled
  `BINANCE_USDM_PUBLIC_1M_OHLC`, and public 15-minute klines for the chart.
  This is never tick-level, and ambiguity is preferred to guessing; V1 makes no
  aggTrades requests.
- **Unsigned, allowlisted:**
  - every URL is built by the scanner's `buildPublicFuturesUrl`, so the host is
    `fapi.binance.com` and the path `/fapi/v1/klines`;
  - no key, signature, account or order endpoint can be expressed;
  - responses are parsed strictly.
- **Bounded, because the IP weight (2400/min) is shared with the scanner:**
  - a 240-weight-per-minute token bucket and at most 2 requests in flight;
  - a pause until the next minute when Binance reports the IP's used weight at
    1200 or more;
  - a pause on 429/418, for `Retry-After` or one minute;
  - one cached minute series per **symbol**, so many alerts share it and a
    refresh fetches only the new tail;
  - an LRU memory cap of 1.5 M cached minutes;
  - a failed symbol is not retried for 60 s;
  - an 8 s deadline per evaluation.
- What is not loaded yet reads `NOT_LOADED` ("refresh to continue"), and a
  provider failure reads `UNAVAILABLE`. A Binance outage degrades observability
  only.

## 9. API (all GET, read-only)

| Route | What |
| --- | --- |
| `GET /api/signal-quality/summary` | counts, horizons, plans, breakdowns, alert rate for the window and filters |
| `GET /api/signal-quality/signals` | one page (≤ 100) of evaluated rows, deterministic sort |
| `GET /api/signal-quality/signals/:alertId` | one alert: canonical evidence, M5 window, plan, outcome, flags |
| `GET /api/signal-quality/signals/:alertId/chart` | 15m bars around the alert, never past `asOf` |
| `GET /api/signal-quality/export?format=csv\|json` | the filtered rows (≤ 2000), as a download |
| `GET /api/signal-quality/soak-health` | scanner, emitter, universe, alert and plan health from existing status files and counts |

**Query keys:** `soakStart`, `soakEnd`, `scope`, `asOf`, `symbol`,
`sourceTimeframe`, `direction`, `levelColor`, `timeframeClass`, `integrity`,
`freshness`, `planOutcome`, `horizon` + `horizonState`, `flag`, `sort`,
`offset` and `pageSize`. Unknown keys and bad values are refused (422).

**Bounds:**

- one evaluation covers at most 2000 alerts, and says when the window held
  more;
- one evaluated set is shared for 15 s by summary, page and export;
- rows are built in chunks that yield to the event loop.

Measured at the bound:

- 2000 alerts × 24 h of minutes evaluate in about 0.35 s of CPU (chunked);
- a 100-row page is about 290 KB; the summary is about 9 KB.

## 10. Frontend

`/signal-quality` (sidebar: **Signal Quality**):

- the banner;
- soak window, scope, `asOf`, refresh, read-only 60 s auto-refresh, and
  CSV/JSON export links;
- monitoring health;
- summary;
- signal and plan quality with denominators;
- breakdowns and alert rate;
- the filterable, paginated table (one page in the DOM).

Each row expands to a detail with the full evidence and a chart: candles, the
SIGNAL marker, horizon markers, and the level, entry, stop and TP lines. The
chart says that candles after the SIGNAL marker were not known when the alert
triggered.

The page has no trade, arm, LIVE_READY or enable control, and its only
requests are GETs.

---

## 11. 24-hour monitoring soak runbook

The soak runs **after** this feature is reviewed and merged, on the operator's
machine, with the existing monitoring-only roles. **Account A and Account B
stay OFF the whole time.** Nothing below starts an account, an execution
worker or a private Binance call.

### A. Precheck (all read-only)

```powershell
cd C:\Projects\trading-alert-dashboard
git fetch origin; git rev-parse HEAD; git rev-parse origin/main   # must be equal: the merged main
git status --short                                                # must be empty
Select-String -Path apps\backend\src\modules\native-canary\native-execution-switch.ts -Pattern "NATIVE_EXECUTION_ENABLED = false as const"
docker compose ps                                                 # Postgres (15432) and Redis (6379) running
Get-NetTCPConnection -State Listen -LocalPort 4001,4002 -ErrorAction SilentlyContinue   # must print NOTHING (A/B control OFF)
```

- In **Trading Runtime Launcher.cmd**, choose **1. Show Status**. Account A
  Control, Account A Execution Worker, Account B Control and Account B
  Execution Worker must all be OFF, and both accounts' attestations SAFE. Do
  **not** choose 2 (Start SAFE): it starts the account roles.
- The account env files (`%LOCALAPPDATA%\trading-alert-dashboard\env\account-a.env`
  and `account-b.env`) must still say kill switch true, live entry false and
  protection false. Check them by eye; never paste them anywhere.
- After pulling the merge, rebuild once while nothing runs:

  ```powershell
  pnpm install; pnpm build
  ```

  The launcher's non-watch backend refuses a stale build, and `package.json`
  gained one script. If pnpm 11 tries to re-verify dependencies while a backend
  runs, set `$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN="false"` for the session.

### B. Start (monitoring-only)

> **Preferred since Always-On Monitoring V1:** start the whole monitoring stack
> with launcher **16** (or `Always-On Monitoring.cmd`), and steps 1–5 below are
> done and supervised for you. That covers the scanner, the emitter pinned to
> its run, the planner and the non-watch backend, with network-outage recovery
> and bounded emitter catch-up. See
> [always-on-monitoring.md](always-on-monitoring.md). The manual steps remain
> valid when Always-On is not running. Never run both: Always-On reports manual
> roles as CONFLICT and never touches them.

1. **Scanner** (own terminal; Ctrl+C to stop):

   ```powershell
   pnpm --filter @trading-alert-dashboard/backend scanner:live-shadow-supervisor --profile teddy-7-all-active
   ```

   (pnpm 11 passes arguments straight through; do not insert a bare `--`, which the strict CLI parsers refuse.)
   Wait for readiness in its status output. Then read the run identity
   (read-only):

   ```powershell
   $s = Get-Content "$env:LOCALAPPDATA\trading-alert-dashboard\scanner\live-shadow-supervisor\status.json" -Raw | ConvertFrom-Json
   $s.runId; $s.engineFingerprint; $s.runState
   ```

2. **Emitter: dry run first** (writes nothing):

   ```powershell
   pnpm --filter @trading-alert-dashboard/backend native-alerts:multi-emitter --profile teddy-7-all-active --run-id $s.runId --expect-engine-fingerprint $s.engineFingerprint
   ```

   If it reports a large stale backlog (would-create from days ago), **stop
   here**. Follow [native-emitter-cursor-rebaseline.md](native-emitter-cursor-rebaseline.md),
   which is an operator decision. Since Always-On Monitoring V1 the emitter
   drains a backlog larger than its queue in bounded rounds instead of
   overflowing. A stale backlog is therefore no longer stopped by the queue:
   this dry-run check is what stops it.

3. **Emitter: COMMIT** (own terminal; Ctrl+C to stop):

   ```powershell
   pnpm --filter @trading-alert-dashboard/backend native-alerts:multi-emitter --profile teddy-7-all-active --run-id $s.runId --expect-engine-fingerprint $s.engineFingerprint --commit-dashboard-alerts --follow
   ```

   Add `--activate-at-eof` only if lanes have never been activated.

4. **Native planner**, for selected-plan visibility: launcher **11. Start
   Native Planner**, then **12. Supervise Native Planner**.

5. **Generic backend**: launcher **14. Start Generic Backend — Non-Watch**.

6. **Frontend** (own terminal):

   ```powershell
   pnpm --filter @trading-alert-dashboard/frontend dev
   ```

7. **Soak monitor** (own terminal; it exits by itself at the end). Write the
   start instant down first:

   ```powershell
   $start = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
   pnpm --filter @trading-alert-dashboard/backend signal-quality:soak-monitor --out "$env:LOCALAPPDATA\trading-alert-dashboard\soak" --soak-start $start --soak-hours 24 --every-minutes 15
   ```

   Every 15 minutes it writes a snapshot of these read-only GETs, under
   `%LOCALAPPDATA%\trading-alert-dashboard\soak\soak-<start>\`, plus
   `report.json`:
   - `/health`
   - `/api/signal-sources/status`
   - `/api/native-planner/status`
   - `/api/signal-quality/soak-health`
   - the soak summary

### C. Verify after start

```powershell
Invoke-RestMethod http://127.0.0.1:4000/health
Invoke-RestMethod http://127.0.0.1:4000/api/signal-sources/status          # native.state RUNNING
Invoke-RestMethod http://127.0.0.1:4000/api/native-planner/status          # readiness READY
Invoke-RestMethod http://127.0.0.1:4000/api/signal-quality/soak-health     # scanner RUNNING, emitter RUNNING, universe counts
Get-NetTCPConnection -State Listen -LocalPort 4001,4002 -ErrorAction SilentlyContinue   # still NOTHING
```

Open `http://127.0.0.1:5173/signal-quality`, enter the soak start and choose
**24h from start**.

### D. Periodic health (around 1 h, 6 h and 12 h; read-only)

- `report.json` from the soak monitor: `continuity.verdict` should be
  `IN_PROGRESS`, with no interruptions.
- `soak-health` should show:
  - the scanner `RUNNING` on the **same** `runId`;
  - `universe.liveEligible` close to `universe.selected`;
  - `failed` and `recovering` at 0;
  - `stale` false and `capacityExceeded` false;
  - `lastMarketDataAt` within a minute;
  - the emitter `RUNNING`, `queueDepth` near 0, `ledgerDuplicates` 0;
  - plans `PENDING` near 0 and `ERROR` 0.
- The observatory summary: alert count, the busiest 15 minutes, flags.
  `TRIGGERED_BEFORE_SOAK` and `DELAYED_DELIVERY` mean backlog.
- `/api/native-planner/status`: `jobs.failed` at 0.

### E. 24 h final

- `report.json` gives `continuity.verdict`:
  - `CONTINUOUS` only if every snapshot was healthy at the 15-minute cadence
    on one scanner run;
  - otherwise `SOAK_INTERRUPTED`, with each reason: `MONITOR_GAP` (sleep, lid
    closed, crash), `SCANNER_RESTARTED`, `SCANNER_NOT_RUNNING`,
    `EMITTER_NOT_RUNNING`, `BACKEND_UNREACHABLE`, `MONITOR_STARTED_LATE`,
    `MONITOR_ENDED_EARLY`.
- Export the soak, as of its end, with
  `scope=TRIGGERED_DURING_SOAK` for real-time alerts only:

  ```powershell
  $end = ([datetime]$start).AddHours(24).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Invoke-WebRequest "http://127.0.0.1:4000/api/signal-quality/export?format=csv&soakStart=$start&soakEnd=$end&scope=TRIGGERED_DURING_SOAK" -OutFile "$env:LOCALAPPDATA\trading-alert-dashboard\soak\native-signal-quality-realtime.csv"
  Invoke-RestMethod "http://127.0.0.1:4000/api/signal-quality/summary?soakStart=$start&soakEnd=$end&scope=OBSERVED_DURING_SOAK_TRIGGERED_BEFORE_START"
  ```

- Read the summary with its denominators:
  - matured counts per horizon;
  - `PENDING`/`PARTIAL` for late signals;
  - resolved, ambiguous, neither, pending and gap plan counts;
  - integrity and freshness distributions;
  - data gaps;
  - recovery (pre-soak) alerts.
- **Re-run the summary after the soak**: at soak end + 24 h, every signal's 24h
  horizon has matured. A signal at soak hour 23 has only its 15m and 1h
  matured at soak end.

### F. Stop (monitoring-only components)

- **Soak monitor:** exits at the end (or Ctrl+C).
- **Emitter:** Ctrl+C in its terminal; it saves its cursors.
- **Scanner:** Ctrl+C; its `status.json` then says `STOPPED`. Avoid
  `taskkill /F`: a forced stop skips the kline-cache flush.
- **Native planner:** launcher **13. Stop Native Planner**.
- **Generic backend:** launcher **15. Stop Generic Backend — Non-Watch**.
- **Frontend:** Ctrl+C.
- Account A and Account B were never started, so there is nothing to stop.

### Windows continuity

The soak needs the machine awake for 24 h.

- **Closing the laptop lid or letting Windows sleep stops collection.** Screen
  off is fine as long as the processes keep running.
- This change does not alter the operator's power settings. Set "When I close
  the lid: Do nothing" and "Sleep: Never" on mains power yourself if needed.
- A sleep shows in the report as `MONITOR_GAP` (and usually
  `SCANNER_RESTARTED` or stale status). FAST_RECOVERY may then replay the
  missed bars, but replayed bars never create alerts. Backlog alerts are
  classified separately.
- **A recovered 24 h dataset is useful; it is not an uninterrupted real-time
  soak.**

## 12. Interpreting 24 h results

- **A 24 h collection window does not give every signal a mature 24 h
  outcome.** A signal's 24 h horizon matures 24 h after its own trigger.
  Evaluate again after soak end + 24 h for the full set.
- 24 h is a **smoke and initial-quality sample**, not proof of edge:
  - one market regime;
  - a few dozen to a few thousand alerts, correlated across symbols and times;
  - plans that resolve or not within one day.
- Look first at engine quality (flags, integrity, freshness, duplicates), then
  at sample sizes, and only then at rates.
- A strategy concern found here is **recorded with evidence and not fixed**
  here; the strategy is out of scope for this milestone.

## Tests

- `apps/backend/tests/native-signal-quality-outcome.test.ts`: the kernel
  matrix:
  - LONG/SHORT favourable, adverse, both, none and boundary cases;
  - every horizon state;
  - every plan outcome;
  - timing, symmetry and determinism.
- `apps/backend/tests/native-signal-quality-aggregate.test.ts`:
  - censoring and denominators;
  - R, expectancy and profit-factor edge cases;
  - groupings and alert rate;
  - facts, freshness and soak scope;
  - diagnostic flags and export.
- `apps/backend/tests/native-signal-quality-adapters.test.ts`:
  - the public market-data adapter (allowlist, budget, used-weight pause,
    429, malformed, tail refresh, cache cap, Unicode);
  - soak health and continuity;
  - the monitor's contract.
- `apps/backend/tests/native-signal-quality.integration.test.ts` (`_test`
  database):
  - every route against seeded alerts, and GET-only;
  - strict query validation;
  - soak scopes and the point-in-time `asOf`;
  - a byte-identical database afterwards.
- `apps/backend/tests/native-signal-quality-structure.test.ts`:
  - the AST import closure (no private client, account control, execution
    service, queue, Redis or env config);
  - no signing, write, authority or migration;
  - GET-only routes;
  - the M4/M5/M6 invariants.
- `apps/frontend/tests/signalQualityObservatory.test.tsx`:
  - the banner, and no trade/arm/enable control;
  - GET-only API and filters, pagination and export;
  - empty, loading and unavailable states;
  - partial, ambiguous and gap states;
  - detail and chart;
  - long and Unicode symbols.
