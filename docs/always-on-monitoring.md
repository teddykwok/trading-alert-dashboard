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
- `failed`, `recovering`, `awaitingStream` and `catchupPending` are all 0;
- `liveEligible + quarantined = selected`;
- the newest market message is under 3 minutes old;
- the REST budget is not halted (418/429).

Quarantine of the current bar is normal after a start or reconnect. It reads
WARMING, and becomes degraded only after 35 minutes. Reconnect and
backpressure counters are reported but never trigger a restart on their own.

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
2. After the grace period, one unsigned public request (`GET
   https://fapi.binance.com/fapi/v1/time`, at most every 30 seconds) checks for
   the network.
   - **Unreachable:** nothing is restarted, no attempt is spent, and the state
     reads `NETWORK_UNAVAILABLE`.
   - **Reachable again:** the scanner gets 120 seconds to heal itself. So does
     the fresh run of a recovery that is still starting up.
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
| `monitoring\always-on\requests\` | `stop.json` / `clear-latch.json`, consumed by the running supervisor |
| `monitoring\always-on\stop\` | One cooperative stop file per spawned scanner/emitter |
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
`OWNERSHIP_WRITE_FAILED` and `SUPERVISOR_TICK_FAILED`.

## 7. Commands

```powershell
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on run [--emitter-activate-at-eof] [--roles backend,scanner,emitter,planner]
     [--poll-seconds 15] [--degraded-grace-seconds 90] [--max-recovery-attempts 6] [--emitter-queue-capacity 10000]
     [--scanner-max-total-requests N] [--scanner-status-every-s N] [--profile teddy-7-all-active] [--backend-url http://127.0.0.1:4000]
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on status [--json]
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on stop [--wait-seconds 600]
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on clear-latch [--role scanner]
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on startup-task [--emitter-activate-at-eof] [--write]
```

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
   for about 10 minutes.
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

- **Not yet validated against the real machine.** The behaviour is proven with
  a fake process table, file system and clock, and the emitter catch-up also
  against the real Postgres ledger. The acceptance procedure above has not been
  run.
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
