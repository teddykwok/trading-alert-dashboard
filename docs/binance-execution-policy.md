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

## Phase 6 scope — LIMIT entry lifecycle (first mutation phase)

Phase 6 is the first phase able to change Binance state. **Real entry
submission is disabled by default and stays disabled until Phase 7.**

### Two fail-closed gates, applied per operation class

`EXECUTION_LIVE_ENTRY_ENABLED` and `EXECUTION_PROTECTION_READY` both default to
`false`; unset stays closed and any other value fails startup validation. Phase
7 protection does not exist, so `EXECUTION_PROTECTION_READY` remains `false` and
no real entry can be placed.

The four approved mutations do **not** carry the same risk, so they are gated
differently:

| Class | Operations | Gate |
| --- | --- | --- |
| `EXPOSURE_OR_CONFIGURATION` | `POST /fapi/v1/marginType`, `POST /fapi/v1/leverage`, `POST /fapi/v1/order` | Both gates must be `true` |
| `RISK_REDUCING_RECOVERY` | `DELETE /fapi/v1/order`, narrowed to this execution's own reserved ENTRY order | Not gated |

Cancellation is deliberately ungated. Gating it would **trap a resting order**:
turning the gates off after an entry had been accepted would leave the system
unable to cancel the unfilled remainder at TTL. Disabling live entry must stop
NEW exposure, not prevent reducing exposure that already exists.

GET reconciliation is likewise always available.

With either gate closed and the execution still `PREFLIGHT`, the lifecycle
returns `LIVE_ENTRY_DISABLED` / `PROTECTION_NOT_READY` and dispatches zero
POST/DELETE requests, creates no `BinanceOrder`, changes no execution status
and appends no entry-intent event. The exception applies only once a durable
local ENTRY intent already exists and the lifecycle is reconciling or expiring
that exact order.

### Authorization model

There is no `bypassSafety` boolean anywhere. Authorization is carried by
branded context objects that only the mutation-client module can mint:

- `authorizeLiveEntry()` — throws when either gate is closed, so an
  exposure-increasing POST cannot be expressed without it. The gates are
  re-checked at **call** time as well, not only when the token was minted.
- `authorizeEntryCancellation({ executionId, symbol, clientOrderId, role,
  generation, reason })` — accepted only for role `ENTRY`, generation `1`, an
  explicit recovery reason (`TTL_DUE` or `OPERATOR_RECOVERY`), and a
  `clientOrderId` that **equals the deterministic id derived from that
  execution**. `cancelReservedEntryOrder(context)` then takes the symbol and
  client order id from the context, never from the call site — so an arbitrary
  symbol, client order id, exchange order id, role, generation or external
  order cannot be addressed. There is no generic ungated cancel method.

The service additionally refuses recovery cancellation unless a persisted
execution and a persisted ENTRY generation 1 reservation exist, the execution
is in a state where an entry order may exist (`ENTRY_SUBMITTING`,
`ENTRY_PENDING`, `PARTIALLY_FILLED`, `MANUAL_INTERVENTION`), the order was
queried first, and TTL is due (or an explicit recovery reason was given).

### Kill-switch recheck immediately before the entry POST

Margin-type and leverage configuration take several network round trips, so
everything is re-validated immediately before `POST /fapi/v1/order`: both live
gates; the profile and its safety policy re-read from the database; the
execution still `ENTRY_SUBMITTING` at the same version; the same reserved
order; and no conflicting local or Binance exposure. No database transaction is
held across any Binance call.

If a gate or kill switch became active in that window, the entry is **not**
submitted, no second reservation is created, margin type and leverage are
**not** rolled back, and a sanitized operator-visible result is persisted —
the system never claims an entry was submitted.

### Mutation allowlist

Exactly four `(method, path)` pairs exist anywhere in the codebase:

```
POST   /fapi/v1/marginType
POST   /fapi/v1/leverage
POST   /fapi/v1/order
DELETE /fapi/v1/order
```

They live in a **separate** `BinanceUsdMExecutionClient`; the Phase 2 connector
stays structurally GET-only. There is no public generic signed-request method,
so an arbitrary mutation cannot be expressed. Position-mode changes,
multi-assets-mode changes, position-margin top-ups, batch orders, order
modification, cancel-all and every transfer endpoint have no representation at
all. Because a protection or MARKET order would travel the same
`POST /fapi/v1/order` path, the order **type** is allowlisted separately —
`LIMIT` + `GTC` only.

