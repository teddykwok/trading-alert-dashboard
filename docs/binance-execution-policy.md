# Binance execution policy (locked)

These decisions are **already made**. They are recorded here so later phases
implement them exactly rather than re-deriving them. Phase 2 (the current
phase) implements **none** of the execution behaviour below — it ships a
strictly read-only connector only.

## Venue and account mode

| Decision | Value |
| --- | --- |
| Venue | Binance USDⓈ-M Futures |
| Position mode | **Hedge Mode** (`LONG` / `SHORT` position sides kept distinct) |
| Margin mode | **Isolated Margin** |
| Entry order type | **LIMIT** |

The connector reads the *actual* account position mode from Binance
(`GET /fapi/v1/positionSide/dual`). It never assumes Hedge Mode from project
configuration, and it never changes the mode automatically. If the account is
in One-way mode, the health check reports:

```
WARNING: Expected HEDGE mode, actual mode is ONE_WAY.
```

## Plan-locked, risk-capped sizing

- The trade plan is **plan-locked**: the planned **Entry**, **Stop-loss** and
  **Take-profit** are frozen at plan time and are never recalculated at
  execution time.
- Sizing is **risk-capped**, derived from the frozen plan.
- Quantity always **rounds downward** to the exchange step size. Rounding down
  can only reduce risk, never increase it.

## Risk and isolated-margin envelope

| Decision | Value |
| --- | --- |
| Initial live risk | **USD 1.50** |
| Target isolated margin | risk × **2.5** (= USD 3.75 at USD 1.50 risk) |
| Maximum isolated margin | risk × **3.333333** (= USD 5.00 at USD 1.50 risk) |

The liquidation-safety guard is **mandatory**: a plan whose liquidation price
would sit between entry and the stop loss must not be executed. Leverage is
only ever the lever that sets isolated margin — it never changes quantity,
stop-loss, take-profit, planned loss or planned profit.

## Position and accounting rules

- **One active position per symbol and position side.** A symbol may hold one
  `LONG` and one `SHORT` position simultaneously (Hedge Mode), but never two of
  the same side.
- **Execution safety rule (for the first live executor — not yet implemented):**
  no leverage or margin-type change may occur for a symbol that has **any**
  open position or open order, regardless of `LONG`/`SHORT` positionSide.
  Adjusting leverage on a symbol with live exposure changes that exposure's
  margin behaviour; the executor must treat such symbols as locked. Phases 2–3
  contain no leverage- or margin-changing capability at all, so this rule
  binds Phase 4+.
- **Fees and funding do not affect v1 sizing.** They are real costs, but v1
  sizes purely from the frozen plan and the risk cap; fee/funding modelling is
  explicitly out of scope for the first execution version.

## Phase 2 scope (this phase)

Phase 2 is **read-only**. The connector:

- issues only `GET` requests, and only to an allowlisted set of documented
  USDⓈ-M endpoints;
- exposes **no** `placeOrder`, `cancelOrder`, `changeLeverage`,
  `changeMarginType` or `changePositionMode` method;
- performs no database write and requires no Prisma migration;
- is **not** connected to the alert pipeline and does not poll continuously;
- does not choose or recommend a leverage — that belongs to Phase 3.

Any `POST`, `PUT`, `PATCH` or `DELETE` attempt is rejected by the transport
boundary before a network request is made
(see `apps/backend/src/modules/binance/binance.client.ts`).

## Phase 3 scope — dynamic leverage and isolated margin (calculation only)

Phase 3 adds a **pure calculation engine**
(`packages/shared/src/binance-margin-engine.ts`) plus a read-only
orchestration service and two CLIs. It **recommends** a leverage and never
applies it: no order, leverage change, margin-type change, isolated-margin
transfer or position-mode change exists anywhere in the phase, it reuses only
the Phase 2 GET allowlist, and it requires no Prisma migration.

Sizing (all decimal.js, no float math):

```
stopDistance      = |entryPrice − stopLoss|
quantityRaw       = riskBudgetUsd / stopDistance
roundedQuantity   = floor(quantityRaw / LOT_SIZE.stepSize) × stepSize   # always DOWN
actualPlannedLoss = roundedQuantity × stopDistance        (≤ riskBudgetUsd by construction)
positionNotional  = roundedQuantity × entryPrice
```

LIMIT sizing uses `LOT_SIZE`, never `MARKET_LOT_SIZE`. Quantity is never
increased to reach `MIN_NOTIONAL`, because that would exceed the risk budget.

Margin envelope is derived from the risk **budget**, not the reduced rounded
loss:

```
targetIsolatedMargin  = riskBudgetUsd × BINANCE_TARGET_MARGIN_MULTIPLIER   (preferred)
maximumIsolatedMargin = riskBudgetUsd × BINANCE_MAX_MARGIN_MULTIPLIER      (hard ceiling)
```

