# Live canary runbook

Operator procedure for the $1.50 real-money canary. **Nothing in this document
is automated.** Every step is performed deliberately by a human.

> **Current status: the canary cannot run yet.** The Phase 5–7 execution
> lifecycle is fully implemented and tested, but no production caller invokes
> it — nothing creates a `TradeExecution`, submits an entry, reconciles a fill
> or places protection. See *Blocker* below. This runbook is written and ready
> for when that gap is closed.

---

## Blocker: execution orchestration is not wired

`pnpm --filter @trading-alert-dashboard/backend execution:canary-preflight`
reports `CANARY_BLOCKED_ORCHESTRATION_NOT_WIRED`.

The production chain today is:

```
TradingView webhook → Alert persisted → vision worker (screenshot + AI)
  → Extreme RR plan generated → Telegram plan message
  → ✗ STOPS HERE
```

`SafetyAdmissionService`, `ExecutionService`, `EntryLifecycleService` and
`ProtectionLifecycleService` are never constructed outside tests, and no startup
recovery scan exists. Until an execution orchestrator is registered in the
worker runtime, opening the live gates would change nothing — no order would be
placed. That is a safe failure, but it is a failure.

Closing this gap is its own piece of work and must not be improvised as a side
effect of a readiness phase.

---

## Dedicated laptop readiness

Run these yourself; nothing here changes a Windows setting automatically.

| Check | Command / action |
| --- | --- |
| AC power connected | Physically confirm |
| Sleep disabled on AC | `powercfg /change standby-timeout-ac 0` |
| Display sleep (optional) | `powercfg /change monitor-timeout-ac 0` |
| Hibernate behaviour understood | `powercfg /a` — know what your lid-close does |
| Windows time sync on | `w32tm /query /status` then `w32tm /resync` |
| Network up | `ping -n 4 fapi.binance.com` |
| PostgreSQL reachable | preflight reports `databaseReady` |
| Redis reachable | preflight reports `redisReady` |
| Backend running | `pnpm --filter @trading-alert-dashboard/backend dev` |
| Worker running | `pnpm --filter @trading-alert-dashboard/backend worker` |
| Notification scheduler alive | preflight reports `notificationSchedulerReady` |

**A canary never borrows the vitest database.** Point a TESTNET canary at its
own database, not at the one `pnpm test` uses. The suite truncates and reseeds
what it finds, and rows a canary leaves behind outlive the canary: a previous
run's residue surfaced later as an unexplained `critical alert outbox` failure
that cost more to diagnose than a separate database costs to create.

**Timezone is irrelevant to signing.** Binance signs against epoch milliseconds
and the client applies a measured server-clock offset, so only *absolute* clock
accuracy matters — never the displayed zone.

### Automatic restart

The repository intentionally has no process supervisor, and adding a heavyweight
one is not warranted. The smallest appropriate approach on Windows:

1. Create two `.bat` wrappers, one per process (`backend`, `worker`), each
   running its `pnpm` script.
2. Register each with **Task Scheduler** manually: trigger *At startup*, enable
   *Restart on failure* (e.g. every 1 minute, 3 attempts), run whether logged in
   or not.

Do this by hand. Correctness must not depend on it — forced termination has to
recover safely regardless, which is what the restart canary below checks.

---

## Network and IP

The key is IP-restricted at Binance. Do not disable that, and do not edit the
allowlist automatically.

The preflight requires **3 consecutive successful signed health checks**; a
transient `-2015` / IP-restricted / auth failure blocks the canary
(`CANARY_BLOCKED_IP_RESTRICTION` / `CANARY_BLOCKED_BINANCE`).

A residential ISP can rotate your egress IP mid-trade, which would break
reconciliation exactly when it matters. A stable VPS or static outbound IP
remains the production target.

---

## Gate windows

Inspect `env.ts` rather than trusting this table blindly — but as of Phase 11A,
one live entry plus protection requires exactly:

### BEFORE CANARY

```
EXECUTION_GLOBAL_KILL_SWITCH=true
EXECUTION_LIVE_ENTRY_ENABLED=false
EXECUTION_PROTECTION_READY=false
EXECUTION_AUTO_ADD_MARGIN_ENABLED=false
EXECUTION_EMERGENCY_CLOSE_MODE=DISABLED
BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED=false
BINANCE_TEST_ORDER_ENABLED=false
```

Profile kill switch (`ExecutionSafetyPolicy.killSwitchActive`) engaged.

### AUTHORIZED CANARY WINDOW

