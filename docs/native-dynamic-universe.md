# Native dynamic universe (Teddy 7% All Active)

**Who this is for:** the operator running the Native scanner, and engineers changing it.

This page covers how the scanner decides which Binance symbols to scan and how that set changes while it runs.

The Native scanner profile `teddy-7-all-active` (`TEDDY_7_ALL_ACTIVE_V1`) scans every active Binance USD-M USDT perpetual. You never maintain a watchlist: the scanner reads Binance's public `exchangeInfo` and follows it, while the scanner is running, with no restart.

Native alerts are dashboard-only. They are `source=NATIVE` and `actionable=false`, and Native execution is hard-disabled in code (`alerts/alert-source.ts`). Nothing in this feature changes that.

## Semantics and identity

| | |
|---|---|
| Engine lifecycle | `TEDDY_DYNAMIC_SOURCE_LEVEL_V1` (unchanged: 7% qualification, running high/low candidates, full-bar timers 5/4/10) |
| History origin | `SYMBOL_FIRST_CLOSED_BAR_V1` (new; part of the engine fingerprint) |
| Universe lifecycle | `DYNAMIC_UNIVERSE_V1` (new; refresh, onboarding, removal, return) |
| Symbol trust | `EXCHANGE_INFO_UNICODE_V1` (new) |
| Engine fingerprint | `35f1a32d82ac2786ee67dd4c5146760bf1f29d5025cafe01da5394b79a9b47fb` |
| State namespace | `%LOCALAPPDATA%\trading-alert-dashboard\scanner\live-shadow-engines\35f1a32d82ac2786ee67dd4c\` |

**Old state is never reused.** These namespaces stay exactly as they are; nothing reads, migrates or deletes them:
- `5cd970a6…`: the first dynamic 7% engine, which had a fixed history origin.
- `47d661a5…`: the legacy 7% engine.
- `3e21f1c1…`: Teddy Aggressive (18%), which is unchanged.

A namespace whose `ENGINE.json` names another fingerprint is refused. The first run of the new engine therefore bootstraps every symbol from public klines.

## Each symbol's history starts at its own first real bar

The profile still has a history start (2026-01-01), a context start (2025-12-29) and a switchover (2026-09-12T01:00Z). For each symbol:

```
effectiveContextStart = max(profileContextStart, symbolFirstRealClosed15m)
effectiveHistoryStart = max(profileHistoryStart, symbolFirstRealClosed15m)
effectiveSwitchover   = max(profileSwitchover,   effectiveHistoryStart + one 15m bar)
```

- **Symbols listed before the context start** keep the profile's ranges exactly (origin `PROFILE_CONTEXT`). Their engine state is identical, bar for bar, to the previous engine's; only the lineage identity differs.
- **Symbols listed later** start at their first real closed 15m bar (origin `SYMBOL_FIRST_CLOSED_BAR`). There is no `TOO_NEW` any more and no minimum age.
- **Pre-listing absence is not a gap.** The bars before a listing never existed, so none are demanded and none are ever fabricated. A real missing bar *after* the first bar is still a gap: the symbol is quarantined.
- **The listing's own source periods are valid.** A symbol listed on a Wednesday at 10:00 has a first 1W candle built from its real bars from Wednesday 10:00 onward, and the same holds for 1D, 1M, 3M, 6M and 12M. The listing bar's open is that period's real open. This is the one engine-input change (shared `listingOpenTimeMs`), and only a symbol-origin history uses it. The 7% formulas are unchanged.
- **One structural minimum.** A listing after the switchover needs two closed bars: one history bar for the lineage, then one causal bar for the live checkpoint. That is about 30 minutes. It is a consequence of the lineage structure, not a product rule.

### How the first real bar is found

1. **Cache.** If the verified kline cache holds a bar at the context start, the origin is `PROFILE_CONTEXT`, with no request.
2. **Binance.** Otherwise the scanner makes one public request for `GET /fapi/v1/klines?startTime=<context start>&endTime=<now>&limit=2`, preceded by `/fapi/v1/time`. Binance returns the earliest bars first.
   - **The first bar opens at the context start:** the origin is `PROFILE_CONTEXT`.
   - **The first bar opens later and has closed:** that bar is the symbol's origin. If `onboardDate` disagrees, the real bar wins and the difference is logged as `ONBOARD_DISCREPANCY`.
   - **No bar yet, or the first bar is still forming:** `WAITING_FIRST_CLOSED_BAR`, retried at the next close.
   - **A failed request, malformed or out-of-order rows, or a bar before the start:** `BOOTSTRAP_UNREADABLE`, retried after 1, 5, 15, then 60 minutes. UNKNOWN is never treated as ABSENT.
   - **429 or 418:** halts all REST for the run, as everywhere else in the scanner.

## Periodic refresh while running

- **Interval.** Every **5 minutes** (`operations.universeRefreshMs`, allowed range 1–60 minutes). Each refresh is one public `exchangeInfo` request (weight 1) through the same governed, serial, budgeted transport as all scanner REST.
- **Fencing.**
  - Only one refresh runs at a time; an overlapping attempt is counted as suppressed.
  - No refresh runs before start-up completes.
  - A refresh that resolves after stop changes nothing.
- **Failure keeps the last-known-good universe.**
  - These cases evict nothing and are reported:
    - an `exchangeInfo` error;
    - an empty target universe;
    - an implausible mass removal (more than max(25, 25% of members) at once).
  - The status file shows `lastResult`, `lastError` and `consecutiveFailures`.
  - After two intervals without a good refresh it shows `stale: true`.
- **An unchanged universe is cheap.** It costs one request: no kline request, no connection change, no rebuild. Only new, returning or recovering symbols touch klines, and they fetch only what is missing.

## A new listing joins without a restart

```
DISCOVERED (PENDING)
  -> BOOTSTRAPPING            first real closed bar, then causal replay from it (non-delivering)
  -> checkpoint written       only if the symbol is still wanted (generation fence)
  -> placed on a connection   fewest symbols with room, or a new connection under the ceiling
  -> connection rebuilt once  controlled; the existing hwm handshake closes the REST/WS gap
  -> readiness on its first stream update (that bar is QUARANTINED)
  -> LIVE from the next 15m boundary
