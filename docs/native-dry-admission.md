# Native dry admission (Milestone 6)

`NATIVE_DRY_ADMISSION_V1` answers one question about a Native (scanner-produced)
Account A candidate:

> If this candidate were evaluated now, which admission stages pass, which
> stage is the authoritative production blocker, and what would the pure gates
> after it say?

It is **observation only**. It holds no execution authority, issues no
hand-off, writes nothing, reads nothing on its own, calls no exchange and
starts nothing. Production Native execution stays OFF:
`NATIVE_EXECUTION_ENABLED` is still `false as const`, and the Native risk
contracts for Account A and Account B are still `UNRESOLVED`. M6 adds no
schema change, migration, route, CLI, UI control, environment variable or
runtime role. TradingView execution is untouched.

The module is `apps/backend/src/modules/native-canary/native-dry-admission.ts`.
It is a library; no production module imports it, and only tests call it.

---

## The production admission order (audited, not reordered)

These are the layers a Native Account A candidate passes through in
production, in order, with their callsites. M6 conforms to them; nothing in
production was reordered.

0. **Scheduler.** `startNativeAccountAAdoptionScheduler`
   (`native-account-a-adoption.ts`) returns `null`, starting nothing, unless
   `NATIVE_EXECUTION_ENABLED` is true and the process is exactly Account A.
   **Today no adoption pass ever runs.**
1. **Adoption pass**, `NativeAccountAAdoptionService.runOnce`:
   1. discovery: a database query for READY plans of NATIVE 1D/1W alerts whose
      trigger instant is inside the Native lifetime, not yet decided for this
      profile;
   2. deferral: `nativeAdoptionDefers`. A source bar still forming
      (`PENDING_BAR_CLOSE`) whose signal is still fresh is left unclaimed and
      offered again later. Nothing is written;
   3. claim: the `SelectedPlanAdoption` row and its lease;
   4. evaluation: the facts are read (alert, the persisted plan, integrity via
      `nativeCanaryIntegrityOf` over the scanner evidence, occupancy via
      `loadNativeOccupancyRows`, profile flags), then
      `decideNativeAccountACandidate`;
   5. an admitted decision goes to the executor;
   6. completion: the terminal verdict is recorded on the claimed row.
2. **The decision** (pure), `judgeNativeAccountACandidate`
   (`native-account-a-canary.ts`), stage by stage, first refusal wins:

   | # | Stage | Kernel | Refuses with |
   | --- | --- | --- | --- |
   | 1 | `ACCOUNT` | `nativeAccountStage` | `ACCOUNT_NOT_A`, `AMBIGUOUS_STATE` |
   | 2 | `SOURCE` | `nativeSourceStage` | `SOURCE_NOT_NATIVE` |
   | 3 | `SOURCE_TIMEFRAME` | `nativeSourceTimeframeStage` | `SOURCE_TF_NOT_EXECUTABLE`, `AMBIGUOUS_STATE` |
   | 4 | `PLAN` | `nativePlanStage` | `PLAN_NOT_READY`, `PLAN_NOT_FOR_ALERT`, `PLAN_INCOMPLETE`, `ACCOUNT_PLAN_UNRESOLVED`, `PLAN_LOOKBACK_MISMATCH`, `AMBIGUOUS_STATE` |
   | 5 | `FRESHNESS` | `nativeFreshnessStage` (M5) | `NATIVE_SIGNAL_STALE`, `NATIVE_SIGNAL_TIME_UNAVAILABLE` |
   | 6 | `INTEGRITY` | `nativeIntegrityStage` | `INTEGRITY_PENDING_BAR_CLOSE`, `INTEGRITY_INELIGIBLE`, `INTEGRITY_UNREADABLE` |
   | 7 | `OCCUPANCY` | `nativeOccupancyStage` | `SAME_SYMBOL_SIDE_OCCUPIED`, `AMBIGUOUS_STATE` |
   | 8 | `ACCOUNT_GATES` | `nativeAccountGatesStage` | `ACCOUNT_NOT_LIVE_READY`, `ACCOUNT_NOT_ARMED` |
   | 9 | `NATIVE_FENCE` | `nativeFenceStage` → `judgeNativeExecutionAdmission` | `NATIVE_EXECUTION_DISABLED`, `NATIVE_INTEGRITY_NOT_ELIGIBLE` |
   | 10 | `RISK` | `nativeRiskStage` → `judgeNativeRiskReadiness` (M5) | `NATIVE_RISK_UNRESOLVED`, `NATIVE_RISK_BUDGET_INVALID`, `NATIVE_RISK_EXCEEDS_CONTRACT` |

   `decideNativeAccountACandidate` is that judgment plus `issueHandoff`, which
   runs only when every stage admits.
   **Today every otherwise-valid candidate stops at `NATIVE_FENCE` with
   `NATIVE_EXECUTION_DISABLED`.**
