# Local runtime launcher

Double-click **`Trading Runtime Launcher.cmd`** in the repository root.

It opens a terminal menu for starting, inspecting and stopping the local
dual-account runtime. It runs on this machine only — the internet-facing
backend has no equivalent endpoint and cannot start processes or edit
configuration.

## The topology it manages

Six roles across three environment files:

| Role | Port | Environment file |
| --- | --- | --- |
| Generic Backend | 4000 | `generic.env` |
| Generic Analysis Worker | — | `generic.env` |
| Account A Control | 4001, loopback only | `account-a.env` |
| Account A Execution Worker | — | `account-a.env` |
| Account B Control | 4002, loopback only | `account-b.env` |
| Account B Execution Worker | — | `account-b.env` |

The files live outside the repository, under
`%LOCALAPPDATA%\trading-alert-dashboard\env`. Each spawned role is given its own
`DOTENV_CONFIG_PATH`, and **every variable that role's file declares is removed
from the inherited environment first** — neither dotenv nor Prisma overwrites a
variable that is already set, so any inherited key would otherwise outrank the
file the role was told to use. That is not only about credentials: a stale
`EXECUTION_GLOBAL_KILL_SWITCH=false` in the launching shell would beat a file
that says `true`, and `OPERATOR_API_TOKEN`, `ACCOUNT_CONTROL_PORT`,
`DATABASE_URL` and `REDIS_URL` behave the same way.

The account identity variables are cleared **unconditionally** on top of that,
so a malformed file that omits one cannot become a way to smuggle an inherited
account in. Only key NAMES are read; values are never read, printed or stored.

The frontend is **not** launcher-managed. Start it separately when you need it.

## The menu

1. **Show Status** — all six roles, their ports, and each account's attestation.
2. **Start SAFE** — proves SAFE, then starts the six roles in order and
   verifies the result.
3. **Prepare LIVE-READY** — unavailable; prints why (see below).
4. **Stop Runtime (requires SAFE)** — stops launcher-owned roles, once *both*
   accounts already report SAFE. It does not transition anything into SAFE.
5. **Supervise Account A Worker**
6. **Supervise Account B Worker**
7. **Exit**

### Optional: the Native planner worker

Three further menu items manage one **optional** generic role, the
planning-only Native planner worker:

- **11. Start Native Planner**: starts exactly one planner, from `generic.env`.
- **12. Supervise Native Planner**: restarts it if it exits.
- **13. Stop Native Planner**: stops only a planner this launcher started.

It is not one of the six roles. Start SAFE never starts it, topology
verification never requires it, and Stop Runtime never touches it. Its
ownership record lives in its own state file, so it can never block or be
erased by the six-role runtime. See [native-planner-worker.md](native-planner-worker.md).

### Optional: the generic backend in NON-WATCH mode

- **14. Start Generic Backend — Non-Watch**: starts the BUILT backend
  (`node apps\backend\dist\src\server.js`) from `generic.env`, only on a
  provably free :4000, and only when the build is current (it never builds).
- **15. Stop Generic Backend — Non-Watch**: stops only the non-watch backend this
  launcher started, after proving ownership.

It is never restarted automatically, and it is not part of Start SAFE (which
still starts the watch backend). The status shows `Generic backend mode:
RUNNING — NON-WATCH / RUNNING — WATCH / OFF / UNPROVEN / CONFLICT`. See
[native-preexecution-safety.md](native-preexecution-safety.md).

## Start SAFE proves SAFE before it starts anything

Three proofs, in this order.

**Before anything else**, all three environment files are read and parsed with
one strict parser. A file is refused if it is missing, unreadable, contains a
line that is not a `KEY=VALUE` assignment, has an empty key, declares the same
key twice, or opens a quote it never closes. The reason is reported as a code
(`ENV_FILE_MISSING`, `ENV_FILE_UNREADABLE`, `ENV_FILE_MALFORMED`,
`ENV_FILE_DUPLICATE_KEY`) with at most a line number or a key name — never a
value.

This is not pedantry. Sanitation works by deleting every name the selected file
declares from the child environment, so a file that cannot be parsed COMPLETELY
cannot be sanitised against: a key the parser skipped is a key the stale shell
value survives into. The key names used for each spawn come from that same
validation, so no file is re-read between being approved and being used.