Change only these, and only after preflight preparation is clean:

```
EXECUTION_GLOBAL_KILL_SWITCH=false
EXECUTION_LIVE_ENTRY_ENABLED=true
EXECUTION_PROTECTION_READY=true
```

Plus disengaging the profile kill switch.

Everything else stays at its BEFORE value. Auto-add-margin and emergency-close
remain off — each needs its own separate justification, testing and
authorization.

### AFTER CANARY

Restore every value in the BEFORE block and re-engage the profile kill switch.
Confirm with a fresh preflight.

---

## First LONG canary

1. Preflight: preparation section fully clean.
2. Binance `nonZeroPositionCount = 0`.
3. Binance `openOrderCount = 0`.
4. Local `activeExecutionCount = 0`, `pendingEntryCount = 0`, `recoveryRequiredCount = 0`.
5. 3/3 consecutive signed health checks.
6. Worker and notification scheduler alive.
7. Risk policy verified: planned risk `1.50`, target margin `3.75`, max margin `5.00`.
8. One-trade policy verified: max open / pending / active all `1`.
9. Record `git rev-parse HEAD`.
10. Record the safe configuration state (names and booleans only).
11. Open **only** the AUTHORIZED CANARY WINDOW gates.
12. Trigger exactly one LONG signal through the normal webhook path. **Do not
    add a bypass** — the signal must pass safety admission on its own merits.
13. Observe LIMIT submission; confirm one client order id, `tad-en-1-*`.
14. Observe fill or partial fill.
15. Verify protection per Phase 7: STOP verified before or with TP; coverage
    equals confirmed exposure.
16. Verify the journal: planned vs actual, timeline ordered by `sequenceNumber`.
17. Verify Telegram: `LIMIT_PLACED` → (`PARTIAL_FILL`) → `POSITION_FILLED` →
    `POSITION_PROTECTED`.
18. Monitor to a terminal state, or continue monitoring deliberately.
19. Restore gates to the AFTER CANARY state.

## First SHORT canary

Identical, with a SHORT signal, and **only after the LONG canary is completely
terminal and the account is clean again**. Never run LONG and SHORT
simultaneously during initial validation — a shared failure would be
ambiguous.

---

## CLOSED_TP checklist

- Binance position for the symbol/side is zero.
- The entry remainder is neutralized (no resting `tad-en-1-*`).
- Protection siblings cancelled or neutralized; no orphan STOP/TP.
- `TradeExecution.status = CLOSED_TP`.
- Capacity released — a fresh preflight shows `activeExecutionCount = 0`.
- Journal shows the exit price and realized PnL; unknown fees/funding read
  "Not available", never `0`.
- Telegram delivered `CLOSED_TP` exactly once.

## CLOSED_SL checklist

Identical, with `CLOSED_SL` and the `🛑` message. Realized PnL is expected to be
negative and must be displayed negative.

TP and SL do **not** both need to occur in one session; validate them over
separate $1.50 canaries.

---

## Entry-expiry canary

Run later, separately. A LIMIT order that stays unfilled through its TTL should
go `ENTRY_PENDING` → cancel remainder → reconcile → `ENTRY_EXPIRED`, with
`ENTRY_EXPIRED` only when **zero** fill occurred.

If it partially filled, it must **not** be called `ENTRY_EXPIRED`: Phase 6
behaviour is preserved and the filled exposure is protected.

---

## Restart canary

Only after a basic live execution has already succeeded, and only with separate
authorization.

Scenarios: restart while `ENTRY_PENDING`; later, restart while `PROTECTED`.

Never delete local state and never touch Binance orders by hand as part of it.

After restart verify: the persisted execution is rediscovered; the **same
deterministic client order ids** are reused; exchange state is reconciled;
protection is verified or restored; and **zero duplicate orders** exist.

---

## Restoring the safe state

After completion or abort, in this order:

1. Re-engage the profile kill switch.
2. Set `EXECUTION_LIVE_ENTRY_ENABLED=false` and `EXECUTION_PROTECTION_READY=false`.
3. Set `EXECUTION_GLOBAL_KILL_SWITCH=true`.
4. Restart the backend and worker so the new values are loaded.
5. Run the preflight and confirm the LIVE-ACTIVATION blockers are back.

If a canary aborts with exposure still open, restoring the gates does **not**
close it. Risk-reducing paths (cancel, protection) are deliberately not gated on
the live-entry switches precisely so a resting order stays cancellable — but any
manual decision about live exposure is yours to make.