3. **Executor**, `SelectedPlanExecutor.handleNativeAccountACandidate`:
   1. `verifyNativeAccountAHandoff` (the hand-off must be one the decision
      issued, by identity);
   2. `nativeAlertFence` (switch, then integrity, then risk);
   3. `nativeAlertSignalFreshness`;
   4. a stop loss and take profit must be present;
   5. the margin planner (`planForSymbolWithSnapshot`: public symbol rules
      and signed account reads);
   6. `createExecutionFromReadyPlan`. It runs `assertNativeAccountAHandoff`,
      then `reserveNativeOccupancy` under the `(profile, symbol, side)`
      transaction lock, then inserts the row;
   7. `admitAndSubmit`.
4. **Orchestrator**, `ExecutionOrchestrator.admitAndSubmit`: refuses while any
   execution of the profile needs recovery, re-reads the row, then runs Phase
   5. On PASS it calls the entry lifecycle.
5. **Phase 5**, `SafetyAdmissionService.evaluateAndReserveSafetyAdmission`:
   1. replay check;
   2. effective policy;
   3. the Native freshness verdict;
   4. kill switch or a Native signal that is not fresh skips the exchange
      read; otherwise signed account state is read;
   5. under the admission lock: local capacity, then the pure safety engine;
   6. on PASS, `resolveAdmissionAuthorization` (now delegating its verdict to
      the pure `judgeAdmissionAuthorization`);
   7. then a session-backed window runs `reserveSessionSlot` (now delegating
      its pre-check to the pure `judgeSessionReservation`), and a legacy window
      runs `claimNaturalWindow`.
6. **Entry lifecycle**, `EntryLifecycleService.prepareEntrySubmission`:
   1. live gates;
   2. **F0** (switch, integrity, risk) before revalidation;
   3. `revalidate`, which includes the signed reads;
   4. `reserveEntryIntent`;
   5. then `continueAfterReservation`:
      - the risk-reducing order query;
      - **F2** before configuration;
      - **F3** immediately before each of `setIsolatedMarginType`,
        `setInitialLeverage` and `submitLimitEntry`.

## Authoritative verdict and diagnostic tail

The result has two parts, and they are never mixed.

**Authoritative.** The production judgment, `judgeNativeAccountACandidate`,
is called once, unchanged, on the snapshot's facts. Its first refusal is the
`terminalStage`, `reason` and `detail`. The stages before it are
`passedStages`. Nothing after it can change it.

It also carries `adoption`, which is what the adoption pass would do at the
same instant (`nativeAdoptionDefers`):

- `DEFER`: the source bar is still forming and the signal is still fresh, so
  nothing is claimed or recorded and a later pass offers the candidate again;
- `DECIDE`: the verdict is recorded.

The integrity verdict is produced by the canonical evaluator from the
snapshot's scanner evidence (`nativeCanaryIntegrityOf`), as the adoption
produces it.

**Diagnostic.** Every entry is `authoritative: false`.

1. Each decision stage after the terminal one, judged alone by its own
   production kernel. This is how the result shows, for example, that the
   `RISK` stage would also refuse `NATIVE_RISK_UNRESOLVED` behind the hard
   fence. `OCCUPANCY` needs the plan's side, so with no LONG or SHORT plan it
   is `NOT_EVALUABLE` (`NO_PLAN_DIRECTION`). `RISK` judges the plan's own
   frozen budget, never its window.
