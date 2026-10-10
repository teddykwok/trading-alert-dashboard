# Native emitter production-cursor rebaseline

`NATIVE_EMITTER_CURSOR_REBASELINE_V1` is an explicit operator command that
advances the Native multi-symbol emitter's **production delivery cursors** to
the exact durable end of one **stopped** scanner run's shadow logs. Native
delivery then resumes after that point, and the old backlog is never delivered.

> **REBASELINE IS NOT A SCANNER RESET.**
> It never touches scanner checkpoints, shadow logs, engine state, lineage,
> the engine fingerprint or the namespace. Strategy state stays authoritative
> and untouched. It changes **delivery state only**.

It never:

- evaluates a record for delivery (no winner, no eligibility, no delivery
  selector);
- creates an Alert;
- opens a database;
- publishes to the dashboard or requests a plan;
- touches a queue, Binance or an account;
- changes Native execution, which remains hard-disabled.

## Why it exists

A COMMIT emitter attempt against the healthy 525-symbol universe failed closed:
`EMITTER_QUEUE_OVERFLOW: BSBUSDT would put 10001 records in a queue bounded at
10000`.

- It created nothing and wrote no cursor.
- A read-only dry run with a 100,000 queue showed why: 53,851 records since the
  production cursors, **2,408 would-create**, including real 1D/1W/1M events
  from days earlier.
- The lanes were already activated, so `--activate-at-eof` (which applies only
  to a lane with no production cursor) does not help.

Delivering that backlog would flood the dashboard and planning with stale
Alerts.

**Never brute-force a stale backlog by raising `--queue-capacity`.** The
10,000 default is a guard, and it worked. The emitter's defaults and overflow
behaviour are unchanged. Nothing rebaselines automatically: not on overflow,
not on start-up.

## What it does, exactly

**1. Binding.** It binds to exactly the lanes the normal emitter would bind for
the pinned run, using the same code: `bindPinnedRun` and `bindLaneSpec`.

- Profile, run id, engine fingerprint, market, chart interval, per-lane lineage
  and checkpoint identity must all match.
- With `DYNAMIC_UNIVERSE_V1` it adds every valid later `JOINED`/`REACTIVATED`
  record from the run's hash-chained membership journal, through the same
  journal parser.
- `INACTIVE`/`QUARANTINED` records never create a lane.
- An invalid journal, or one that ends in a partial line, refuses everything.
- Unicode symbols keep their exact identity and their encoded `u-<hex>` paths.
- The lane set is never truncated.

**2. Run fencing.**

- The pinned run's own `status.json` must say `runState: STOPPED`. RUNNING,
  missing or unreadable status refuses.
- **Dry run** inspects each lane's scanner lock (`live-shadow.lock`) read-only.
  A lock whose owner process is alive refuses; a lock whose owner is gone is
  stale and is not a writer.
- **Commit** takes every lane's scanner lock itself, through the repository's
  pid-owned lock primitive, plus one rebaseline lock per cursor namespace. While
  it works, no scanner can append to any lane and no second rebaseline can run.
- Old `RUNNING` status files of *other* runs are never consulted, so they
  cannot create false ambiguity.

**3. EOF.** EOF is the end of the last **complete** record, through the
emitter's strict shadow-log reader. The operation is refused if any of these
hold:

- the final record is partial (torn);
- the tail is malformed;
- the log is missing or unreadable;
- the lineage does not match;
- a cursor is beyond EOF;
- the log no longer matches the bytes a cursor consumed;
- a cursor position is not on a record boundary.

Unknown is never treated as absent.

**4. Cursors** (the existing `teddy.native-alerts.emitter-cursor.v1` schema; no
new field):

| Lane | Action | Change |
| --- | --- | --- |
| cursor behind EOF | `WOULD_ADVANCE` → `ADVANCED` | only `consumedChars`, `consumedSha256` and `updatedAt` change; `activationChars`, `activatedAt` and `activatedByRunId` keep their original first-activation meaning |
| cursor at EOF | `ALREADY_AT_EOF` | none |
| no cursor | `WOULD_INITIALIZE` → `INITIALIZED` | a first activation **at EOF**, exactly what `--activate-at-eof` does; nothing before it is ever delivered |
| cursor beyond EOF | refused | — |

The rebaseline cutoff itself is recorded in the audit evidence, not in the
cursor.

## Safety model

**Dry run (the default) writes nothing at all:** no cursor and no audit file.
It prints:

- profile, run, fingerprint and run state;
- final accepted symbols;
- existing and missing cursors;
- `alreadyAtEof`, `wouldAdvance`, `wouldInitialize`;
- total old cursor characters and total proposed EOF characters;
- the largest backlog lanes (`--top N`; every lane with `--verbose`);
- the **plan hash**.

`--json` prints the full machine-readable plan to stdout.

**Commit** requires `--commit-rebaseline --expect-plan-sha256 <plan hash from
the dry run>`. It applies only that exact plan. If any durable fact changed
since the dry run, the plan hash differs and the commit is refused
(`PLAN_CHANGED`) before anything is written.

## Transaction and crash safety

Evidence lives under the scanner state root, outside the repository:

```
native-emitter/rebaseline/<profileId>/<engine prefix>/<market>/<interval>/<operationId>/
  plan.json         immutable: the plan body, its SHA-256, operation id, createdAt
  before/<lane>.json exact prior cursor bytes (lanes that had a cursor)
  transaction.json  PREPARED -> COMMITTING -> COMMITTED (or RECOVERY_REQUIRED + why)
  result.json       per-lane outcome, totals, "Alerts created 0, database NO, Binance NO"
```

1. Every lane is preflighted before the first write. One bad lane refuses the
   whole operation.
2. `plan.json` and `before/` are created exclusively and never overwritten.
   Then the transaction is `PREPARED`.
3. `COMMITTING`: lanes are written in order. Each lane's file is replaced
   atomically (temp file, fsync, rename). Immediately before each write the
   lane must still be exactly its planned prior cursor, and its log exactly the
   planned bytes.
4. All lanes are re-verified at their targets. Then `result.json` is written
   and the state becomes `COMMITTED`.

Each lane's target cursor is a pure function of the plan and the operation's
`createdAt`. So after any interruption, every lane is provably either untouched
(its before bytes) or done (its target bytes).

**If a commit is interrupted:**

- Any further dry run, or any commit with a different plan, is refused. It
  reports the open operation and its plan hash. A different operation never
  starts beside it.
- Rerun the commit with **the same** `--expect-plan-sha256`. It resumes that
  operation: it verifies the before-snapshots, skips lanes already at their
  target, writes the rest, and marks it `COMMITTED`.
- A lane that is neither its before bytes nor its target bytes, or a log that
  changed, makes the operation `RECOVERY_REQUIRED`. It is recorded durably, the
  file is never overwritten, and it needs an operator's investigation. There is
  deliberately no automatic restore command.

**Idempotent:** after a commit, a dry run shows every lane `ALREADY_AT_EOF`. A
commit of that plan is a `NOOP` that writes nothing.

## Command

```
DOTENV_CONFIG_PATH=<generic env file> pnpm --filter @trading-alert-dashboard/backend \
  native-alerts:rebaseline-cursors --profile teddy-7-all-active --run-id <STOPPED run id> \
  --expect-engine-fingerprint 35f1a32d82ac2786ee67dd4c5146760bf1f29d5025cafe01da5394b79a9b47fb
# then, after reviewing the dry run:
  ... --commit-rebaseline --expect-plan-sha256 <plan hash>
```

It is a generic process. Its first import is `bootstrap-generic`, which refuses
to start if any account credential is reachable.

## Intended operator flow (documentation only; not run as part of this change)

1. Stop the scanner cleanly. The run's `status.json` must say `STOPPED`.
2. Run the rebaseline **dry run** against that pinned run.
3. Inspect the summary: lanes, would-advance, would-initialize, backlog, plan
   hash.
4. Run the rebaseline **commit** with `--commit-rebaseline
   --expect-plan-sha256 <hash>`.
5. Run the dry run again. Expect `wouldAdvance 0`, `wouldInitialize 0`, and
   every lane at EOF.
6. Start a **new** scanner supervisor run.
7. Wait for full Native readiness: selected 525, live 525, quarantined 0,
   awaiting 0, recovering 0, failed 0, pending 0.
8. Keep the Native planner READY.
9. Start the normal multi-emitter COMMIT, pinned to the **new** run, with
   `--commit-dashboard-alerts --activate-at-eof --follow`.
10. Only new, post-cutoff live Native events can be delivered.
11. Validate: Alert → READY plan; 0 duplicates, 0 adoptions, 0 executions,
    0 orders.

Native execution remains disabled throughout.