A mutation is never blind-retried: an ambiguous result is reconciled by client
order id instead.

### Local intent before external mutation

Before changing margin type, leverage or submitting anything, one transaction
verifies `(id, expectedVersion, status = PREFLIGHT)`, reserves exactly one
`BinanceOrder` (role `ENTRY`, generation 1, deterministic client order id,
status `SUBMITTING`, no exchange id, zero executed), transitions
`PREFLIGHT → ENTRY_SUBMITTING`, increments the version once and appends one
event. A crash after this commit resumes from the durable reservation.

Generation 2 is **never** created automatically, and a timeout never mints a new
client order id.

### Configuration verification

ISOLATED margin and the exact frozen `selectedLeverage` are each read first (no
POST when already correct), changed only when the symbol carries no position and
no open order, and then **verified by a second GET** — a success message is
never taken as proof. An unresolved ambiguity stops the lifecycle; neither
setting is ever automatically reverted, because reverting could collide with the
user's own activity.

Leverage is sent exactly as frozen: no clamp, no fallback, no recalculation, and
the verified `maxNotionalValue` must still cover the frozen `positionNotional`.

### Result classification

`CONFIRMED_ACCEPTED`, `CONFIRMED_REJECTED`, `RESULT_UNKNOWN`, `QUERY_RETRYABLE`,
`NOT_FOUND_CONFIRMED`, `CONFLICT`, `MANUAL_REVIEW_REQUIRED`.

A timeout, connection reset or 5xx is `RESULT_UNKNOWN` — **never** proof that
nothing happened. The response is always followed by a query on the same
`origClientOrderId`. A duplicate-client-id conflict proves the order exists, so
it triggers a query rather than a new id.

### Status mapping

| Exchange | Local order | Execution |
| --- | --- | --- |
| `NEW` | `NEW` | `ENTRY_PENDING` |
| `PARTIALLY_FILLED` | `PARTIALLY_FILLED` | `PARTIALLY_FILLED` |
| `FILLED` | `FILLED` | `ENTRY_FILLED` |
| `CANCELED`, zero fill, TTL | `CANCELED` | `ENTRY_EXPIRED` |
| `CANCELED`, zero fill, operator | `CANCELED` | `CANCELED` |
| `EXPIRED` / `EXPIRED_IN_MATCH`, zero fill | `EXPIRED` | `ENTRY_EXPIRED` |
| `REJECTED`, zero fill | `REJECTED` | `FAILED` |
| **any close-out with a non-zero fill** | preserved | **`MANUAL_INTERVENTION`** |
| unknown / contradictory | `UNKNOWN` | `MANUAL_INTERVENTION` |

Fills are monotonic: an exchange read reporting less filled than already
observed is ignored, an average fill price is never cleared, and a known
`exchangeOrderId` is never overwritten. A contradictory order identity (symbol,
side, positionSide, type, price, quantity or client id) produces
`MANUAL_INTERVENTION` instead of rewriting local intent.

### TTL and the partial-fill rule

The order is sent `GTC` with a **local** TTL (`EXECUTION_ENTRY_TTL_SECONDS`,
default 300). The deadline is stored on `BinanceOrder.entryOrderExpiresAt` —
deliberately not `TradeExecution.entryExpiresAt`, which is a frozen planned
field meaning "the plan's entry opportunity expires". It is derived once from
the committed submission intent and stays stable across retries.

TTL cancellation cancels **only the unfilled remainder**. It never closes the
filled position, never submits an opposite order, never zeroes
`filledQuantity`, and never releases open-position capacity as though no fill
happened. Until Phase 7 can protect a partial position:

> **partial fill + cancelled remainder → `MANUAL_INTERVENTION`**, never the
> terminal `ENTRY_EXPIRED`.

A cancel timeout is likewise an unknown result: the order is queried again, a
`FILLED` order never receives another cancel, and an ambiguous cancellation
while a fill is possible parks the execution for a human. No compensating trade
is ever submitted.

### Kill switches