2. The gates after the decision, in production order:

   | Stage | Status | Why |
   | --- | --- | --- |
   | `EXECUTOR_MARGIN_PLAN` | `NOT_EVALUABLE` (`REQUIRES_EXCHANGE_READS`) | needs the exchange's symbol rules and signed account reads |
   | `EXECUTION_CREATION` | `NOT_EVALUABLE` (`REQUIRES_DATABASE_LOCK`) | re-checks the hand-off and repeats occupancy under its lock in its own transaction |
   | `PHASE5_SAFETY_ENGINE` | `NOT_EVALUABLE` (`REQUIRES_EXCHANGE_READS`) | recovery gate, local capacity and signed exchange state under the lock |
   | `PHASE5_AUTHORIZATION` | evaluated | `judgeAdmissionAuthorization` over the snapshot's authorization facts |
   | `PHASE5_SESSION_BUDGET` | evaluated | `judgeSessionReservation` for a session-backed window. A LEGACY, EXACT or legacy-window authorization reserves no slot (`PASS`, `NO_SESSION_SLOT_REQUIRED`). Not evaluated unless the authorization admits. |
   | `ENTRY_LIFECYCLE` | `NOT_EVALUABLE` (`REQUIRES_EXCHANGE_MUTATIONS`) | signed revalidation, then margin type, leverage and the order, each behind the Native fence |

A diagnostic `REFUSE` never adds a second blocker, and a diagnostic `PASS`
never clears the verdict. With the switch false, an `ACCOUNT_GATES` refusal
(for example `SAFE`) stays the verdict even when Phase 5 would pass.

## The result

```jsonc
{
  "policy": "NATIVE_DRY_ADMISSION_V1",
  "authority": "NONE",
  "evaluatedAt": "2026-10-01T12:31:00.000Z",   // the snapshot's nowMs, nothing else
  "authoritative": {
    "admitted": false,
    "adoption": "DECIDE",
    "terminalStage": "NATIVE_FENCE",
    "reason": "NATIVE_EXECUTION_DISABLED",
    "detail": "Every stage before the hard fence passed; Native execution is hard-disabled in code (NATIVE_EXECUTION_ENABLED = false).",
    "integrity": "ELIGIBLE",
    "passedStages": ["ACCOUNT", "SOURCE", "SOURCE_TIMEFRAME", "PLAN", "FRESHNESS", "INTEGRITY", "OCCUPANCY", "ACCOUNT_GATES"]
  },
  "diagnostics": [
    { "stage": "RISK", "status": "REFUSE", "reason": "NATIVE_RISK_UNRESOLVED", "detail": "Native risk for Account A is UNRESOLVED: …", "authoritative": false },
    { "stage": "EXECUTOR_MARGIN_PLAN", "status": "NOT_EVALUABLE", "reason": "REQUIRES_EXCHANGE_READS", "detail": "…", "authoritative": false },
    { "stage": "EXECUTION_CREATION", "status": "NOT_EVALUABLE", "reason": "REQUIRES_DATABASE_LOCK", "detail": "…", "authoritative": false },
    { "stage": "PHASE5_SAFETY_ENGINE", "status": "NOT_EVALUABLE", "reason": "REQUIRES_EXCHANGE_READS", "detail": "…", "authoritative": false },
    { "stage": "PHASE5_AUTHORIZATION", "status": "PASS", "reason": "AUTHORIZATION_NATURAL", "detail": "…", "authoritative": false },
    { "stage": "PHASE5_SESSION_BUDGET", "status": "PASS", "reason": "SESSION_SLOT_AVAILABLE", "detail": "…", "authoritative": false },
    { "stage": "ENTRY_LIFECYCLE", "status": "NOT_EVALUABLE", "reason": "REQUIRES_EXCHANGE_MUTATIONS", "detail": "…", "authoritative": false }
  ]
}
```

That is the shape in full. The result names stages and reasons only. It
carries no candidate, price, quantity, budget, order or exchange id, lease,
token, credential or hand-off. It is deep-frozen, and it shares no object
with the snapshot.

### Refusal code examples

