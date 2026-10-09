# Native Fast Recovery V1

Fast Recovery V1 makes the live-shadow scanner restart faster after downtime.

It changes only how the scanner fetches data from Binance. It does not change
what the scanner replays or how:

- Teddy semantics are unchanged.
- Checkpoint verification is unchanged.
- The engine fingerprint (`35f1a32d…`) is unchanged.
- The state namespace is unchanged.

Native execution stays disabled.

## Why restarts were slow (evidence)

Three real restarts of the 525-symbol universe each took about 19 minutes from
start to manifest. The downtime before them was very different (a prior stop,
16 h and 1.2 h), so the cost is a fixed overhead per symbol, not a cost per
missed bar.

| Where the time went | Measured |
| --- | --- |
| REST requests at start-up | about 1145 in run `20261007T070329Z` |
| Request model | 525 symbols × (1 serverTime + 1 klines page) + 56 later listings × (1 serverTime + 1 probe) = 1162 |
| Request discipline | one global governor: 1 in flight, ≥ 1000 ms between starts. 1162 × 1 s ≈ 19 min, which matches the observation |
| CPU (real cache and checkpoints, 25 symbols sampled read-only) | 48 ms cache load + 315 ms rebuild and hash-fence verification per symbol, about 190 s for 525 |

Half of all start-up requests were `serverTime` calls: one per symbol, and one
per origin probe on every restart. Every klines page asked for 1000 rows (weight
5), even when only one bar was missing.

CPU replay accounts for about 3 minutes, and that time *is* the checkpoint
verification. It is kept unchanged.

## What changed: the FAST_RECOVERY_V1 fetch policy (now the default)

1. **One shared Binance clock** (`BinanceServerClock`). A single `serverTime`
   reading serves every symbol's closure proof and every origin probe.
   - Binance's clock only moves forward, so an older reading can only
     *under*-claim closure.
   - When the kept reading cannot prove a range closed, the scanner fetches one
     fresh reading, shared by all concurrent callers.
   - If even that reading cannot prove closure, the scanner refuses with
     `RANGE_NOT_CLOSED`, exactly as before.
2. **Range-sized pages.** A klines page asks only for the bars the range still
   needs. A gap under 100 bars costs weight 1 instead of 5. The rows returned
   are identical.
3. **IP-weight governance** (`GovernedPublicTransport`):
   - The scanner's own weight is capped at **≤ 300 per rolling minute**. That
     is the old worst case (60 requests/min × weight 5), so the scanner never
     loads the IP more than before.
   - Starts stay at least **250 ms** apart, the existing hard floor.
   - At most **2 requests are in flight**, with starts kept in call order.
   - When Binance reports (`X-MBX-USED-WEIGHT-1M`) that the shared IP, including
     Account A/B traffic, has used **≥ 1200 of 2400**, no request starts until
     the next minute.
   - These are unchanged: a 418/429 still halts the whole run (no request starts
     once the halt is known), the total run budget still applies, and transient
     5xx and transport errors are still retried with the same backoff.
4. **Bounded worker pool.** Four symbols are prepared at once instead of two,
   so the CPU replay of one symbol overlaps the others' network waits. Replay
   within each symbol is still sequential and deterministic, and each symbol
   keeps its own lock, generation fence and checkpoint.

The original policy can still be selected with `--recovery-policy legacy`. It
is the baseline of the equivalence tests.

Operator flags:

| Flag | Default | Bounds |
| --- | --- | --- |
| `--recovery-policy` | `fast` | `fast` or `legacy` |
| `--max-in-flight` | 2 | 1..4 |
| `--max-weight-per-minute` | 300 | 10..1200 (never more than half the IP limit) |
| `--request-spacing-ms` | 250 | ≥ 250 |
| `--rest-concurrency` | 4 | 1..8 |

## What did NOT change

Every symbol still recovers along the same path:

> trusted checkpoint → exact missing closed 15m interval → klines → full
> deterministic rebuild with the hash fence → existing checkpoint semantics →
> LIVE

