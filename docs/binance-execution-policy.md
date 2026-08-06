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