| Snapshot | Authoritative | Notable diagnostics |
| --- | --- | --- |
| Account A, every fact favourable | `NATIVE_FENCE` / `NATIVE_EXECUTION_DISABLED` | `RISK` REFUSE `NATIVE_RISK_UNRESOLVED` |
| Account B | `ACCOUNT` / `ACCOUNT_NOT_A` | `RISK` REFUSE `NATIVE_RISK_UNRESOLVED` (B's own contract) |
| generic / unproven process | `ACCOUNT` / `ACCOUNT_NOT_A` / `AMBIGUOUS_STATE` | |
| TradingView alert | `SOURCE` / `SOURCE_NOT_NATIVE` | `INTEGRITY` REFUSE `INTEGRITY_UNREADABLE` |
| 1M (or hand-made 3M/6M/12M) | `SOURCE_TIMEFRAME` / `SOURCE_TF_NOT_EXECUTABLE` | |
| no plan | `PLAN` / `PLAN_NOT_READY` | `OCCUPANCY` and `PHASE5_AUTHORIZATION` NOT_EVALUABLE `NO_PLAN_DIRECTION` |
| plan persists 300 candles | `PLAN` / `PLAN_LOOKBACK_MISMATCH` | |
| 1 ms past expiry | `FRESHNESS` / `NATIVE_SIGNAL_STALE` | |
| missing `barStart` / impossible touch / future | `FRESHNESS` / `NATIVE_SIGNAL_TIME_UNAVAILABLE` | |
| bar still forming, signal fresh | `INTEGRITY` / `INTEGRITY_PENDING_BAR_CLOSE`, `adoption: DEFER` | |
| re-quarantined, gap, duplicate, checkpoint mismatch, stale generation | `INTEGRITY` / `INTEGRITY_INELIGIBLE` (status carried in `integrity`) | `NATIVE_FENCE` and `RISK` still REFUSE |
| pending LIMIT on the same symbol and side | `OCCUPANCY` / `SAME_SYMBOL_SIDE_OCCUPIED` | |
| SAFE runtime | `ACCOUNT_GATES` / `ACCOUNT_NOT_LIVE_READY` | |
| LIVE_READY, not ARMED | `ACCOUNT_GATES` / `ACCOUNT_NOT_ARMED` | |
| ARMED, window expired | `NATIVE_FENCE` / `NATIVE_EXECUTION_DISABLED` | `PHASE5_AUTHORIZATION` REFUSE `NATURAL_AUTHORIZATION_EXPIRED` |
| ARMED, session budget spent | `NATIVE_FENCE` / `NATIVE_EXECUTION_DISABLED` | `PHASE5_SESSION_BUDGET` REFUSE `SESSION_BUDGET_EXHAUSTED` |

## Deterministic snapshots

The evaluator takes a `NativeDryAdmissionSnapshot` holding every fact it
judges, already read by the caller:

- the account slot and profile id, the Alert row fields and the persisted
  plan;
- Account A's planner-window policy;
- the source bar's scanner evidence (event log text and checkpoint);
- the profile's occupancy rows, the account gates (three live-entry flags and
  the profile's two flags);
- Phase 5's authorization facts (the authorization count, an exact binding id,
  the newest natural window and the session it names);
- the evaluation instant `nowMs`.

It reads no database, file, network, exchange, environment, queue, clock or
randomness. A natural window carries no token hash, and the snapshot holds no
credential of any kind. The same snapshot always gives the same result, byte
for byte. Repeating an evaluation consumes nothing.

M6 adds no loader. A loader that reads a live candidate read-only is left to a
future operator milestone. In tests, snapshots are built from fixtures, or
read from `_test` rows with exactly the reads the adoption pass and Phase 5
make.

## Why a dry PASS cannot become a real hand-off

- The result is a distinct type whose `authority` is `"NONE"`. It is never a
  `NativeAccountAHandoff`.
- The dry module calls `judgeNativeAccountACandidate`, which issues nothing.
  It never calls `decideNativeAccountACandidate`, which is the only code that
  can issue a hand-off.
- The verifier recognises a hand-off by object identity (a module-private
  `WeakSet` filled only by `issueHandoff`). A dry result, a copy of it, its
  JSON round-trip, its parts, and an object fabricated from it with every
  hand-off field are all refused `HANDOFF_INVALID`. So are real hand-offs once
  serialized.
- Execution creation re-asserts the hand-off (`assertNativeAccountAHandoff`),
  and with the switch false it refuses every value.
- Even in a test-only module graph with the switch on and a synthetic resolved
  risk contract, where the dry verdict says `admitted: true`, the real
  executor refuses every dry form before touching a single dependency, and
  creation throws the Native fence error.

## What stays as it was