The rebuild still covers the historical state, the causal bytes through the
high-water mark and the state at the high-water mark. Catch-up replay is still
silent and `NON_ACTIONABLE`: it writes no events, no observations and no
alerts. In-run recovery still commits `REPLAYED_NON_ACTIONABLE`.

These are unchanged:

- 7% gate, 1% touch tolerance, 5/4/10-bar timers, colour and direction rules,
  forming candidates;
- symbol history origin, Unicode symbols, quarantine of real post-origin gaps;
- the 5-minute universe refresh, capacity refusal and last-known-good universe.

## Versioning decision

The engine fingerprint is **not** changed. Fast recovery yields byte-identical
durable state and engine state, as the tests below prove, so recovery speed is
not an engine change.

`FAST_RECOVERY_V1` is an **observability label only**. It appears in the
start-up log and in `status.recovery.policy`. It is in no lineage, fingerprint,
checkpoint or namespace.

## Proof of equivalence (tests/native-fast-recovery.test.ts)

The test starts from one trusted checkpoint and the same missed bars, and runs
them through LEGACY and FAST. Every durable byte must be identical: checkpoints
(body and hash), event logs, kline cache rows and the run's files. The full
committed engine state must be identical too: levels, creation, arming and touch
bars, forming candidates and HTF tracks. So must HWM, lineage, origin,
quarantine decisions and the start-up summary.

Downtime shapes tested: 6 h, 1 d, 3 d, 2 w and 30 d. The 2 w and 30 d gaps
create, arm and retest levels (cooldown) and close source periods during the
downtime.

The production engine is tested too: all six source timeframes, 7%, 1%,
5/4/10.

Failure shapes, each decided identically by both policies, failing closed:

- a missing post-origin bar is quarantined;
- a duplicate row is refused;
- a checkpoint mismatch is quarantined and the checkpoint left untouched;
- a retryable 5xx is retried, ending in the same state as a clean run;
- a permanent failure becomes UNREADABLE;
- a 429 halts the run, and nothing starts after it;
- a shutdown midway lands nothing;
- a newly onboarded symbol is bootstrapped from its own origin;
- a Unicode symbol is recovered;
- the shared-IP pause triggers;
- in-run recovery produces identical `REPLAYED_NON_ACTIONABLE` commits.

Structural assertions on the FAST runs:

- fewer requests and no more weight than LEGACY;
- one `serverTime` per start-up;
- no page fetched twice;
- no page above 1000 rows;
- at most 2 in flight;
- at most 300 weight in every rolling minute.

## OFFLINE STRUCTURAL MODEL (synthetic, non-gating, not a measurement)

Command: `pnpm -C apps/backend exec tsx scripts/native-recovery-benchmark.ts 525 360 150`

The model runs the real supervisor against a fake Binance with a manual clock.
Its request counts, request weight, rolling-minute weight and in-flight figures
are exact for the synthetic universe. Its wall-clock column is **not** a
measurement. It was computed as max(REST, CPU), using a CPU cost of 360 ms per
symbol.

| Downtime | LEGACY requests / weight | FAST requests / weight | Modelled wall time, LEGACY → FAST |
| --- | --- | --- | --- |
| 6 h | 1168 / 3268 | 585 / 585 | 19.4 → 3.1 min |
| 1 d | 1168 / 3268 | 585 / 585 | 19.4 → 3.1 min |
| 3 d | 1168 / 3268 | 585 / 1110 | 19.4 → 3.6 min |
| 2 w | 1693 / 5893 | 1111 / 3736 | 28.2 → 12.3 min |
| 30 d | 2218 / 8518 | 1638 / 7938 | 37.0 → 26.2 min |

**The modelled FAST wall times are too optimistic.**

- The 360 ms CPU figure covered only the cache load and the rebuild with
  hash-fence verification. It left out the cache save and verified reload that
  every fetched symbol performs. Re-measured afterwards on temp copies of real
  state, read-only, the full per-symbol cost is about 425 ms: 42 ms load, 82 ms
  save and reload, 301 ms rebuild and verification.