The Phase 5 kill switch is re-checked before a new submission and blocks it. It
does **not** cancel an entry order that has already been submitted —
active-order emergency behaviour belongs to a later phase.

### Concurrency

Reservation and configuration hold a per-`(profile, symbol)` advisory lock, so
two local executions never configure or submit the same symbol simultaneously
while different profiles stay unblocked. Every local mutation keeps the Phase 4
guarantees: conditional update on `(id, expectedVersion)`, exactly one version
increment per committed event, the new version as the event `sequenceNumber`,
and full rollback if the event insert fails.

## Phase 7 scope — SL/TP protection, liquidation safety, margin top-up, emergency close

Phase 7 protects confirmed exposure. **Live entry and protection remain
disabled**: `EXECUTION_LIVE_ENTRY_ENABLED=false` and
`EXECUTION_PROTECTION_READY=false` stay false until a reviewed live-canary step
after this phase is merged.

### Algo Order API

Current USDⓈ-M protection uses the **Algo Order** API, not a legacy
standard-order workflow:

```
POST   /fapi/v1/algoOrder    algoType=CONDITIONAL
GET    /fapi/v1/algoOrder    by clientAlgoId
DELETE /fapi/v1/algoOrder    by clientAlgoId
```

`algoId` is persisted only after it has been observed; `clientAlgoId` is the
deterministic idempotency key.

