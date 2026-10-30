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
[evidence record](#h-incident-evidence) in every case. Row 18 `UNDETERMINED` is never
an automatic PASS, and a clean row 18 is not replay safety.

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
$logs = Join-Path $root 'logs'
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
function Get-ScannerOwn($runId) {
  $file = Join-Path $scan "live-shadow-supervisor\runs\$runId\status.json"
  if ((-not $runId) -or (-not (Test-Path $file))) { return $null }
  $f = Read-Json $file
  if ($f.runId -ne $runId) { return $null }
  $f
}
function Show-ScannerOwn($runId) {
  $f = Get-ScannerOwn $runId
  if ($null -eq $f) { "NO USABLE STATUS for scanner run '$runId': its evidence is not established"; return }
  [pscustomobject]@{ runId = $f.runId; runState = $f.runState; startedAt = $f.startedAt; pid = $f.pid; gitHead = $f.gitHead; writtenAt = $f.writtenAt; restRequests = $f.totals.restRequests
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
function Get-InstantMs($iso) { try { [DateTimeOffset]::Parse($iso, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds() } catch { $null } }
function Get-NextBarOpenMs($ms) { [long]([Math]::Ceiling($ms / 900000) * 900000) }
function Get-SymbolSegment($symbol) {
  if (($symbol -cmatch '^[A-Z0-9]{3,30}$') -and ($symbol -cnotmatch '^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$')) { return $symbol }
  'u-' + (([Text.Encoding]::UTF8.GetBytes([string]$symbol) | ForEach-Object { $_.ToString('x2') }) -join '')
}
function Read-Bounded($file, $maxBytes) {
  try {
    if ((Get-Item -LiteralPath $file -ErrorAction Stop).Length -gt $maxBytes) { return $null }
    $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try { (New-Object IO.StreamReader($stream, (New-Object Text.UTF8Encoding($false)))).ReadToEnd() } finally { $stream.Dispose() }
  } catch { $null }
}
function Read-Lane($fingerprint, $symbol, $sinceMs) {
  $text = Read-Bounded (Join-Path $scan "live-shadow-engines\$($fingerprint.Substring(0,24))\USDM_PERPETUAL\$(Get-SymbolSegment $symbol)\15m\events.jsonl") 67108864
  if ($null -eq $text) { return [pscustomobject]@{ problem = 'lane log absent, unreadable or over 64 MB'; byId = @{} } }
  $byId = @{}; $problem = $null; $previous = $null; $lines = $text.Split("`n")
  for ($i = 0; $i -lt ($lines.Count - 1); $i++) {
    try { $r = $lines[$i] | ConvertFrom-Json } catch { $problem = "lane log line $($i + 1) is not JSON"; continue }
    if (-not $r.eventId) { $problem = "lane log line $($i + 1) has no eventId"; continue }
    if ($byId.ContainsKey($r.eventId)) { $problem = "lane log repeats event $($r.eventId)"; continue }
    $byId[$r.eventId] = $r
    if ($r.kind -ceq 'LIVE_IMMEDIATE_OBSERVATION') {
      if (($null -ne $previous) -and ($previous -ge $sinceMs) -and ($r.firstObservedAtMs -lt $previous)) { $problem = 'firstObservedAtMs goes backwards in the lane log' }
      $previous = $r.firstObservedAtMs
    }
  }
  [pscustomobject]@{ problem = $problem; byId = $byId }
}
function Read-ScannerLog($symbols, $sinceIso) {
  $problem = $null; $runs = @(); $bySymbol = @{}; $run = $null; $previous = ''; $found = $false
  $pattern = [regex]'^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\] (\S+) (?:READINESS_ESTABLISHED at bar \S+: \w+; live eligible from (\S+)|(?:DETACHED|FAILED|QUARANTINED|INACTIVE) )'
  foreach ($name in 'always-on-scanner.log.1', 'always-on-scanner.log') {
    $file = Join-Path $logs $name
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $text = Read-Bounded $file 67108864
    if ($null -eq $text) { $problem = "$name unreadable or over 64 MB"; continue }
    $found = $true
    foreach ($line in $text.Split("`n")) {
      if ($line.StartsWith('run id: ')) { $run = $line.Substring(8).Trim(); $runs += $run; continue }
      if (-not ($line.StartsWith('[') -and ($line.Length -gt 26) -and ($line[25] -eq ']'))) { continue }
      $stamp = $line.Substring(1, 24)
      if (([string]::CompareOrdinal($previous, $sinceIso) -ge 0) -and ([string]::CompareOrdinal($stamp, $previous) -lt 0)) { $problem = "the scanner log's time goes backwards at $stamp" }
      $previous = $stamp
      $m = $pattern.Match($line)
      if ($m.Success -and $symbols.ContainsKey($m.Groups[2].Value)) {
        $symbol = $m.Groups[2].Value
        if (-not $bySymbol.ContainsKey($symbol)) { $bySymbol[$symbol] = New-Object Collections.ArrayList }
        [void]$bySymbol[$symbol].Add([pscustomobject]@{ atMs = (Get-InstantMs $m.Groups[1].Value); ready = $m.Groups[3].Success; eligibleMs = (Get-InstantMs $m.Groups[3].Value); run = $run })
      }
    }
  }
  if ((-not $found) -and ($null -eq $problem)) { $problem = 'no scanner role log' }
  [pscustomobject]@{ problem = $problem; runs = $runs; bySymbol = $bySymbol }
}
function New-Verdict($kind, $why, $producer) { [pscustomobject]@{ kind = $kind; why = $why; producer = $producer } }
function Get-AlertVerdict($x, $c) {
  $id = "$($x.shadowEventId)"; $symbol = "$($x.symbol)"
  if ($id -cnotmatch '^[0-9a-f]{64}$') { return New-Verdict 'UNDETERMINED' 'no valid shadowEventId' }
  if ($symbol -eq '') { return New-Verdict 'UNDETERMINED' 'no symbol' }
  if (-not $c.lanes.ContainsKey($symbol)) { $c.lanes[$symbol] = Read-Lane $c.fingerprint $symbol $c.drilledStartMs }
  $lane = $c.lanes[$symbol]
  if ($lane.problem) { return New-Verdict 'UNDETERMINED' $lane.problem }
  $e = $lane.byId[$id]
  if ($null -eq $e) { return New-Verdict 'UNDETERMINED' 'source record not in the lane log' }
  $barMs = Get-InstantMs $x.barStart; $eventMs = Get-InstantMs $x.triggeredAt; $seen = $e.firstObservedAtMs
  if (($e.kind -cne 'LIVE_IMMEDIATE_OBSERVATION') -or ($e.eventId -cne $id) -or ($e.symbol -cne $symbol) -or ($e.marketType -cne 'USDM_PERPETUAL') -or ($e.chartInterval -cne '15m') -or ($e.classification -cne 'SHADOW_LIVE_ONLY') -or ($e.actionable -ne $false) -or ($null -eq $barMs) -or ($e.barOpenTimeMs -ne $barMs) -or ($null -eq $eventMs) -or ($e.exchangeEventTimeMs -ne $eventMs)) { return New-Verdict 'UNDETERMINED' 'source record does not match the alert' }
  if ((($seen -isnot [int]) -and ($seen -isnot [long])) -or ($seen -le 0)) { return New-Verdict 'UNDETERMINED' 'firstObservedAtMs missing or invalid' }
  if (($barMs % 900000) -ne 0) { return New-Verdict 'UNDETERMINED' 'bar not on a 15-minute boundary' }
  if ($eventMs -lt $barMs) { return New-Verdict 'UNDETERMINED' 'its event time is before its own bar opened' }
  if ([Math]::Abs($seen - $eventMs) -gt 31000) { return New-Verdict 'UNDETERMINED' "local and Binance clocks differ by $($seen - $eventMs) ms on this record" }
  if ($seen -lt $c.activatedMs) {
    $storedMs = Get-InstantMs $x.observedAt
    if ($null -eq $storedMs) { return New-Verdict 'UNDETERMINED' 'no observedAt' }
    if (($seen -lt $c.drilledStartMs) -or (($storedMs - $seen) -gt 900000)) { return New-Verdict 'LATE' "observed $([int](($storedMs - $seen) / 60000)) min before it was stored" }
    return New-Verdict 'BEFORE'
  }
  $isReplacement = $c.recovery -and ($seen -ge $c.replacementMs)
  $producer = if ($isReplacement) { $c.replacementRun } else { $c.drilledRun }
  if ($isReplacement -and ($barMs -lt (Get-NextBarOpenMs $c.replacementMs))) { return New-Verdict 'VIOLATION' 'observed by the replacement on a bar opened before its first possible boundary' $producer }
  $last = $null; $end = $null
  foreach ($h in $c.log.bySymbol[$symbol]) {
    if ($h.ready) { if ($h.atMs -le $seen) { $last = $h; $end = $null } }
    elseif (($null -ne $last) -and ($null -eq $end)) { $end = $h }
  }
  if ($null -eq $last) { return New-Verdict 'UNDETERMINED' 'no READINESS_ESTABLISHED line at or before its observation' }
  if ($last.run -cne $producer) { return New-Verdict 'UNDETERMINED' "its readiness line is in run $($last.run), but its observation time places it in run $producer" }
  if ($null -eq $last.eligibleMs) { return New-Verdict 'UNDETERMINED' 'unreadable readiness line' }
  if ($barMs -lt $last.eligibleMs) { return New-Verdict 'VIOLATION' 'observed on a bar opened before its own live-eligible boundary' $producer }
  if (($null -ne $end) -and ($end.atMs -lt $seen)) { return New-Verdict 'UNDETERMINED' 'observed after its session ended, with no new readiness line' }
  if (($last.atMs -lt $c.activatedMs) -and ($null -eq $end)) { return New-Verdict 'UNDETERMINED' 'observed after activation on a session armed before it, with no recorded end' }
  if ($last.atMs -lt $c.activatedMs) { [void]$c.armedEarlier.Add("$($x.alertId): +$($seen - $c.activatedMs) ms") }
  if ($producer -ceq $c.liveRun) {
    $row = $c.liveRows[$symbol]
    if ($row -and $row.stateDir -and ($row.stateDir -cne (Get-SymbolSegment $symbol))) { return New-Verdict 'UNDETERMINED' "the scanner status names another lane: $($row.stateDir)" }
    $liveMs = if ($row) { Get-InstantMs $row.liveEligibleFrom } else { $null }
    if ($null -eq $liveMs) { $c.unavailable++ } else {
      $ref = $null; foreach ($h in $c.log.bySymbol[$symbol]) { if ($h.ready -and ($h.run -ceq $producer) -and ($h.atMs -le $c.liveWrittenMs)) { $ref = $h } }
      if (($null -eq $ref) -or ($ref.eligibleMs -ne $liveMs)) { return New-Verdict 'UNDETERMINED' 'liveEligibleFrom contradicts the scanner log' }
      $c.matched++
    }
  } else { $c.unavailable++ }
  New-Verdict 'CHECKED' $null $producer
}
function Test-WholeNumber($value) { ($value -is [int]) -or ($value -is [long]) }
function Get-AlertPageProblem($p, $offset, $sinceMs, $endMs, $total, $MaxRows) {
  $w = $p.window; $s = $p.sample; $g = $p.pagination
  if (((Get-InstantMs $w.soakStart) -ne $sinceMs) -or ((Get-InstantMs $w.soakEnd) -ne $endMs) -or ((Get-InstantMs $w.asOf) -ne $endMs) -or ($w.scope -cne 'ALL') -or ($null -eq (Get-InstantMs $w.soakStart)) -or ($null -eq (Get-InstantMs $w.asOf))) { return 'the response window is missing or is not the one requested' }
  if ($s.truncated -isnot [bool]) { return 'sample.truncated is missing or not a boolean' }
  if ($s.truncated) { return "sample.truncated: the window holds more than the API's $($s.limit) alerts" }
  if ((-not (Test-WholeNumber $g.offset)) -or (-not (Test-WholeNumber $g.pageSize)) -or (-not (Test-WholeNumber $g.total)) -or ($g.hasMore -isnot [bool]) -or ($g.sort -cne 'TRIGGERED_ASC')) { return 'pagination is missing or has invalid fields' }
  if (($g.offset -ne $offset) -or ($g.pageSize -ne 100)) { return "the page answered offset $($g.offset), size $($g.pageSize), not the offset $offset, size 100 requested" }
  if (($g.total -lt 0) -or ($g.total -gt $MaxRows)) { return "pagination.total $($g.total) is outside 0 to $MaxRows" }
  if ((Test-WholeNumber $s.evaluated) -and ($s.evaluated -ne $g.total)) { return "pagination.total $($g.total) differs from sample.evaluated $($s.evaluated)" }
  if (-not (Test-WholeNumber $s.evaluated)) { return 'sample.evaluated is missing or invalid' }
  if (($null -ne $total) -and ($g.total -ne $total)) { return "pagination.total changed between pages, $total to $($g.total)" }
  if ($p.items -isnot [array]) { return 'items is missing or not a list' }
  $expected = [Math]::Max(0, [Math]::Min(100, $g.total - $offset))
  if ($p.items.Count -ne $expected) { return "offset $offset of total $($g.total) returned $($p.items.Count) rows, expected $expected" }
  if ($g.hasMore -ne (($offset + 100) -lt $g.total)) { return "hasMore $($g.hasMore) contradicts offset $offset of total $($g.total)" }
  $null
}
function Get-AlertsSince($sinceIso, $MaxPages = 20, $MaxRows = 2000) {
  $rows = New-Object Collections.ArrayList; $seen = @{}; $total = $null; $pages = 0; $offset = 0; $reason = $null; $last = ''; $more = $true
  $now = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture)
  $sinceMs = if ("$sinceIso" -cmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$') { Get-InstantMs $sinceIso } else { $null }
  $endMs = Get-InstantMs $now
  if ($null -eq $sinceMs) { $reason = "no valid start time was given ('$sinceIso'); nothing was requested" }
  while ($more -and ($null -eq $reason)) {
    if ($pages -ge $MaxPages) { $reason = "stopped at the limit of $MaxPages pages with more to read"; break }
    $pages++; $p = $null
    try { $p = Invoke-RestMethod -Uri "http://127.0.0.1:4000/api/signal-quality/signals?soakStart=$sinceIso&soakEnd=$now&asOf=$now&sort=TRIGGERED_ASC&pageSize=100&offset=$offset" -TimeoutSec 120 -ErrorAction Stop }
    catch { $reason = "page $pages (offset $offset) failed: $($_.Exception.Message)"; break }
    $problem = Get-AlertPageProblem $p $offset $sinceMs $endMs $total $MaxRows
    if ($problem) { $reason = "page $pages (offset $offset): $problem"; break }
    $total = $p.pagination.total
    foreach ($item in $p.items) {
      if (($item.alertId -isnot [string]) -or ($item.alertId -eq '') -or ($item.triggeredAt -isnot [string])) { $reason = "page $pages (offset $offset): a row has no valid alertId or triggeredAt"; break }
      if ($seen.ContainsKey($item.alertId)) { $reason = "page $pages (offset $offset): alert $($item.alertId) was returned twice"; break }
      if ([string]::CompareOrdinal($item.triggeredAt, $last) -lt 0) { $reason = "page $pages (offset $offset): rows are out of order"; break }
      $seen[$item.alertId] = $true; $last = $item.triggeredAt; [void]$rows.Add($item)
    }
    $offset += 100; $more = $p.pagination.hasMore
  }
  if (($null -eq $reason) -and ($rows.Count -ne $total)) { $reason = "collected $($rows.Count) rows of total $total" }
  [pscustomobject]@{ contract = 'GET_ALERTS_SINCE_V1'; complete = ($null -eq $reason); rows = $rows.ToArray(); rowCount = $rows.Count; reason = $reason; since = $sinceIso; asOf = $now; total = $total; pages = $pages }
}
function Test-AlertBars($Fetch, $DrilledRunId, $ReplacementRunId, [switch]$RecoveryOccurred) {
  $rows = @(); $problems = @(); $checked = 0; $byDrilled = 0; $byReplacement = 0; $violations = @(); $undetermined = @(); $before = @(); $late = @()
  $drilled = Get-ScannerOwn $DrilledRunId
  $activatedMs = Get-InstantMs $drilled.drill.activatedAt; $drilledStartMs = Get-InstantMs $drilled.startedAt; $replacementMs = $null
  if (($null -eq $activatedMs) -or ($null -eq $drilledStartMs)) { $problems += 'the drilled run has no usable startedAt or drill.activatedAt' }
  if ($RecoveryOccurred) {
    $replacementMs = Get-InstantMs (Get-ScannerOwn $ReplacementRunId).startedAt
    if ($null -eq $replacementMs) { $problems += 'the replacement run has no usable startedAt' }
    elseif ($replacementMs -le $activatedMs) { $problems += 'the replacement started before activation: clock or run mismatch' }
    elseif (($null -eq (Get-InstantMs $drilled.writtenAt)) -or ((Get-InstantMs $drilled.writtenAt) -gt $replacementMs)) { $problems += 'the drilled run has no usable writtenAt, or wrote status after the replacement started: clock change or overlap' }
  }
  if ("$($Fetch.contract)" -cne 'GET_ALERTS_SINCE_V1') { $problems += 'the input is not a Get-AlertsSince result' }
  elseif ($Fetch.complete -isnot [bool]) { $problems += 'the alert fetch does not say whether it is complete' }
  elseif (-not $Fetch.complete) { $problems += "the alert fetch is incomplete: $($Fetch.reason)" }
  elseif (($Fetch.rows -isnot [array]) -or ($Fetch.rowCount -ne $Fetch.rows.Count)) { $problems += 'the alert fetch rows do not match its count' }
  elseif (($null -eq $activatedMs) -or ((Get-InstantMs $Fetch.since) -ne $activatedMs)) { $problems += "the alert fetch starts at '$($Fetch.since)', not at this drill's activation" }
  elseif ((Get-InstantMs $Fetch.asOf) -le [Math]::Max([double](Get-InstantMs $drilled.drill.endedAt), [double]$replacementMs)) { $problems += 'the alert fetch was taken before the drill ended or the replacement started' }
  else { $rows = @($Fetch.rows | Where-Object { $null -ne $_ }) }
  $c = $null
  if (($rows.Count -gt 0) -and ($problems.Count -eq 0)) {
    $fingerprint = "$((Read-Json (Join-Path $aon 'status.json')).roles.scanner.engineFingerprint)"
    if ($fingerprint -cnotmatch '^[0-9a-f]{64}$') { $problems += 'no engine fingerprint in status.json' }
    $symbols = @{}; foreach ($x in $rows) { if ($x.symbol) { $symbols["$($x.symbol)"] = $true } }
    $log = Read-ScannerLog $symbols $drilled.startedAt
    if ($log.problem) { $problems += $log.problem }
    $runs = @($log.runs)
    $expected = @(if ($RecoveryOccurred) { $DrilledRunId; $ReplacementRunId } else { $DrilledRunId })
    $tail = if ($runs.Count -ge $expected.Count) { @($runs[($runs.Count - $expected.Count)..($runs.Count - 1)]) } else { @() }
    if (($tail -join ',') -cne ($expected -join ',')) { $problems += "scanner log runs end [$($tail -join ',')], expected [$($expected -join ',')]" }
    if ($problems.Count -eq 0) {
      $liveRun = $expected[-1]; $live = Get-ScannerOwn $liveRun; $liveRows = @{}
      if ($null -ne $live) { foreach ($s in @($live.symbols)) { if ($null -ne $s) { $liveRows["$($s.symbol)"] = $s } } }
      $c = [pscustomobject]@{ fingerprint = $fingerprint; lanes = @{}; log = $log; activatedMs = $activatedMs; drilledStartMs = $drilledStartMs; replacementMs = $replacementMs; recovery = [bool]$RecoveryOccurred
        drilledRun = $DrilledRunId; replacementRun = $ReplacementRunId; liveRun = $liveRun; liveRows = $liveRows; liveWrittenMs = (Get-InstantMs $live.writtenAt); matched = 0; unavailable = 0; armedEarlier = (New-Object Collections.ArrayList) }
      foreach ($x in $rows) {
        $v = Get-AlertVerdict $x $c
        switch ($v.kind) {
          'CHECKED' { $checked++; if ($v.producer -ceq $DrilledRunId) { $byDrilled++ } else { $byReplacement++ } }
          'BEFORE' { $before += $x.alertId }
          'LATE' { $late += "$($x.alertId): $($v.why)" }
          'VIOLATION' { $violations += "$($x.alertId): $($v.why)" }
          default { $undetermined += "$($x.alertId): $($v.why)" }
        }
      }
    }
  }
  $repeated = @($rows | Where-Object { $_.deliveryKey } | Group-Object deliveryKey | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
  $repeatedEvents = @($rows | Where-Object { $_.shadowEventId } | Group-Object shadowEventId | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
  $manyBefore = $before.Count -gt 10
  $result = if ($violations.Count -gt 0) { 'VIOLATION' } elseif (($problems.Count -gt 0) -or ($undetermined.Count -gt 0) -or ($late.Count -gt 0) -or ($repeated.Count -gt 0) -or ($repeatedEvents.Count -gt 0) -or $manyBefore) { 'UNDETERMINED' } elseif ($checked -eq 0) { 'NOTHING TO CHECK' } else { 'NO VIOLATION FOUND' }
  [pscustomobject]@{ result = $result; alertFetch = $(if ($Fetch.complete -eq $true) { "complete: $($Fetch.rowCount) rows to $($Fetch.asOf)" } else { 'NOT COMPLETE' }); checked = $checked; producedByDrilledRun = $byDrilled; producedByReplacementRun = $byReplacement; violations = ($violations -join '; '); undetermined = ($undetermined -join '; '); evidenceProblems = ($problems -join '; ')
    onPreFaultSession = $(if ($c) { $c.armedEarlier -join '; ' } else { '' }); observedBeforeFault = $before.Count; manyBeforeFault = $manyBefore; lateDelivered = ($late -join '; '); repeatedDeliveryKeys = ($repeated -join ','); repeatedEventIds = ($repeatedEvents -join ',')
    liveEligibleMatched = $(if ($c) { $c.matched } else { 0 }); liveEligibleUnavailable = $(if ($c) { $c.unavailable } else { 0 }); replayOrDuplicatesDecidedHere = 'NO: see section F rows 12 to 14' } | Format-List
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
| 10 | No conflict, latch or recovery | `Show-State` | `recoveries` 0, `latched` false, no role in `CONFLICT`, `LATCHED`, `BACKOFF` or `RECOVERING`. Every `externalPids` list empty: a CLI you just ran can stay listed until the supervisor's next pass, so re-read after about 15 s. A pid still listed, or one you cannot attribute, is an unexpected process: escalate, and never kill it |
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

Expected timeline. `T` is `DRILL_STARTED`. Rows are in order of when each is first
expected, and their ranges overlap. Every time is an approximation from the code's
intervals, not a measurement from a real run and not a deadline.

| Approx. time | What | Kind |
| --- | --- | --- |
| T | `DRILL_STARTED`; the drill's `state` `ACTIVE`; one `.drill` file | Required, first |
| within 1 s | The scanner applies it: `public transport drill <id> ACTIVE` in `logs\always-on-scanner.log`. All its connections drop, and every symbol detaches | Expected |
| T+15 to T+75 s | The scanner's next status (written every 60 s) is read on the next pass (every 15 s): `SCANNER_DEGRADED` | Optional: usual, but a status may never catch the fault |
| T+15 to T+75 s or later | `DRILL_ACTIVATION_CONFIRMED`. **It may land after `DRILL_ENDED`**, because of when the status was written | Required, order free |
| T+60 s | The scanner's gate ends the fault itself, at the expiry | Expected |
| from T+60 s | REST catch-up can start for each symbol once REST answers, without waiting for its stream | Illustrative |
| T+60 to T+75 s | `DRILL_ENDED` (`EXPIRED`); the file is removed | Required |
| by about T+150 s | First status written after the end: `DRILL_RESTORE_CONFIRMED` | Required, last of the four |
| by about T+105 s | The latest usual reconnect. Delays are 5, 10, 30 and 60 s, so a connection may not retry until well after the fault ends | Estimate |
| about T+105 to T+240 s | The first moment a recovery can be decided: degradation is first seen on a pass after `T`, then 90 s of grace, then a status written after it | Estimate |
| about T+190 s or later | REST catch-up of all symbols may finish (section E) | Estimate |

Only these orders are required: `DRILL_STARTED` first, `DRILL_ENDED` before
`DRILL_RESTORE_CONFIRMED`, and `DRILL_RESTORE_CONFIRMED` last of the four. Nothing
else here is a fixed sequence.

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
from about T+60 s, while connections retry separately. Under the default
`FAST_RECOVERY_V1` policy, **4 symbol workers** (`restConcurrency`) catch up at once,
started from a loop that ticks about once a second. Across them, **at most 2 HTTP
requests are in flight**, starts are at least 250 ms apart, and the budget is 300
weight per minute. The Gate 3 log shows the same: "<= 2 in flight … 4 symbol
worker(s)".

**This is an estimate, not a deadline or a guarantee.** With one request per symbol,
522 symbols at about 4 per second take about 2.2 minutes, so catch-up may finish
around T+190 s. That is close to the best case: replaying bars, slow responses, or a
worker still busy at the next tick can only lengthen it. A recovery can be decided
between about T+105 s and T+240 s, and a status must show nothing recovering by then.
**Self-heal and one ordered recovery are both possible at 522 symbols, and this
estimate does not promise that no scanner restart is needed.** Only the real run can
say which.

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
| 16 | Ownership | `Show-State`, `Show-Machine`, `Show-Locks` | Emitter pinned to `runId`. `otherLiveNodeHolders` empty; `failed` 0. Every `externalPids` list empty after a re-read about 15 s later (row 0's CLI can stay listed until the next pass). A pid that persists, or ownership that cannot be established, is an abort trigger |
| 17 | Isolation | `Show-Machine`, `Show-State` | Nothing on 4001/4002; no `execution.worker`; `authority` `NONE native=False account=NONE` |
| 18 | Alert bars and provenance | The commands below | `result` is `NO VIOLATION FOUND`, or `NOTHING TO CHECK` with a note that it proved nothing. `VIOLATION` is FAIL. `UNDETERMINED` is INCONCLUSIVE unless each listed item is explained in writing from other evidence. This row never settles replay on its own |

After a recovery, row 6 reads the **old** run's file. The new run has no drill
report at all, which is correct: its gate has seen no drill. If the old scanner
stopped before writing an inactive report, its file can still read `active` true.
`DRILL_RESTORE_CONFIRMED` with `SCANNER_RUN_ENDED`, plus that `pid` being gone, is
then the evidence. Note it in the record.

`locks` may exceed `heldByScanner`: old lock files stay behind and are harmless.
Never delete them.

**Replay. No single field proves replay safety.** The evidence together is rows 12
to 14 and 18, read with `observedBeforeFault` and `lateDelivered`. A clean row 18 says
nothing about ledger idempotency or cursor integrity.

**Row 18, exact commands.** Run them while the scanner is still running: its
`liveEligibleFrom` values are empty once it stops. The helper reads the run ids' own
status files, the lane logs and the scanner's role log, and writes nothing.

After a self-heal:

```powershell
$activatedAt = (Get-ScannerOwn '<drilled runId>').drill.activatedAt
$fetch = Get-AlertsSince $activatedAt
Test-AlertBars $fetch '<drilled runId>'
```

After one recovery:

```powershell
$activatedAt = (Get-ScannerOwn '<drilled runId>').drill.activatedAt
$fetch = Get-AlertsSince $activatedAt
Test-AlertBars $fetch '<drilled runId>' '<replacement runId>' -RecoveryOccurred
```

**Reading the alerts.** `Get-AlertsSince` returns one result object, and
`Test-AlertBars` accepts nothing else: a plain list or an empty value reads
`UNDETERMINED`.

| Property | Meaning |
| --- | --- |
| `complete` | True only if every page was read and checked |
| `rows`, `rowCount` | The alerts collected, and how many. Do not use the rows when `complete` is false |
| `reason` | Why it is not complete |
| `since`, `asOf`, `total`, `pages` | The window requested, the API's `pagination.total`, and the requests made |

**A failed read is never "no alerts".** `complete` is false, and row 18 reads
`UNDETERMINED`, on a refused connection, a timeout (120 s a page) or an HTTP error; a
response that is not the expected JSON; a window, `scope`, `sort`, offset or page size
differing from the request; missing or mistyped pagination; `sample.truncated`; `total`
differing from `sample.evaluated`, changing between pages, or not matching the rows
returned; `hasMore` contradicting them; a repeated `alertId`; rows out of order; or more
than 20 pages or 2000 rows (the API's own limits, and 2000 rows is exactly 20 pages).
`Test-AlertBars` also refuses a fetch that does not start at this drill's activation, or
that was taken before the drill ended or the replacement started.

**There are no retries.** The first failed page ends the read, so it cannot loop or
collect a stale page twice. To try again, run the `Get-AlertsSince` line again: it starts
from the first page. If it stays incomplete, the row is INCONCLUSIVE.

**The API has no snapshot.** Pages are separate requests, and an evaluation is reused
for only 15 s. The helper pins one `asOf`, so later alerts stay out of the window, and any
change it can see makes the read incomplete. An alert committed late with an earlier
time, swapped for another between pages so that `total` and the order still hold, would
not be seen. A complete read means complete by these checks. It proves neither recovery
nor ledger safety, and zero rows is only "no alert was stored in the window".

**The evidence, and where each item comes from:**

| Evidence | Meaning | Source |
| --- | --- | --- |
| `shadowEventId` on an alert | The `eventId` of the scanner record behind it: a hash of lineage, symbol, bar, signal, timeframe and level, with no clock in it. The scanner writes one identity once, across runs | Alert API |
| `firstObservedAtMs` | **The local clock, read by the scanner in the same step that writes the record.** It is not in the alert. **The record does not name its run** | `live-shadow-engines\<first 24 of engine fingerprint>\USDM_PERPETUAL\<symbol segment>\15m\events.jsonl`. The segment is the symbol if it is 3 to 30 of `A-Z0-9` and not a Windows device name, otherwise `u-` and the lower-case hex of its UTF-8 bytes |
| `READINESS_ESTABLISHED` line | Local time, symbol, and the `live eligible from` boundary that session got. **This is the per-symbol history**, and it survives the scanner | `logs\always-on-scanner.log` (and `.log.1`: it rotates at 32 MB when a role starts). A `run id:` line opens each run. This is an operator log, not a versioned format: a line that does not match counts as absent |
| `DETACHED`, `FAILED`, `QUARANTINED`, `INACTIVE` lines | Local time that symbol's session was turned off. **Not the network disconnect**: at activation the scanner stamps `activatedAt`, then marks its sockets dropped so no new message is accepted. Each session ends only when the deferred close is handled, and messages already queued can be handled until then. The line can be later than the drop, and nothing here gives the exact instant the connection failed | The same log |
| `liveEligibleFrom` | **The current value only**, for one symbol in one run, in that run's status file. It holds no history, a later reconnect replaces it, and it is empty when the session is not ready or the scanner has stopped. So it only cross-checks the log's latest line, and is never used to judge a past alert | `scanner\live-shadow-supervisor\runs\<runId>\status.json`, `symbols[]` |
| `startedAt`, `drill.activatedAt` | Local clock, written by each scanner into its own file. **Never substitute the supervisor's or the emitter's time** | `Get-ScannerOwn` |
| `triggeredAt` | Binance's event time. **It never decides the producer or a violation.** It must match the record, and is used only to detect clock trouble | Alert API |
| `barStart`, `observedAt` | When the bar opened; when the alert was stored | Alert API |
| `runId` on an alert | **The run the delivering emitter was pinned to, not necessarily the scanner that produced the observation.** The helper never uses it. Lane logs outlive runs and the emitter resumes from its cursor, so an old-scanner record can validly arrive under the replacement's `runId` | Alert API |

**Producer.** No record names its producer, so it is derived on the local clock. The
supervisor spawns a replacement only after the old scanner has exited, and the
replacement writes `startedAt` before it connects. So, **if the local clock did not go
backwards**, `firstObservedAtMs` at or after the replacement's `startedAt` means the
replacement, and earlier means the old scanner. Binance's clock plays no part, so no
margin is needed. The readiness line before the record must be in that same run.

**The rule the helper applies**, after finding the record and checking that its id,
symbol, bar, `triggeredAt`, market and interval match the alert:

| `firstObservedAtMs` | Evidence | Result |
| --- | --- | --- |
| before `activatedAt`, stored within 15 minutes, this run | Before the fault | `observedBeforeFault`: counted, not judged |
| before `activatedAt`, stored over 15 minutes later, or before the drilled run started | A late or re-delivered record | `lateDelivered`: `UNDETERMINED` |
| at or after the replacement's `startedAt`, bar opened before the next boundary after it | No session of that run could be eligible | `VIOLATION` |
| at or after `activatedAt`, bar opened before the last readiness line's `live eligible from` | The session refuses such a bar | `VIOLATION` |
| at or after `activatedAt`, on a session armed before activation, its end logged at or after the observation | By the log that session was still armed, so the bar rule holds | Checked, and listed in `onPreFaultSession` |
| as above, but no end logged, or an end logged before the observation with no new readiness | Contradicts the session's lifecycle, or a line is missing | `UNDETERMINED` |
| no readiness line, or one in another run | Cannot be attributed | `UNDETERMINED` |
| otherwise | Eligible, on evidence from its own run | Checked |

**The four results:**

| `result` | Meaning | Row 18 |
| --- | --- | --- |
| `NO VIOLATION FOUND` | The fetch was complete, and every judged alert was attributed and passed. **Limited evidence for the rules above, not universal replay safety** | Passes, with rows 12 to 14 still required |
| `VIOLATION` | An alert's own records and logs show a bar its session could not be eligible on | FAIL. Capture the alert, its lane record and its log lines |
| `UNDETERMINED` | Missing, contradictory or ambiguous evidence | INCONCLUSIVE, unless each listed item is explained in writing from other evidence. **Never an automatic PASS** |
| `NOTHING TO CHECK` | The fetch was complete, and no alert was judged: none in the window, or only `observedBeforeFault` ones | Passes with a note that it proved nothing, neither recovery nor ledger safety. **A failed fetch never reads this** |

**`UNDETERMINED` also reads for:** an incomplete or invalid alert fetch; a missing,
malformed or repeating lane log; a
missing `shadowEventId` or `firstObservedAtMs`; a record that does not match its alert;
no usable run file; a scanner log that is missing, over 64 MB, or whose runs do not end
in the expected ids; a repeated `deliveryKey` or `shadowEventId`; `liveEligibleFrom`
contradicting the log; or more than 10 in `observedBeforeFault` (`manyBeforeFault`).
A `VIOLATION` on one alert outranks all of these.

**`observedBeforeFault` needs reading, not assuming.** Those alerts are normally
observations the emitter delivered just after the drop, or backlog after a recovery.
But a stale record delivered again inside the 15 minutes looks the same, so the count
says nothing by itself. Expect a few. An unexpectedly large count, or anything in
`lateDelivered`, must be investigated with rows 12 to 14, the emitter's cursors and the
recovery journal. The 15 minutes and the 10 are operator policy.

**Limits of this check:**

- **A clock that went backwards can defeat the producer split.** The helper reads
  `UNDETERMINED` if it can see it, from the drilled run's start onward: time going
  backwards in the scanner log or in the observations of a lane; `firstObservedAtMs` over 31 s from `triggeredAt` (the scanner
  detaches at 30 s of lag; the same limit is applied the other way as an operator
  policy); or the old run's last status written after the replacement's `startedAt`.
  **A small step back falling between two log lines is not visible.** `CLOCK_ROLLBACK`
  in the journal stays an abort trigger.
- It rests on the scanner log. A lost log or a rotated-away run gives `UNDETERMINED`.
  It cannot be reconstructed from a later status.
- Only alerts in the API are judged. It says nothing about an observation that was
  never delivered, or about one that should have been.
- Do **not** reject an alert because its bar has not closed: alerts fire on open bars.
- `onPreFaultSession` shows how long after `activatedAt` such an observation came. It
  does not change the result: a long gap means that symbol's connection outlived the
  drop, which is not a bar violation. More than a few seconds is unexpected; read it
  with row 9 (operator judgement).
- A record whose event time is before its own bar reads `UNDETERMINED`. The emitter's
  strict log reader already refuses such a record, so this case does not show that
  production accepts one. The helper checks only the fields it relies on and is not a
  full validator of the log.
- Reads are limited to the lanes of the alerts listed and the two scanner log files,
  each at most 64 MB. A larger file reads `UNDETERMINED`; it is not read in part.
- `Get-AlertsSince` reads the Signal Quality API, which loads public market data for
  its outcomes, so use it only at validation. It needs a healthy backend, and without
  one its result is incomplete.

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
   If the verdict is `INCOMPLETE`, wait about 30 s and read all three again. They only
   read, and the stop can return while the supervisor is still exiting or a last
   journal line is being written. **Only the second reading counts.**

   | `verdict` | Means | Do |
   | --- | --- | --- |
   | `COMPLETE` | After `SUPERVISOR_STOPPING`: `ROLE_STOPPED` for emitter, scanner, planner and backend in that order, then one `SUPERVISOR_STOPPED`. `ownership.json` has no supervisor or children. No monitoring process or listener remains | Step 4 |
   | `COMPLETE, NOT CLEAN` | Everything has stopped, but through a forced stop, an unexpected exit or a dropped record | Step 4; the drill result is at best INCONCLUSIVE |
   | `INCOMPLETE` on the second reading | Anything else, even if `stop` exited 0 | The branch below. It never becomes a PASS because the CLI returned 0 |

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
Replacement run id (or none):    Its own startedAt:
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
Alerts: created before / after; fetch complete / rowCount / total / pages / asOf / reason:
  Test-AlertBars result / alertFetch / checked / producedByDrilledRun / producedByReplacementRun:
  violations / undetermined / evidenceProblems:
  onPreFaultSession / observedBeforeFault / manyBeforeFault / lateDelivered / repeatedDeliveryKeys / repeatedEventIds:
  liveEligibleMatched / liveEligibleUnavailable:
  First alert after the drill (symbol, triggeredAt, barStart, emitter-pinned runId):
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
- **Timings at 522 symbols are estimates** from code intervals, not measurements.
- **No replay indicator**, and no CLI view of the scanner's own drill report: both
  are read from files, as above.
- **CLI processes appear as other supervisors** in the census (cosmetic, section B).
- **`requests\` leftovers have no supported cleanup.**
- **F4 has no supported recovery.** A stop that cannot finish needs engineering.
- **The orphan path is unproven.** Adopt-then-stop exists in the code but is unproven
  as a recovery on this machine, and needs its own approval.
- **The new helpers have run only against stopped-machine files.** `Show-Liveness`,
  `Show-Shutdown`, `Show-ScannerOwn` and `Test-AlertBars` were tested on stopped state
  and synthetic records. `Get-AlertsSince` has run only against a mock built on the API's real page and query
  code, never against a live backend, and
  the live fields have never been exercised, including `liveEligibleFrom` with values
  in it.
- **The readiness history is an operator log.** Row 18 reads its text. A changed line
  format would read `UNDETERMINED`, not a false pass, but the format has no contract.
