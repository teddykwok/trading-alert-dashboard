# Gate 4A: first real-machine drill runbook

> **MONITORING ONLY · NO ACCOUNT EXECUTION · NATIVE EXECUTION HARD-DISABLED**
>
> **This document authorizes nothing.** Starting Always-On or running a drill
> needs its own explicit operator approval, naming this drill. The procedure has
> never been executed. Every command, field and event below was checked against
> the source, but the source check is not runtime acceptance.

One drill, one fault: `PUBLIC_ALL_DOWN` for 60 seconds. For how the drill is
built and its trust boundary, see
[always-on-monitoring.md, section 12](always-on-monitoring.md#12-operator-network-drill-the-gate-4a-mechanism-engineered-and-tested-never-run).

## Quick reference

**PASS on the first 60-second PUBLIC_ALL_DOWN drill is NOT full Gate 4A
acceptance, NOT permission for a 24-hour soak and NOT trading authorization.**

The first drill is a process-local activation, transport and recovery smoke test.
Full Gate 4A acceptance needs additional, separately approved real-machine
evidence.

**Preflight, all required** ([section B](#b-mandatory-preflight)):

- written approval naming this drill; exact SHAs; clean checkout and build;
- Account A/B off; nothing on 4001/4002; no execution workers;
  `NATIVE_EXECUTION_ENABLED = false as const`;
- no drill files, pending requests or unresolved earlier drill;
- a fresh supervisor and scanner from the approved build, **nothing adopted**;
- `Show-Liveness` reads `ESTABLISHED`; `RUNNING`, `HEALTHY`, attempts 0, no latch,
  no `CONFLICT`;
- the [operator policies](#operator-policies-not-code-enforced-limits) met: REST at
  most 2000, UTC minute mod 15 between 3 and 7, 30-minute baseline;
- generation and run id read immediately before; same checkout as the supervisor.

**Activate once, from the repository root** ([section C](#c-activation)):

```powershell
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on drill start --fault PUBLIC_ALL_DOWN --duration-seconds 60 --generation <G> --run-id <runId>
```

A refusal means **stop**. Never retry automatically. **Never start another drill
while a restore is unresolved**: the code does not prevent it.

**Abort immediately** on ([full list](#g-abort-and-rollback)): an activation
refusal; `Show-Liveness` not `ESTABLISHED`; `DRILL_UNAUTHORIZED_FILE_REMOVED` or
`DRILL_STATE_INCONSISTENT`; `SUPERVISOR_RESUMED_AFTER_GAP`; `SUPERVISOR_TICK_FAILED`;
any account or execution process, or a listener on 4001/4002; `CONFLICT`; a second
recovery or any latch; no `DRILL_RESTORE_CONFIRMED` about 5 minutes after expiry.

**Restore first** ([section G](#g-abort-and-rollback)):

```powershell
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on drill restore
```

Exit 0 means no drill file remains, **not** that the restore is confirmed.

**Stop only if the restore is not clean, or another trigger stands:**

```powershell
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on stop --wait-seconds 600
```

Exit 0 is **not** proof of shutdown. Proof is `Show-Shutdown <G>` reading `COMPLETE`.
Children left with no supervisor: mark the shutdown **INCOMPLETE**, capture evidence
and take no further action without separate approval. Never kill processes or
delete state by hand.

**Independent scanner evidence** ([section F](#f-restoration-and-independent-validation)):
`drill` in `scanner\live-shadow-supervisor\runs\<runId>\status.json`, read with
`Show-ScannerOwn <runId>`. `drill status`, `restore CONFIRMED`, `fileRemoved`, a
status snapshot or one journal line are never enough on their own.

**Classify** ([section H](#h-incident-evidence)): **PASS** only when every section F
row is shown, with one acceptable
[recovery outcome](#e-expected-recovery-outcomes-f1) and no abort trigger. **FAIL**
on a real defect or contradicting evidence. **INCONCLUSIVE** when anything cannot be
shown, or control-plane liveness cannot be established. Capture the
[evidence record](#h-incident-evidence) in every case.

More: [journal events](#d-journal-events),
[residual risks](#residual-risks-and-gaps).

## A. Purpose and limits

The drill is a **process-local fault in the public market-data transports** of
the one scanner run the supervisor owns, plus the supervisor's two connectivity
probes. No adapter, DNS, hosts, firewall, routing or proxy setting changes.
Nothing else on the machine is affected.

It is a bounded smoke test. **It can show, on the real machine:**

- `drill start` works against a live supervisor, including the controller and
  ACL checks (never yet run), and targets the right generation and run;
- the real sockets drop and the real `fetch` and `WebSocket` reconnect at 522
  symbols;
- the drill file and journal lifecycle, and that the fault ends on its own, with
  the scanner's own status confirming it;
- scanner ownership and fencing while this happens, and, if a recovery is needed,
  its real order and emitter re-pinning.

**It does not prove:**

- Windows adapter failures, or DNS or TLS failures;
- Binance-side incidents (5xx, 418/429, partial outages);
- real REST timeouts (a drill refuses at once);
- latch exhaustion (a drill never survives a run replacement, so at most one
  recovery cycle is exercised);
- long outages: at default settings a 60-second drill ends before the 90-second
  grace period, so neither probe should run against a drilled transport;
- **R1 or R3 end to end, or all R1/R2/R3 recovery paths.** The R1 stream hold
  (`PUBLIC_STREAM_UNREACHABLE`), the `NETWORK_UNAVAILABLE` hold and the R3 universe
  extension need a longer outage than this. The run may show R2's wait for a status
  written after the grace deadline (`AWAITING_FRESH_STATUS`), but only that path.
  Section 12 of the monitoring document lists R1/R2/R3 as what drills in general
  can show, not what this one proves;
- half-open outages;
- anything about trading, orders or execution safety.

## B. Mandatory preflight

Any failed check: **do not start the drill.** Record it (section H). A check that
fails after the stack is running goes to section G.

### Session setup

Paste once into the PowerShell window you will observe from. It only reads
state, and writes only to its own evidence folder.

```powershell
# READ-ONLY
$repo = 'C:\Projects\trading-alert-dashboard'
$root = Join-Path $env:LOCALAPPDATA 'trading-alert-dashboard'
$aon  = Join-Path $root 'monitoring\always-on'
$scan = Join-Path $root 'scanner'
$evidence = Join-Path $env:USERPROFILE 'gate4a-drill-evidence'
New-Item -ItemType Directory -Force $evidence | Out-Null
function Read-Json($file) { Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json }
function Get-Journal { Get-Content -Encoding UTF8 (Join-Path $aon 'incidents.jsonl') | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } } }
function Show-State {
  $s = Read-Json (Join-Path $aon 'status.json'); $c = $s.roles.scanner; $h = $c.health; $e = $s.roles.emitter; $p = $s.roles.planner
  [pscustomobject]@{
    writtenAt = $s.writtenAt; state = "$($s.state) ($($s.reasonCode))"; generation = $s.generation
    authority = "$($s.authority) native=$($s.nativeExecutionEnabled) account=$($s.accountExecution)"
    scannerRole = "$($c.state) ($($c.reasonCode))"; verdict = $h.verdict; issues = (@($h.issues.code) -join ',')
    runId = $c.runId; ours = $h.ours; scannerStatusWritten = $h.writtenAt; scannerStatusAge = $h.ageSeconds
    attempts = $c.attempts; restarts = $c.restarts; recoveries = $s.counters.scannerRecoveries; latched = $c.latched
    restRequests = $h.restRequests; selected = $h.universe.selected; live = $h.universe.liveEligible
    quarantined = $h.universe.quarantined; failed = $h.universe.failed; recovering = $h.universe.recovering
    awaiting = $h.universe.awaitingStream; universeStale = $h.universe.stale
    streams = "$($h.stream.delivering)/$($h.stream.connections) delivering"; reconnects = $h.reconnects
    emitter = "$($e.state) pinned=$($e.pinnedRunId) lanes=$($e.health.lanesHealthy)/$($e.health.lanesTracked) queue=$($e.health.queueDepth) created=$($e.health.created)"
    ledgerDuplicates = $e.health.ledgerDuplicates
    planner = "$($p.state) pending=$($p.health.pending) deltaJobs=$($p.health.delta.jobsFailed) deltaPlans=$($p.health.delta.plansError)"
    backend = $s.roles.backend.state; dataStore = $s.dataStore
    network = "reachable=$($s.network.reachable) since=$($s.network.unavailableSince) streamOutcome=$($s.network.stream.lastProbeOutcome) streamSince=$($s.network.stream.unreachableSince)"
    externalPids = "scanner[$(@($c.externalPids) -join ',')] emitter[$(@($e.externalPids) -join ',')] planner[$(@($p.externalPids) -join ',')] backend[$(@($s.roles.backend.externalPids) -join ',')] supervisors[$(@($s.external.otherSupervisorPids) -join ',')]"
    drill = if ($s.drill) { "$($s.drill.drillId) $($s.drill.state) activation=$($s.drill.activation) end=$($s.drill.endReason) fileRemoved=$($s.drill.fileRemoved) restore=$($s.drill.restore)" } else { 'none' }
    scannerReportsDrill = if ($h.drill) { "$($h.drill.drillId) active=$($h.drill.active)" } else { 'none' }
  } | Format-List
}
function Show-ScannerOwn($runId) {
  $f = Read-Json (Join-Path $scan "live-shadow-supervisor\runs\$runId\status.json")
  [pscustomobject]@{ runId = $f.runId; runState = $f.runState; pid = $f.pid; gitHead = $f.gitHead; writtenAt = $f.writtenAt; restRequests = $f.totals.restRequests
    drillId = $f.drill.drillId; fault = $f.drill.fault; active = $f.drill.active; activatedAt = $f.drill.activatedAt; endedAt = $f.drill.endedAt; endReason = $f.drill.endReason } | Format-List
}
function Show-Journal($generation, $sinceIso, [switch]$Facts) {
  Get-Journal | Where-Object { $_.generation -eq $generation -and $_.at -ge $sinceIso } | ForEach-Object {
    '{0} {1,-34} {2,-9} {3}' -f $_.at, $_.kind, $_.role, $_.reasonCode
    if ($Facts) { "    facts: $($_.facts | ConvertTo-Json -Compress)"; "    detail: $($_.detail)" }
  }
}
function Get-AgeSeconds($iso) { [int]([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($iso, [Globalization.CultureInfo]::InvariantCulture)).TotalSeconds }
function Show-Liveness {
  $s = Read-Json (Join-Path $aon 'status.json'); $o = Read-Json (Join-Path $aon 'ownership.json'); $f = Read-Json (Join-Path $scan 'live-shadow-supervisor\status.json')
  $supervisorPid = $o.supervisor.pid
  $present = ($null -ne $supervisorPid) -and ($null -ne (Get-CimInstance Win32_Process -Filter "ProcessId=$supervisorPid"))
  $holder = @(Get-NetTCPConnection -State Listen -LocalPort 4019 -ErrorAction SilentlyContinue).OwningProcess
  $statusAge = Get-AgeSeconds $s.writtenAt; $scannerAge = Get-AgeSeconds $f.writtenAt
  $scannerPresent = $null -ne (Get-CimInstance Win32_Process -Filter "ProcessId=$($f.pid)")
  [pscustomobject]@{ statusWrittenAt = $s.writtenAt; statusAgeSeconds = $statusAge; statusGeneration = $s.generation; ownershipGeneration = $o.generation
    recordedSupervisorPid = $supervisorPid; supervisorProcessPresent = $present; holderOf4019 = (@($holder) -join ',')
    scannerRunId = $f.runId; scannerPid = $f.pid; scannerProcessPresent = $scannerPresent; scannerOwnWrittenAt = $f.writtenAt; scannerOwnAgeSeconds = $scannerAge
    liveness = if ($present -and ($statusAge -le 60) -and ($s.generation -eq $o.generation) -and (@($holder) -contains $supervisorPid)) { 'ESTABLISHED' } else { 'NOT ESTABLISHED' }
    scannerEvidence = if ($scannerPresent -and ($scannerAge -le 180)) { 'FRESH' } else { 'NOT FRESH' } } | Format-List
}
function Show-Shutdown($generation) {
  $g = @(Get-Journal | Where-Object { $_.generation -eq $generation }); $stopping = @($g | Where-Object { $_.kind -eq 'SUPERVISOR_STOPPING' }) | Select-Object -Last 1
  $after = if ($stopping) { @($g | Where-Object { $_.seq -gt $stopping.seq }) } else { @() }
  $stopped = @($after | Where-Object { $_.kind -eq 'ROLE_STOPPED' }).role -join ','; $forced = @($after | Where-Object { $_.kind -eq 'ROLE_FORCE_STOPPED' }).role -join ','
  $other = @($after | Where-Object { $_.kind -in 'ROLE_STOP_FAILED', 'CHILD_RECORD_DROPPED', 'ROLE_EXITED' }).kind -join ','
  $o = Read-Json (Join-Path $aon 'ownership.json')
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'run-always-on-monitoring|run-live-shadow|run-native-multi-emitter|run-native-alert-emitter|native-plan\.worker|dist[\\/]src[\\/]server\.js|src[\\/]server\.ts' })
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 4000,4001,4002,4009,4019 -ErrorAction SilentlyContinue).LocalPort -join ','
  $done = (@($after | Where-Object { $_.kind -eq 'SUPERVISOR_STOPPED' }).Count -eq 1) -and ($null -eq $o.supervisor) -and (@($o.children).Count -eq 0) -and ($procs.Count -eq 0) -and ($listeners -eq '')
  [pscustomobject]@{ roleStopped = $stopped; roleForceStopped = $forced; otherEvents = $other; ownershipSupervisorNull = ($null -eq $o.supervisor); ownershipChildren = @($o.children).Count
    monitoringProcesses = (@($procs).ProcessId -join ','); listeners = $listeners
    verdict = if (-not $done) { 'INCOMPLETE' } elseif ($stopped -eq 'emitter,scanner,planner,backend' -and $other -eq '') { 'COMPLETE' } else { 'COMPLETE, NOT CLEAN' } } | Format-List
}
function Get-NextBarOpenMs($iso) { [long]([Math]::Ceiling([DateTimeOffset]::Parse($iso, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds() / 900000) * 900000) }
function Test-AlertBars($items, $activatedAtIso, $freshRunId, $freshRunStartedAtIso) {
  $cutoffMs = [DateTimeOffset]::Parse($activatedAtIso, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds() + 5000
  $first = Get-NextBarOpenMs $activatedAtIso; $fresh = if ($freshRunStartedAtIso) { Get-NextBarOpenMs $freshRunStartedAtIso } else { $first }
  $after = @($items | Where-Object { [DateTimeOffset]::Parse($_.triggeredAt, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds() -ge $cutoffMs })
  $bad = @($after | Where-Object { (-not $_.barStart) -or ([DateTimeOffset]::Parse($_.barStart, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds() -lt $(if ($_.runId -eq $freshRunId) { $fresh } else { $first })) })
  [pscustomobject]@{ alertsAfterActivation = $after.Count; barStartTooEarly = $bad.Count; alertIds = (@($bad).alertId -join ',') } | Format-List
}
function Get-AlertsSince($sinceIso) {
  $end = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture); $offset = 0
  do {
    $page = Invoke-RestMethod "http://127.0.0.1:4000/api/signal-quality/signals?soakStart=$sinceIso&soakEnd=$end&sort=TRIGGERED_ASC&pageSize=100&offset=$offset"
    $page.items; $offset += 100
  } while ($page.pagination.hasMore)
}
function Show-DrillFiles {
  "requests: $(@(Get-ChildItem (Join-Path $aon 'requests') -File).Name -join ',')"
  "drill files: $(@(Get-ChildItem (Join-Path $aon 'stop') -File -Filter '*.drill').Name -join ',')"
}
function Show-Machine {
  Get-NetTCPConnection -State Listen -LocalPort 4000,4001,4002,4009,4019 -ErrorAction SilentlyContinue | ForEach-Object { "port $($_.LocalPort) pid $($_.OwningProcess)" }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { "node $($_.ProcessId) parent $($_.ParentProcessId) $($_.CommandLine)" }
}
function Get-CursorDir { $fp = (Read-Json (Join-Path $aon 'status.json')).roles.scanner.engineFingerprint; Join-Path $scan "native-emitter\cursors\TEDDY_7_ALL_ACTIVE_V1\$($fp.Substring(0,24))\USDM_PERPETUAL\15m" }
function Save-Cursors($name) {
  Get-ChildItem (Get-CursorDir) -File -Filter '*.json' | ForEach-Object { $x = Read-Json $_.FullName; [pscustomobject]@{ file = $_.Name; consumedChars = $x.consumedChars; activationChars = $x.activationChars } } |
    ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $evidence "cursors-$name.json")
  "rebaseline files: $(@(Get-ChildItem (Join-Path $scan 'native-emitter\rebaseline') -Recurse -File).Count)" | Tee-Object -FilePath (Join-Path $evidence "rebaseline-$name.txt")
}
function Compare-Cursors($before, $after) {
  $a = @{}; foreach ($x in (Read-Json (Join-Path $evidence "cursors-$after.json"))) { $a[$x.file] = $x }
  $b = Read-Json (Join-Path $evidence "cursors-$before.json")
  [pscustomobject]@{ before = @($b).Count; after = $a.Count
    missing = @($b | Where-Object { -not $a.ContainsKey($_.file) }).Count
    wentBack = @($b | Where-Object { $a.ContainsKey($_.file) -and $a[$_.file].consumedChars -lt $_.consumedChars }).Count
    activationChanged = @($b | Where-Object { $a.ContainsKey($_.file) -and $a[$_.file].activationChars -ne $_.activationChars }).Count }
}
function Show-Locks {
  $scannerPid = (Read-Json (Join-Path $scan 'live-shadow-supervisor\status.json')).pid
  $fp = (Read-Json (Join-Path $aon 'status.json')).roles.scanner.engineFingerprint
  $locks = Get-ChildItem (Join-Path $scan "live-shadow-engines\$($fp.Substring(0,24))\USDM_PERPETUAL") -Recurse -File -Filter 'live-shadow.lock' | ForEach-Object { Read-Json $_.FullName }
  $nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'").ProcessId
  [pscustomobject]@{ locks = @($locks).Count; heldByScanner = @($locks | Where-Object { $_.pid -eq $scannerPid }).Count
    otherLiveNodeHolders = (@($locks | Where-Object { $_.pid -ne $scannerPid -and $nodes -contains $_.pid }).pid -join ',') }
}
```

Reading `status.json` this way is deliberate. Every `monitoring:always-on`
command, including `status`, briefly shows up to the supervisor as another
supervisor runtime: one `EXTERNAL_MONITORING_PROCESS` / `OTHER_SUPERVISOR_RUNTIME`
journal line per pid, and a pid in `external.otherSupervisorPids`. That is
cosmetic when the pid is a CLI you just ran; any other pid is an abort trigger.

The `status.json` file holds the status at its top level. The output of
`monitoring:always-on status --json` wraps it, so the same field there is
`status.<path>`, beside `supervisorRunning`.

### Control-plane liveness

**`status.json` can freeze.** A dead or hung supervisor leaves it reading `RUNNING`,
or `restore CONFIRMED`, with a frozen `scannerStatusAge`. So no field in `Show-State`
or `drill status` is evidence until liveness is established. They do not check it.

| Signal | What it proves | What it does not prove |
| --- | --- | --- |
| `Supervisor: RUNNING (pid …, generation …)` from `monitoring:always-on status` | The pid in `ownership.json` is a live process with the recorded OS creation time (within 1 s), and this repository on its command line | That it is still working: a hung supervisor passes. `NOT RUNNING` also reads when the recorded process is gone, whatever its children are doing. `UNKNOWN` proves nothing; ask again |
| Listener on `127.0.0.1:4019` held by that pid (`Show-Liveness`) | The exclusive single-instance listener, independent of `ownership.json`. The OS releases it on exit | That it is still working |
| Top-level `writtenAt` in `status.json`, at most 60 s old (`Show-Liveness`, or `written …s ago` in `status`) | A pass completed recently. Every pass rewrites it, about every 15 s | Anything on its own, if the process checks disagree |
| `scannerOwnAgeSeconds` at most 180 (`Show-Liveness`) | The scanner's own file is fresh, read directly | Its role's health |

**Required at every decision point:** `monitoring:always-on status` shows
`Supervisor: RUNNING`, and `Show-Liveness` reads `liveness: ESTABLISHED`. Run the CLI
only at the decision points; it adds a census line each time (above). Between them
use `Show-Liveness`.

The 60 s limit is **operator policy derived from the code**, which treats more than
4 polls of 15 s between passes as a stall. The 180 s is the code's own status
freshness window. If `statusAgeSeconds` is over 60, read again after 30 s. Still
over, or any process check failing: **liveness is not established**, nothing may be
declared healthy or restored, and the result can only be FAIL or INCONCLUSIVE.
Capture evidence and follow [section G](#g-abort-and-rollback).

`scannerEvidence` reads `NOT FRESH` while a recovery's fresh run is still starting,
because the old scanner has gone and the new one has not written yet. That alone is
not an abort trigger during a recovery. It must read `FRESH` before validation.

### Operator policies (not code-enforced limits)

None of these is enforced at run time, and the code would let a run proceed outside
them. They are this runbook's conservative judgement and can be wrong.

| Policy | Source | Limitation |
| --- | --- | --- |
| REST at most 2000 of 4000 before the drill | 4000 is the scanner's per-run default budget, checked before each request, and refused requests count. The fault can spend at most about 240 (250 ms floor), and each symbol then needs at least one request to recover its gap. The last real run had used 593 after 44 minutes | A margin, not a calculation of exact cost. A replacement run starts a new budget |
| Start at UTC minute mod 15 from 3 to 7 | 15-minute bars close on UTC boundaries. At minute 7 the next close may be only about 7 minutes away (7:59 leaves 7:01). The fault plus the CLI's latency ends over 5 minutes before it | Keeps the fault away from a close, not the whole recovery: a replacement run takes about 7 minutes and will usually cross one |
| 30 minutes healthy before the drill | Covers at least one close. The Gate 3 run showed no scanner degradation in its 44 minutes | Limited evidence; a transient would need judgement |
| Back to `RUNNING` within 30 minutes of `T` | Gate 3 took about 8 minutes from a start. The code allows a fresh run 45 minutes | Stricter than the code, so a slow but working recovery is stopped here |
| 30 minutes stable, with two closes, after the drill | Any 30-minute span contains two closes, and 30 minutes of continuous health is when the code forgives attempts | Not proof of long-term stability; that needs separately approved evidence |

### Before anything is started

| # | Check | How | Required |
| --- | --- | --- | --- |
| 1 | Approval | The written approval | Names this real-machine drill, the fault and the duration, and says whether `--emitter-activate-at-eof` may be used |
| 2 | Exact SHAs | `git -C $repo fetch origin`, then `git -C $repo rev-parse main origin/main HEAD` | All three equal the SHA named in the approval |
| 3 | Clean checkout and build | `git -C $repo status --porcelain --untracked-files=all` must print nothing. Then, from `$repo`, `pnpm install; pnpm build`, and repeat the status | Build passes; still clean |
| 4 | No unexpected processes | `Show-Machine` | No listeners. Every `node.exe` explained, and none running this repository's monitoring or account code. Never kill anything to pass this check |
| 5 | Account A/B off | Launcher item **1** | Both **OFF** |
| 6 | Native execution disabled | `git -C $repo grep -n "NATIVE_EXECUTION_ENABLED = false as const" -- apps/backend/src` | One hit, in `native-execution-switch.ts` |
| 7 | No account or execution workers | `Show-Machine` | Nothing on 4001/4002. No command line containing `execution.worker` |
| 8 | No drill leftovers | `Show-DrillFiles` | Both lists empty |
| 9 | No unresolved earlier drill | `Get-Journal \| Where-Object { $_.kind -like 'DRILL_*' }`, read to the end | Every earlier drill reads `DRILL_RESTORE_CONFIRMED` with no later contradiction. No `DRILL_RESTORE_UNCONFIRMED` left standing, no reason code ending `REMOVAL_FAILED`, no `DRILL_ENDED` with `facts.fileRemoved` false, no `DRILL_STATE_INCONSISTENT` unexplained. |

Also confirm `docker compose ps` shows Postgres and Redis up, and that the
scanner and emitter were not stopped apart: if the emitter was down for days
while the scanner ran, section 4 of the monitoring document applies first.

If `requests\` is not empty, **stop**. No supported command clears it, and a
start would consume it. Do not delete it by hand; report it.

### Starting the stack (only under the approval)

Open a separate console, keep it open, and do not press Ctrl+C or close it
during the drill. A first Ctrl+C stops the stack. A second one, or closing the
window, leaves the children running without a supervisor.

```powershell
Set-Location C:\Projects\trading-alert-dashboard
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = 'false'
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on run --emitter-activate-at-eof
```

Set the same environment variable in the observing window. It stops pnpm
reinstalling dependencies in the middle of a run
([native-planner-worker.md](native-planner-worker.md)). Without
`--emitter-activate-at-eof`, a lane with no production cursor refuses COMMIT, for
example a symbol listed while the stack was down.

### With the stack running

**First establish [control-plane liveness](#control-plane-liveness).** The table
below means nothing without it.

| # | Check | How | Required |
| --- | --- | --- | --- |
| 10 | No conflict, latch or recovery | `Show-State` | `recoveries` 0, `latched` false, every `externalPids` list empty, no role in `CONFLICT`, `LATCHED`, `BACKOFF` or `RECOVERING` |
| 11 | Stable baseline (operator policy) | `Show-State`, `Show-Journal <G> ''` | `RUNNING` for at least 30 continuous minutes, including at least one 15-minute close, with no `SCANNER_DEGRADED` since `SUPERVISOR_RETURNED_HEALTHY` |
| 12 | Fresh, drill-capable run | `Show-Journal <G> '' -Facts`, then `Show-ScannerOwn <runId>` | In this generation `SUPERVISOR_STARTED` has `"adopted":0` in its facts, there is no `CHILD_ADOPTED`, and the scanner's `ROLE_STARTED` reads `INITIAL_START`. The scanner's own `gitHead` equals the approved SHA. **An adopted scanner may have no drill gate and is not acceptable** |
| 13 | Healthy now | `Show-State` | `state` `RUNNING (ALL_ROLES_HEALTHY)`, `verdict` `HEALTHY`, `attempts` 0, `ours` true, `failed`, `recovering` 0, `universeStale` false |
| 14 | REST budget (operator policy) | `Show-State` | `restRequests` at most **2000** of the run's 4000 |
| 15 | Identity | `Show-State` | Note `generation` and `runId` within the last minute before activation |
| 16 | Same checkout | `(Read-Json (Join-Path $aon 'ownership.json')).repoRoot` | Equals `$repo`. Run the CLI from there; a worktree is refused (`CONTROLLER_NOT_VERIFIED`) |
| 17 | Distance from bar close (operator policy) | `(Get-Date).ToUniversalTime().Minute % 15` | **3 to 7**, leaving about 7 minutes or more before the next close. Otherwise wait |
| 18 | Restore and stop ready | Section G open, the commands below ready in the observing window | The operator can run them immediately |

Before activation also run `Save-Cursors before`, `Show-Locks` and record
`Show-State`. `WARMING` in check 13 is not a failure: it is normal until the first
close after a start. Wait for `HEALTHY` rather than proceeding.

The machine must not sleep or hibernate during the drill. This runbook changes no
Windows setting: keep it attended and awake. A resume is an abort trigger.

**Abort before activation** on any failed check, on any refusal by `run`, or on any
role not `RUNNING` when the window in check 17 opens. Waiting for the next window
is fine for checks 13, 15 and 17. Stopping needs no drill: section G, step 3.

## C. Activation

Run only once, from `$repo`, in the observing window:

```powershell
Set-Location C:\Projects\trading-alert-dashboard
Show-Liveness; Show-State    # liveness ESTABLISHED; recheck generation, runId and check 17
pnpm --filter @trading-alert-dashboard/backend monitoring:always-on drill start --fault PUBLIC_ALL_DOWN --duration-seconds 60 --generation <G> --run-id <runId>
$LASTEXITCODE
```

Do not insert a bare `--`. The command waits for a verdict, at most 75 seconds.

| Output | Exit | Meaning | Do |
| --- | --- | --- | --- |
| `ACCEPTED: drill ACTIVE since …` | 0 | The supervisor wrote the drill file and shows it in its status. **Not yet proof the scanner applied it** | Go to the observation steps |
| `REFUSED: … Nothing was requested.` | 1 | The CLI's own check (no supervisor, wrong generation or run, a drill active, a request waiting). **Not journaled** | Stop and diagnose |
| `REFUSED by the supervisor (<code>): …` | 1 | Journaled as `DRILL_REJECTED` | Stop and diagnose |
| `NOT ACCEPTED: the supervisor gave no verdict in time…` | 1 | The request was withdrawn. The CLI's "nothing was drilled" is an inference | Check `Show-State` and `Show-DrillFiles` first; a drill showing `ACTIVE` goes to section G |
| Usage text | 2 | Bad arguments; nothing happened | Fix the arguments and repeat this section's recheck |

**Never retry a refusal blindly.** Possible supervisor refusals are
`REQUEST_EXPIRED`, `REQUEST_FROM_FUTURE`, `REQUEST_REPLAYED`,
`GENERATION_MISMATCH`, `SHUTTING_DOWN`, `DRILL_ALREADY_ACTIVE`,
`RECOVERY_IN_PROGRESS`, `NO_OWNED_SCANNER`, `RUN_MISMATCH`,
`SCANNER_NOT_HEALTHY`, `CONTROLLER_UNOBSERVABLE`, `CONTROLLER_NOT_VERIFIED`,
`DIRECTORY_NOT_PRIVATE`, `MUTATION_AUTHORITY_BUSY` (something holds the launcher's
mutation lock on port 4009), `OWNERSHIP_UNREADABLE`, `DRILL_FILE_WRITE_FAILED`,
and the parse reasons `SCHEMA_INVALID`, `FIELD_INVALID`, `FAULT_UNKNOWN`,
`DURATION_OUT_OF_BOUNDS`. Find the cause and record it. A new attempt needs the
whole "with the stack running" table again. The approval decides whether a
further attempt is allowed.

**Start exactly one drill.** Do not start another until the first is independently
confirmed restored (section F). `drill start` refuses only while a drill is
active, so it will not protect you from starting one during an unresolved restore.

### Observing the fault

Set `$since` to the `DRILL_STARTED` time, then repeat every 15 to 30 seconds:

```powershell
Show-Liveness; Show-State; Show-DrillFiles; Show-Journal <G> $since
```

Expected timeline. `T` is `DRILL_STARTED`. The timings come from the code's
intervals, not from a real run.

| When | What |
| --- | --- |
| T | `DRILL_STARTED`; `state` of the drill `ACTIVE`; one `.drill` file |
| within 1 s | The scanner applies it: `public transport drill <id> ACTIVE` in `logs\always-on-scanner.log`. All its connections drop, and every symbol detaches |
| up to about T+75 s | The scanner's next status (written every 60 s) is read on the next pass (every 15 s): `SCANNER_DEGRADED`, usually, and `DRILL_ACTIVATION_CONFIRMED`, which may land after `DRILL_ENDED` |
| T+60 s | The scanner's gate ends the fault itself, at the expiry |
| up to about T+75 s | `DRILL_ENDED` (`EXPIRED`); the file is removed |
| up to about T+150 s | First status written after the end: `DRILL_RESTORE_CONFIRMED` |
| from about T+60 s | REST catch-up can start as soon as REST answers, for each symbol, without waiting for its stream |
| about T+105 s | The latest usual reconnect: reconnect delays are 5, 10, 30 and 60 s, so a connection may not retry until well after the fault ends |
| about T+105 to T+240 s | The first moment a recovery can be decided: degradation is first seen on a pass after `T`, then 90 s of grace, then a status written after it |

During this time, **all of these are expected and are not abort triggers:**
scanner and supervisor state `DEGRADED`, `SYMBOLS_RECOVERING`,
`AWAITING_STREAM`, `MARKET_DATA_STALE`, and `AWAITING_FRESH_STATUS`. After a
reconnect every symbol is `QUARANTINED_CURRENT_BAR` until the next close, so the
scanner reads `WARMING` with its role `RUNNING`. **`WARMING` becomes a problem only
after 35 minutes** (`QUARANTINE_PERSISTENT`, `AWAITING_STREAM_PERSISTENT`).

Backend and planner should stay `RUNNING` throughout. `NETWORK_UNAVAILABLE` should
**not** appear in a 60-second drill at default settings. If it does, treat it as a
possible real outage (section G).

## D. Journal events

The journal, `monitoring\always-on\incidents.jsonl`, records transitions the moment
they happen. `status.json` is rewritten at the end of the same pass.
`drill status` reads only `status.json` and the stop directory.

| Kind | When | On a normal drill |
| --- | --- | --- |
| `DRILL_REJECTED` | The supervisor refused a request | Never |
| `DRILL_STARTED` | Request accepted and file written | Once |
| `DRILL_ACTIVATION_CONFIRMED` | A status written since the start names this drill, active or not | Once, possibly after `DRILL_ENDED` |
| `DRILL_ACTIVATION_UNCONFIRMED` | No such status within 180 s | Never |
| `DRILL_RESTORE_REQUESTED` | `drill restore` was consumed (`ENDED_ACTIVE_DRILL` or `NO_ACTIVE_DRILL`) | Only if you ran `drill restore` |
| `DRILL_ENDED` | The drill ended, with its reason as `reasonCode` | Once, `EXPIRED` |
| `DRILL_RESTORE_CONFIRMED` | Scanner evidence after the end: `SCANNER_REPORTS_INACTIVE`, or `SCANNER_RUN_ENDED` when the drilled process has gone | Once |
| `DRILL_RESTORE_UNCONFIRMED` | No such evidence within 180 s of the end. It can still turn `CONFIRMED` later, leaving both lines | Never |
| `DRILL_STALE_REMOVED` | A new generation found drill files at start (`NEW_GENERATION`, `NEW_GENERATION_REMOVAL_FAILED`) | Never, after check 8 |
| `DRILL_UNAUTHORIZED_FILE_REMOVED` | A valid file the supervisor did not write was found and removed | Never |
| `DRILL_STATE_INCONSISTENT` | A fact to investigate, see below | Never |

So **the only normal lines are `DRILL_STARTED`, `DRILL_ACTIVATION_CONFIRMED`,
`DRILL_ENDED` and `DRILL_RESTORE_CONFIRMED`**. The two middle ones can swap order.
`DRILL_RESTORE_CONFIRMED` is always last.

`DRILL_STATE_INCONSISTENT` reason codes:

| Code | Meaning |
| --- | --- |
| `SCANNER_REPORTS_UNEXPECTED_DRILL` | The owned scanner reports a drill this generation did not accept. It withdraws an earlier `restore CONFIRMED` on the same child |
| `WALL_CLOCK_MOVED_BACK` | The clock moved back after the end, before the restore was confirmed |
| `FILE_UNREADABLE`, `RUN_NOT_IDENTIFIED`, `FILE_OF_ANOTHER_RUN`, `FILE_INVALID` | A file at the scanner's drill path that the supervisor did not write and could not attribute. Journaled once and left in place |

**How to read the end reason:**

| Reason | Meaning | Decision |
| --- | --- | --- |
| `EXPIRED` | The bounded end. This is the only expected reason here | Continue to section F |
| `OPERATOR_RESTORE` | You ran `drill restore` | Not a clean run; say why |
| `SCANNER_ENDED` | The scanner's status shows it no longer applies this drill, though the supervisor had not ended it. Its fail-safe ended the fault, for example on an unreadable file, or the file was overwritten | **Unexpected: section G** |
| `CLOCK_ROLLBACK` | The wall clock moved back more than 5 s against the monotonic clock, so the drill's times cannot be trusted. Only a status written since then counts | **Result is at best INCONCLUSIVE** |
| `RUN_ENDED` | The scanner child exited or was replaced during the drill | **Section G** |
| `FILE_REMOVED_EXTERNALLY` | Something other than the supervisor removed the file, or `drill restore` could not reach it in time | **Section G unless you ran `drill restore`** |
| `SHUTDOWN`, `DETACHED`, `FENCED` | A stop, a closed console, or a newer generation | **Section G** |

The scanner's own file uses a different, shorter set: `EXPIRED`, `FILE_REMOVED`,
`FILE_INVALID`, `SUPERSEDED`. They do not need to match the supervisor's word: an
operator restore reads `FILE_REMOVED` in the scanner.

**Restore uncertainty.** `drill.restore` is `NOT_ENDED`, `PENDING`, `CONFIRMED`,
`UNCONFIRMED` or `REMOVAL_FAILED`. `PENDING` for up to about 75 s after the end is
normal. `UNCONFIRMED` means no evidence, not a known failure, and the drill must
not be called restored. `CONFIRMED` alone is not enough: if a file removal is
failing, the scanner can still report the fault over, so `CONFIRMED` can stand
beside `fileRemoved` false. **Require both.**

## E. Expected recovery outcomes (F1)

Do **not** require zero recoveries. The "no recovery" result for a short outage was
measured with 6 simulated symbols, which says nothing about timing at 522 symbols on
about 11 connections.

REST catch-up does not wait for streams: each symbol's job starts once REST answers,
from about T+60 s, while connections retry separately. At most **2 catch-up jobs**
run at once (`restConcurrency`), new ones start from a loop that ticks about once a
second, and requests are spaced at least 250 ms apart within 300 weight per minute.

**These are estimates, not guaranteed timings.** If the one-second loop is the
limiting driver, 522 symbols at 2 per second take about 4.4 minutes; if only the
250 ms spacing limits it, about 2.2 minutes. That finishes between about T+190 s and
T+320 s, against a decision between T+105 s and T+240 s. **One recovery is a
realistic result, and so is self-heal.** Only the real run can say which.

Two outcomes are acceptable. **Neither is automatically PASS**; each must still
pass section F.

**1. Self-heal.** `recoveries` 0, `attempts` 0, `restarts` 0 and the same `runId`.
The emitter stays pinned to it, with no `ROLE_STARTED` line after `T`. The scanner
returns to `RUNNING` (`WARMING`, then `HEALTHY`), and
`SUPERVISOR_RETURNED_HEALTHY` appears.

**2. Exactly one ordered recovery.** `recoveries` 1. The journal shows this order
for one new run id:

1. `SCANNER_RECOVERY_REQUESTED` (usually `SCANNER_DEGRADED_BEYOND_GRACE`);
2. `ROLE_STOP_REQUESTED` emitter, then `ROLE_STOPPED` emitter;
3. `ROLE_STOP_REQUESTED` scanner, then `ROLE_STOPPED` scanner;
4. `ROLE_STARTED` scanner (`RESTART`, `facts.attempt` 1);
5. `SCANNER_RUN_IDENTIFIED` with `RUN_OF_THE_PROFILE_ENGINE`;
6. `SCANNER_RECOVERY_SUCCEEDED`, naming the new and previous run;
7. `ROLE_STARTED` emitter (`RESTART_NOT_A_FAILURE`), then `EMITTER_STARTED_ON_RUN`
   for the new run;
8. `SUPERVISOR_RETURNED_HEALTHY`.

Expect about 7 minutes of fresh-run start-up (363 s in the Gate 3 run), plus the
emitter re-validating its lanes. `attempts` reads 1 until 30 minutes of continuous
health forgive it. `LARGE_BACKLOG_DETECTED` and `BACKLOG_DRAINED` are allowed.

**Expected alert gap, in both outcomes.** Native alerts are intrabar observations on
**open** bars. Closed bars missed during the gap are committed as
`REPLAYED_NON_ACTIONABLE` and never delivered. When a symbol is ready again, its
current bar is `QUARANTINED_CURRENT_BAR`, also never delivered. Its first eligible
bar is the one opening at the next 15-minute boundary after it became ready. So a
symbol is silent from the drop until at least the next close, and one that becomes
ready after that close waits for the following one. **This loss is by design.**

**Failure or abort, in either outcome:**

- a second `SCANNER_RECOVERY_REQUESTED`, or `recoveries` above 1;
- any `SCANNER_RECOVERY_FAILED`, `ROLE_LATCHED` or `SUPERVISOR_LATCHED`;
- `BACKOFF_ENTERED` for the scanner;
- the emitter running while the scanner is replaced, or pinned to any run but the
  current one;
- not back to `RUNNING` within **30 minutes** of `T` (operator policy; the code
  allows a fresh run 45 minutes).

`ROLE_FORCE_STOPPED` keeps the order but means a cooperative stop window was
exceeded. Record it; the result is at best INCONCLUSIVE.

## F. Restoration and independent validation

**`drill status` alone is not enough.** It shows only the supervisor's view and
never the scanner's own report. Allow for lag: a scanner status can be 60 s old and
the supervisor reads it up to 15 s later. Do not judge a field until a status
written after the event has appeared.

| # | Verify | How | Required |
| --- | --- | --- | --- |
| 0 | Control plane live | `monitoring:always-on status`, `Show-Liveness` | `Supervisor: RUNNING`, `liveness` `ESTABLISHED`, `scannerEvidence` `FRESH`. **Without this no other row counts**; the result is FAIL or INCONCLUSIVE |
| 1 | Lifetime ended | `drill status`; `status.json` `drill.state`, `drill.endedAt` | `ENDED`; `endReason` `EXPIRED` |
| 2 | Journal sequence | `Show-Journal <G> $since` | The section D lines; no other `DRILL_*` line |
| 3 | Restore confirmed | `drill.restore` | `CONFIRMED` |
| 4 | File gone per supervisor | `drill.fileRemoved` | `true` |
| 5 | No file on disk | `Show-DrillFiles` | Both lists empty |
| 6 | Scanner's own report | `Show-ScannerOwn <drilled runId>` | `drillId` is this drill, `active` false, `endedAt` set, `pid`, `runId` matching. This file is written by the scanner itself. `roles.scanner.health.drill` in `status.json` (`status.roles.scanner.health.drill` under `status --json`) is the supervisor's parsed copy, holding only `drillId` and `active` |
| 7 | Report is fresh and current | `Show-Liveness`, `Show-State` | `scannerOwnAgeSeconds` at most 180, read from the scanner's own file. `ours` true, `generation` unchanged, `scannerStatusWritten` later than `drill.endedAt`. `scannerStatusAge` alone proves nothing: it is frozen in a frozen `status.json` |
| 8 | No lingering probe fault | `Show-State`, `network` | `reachable` is true or empty, and `streamSince` and `since` are empty. `streamOutcome` is empty or `REACHABLE`. See F2 below |
| 9 | Public connections back | `Show-State` | `streams` all delivering; `reconnects` higher than before (self-heal) or a new count (new run) |
| 10 | Scanner and supervisor agree | `Show-State` | Role state and `verdict` consistent. `runId` equals the run in the scanner's `live-shadow-supervisor\status.json` |
| 11 | Stable condition (operator policy) | `Show-Liveness`, `Show-State`, `Show-Journal` | Liveness holds throughout. `RUNNING`, `HEALTHY`, `failed`, `recovering` 0, for **30 continuous minutes** and at least two closes after returning healthy. After a recovery, `attempts` returns to 0 |
| 12 | No duplicates | `Show-State`; `Invoke-RestMethod http://127.0.0.1:4000/api/signal-quality/soak-health` `.emitter.ledgerDuplicates`; after a recovery also `ledgerDuplicates` in `scanner\native-emitter\runs\<old runId>\status-commit.json` | 0 in all |
| 13 | Cursors | `Save-Cursors after`, `Compare-Cursors before after` | `missing`, `wentBack`, `activationChanged` all 0 |
| 14 | No rebaseline | `rebaseline-before.txt` and `rebaseline-after.txt` in the evidence folder | Equal counts |
| 15 | Planner | `Show-State` | `deltaJobs`, `deltaPlans` 0; `pending` returns to 0; no `PLANNER_FAILURE_DELTA_INCREASED` |
| 16 | Ownership | `Show-State`, `Show-Machine`, `Show-Locks` | Emitter pinned to `runId`. Every `externalPids` list empty. `otherLiveNodeHolders` empty; `failed` 0 |
| 17 | Isolation | `Show-Machine`, `Show-State` | Nothing on 4001/4002; no `execution.worker`; `authority` `NONE native=False account=NONE` |
| 18 | Alert bars | `$a = Get-AlertsSince <activatedAt>`, then `Test-AlertBars $a <activatedAt> <new runId> <new run's startedAt>` (the last two only after a recovery) | `barStartTooEarly` 0 |

After a recovery, row 6 reads the **old** run's file. The new run has no drill
report at all, which is correct: its gate has seen no drill. If the old scanner
stopped before writing an inactive report, its file can still read `active` true.
`DRILL_RESTORE_CONFIRMED` with `SCANNER_RUN_ENDED`, plus that `pid` being gone, is
then the evidence. Note it in the record.

`locks` may exceed `heldByScanner`: old lock files stay behind and are harmless.
Never delete them.

**Replay. No single field proves replay safety.** The evidence together is rows 12
to 14 and 18, the alerts' `runId`, and `triggeredAt` against `observedAt`.

Row 18 applies the source rule. `activatedAt` is the scanner's own, from
`Show-ScannerOwn`. An alert triggered after it must be on a bar that **opened** at or
after the next 15-minute boundary, and one from a replacement run on a bar opened at
or after the boundary following that run's `startedAt`. **Do not reject an alert
because its bar has not closed**: alerts fire on open bars.

Limits of this check:

- It is necessary, not sufficient. A symbol that became ready later has a later first
  eligible bar, and no status field gives that per symbol.
- `triggeredAt` is Binance's event time and `activatedAt` is the local clock, so the
  helper allows 5 s of difference (operator margin). Look at any alert near that edge.
- Alerts delivered after the drop can have a `triggeredAt` before it. They are not in
  this check: they came from before the fault.
- `Get-AlertsSince` reads the Signal Quality API, which loads public market data for
  its outcomes, so use it only at validation. It needs a healthy backend.

A row that cannot be shown makes the result INCONCLUSIVE, not PASS.

**After validation** stop the stack with section G step 3, unless the approval says
to leave it running.

## G. Abort and rollback

**Abort triggers:**

- any unexpected activation refusal (no retry);
- control-plane liveness not established, before any stop you requested
  (`Supervisor: NOT RUNNING` or `UNKNOWN` after asking again, or `Show-Liveness`
  reading `NOT ESTABLISHED`);
- `SUPERVISOR_RESUMED_AFTER_GAP`: the supervisor went more than 60 s without a pass
  (sleep, hibernate or a stalled process). The code restarts its grace periods and
  drops its network state, so the drill's timings no longer mean what this runbook
  says. Capture `Show-Journal <G> $since -Facts`, whose detail gives the gap, and say
  whether the machine slept. The result is at best INCONCLUSIVE, even if everything
  then looks healthy;
- `DRILL_UNAUTHORIZED_FILE_REMOVED`, or any `DRILL_STATE_INCONSISTENT`, including
  `SCANNER_REPORTS_UNEXPECTED_DRILL`;
- `SCANNER_ENDED`, `RUN_ENDED`, `CLOCK_ROLLBACK`, or `DRILL_ACTIVATION_UNCONFIRMED`;
- any account or execution process appearing, or any listener on 4001/4002;
- `CONFLICT`, an unexplained `OTHER_SUPERVISOR_RUNTIME` pid, or an ownership
  failure (`OWNERSHIP_READ_FAILED`, `OWNERSHIP_WRITE_FAILED`, `SUPERVISOR_FENCED`,
  `SUPERVISOR_TICK_FAILED`);
- more than one recovery, or any latch (section E);
- backend or planner leaving `RUNNING`, or `dataStore` not `AVAILABLE`;
- `NETWORK_UNAVAILABLE` with no explanation;
- scanner and supervisor disagreeing with no status lag to explain it;
- **no `DRILL_RESTORE_CONFIRMED` within about 5 minutes of the drill's expiry;**
- cursors going backwards, a new rebaseline file, or any change to locks, cursors,
  checkpoints, ledger or journals that the running stack did not make.

**Procedure, in this order:**

1. **If a drill shows `ACTIVE`, a `.drill` file exists, or restore is unresolved:**

   ```powershell
   Set-Location C:\Projects\trading-alert-dashboard
   pnpm --filter @trading-alert-dashboard/backend monitoring:always-on drill restore
   $LASTEXITCODE
   ```

   It is idempotent, and it also works with no supervisor. It asks the supervisor
   to end the drill, waits up to 45 s for the request to be consumed, then removes
   any `.drill` file still in the stop directory. **Exit 0 means no drill file
   remains, not that the scanner has confirmed anything.** The state it prints can
   be from the pass before. Exit 1 means a file could not be removed; the fault
   still ends at its expiry.

2. **Re-read after one status interval:** wait at least 90 s, then `Show-Liveness`,
   `drill status`, `Show-State`, `Show-DrillFiles`, `Show-ScannerOwn <runId>`. Treat
   it as confirmed only with liveness `ESTABLISHED`, the supervisor's `restore
   CONFIRMED`, the scanner's own report inactive, and no drill file. Then skip to
   step 4 unless another trigger stands, recording `OPERATOR_RESTORE`. A frozen
   status can read `CONFIRMED`.

3. **If restoration is still not clean, or any other trigger stands:**

   ```powershell
   pnpm --filter @trading-alert-dashboard/backend monitoring:always-on stop --wait-seconds 600
   $LASTEXITCODE
   ```

   With a live supervisor this ends any drill first (`SHUTDOWN`), then stops the
   emitter, scanner, planner and backend. **Its exit code is not proof of shutdown:**

   | Output | Exit | Means |
   | --- | --- | --- |
   | `The supervisor has exited.` | 0 | The recorded process is gone. It may have detached or been fenced without stopping its children |
   | `No running Always-On supervisor is recorded; nothing was requested.` | 0 | **Nothing was stopped.** Children may still be running |
   | `Still running after …s` | 1 | The stop continues in the supervisor. Read `monitoring:always-on status` and ask again |
   | `…could not be observed…; nothing was requested. Try again.` | 1 | Nothing was requested. Try again |

   **Then prove it:** run `Show-Shutdown <G>`, `Show-Machine` and `Show-DrillFiles`.

   | `verdict` | Means | Do |
   | --- | --- | --- |
   | `COMPLETE` | After `SUPERVISOR_STOPPING`: `ROLE_STOPPED` for emitter, scanner, planner and backend in that order, then one `SUPERVISOR_STOPPED`. `ownership.json` has no supervisor or children. No monitoring process or listener remains | Step 4 |
   | `COMPLETE, NOT CLEAN` | Everything has stopped, but through a forced stop, an unexpected exit or a dropped record | Step 4; the drill result is at best INCONCLUSIVE |
   | `INCOMPLETE` | Anything else | The branch below |

   A remaining drill file with no supervisor: run step 1 again, which removes it.

   **Shutdown INCOMPLETE, or the stop cannot be applied** (for example, no supervisor
   but children still running, or `STOPPING` never ends):

   1. Capture `monitoring:always-on status`, `Show-Liveness`, `Show-State`,
      `Show-Machine`, `Show-Shutdown <G>` and `Show-Journal <G> $since -Facts`.
   2. Record the shutdown as **INCOMPLETE**. The drill result is FAIL or INCONCLUSIVE.
   3. Take no further drill action.
   4. Do not kill any process. Do not remove any lock, journal, checkpoint or cursor.
   5. Obtain **separate explicit approval** for any cleanup. The supported path, a new
      `monitoring:always-on run` that adopts the children provably its own, followed
      by `stop`, is not authorized by this runbook, and is unproven as a recovery on
      this machine.

4. **Capture evidence, classify the result** (section H), **and take no further
   action** beyond the documented, already-authorized `drill restore` and `stop`
   attempts above. Orphan cleanup, process adoption or any other intervention needs
   separate explicit approval. So does restarting Always-On or another drill.

**Never:**

- delete or edit scanner locks, cursors, checkpoints, the ledger, journals,
  `ownership.json` or request files by hand;
- run `taskkill` or `Stop-Process` on any monitoring process;
- close the console or press Ctrl+C twice as a shortcut, since that leaves the
  children unsupervised;
- run `clear-latch` to get past a latch during this drill;
- run `native-alerts:rebaseline-cursors`;
- call an unresolved drill PASS or leave it out of the record.

**Authority.** `drill restore` and the conditional `stop`, including the re-asks
described in step 3, are already authorized by the drill's approval. Nothing after
them is. If the stop cannot finish (`STOPPING`
never ends, repeated `SUPERVISOR_TICK_FAILED`), no supported command forces it, and
the fault still ends at its TTL. Keep the console open and follow the INCOMPLETE
branch above. Do not improvise process termination.

Rollback of the merged code is a separate decision with its own approval.

## H. Incident evidence

Copy into the record. Never include credentials, environment values or signed
requests. The commands above expose none.

```text
GATE 4A FIRST DRILL RECORD
Approval reference:
Operator:
Baseline commit (main = origin/main = HEAD):
Scanner gitHead:

Generation:                      Drilled run id:
Replacement run id (or none):
Drill id:                        Fault / duration: PUBLIC_ALL_DOWN / 60 s
Requested at (UTC):              UTC minute % 15 at start:
CLI command result + exit code:

Control plane: Supervisor line / liveness / statusAgeSeconds / holderOf4019 / scannerEvidence
  before activation:
  at validation:
SUPERVISOR_RESUMED_AFTER_GAP (or none), gap, did the machine sleep:

Lifecycle (at, kind, reasonCode)
  DRILL_STARTED:
  DRILL_ACTIVATION_CONFIRMED:
  DRILL_ENDED:
  DRILL_RESTORE_CONFIRMED:
  Any other DRILL_* line:

Supervisor view: state / activation / restore / fileRemoved / endReason:
Scanner's own report (file, drillId, active, activatedAt, endedAt, endReason, pid, writtenAt):
Drill files after end:

Recovery outcome: SELF-HEAL / ONE ORDERED RECOVERY / OTHER
  recoveries / attempts / restarts:
  Ordered transitions (at, kind, role, reasonCode):
  Time from T to RUNNING:           Time from T to HEALTHY:
  Force-stopped role (or none):

REST: restRequests before / after / new run:
Alerts: created before / after; alertsAfterActivation / barStartTooEarly:
  First alert after the drill (symbol, triggeredAt, barStart, runId):
Ledger: ledgerDuplicates status / soak-health / old run:
Cursors: before / after / missing / wentBack / activationChanged:
Rebaseline files before / after:
Planner: deltaJobs / deltaPlans / pending:
Locks: locks / heldByScanner / otherLiveNodeHolders:
Isolation: 4001/4002 listeners, execution workers, authority line:

Stable condition: RUNNING + HEALTHY from ____ to ____ (30 min, closes seen):
Final state of the stack:
Shutdown proof: stop output + exit / Show-Shutdown verdict / remaining processes:
Abort triggers hit, and steps taken:
Outstanding incidents:
Protected-state changes not made by the running stack:

DECISION: PASS / FAIL / INCONCLUSIVE
Reason:
```

- **PASS:** every section F row shown, one acceptable outcome from section E, no
  abort trigger.
- **FAIL:** an abort trigger for a real defect, a failure listed in section E, or
  evidence contradicting restoration, ownership or isolation.
- **INCONCLUSIVE:** a row that cannot be shown, control-plane liveness that cannot be
  established, a coincident real outage, a clock rollback, a sleep or resume, a forced
  stop, or an operator restore. It proves less; it is not a pass.

An INCOMPLETE shutdown is recorded beside the decision and is never a PASS. Whatever
the decision, it is the result of this smoke test only: **it is not Gate 4A
acceptance, soak permission or trading authorization.**

## Residual risks and gaps

Accepted as non-blocking for integration. **None is fixed.** Details are in
[section 12](always-on-monitoring.md#known-limits-none-blocking-a-first-supervised-drill).

| Id | Risk | Effect on this drill |
| --- | --- | --- |
| F1 | 522 symbols may need one ordered restart | Section E |
| F2 | A drilled REST or stream probe answer stays cached for up to 30 s after a normal drill end, because only a clock rollback clears it | Should not arise at 60 s, since no probe runs during the fault. If `reachable` false is shown just after the end, recheck after 30 s before judging |
| F4 | `ownership.json` does not validate that a stop file ends in `.stop`. A hand-edited value makes the drill reconcile throw on every pass: repeated `SUPERVISOR_TICK_FAILED`, stalled supervision, and a stop that cannot finish, since the throw comes before the stop path. It needs **adoption**: stop files are read from that file only when a new generation starts, and a spawned child always gets a `.stop` path. Read from code, not executed | **Check 12 is a mandatory precondition of this drill: a fresh generation, nothing adopted.** That excludes F4 here. It is not a guarantee that F4 can never occur: it can after a restart that adopts an edited record. Never edit that file |
| F5 | Journal lines come first: `status.json` follows at the end of the pass, and the scanner's report up to about 75 s later. A planted file removed within one pass may never appear in a status, so `restore CONFIRMED` can stand beside a `DRILL_UNAUTHORIZED_FILE_REMOVED` line | Always read the journal too |
| F6 | Removal outside reconciliation does not inspect the file: a drill's own end and retries, the next generation's sweep, and `drill restore` (which removes every `.drill` file in the stop directory) | Removal can only end a fault |
| F7 | A valid planted file during start-up or recovery stays until the run is identified (`RUN_NOT_IDENTIFIED`), bounded by its TTL | Abort trigger |
| F8 | Other supervisor timers use the wall clock, so a rollback can delay the grace period | Do not change the clock during the drill |
| N2 | Same-account code can forge drill files with fresh ids. **The 900 s TTL is per drill, not a total bound**: without a supervisor, a scanner can be faulted indefinitely. Market data only; no order path | Not protected by this drill |
| N3 | The controller check matches a command-line shape and a creation time. A look-alike passes. **It is not authentication** | Not protected by this drill |
| N5 | A file overwriting an active drill before activation is confirmed goes unnoticed until the drill ends | Abort trigger if reported |
| N6 | A second drill can be accepted while the first's file removal is failing, and then the first's restore evidence is lost | Check 9, and start one drill only |
| N7 | The ACL check ignores the directory owner and parent folders, and runs only when a request is judged. The scanner never checks ACLs | Accepted |
| N8 | Symlinks are followed, the file read has no size limit, and `existsSync` reads any error as "gone" | Rows 4 and 5 of section F are separate checks for this reason |

**Windows boundary.** ACLs stop other non-admin accounts only. Code running as the
operator or an administrator can do anything the operator can.

**Known gaps in this procedure:**

- **Never executed.** `drill start` has only been tested through its parts and
  against no running supervisor. Only the real tsx command-line shape was checked,
  by a probe. A first-run surprise here is a finding, not an operator error.
- **Timings at 522 symbols are estimates** from code intervals and earlier soak
  ratios.
- **No replay indicator**, and no CLI view of the scanner's own drill report: both
  are read from files, as above.
- **CLI processes appear as other supervisors** in the census (cosmetic, section B).
- **`requests\` leftovers have no supported cleanup.**
- **F4 has no supported recovery.** A stop that cannot finish needs engineering.
- **The orphan path is unproven.** Adopt-then-stop exists in the code but is unproven
  as a recovery on this machine, and needs its own approval.
- **The new helpers have run only against stopped-machine files.** `Show-Liveness`,
  `Show-Shutdown` and the alert-bar check were tested on stopped state and synthetic
  rows. `Get-AlertsSince` has never run against a live backend, and the live fields
  have never been exercised.