- max(REST, CPU) assumes CPU and network overlap fully. In one Node process the
  synchronous rebuild and verification run on the same thread as the request
  timers and responses, so in practice they largely add up.

The request-count and weight reductions are what the model got right, and the
live run below confirms them.

## LIVE PUBLIC BINANCE RESULT (measured)

One approved 60-minute live public soak: public endpoints only, no signed
calls, no DB.

| | |
| --- | --- |
| Run | `20261009T065309Z-bbb0c078` |
| Git | `ec6d233` |
| Universe | 525 symbols |
| Real downtime represented | 87,687 missed 15m bars = 167 bars × 525 symbols ≈ 41.8 hours |
| Start-up recovery | 427,737 ms ≈ 7 min 08 s |
| Start-up REST | 589 requests |
| Start-up request weight | 1114 |
| serverTime requests | 8 |
| Max in flight | 2 |
| Workers | 4 |
| Weight waits | 0 |
| Used-weight pauses | 0 |
| Result | 525 recovered, 0 current, 0 bootstrapped, 0 not live |

The figures come from the `recovery` block of the run's `status.json`.

Compared with the earlier legacy restarts (real, measured the same way, from run
start to manifest):

| | Wall clock | Start-up requests |
| --- | --- | --- |
| LEGACY | ~19 min | ~1160 |
| FAST | ~7 min 08 s | 589 |
| Change | roughly **2.7× faster** | roughly **half** |

Notes on the live run:

- **The governor was not the limit.** There were 0 weight waits and 0
  used-weight pauses. The REST spacing floor alone is 589 × 250 ms ≈ 147 s.
- **No phase split is claimed.** The rest of the 7 min 08 s was most likely
  synchronous CPU (cache save/reload, rebuild and verification) plus network
  latency, but per-phase timing was not recorded durably.
- **Peak used weight is unknown for this run.** It did not record the
  `X-MBX-USED-WEIGHT-1M` peak, because that metric was added afterwards (see
  below).
- **The run-wide REST total of 1113 is more than start-up.** It splits exactly
  into:
  - 589 for start-up recovery;
  - 1 initial exchangeInfo, made before start-up;
  - 10 universe refreshes;
  - 513 in-run recoveries: one 1-bar page for each symbol whose start-up
    catch-up finished before the 07:00 bar closed, because start-up straddled a
    15m boundary. Legacy restarts show the same effect.

At 6 h – 3 d of downtime the remaining bound is CPU, the rebuild and hash-fence
verification. A future milestone could move that work to worker threads without
weakening it.

## Start-up observability

Each start-up now records the following.

- **In `status.json` → `recovery`** (written by every status update, so it
  survives terminal scrollback):
  - the policy;
  - symbols recovered, current, bootstrapped and not live;
  - missed bars replayed;
  - start-up requests, weight, serverTime requests, max in flight and workers;
  - weight waits and used-weight pauses;
  - `peakReportedUsedWeight`: the highest valid `X-MBX-USED-WEIGHT-1M` Binance
    reported during start-up, or `null` when none arrived. Unknown is never
    written as 0.
  - `elapsedMs`;
  - `completedAt`: when the recovery walk completed successfully; `null` if it
    did not complete.
- **In `status.json` → `totals`**: the governor's lifetime metrics, `restWeight`,
  `restWeightWaits`, `restUsedWeightPauses` and `restPeakReportedUsedWeight`,
  next to the unchanged `restRequests`.
- **For a start-up that throws**, which never reaches `status.json`: one
  `startup-recovery.json` in that run's own directory,
  `live-shadow-supervisor/runs/<runId>/`. It holds the summary above, the
  outcome and a sanitized failure: error class, code, and the message with any
  URL or key-like token removed.
  - It is written once, atomically, and never overwrites an existing file.
  - A failure to write it never masks the start-up error.
  - It is observation only. No scanner, emitter, status-page or
    execution-integrity reader opens it.

None of this affects any decision, readiness, checkpoint, engine state,
lineage, commit, alert or execution admission.
