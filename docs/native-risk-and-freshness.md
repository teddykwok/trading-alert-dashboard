# Native risk contract and signal freshness (Milestone 5)

Milestone 5 adds two fail-closed rules to the Native (scanner-produced)
execution path that Milestone 4 built ([native-account-a-canary.md](native-account-a-canary.md)):

- **Native Risk Contract V1.** A Native trade needs an explicit, per-account
  approval of how much it may risk. Neither account has one.
- **Native Signal Freshness V1.** A Native signal's lifetime is anchored to the
  close of the operational 15m bar it was observed on, not to 300 seconds from
  the touch.

Nothing is enabled. `NATIVE_EXECUTION_ENABLED` is still `false as const`, and
the hard switch is still the first refusal everywhere. No schema change, no
migration, no route, no UI control and no environment variable was added.
TradingView execution is unchanged, including its 300-second signal age.

---

## Native Risk Contract V1

### Status

| Account | Status | Amount |
| --- | --- | --- |
| A | `UNRESOLVED` | none |
| B | `UNRESOLVED` | none |

The table is `NATIVE_RISK_CONTRACTS` in
`apps/backend/src/modules/native-canary/native-risk-contract.ts`. It holds no
amount, no percentage, no default and no fallback. A test pins that the module
contains no digit at all, and that no production source assigns a Native risk
amount anywhere.

Nothing outside that table can resolve a contract:

- no environment variable, and no env file (generic, `account-a.env`,
  `account-b.env`): the contract and gate modules read no environment;
- not the TradingView risk template, the safety-policy caps
  (`maxTotalPlannedRiskUsd`) or any database row;
- not a planner lookback window (see "100 and 300" below).

Resolving a contract is a reviewed code change to that table, made only after
the operator decision listed at the end of this document.

### The gate

`judgeNativeRiskReadiness(accountSlot, riskBudgetUsd)`
(`native-risk-gate.ts`) looks up the code-fixed contract for the account this
process proved it is, then judges the risk budget the trade would actually
use:

| Verdict | When |
| --- | --- |
| `NATIVE_RISK_UNRESOLVED` | No contract for this process (B is UNRESOLVED; generic and unproven processes have none), or the contract is UNRESOLVED, belongs to another account, or names no exact positive USDT amount. |
| `NATIVE_RISK_BUDGET_INVALID` | The trade's risk budget is not an exact positive decimal string. |
| `NATIVE_RISK_EXCEEDS_CONTRACT` | The budget is above the contract's `maxRiskPerTradeUsd`. |
| ready | Budget at or below the contract. |

It is a **cap, not a sizing rule.** The budget is still the plan's frozen
risk-template snapshot (`template.riskAmount`), exactly as for TradingView.
The gate never resizes, rounds or replaces it. No caller passes a contract in,
so no caller can hand the gate a RESOLVED one.

### Where it refuses

Always **after** the hard switch, so the switch still wins while it is false:

| Where | Before |
| --- | --- |
| Decision stage `RISK` (after `NATIVE_FENCE`) | any hand-off is issued |
| The Native fence in `handleNativeAccountACandidate`, judged against `handoff.template.riskAmount` | the margin planner's signed reads |
| The Native fence at entry lifecycle **F0**, judged against the execution's frozen `riskBudgetUsd` | revalidation's signed reads and any reservation |
| **F2** | margin-type and leverage configuration |
| **F3**, immediately before each call | `setIsolatedMarginType`, `setInitialLeverage`, `submitLimitEntry` |

The entry lifecycle's codes gained `NATIVE_RISK_UNRESOLVED`,
`NATIVE_RISK_BUDGET_INVALID` and `NATIVE_RISK_EXCEEDS_CONTRACT`.

Phase 5 has no notion of the contract and keeps all its own limits
(`maxTotalPlannedRiskUsd`, margin, counts, session budget). A Native execution
can only exist if the executor created it after the gate admitted it, and F0
re-judges the contract before any entry work.

### 100 and 300 are lookbacks, not money

`NATIVE_PLAN_BUILTIN_DEFAULTS = { A: 100, B: 300 }` are **planner lookback
windows in candles**. They are not dollars, USDT risk, percent, leverage,
order size, notional or a daily budget.

Where monetary risk actually comes from (key names and code defaults only;
live values are not reproduced here):