**Before any process is spawned**, both account files must declare the SAFE
deployment posture: `EXECUTION_GLOBAL_KILL_SWITCH=true`,
`EXECUTION_LIVE_ENTRY_ENABLED=false` and `EXECUTION_PROTECTION_READY=false`.
Four further gates — account-setup mutations, test orders, auto-add-margin and
emergency close — may be absent, because their schema defaults are already the
SAFE values, but a file that declares one must declare the SAFE value. The set
is exactly the seven the runtime attestation verifies; nothing was invented for
the launcher.

**After each account control plane is up and before that account's execution
worker is started**, the launcher asks that control plane, over its own
loopback port and with its own token, to prove the account is dormant:
`/health` must answer `ACCOUNT_CONTROL`, the profile must be `isEnabled=false`,
and its kill switch must be active. The control plane is asked first precisely
because it is inert — it binds no orchestration and adopts no plan — while the
worker would begin adopting within seconds of starting.

Any unknown refuses. An unreachable control plane is not evidence of a disabled
profile. A failed proof rolls back only the roles that this Start SAFE action
spawned, newest first, re-proving ownership of each PID.

## Detected versus launcher-owned

Status reports a role as `ON (launcher-owned)` or `ON (external)`.

The distinction is the whole safety model. **Detection** is what makes the
status screen honest about a runtime someone started by hand — before Phase 11I
the tool asked only its own state file, so six healthy processes read as six OFF
lines. **Ownership** is what the tool is allowed to terminate: a recorded PID
that still exists, started when we recorded it starting, and running from this
repository.

The launcher never stops a role it does not own. If you started a role by hand,
stop it the way you started it.

## LIVE-READY is no longer available here

The old menu loaded live-entry gates for the whole deployment. It is gone, and
the menu says so rather than quietly dropping it. Three source facts, any one of
which is disqualifying:

- the gate file it rewrote (`apps/backend/.env`) is read by **none** of the six
  runtimes since the Phase 11F.1 environment bootstrap;
- those gates are process-wide, so one action could never arm exactly one
  account;
- its safety check read **one** profile — whichever the launcher process itself
  resolved — so it could not see the other account's exposure.

Arming is account-scoped work for that account's control plane and its audited
arming workflow.

## CONFIGURED versus EFFECTIVE gates

Status shows both, and never conflates them.

**CONFIGURED** is what an account's env file declares. It is what the next
start would load. It is *not* necessarily what a running process has.

**EFFECTIVE** is what that account's running control plane attests it actually
loaded, read from the runtime attestation rather than from any file. When no
control plane is attesting, EFFECTIVE reports that it is unavailable rather
than falling back to the file.

## Stopping requires both accounts to agree

Before anything is terminated, each account with a live runtime is asked over
its **own** loopback control plane whether it is safe to stop. An account is
asked rather than inspected from here because `TradingControlService` resolves
its profile from the process environment: a launcher-side database read could
only ever describe whichever account the launcher happens to be.

The launcher never transitions an account into SAFE — the menu item says
*requires SAFE* for that reason. A stop is refused when either account reports
anything other than SAFE OFF,
holds an active execution, needs manual intervention, or has outstanding
recovery work — and equally when an account cannot be reached, because "we could
not ask" and "there is nothing outstanding" are different facts.

Account B being quiet is never a reason to take Account A's worker away.

## What it will not do

- It is **not** a substitute for Trading Control's *Safe Off*. It refuses to
  stop a runtime that still has work outstanding; it never disarms anything.
- It writes **no** environment file. It cannot change a gate, so it cannot arm.
- It never touches an execution profile, never reaches Binance, and never
  creates an authorization window.
- It never terminates by process name. Every termination is a `taskkill /PID`
  against a PID whose ownership was proved immediately beforehand.
- It prints no API key, secret, operator token or account identifier. Roles are
  named by alias (`account-a`, `account-b`); the launcher's own state file
  records the alias, never the identifier.

## Scope of supervision

Supervision watches one named account's execution worker and restarts it by
role, which is what pins the environment file — a restart cannot change which
account the worker is. It runs only while the launcher window is open and is not
a Windows service.