```

- **One worker, one bootstrap.** Each symbol has exactly one worker; refreshes never create a second one, and at most one bootstrap is in flight per symbol. Bootstraps share the REST concurrency bound with recoveries.
- **Bootstrap never delivers.** History replay writes nothing to the shadow event log, so there is nothing an emitter could deliver. Observations exist only for bars that become `LIVE_ELIGIBLE` after readiness.
- **No lost or duplicated closed bars.**
  - Closed bars are committed strictly by open time from the session's high-water mark.
  - If the stream's first update is ahead of the checkpoint, the missing closed bars are recovered by REST (`REPLAYED_NON_ACTIONABLE`).
  - A WebSocket close for a bar already committed is ignored when identical, and triggers recovery when it contradicts the committed bar.
- **What a rebuild costs.** Neighbours on the rebuilt connection quarantine their bar in progress, then recover their closed gap (usually zero requests, because no bar closed meanwhile). If every connection is full, the newcomer opens a new connection and nobody is disturbed.
- **The emitter learns of joins.** Joins are appended to the run's membership journal (`live-shadow-supervisor/runs/<runId>/membership.jsonl`: append-only, hash-chained). The manifest is still written once and never rewritten; dynamic runs use manifest `v2`, whose symbols carry their history origin. A pinned `native-alerts:multi-emitter` binds each `JOINED` symbol with the manifest's checks (the profile rebuilds its lineage, and its checkpoint names it). It activates the symbol at its current end-of-file, so nothing written before the binding is delivered. A journal that fails verification stops new bindings only.

## Symbols that leave, and come back

- **Leaving: INACTIVE.** A symbol that leaves the target universe (SETTLING, not TRADING, not PERPETUAL, not USDT) becomes `INACTIVE`:
  - no new observations; a late WebSocket message is counted and ignored;
  - it is taken off its connection, and the subscription is dropped at that connection's next connect;
  - its checkpoint, shadow evidence, kline cache, alerts and plans are untouched;
  - no close event is invented.
- **Returning with the same contract identity.** Same baseAsset, quoteAsset, contractType, onboardDate and underlyingType:
  - the same worker and lineage resume;
  - the closed bars missed meanwhile are caught up (non-actionable), and the symbol rejoins once (`REACTIVATED`).
- **Returning with a gap.** If the returning symbol's bars do not continue from its checkpoint (a real halt gap), it is `QUARANTINED`, never bridged.
- **Changed identity.** A changed contract identity under the same symbol is `QUARANTINED` and not retried automatically.

## Unicode symbols

- **Trust model.** A symbol is trusted only because the current `exchangeInfo` lists it as TRADING, PERPETUAL and USDT. The exact string Binance returns is the identity; it is never rewritten, transliterated or aliased. Operators can still name ASCII symbols only (`--symbols`, `--include-symbols`), so an arbitrary Unicode string can never become a scanned symbol.
- **Accepted shape.** NFC-normalised, 3–30 code points, each an ASCII `A-Z`/`0-9` or a non-ASCII letter or number with **no case** (for example CJK). Examples that pass: `币安人生USDT`, `我踏马来了USDT`, `龙虾USDT`, `牛来USDT`, `哈基米USDT`.
  - Fails closed: cased non-ASCII letters, combining marks, punctuation, separators, whitespace and control characters.
- **On disk.** An ASCII symbol is its own directory and file name, so every existing path is unchanged. Any other symbol is `u-<lower-case hex of its UTF-8 bytes>`: reversible, collision-free, case-insensitive-safe and traversal-free. The exact symbol is stored inside every file (checkpoint, cache manifest, events, cursors, manifest, journal).
- **On the WebSocket.** The stream name is the symbol lower-cased plus `@kline_15m` (`币安人生usdt@kline_15m`), carried percent-encoded as UTF-8 in the combined `/market/stream` URL. That exact form was verified against Binance's public stream on 2026-10-05: the stream echoed the decoded name, and `s` / `k.s` carried the exact symbol. Raw single-symbol `/market/ws/` mode stays ASCII-only.
- **Redis.** The scanner and emitter use no symbol-keyed Redis key.

## Capacity

- **The ceiling.** 16 connections × 50 symbols = 800.
- **At start-up.** A larger target universe is refused before any request.
- **While running.** A universe that outgrows the ceiling admits **nobody new**. The status reports `capacity.exceeded: true`, `allActiveSatisfied: false` and the symbols not admitted. Nothing is truncated silently, and the next refresh that fits admits them.

## Telemetry (status file `universe` block and totals)

- **Refresh state:** generation, last attempt and success, last result and error, consecutive failures, stale flag, next refresh.
- **Refresh counters:** refreshes, failures and suppressed refreshes.
- **Universe:** exchange candidates; the latest refresh's added, removed, reactivated, identity-conflict and not-admitted symbols.
- **Capacity:** required versus available.
- **Totals:**
  - symbol states: bootstrapping, waiting for a first closed bar, unreadable, quarantined, inactive, awaiting placement;
  - connections: connections open and connection rebuilds;
  - plus the existing live, recovery, reconnect and backpressure counters.
- **Per symbol:** origin, onboard discrepancy, next attempt, inactive-since, and the encoded state directory.

## Operational notes

- **Request budget.** `--max-total-requests` is a run-wide budget that includes every refresh (12 per hour). Size it for the soak: start-up of a fresh namespace plus refreshes plus recoveries.
- **Planning a Unicode alert.** A Native alert for a Unicode symbol goes through the existing planner unchanged. Whether planning succeeds for it depends on the planner's own market-data path; nothing here changes the planner.
