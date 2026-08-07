# Binance API key setup for trading-alert-dashboard

This is the manual operator procedure for connecting a real Binance account.
None of it is automated, and none of it can be automated: **this application
never creates, edits, rotates or revokes a Binance API key**, and no code here
reads or writes anything in Binance's API-management UI.

Do not paste an API key or secret into a chat window, a commit, an issue, a log
or a screenshot. The secret belongs in exactly one place: `apps/backend/.env`,
which is gitignored.

---

## What can and cannot be checked automatically

Two different things get confused here constantly, so they are kept apart.

### PROGRAMMATICALLY VERIFIED

These are proven by running `binance:account-health` and (optionally)
`binance:test-order`. They are facts observed from real Binance responses:

| Property | How it is proven |
| --- | --- |
| The key authenticates | A signed USER_DATA request succeeds |
| Request signing is correct | Same — a bad signature returns `-1022` |
| Clock synchronization is within `recvWindow` | Server time is read and the offset applied |
| USDⓈ-M Futures account is reachable | The signed futures endpoints answer |
| Position mode (HEDGE / ONE_WAY) | `GET /fapi/v1/positionSide/dual` |
| Asset mode (SINGLE_ASSET / MULTI_ASSET) | `GET /fapi/v1/multiAssetsMargin` |
| Account-wide non-zero position count | `GET /fapi/v3/positionRisk` |
| Account-wide open-order count | `GET /fapi/v1/openOrders` |
| Symbol filters are readable | `GET /fapi/v1/exchangeInfo` |
| Leverage brackets are readable | `GET /fapi/v1/leverageBracket` |
| The key carries the permission `/order/test` requires | `POST /fapi/v1/order/test` is accepted |

### MANUALLY VERIFIED IN BINANCE UI

Binance exposes no endpoint that lets this application read your key's
permission checkboxes, so these cannot be proven from code. **Do not infer them
from trading behaviour** — a key that can place an order tells you nothing about
whether withdrawal is disabled.

| Property | Where to check |
| --- | --- |
| The key is dedicated to this bot | API Management → your key |
| Futures trading permission enabled | API Management → Edit restrictions |
| Withdrawal disabled | API Management → Edit restrictions |
| Unneeded transfer permissions disabled | API Management → Edit restrictions |
| IP restriction status | API Management → Edit restrictions |

---

## Checklist

```
[ ] Dedicated key created for trading-alert-dashboard
[ ] Required read/Futures trading access enabled
[ ] Withdrawal disabled
[ ] Unneeded transfer permissions disabled
[ ] API secret stored only in backend .env
[ ] .env confirmed ignored by Git
[ ] IP whitelist configured when stable VPS IP exists
```

---

## Step by step

### 1. Create a dedicated key

In Binance → API Management, create a **new** key used by nothing else. A
dedicated key means you can revoke this bot's access without disturbing anything
else you run, and any unexpected activity on it is unambiguous.

Name it after this project so it is recognisable a year from now.

### 2. Set the minimum permissions

Enable:

- **Enable Reading** — required by every signed endpoint this project calls.
- **Enable Futures** — required later for real execution. `POST /fapi/v1/order/test`
  also requires it, which is precisely why the test-order step is useful: it
  proves the permission is present without placing an order.

Leave disabled:

- **Enable Withdrawals** — this project has no withdrawal code path at all, and
  the endpoint appears nowhere in the codebase.
- **Permits Universal Transfer** and every other transfer permission — likewise
  unused and unrepresented.
- Anything else not listed above.

### 3. Store the secret

Put the key and secret in `apps/backend/.env` only:

```
BINANCE_READ_ONLY_ENABLED=true
BINANCE_API_KEY=
BINANCE_API_SECRET=
```

Confirm the file is ignored:

```
git check-ignore -v apps/backend/.env
```

The secret is never persisted to the database, never returned from an API,
never sent to the frontend and never written to a log.

### 4. IP restriction

Restrict the key to a specific IP **once you have a stable outbound address** —
a VPS or server. That is the production target.

A laptop's IP usually changes, so an allowlist there breaks constantly; use
whichever development arrangement Binance currently offers you until the server
exists. No IP address is hardcoded anywhere in this repository, and none should
be.

---

## Verifying the connection

### Layer A — always safe

```
pnpm --filter @trading-alert-dashboard/backend binance:account-health
```

Read-only. Issues only allowlisted GET requests and changes nothing. It prints
sanitized counts — never a balance, a position symbol or quantity, an order id,
an account alias or a credential.

If it reports `nonZeroPositionCount > 0` or `openOrderCount > 0`, the account
holds existing exposure. Hedge-mode setup will refuse to run. **Decide what to
do with that exposure yourself** — nothing in this project will cancel or close
anything on your behalf.

### Layer B — operator authorized only

Both commands are dry runs unless you pass their confirmation flag, and both
additionally require their own environment gate.

```
BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED=true
pnpm --filter @trading-alert-dashboard/backend binance:set-hedge-mode --confirm-set-hedge-mode
```

Position mode is **account-wide** on USDⓈ-M futures, so this refuses to run
unless the *entire* account has zero non-zero positions and zero open orders —
a position on an unrelated symbol blocks it, because the change would affect
that symbol too. The account state is re-read immediately before the request, so
a fill arriving mid-procedure aborts it. Only HEDGE can be requested; One-way is
not expressible anywhere in this codebase.

```
BINANCE_TEST_ORDER_ENABLED=true
pnpm --filter @trading-alert-dashboard/backend binance:test-order \
  --symbol=BTCUSDT --side=LONG --quantity=0.002 --price=50000 --confirm-test-order
```

`POST /fapi/v1/order/test` is Binance's **non-matching** validation endpoint: it
checks the request and returns without ever reaching the order book. No order is
created, rests or fills. This project verifies that rather than assuming it —
the account-wide open-order count is read before and after, and any change is
reported as `CRITICAL_TEST_INVARIANT_VIOLATION`.

**A successful test order proves:** authentication, signing, clock sync and the
request parameters are accepted, and the key carries the required permission.

**It does not prove:** that a real order would fill, that future balance will be
sufficient, that the symbol state will stay unchanged, that stop-loss and
take-profit placement works, or that the live executor is enabled.

---

## After Phase 10

The connection can reach at most `TEST_ORDER_VALIDATED`. Every live trading gate
stays false:

```
EXECUTION_LIVE_ENTRY_ENABLED=false
EXECUTION_PROTECTION_READY=false
EXECUTION_AUTO_ADD_MARGIN_ENABLED=false
EXECUTION_EMERGENCY_CLOSE_MODE=DISABLED
```

A validated test order is evidence that the plumbing works. It is not authority
to trade, and it does not enable anything. Starting a live canary is Phase 11's
decision.