Candidate selection walks every integer leverage from 1x to the **usable
maximum** — `min(bracket initialLeverage, BINANCE_MAX_AUTOMATION_LEVERAGE)`
(user cap default 25x; the symbol's *currently configured* leverage plays no
part) — computes `estimatedInitialMargin = notional / leverage`, discards
anything above the maximum margin or failing liquidation safety, then picks
the smallest `|margin − targetMargin|`; ties keep the **lower** leverage.
When Binance would allow a safe plan at a leverage above the user cap but
nothing at or below the cap qualifies, the plan is skipped with
`USER_LEVERAGE_CAP_PREVENTS_SAFE_PLAN`.

Prices must satisfy the symbol's `PRICE_FILTER` (minPrice/maxPrice where
enabled, exact tickSize alignment, checked with decimal arithmetic). Entry and
stop are treated differently on purpose:

- **LIMIT entry — never moved.** It is an execution-locked price. Off-tick or
  out-of-range entries fail closed (`ENTRY_PRICE_NOT_TICK_ALIGNED`, …).
- **Stop loss — normalized when strategy-calculated.** A stop such as
  `0.26563` on a `0.0001` tick is a *mathematical* price, not an exchange
  price. It is moved onto the tick grid **away from entry** (LONG rounds
  **down**, SHORT rounds **up**), so the stop can only widen, never tighten.
  The result exposes `calculatedStopLoss`, `executableStopLoss`,
  `stopAdjustment` and the marker `STOP_PRICE_NORMALIZED_TO_TICK`; the main
  `stopLoss` field is the executable value.
- A stop explicitly marked `stopLossSource: "EXECUTION_LOCKED"` is never
  moved and still fails closed with `STOP_PRICE_NOT_TICK_ALIGNED`.

### The strategy is locked AFTER exchange-price normalization

Normalization happens once, before sizing. Everything downstream —
`stopDistance`, `quantityRaw`, `roundedQuantity`, `actualPlannedLoss`,
`positionNotional`, every leverage candidate, the liquidation boundary and the
safety check — is computed from the **executable** stop. From that point the
plan is locked and no price moves again.

Because the stop widens by up to one tick, the realised risk/reward differs
slightly from the strategy's theoretical figure: the stop distance grows a
little, quantity shrinks (it is still rounded **down** to `LOT_SIZE`), and
`actualPlannedLoss` therefore stays at or below the risk budget. A small
adverse RR difference versus the pre-normalization plan is expected and
accepted; it is the cost of using a genuinely executable price, and it always
errs toward less risk rather than more.

### Liquidation estimate (ISOLATED, single position)

Derived from the balance condition "margin balance = maintenance margin",
where the maintenance margin is `notionalAtMP × MMR − cum`:

```
LONG :  WB + qty·(MP − EP) = qty·MP·MMR − cum
        MP = (qty·EP − WB − cum) / (qty·(1 − MMR))
SHORT:  WB + qty·(EP − MP) = qty·MP·MMR − cum
        MP = (qty·EP + WB + cum) / (qty·(1 + MMR))
```

`WB` is the isolated wallet backing the position (the initial margin at open);
`TMM` and other-contract `UPNL` are zero for an isolated single position. MMR
and `cum` come from the account leverage bracket that contains the notional
**at the liquidation price**, so the bracket is re-resolved and the price
recomputed until it stabilises (bounded iteration). If it cannot stabilise, or
required data is missing, the engine returns
`LIQUIDATION_ESTIMATE_UNAVAILABLE` and marks nothing safe — it fails closed.

This is an **estimate**, never Binance's guaranteed liquidation price.
`binance:liquidation-check` compares it against Binance's own reported values
for existing ISOLATED positions (CROSS positions are never used) within
`max(1 tick, 0.1% relative)`.

Required liquidation boundary, with `BINANCE_LIQUIDATION_BUFFER_RATIO`:

```
LONG :  estimatedLiquidation ≤ stopLoss − stopDistance × ratio
SHORT:  estimatedLiquidation ≥ stopLoss + stopDistance × ratio
```

## Phase 5 scope — safety and capacity engine (admission control only)

Phase 5 decides **whether a planned execution may proceed** and reserves its
capacity locally. It evaluates and reserves; it does not execute.

It never submits or cancels an order, never changes leverage, margin type,
isolated margin or position mode, never transfers funds, never enables a
trading permission and never calls a POST/PUT/PATCH/DELETE Binance endpoint.
Binance is read exclusively through the Phase 2 GET-only connector. Phase 3
remains calculation-only and is **not** recalculated here — the frozen plan is
revalidated, not regenerated. Phase 4 remains the authoritative lifecycle and
event store.

### The kill switch blocks NEW admissions only

`EXECUTION_GLOBAL_KILL_SWITCH` (global) and `ExecutionSafetyPolicy.killSwitchActive`
(per profile) are **admission** controls. When either is active:

- every new admission is rejected, and no Binance call is made at all;
- **no order is cancelled, no position is closed**;
- no existing execution changes status, and no capacity record is deleted.

Engaging the switch mid-flight leaves everything already running exactly as it
is. It is a brake on new exposure, not an emergency stop for existing exposure.
The effective switch is active when **either** side is active; neither side can
re-enable admissions on its own.

### Effective limits

Every limit exists globally (env) and per profile. The **stricter** of the two
applies. Defaults are the locked canary values and fail closed:

| Limit | Default | Meaning |
| --- | --- | --- |
| `EXECUTION_GLOBAL_KILL_SWITCH` | `true` (ACTIVE) | All admissions rejected |
| `EXECUTION_MAX_OPEN_POSITIONS` | 1 | Concurrent open positions |
| `EXECUTION_MAX_PENDING_ENTRIES` | 1 | Concurrent pending entries |
| `EXECUTION_MAX_TOTAL_ACTIVE_TRADES` | 1 | Union of the two above |
| `EXECUTION_MAX_TOTAL_PLANNED_RISK_USD` | 1.50 | Sum of reserved risk budgets |
| `EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD` | 5.00 | Sum of reserved maximum margins |
| `EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE` | 1 | Active trades per symbol AND side |
| `EXECUTION_MAX_ALERT_AGE_SECONDS` | 300 | Signal freshness ceiling |

`EXECUTION_MAX_TOTAL_ACTIVE_TRADES` below either individual limit is a
configuration error and fails startup. Monetary limits are decimal strings and
never pass through a JavaScript float.

Reaching a limit skips **only the requesting execution**. Existing executions,
positions and orders are never modified or deleted to make room.

### Capacity classification

| Status | Pending entry | Open position | Total active |
| --- | --- | --- | --- |
| `PLAN_READY` | – | – | – |
| `PREFLIGHT` | ✓ | – | ✓ |
| `ENTRY_SUBMITTING` | ✓ | – | ✓ |
| `ENTRY_PENDING` | ✓ | – | ✓ |
| `PARTIALLY_FILLED` | ✓ | ✓ | ✓ |
| `ENTRY_FILLED` | – | ✓ | ✓ |
| `PLACING_PROTECTION` | – | ✓ | ✓ |
| `PROTECTED` | – | ✓ | ✓ |
| `MANUAL_INTERVENTION` | – | ✓ | ✓ |
| `ENTRY_EXPIRED`, `CLOSED_TP`, `CLOSED_SL`, `CANCELED`, `SKIPPED`, `FAILED` | – | – | – |

`PARTIALLY_FILLED` consumes both: the unfilled remainder is a live working
order and the filled part is real exposure. `MANUAL_INTERVENTION` counts as
open because exposure may exist and is unresolved. `PLAN_READY` reserves
nothing until admission succeeds.

### What is reserved

- **Risk** is reserved at the full `riskBudgetUsd`, not the smaller rounded
  `actualPlannedLoss`.
- **Margin** is reserved at `maximumIsolatedMargin`, not the selected
  `estimatedInitialMargin`, so a later safety top-up still fits the ceiling.
- Available balance is taken from the read-only snapshot's **available**
  balance (never the wallet balance), reduced by local reservations Binance
  cannot yet reflect:
  `effectiveAvailable = binanceAvailable − localUnreflectedMaximumMargins`,
  and must be `>= maximumIsolatedMargin`.

### Signal freshness

Freshness uses `TradeExecution.signalTriggeredAt` — a frozen copy of
`Alert.triggeredAt` — never `createdAt`, and it survives retention nulling
`alertId`. `signalAgeSeconds = floor((evaluatedAt − signalTriggeredAt) / 1000)`,
with a small tolerance for a signal slightly ahead of local time. Rows created
before Phase 5 have no trustworthy value and were deliberately **not**
backfilled with a fabricated timestamp; they fail closed with
`SIGNAL_TIME_UNAVAILABLE`.

### Symbol exclusivity

Any Binance open position **or** open order on the symbol blocks a new
execution, regardless of `positionSide`, because the first live executor must
not change leverage or margin type for a symbol with live exposure. Locally, at
most one active LONG and one active SHORT may exist per symbol. Phase 5 never
cancels or closes anything to satisfy this.

### Atomicity

`evaluateAndReserveSafetyAdmission` counts capacity and reserves it inside one
transaction holding a per-`ExecutionProfile` PostgreSQL advisory lock
(`pg_advisory_xact_lock`). A plain read-count-write is not sufficient: two
concurrent admissions would both read the same free slot. The lock is scoped to
the profile, so different profiles never block each other. A lost race rolls
back completely and retries a bounded number of times before returning
`RETRY_CONFLICT` / `CAPACITY_CONFLICT_RETRY`. **PASS is never returned unless
the PREFLIGHT reservation committed.**

