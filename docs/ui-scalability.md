# UI Scalability V1

Trading Control and Executions stay usable when Native monitoring grows from
dozens of plans to hundreds or thousands. **Nothing about trading changes.**

- Every endpoint and screen touched here is **read only**.
- No adoption, admission, execution or order path is wired.
- No Binance request is made.
- No schema change or migration.
- Native execution stays hard-disabled, and TradingView execution is untouched.

## Trading Control: Native plans

The page keeps its narrow column for the account controls. Only the read-only
Native section is wide, because it is a monitoring table, not a control.

**Safety and planning summary.** It is always visible, before any data
arrives, and on a phone.

- **NATIVE EXECUTION DISABLED** is a strong *informational* panel, not an error
  colour. If a payload ever says otherwise, it is shown as a fault.
- **PLANNING ONLY.**
- Account A and Account B **planning defaults** (built-in 100 / 300 unless
  overridden). These are lookback windows, never risk amounts.
- The planner worker's health.

**Counts.** Each line says exactly what it covers:

| Line | Scope | Source |
| --- | --- | --- |
| All Native plans | every Native plan, by plan status | database |
| Matching search and filters | the filtered set; the integrity filter is not counted | database |
| Integrity · this page only | the plans on screen | the page's own items |

The integrity line is per page because integrity is rebuilt from scanner files
on every read and is never stored.

**Table.** Newest trigger first. The columns are:

1. Triggered
2. Symbol
3. Source TF
4. Direction
5. Plan
6. Integrity
7. Entry
8. Lookback
9. RR
10. Account A
11. Account B

The two state columns come before the numbers. On a phone, the integrity verdict
is repeated under the symbol.

- **Severity:** ELIGIBLE is green. PENDING BAR CLOSE is blue: it is a normal
  temporary state, never red. Every fail-closed state is marked `!` in text.
- **Search** takes a symbol fragment (case-insensitive, any script) or an exact
  alert id. It is debounced 300 ms. Anything other than letters and digits is
  refused in place and never sent.
- **Filters** use the shared vocabulary only: source timeframe, direction, plan
  status, and integrity (one exact status, or "any fail-closed"). Clear filters
  resets them all.
- **Pages** of 50 / 100 / 200 rows. The DOM holds one page.
- **Row details.** Each row has a keyboard toggle (`aria-expanded`). Expanding it
  shows identity, the selected plan, both accounts' previews, integrity with its
  full reason, and the available lookbacks. The panel is pinned to the visible
  width.
- **States:** loading, error with Retry, empty, and stale (dimmed and busy while
  a newer page loads).

Only the newest request may update the screen. A superseded request is aborted,
and an identical request is never sent twice. There is no polling.

## API: `GET /api/extreme-rr/native-plans`

**Original list (unchanged).** A request with none of the page keys below is
byte-for-byte the original list:

- `{ nativeExecutionEnabled, accountPolicies, items }`;
- the 20 most recently updated plans by default, or `?limit=1..50`.

**Page.** Any of these keys makes it a page:

| Key | Values |
| --- | --- |
| `pageSize` | 1–200 (UI offers 50/100/200; default 50) |
| `cursor` | opaque; only a `nextCursor` this API returned |
| `q` | letters and digits, 1–40: symbol fragment or exact alert id |
| `sourceTimeframe` | `1D` `1W` `1M` `3M` `6M` `12M` |
| `direction` | `LONG` `SHORT` |
| `planStatus` | `PENDING` `READY` `INVALID` `ERROR` |
| `integrity` | any integrity status, or `FAIL_CLOSED` |

The response adds `pagination` and `summary` to the original fields:

- `pagination`: `order`, `pageSize`, `cursor`, `nextCursor`, `hasMore`,
  `totalMatching`, `integrityScan`;
- `summary`: `allNativePlans` and `matchingFilters`, each with `total` and
  `byPlanStatus`.

**Order and cursor.**

- Order is `triggeredAt DESC, alertId DESC`. Both are immutable, so keyset pages
  never shift while new alerts arrive.
- A cursor is the strict, canonical encoding of the last row's
  `(triggeredAt, alertId)`. Anything else is refused.

**Filters.** Search, source timeframe, direction and plan status run in the
database. A TradingView plan never appears.

**Integrity filter.** Integrity cannot be filtered in the database. With
`integrity`:

- plans are judged newest first until the page is full or **200** plans were
  judged;
- `integrityScan` says how many were judged and whether the scan reached the
  end;
- `nextCursor` resumes from the last plan judged;
- `totalMatching` is `null`, because it is not countable.

**Fail-closed validation.** All of these are refused with 422, never ignored:

- an unknown or repeated key;
- an out-of-vocabulary value;
- `limit` together with page keys;
- a cursor this API did not issue.

**Cost.** Each lane's scanner evidence is read once per request. Judgements run
25 at a time, yielding to the event loop in between. No request of any kind
judges more than 200 plans. Integrity verdicts are unchanged.

## Executions: the central lifecycle journal

- **Search** takes a symbol fragment, an exact execution id or an exact alert
  id. It is debounced.
- **Account filter:** the profiles that own executions, by name and environment.
  The account identifier is never exposed.
- **Source filter** (TradingView / Native) reads the linked alert. An execution
  whose alert retention removed shows "source unknown". No Native-sourced
  execution exists, because Native execution is disabled.
- **Other filters:** direction, status, protection, environment, lifecycle, a
  UTC created date range, and needs-manual-intervention. Pages of 25 / 50 / 100.
- **Combined filters.** `status` and `lifecycle` now combine (AND). Before, the
  lifecycle silently replaced a status filter.
- **Summary counts** cover every page of the filtered set. The lifecycle filter
  is not applied to them, and the page says so.

Each row expands into its **lifecycle**. The expanded row loads only the
execution's stored detail and timeline (GET). The full detail page shows the
same lifecycle at the top:

1. plan / admission
2. entry order submitted
3. entry filled
4. stop submitted
5. stop verified
6. take profit submitted
7. protected
8. reconciled
9. closed / cleaned up

A step is **Recorded** only when a stored record proves it. The records used are:

- the execution's own columns;
- its order rows;
- its protection state;
- its safety admissions;
- its timeline's recorded status changes.

Missing evidence is never shown as done:

- **Not recorded** means unknown, for example a closed position whose order
  rows are absent.
- **Not reached** means the execution provably ended earlier.

Problems (an unknown submission, incomplete protection, incomplete cleanup,
manual intervention) are shown as problems. No exchange call is made to draw any
of this.

**API.** `GET /api/executions` accepts `q` (letters and digits, 1–64) and
`source` (`TRADINGVIEW` / `NATIVE`). It adds `profiles` to the response and
`alertSource` to each item. Every other field and the page size bound (100) are
unchanged.

## Deploying

The backend must be rebuilt and restarted to serve page queries. Until then:

- the Native table shows an explicit "update and restart the backend" message,
  rather than presenting the original 20-item list as a filtered page;
- the journal disables search, source and account filters and says why.

## Known limits / follow-ups

**Integrity evaluation cost grows with scanner log size.** Each judgement
re-reads and strictly parses its lane's whole `events.jsonl`, which grows about
38 KB per lane per day. Measured on synthetic logs:

| Lane log | Per judgement | 200-row page |
| --- | --- | --- |
| 170 KB | 3.7 ms | ≈0.7 s |
| 1.7 MB | 35 ms | ≈7 s |

The 200 bound and turn-taking keep the server responsive. The real fix (an
incremental per-lane parse cache, or a scanner-maintained index) belongs with
the integrity module.

**Account policy resolution is not a filter.** It is visible per row and in the
detail.
