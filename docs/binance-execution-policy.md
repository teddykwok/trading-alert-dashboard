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