### Decision lifecycle

| Decision | Status transition | Version | Event | Terminal? |
| --- | --- | --- | --- | --- |
| `PASS` | `PLAN_READY → PREFLIGHT` | +1 | 1 × `DECISION_RECORDED` | capacity reserved |
| `SKIP` | `PLAN_READY → SKIPPED` | +1 | 1 × `DECISION_RECORDED` | **yes** |
| `UNAVAILABLE` | stays `PLAN_READY` | +1 | 1 × `DECISION_RECORDED` | **no — retryable** (transient reasons only) |
| `RETRY_CONFLICT` | stays `PLAN_READY` | unchanged | none | **no — retryable** |

**`UNAVAILABLE` is never terminal.** A missing account snapshot, an
un-inspectable symbol, a connector failure, a rate limit or a network blip says
nothing about whether the trade is allowed — only that we could not tell yet.
Burning the execution into `SKIPPED` would turn a transient outage into a
permanent refusal, so the status stays `PLAN_READY` and only the version moves.

### Retryable versus terminal reasons

`classifySafetyReasonRetryability(reasonCode)` is the single source of truth;
the orchestration service derives the lifecycle from the decision alone and
special-cases no reason code.

| Retryable (`UNAVAILABLE` → stays `PLAN_READY`) | Why it can resolve |
| --- | --- |
| `BINANCE_ACCOUNT_STATE_UNAVAILABLE` | Connector failure, rate limit, network blip |
| `BINANCE_SYMBOL_STATE_UNAVAILABLE` | Symbol could not be inspected, or filters/brackets came back incomplete |
| `PROFILE_POLICY_UNAVAILABLE` | An operator can create the missing policy |
| `CAPACITY_CONFLICT_RETRY` | Lost lock race; nothing was written |

Every other code is terminal. Two deserve explicit mention because their names
suggest unavailability:

| Terminal despite the name | Why it cannot self-heal |
| --- | --- |
| `SIGNAL_TIME_UNAVAILABLE` | A pre-Phase-5 row has no trustworthy signal time and never will — the field is frozen |
| `MARGIN_PLAN_SNAPSHOT_MISSING` | The frozen plan snapshot was never captured on this execution and cannot appear later |

A decision is retryable only when **every** failed check is retryable. A single
terminal failure makes the whole decision a terminal `SKIP`, so a permanent
precondition can never hide behind a transient one and be retried forever; the
reported `reasonCode` is then the first terminal check, so it always agrees
with the decision.

Note that an incomplete **live** filters/bracket read reports
`BINANCE_SYMBOL_STATE_UNAVAILABLE` (this attempt's symbol state, retryable),
while a missing **frozen** plan snapshot reports
`MARGIN_PLAN_SNAPSHOT_MISSING` (immutable execution data, terminal). Phase 5
never recalculates Phase 3 in either case.
The attempt is still recorded (one `SafetyAdmission`, one event) so the history
is complete and the stale version can never be replayed into a second
admission. The caller retries with the **new** `expectedVersion` and may then
get `PASS`, `SKIP` or another `UNAVAILABLE`. There is no internal retry loop
for `UNAVAILABLE`; only the bounded serialization retry for lock conflicts.

Both inserts and the version increment are in one transaction: if either
insert fails, the version increment rolls back with them.

### Configuration-mismatch reason codes

Each mismatch has its own stable code, so an intentionally-off profile is never
confused with a misconfigured one:

| Code | Condition |
| --- | --- |
| `PROFILE_DISABLED` | `ExecutionProfile.isEnabled` is actually `false` — nothing else |
| `PROFILE_ENVIRONMENT_MISMATCH` | Profile environment ≠ active connector environment |
| `EXPECTED_ISOLATED_MARGIN_TYPE` | Profile/symbol configuration does not satisfy the required ISOLATED policy |
| `EXPECTED_HEDGE_MODE` | The real Binance position mode is not HEDGE |
| `EXPECTED_SINGLE_ASSET_MODE` | The real Binance asset mode is not SINGLE_ASSET |

### Stored decisions

Each decision — including `UNAVAILABLE` — is written to `SafetyAdmission`,
unique per `(tradeExecutionId, evaluatedVersion)` so an identical retry replays
the stored decision instead of duplicating history. It stores effective limits, before and
projected totals, the reservations, the Binance snapshot timestamp and a
summary of the requested symbol only. It stores **no** credentials, signed
queries, authorization headers, raw Binance payloads or unrelated
position/account detail.

### Safety policy administration

`ExecutionSafetyPolicy` is created and updated through internal service methods
only, with optimistic locking on `version`. There is deliberately **no HTTP
route**: loosening a limit or releasing a kill switch is a deliberate operator
action, never something an unauthenticated request can reach.