| Quantity | Source | Unit | Rule |
| --- | --- | --- | --- |
| Risk per plan | the active `RiskTemplate` row (`referenceCapital`, `riskPercent`, `rewardRatio`), snapshotted into each plan at generation | USDT, percent | `riskAmount = referenceCapital × riskPercent / 100`, `targetAmount = riskAmount × rewardRatio` (`calculateRiskTemplateAmounts`) |
| Trade risk budget | the plan's own frozen snapshot, `template.riskAmount` | USDT | handed to the margin planner as `riskBudgetUsd` |
| Quantity, margin, leverage | margin planner (`calculateDynamicLeveragePlan`): `BINANCE_TARGET_MARGIN_MULTIPLIER` (code default 2.5), `BINANCE_MAX_MARGIN_MULTIPLIER` (3.333333), `BINANCE_MIN_MARGIN_USD` (0), `BINANCE_LIQUIDATION_BUFFER_RATIO` (0.5), `BINANCE_MAX_AUTOMATION_LEVERAGE` (25) | USDT, ratios, x | quantity = floor(risk / stop distance, step); planned loss ≤ risk; margins = risk × multipliers; leverage capped by bracket and the automation cap |
| Total exposure caps | Phase 5: `EXECUTION_MAX_TOTAL_PLANNED_RISK_USD` (code default 1.50), `EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD` (5.00) | USDT | effective = min(env, profile policy); a missing policy fails closed |
| Session budget | `TradingSession.tradeBudget` | trades (a count) | presets 10/50/100/200/300 are trade counts that only coincide numerically with the lookbacks |

The lookback changes the stop-loss **geometry** (the extreme over the window),
which changes quantity through the stop distance. It never changes the
monetary risk budget. Tests prove it structurally: no lookback identifier
appears in the risk gate, the margin engine or planner service, Phase 5, the
entry lifecycle or the risk-template service. The executor's only
`riskBudgetUsd` is `handoff.template.riskAmount`. The gate refuses the numbers
100 and 300 even when handed them as a budget. And with a synthetic contract
capped exactly at the template amount, a plan one cent richer is refused at
`RISK` although its window (100) is far below the cap.

---

## Native Signal Freshness V1

### The rule

```
operationalBarClose = barStart + 15 min
postCloseExpiry     = operationalBarClose + 5 min
absoluteExpiry      = triggeredAt + 20 min
expiresAt           = min(postCloseExpiry, absoluteExpiry)

fresh  <=>  triggeredAt <= now <= expiresAt          (millisecond precision)
```

Each valid touch gets up to 5 minutes after its 15m bar closes. No signal can
live more than 20 minutes from the actual touch. One pure module computes it,
`native-canary/native-signal-freshness.ts`:

- `nativeSignalWindowOf(alert)` derives and validates the window;
- `judgeNativeSignalFreshness(window, nowMs)` makes the only comparison;
- `nativeSignalExpiryOf` is the formula alone;
- `nativeSignalLifetimeSpan` is discovery's superset filter.

### The anchor: persisted evidence only

- **barStart** is the alert's own `rawPayload.delivery.barStart`: exact ISO
  milliseconds, equal to `rawPayload.barTime`, on a 15m boundary, and matching
  the payload's shadow-event hash (`nativeExecutionProvenanceOf`). The native
  emitter writes it from the winning observation's bar. It is never the
  1D/1W/1M source candle, never the wall clock and never processing time. No
  migration was needed.
- **triggeredAt** is `Alert.triggeredAt`, the exchange event time of the
  touching kline update. The payload's `triggeredAt` must be the same instant,
  and an execution's frozen `signalTriggeredAt` must equal it.

Anything missing, unreadable, inconsistent, impossible or unattributable is
refused, never assumed. That includes a V1 payload, a missing or malformed
`barStart`, a `barTime` mismatch, a broken hash, a row/payload trigger
mismatch, or a non-NATIVE alert.

### Boundaries (from the scanner's own semantics)

- A touch cannot predate its own bar. The scanner's log reader already rejects
  that as `IMPOSSIBLE_ORDERING` (`shadow-log-reader.ts`), so
  `triggeredAt < barStart` is refused.
- A touch **at or after** the nominal close is legal: the live session emits
  observations on the bar's closing update, and the reader sets no upper
  bound. Such a touch stays on its own bar and gets `close + 5 min`, never a
  next-bar window.
- `now == expiresAt` is fresh; one millisecond later is stale.
- `now < triggeredAt` is refused (`TIME_IN_FUTURE`), with **no** clock-skew
  tolerance. Discovery only offers plans whose trigger is not after `now`.
- Because `triggeredAt >= barStart`, `postCloseExpiry <= absoluteExpiry` for
  every valid alert. The 20-minute cap is defence in depth, pinned separately
  on the formula.

Verdicts: `fresh`; `STALE`, which is permanent because the expiry is fixed by
persisted evidence; `TIME_IN_FUTURE`; `EVIDENCE_INVALID`. Canary codes:
`NATIVE_SIGNAL_STALE`, `NATIVE_SIGNAL_TIME_UNAVAILABLE`.

### Where it applies (Native only)