### Mutation allowlist after Phase 7

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/fapi/v1/marginType` | Phase 6 — ISOLATED only |
| POST | `/fapi/v1/leverage` | Phase 6 — exact frozen leverage |
| POST | `/fapi/v1/order` | Phase 6 LIMIT entry **and** the one branded emergency MARKET close |
| DELETE | `/fapi/v1/order` | Phase 6 — reserved ENTRY cancellation |
| POST | `/fapi/v1/algoOrder` | Phase 7 — STOP_MARKET / TAKE_PROFIT_MARKET protection |
| DELETE | `/fapi/v1/algoOrder` | Phase 7 — persisted protection cleanup |
| POST | `/fapi/v1/positionMargin` | Phase 7 — ADD (type 1) only |

Every Phase 7 operation is **RISK-REDUCING** and therefore deliberately **not**
gated on the exposure-increasing live-entry switches: refusing to protect or
close an existing position because new entries were disabled would be the
opposite of safe. Emergency close additionally survives an active kill switch.
Authorization is carried by module-private branded contexts; there is no
`bypassSafety` flag and no generic MARKET-order method.

### Protection state is tracked separately

`ExecutionProtectionState` is a one-to-one companion to `TradeExecution`.
`TradeExecution.status` continues to describe the **entry** lifecycle, so a
still-open `PARTIALLY_FILLED` entry keeps consuming its pending-entry capacity
while its filled quantity is fully protected. Phase 5 capacity classification is
unchanged, with a test proving no slot is released early.

States: `UNPROTECTED`, `MARGIN_CHECK`, `MARGIN_ADJUSTING`, `PLACING_STOP`,
`STOP_VERIFIED`, `PLACING_TAKE_PROFIT`, `PROTECTED`, `PROTECTION_INCOMPLETE`,
`EMERGENCY_CLOSING`, `CLOSURE_CLEANUP`, `CLOSED`, `MANUAL_INTERVENTION`.

### First fill, not full fill

Protection starts on the **first confirmed non-zero fill** — it never waits for
`ENTRY_FILLED`. Phase 6 persists the fill; the internal
`ensureProtectionForExposure` then continues from that durable state. No
mutation is ever sent inside a Phase 6 transaction.

### Incremental tranches

A verified stop is never cancelled merely because the entry filled further.
Coverage grows in non-overlapping paired generations:

```
fill 0.10  -> generation 1: STOP 0.10 + TP 0.10
fill 0.25  -> generation 2: STOP 0.15 + TP 0.15   (aggregate 0.25)
```

Aggregate active STOP coverage **and** aggregate active TP coverage must each
equal the confirmed open quantity exactly before a position is declared
protected. Over-protection is escalated, never silently accepted.

### Protection parameters

| | LONG exposure | SHORT exposure |
| --- | --- | --- |
| SL | `STOP_MARKET`, side `SELL`, positionSide `LONG` | `STOP_MARKET`, side `BUY`, positionSide `SHORT` |
| TP | `TAKE_PROFIT_MARKET`, side `SELL`, positionSide `LONG` | `TAKE_PROFIT_MARKET`, side `BUY`, positionSide `SHORT` |

Always `algoType=CONDITIONAL`, the exact frozen trigger, the exact coverage
quantity, `newOrderRespType=ACK`, the configured working type and
`priceProtect`, and `closePosition=false`. **Never** `reduceOnly` (invalid in
hedge mode), `closePosition=true` (the strategy tracks filled quantity
explicitly), `price`, `priceMatch`, `activationPrice`, `callbackRate` or any
trailing parameter. The working-type and price-protect policy is frozen into
the local intent, so a retry cannot silently change it.

### Stop first

Within a tranche the STOP is submitted, queried by its own `clientAlgoId` and
verified active **before** the TP is submitted. If the STOP is unverified the
position is never claimed protected and the TP is never used as a substitute.
If the STOP is verified but the TP fails, the STOP is retained — never
cancelled — and the state becomes `PROTECTION_INCOMPLETE`.

### Liquidation safety and margin top-up

The **actual** reported liquidation price is revalidated against the frozen
boundary (LONG safe when `actual <= boundary`, SHORT when `actual >= boundary`;
exact equality accepted). Missing, zero or malformed data fails closed.

Margin top-up only ever ADDs (type 1). The allowance is recomputed on every
attempt as `maximumIsolatedMargin - verifiedCurrentIsolatedMargin`, so retries
after an ambiguous result can never accumulate past the frozen cap. A durable
`MarginAdjustmentIntent` with a pre-adjustment baseline is written **before**
the POST; an ambiguous result is proven by re-reading the position, never by
sending another ADD.

### Emergency close

Eligible only when confirmed exposure exists, the stop cannot be verified after
the bounded budget, no verified stop covers the position, the identity is known
and `EXECUTION_EMERGENCY_CLOSE_MODE=ON_UNVERIFIED_STOP`. In `DISABLED` mode no
MARKET order is sent at all: the execution parks in `MANUAL_INTERVENTION` with
a critical alert and all evidence preserved. Success requires a confirmed zero
position, not just an acknowledgement; the terminal status is
`CLOSED_EMERGENCY`.

### Critical alerts are durable

`CriticalAlert` is an outbox: the row is persisted first and delivered
separately, so a safety action never waits for Telegram and a delivery failure
stays visible and retryable. Alerts are deduplicated per
(execution, type, reason, state), so repeated reconciliation cannot spam. No
credentials, signed URLs, balances, unrelated positions or raw payloads.

### Closure and sibling cleanup

A filled protection order is **not** proof of closure — only a confirmed zero
position quantity is. A protection fill alongside remaining exposure is a
`PARTIAL_PROTECTION_EXIT`: critical, never `CLOSED_TP`/`CLOSED_SL`. Once flat,
every sibling across every generation is cancelled by its own `clientAlgoId`,
queried again afterwards, and only then is the terminal status recorded. While
the position is open no protection is cancelled at all. An unreadable sibling
leaves cleanup incomplete rather than being assumed gone.

## Phase 8 scope — execution journal and dashboard (read-only)

Phase 8 adds observability only. It reads persisted database state and changes
nothing: no Binance call of any kind (GET or mutation) happens on a dashboard
request, no execution record is created or updated by viewing a page, and no
worker, queue, webhook or Telegram sender is involved. All live execution gates
remain `false`.

### Financial fields

`tradingFeesUsd` (non-negative) and `fundingPnlUsd` (signed: positive = funding
received, negative = paid) are both **nullable**, and null means *unknown / not
yet collected* — never zero. Nothing estimates them and Phase 8 adds no
historical Binance fetch, so they stay null until a future phase records real
values.

```
netPnlUsd = realizedPnl - tradingFeesUsd + fundingPnlUsd
```

If **any** component is null, `netPnlUsd` is null and the UI shows "—" plus the
names of the missing components. A partial sum is never presented as a net
result. The same rule governs the aggregate: the summary sums only KNOWN
realized PnL and states how many closed executions are unknown, so it is never
labelled complete net profit.

### Read-only API

```
GET /api/executions                          paginated summaries + metrics
GET /api/executions/:executionId             full detail
GET /api/executions/:executionId/timeline    ordered event history
GET /api/alerts/:alertId/execution           null when none exists
```

GET only — there is deliberately no POST/PUT/PATCH/DELETE journal route, and a
test asserts every write verb 404s. The list returns summaries only; timelines
load exclusively when a detail view is opened. Page size is bounded
(`MAX_PAGE_SIZE = 100`) and sorting is stable (`updatedAt desc, id desc`).

### DTO rules

Prisma rows are never returned directly. Every monetary, price, quantity,
margin and PnL value leaves as an **exact decimal string or null** (never a JS
float); timestamps are ISO-8601 or null. Metadata is re-sanitized at the DTO
boundary, and unlike the write-time sanitizer — which redacts a credential-like
*value* but keeps the key — the boundary **drops the key entirely**, so no
response carries even the shape of a credential. `accountIdentifier` is never
copied into a DTO; only the profile name and environment are.

### Timeline ordering

`sequenceNumber` is authoritative. Two events can share a `createdAt`, so
sorting by time alone would present them in the wrong order; the UI shows the
sequence number explicitly and same-status events remain visible.

### Protection presentation

An execution is labelled protected only from the persisted verified protection
state, never from local intent rows. `TradeExecution.status` continues to
describe the entry lifecycle, so a `PARTIALLY_FILLED` entry with fully verified
protection still reads as partially filled — and still consumes its capacity.

### Unknown statuses

Every backend enum has a central frontend mapping. An unrecognised future value
is never styled as a success: it falls through to a warning tone and its raw
sanitized value stays visible. Completeness tests fail if a backend enum gains a
value the frontend has not learned about.

### Exit reason

The persisted `exitReason` wins. A lifecycle status is used as a fallback label
only where it unambiguously describes a position exit (`CLOSED_TP`,
`CLOSED_SL`, `CLOSED_EMERGENCY`). `FAILED`, `SKIPPED`, `CANCELED`,
`ENTRY_EXPIRED` and `MANUAL_INTERVENTION` are lifecycle outcomes, so no exit
reason is invented for them.

### Journal versus manual review

The Execution Journal is the authoritative automated lifecycle. The existing
`TradeReview` / `TradeJournal` records remain the user's own manual outcome and
retrospective notes; they are separate models, shown in separate labelled
sections, and Phase 8 neither merges nor overwrites them.

## Phase 9 — Telegram execution notifications

Phase 9 is **observability only**. It reads persisted execution state and sends
Telegram messages. It never submits or cancels an order, never changes leverage,
margin type or isolated margin, never closes a position, and never alters a
Phase 5 capacity decision, a Phase 6 entry reconciliation or a Phase 7
protection decision. Telegram availability has no influence whatsoever on
trading safety or lifecycle progress: the worst case is an undelivered row that
stays durable, visible and retryable.

### Durable outbox

A milestone is persisted first and delivered afterwards. No Telegram call ever
happens inside a lifecycle transaction, and no database transaction is held open
across an HTTP request. A Telegram failure therefore cannot roll back entry
reconciliation, fill persistence, SL or TP placement, margin handling, emergency
close or closure cleanup.

Two explicitly separated stages:

| Stage | Reads | Writes |
| --- | --- | --- |
| `materializeExecutionNotifications` | `TradeExecution`, `BinanceOrder`, `ExecutionProtectionState` | `ExecutionNotification` only |
| `dispatchPendingNotifications` | `ExecutionNotification`, `CriticalAlert` | delivery fields only |

Neither stage is wired to a worker, a queue, a scheduler or a poller. There is
no background daemon: a caller decides when to run each stage, so nothing in the
execution path can be delayed by Telegram.

### Relationship with the Phase 7 CriticalAlert

`CriticalAlert` remains the single authoritative durable record for every
critical condition (`STOP_NOT_VERIFIED`, `STOP_SUBMISSION_UNKNOWN`,
`LIQUIDATION_BUFFER_UNSAFE`, `MARGIN_TOP_UP_FAILED`,
`MARGIN_TOP_UP_RESULT_UNKNOWN`, `PROTECTION_COVERAGE_INCOMPLETE`,
`EMERGENCY_CLOSE_STARTED`, `EMERGENCY_CLOSE_FAILED`,
`POSITION_IDENTITY_CONFLICT`, `SIBLING_CANCELLATION_FAILED`,
`ORPHAN_PROTECTION_ORDER`, and the entry-cleanup reason codes that map onto
them). Phase 9 creates **no** competing critical model and no
`ExecutionNotification` row for a critical condition — it delivers the existing
record through the shared pipeline, preserving the Phase 7 dedupe identity.
Phase 9 writes only that row's delivery fields (`status`, `sentAt`, `attempts`,
`lastError`, `claimedAt`, `claimToken`).

### Milestones require durably confirmed state

| Notification | Earned only when |
| --- | --- |
| `LIMIT_PLACED` | the generation-1 ENTRY order has been read back by reconciliation and is `NEW`/`PARTIALLY_FILLED`/`FILLED` — never from a bare submission ACK, and never from `status == ENTRY_PENDING` alone |
| `PARTIAL_FILL` | `0 < confirmed filled < planned` |
| `POSITION_FILLED` | the ENTRY order itself is `FILLED` |
| `POSITION_PROTECTED` | the persisted protection state is `PROTECTED`, liquidation safety is verified true, and stop **and** take-profit coverage each equal the confirmed open quantity |
| `ENTRY_EXPIRED` | terminal `ENTRY_EXPIRED` **and** zero exposure proven by the persisted protection state |
| `CLOSED_TP` / `CLOSED_SL` / `CLOSED_EMERGENCY` | the corresponding terminal status has committed (Phase 7 has already proven position zero, entry remainder neutralized, sibling cleanup complete) |
| `TRADE_SKIPPED` | terminal `SKIPPED` — a retryable `UNAVAILABLE` or capacity conflict never reaches this status and is never called a skip |

### Dedupe

Every notification carries a deterministic key,
`sha256(executionId | type | discriminator)`, enforced by a **database unique
constraint** rather than an in-memory check, so concurrent materializers create
one row. The discriminator is empty for once-per-execution milestones,
the canonical cumulative filled quantity for `PARTIAL_FILL`, and the canonical
verified protected quantity for `POSITION_PROTECTED`. `0.10`, `0.1` and `0.100`
are the same milestone. Critical alerts reuse the Phase 7 dedupe key unchanged.

### Delivery, ordering and priority

Delivery is claim-based: an atomic conditional update leases a row, the lease is
released after the send, and a lease older than one minute is reclaimable so a
crashed process cannot strand a message. Batches are bounded and no invocation
loops. Critical alerts are claimed and delivered **before** any informational
message and are counted against a separate budget, so an informational flood
cannot starve a protection failure. Informational rows are ordered
`createdAt, milestoneSequence, id`, which guarantees a restart never delivers
`CLOSED_TP` before `POSITION_FILLED`.

Telegram provides no exactly-once guarantee. A crash between a successful send
and the local delivered mark re-sends the message. This is deliberate: durable
at-least-once delivery is safer than silently losing a critical notification,
and every message carries a stable `Ref:` line so a duplicate is recognisable as
the same milestone rather than a second fill or a second closure. Trading
correctness is never traded away for Telegram exactly-once.

### Financial semantics

Reused from Phase 8 unchanged. `netPnlUsd = realizedPnl - tradingFeesUsd +
fundingPnlUsd`, and only when all three are known; otherwise the message reads
`Not available`. Null is never rendered as `$0.00`, a zero fee is rendered as
zero, and negative realized PnL and paid funding stay negative. Nothing is
recomputed from exchange prices and no Binance income history is fetched.

### Routing

`TELEGRAM_EXECUTION_CHAT_ID` is optional. When set, execution milestones go
there; when empty they fall back to `TELEGRAM_CHAT_ID`. Critical alerts always
use the existing destination and are never duplicated into a second chat. The
same `TELEGRAM_BOT_TOKEN` serves both — there is no second bot. The token stays
environment-only, and no chat id is ever persisted, logged or written into a
notification payload.

### Message format

Plain text, matching the repository-wide convention: no `parse_mode` is ever
sent, so Markdown or HTML characters in a symbol, a reason code or an operator
message cannot break a parser and cause a silent delivery failure. Dynamic
fields are still flattened to a single line and length-bounded so nothing can
forge extra message structure. Decimals are shown exactly (trailing zeros
dropped — a lossless rewrite, never a rounding). Messages never contain a bot
token, API key or secret, authorization header, signed URL, raw Telegram or
Binance payload, wallet or available balance, account identifier, client order
id or stack trace.

### Phase 9 runtime — how notifications actually run

`runExecutionNotificationTick()` is the production entry point. One bounded pass
discovers unmaterialized history, materializes the intents it earns, delivers
critical alerts, delivers informational notifications, and returns. There is no
loop inside it and it never throws.

It is scheduled by `execution-notification.scheduler.ts` on a 60-second
interval, started once from the existing worker entrypoint
(`vision-analysis.worker.ts`) next to the cleanup and retention schedulers and
cleared by the same SIGTERM handler. An overlap guard skips a tick while the
previous one is still running. No second daemon, no queue, no HTTP trigger, no
Binance polling.

#### Durable source per notification

| Notification | Authoritative durable source |
| --- | --- |
| `LIMIT_PLACED` | `ExecutionEvent(ENTRY_RECONCILED).metadata.localOrderStatus` in an accepted state |
| `PARTIAL_FILL` | `ExecutionEvent(ENTRY_RECONCILED).metadata.cumulativeFilledQuantity` — the quantity **at that event** |
| `POSITION_FILLED` | the same event with `localOrderStatus = FILLED` |
| `POSITION_PROTECTED` | `ExecutionProtectionVerification` — one immutable row per proven full-coverage verification |
| `ENTRY_EXPIRED` / `CLOSED_TP` / `CLOSED_SL` / `CLOSED_EMERGENCY` / `TRADE_SKIPPED` | `ExecutionEvent.toStatus` — the status the event committed |
| `CRITICAL_PROTECTION_FAILURE` | Phase 7 `CriticalAlert` |

Quantity-sensitive milestones read the quantity that belonged to the historical
event, never today's latest value. That is what lets a runner that was offline
across `0.10 → 0.15 → 0.25` still emit both partial fills instead of only the
final fill, and a runner offline across `protected 0.10 → protected 0.25` emit
both protection milestones.

The lifecycle writes this history inside the transaction it was already
committing. No Telegram call, no notification-table write and no network
activity was added to any trading transaction, and execution correctness never
depends on an `ExecutionNotification` insert.

#### Discovery and crash semantics

`ExecutionNotificationCheckpoint` holds one row per processed source, linked by a
UNIQUE foreign key to either the `ExecutionEvent` or the
`ExecutionProtectionVerification` it covers. Discovery asks each history table
for rows with no checkpoint — an index-backed anti-join, bounded per tick, never
a timestamp watermark (two events can share a `createdAt` and a watermark would
skip one).

The notifications derived from a source and that source's checkpoint commit in
one transaction:

- crash before commit → no checkpoint, the source is rediscovered;
- crash after commit → both exist, and the unique dedupe key stops a replay from
  creating a second row;
- two runners on the same source → the unique checkpoint lets exactly one win,
  and the loser's `P2002` is treated as "already done".

Sources that earn no milestone are still checkpointed, so ordinary lifecycle
events are not rescanned forever.

#### Ordering after downtime

Informational rows carry `milestoneSequence` taken from the source's own causal
position — `ExecutionEvent.sequenceNumber` for lifecycle events — and delivery
orders by `createdAt, milestoneSequence, id`. A closure recovered together with
the fill it closes is therefore delivered after that fill, never before it,
regardless of what the execution's current status says. Critical alerts keep
delivery priority over every informational message.

#### Telegram disabled

When `TELEGRAM_NOTIFICATIONS_ENABLED` is false (or no bot token is configured):

- materialization still runs, so durable history is never lost;
- dispatch returns before claiming anything — zero HTTP calls;
- no attempt is consumed, so repeated scheduler ticks cannot exhaust the bounded
  retry budget and there is no busy-loop;
- nothing in any execution table changes.

Switching Telegram back on finds every intent still `PENDING` with
`attemptCount = 0`, and the next tick delivers them in causal order.
