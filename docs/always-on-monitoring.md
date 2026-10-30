# Always-On Monitoring V1

> **MONITORING ONLY · NO ACCOUNT EXECUTION · NATIVE EXECUTION HARD-DISABLED**

Always-On Monitoring is one supervisor process that owns the monitoring data
plane and keeps it running across process crashes, network loss and large
catch-up backlogs, without an operator watching. It does not expand trading
authority in any way.

| It owns | It never touches |
| --- | --- |
| Generic backend, non-watch (`node apps/backend/dist/src/server.js`) | Account A or Account B (control planes, execution workers) |
| Native live-shadow scanner (`scanner:live-shadow-supervisor --profile …`, FAST_RECOVERY_V1) | LIVE-READY, gates, arming, risk, sizing, orders, stops, take profits |
| Native multi-symbol emitter (COMMIT + follow; **dashboard writes only**) | Signed/private Binance, credentials, leverage, margin |
| Native planner (**planning only**) | TradingView execution, Start SAFE, Stop Runtime |
| Its own status artifact and incident journal | Any process it did not start (reported, never killed) |

`NATIVE_EXECUTION_ENABLED` stays the literal `false as const`. Both accounts'
Native risk stays `UNRESOLVED`. No schema or migration changes are involved.

## 1. How it works

```
monitoring:always-on run   (one process; single instance: 127.0.0.1:4019)
 ├─ backend   (built server, no watcher)          health: GET /health
 ├─ scanner   (FAST_RECOVERY_V1, --stop-file …)   health: its own status.json (pid in OUR tree)
 ├─ emitter   (--run-id <our scanner run> --expect-engine-fingerprint <profile engine>
 │             --commit-dashboard-alerts --follow --stop-file …)   health: status-commit.json
 └─ planner   (planning only)                      health: GET /api/native-planner/status + soak-health plans
```

The supervisor observes every 15 seconds, or every 2 seconds while it is
stopping or restarting something. Each tick it judges each role, then acts in
dependency order:

- **Backend** needs nothing.
- **Scanner** needs public Binance.
- **Emitter** is pinned to OUR scanner run, and starts only once that run
  reports healthy.
- **Planner** needs a healthy backend.

Losing market connectivity degrades the scanner only. The backend and planner
are never restarted because of a market outage.

Every child gets the generic env file (`DOTENV_CONFIG_PATH`). Its environment
has every name that file declares removed, plus, case-insensitively,
`BINANCE_API_KEY`, `BINANCE_API_SECRET`, `EXECUTION_PROFILE_ACCOUNT_IDENTIFIER`,
`EXECUTION_PROFILE_ENVIRONMENT`, `API_KEY` and `API_SECRET`. The supervisor
strips the same names from its own environment at start-up. Only the names are
logged.

## 2. Health model

Nothing is ever compared with a fixed universe size. Binance's active
membership changes legitimately (524 → 522 is healthy).

**Scanner.** A status counts only if its `pid` is a runtime inside the
scanner tree the supervisor owns. A file left by an older run, or written by
someone else's scanner, proves nothing. The scanner is HEALTHY when all of
these hold:

- `RUNNING`, with a status no older than 3 minutes;
- `universe.stale = false` and `capacity.exceeded = false`;
- `failed`, `recovering` and `catchupPending` are all 0, and no symbol awaits
  its stream on a connection that delivers nothing;
- membership is consistent: every placed symbol is in exactly one known state
  (live, quarantined, awaiting its stream, recovering, pending, failed), and
  their number matches `selected`. A failed symbol stays placed and is
  reported once, as `SYMBOLS_FAILED`;
- the newest market message is under 3 minutes old;
- the REST budget is not halted (418/429).

These are WARMING, not degraded: normal after a start or a reconnect:
- symbols quarantined for the current bar;
- quiet symbols awaiting their first update on a connection that **is**
  delivering messages.

The scanner itself detaches a symbol that stays silent on a healthy connection
for `staleSymbolMs` (30 minutes) and recovers it. So the supervisor does not
race it: WARMING becomes degraded only after 35 minutes, as
`QUARANTINE_PERSISTENT` or `AWAITING_STREAM_PERSISTENT`. A symbol on a silent,
closed or never-opened connection is a stream failure (`AWAITING_STREAM`) at
once. A status without per-symbol detail, from an older scanner, is read
strictly. Reconnect and backpressure counters are reported but never trigger
a restart on their own.

**Universe staleness.** The run's first universe refresh is due one interval
(5 minutes) after the universe the run started with was read. After a
FAST_RECOVERY start-up longer than that, it is due immediately. With no
refresh successful yet, staleness counts from the end of start-up. Until the
2026-10-24 acceptance it counted from the run's start, so a 7-minute start-up
read as `UNIVERSE_STALE` before the first refresh was even due.

**A status that disappears or cannot be read.** Before a role's first status
of its own, a missing status means it is still starting up, with its own
deadline: 45 minutes for the scanner, 10 for the emitter. After that it is
degraded evidence (`STATUS_MISSING`), judged like a stale status. The scanner
gets the grace period, the emitter its hung window. A single failed read is
never acted on at once.

**Emitter.** Health is judged from its own status for its pinned run (its own
pid):

- STALE after 5 minutes; restarted only when hung for 10 minutes.
- DEGRADED on failed lanes or a broken membership journal. A restart does not
  repair evidence, so it is not restarted for these.
- CATCHING_UP while lanes are behind or the queue is at least half full. This
  is healthy.
- More tracked lanes than the scanner's current selection is a note
  (`HISTORICAL_LANES_BEYOND_CURRENT_SELECTION`), not a failure.

**Planner.** It is judged on new failures only:

- At start the supervisor records a baseline of BullMQ failed jobs and ERROR
  plans; for example, the three historical ERROR plans.
- Health degrades on a positive delta, on pending Native plans persisting for
  15 minutes, on a last-sweep error, or on a missing heartbeat.
- It is restarted only when its heartbeat reads OFF or STALE for 2 minutes
  while the process is alive. UNREADABLE means Redis trouble, and is never a
  reason to restart.
- Nothing historical is reset, retried or deleted. If a counter goes backwards
  (retention), the baseline follows it down, never up.

**Data store.** If the backend answers but soak-health returns 5xx, the
database is unavailable. Emitter and planner (re)starts then wait without
spending attempts.

## 3. Network outages and the one recovery path

