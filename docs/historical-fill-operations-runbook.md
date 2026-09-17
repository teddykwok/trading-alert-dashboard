# Historical fill operations runbook

Operator procedure for the **Historical fill operations** panel on the trading
control page. **Nothing in this document is automated.** Every check is
performed deliberately by a human, and every check is read-only.

> **Current status: historical-fill ingestion does not run by itself.**
> The Phase 6–7 ingestion machinery is implemented and tested, but no production caller invokes it — nothing schedules a batch, claims a window or requests `userTrades`.
> The panel therefore reports the durable state of work that only a deliberate, manual invocation produces. This runbook describes how to read that state, not how to start it.

---

## Scope

This runbook covers the historical-fill ingestion subsystem **only**.

Nothing here is a statement about the account, the exchange connection, open
positions, protection, or whether trading is safe. A `NORMAL` historical-fill
panel means the historical-fill workset reports no condition needing review; it
does not mean the system as a whole is healthy.

---

## The three states

The **backend** classifies the snapshot. The panel renders that verdict and
never recomputes it, so the API and the screen cannot disagree.

| State | Meaning |
| --- | --- |
| `NORMAL` | No historical-fill condition currently requires operator attention. |
| `NEEDS_ATTENTION` | One or more durable conditions are worth an operator's review. |
| `UNAVAILABLE` | The execution profile could not be resolved, so the workset was not evaluated at all. |

There is no severity ladder. `NEEDS_ATTENTION` is not ranked, not scored, and
not subdivided — two conditions are not "worse" than one, and the panel lists
every condition the server reported, in the server's order.

A `NEEDS_ATTENTION` state is a reason to **look**, not a reason to act.

---

## Issue codes

These five conditions, and only these five, set `NEEDS_ATTENTION`.

### `STALE_LEASES_PRESENT`

A pending ingestion window holds a claim whose lease is older than the
configured lease boundary.

**Check:** Review the recorded claim and attempt history for the affected
historical-fill work, and check whether the condition clears on a later
refresh, before considering any manual recovery.

### `ATTEMPT_EXHAUSTED_PRESENT`

One or more pending windows have reached the configured attempt limit.

**Check:** Review the repeated ingestion failures that exhausted the attempt
budget before planning any recovery.

### `ABANDONED_WINDOWS_PRESENT`

One or more ingest windows reached their terminal abandoned state, which the
ingestion model treats as a known coverage gap.

**Check:** Review the failure history that led the window to that state before
deciding on a controlled recovery.

### `INCOMPLETE_SKIPPED_ROWS_PRESENT`

A window finished without accepting every row the exchange returned, so that
interval carries a known coverage gap. The rows that were accepted are
recorded; the interval is simply not claimed as whole.

**Check:** Review why returned rows were skipped before treating the affected
historical interval as fully reconciled.

### `SATURATED_SINGLE_MILLISECOND_PRESENT`

An exchange page stayed saturated at single-millisecond granularity, so the
planner had no smaller interval left to ask for. Time-windowing cannot prove
exhaustion here at all.

**Check:** Review the saturated one-millisecond interval before planning a
targeted recovery.

---

## Conditions that are NOT issues

These are ordinary states of a working queue and deliberately do not raise
`NEEDS_ATTENTION` at any magnitude:

- pending total, claimable now, active leases, in backoff
- `SPLIT` and `COMPLETE` windows
- unattributed fills in the ledger
- every timestamp, and the size of the queue

A large queue is a queue with work in it.

---

## `UNAVAILABLE` reasons

The panel keeps showing the factual reason sentence. Each reason has exactly
one check, and only the reported one is shown.

| Reason | Check |
| --- | --- |
| `PROFILE_NOT_CONFIGURED` | Verify that the intended execution profile configuration is present for this deployment environment. |
| `PROFILE_NOT_FOUND` | Verify that the configured execution profile still exists in the current environment. |
| `PROFILE_AMBIGUOUS` | Verify that the current environment resolves to exactly one execution profile. |
| `PROFILE_POLICY_MISSING` | Verify that the configured execution profile has the required policy record. |
| `PROFILE_ENVIRONMENT_MISMATCH` | Verify that the configured environment and the execution profile binding agree. |

Never display or paste a secret, key or credential value while performing these
checks.

---

## Available evidence, and what is missing

This section is deliberately blunt, because a runbook that sends an operator
looking for evidence that does not exist is worse than no runbook.

**Available to an operator today**

- The panel itself: window counts by status, roots and split children, distinct
  symbol count, pending diagnostics (claimable, active lease, stale lease, in
  backoff, attempt exhausted), the three queue timestamps, ledger totals, the
  execution profile id, and the server's interpretation.
- That is the whole operator-facing surface. It is all aggregate counts.

**Durably recorded, but NOT exposed anywhere an operator can read**

Each `ExchangeFillIngestWindow` row carries its own history — window id, symbol,
inclusive millisecond bounds, status, split lineage, attempt count, claim
timestamp and claim owner, backoff and last-attempt timestamps, a stable
`lastErrorCode` and a sanitized failure phrase. None of this reaches any API
route or any screen.

**Not available at all**

The historical-fill execution modules emit **no runtime logs**. There is no
worker log line for a claim, an attempt, a split, a skipped row or an
abandonment. Do not go looking for one.

The practical consequence: the panel tells you *that* a condition exists and
how many rows are in it. It cannot tell you *which* rows, *which* symbol, or
*why*. Answering those questions requires engineering access to the durable
records — which is exactly where this runbook stops.

---

## Do not do these from this dashboard

The panel has one button, `Refresh`, and it re-reads the same authenticated
GET. There is no other control, and none should be added as a reaction to a
`NEEDS_ATTENTION` state.

Specifically, **do not**:

- reset or clear a lease, or edit a claim timestamp or claim owner
- reset, raise or otherwise adjust an attempt count
- force or steal a claim
- requeue, re-open, retry or delete a window by hand
- rewrite, backfill or hand-edit ledger rows
- run direct SQL against the production database
- run Prisma console mutations against production
- mutate Redis keys belonging to ingestion

Every one of those edits durable state that the ingestion state machine treats
as proof. Doing it blind — and from this panel you would be blind, see above —
can convert a *known* coverage gap into a silent one, which is strictly worse.

---

## Escalation boundary

> If the condition cannot be explained from the available evidence, escalate for engineering review before changing durable ingestion state.

That is the boundary. There is no time limit attached to it and no
"escalate after N minutes" rule: no operational SLA has been reviewed or
agreed for this subsystem, so this document does not invent one.

It is fine to note whether a condition clears on a later refresh. It is not
fine to turn that into a threshold.

---

## Reading the panel

The panel polls the same read-only endpoint every 15 seconds and replaces the
snapshot wholesale each time. There is no acknowledgement, no dismissal and no
sticky alarm: if a later response says `NORMAL`, the panel says `NORMAL`.

Guidance for the reported conditions lives under **Operator checks** in the
panel, collapsed by default, and matches this document.