| Site | Native behaviour |
| --- | --- |
| Adoption discovery | Plans whose trigger is within `[now − 20 min, now]` (was `now − 300 s`). |
| Adoption deferral | A `PENDING_BAR_CLOSE` bar is deferred **only while fresh**. Once the expiry passes it is claimed and refused `NATIVE_SIGNAL_STALE`, terminally and once. |
| Decision stage `FRESHNESS` (after `PLAN`, before `INTEGRITY`) | Refuses `NATIVE_SIGNAL_STALE` / `NATIVE_SIGNAL_TIME_UNAVAILABLE`. |
| Executor, before the margin planner's signed reads | Re-judged at a fresh instant. |
| Phase 5 | Judged once at the admission's `evaluatedAt` and handed to the pure engine. `STALE` gives `ALERT_STALE`; anything else not fresh gives `SIGNAL_TIME_UNAVAILABLE`; both are terminal. A Native signal that is not fresh skips the exchange reads entirely, like the kill switch. It **replaces** `maxAlertAgeSeconds` for Native only. |
| Entry revalidation | Refuses `SIGNAL_OR_ENTRY_DEADLINE_EXPIRED` before the first signed read. |
| PREFLIGHT release / retry | Only a **proven** `STALE` terminalizes (`PREFLIGHT_SKIPPED_SIGNAL_EXPIRED`), after the existing risk-reducing flatness proof. Unprovable evidence is left alone, like a missing `signalTriggeredAt`. |

Integrity and freshness compose causally: touch, then the bar forms
(`PENDING_BAR_CLOSE`, deferred), then the bar closes and the scanner commits
it (`ELIGIBLE`), and the window stays open until `expiresAt`. If integrity
does not become executable before `expiresAt`, the refusal is stale. There is
no `eligibleAt` state, no migration and no processing-time freshness. Every
site, retry and restart computes the same expiry, because it depends only on
persisted evidence.

### TradingView is unchanged

TradingView executions keep the existing rule at every site: 300 seconds
(`EXECUTION_MAX_ALERT_AGE_SECONDS`, min-merged with the policy in Phase 5)
from `Alert.triggeredAt`, measured in whole seconds, with the 5-second future
tolerance in Phase 5. The TradingView adoption pass, its fence, `handleSelectedPlan`
and creation are untouched. Phase 5 skips no read for TradingView. A Native
verdict is attached only to a Native execution.

---

## Operator decision required before the first real Native trade

M5 deliberately makes none of these. Each is a financial or product choice:

1. **The Native risk amount per account.** Set `maxRiskPerTradeUsd` for
   Account A (and, separately, B) in `NATIVE_RISK_CONTRACTS` by a reviewed code
   change. Until then every Native candidate is refused `NATIVE_RISK_UNRESOLVED`.
2. **The sizing source.** Today a Native plan is still sized by the global,
   TradingView-configured `RiskTemplate` snapshot, and the contract only caps
   it. Decide whether Native should have its own template, or whether a cap
   over the shared template is the intended model.
3. **Enabling execution at all.** Flipping `NATIVE_EXECUTION_ENABLED` is a
   separate reviewed change. It is not part of M5.

## Future Account B milestone

Account B's intended planner window is 300 candles, but a READY plan persists
only one selected window (the generic `EXTREME_RR_LOOKBACK_CANDLES`), not a
per-account one. Executing B's window needs it persisted with the plan, which
is a schema change. B also remains non-runnable here: it is refused at
`ACCOUNT`, its contract is UNRESOLVED, and its scheduler starts nothing.

## Tests

- `tests/native-m5-risk-contract.test.ts` (pure, structural): the 15 risk
  requirements, the gate's decimal semantics, and the structural proofs (where
  the gate is called, that the contract has no money and reads no
  environment, that lookbacks cannot reach sizing, and that no route or UI
  control was added).
- `tests/native-m5-signal-freshness.test.ts` (pure, structural): freshness
  matrix A–R pinned to the millisecond, the Phase 5 engine mapping, and the
  structural proofs (one canonical helper, every Native site converted, the
  TradingView rule byte-for-byte unchanged).
- `tests/native-m5-risk-freshness.integration.test.ts` (`_test` DB, every
  private adapter a trap): adoption deferral and stale refusal, discovery's
  lifetime bound, lease-reclaim determinism; risk past the switch at the
  decision, F0 and F2; revalidation, Phase 5 and PREFLIGHT release for Native
  and TradingView.
- `tests/native-account-a-canary-isolation.integration.test.ts` gained the M5
  cases. Past the switch, on the real signing clients, an UNRESOLVED contract
  gives 0 signatures, 0 requests and 0 mutations. With a synthetic resolved
  contract the same candidate does reach the exchange, so the trap is live.
- The Milestone 4 suites run on the fixture clock, with the synthetic resolved
  contract where they need to reach past the switch.