1. The scanner is DEGRADED. During the 90-second grace period nothing happens.
   After it, nothing is decided on a status written before the grace deadline:
   the scanner writes its status every 60 seconds, so an older snapshot may
   describe an outage that is already over (`AWAITING_FRESH_STATUS`). A status
   that stops arriving is itself the evidence (`STATUS_MISSING`, or
   `STATUS_STALE` after 180 seconds) and is never delayed.
2. After the grace period, one unsigned public request (`GET
   https://fapi.binance.com/fapi/v1/time`, at most every 30 seconds) checks for
   the network.
   - **Unreachable:** nothing is restarted, no attempt is spent, and the state
     reads `NETWORK_UNAVAILABLE`.
   - **Reachable again:** the scanner gets 120 seconds to heal itself. So does
     the fresh run of a recovery that is still starting up.
   - **REST answers but the streams may not:** when the scanner's own fresh
     status shows no connection delivering anything, and only stream-explained
     issues (awaiting streams, stale market data, symbols recovering), one
     public stream probe runs (at most every 30 seconds): a BTCUSDT 15m kline
     subscription to the production-validated URL, no headers, 10 seconds at
     most. Only a confirmed outage (an error or close before a valid message,
     or no handshake at all) holds the scanner: `PUBLIC_STREAM_UNREACHABLE`,
     nothing restarted, no attempt spent, the scanner and its emitter kept, a
     fresh run never started into it and never failed for it. When the
     streams return, the 120-second heal window applies. A probe that is
     uncertain (it cannot be built, opens but hears nothing, or reads something
     it cannot interpret) or that connects (the fault is the scanner's own)
     never holds anything: the normal recovery and latch follow.
   - **Only the universe is stale:** after a confirmed restore, the scanner's
     own next refresh (its `universe.nextRefreshAt`) gets 60 more seconds, never
     beyond the restore + 360 seconds (`UNIVERSE_REFRESH_PENDING`). Any other
     issue, or no valid next-refresh time, keeps the 120-second window.
3. Still degraded after that, a single fenced **recovery** runs:
   - stop the owned emitter, cooperatively (it persists its processed cursors);
   - stop the owned scanner, cooperatively (its status and checkpoints persist);
   - start a fresh scanner run (FAST_RECOVERY_V1);
   - wait until OUR new run reports healthy (status pid in our tree, manifest
     present, engine fingerprint equal to the profile's);
   - start an emitter pinned to that run id and fingerprint.

A scanner that exits takes the same path. An emitter is never left pinned to a
replaced run, and it never hops runs internally.

So does a scanner whose run is **not the profile's engine**, for example a run
adopted after a code change: its emitter is stopped first, then a fresh run
starts. If the fresh run is again not the profile's engine, the scanner
latches at once with `ENGINE_FINGERPRINT_MISMATCH`. The code on disk is not
the engine this supervisor was started with, so another run cannot help.
Restart Always-On, then clear the latch.

A cooperative stop asks the child to stop by creating its unique
`--stop-file`. The child runs exactly the graceful stop that Ctrl+C runs. If
the child has not exited after 90 seconds (emitter) or 180 seconds (scanner),
the **fenced stop** re-proves ownership and then runs `taskkill /T /F` on that
one owned root.

During recovery no cursor is rebaselined, and no cursor, namespace,
checkpoint or log is deleted.

**Backoff and latching.** Every restart after a role's first start in a
generation is an attempt, except a restart after a stop the supervisor made
for another reason. An emitter stopped for a scanner recovery, or because its
pinned run was superseded, did not fail: it restarts at once and spends no
attempt.

- Attempts are spaced 30 seconds, then 1, 2, 5, 10 and 15 minutes apart.
- After 6 attempts the role **LATCHES**: no more automatic restarts until
  `monitoring:always-on clear-latch`.
- 30 minutes of continuous, observed health forgives the attempts.
- A sleep or hibernate (a tick more than 4 polls late) restarts every grace
  period, the emitter's hung window and the forgiveness streak. Nothing is
  judged on pre-sleep timers or on a status written before the sleep.

**Supervisor states:** `STARTING`, `RUNNING` (normal), `DEGRADED`,
`RECOVERING`, `BACKOFF`, `LATCHED` (failed/latching), `STOPPING`, `STOPPED`.
Each comes with a machine-readable `reasonCode` and an operator-readable
`reason`.

## 4. Emitter bounded catch-up

Before this milestone the emitter read every lane, admitted every new record,
and only then drained. A recoverable backlog larger than `--queue-capacity`
therefore failed with `EMITTER_QUEUE_OVERFLOW` before anything was delivered.
A real one did: 14,088 records against 10,000. It caught up only with
`--queue-capacity 25000`.

Now the queue is genuinely bounded and the backlog drains in rounds:

- **Admit only what fits.** A round gives each lane that still has unread
  records an equal share of the free room, at least one record. Records not yet
  admitted stay in the durable log and are never dropped or skipped.
- **Drain round-robin.** The queue is drained one record per lane per turn,
  each lane in its log order. Then the next round admits more.
- **`queueDepth <= queueCapacity` at all times.** The overflow check remains
  only as an invariant that can no longer be reached.
- **When everything fits, one round admits it all,** and processing is
  exactly the old unbounded order.

These are unchanged:

- strict per-record validation in log order;
- the streaming V2 selector (first in a slot wins);
- COMMIT ordering: the ledger transaction first, the cursor only after it;
- ledger idempotency as the final duplicate fence;
- first activation at EOF;
- dynamic membership joins;
- the default queue capacity, 10,000, and the bounded `--queue-capacity` flag.

A refused line still fails its lane closed. Anything that lane had queued is
dropped unprocessed, so nothing at or after a refusal is ever delivered, and
its cursor stays at its last processed record.

A graceful stop keeps only processed positions. Queued and unadmitted records
are re-read from the cursor on the next start.

During a long catch-up the emitter refreshes its status file every
`--status-every-s`, so it is never mistaken for a hung process. Its status has
`catchUp: { rounds, recordsAdmitted, backlogLanes }`.

- It yields to the event loop every 256 processed records. A cooperative stop
  or Ctrl+C is therefore seen promptly, even while it only skips records.
- Cursors are written after each delivery, once at the end of each drain, and
  on stop. They are not written once per lane per round: each write hashes the
  lane's consumed prefix and fsyncs.

**Start-up.** Before it delivers anything, the emitter re-validates every lane
up to its cursor, which takes longer as the run's logs grow. From the first
lane on, its status has `initialization: { complete, lanesBaselined,
lanesTotal }`. The supervisor reads a fresh, incomplete one as
`STARTING (INITIALIZING)` and applies no first-status deadline to it. A status
that stops refreshing is still `STALE`, and hung after 10 minutes.

> **The queue bound is no longer a staleness guard.** The overflow used to stop
> a stale multi-day backlog as a side effect
> ([native-emitter-cursor-rebaseline.md](native-emitter-cursor-rebaseline.md)).
> In Always-On the emitter is supervised alongside the scanner, so backlogs are
> outage-length. FAST_RECOVERY also replays downtime silently and writes no
> deliverable record.
>
> If the emitter has been down for days while the scanner ran, for example
> blocked by a database outage, its backlog is genuine but late. Starting it
> delivers that backlog, which the observatory marks as delayed. Before
> starting Always-On after such a gap, run the DRY emitter. If its would-create
> backlog is stale, decide on a rebaseline. Always-On never rebaselines.

## 5. Ownership, generations, fencing

- **One supervisor.** An exclusive loopback listener on `127.0.0.1:4019` is
  held for the supervisor's life. The OS releases it on any exit, so there is
  never a stale owner.
- **Generations.** Each start takes `generation + 1` in
  `ownership.json`. Every start, stop and record change re-reads that file
  **under the launcher's mutation lock** (`127.0.0.1:4009`) and refuses unless
  the generation on disk is still its own. A stale supervisor can never control
  a newer generation's children.
  - A file that cannot be **read**, for example while an editor, an indexer or
    antivirus holds it, is UNKNOWN. Mutations pause until it can be read, and
    the generation is not given up (`OWNERSHIP_READ_FAILED`).
  - Only a readable file naming another generation, or a removed or broken
    file, fences the supervisor.
- **Durability.** `ownership.json` is replaced atomically, with bounded retries
  for Windows sharing errors (EPERM, EBUSY, EACCES).
  - If it still cannot be written right after a spawn, the child stays
    recorded in memory and the write is retried every tick
    (`OWNERSHIP_WRITE_FAILED`, then `OWNERSHIP_WRITE_RESTORED`). No other role
    starts until the record is durable.
  - `run` refuses to start if it cannot read or write the file, or cannot read
    its own OS creation time.
- **Children.** Each child is recorded by its owned root: pid, OS creation
  time, and the repository path on its command line. A process is terminated
  only through the reviewed fenced stop, which re-proves all three.
- **Adoption.** A new generation adopts the previous generation's children
  that are still provably its own. A recycled pid or a gone root is dropped
  from the record and never killed. A supervisor restart therefore does not
  restart a healthy scanner.
  - A record written by **another checkout's** supervisor is never adopted.
    The main checkout and every worktree share `%LOCALAPPDATA%`. Such children
    are dropped from the record (`OTHER_REPOSITORY`), reported as `CONFLICT`,
    and never stopped.
- **A supervision pass never ends the supervisor.** An unexpected error is
  journaled once (`SUPERVISOR_TICK_FAILED`) and the state reads
  `DEGRADED (SUPERVISION_ERROR)`. The next pass then runs as usual.
- **Conflicts.** A manual or launcher-owned scanner, emitter, planner or
  backend is reported as `CONFLICT` and never killed; nothing is started beside
  it. Old `signal-quality:soak-monitor` processes are reported as external.

## 6. Files

Everything lives under `%LOCALAPPDATA%\trading-alert-dashboard\`, outside the
repository.

| File | What |
| --- | --- |
| `monitoring\always-on\status.json` | `teddy.native-monitoring.always-on-status.v1`, rewritten atomically every tick |
| `monitoring\always-on\incidents.jsonl` | Append-only (fsync) journal of transitions, never one line per poll, generation-tagged, redacted |
| `monitoring\always-on\ownership.json` | Generation, supervisor identity, children (atomic replace) |
| `monitoring\always-on\requests\` | `stop.json` / `clear-latch.json` / `drill.json` / `drill-restore.json`, consumed by the running supervisor |
| `monitoring\always-on\stop\` | One cooperative stop file per spawned scanner/emitter; the owned scanner's `.drill` file beside its stop file while an operator drill is active (section 12) |
| `logs\always-on-<role>.log`, `logs\always-on-supervisor.log` | stdout+stderr, rotated at 32 MB |

The status artifact has:

- the supervisor's state, reason code, reason and generation;
- start and write times;
- for each role: owned root/runtime pids, state and reason, restarts,
  attempts, next attempt, latch, last exit, and external pids;
- **scanner:** run id, health, universe counts, last market data time,
  reconnects and backpressure;
- **emitter:** pinned run and mode, tracked/healthy/failed lanes, queue
  depth/capacity/max, backlog lanes, created and duplicates;
- **planner:** worker state, pending count, baseline and delta;
- data store and network state;
- last recovery, current backoff, counters, and the last successful
  end-to-end healthy time;
- recent incidents.

Journal kinds include `SCANNER_DEGRADED`, `NETWORK_UNAVAILABLE`,
`NETWORK_RESTORED`, `SCANNER_RECOVERY_REQUESTED`, `SCANNER_RECOVERY_SUCCEEDED`,
`SCANNER_RECOVERY_FAILED`, `EMITTER_STOPPED_RUN_SUPERSEDED`,
`EMITTER_STARTED_ON_RUN`, `LARGE_BACKLOG_DETECTED`, `BACKLOG_DRAINED`,
`PLANNER_FAILURE_DELTA_INCREASED`, `BACKOFF_ENTERED`, `ROLE_LATCHED`,
`SUPERVISOR_LATCHED`, `SUPERVISOR_RETURNED_HEALTHY`, `ROLE_CONFLICT`,
`EXTERNAL_MONITORING_PROCESS`, `OWNERSHIP_READ_FAILED`,
`OWNERSHIP_WRITE_FAILED` and `SUPERVISOR_TICK_FAILED`. The operator drill adds
`DRILL_REJECTED`, `DRILL_STARTED`, `DRILL_ACTIVATION_CONFIRMED` /
`DRILL_ACTIVATION_UNCONFIRMED`, `DRILL_RESTORE_REQUESTED`, `DRILL_ENDED`,
`DRILL_RESTORE_CONFIRMED` / `DRILL_RESTORE_UNCONFIRMED`, `DRILL_STALE_REMOVED`,
`DRILL_UNAUTHORIZED_FILE_REMOVED` and `DRILL_STATE_INCONSISTENT` (section 12). The status artifact gains an
optional `drill` view, present only once a generation has accepted a drill.

## 7. Commands

```powershell
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on run [--emitter-activate-at-eof] [--roles backend,scanner,emitter,planner]
     [--poll-seconds 15] [--degraded-grace-seconds 90] [--max-recovery-attempts 6] [--emitter-queue-capacity 10000]
     [--scanner-max-total-requests N] [--scanner-status-every-s N] [--profile teddy-7-all-active] [--backend-url http://127.0.0.1:4000]
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on status [--json]
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on stop [--wait-seconds 600]
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on clear-latch [--role scanner]
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on startup-task [--emitter-activate-at-eof] [--write]
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on drill start --fault <FAULT> --duration-seconds <10-900> --generation <G> --run-id <run id>
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on drill restore
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on drill status
```

The `drill` commands are the operator network drill (section 12). Never run one
without a separately approved drill procedure.

pnpm 11 passes arguments straight through. Do not insert a bare `--`.

If the recorded supervisor cannot be observed (a process probe failed, or
`ownership.json` cannot be read):

- `status` says `UNKNOWN` (`supervisorRunning: null` with `--json`);
- `stop` and `clear-latch` request nothing and exit 1;
- a `stop` waits until the supervisor has provably exited.

`--emitter-activate-at-eof` is an explicit operator decision. Without it, a
lane that has never had a production cursor refuses COMMIT, for example a
symbol listed while the stack was down. With it, such a lane activates at its
current EOF, which is exactly how dynamic joins already activate. Lanes with
cursors are unaffected either way.

**Runtime launcher** (`Trading Runtime Launcher.cmd`):

- **16. Start Always-On Monitoring** starts the supervisor detached, logging to
  `logs\always-on-supervisor.log`.
- **17. Show Always-On Monitoring Status**.
- **18. Stop Always-On Monitoring** is graceful. The supervisor stops only what
  it owns; the launcher writes a request and waits.

Nothing else in the launcher changes. While Always-On owns the backend and
planner, launcher items 11 and 14 (and Start SAFE) see them as external and
refuse to start a second copy.

**Visible console:** double-click `Always-On Monitoring.cmd` at the repository
root.

- Ctrl+C stops the stack gracefully.
- A second Ctrl+C, closing the window, or Ctrl+Break leaves the children
  running. The next start adopts them.

## 8. Windows startup (prepared, NOT registered)

```powershell
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on startup-task --emitter-activate-at-eof --write
schtasks /Create /TN "TeddyAlwaysOnMonitoring" /XML "%LOCALAPPDATA%\trading-alert-dashboard\monitoring\always-on\startup-task.xml"
schtasks /Query /TN "TeddyAlwaysOnMonitoring" /V /FO LIST
schtasks /Delete /TN "TeddyAlwaysOnMonitoring" /F      # to remove it
```

The task is a **logon** trigger for the interactive user, so it gets that
user's LocalAppData, env files and scanner data. It has:

- a one-minute delay, so Docker and the network come up first;
- least privilege;
- no execution time limit and no battery stop;
- `IgnoreNew` for a second instance;
- a bounded restart-on-failure;
- the action `cmd /d /c pnpm -C <repo> --filter @trading-alert-dashboard/backend monitoring:always-on run`.

It starts only the supervisor. This repository never runs `schtasks`.

## 9. Manual acceptance procedure (for later; not executed during implementation)

Prerequisites:

- `git rev-parse HEAD` is the merged main.
- `docker compose ps` shows Postgres and Redis up.
- Launcher **1** shows Account A/B **OFF**, and
  `Get-NetTCPConnection -State Listen -LocalPort 4001,4002` prints nothing.
- Stop any manually started scanner, emitter, planner or non-watch backend
  first, or Always-On will report them as `CONFLICT`.
- `pnpm install; pnpm build` once; the backend must be built for non-watch.
- If the emitter was down for days while the scanner ran, run the DRY emitter
  first (section 4).

1. **Clean start.** Launcher **16**, or `Always-On Monitoring.cmd`, or
   `monitoring:always-on run --emitter-activate-at-eof`.
   - `monitoring:always-on status` goes `STARTING` → `RUNNING` once the
     scanner's FAST_RECOVERY_V1 start-up (about 7 minutes) completes.
   - Scanner: `selected = liveEligible` (any size), `failed 0`, `stale false`.
   - Emitter pinned to the scanner's run id, `queue 0/10000`.
   - Planner `READY`, pending 0, Δ 0 (baseline recorded).
2. **Temporary network loss.** Disable the network adapter, or pull the cable,
   for about 10 minutes. (A machine-wide disconnect also cuts everything else on
   the machine. The process-local alternative is the operator drill, section
   12, run only under a separately approved procedure.)
   - Status: scanner `DEGRADED`, then `NETWORK_UNAVAILABLE` after the grace
     period.
   - Backend, emitter and planner stay `RUNNING`.
   - No process storm: `incidents.jsonl` has one `NETWORK_UNAVAILABLE` and no
     `ROLE_STARTED`.
   - `Get-NetTCPConnection -LocalPort 4001,4002` still prints nothing.
3. **Network returns.**
   - Either the scanner heals itself (back to `RUNNING`, no recovery), or,
     after 120 seconds, `SCANNER_RECOVERY_REQUESTED`.
   - Then `ROLE_STOPPED emitter`, `ROLE_STOPPED scanner`, `ROLE_STARTED
     scanner`, `SCANNER_RECOVERY_SUCCEEDED` (new run id) and
     `EMITTER_STARTED_ON_RUN`, pinned to the new run.
4. **Backlog drains.** Look for `LARGE_BACKLOG_DETECTED`, then
   `BACKLOG_DRAINED`. The emitter's `maxQueueDepth <= queueCapacity`, and the
   queue returns to 0.
5. **No duplicates.** soak-health `ledgerDuplicates` 0 in normal operation. The
   planner catches up: pending returns to 0 and Δ stays 0.
6. **Healthy again.** State `RUNNING`, a fresh `lastEndToEndHealthyAt`, no
   rebaseline, and no cursor deleted.
7. **Stop.** Launcher **18**, or `monitoring:always-on stop`. The journal shows
   `ROLE_STOPPED` for emitter, scanner, planner and backend, in that order, then
   `SUPERVISOR_STOPPED`.

After this passes, start a fresh, uninterrupted 24-hour Signal Quality
Observatory soak ([native-signal-quality-observatory.md](native-signal-quality-observatory.md)
§11) with Always-On running.

## 10. Known limitations and follow-ups

- **The first real-machine acceptance (2026-10-24) failed, and was fixed by
  `fix/always-on-scanner-stability`.** The causes:
  - stale symbol locks of a killed manual scanner, falsely held by a reused
    pid;
  - a first universe refresh scheduled after a long start-up while staleness
    counted from the run's start;
  - one quiet symbol awaiting its first stream update, read as two failures;
  - empty role logs, because a detached `cmd.exe` gives children a hidden
    console.

  The acceptance must be repeated.
- **Stop a manual scanner gracefully before starting Always-On** (Ctrl+C, so
  its run writes STOPPED and releases its symbol locks). A killed scanner's
  locks are reclaimed once its pid is gone, or proven to belong to a younger
  process.
- **No staleness policy for long-downtime backlogs** (section 4). Deciding one,
  for example requiring a rebaseline decision past a backlog age, is an
  operator follow-up.
- **The planner and backend are force-stopped** through the fenced stop, the
  same as the launcher's existing stops. Planner jobs stay in Redis and PENDING
  intents in the database.
- **The supervisor reads planner and plan health through the backend.** While
  the backend is down, planner health is `HEALTH_UNREADABLE` and it is left
  running.
- **A latched role needs `clear-latch`,** or a supervisor restart.
- **The scanner's run-wide REST budget** (`--max-total-requests`, default 4000)
  is consumed by universe refreshes and in-run recoveries. When it runs out,
  symbols fail and a fresh run (fresh budget) is started through the recovery
  path. Raise it with `--scanner-max-total-requests` if that happens too often.
- **The launcher-started supervisor has no console.** Use 17/18 or the CLI; for
  a console, use `Always-On Monitoring.cmd`.
- **Ownership writes are retried, not transactional.** If the supervisor dies
  after a spawn and before `ownership.json` could be written, that child is
  unrecorded. The next generation reports it as `CONFLICT` and never kills it.
- **The launcher's Always-On status line reads `ownership.json` leniently.** A
  transient read failure shows OFF for that refresh; the CLI reports
  `UNKNOWN`.
- **The runtime launcher's own process-tree queries** (pre-existing, outside
  Always-On) still replace only `|` in command lines. While any node.exe or
  cmd.exe has a line break in its command line, those launcher views report
  `UNPARSEABLE`. The Always-On adapter already removes CR and LF.
- **Unrelated, unchanged:** the TradingView adoption lease-theft finding and
  ENTRY_SUBMITTING recovery.
- **Three outages the REST probe could not see** (found by the simulated
  network, section 11) are resolved by `fix/always-on-recovery-resilience`
  (section 3):
  - a stream-only outage no longer spends attempts and latches the scanner;
  - a blip shorter than the grace period no longer costs a recovery;
  - a REST outage restored right after a refresh attempt waits for the next
    refresh.

  What remains:
  - **A half-open stream outage** (connections open, no data) answers the
    stream probe UNKNOWN by design (it cannot be told from a quiet stream), so
    it keeps the normal bounded recovery and latch.
  - **A REST outage longer than the scanner's 45-minute start-up deadline while
    a fresh run is starting** still fails that run when the deadline passes
    (pre-existing).
  - **The compact membership fallback** (a status without per-symbol detail)
    can offset a gap with a symbol that failed before placement; diagnostic
    only, and current scanners always write the detail. An exact fix needs a
    scanner-side count of placed failures.
  - **Recovery under real network faults is not proven on a real machine** —
    see sections 11 and 12. The operator drill (section 12) makes a
    process-local real-machine drill possible; it has not been run.
- **Every `monitoring:always-on` CLI process** (status, stop, clear-latch, and
  the drill controller while it waits for its verdict) matches the supervisor
  entrypoint, so a running supervisor reports it once as
  `EXTERNAL_MONITORING_PROCESS` (`OTHER_SUPERVISOR_RUNTIME`). This is
  pre-existing and report-only: nothing is stopped or started for it.

## 11. Network fault injection (test-only)

The real-machine acceptance's network step (section 9) disconnects the whole
machine. Its recovery contract is instead proven automatically, against the
real code, by a simulated public network. Nothing in production can select
it: it is a test helper handed explicitly, as transports, to the objects a
test constructs.

- **`tests/helpers/simulated-public-network.ts`**: one market, one fault state,
  three transports.
  - The scanner's REST is `UP`, `REFUSED` (as undici: `fetch failed`,
    `ECONNREFUSED`) or `TIMEOUT` (held for the CLI's full 20-second client
    timeout on the simulated clock).
  - Open streams are `UP`, `DROP` (error, then close 1006) or `SILENT`
    (half-open).
  - New streams are `UP`, `REFUSED` or `BLACKHOLE` (never open).
  - The connectivity probe's fetch follows the REST fault, which can be scoped
    to some paths (`restPaths`, e.g. only exchangeInfo).
  - The stream probe's socket follows the stream faults (`REFUSED` errors and
    closes, `BLACKHOLE` never answers, `SILENT` opens and says nothing), and
    every probe socket and its remaining listeners are recorded.
  - Every outage has a mandatory maximum duration (at most 6 hours) and
    restores itself at that deadline. `withOutage` restores in `finally`, and
    `dispose` restores and refuses any further use.
  - It serves only `https://fapi.binance.com` and the production-validated
    stream URL, and refuses anything signed, keyed or not a GET.
- **`tests/helpers/simulated-scanner.ts`**: a real `LiveShadowSupervisor` with
  the production CLI's own option values (FAST_RECOVERY_V1, dynamic universe,
  REST budget, real symbol locks) on a simulated clock. Its timers wake at
  their instants, so a backoff never skips network turns. By default it runs
  the production engine on 1D over a short timeline. Where the real emitter
  must bind the run, it uses the registered production profile, because the
  emitter refuses any other engine.
- **`tests/helpers/simulated-monitoring-machine.ts`**: the real Always-On
  supervisor (production policy) on the fake machine, owning **real** scanner
  processes and gating recovery on the **real** `publicBinanceReachable` and
  `publicStreamReachable`.
  - It can make a run's streams fail inside the scanner (a scanner-local fault,
    the network fine), and make the stream probe unconstructable or answered
    by something unreadable.
  - A cooperative stop runs the CLI's graceful stop. A fenced terminate kills
    the process: its network, sockets and timers end, and its locks stay on
    disk.
  - Every simulated second checks five things: at most one scanner process;
    locks held only by it, or stale; an emitter pinned only to a running
    scanner's run; monitoring roles only; nothing signed on the network.

Both probes take their transport as an optional parameter: `fetch` for
`publicBinanceReachable`, and the socket constructor and timers for
`publicStreamReachable`, each defaulting to the real one. Structural tests pin
that production calls both through the machine's probe functions, which pass
the real transport itself unless an active operator drill (section 12) gates
it. They also pin that no production module, environment variable or CLI
option can select a simulated transport, and that only the dedicated
`drill start` command can request a drill.

**What it does not prove:** real-machine network recovery (operating-system
sockets, DNS, TLS, Binance's own behaviour), and timings under real load. The
mechanism for a separately approved real-machine Gate 4A is the operator
network drill, section 12.

## 12. Operator network drill (the Gate 4A mechanism; engineered and tested, never run)

A drill fails the **public, unsigned market-data transports** of the ONE
scanner run the running supervisor owns, plus the supervisor's own two
connectivity probes, for a bounded while. The failure happens **inside those
processes**. Real Windows process ownership, fencing, recovery and restoration
can then be exercised on the real machine without touching its network. No
adapter, DNS, hosts, firewall, routing or proxy changes, no other process
affected.

It is never driven by an environment variable, a `run` or scanner option, a
route, the frontend or the launcher. It never reaches the backend, the emitter,
the planner, an account, a credential or anything signed. Native execution
stays hard-disabled.

### How it is isolated

- **Scanner side** (`native-scanner/public-transport-drill.ts`): a gate the
  scanner CLI builds **only** for a run Always-On spawned (it was given a
  cooperative stop file). It watches exactly one file, `<its stop file>.drill`,
  polls it every second and checks it on every transport use.
  - While a valid, current drill for **its own run id** is there, it wraps the
    scanner's real transports. These stay exactly the real `fetch` and
    `WebSocket`.
  - The wrappers can only **refuse, drop or silence**. No URL, host, header or
    redirect can be expressed: the file format refuses any unknown field.
  - A scanner started by hand has no stop file, so it has no gate at all.
- **Supervisor side** (`always-on/always-on-drill.ts`, the supervisor): it
  accepts the request and writes the drill file. Its two probes run their
  unchanged code over a gated transport. Outside an active drill they receive
  the real `fetch` / `WebSocket` itself.
- **Nothing else reads the drill.** Only the Always-On module and the scanner
  entrypoint import the drill modules (pinned by `always-on-drill-structure`).

### Explicit local authorization

```powershell
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on status        # read the generation and the scanner run id
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on drill start --fault PUBLIC_STREAMS_DOWN --duration-seconds 600 --generation 7 --run-id 20261025T030000Z-0a1b2c3d
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on drill status
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on drill restore   # end it now (idempotent)
```

`drill start` refuses unless the running supervisor is that generation and owns
that run. It writes one request, `requests\drill.json`, naming the generation,
the run, the fault, the duration and itself (pid and OS creation time), then
waits for the verdict.

The running supervisor consumes it once, and only after its file is gone. It
accepts it only if every check below passes, judged in this fixed order (the
first failure wins). Anything uncertain refuses, and every refusal is journaled
as `DRILL_REJECTED` with its reason.

| Check | Refusal |
| --- | --- |
| written at most 60 s ago | `REQUEST_EXPIRED` |
| not from the future | `REQUEST_FROM_FUTURE` |
| its id never used before | `REQUEST_REPLAYED` |
| this generation | `GENERATION_MISMATCH` |
| no stop in progress | `SHUTTING_DOWN` |
| no other drill active | `DRILL_ALREADY_ACTIVE` |
| no recovery in progress | `RECOVERY_IN_PROGRESS` |
| an owned, identified scanner | `NO_OWNED_SCANNER` |
| that scanner's run | `RUN_MISMATCH` |
| that run is healthy | `SCANNER_NOT_HEALTHY` |
| the controller is a live node process of THIS repository running exactly `run-always-on-monitoring.ts drill start`, with matching creation time | `CONTROLLER_UNOBSERVABLE` / `CONTROLLER_NOT_VERIFIED` |
| the real Windows ACL (`Get-Acl`, read every time) of the Always-On, `requests\` and `stop\` directories grants write access to nobody but this account, SYSTEM and Administrators | `DIRECTORY_NOT_PRIVATE` |

A malformed request is refused with its parse reason (`SCHEMA_INVALID`,
`FIELD_INVALID`, `FAULT_UNKNOWN`, `DURATION_OUT_OF_BOUNDS`).

Accepted, the drill file is written beside the owned scanner's stop file. It
names that run, the catalogue faults and the window. It is written under the
launcher's mutation lock with the generation fence re-checked
(`ALWAYS_ON_DRILL_START`), and journaled as `DRILL_STARTED`. The launcher's
mutation lock being busy refuses (`MUTATION_AUTHORITY_BUSY`).

**The trust boundary, stated plainly.** This is an operator-controlled test
feature, not a security boundary against software running as the operator.

- **What the checks stop:** other non-admin Windows accounts (the ACL), anything
  remote (there is no listener: the supervisor's `127.0.0.1:4019` mutex drops
  every connection), leftover request files (no live controller, the 60 s
  lifetime, generation and run binding), and accidental activation (no switch
  exists).
- **What they cannot stop:** code already running as the operator's own account,
  or as an administrator, can do anything the operator can.
  - It can run `drill start`, or request a drill itself. The controller check
    matches a process's shape (a node command line and its creation time). A
    look-alike local command passes it. It is **not** cryptographic
    authentication; it rejects leftovers and accidents, not an adversary.
  - It can write a valid drill file directly: the scanner's gate trusts a
    well-formed file naming its run id, and run ids are in the status files.
- **Planted files:** every pass, the supervisor reconciles the file at the owned
  scanner's drill path, including after a completed drill. A completed drill
  vouches for nothing.
  - A file the gate would apply (it names exactly this run) is removed and
    journaled (`DRILL_UNAUTHORIZED_FILE_REMOVED`). It can fault the scanner for
    up to one supervision pass, about 15 s.
  - A file the gate ignores (another run's, invalid) or that cannot be judged
    (unreadable, run not yet identified) has no proven owner. It is journaled
    once (`DRILL_STATE_INCONSISTENT`) and left in place; an accepted drill
    replaces it, and the next generation removes it.
  - The scanner reporting a drill this generation did not accept is journaled
    (`SCANNER_REPORTS_UNEXPECTED_DRILL`), shown by the status, and withdraws an
    earlier `restore CONFIRMED` until its own report shows nothing applied.
    The status is written every 60 s, so a fault shorter than that may never
    appear in a report.
- **Without a supervisor nothing removes a planted file.** The 900 s TTL applies
  **per drill, authorized or forged**: repeated forged files with fresh ids can
  keep a scanner faulted indefinitely. That costs market data, and the alerts it
  would have produced, but reaches no order path.

### Run and generation binding

- The drill file is per spawn: its name comes from that child's own stop file.
- It names the run id, a random id fixed by that scanner process at start; the
  scanner's gate ignores any drill for another run.
- A replacement scanner has a new stop file and a new run id, so it can never
  inherit a drill.
- The supervisor hands its probes the drill's faults only while the drill is
  active **and** its scanner child (pid and spawn sequence) is still the one it
  was written for.

### Finite duration and restoration

- **Maximum TTL: 900 s per drill** (minimum 10 s). The scanner enforces it
  itself. It ends the drill exactly at its expiry on the wall clock **and** on a
  monotonic deadline fixed at activation, so a wall clock moved backwards cannot
  extend it. A file that is gone, unreadable or invalid ends it (fail-safe: inactive).
  An ended drill id never comes back. **None of this needs the supervisor or
  the controller to stay alive.**
- **The supervisor ends a drill exactly once**, at the first of:

  | End reason | When |
  | --- | --- |
  | `EXPIRED` | checked first in every pass, so it wins a same-pass race |
  | `OPERATOR_RESTORE` | `drill restore`: honoured even unparseable, and by any running generation, because it can only end a fault; idempotent |
  | `SHUTDOWN` | before anything is stopped |
  | `DETACHED` | the console was closed |
  | `FENCED` | a newer generation owns the stack; only this generation's own file is removed |
  | `RUN_ENDED` | the scanner child exited or was replaced |
  | `CLOCK_ROLLBACK` | the wall clock moved back by more than 5 s against the monotonic clock: the drill's times can no longer be trusted |
  | `FILE_REMOVED_EXTERNALLY` | the drill file disappeared |
  | `SCANNER_ENDED` | the drilled run's own status, written after the drill started, shows it no longer applies the drill: its fail-safe gate ended it (e.g. on a file it could not read), or, after confirming it, it moved on to another drill (the file was overwritten). The probes are never left drilled on evidence that no longer holds, and a restore is confirmed only once that run reports nothing applied |

- **The supervisor measures a drill's lifetime on a monotonic clock too.** A
  rollback ends the drill at once and drops any probe answer cached under the old
  clock. Only a status written since then counts as evidence, and the
  confirmation windows run on the monotonic clock, so nothing waits for the wall
  clock to catch up. A correction of 5 s or less changes nothing. A rollback is
  noticed at the next pass. This covers the drill only: the supervisor's other
  timers (for example the degraded grace period) still use the wall clock and can
  be delayed by a rollback, drill or no drill.
- **A new generation removes every leftover drill file at start**
  (`DRILL_STALE_REMOVED`). A crashed supervisor's drill therefore ends within a
  second of the next start, and at its TTL in any case.
  `drill restore` also removes leftover drill files when no supervisor runs.
- **Ending removes the drill file** and records whether it is provably gone. A
  file that cannot be removed is retried every pass and reads `REMOVAL_FAILED`.
- **Confirmation comes only from the scanner's own status** of the drilled run,
  written after the event (or, for a restore, from the drilled process having
  ended). Without it within the status freshness window (180 s) the drill reads
  `UNCONFIRMED`. **A restore is never claimed without evidence.** Another
  drill's report proves nothing unless this drill was first confirmed applied,
  and then only if that other drill is no longer applied.
- Restoration never touches a scanner lock, cursor, checkpoint, ledger or
  incident.

### Faults

| Fault | Scanner | Supervisor probes | Expected recovery path |
| --- | --- | --- | --- |
| `PUBLIC_REST_DOWN` | REST refused | REST probe refused | REST outage: `NETWORK_UNAVAILABLE`, nothing restarted; after the restore the heal window and the R3 universe extension |
| `PUBLIC_STREAMS_DISCONNECT` | open streams dropped once | untouched | the scanner reconnects by itself |
| `PUBLIC_STREAMS_NEW_REFUSED` | new connections refused | stream probe refused | invisible until a reconnect is needed |
| `PUBLIC_STREAMS_DOWN` | open dropped + new refused | stream probe refused | R1 hold (`PUBLIC_STREAM_UNREACHABLE`), nothing spent; heals after the end |
| `PUBLIC_ALL_DOWN` | REST + streams | both refused | combined outage; a short one (< 90 s) costs nothing (R2) |
| `PUBLIC_STREAMS_HALF_OPEN` | streams silent | stream probe silent (UNKNOWN) | UNKNOWN never holds: the normal bounded recovery; the fresh run is not drilled |
| `SCANNER_LOCAL_STREAMS` | open dropped + new refused | untouched (REACHABLE) | a scanner-local fault: ONE ordered recovery; the drill ends with the old run |

### What a drill can prove, and what needs separate evidence

**It can prove, on the real machine:**

- the real supervisor's ownership, fencing, cooperative and fenced stops;
- the real recovery sequence (emitter stopped first, a fresh run, the emitter
  re-pinned) and its backoff accounting;
- the R1/R2/R3 decisions on real status files and real probes;
- real restoration: after the drill the very same real `fetch` and
  `WebSocket` reconnect to Binance;
- real logs, journal and status artifacts.

**It does NOT prove:**

- operating-system failures: adapter down, DNS failure, TLS errors, routing,
  proxy, sleep and resume on a network change;
- Binance-side failures: 5xx, 418/429, partial outages, slow handshakes;
- REST **timeouts** (a drill refuses at once; a held connection is not
  simulated);
- failures of the backend, emitter, planner or database during an outage;
- latch exhaustion by a persistent scanner-local fault. A drill never survives
  a run replacement, so it proves one recovery cycle, not six;
- a half-open outage the probe can *confirm*: by design it reads UNKNOWN.

These need their own evidence (the simulated network of section 11 covers
timeouts, half-open sockets and latching against real code).

### Known limits, none blocking a first supervised drill

Each of these needs deliberate action as the operator's account, or an already
wrong profile, and is bounded as stated.

- **A file overwriting an active drill before its activation is confirmed** is
  not noticed until that drill ends. It is journaled if the scanner reports it,
  and removed with the drill's own file.
- **A second drill can be accepted while the first's file removal is failing.**
  That drill's restore evidence is then lost; the new file replaces the old one.
- **The ACL check** does not look at the directory owner or at parent folders,
  and happens only when a request is judged. The scanner never checks ACLs.
- **File handling:** symlinks are followed, the drill file is read synchronously
  with no size limit, and `existsSync` reads any error as "gone" (a removal
  could be recorded as done; the restore still needs the scanner's evidence).

### Operational precautions before a real drill

- Only with a separately approved procedure.
- Start from `RUNNING` with every role healthy, Account A/B **OFF**, nothing
  listening on 4001/4002, and no manual scanner, emitter or planner.
- Use the generation and run id from `monitoring:always-on status`
  immediately before.
- Prefer short durations first (`PUBLIC_ALL_DOWN` 60 s, then
  `PUBLIC_STREAMS_DOWN` 600 s).
- Keep `drill restore` ready.
- After each drill:
  - read `drill status` for `restore CONFIRMED`;
  - `stop\*.drill` must be empty;
  - in the journal, `DRILL_STARTED` and `DRILL_ENDED` should be the only drill
    lines (no `DRILL_UNAUTHORIZED_FILE_REMOVED`, no `UNCONFIRMED`);
  - expect no cursor rebaseline and `ledgerDuplicates` 0.
- Expect real Binance traffic to resume at the end: the restore is real.

## Tests

- `tests/native-emitter-bounded-catch-up.test.ts`: a backlog of 3× to 12× the
  queue, fairness, COMMIT ordering, ledger failure, graceful stop, crash and
  restart, refused lines.
- `tests/native-emitter-bounded-catch-up.integration.test.ts`: the real
  delivery ledger on the `_test` database.
- `tests/always-on-supervisor.test.ts`: the supervisor end to end on a fake
  machine (matrix items 7 to 18 and more).
- `tests/always-on-supervisor-resilience.test.ts`: regressions from the
  adversarial review, among them: a held or unreadable `ownership.json`; an
  unexpected error in a pass; adoption across checkouts; restart accounting;
  sleep timers; wrong-engine runs; post-network grace for a fresh run;
  excluded roles; and emitter start-up.
- `tests/always-on-machine.test.ts`: the real adapters without starting
  anything long-lived. It covers file-system retries and strict reads, line
  breaks in process command lines, run-time spawn failures, and the
  supervisor's own identity.
- `tests/native-shadow-log-memory.test.ts`: an unchanged log is held once,
  not twice.
- `tests/always-on-units.test.ts`: the pure judges, plans, census, ownership,
  instance lock, journal, startup task, CLI and launcher controls.
- `tests/always-on-structure.test.ts`: the AST closure has no database, env,
  exchange client or execution module; spawn and terminate happen only through
  the fenced primitives; no route and no migration.
- `tests/always-on-network-fault-harness.test.ts`: the simulated network itself
  (each fault changes transport behaviour; fail-safe restoration; refusals),
  the real probe over it, and that production cannot select it.
- `tests/native-scanner-network-faults.test.ts`: the real scanner under REST-only,
  stream-only, half-open, short, sustained and timing-out outages, judged every
  second by the real health judge.
- `tests/always-on-network-recovery.test.ts`: the supervisor's recovery contract
  end to end over the simulated network, including a hung scanner, a 45-minute
  stream-only outage, a scanner-local stream fault, uncertain stream probes, a
  sub-grace blip and a stale universe after a REST outage.
- `tests/native-emitter-network-recovery.test.ts`: the real emitter across an
  outage and a scanner recovery (cursors, replays, queue bound, every key once).
- `tests/always-on-stream-probe.test.ts`: the public stream probe's outcomes, its
  cleanup on every path, the production endpoint and the absence of a switch.
- `tests/always-on-stream-gate.test.ts`: when a stream outage holds a recovery
  (both signals agree) and when it never does (uncertain, stale, another run's
  answer, another issue, a connection still delivering).
- `tests/always-on-fresh-evidence.test.ts`: a recovery rests on a status written
  after the grace deadline; a missing or stale status is never delayed.
- `tests/always-on-universe-heal.test.ts`: a stale universe after a confirmed
  restore waits for the scanner's next refresh, capped; anything untrustworthy
  or additional keeps the existing window.
- `tests/public-transport-drill.test.ts`: the scanner's drill gate and
  transports. It covers:
  - the file format and its refusals;
  - activation, exact expiry and the monotonic bound;
  - fail-safe ends;
  - REST refused like a dead network, never forwarded;
  - streams dropped, refused or silenced.
- `tests/always-on-drill.test.ts`: the fault catalogue, strict request parsing,
  the fixed-order judgement, the controller check, the ACL judge, and the real
  probes over the drilled transports.
- `tests/always-on-drill-supervisor.test.ts`: the drill in the real supervisor
  on the fake machine. It covers:
  - every refusal, and activation under the mutation lock;
  - the TTL, idempotent restore, removal failure and unconfirmed states;
  - shutdown, detach, fencing and next-generation cleanup;
  - a replaced run, a planted file, races and the audit trail.
- `tests/always-on-drill-structure.test.ts`: no switch anywhere (environment,
  `run`, scanner, startup task, route, frontend, launcher); only the allowed
  importers; and the real CLI without a supervisor.
- `tests/always-on-drill-recovery.test.ts`: the drill end to end over real
  scanner processes and the real probes. It covers R1, R2 and R3, a
  scanner-local fault, half-open, a scanner dying mid-drill, and a graceful
  stop mid-drill.
