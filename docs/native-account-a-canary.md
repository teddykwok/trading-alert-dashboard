# Native Account A canary (Milestone 4)

This milestone builds the path a Native (scanner-produced) plan would take to
reach Account A's **existing** executor. It does not let anything trade.
Native execution stays hard-disabled in code, and every Native candidate is
refused before any signed or private exchange request.

- `NATIVE_EXECUTION_ENABLED` is `false as const` in
  `apps/backend/src/modules/native-canary/native-execution-switch.ts`. No env
  variable, profile, policy row, route or UI control can change it. Flipping it
  is a reviewed code change.
- The Native adoption scheduler is wired into the account worker but is
  dormant. It returns `null` and builds nothing unless the switch is on **and**
  the process is exactly Account A.
- No schema change, no migration, no new route and no UI control.

---

## The path

```
Native READY plan
  -> Account A Native adoption (claim per plan+profile, durable)      native-account-a-adoption.ts
  -> decideNativeAccountACandidate: the stages below, then the fence    native-account-a-canary.ts
  -> SelectedPlanExecutor.handleNativeAccountACandidate                selected-plan-executor.ts
       fence again, BEFORE the margin planner's signed reads
       same margin planner -> same creation -> same orchestrator admission
  -> createExecutionFromReadyPlan: NATIVE only with an issued hand-off  execution.service.ts
  -> Phase 5 SafetyAdmission (unchanged, authoritative)
  -> EntryLifecycleService: fence F0 / F2 / F3                          entry-lifecycle.service.ts
  -> existing protection machinery (unchanged)
```

### The decision stages

`decideNativeAccountACandidate` is pure. The caller loads the facts, and the
first refusal wins and names its stage.

| Stage | Passes only when | Refusal codes |
| --- | --- | --- |
| `ACCOUNT` | The process is exactly Account A, and the policy offered is Account A's. | `ACCOUNT_NOT_A`, `AMBIGUOUS_STATE` |
| `SOURCE` | The alert source is exactly `NATIVE`. | `SOURCE_NOT_NATIVE` |
| `SOURCE_TIMEFRAME` | The source timeframe is exactly `1D` or `1W`, and the payload agrees with the column. | `SOURCE_TF_NOT_EXECUTABLE`, `AMBIGUOUS_STATE` |
| `PLAN` | It is the alert's own READY plan; Account A's code-fixed 100-candle window equals the window the plan persists; that window has one candidate, with complete history, valid, money-carrying, with a template. | `PLAN_NOT_READY`, `PLAN_INCOMPLETE`, `PLAN_NOT_FOR_ALERT`, `ACCOUNT_PLAN_UNRESOLVED`, `PLAN_LOOKBACK_MISMATCH`, `AMBIGUOUS_STATE` |
| `INTEGRITY` | The source bar's final scanner evidence is `ELIGIBLE`. | `INTEGRITY_PENDING_BAR_CLOSE`, `INTEGRITY_INELIGIBLE`, `INTEGRITY_UNREADABLE` |
| `OCCUPANCY` | No local execution holds this symbol and side, and nothing on the symbol is ambiguous. | `SAME_SYMBOL_SIDE_OCCUPIED`, `AMBIGUOUS_STATE` |
| `ACCOUNT_GATES` | The runtime is `LIVE_READY` and the profile is `ARMED`. | `ACCOUNT_NOT_LIVE_READY`, `ACCOUNT_NOT_ARMED` |
| `NATIVE_FENCE` | `judgeNativeExecutionAdmission`, with the hard-coded switch, admits. | `NATIVE_EXECUTION_DISABLED`, `NATIVE_INTEGRITY_NOT_ELIGIBLE` |

`INTEGRITY_INELIGIBLE` refusals carry the canonical integrity status, for
example `INELIGIBLE_REQUARANTINED`. The runtime-mode and trading-state
vocabularies are the canonical ones; a test holds them equal to
`effectiveModeFromWire` and `mapTradingSystemState` on every input.

Some gates are not re-implemented here: the natural-window claim, the session
budget, capacity limits and risk admission. A Native execution would meet them
in the existing Phase 5 SafetyAdmission, under its own lock and with its own
reason codes.

### The hand-off

A `NativeAccountAHandoff` is the capability that both the executor's Native
entry point and creation demand.

- It is deep-frozen.
- It is recognised by identity alone (a module-private `WeakSet`).
- It is issued in exactly one place: `decideNativeAccountACandidate`, after the
  fence admits.

Because the switch is `false`, no hand-off can exist, so no Native
`TradeExecution` can be created. A structurally perfect forgery is refused.

## Where the fence is asked

Every ask is a fresh judgment: the hard-coded switch, then the source bar's
evidence re-read from disk. No verdict is carried forward from upstream.