- **Execution OFF.** `NATIVE_EXECUTION_ENABLED = false as const`. No
  environment variable can change it or the dry result.
- **Risk UNRESOLVED.** Production Native risk for A and B stays
  `UNRESOLVED`; the diagnostic tail shows it. A synthetic `RESOLVED` contract
  exists only inside test module graphs (`vi.doMock`). It is never exported as
  configuration, read from the environment, persisted, or used to change
  `NATIVE_RISK_CONTRACTS`.
- **Lookbacks, not money.** Account A's window is 100 candles and Account B's
  300. They are planner lookbacks. The risk stage judges the plan's frozen
  `template.riskAmount`; a test proves the window never reaches it.
- **Freshness from M5.** The `FRESHNESS` stage is M5's
  `judgeNativeSignalFreshness`, unchanged:
  `expiresAt = min(barStart + 15m + 5m, triggeredAt + 20m)`, fresh iff
  `triggeredAt <= now <= expiresAt`. TradingView keeps its 300 seconds.

### Refactors (behaviour-identical)

M6 extracted pure kernels so the dry admission can ask the same code
production asks:

- the decision's ten stage kernels;
- `nativeCanaryIntegrityOf` and `nativeAdoptionDefers`, the adoption's
  integrity read and deferral;
- `judgeAdmissionAuthorization` (`natural-authorization.ts`), from
  `resolveAdmissionAuthorization`;
- `judgeSessionReservation` (`trading-session.ts`), from `reserveSessionSlot`.

Each production function now composes or delegates to them, with the same
queries, in the same order, with the same messages. The pre-existing suites
pass unchanged, and new tests compare each I/O function with its kernel on
`_test` rows.

## Remaining blockers before the first real Native canary

M6 resolves none of these. Each needs an operator decision or a separate
reviewed milestone:

1. **Native risk amount** for Account A (and separately B) in
   `NATIVE_RISK_CONTRACTS`: an operator financial decision.
2. **Sizing source:** a Native plan is still sized by the shared
   TradingView-configured risk template, capped by the contract.
3. **Enabling execution:** flipping `NATIVE_EXECUTION_ENABLED` is its own
   reviewed change.
4. **Per-account windows are not persisted.** Account B's 300 needs a schema
   change.
5. **A refusal after reservation** (F2/F3 once the switch is on) leaves
   `ENTRY_SUBMITTING` blocking the profile until the entry-recovery CLI
   releases it (M4 known limit 3).
6. **The pre-existing TradingView claim-reclaim issue** is tracked separately
   and must be fixed before real runtime enablement. M6 does not touch it.
7. **No live snapshot loader:** using the dry admission on a real candidate
   needs a reviewed read-only loader (a future milestone).

## Tests

- `apps/backend/tests/native-m6-dry-admission.test.ts` (pure). The contract;
  the required matrix, every case compared with the production decision for
  the same facts, stage by stage; SAFE / LIVE_READY / ARMED and Phase 5; risk
  in production and in test-only graphs; the hard fence and environment
  overrides; authority in every form; and determinism over 1, 10 and 100 runs
  and under two system clocks.
- `apps/backend/tests/native-m6-dry-admission-structure.test.ts` (structural).
  The value-import closure from the TypeScript AST, pinned to 26 modules: no
  exchange client or adapter, Prisma client, environment, queue, Redis, route
  or service. It also proves:
  - no module in the closure reads the environment, the clock or randomness,
    starts a timer, signs, makes a request, loads code dynamically or writes a
    row;
  - every file call in the closure sits in four I/O entry points the dry path
    never names;
  - the dry module names nothing that acts;
  - no runtime role, route, UI control, environment key or migration was
    added;
  - the M4/M5 invariants re-proved.
- `apps/backend/tests/native-m6-dry-admission.integration.test.ts` (`_test`
  database). Traps on signing, the network, every exchange adapter method, the
  file system, queues and Redis, plus a digest of every `_test` table, each
  shown to fire on a real call first. Around 100 evaluations of every
  snapshot they all read zero, and the database is byte-identical. It also
  covers:
  - the real executor and creation refusing every dry form, in both graphs;
  - the real adoption pass recording exactly the dry verdict over the same
    rows;
  - `resolveAdmissionAuthorization` and `reserveSessionSlot` equal to their
    kernels.