| Where | Before |
| --- | --- |
| Adoption decision (`NATIVE_FENCE` stage) | anything is handed to the executor |
| `handleNativeAccountACandidate` | the margin planner's signed `account` / `leverageBracket` reads |
| Creation | a Native row can exist (an issued hand-off, valid while the switch is on, is required) |
| Entry lifecycle **F0** | revalidation's signed reads and any reservation |
| Entry lifecycle **F2** | margin/leverage configuration reads and writes |
| Entry lifecycle **F3** | **each** `setIsolatedMarginType`, `setInitialLeverage` and `submitLimitEntry`, with nothing awaited in between |

The fence recognises a Native execution in two ways:

- the alert's own source;
- the `alertSource: "NATIVE"` marker that creation writes into the
  `EXECUTION_CREATED` event in the same transaction, so the row stays
  recognisable after retention nulls `alertId`.

A row whose two facts contradict each other is refused as
`NATIVE_SOURCE_AMBIGUOUS`. For a TradingView execution the fence does not
apply, and nothing on the TradingView path changes.

Risk-reducing work is deliberately left unfenced, exactly as the live gates
leave it. That covers the reconcile GET of an already-reserved order, TTL or
operator cancellation, and protection of an existing fill.

## Account A, and what "100" means

The process's account comes from its launch file. Account A is exactly
`<LOCALAPPDATA>\trading-alert-dashboard\env\account-a.env` (the launcher's
contract in `dual-account-topology.ts`). Anything else is `ACCOUNT_B`,
`GENERIC` or `UNKNOWN`. There is no default and no fallback.

Account A's plan is the candidate for its planner **lookback window**, which is
fixed in code at 100 candles (`NATIVE_PLAN_BUILTIN_DEFAULTS.A`). It is never a
dollar amount: the risk budget is still the plan's own frozen template
(`riskAmount`), exactly as for TradingView.

A READY plan persists candidates for every window and one selected window
(`selectedLookback`, from the generic `EXTREME_RR_LOOKBACK_CANDLES` at
generation). It persists no per-account window: the A/B defaults on Trading
Control are computed at read time from the generic process's settings. So that
no process environment can steer execution:

- `nativeAccountAExecutionPolicy` gives the built-in 100 and nothing else. An
  account-process `NATIVE_PLAN_DEFAULT_LOOKBACK_A` that agrees with it changes
  nothing; any other value is refused (`ACCOUNT_PLAN_UNRESOLVED`), so a
  misconfigured `account-a.env` is visible rather than obeyed or ignored.
- The decision refuses any policy that is not that built-in, however it was
  built.
- The plan's **persisted** window is authoritative: Account A refuses
  (`PLAN_LOOKBACK_MISMATCH`) unless `plan.selectedLookback` is also 100. It then
  executes the plan's own frozen candidate for that window.

## Occupancy

There may be at most one active or pending execution per symbol and side for
the profile. A resting LIMIT (`ENTRY_PENDING`) counts, and so does
`PLAN_READY`. Occupancy is read from durable local state only:

- an unread state is never treated as free;
- the following on the same symbol are `AMBIGUOUS_STATE`, whichever side they
  are on:
  - `MANUAL_INTERVENTION` or the manual flag;
  - a `BOTH` position side, or a direction that disagrees with its position
    side;
  - an unknown status;
  - a finished row whose entry order may still be live.

"No row" proves only that nothing local holds the slot. Exchange exposure is
still checked by the existing signed revalidation, which also refuses any
other local execution on the symbol, on either side. That rule is stricter
than this one, and it is unchanged.

The candidate's own execution (same alert) is never its occupant, so a retry
finds its execution instead of being refused by it.

### Where occupancy is serialized

The adoption claim is per **plan**, so it cannot stop two different plans for
the same account, symbol and side (a 1D and a 1W touch on one bar) from both
passing the decision's occupancy check, which is only a read. Occupancy is
established by the `TradeExecution` row, and exactly one place creates one:
`createExecutionFromReadyPlan`. Its Native branch calls
`reserveNativeOccupancy` inside the creating transaction, immediately before
the insert. That function:

1. takes `pg_advisory_xact_lock(0xa7e1, key(profile, symbol, side))`;
2. re-reads occupancy under the lock;
3. throws `NativeOccupancyConflictError` unless the slot is free.

The second of two racing creations therefore re-reads after the first
commits. At most one establishes occupancy, and the executor turns the loser's
conflict into a terminal `SAME_SYMBOL_SIDE_OCCUPIED` refusal before admission.
A concurrency test drives two workers and two such plans to the creation
boundary at the same moment. TradingView creation does not take this lock;
Phase 5's profile lock (`SYMBOL_SIDE_ALREADY_ACTIVE`) and the entry
lifecycle's symbol-level exclusion still govern every execution.

## Durable intent

Native adoption uses the existing per-account model: one `SelectedPlanAdoption`
row per (plan, profile).

- A unique-index INSERT wins the claim.
- A reclaim of an expired lease is fenced on `attempts` **and** on the lease
  really being expired (`claimedAt` older than the lease). Discovery's
  relation read is a separate query from its WHERE, so it can return a claim
  another worker made a moment ago; without the staleness fence a reclaim
  would steal that live lease and the plan would be evaluated twice at once.
- The verdict is terminal.

A retry, a restart or a second worker never produces a second intent. A source
bar that is still `PENDING_BAR_CLOSE` is deferred: nothing is written, and a
later pass decides it.

## What did not change

- `handleSelectedPlan`, the TradingView adoption pass, the TradingView fence
  and Phase 5 are untouched.
- TradingView creation still runs the original `assertExecutableAlertSource`
  line on every path that carries no hand-off.
- The entry lifecycle's TradingView decisions are unchanged. The fence returns
  "does not apply". Each ask costs two local database reads (the alert's source
  and the creation event), plus one row lookup at F0. It makes no exchange
  request.

## Known limits to resolve before any real canary

1. **Signal age versus bar close (product decision, not changed).** Signal age
   is measured from `Alert.triggeredAt`, the exchange event time of the
   intrabar touch, frozen as `TradeExecution.signalTriggeredAt`. The limit is
   300 s: `EXECUTION_MAX_ALERT_AGE_SECONDS`, min-merged with the policy's
   `maxAlertAgeSeconds` in Phase 5. It is enforced by adoption discovery,
   Phase 5 (`ALERT_STALE`), entry revalidation and PREFLIGHT release. A bar
   becomes `ELIGIBLE` only once the scanner commits it, on the stream's closed
   kline: bar open + 15 min + a few seconds. So only touches in roughly the
   last 5 minutes of a bar (under about a third) can ever execute. Touches in
   the first ~10 minutes never can, and candidates that age out while deferred
   leave no recorded reason. The recommended direction is a Native-only
   freshness rule anchored on the source bar's close (derived from the alert's
   immutable `barStart`, so it is deterministic and replay-safe), with a
   bounded post-close window and an independent absolute cap.
2. **Per-account windows are not persisted.** Account A executes only when the
   plan persists 100 (today's generic `EXTREME_RR_LOOKBACK_CANDLES`), otherwise
   it refuses. A generic-process `NATIVE_PLAN_DEFAULT_LOOKBACK_A` preview
   override other than 100 would show a window execution never uses (display
   only). Executing a per-account window that differs from the plan's
   selection (Account B's 300, for example) needs that window persisted with
   the plan, which is a schema change.
3. **A refusal after reservation.** Once the switch is on, an F2/F3 refusal
   after reservation would leave `ENTRY_SUBMITTING` with nothing sent. That
   blocks the profile (`RECOVERY_REQUIRED`) until the existing entry-recovery
   CLI releases it. This is unreachable today, because F0 refuses before any
   reservation.

## Tests

- `apps/backend/tests/native-account-a-canary.test.ts` (pure and structural)
  covers:
  - every stage and reason code;
  - every integrity status, from the real evaluator;
  - occupancy;
  - gate vocabulary equivalence;
  - hand-off forgery;
  - account slot resolution;
  - that every exposure-increasing call site is immediately preceded by the
    fence;
  - a dormant scheduler;
  - mutation sensitivity: with the switch mocked `true` in a test module graph,
    the same input is admitted.
- `apps/backend/tests/native-account-a-canary.integration.test.ts` runs on the
  `_test` database with trap adapters. It covers:
  - durable, idempotent adoption (retry, restart, race, lease, deferral);
  - Account B;
  - occupancy from real rows;
  - the creation fence;
  - F0 and F2 on hand-written Native rows, with zero mutations;
  - Phase 5 still refusing;
  - a plan that persists a window other than 100 being refused.
- `apps/backend/tests/native-account-a-canary-concurrency.integration.test.ts`
  races two Native candidates for one account, symbol and side (two workers,
  and repeated creation pairs). At most one establishes occupancy, and the
  loser fails closed. It also covers the lease-theft guard, keying by side and
  symbol, and idempotent retry. Each test mutates the switch to `true` in a
  test-only module graph; nothing can reach an exchange.
- `apps/backend/tests/native-account-a-canary-isolation.integration.test.ts`
  uses the production composition with sentinel credentials, counting HMAC
  signing, requests and mutation transport:
  - a fresh disabled candidate produces zero of each;
  - a historical reserved Native execution makes only its own risk-reducing
    order lookup.
