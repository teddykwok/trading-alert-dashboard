import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import {
  defaultStatePath,
  expectedGateSnapshotFor,
  classifySpawnResult,
  executeRollback,
  firstObservationFailure,
  judgeOwnedTree,
  observed,
  parseProcessRows,
  unobserved,
  verifyOwnership,
  type RoleHealth,
  type Observation,
  type ProcessProbe,
} from "./runtime-launcher";
import {
  ACCOUNT_SENSITIVE_KEYS,
  DUAL_ROLES,
  SAFE_GATE_CONTRACT,
  accountIdentitiesAreDistinct,
  buildProcessProbeQuery,
  LIVE_READY_UNAVAILABLE,
  ROLE_CONTRACTS,
  RUNTIME_ACCOUNTS,
  censusOf,
  dualSpawnPlan,
  envFilePathFor,
  evaluateAccountProfileProof,
  evaluateDualShutdownSafety,
  evaluateDualStartPreconditions,
  evaluateSafeGatePosture,
  describeEnvFileFailure,
  parseProcessProbeRows,
  projectTopology,
  parseEnvFileStrict,
  validateEnvFiles,
  verifyDualTopology,
  type AccountAttestationView,
  type AccountProfileProof,
  type AccountShutdownState,
  type DualRole,
  type EnvKeyNameReader,
  type GateTriple,
  type ObservedListener,
  type ObservedProcess,
  type RoleStatus,
  type RuntimeAccount,
  type TopologyStatus,
} from "./dual-account-topology";
import {
  EMPTY_RESTART_BUDGET,
  WORKER_SUPERVISION_INTERVAL_MS,
  decideWorkerSupervision,
  executeWorkerRestart,
  observeWorkerHealth,
  recordRestartAttempt,
  renderSupervisionState,
  runSupervisionSingleFlight,
  type RestartBudget,
} from "./worker-supervision";
import {
  GENERIC_ANALYSIS_ROLE,
  decideGenericAnalysisSupervision,
  genericAnalysisHealth,
  renderGenericAnalysisSupervision,
} from "./generic-analysis-supervision";

/**
 * Phase 11I — the local Windows runtime launcher for the DUAL-ACCOUNT topology.
 *
 *   pnpm --filter @trading-alert-dashboard/backend runtime:launcher
 *
 * or double-click `Trading Runtime Launcher.cmd` at the repository root.
 *
 * This file holds only the parts that must touch the machine: probing PIDs,
 * opening sockets, spawning and terminating this repository's own processes,
 * and asking each account control plane about its own durable state. Every
 * DECISION comes from `dual-account-topology.ts`, which is pure and tested.
 *
 * It is a DEPLOYMENT tool and nothing more. It cannot arm, cannot create an
 * authorization window, cannot reach Binance, never writes an environment file
 * and never touches an execution profile. Since 11I it cannot even load
 * live-entry gates: see `LIVE_READY_UNAVAILABLE`.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const STATE_PATH = `${defaultStatePath()}.dual.json`;

// ---------------------------------------------------------------------------
// Launcher state — six independent role records, no secrets
// ---------------------------------------------------------------------------

interface OwnedRole {
  role: DualRole;
  pid: number;
  /** Milliseconds since epoch. Defeats PID reuse: a recycled PID starts later. */
  startedAtMs: number;
  /** The ALIAS of the env file this role was started with. Never a value from it. */
  envAlias: string;
  port: number | null;
}

interface DualRuntimeState {
  repoRoot: string;
  startedAtMs: number;
  processes: OwnedRole[];
}

function readState(): DualRuntimeState | null {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as DualRuntimeState;
    return Array.isArray(parsed.processes) ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(state: DualRuntimeState): void {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const temporary = `${STATE_PATH}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  renameSync(temporary, STATE_PATH);
}

function clearState(): void {
  try {
    writeState({ repoRoot: REPO_ROOT, startedAtMs: Date.now(), processes: [] });
  } catch {
    // A state file we cannot rewrite is reported by the next status read.
  }
}

// ---------------------------------------------------------------------------
// Machine adapters
// ---------------------------------------------------------------------------

/** One PowerShell round-trip for every node process on the machine. */
/**
 * Every node process on the machine, or an explicit failure.
 *
 * The failure case is the whole point. `spawnSync` does not throw when the
 * command cannot be run; it returns a result with `error` set, or a non-zero
 * `status`, and empty stdout. This used to return `[]` for all three, which
 * every caller then read as "no processes are running" -- and for supervision
 * that is the verdict that authorises a replacement spawn.
 *
 * Empty stdout from a SUCCESSFUL command still means an empty machine, which
 * is a real and common answer. Only output that exists and yields no parsable
 * row is rejected as UNPARSEABLE.
 */
function observeProcesses(): Observation<ObservedProcess[]> {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, " +
    "([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), ($_.CommandLine -replace '\\|',' ') }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  const classified = classifySpawnResult(result);
  if (!classified.ok) return classified;
  // ALL OR NOTHING: one malformed row discards the whole census.
  return parseProcessRows(classified.value);
}

/** Listening sockets on the three contracted ports, with their bind address. */
/**
 * Raised when the machine could not be observed at all.
 *
 * Deliberately an exception rather than a quiet empty result: every caller of
 * `collectStatus` renders or decides from the topology, and there is no
 * sensible topology to hand them. The menu catches it and says so.
 */
class ProcessObservationError extends Error {
  constructor(readonly reason: string) {
    super(`the running processes could not be observed (${reason})`);
    this.name = "ProcessObservationError";
  }
}

function observeListeners(): ObservedListener[] {
  const script =
    "Get-NetTCPConnection -State Listen -LocalPort 4000,4001,4002 -ErrorAction SilentlyContinue | " +
    "ForEach-Object { '{0}|{1}|{2}' -f $_.LocalPort, $_.LocalAddress, $_.OwningProcess }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  const listeners: ObservedListener[] = [];
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const [port, address, pid] = line.trim().split("|");
    if (!port || !address) continue;
    listeners.push({ port: Number(port), address, pid: Number(pid) });
  }
  return listeners;
}

/**
 * Asks Windows about SPECIFIC PIDs, whatever executable they are.
 *
 * Deliberately NOT the node-only census: the PID this resolves is the
 * `cmd.exe` that `spawn` returned and that heads each role's process tree, so
 * a query restricted to `node.exe` can never find it. Building the query and
 * parsing its rows both live in the pure module, which is what makes that
 * constraint testable without spawning anything.
 */
/**
 * Asks about SPECIFIC pids, or reports that it could not ask.
 *
 * A pid that is genuinely not running produces a successful command with no
 * row for it, which is proven absence and stays an empty entry. A command that
 * failed produces no rows either, and conflating the two is what let a broken
 * PowerShell read as a dead runtime.
 */
function probeProcesses(pids: number[]): Observation<Map<number, ProcessProbe>> {
  const found = new Map<number, ProcessProbe>();
  const script = buildProcessProbeQuery(pids);
  // Nothing was asked because nothing was asked ABOUT: a real, empty answer.
  if (script === null) return observed(found);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  const classified = classifySpawnResult(result);
  if (!classified.ok) return classified;
  // The SAME strict parser: a probe row and a census row have one shape, so
  // they get one contract.
  const parsed = parseProcessRows(classified.value);
  if (!parsed.ok) return parsed;
  for (const row of parsed.value) found.set(row.pid, row);
  return observed(found);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(700);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** taskkill /T on ONE verified repo-owned root. Never a name-based sweep. */
function terminateTree(pid: number): boolean {
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
  return result.status === 0;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Reads ONE value out of a role's environment file.
 *
 * Every caller below asks only for a non-secret scalar — an account identifier
 * used to build a Redis key pattern, a loopback port, or an operator token used
 * as a request header. None of them is ever printed, and this function returns
 * a value to exactly one caller at a time rather than handing out the file.
 */
function envValue(role: DualRole, key: string): string | null {
  const parsed = parseEnvFileStrict(envFilePathFor(role));
  if (!parsed.ok) return null;
  const value = parsed.values.get(key);
  return value === undefined || value === "" ? null : value;
}

/**
 * The gate values a role's env file DECLARES.
 *
 * Booleans and one enum, named by `SAFE_GATE_CONTRACT`. Nothing else in the
 * file is read, so no credential can reach a caller.
 */
function declaredGateValues(role: DualRole): Record<string, string | undefined> {
  const declared: Record<string, string | undefined> = {};
  for (const gate of SAFE_GATE_CONTRACT) {
    declared[gate.key] = envValue(role, gate.key) ?? undefined;
  }
  return declared;
}

/**
 * Asks ONE account's control plane to prove its profile is dormant.
 *
 * Two calls, both read-only, both loopback: `/health` for the surface, and the
 * operator status for the profile. The status DTO carries the environment and
 * two booleans and never the account identifier, so nothing here could print
 * one even by mistake -- and the raw response is parsed into four fields and
 * then dropped rather than logged.
 */
async function proveAccountProfileDormant(
  account: Exclude<RuntimeAccount, "GENERIC">
): Promise<AccountProfileProof> {
  const controlRole: DualRole =
    account === "ACCOUNT_A" ? "account-a-control" : "account-b-control";
  const port = ROLE_CONTRACTS[controlRole].port;
  const token = envValue(controlRole, "OPERATOR_API_TOKEN");
  const unknown: AccountProfileProof = {
    account,
    healthOk: false,
    surface: null,
    isEnabled: null,
    killSwitchActive: null,
  };
  if (port === null || token === null) return unknown;

  let healthOk = false;
  let surface: string | null = null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(8000),
    });
    healthOk = response.ok;
    const body = (await response.json()) as { surface?: string };
    surface = body.surface ?? null;
  } catch {
    return unknown;
  }

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/operator/trading-control/status`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) return { ...unknown, healthOk, surface };
    const status = (await response.json()) as {
      profile?: { isEnabled?: boolean | null; killSwitchActive?: boolean | null } | null;
    };
    return {
      account,
      healthOk,
      surface,
      isEnabled: status.profile?.isEnabled ?? null,
      killSwitchActive: status.profile?.killSwitchActive ?? null,
    };
  } catch {
    // Message deliberately dropped: it can carry a token or an endpoint.
    return { ...unknown, healthOk, surface };
  }
}

// ---------------------------------------------------------------------------
// Attestation, per account
// ---------------------------------------------------------------------------

/**
 * One account's attestation reading.
 *
 * The identity comes from that account's OWN env file, so A and B are read
 * through different key prefixes and cannot be confused for one another. The
 * identifier is used to build the scan pattern and is never logged.
 */
async function readAccountAttestation(
  account: Exclude<RuntimeAccount, "GENERIC">
): Promise<AccountAttestationView | null> {
  const controlRole: DualRole = account === "ACCOUNT_A" ? "account-a-control" : "account-b-control";
  const accountIdentifier = envValue(controlRole, "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER");
  const environment = envValue(controlRole, "EXECUTION_PROFILE_ENVIRONMENT");
  if (accountIdentifier === null || environment === null) return null;

  try {
    const { readRuntimeDeploymentAttestationStatusOnce } = await import("../runtime/runtime-attestation");
    const status = await readRuntimeDeploymentAttestationStatusOnce({
      identity: { accountIdentifier, environment },
      expected: expectedGateSnapshotFor("SAFE"),
    });
    // A Redis we could not read reports zero fresh instances for every role,
    // which is indistinguishable from a silent runtime by count alone. Saying
    // UNKNOWN points at the actual fault instead of blaming the processes.
    if (status.reasonCode === "RUNTIME_ATTESTATION_UNAVAILABLE") return null;
    // The gates the CONTROL PLANE actually loaded. Reported as EFFECTIVE,
        // never merged with anything read off disk.
    const gates = status.backend.gates;
    return {
      backendFresh: status.backend.freshCount,
      backendStale: status.backend.staleCount,
      workerFresh: status.worker.freshCount,
      workerStale: status.worker.staleCount,
      effectiveGates:
        gates === null
          ? null
          : {
              globalKillSwitch: gates.globalKillSwitch,
              liveEntryEnabled: gates.liveEntryEnabled,
              protectionReady: gates.protectionReady,
            },
    };
  } catch {
    // Message deliberately dropped: it can carry a Redis endpoint.
    return null;
  }
}

async function readAllAttestation(): Promise<Partial<Record<RuntimeAccount, AccountAttestationView | null>>> {
  const [a, b] = await Promise.all([
    readAccountAttestation("ACCOUNT_A"),
    readAccountAttestation("ACCOUNT_B"),
  ]);
  return { ACCOUNT_A: a, ACCOUNT_B: b };
}

// ---------------------------------------------------------------------------
// Durable shutdown state, asked of each account control plane
// ---------------------------------------------------------------------------

/**
 * Asks ONE account whether it is safe to stop.
 *
 * Over its own loopback control plane rather than from a database read in this
 * process, because `TradingControlService` resolves the profile from the
 * PROCESS environment: a launcher-side read can only ever describe whichever
 * account the launcher itself resolves, which is exactly the single-account
 * assumption 11I removes. The account-bound process is the only thing that can
 * answer for its own account.
 *
 * Every field falls to null on any failure, and null refuses.
 */
async function readAccountShutdownState(
  account: Exclude<RuntimeAccount, "GENERIC">,
  present: boolean
): Promise<AccountShutdownState> {
  const unknown: AccountShutdownState = {
    account,
    present,
    systemState: null,
    activeExecutions: null,
    manualIntervention: null,
    warnings: null,
  };
  if (!present) return { ...unknown, present: false };

  const controlRole: DualRole = account === "ACCOUNT_A" ? "account-a-control" : "account-b-control";
  const port = ROLE_CONTRACTS[controlRole].port;
  const token = envValue(controlRole, "OPERATOR_API_TOKEN");
  if (port === null || token === null) return unknown;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/operator/trading-control/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return unknown;
    const status = (await response.json()) as {
      systemState?: string;
      capacity?: { totalActive?: number };
      manualIntervention?: { count?: number };
      warnings?: { code?: string }[];
    };
    return {
      account,
      present,
      systemState: status.systemState ?? null,
      activeExecutions: status.capacity?.totalActive ?? null,
      manualIntervention: status.manualIntervention?.count ?? null,
      warnings: (status.warnings ?? []).map((warning) => warning.code ?? "UNKNOWN"),
    };
  } catch {
    // Message deliberately dropped: it can carry a token or an endpoint.
    return unknown;
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The recorded roots this launcher can still PROVE it owns.
 *
 * Returns an observation, because the difference between
 * "nothing of ours is running" and "the machine could not be asked" decides
 * whether a supervisor may start a replacement. A failed probe used to produce
 * the first answer while meaning the second.
 */
function ownedRolesAlive(
  state: DualRuntimeState | null
): Observation<{ alive: OwnedRole[]; disowned: string[] }> {
  if (!state) return observed({ alive: [], disowned: [] });
  const probed = probeProcesses(state.processes.map((entry) => entry.pid));
  if (!probed.ok) return probed;
  const probes = probed.value;
  const alive: OwnedRole[] = [];
  const disowned: string[] = [];
  for (const record of state.processes) {
    const verdict = verifyOwnership(record, probes.get(record.pid) ?? null, state.repoRoot);
    if (verdict.owned) alive.push(record);
    else if (verdict.reason !== "GONE") {
      disowned.push(`${record.role} pid ${record.pid}: ${verdict.reason} — NOT terminated`);
    }
  }
  return observed({ alive, disowned });
}

async function collectStatus(): Promise<{
  status: TopologyStatus;
  alive: OwnedRole[];
  disowned: string[];
  effectiveGates: Partial<Record<RuntimeAccount, GateTriple | null>>;
}> {
  const state = readState();
  // An unobservable machine is NOT an empty machine. Both reads are required
  // before any topology can be projected, and a failure is surfaced as a
  // refusal rather than drawn as six OFF roles.
  const ownership = ownedRolesAlive(state);
  const processes = observeProcesses();
  // The explicit test narrows both unions; the shared helper picks WHICH
  // failure is reported, so that choice is a tested function rather than a
  // nested conditional written twice.
  if (!ownership.ok || !processes.ok) {
    throw new ProcessObservationError(firstObservationFailure(ownership, processes) ?? "UNPARSEABLE");
  }
  const { alive, disowned } = ownership.value;
  const census = censusOf(processes.value, observeListeners());
  const attestation = await readAllAttestation();
  const status = projectTopology({
    census,
    ownedRoles: alive.map((entry) => entry.role),
    attestation,
  });
  return {
    status,
    alive,
    disowned,
    effectiveGates: {
      ACCOUNT_A: attestation.ACCOUNT_A?.effectiveGates ?? null,
      ACCOUNT_B: attestation.ACCOUNT_B?.effectiveGates ?? null,
    },
  };
}

/** The three deployment gates each account file declares. Booleans only. */
function gateLine(role: DualRole): string {
  const parsed = parseEnvFileStrict(envFilePathFor(role));
  if (!parsed.ok) return `gates unavailable (${parsed.reasonCode})`;
  const show = (key: string): string => parsed.values.get(key) ?? "<absent>";
  return (
    `kill=${show("EXECUTION_GLOBAL_KILL_SWITCH")} ` +
    `entry=${show("EXECUTION_LIVE_ENTRY_ENABLED")} ` +
    `protection=${show("EXECUTION_PROTECTION_READY")}`
  );
}

function renderTopology(
  status: TopologyStatus,
  disowned: string[],
  effectiveGates: Partial<Record<RuntimeAccount, GateTriple | null>> = {}
): string[] {
  const lines: string[] = ["", "Runtime:"];
  let lastAccount: RuntimeAccount | null = null;
  for (const role of status.roles) {
    const contract = ROLE_CONTRACTS[role.role];
    if (lastAccount !== null && contract.account !== lastAccount) lines.push("");
    lastAccount = contract.account;
    const presence =
      role.presence === "OWNED" ? "ON  (launcher-owned)" : role.presence === "DETECTED" ? "ON  (external)" : "OFF";
    const port =
      role.port === null
        ? ""
        : `   port ${role.port} ${role.portOpen ? "open" : "closed"}${
            role.portLoopbackOk === false ? " NOT-LOOPBACK" : ""
          }`;
    // ABSENT is the ordinary state of a role that is not running, so it reads
    // as plain english rather than as a fault code.
    const attestation =
      role.attestation === "NOT_APPLICABLE"
        ? ""
        : role.attestation === "ABSENT"
          ? "   not attesting"
          : `   attestation ${role.attestation}`;
    lines.push(`  ${contract.label.padEnd(28)} ${presence.padEnd(21)}${port}${attestation}`);
  }

  lines.push("");
  lines.push("CONFIGURED gates — what each account FILE declares. This is what the");
  lines.push("next start would load. It is NOT necessarily what a running process has:");
  lines.push(`  account-a   CONFIGURED  ${gateLine("account-a-control")}`);
  lines.push(`  account-b   CONFIGURED  ${gateLine("account-b-control")}`);

  lines.push("");
  lines.push("EFFECTIVE gates — what each RUNNING control plane attests it loaded:");
  for (const [account, alias] of [
    ["ACCOUNT_A", "account-a"],
    ["ACCOUNT_B", "account-b"],
  ] as const) {
    const effective = effectiveGates[account] ?? null;
    lines.push(
      `  ${alias}   EFFECTIVE   ` +
        (effective === null
          ? "not attesting (no running control plane, or unreadable)"
          : `kill=${effective.globalKillSwitch} entry=${effective.liveEntryEnabled} protection=${effective.protectionReady}`)
    );
  }

  if (status.anyExternal) {
    lines.push("");
    lines.push("Some roles are EXTERNAL: running, but not started by this launcher.");
    lines.push("They are reported and never terminated. Stop them the way they were started.");
  }
  for (const line of disowned) lines.push(`  ${line}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Start SAFE
// ---------------------------------------------------------------------------

async function startSafe(): Promise<void> {
  console.log("");
  console.log("Starting the SAFE dual-account topology: six roles, three environment files.");
  console.log("This never enables trading. It writes no environment file and arms nothing.");

  // FIRST, and for all three files, before a single process is spawned.
  //
  // Sanitation works by deleting every name the selected file declares from
  // the child environment, so a file that cannot be parsed COMPLETELY cannot
  // be sanitised against: an under-reported key set is a key the stale shell
  // value survives into. Refusing here is the only honest answer.
  const envFiles = validateEnvFiles();
  if (!envFiles.ok) {
    console.log("");
    console.log("BLOCKED — nothing was started:");
    for (const failure of envFiles.failures) console.log(`  - ${describeEnvFileFailure(failure)}`);
    return;
  }

  // The key names every spawn below will clear come from THAT validation, not
  // from a second read: there is no window in which a file could change
  // between being approved and being used.
  const validatedKeyNames: EnvKeyNameReader = (role) =>
    envFiles.parsed.get(ROLE_CONTRACTS[role].envAlias)?.keys ?? [];

  // SAFE must MEAN safe. Both account files are required to declare the SAFE
  // deployment posture before a single process is spawned -- otherwise
  // "Start SAFE" would only mean "start whatever the files currently say".
  const gatePosture = [
    evaluateSafeGatePosture("account-a", declaredGateValues("account-a-control")),
    evaluateSafeGatePosture("account-b", declaredGateValues("account-b-control")),
  ];
  const gateReasons = gatePosture.flatMap((verdict) => (verdict.ok ? [] : verdict.reasons));
  if (gateReasons.length > 0) {
    console.log("");
    console.log("BLOCKED — nothing was started:");
    for (const reason of gateReasons) console.log(`  - ${reason}`);
    return;
  }

  const { status, alive } = await collectStatus();
  // Identifiers are compared inside the guard and never returned here.
  const identities = accountIdentitiesAreDistinct((role) => ({
    accountIdentifier: envValue(role, "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER"),
    environment: envValue(role, "EXECUTION_PROFILE_ENVIRONMENT"),
  }));
  const verdict = evaluateDualStartPreconditions({
    status,
    envFiles,
    ownedAliveCount: alive.length,
    identities,
  });
  if (!verdict.ok) {
    console.log("");
    console.log("BLOCKED — nothing was started:");
    for (const reason of verdict.reasons) console.log(`  - ${reason}`);
    return;
  }

  const started: OwnedRole[] = [];
  const rollback = (why: string): void => {
    console.log("");
    console.log(`PARTIAL START — ${why}`);
    console.log("Rolling back ONLY the roles this action started, newest first.");
    // The SAME decision Stop Runtime makes, and the same retention rule: a
    // tree that could not be observed is left alone AND left owned.
    const { retained, complete } = executeRollback([...started].reverse(), REPO_ROOT, {
      probe: (pid) => probeProcesses([pid]),
      terminate: (pid) => terminateTree(pid),
      log: (line) => console.log(`  ${line}`),
    });
    if (complete) {
      clearState();
      return;
    }
    // Unresolved trees keep their ownership records, so a later Stop Runtime
    // or supervision pass can still identify and stop them.
    writeState({ repoRoot: REPO_ROOT, startedAtMs: Date.now(), processes: retained });
    console.log("");
    console.log(
      `ROLLBACK INCOMPLETE — ${retained.length} role(s) could not be observed and were NOT stopped.`
    );
    console.log("Their ownership records were KEPT so they can still be stopped later.");
  };

  for (const role of DUAL_ROLES) {
    const contract = ROLE_CONTRACTS[role];
    console.log(`Starting ${contract.label} (${contract.envAlias}.env)…`);
    const plan = dualSpawnPlan(role, REPO_ROOT, process.env, validatedKeyNames);
    const child = spawn(plan.command, plan.args, plan.options);
    if (child.pid === undefined) {
      rollback(`${contract.label} could not be spawned.`);
      return;
    }
    child.unref();
    const probes = probeProcesses([child.pid]);
    const startedAtMs = probes.ok ? probes.value.get(child.pid)?.startedAtMs : undefined;
    started.push({
      role,
      pid: child.pid,
      startedAtMs: startedAtMs ?? Date.now(),
      envAlias: contract.envAlias,
      port: contract.port,
    });
    writeState({ repoRoot: REPO_ROOT, startedAtMs: Date.now(), processes: started });

    if (contract.port !== null) {
      let open = false;
      for (let attempt = 0; attempt < 30 && !open; attempt += 1) {
        await sleep(1000);
        open = await portOpen(contract.port);
      }
      if (!open) {
        rollback(`an expected port did not open (${contract.port}, ${contract.label}).`);
        return;
      }
    }

    // A control plane is inert -- it binds no orchestration and adopts no
    // plan -- so it is asked to prove its account dormant BEFORE that
    // account's worker exists. The worker is the process that would begin
    // adopting within seconds of starting, and after it exists the proof is
    // no longer a precondition, only an observation.
    if (contract.attests === "BACKEND") {
      const account = contract.account as Exclude<RuntimeAccount, "GENERIC">;
      console.log(`Proving ${account} is dormant before its worker starts…`);
      const proof = await proveAccountProfileDormant(account);
      const verdict = evaluateAccountProfileProof(proof);
      if (!verdict.ok) {
        for (const reason of verdict.reasons) console.log(`  - ${reason}`);
        rollback(`${account} could not prove its execution profile is dormant.`);
        return;
      }
      console.log(
        `  ${account}: control plane ACCOUNT_CONTROL, profile disabled, kill switch active.`
      );
    }
  }

  // Heartbeat is 5s and the TTL is 15s; a first beat plus a margin.
  console.log("");
  console.log("Waiting for the expected ports and attestations to settle…");
  await sleep(20_000);

  const after = await collectStatus();
  const topology = verifyDualTopology(after.status);
  if (!topology.ok) {
    console.log("");
    console.log("Topology verification FAILED:");
    for (const reason of topology.reasons) console.log(`  - ${reason}`);
    rollback("the six-role topology did not verify.");
    return;
  }

  console.log("");
  console.log("SAFE topology verified: six roles, both accounts attesting one BACKEND and one WORKER.");
  for (const line of renderTopology(after.status, after.disowned, after.effectiveGates)) {
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

async function stopRuntime(): Promise<void> {
  const { status, alive, disowned } = await collectStatus();

  if (alive.length === 0) {
    console.log("");
    console.log("This launcher owns no running processes, so there is nothing for it to stop.");
    if (status.anyExternal) {
      console.log("Roles ARE running that this launcher did not start. It will not terminate them.");
    }
    return;
  }

  // Every account with a live runtime must answer for itself.
  const presence: Record<string, boolean> = {};
  for (const role of status.roles) {
    const contract = ROLE_CONTRACTS[role.role];
    if (contract.account === "GENERIC") continue;
    presence[contract.account] = presence[contract.account] === true || role.presence !== "OFF";
  }
  const states = await Promise.all(
    RUNTIME_ACCOUNTS.map((account) => readAccountShutdownState(account, presence[account] === true))
  );
  const safety = evaluateDualShutdownSafety(states);
  if (!safety.ok) {
    console.log("");
    console.log("BLOCKED — nothing was stopped:");
    for (const reason of safety.reasons) console.log(`  - ${reason}`);
    console.log("");
    console.log("This tool is a deployment launcher; it never disarms, revokes or closes anything.");
    console.log("Use Trading Control on the account's own control plane, then try again.");
    return;
  }

  console.log("");
  console.log("Both accounts report SAFE OFF with nothing outstanding. Stopping owned roles…");
  const order = [...DUAL_ROLES].reverse();
  const remaining: OwnedRole[] = [];
  for (const role of order) {
    for (const record of alive.filter((entry) => entry.role === role)) {
      const action = judgeOwnedTree(record, probeProcesses([record.pid]), REPO_ROOT);
      if (action.act === "SKIP") {
        // `retainRecord` is the load-bearing half. Forgetting a record we
        // merely could not observe leaves a live tree the launcher can no
        // longer stop.
        const kept = action.retainRecord ? ", still recorded" : "";
        console.log(`  ${record.role}: ${action.reason} — NOT terminated${kept}`);
        if (action.retainRecord) remaining.push(record);
        continue;
      }
      const stopped = terminateTree(record.pid);
      console.log(`  ${record.role}: ${stopped ? "terminated" : "TERMINATION FAILED"}`);
      if (!stopped) remaining.push(record);
    }
  }
  for (const line of disowned) console.log(`  ${line}`);

  writeState({ repoRoot: REPO_ROOT, startedAtMs: Date.now(), processes: remaining });
  console.log("");
  console.log(
    "Stopped. Nothing was transitioned INTO safe: this tool verifies that both " +
      "accounts are already SAFE and then stops. No environment file was written " +
      "and no profile was changed."
  );
}

// ---------------------------------------------------------------------------
// Supervision, per account
// ---------------------------------------------------------------------------

/**
 * How many runtime LEAVES of a role's entrypoint are running that no
 * launcher-owned record explains.
 *
 * ## Why a subtraction rather than a count
 *
 * A bare count cannot answer "would spawning duplicate anything?", because the
 * OTHER account's execution worker runs the same entrypoint and is supposed to
 * be there. What matters is whether the census holds more leaves than the
 * launcher's own surviving records account for.
 *
 * ## The account-identity limit, stated rather than worked around
 *
 * `classifyEntrypoint` reports an entrypoint, never an account: both account
 * execution workers are `execution.worker.ts` and differ only by an
 * environment variable, which a command line does not carry. So an unexplained
 * `execution.worker` leaf cannot be attributed to A or to B.
 *
 * The conservative reading is the only safe one: ANY unexplained leaf of that
 * entrypoint blocks a replacement for EITHER account. Refusing to start a
 * second worker for the account that already has one costs a stalled recovery
 * an operator can see; guessing wrongly costs two workers admitting against
 * one set of limits.
 *
 * `excludeRole` is the role being replaced -- its own tree has already been
 * proved gone, so it must not be counted as accounting for anything.
 */
function unaccountedLeavesFor(role: DualRole, excludeRole: DualRole): number | null {
  const entrypoint = ROLE_CONTRACTS[role].entrypoint;
  // BOTH reads must succeed. A failed process scan cannot be read as zero
  // leaves, and unverifiable ownership cannot be read as nothing to account
  // for -- either one would turn a blind census into a licence to spawn.
  const processes = observeProcesses();
  if (!processes.ok) return null;
  const ownership = ownedRolesAlive(readState());
  if (!ownership.ok) return null;
  const seen = censusOf(processes.value, []).counts[entrypoint] ?? 0;
  const accountedFor = ownership.value.alive.filter(
    (entry) => entry.role !== excludeRole && ROLE_CONTRACTS[entry.role].entrypoint === entrypoint
  ).length;
  return Math.max(0, seen - accountedFor);
}

/**
 * The ONE restart-execution path both supervisors use.
 *
 * Everything about the safety sequence -- pre-kill ownership re-proof, the
 * refusal to spawn after a failed re-proof, terminate, post-kill exit proof,
 * the fresh pre-spawn census -- lives in `executeWorkerRestart` and is
 * exercised by its own behavioural tests. This adapter supplies the machine
 * calls and nothing else; it makes no safety decision of its own.
 */
function restartOwnedRole(
  decision: ReturnType<typeof decideWorkerSupervision>,
  role: DualRole,
  attemptNumber: number
): ReturnType<typeof executeWorkerRestart> {
  const state = readState();
  return executeWorkerRestart(
    decision,
    { repoRoot: state?.repoRoot ?? REPO_ROOT, processes: state?.processes ?? [] },
    attemptNumber,
    {
      probe: (pid) => {
        const probed = probeProcesses([pid]);
        // `observed: true, process: null` is proven absence; `observed: false`
        // is an unanswered question, and the primitive fails closed on it.
        return probed.ok ? { observed: true, process: probed.value.get(pid) ?? null } : { observed: false };
      },
      terminate: (pid) => {
        terminateTree(pid);
        return true;
      },
      unaccountedLeaves: () => unaccountedLeavesFor(role, role),
      spawnWorker: () => {
        // The SAME role, so the SAME env file, through the same reviewed spawn
        // plan every start of that role uses. No operator input reaches it.
        const plan = dualSpawnPlan(role, REPO_ROOT);
        const child = spawn(plan.command, plan.args, plan.options);
        if (child.pid === undefined) return null;
        child.unref();
        return child.pid;
      },
      log: (line) => console.log(`  ${line}`),
    },
    role
  );
}

/**
 * The OS creation time of a freshly spawned root, or now.
 *
 * Best effort by design: the spawn already happened, so an unobservable
 * creation time must not lose the record. It makes the record harder to verify
 * later, which the ownership check reports honestly, rather than unsafe.
 */
function replacementStartedAt(pid: number): number {
  const probed = probeProcesses([pid]);
  return (probed.ok ? probed.value.get(pid)?.startedAtMs : undefined) ?? Date.now();
}

/** Records a replacement root, leaving every other role's record untouched. */
function recordReplacement(role: DualRole, pid: number, startedAtMs: number): void {
  const next = readState() ?? { repoRoot: REPO_ROOT, startedAtMs: Date.now(), processes: [] };
  next.processes = [
    ...next.processes.filter((entry) => entry.role !== role),
    { role, pid, startedAtMs, envAlias: ROLE_CONTRACTS[role].envAlias, port: null },
  ];
  writeState(next);
}

async function superviseAccountWorker(
  account: Exclude<RuntimeAccount, "GENERIC">,
  ask: (question: string) => Promise<string>
): Promise<void> {
  const workerRole: DualRole = account === "ACCOUNT_A" ? "account-a-worker" : "account-b-worker";
  const controlRole: DualRole = account === "ACCOUNT_A" ? "account-a-control" : "account-b-control";
  const label = ROLE_CONTRACTS[workerRole].label;

  console.log("");
  console.log(`Worker supervision watches ${label} ONLY.`);
  console.log("It never changes a deployment gate, never arms, and never touches an");
  console.log("authorization window. A SAFE runtime stays SAFE.");
  console.log("");
  console.log("It runs only while this launcher is open. Press Ctrl+C to stop it.");
  console.log("");
  if ((await ask(`Start supervising ${label}? (y/N) `)).trim().toLowerCase() !== "y") {
    console.log("Nothing was changed.");
    return;
  }

  let budget: RestartBudget = EMPTY_RESTART_BUDGET;
  for (;;) {
    const pass = await runSupervisionSingleFlight(async () => {
      const state = readState();
      const ownership = ownedRolesAlive(state);
      if (!ownership.ok) {
        // No attempt is spent: nothing was tried, because nothing could be
        // seen. The next tick asks again.
        console.log(`  ${label}: processes could not be observed (${ownership.reason}) — nothing was changed.`);
        return null;
      }
      const { alive } = ownership.value;
      const processes = observeProcesses();
      if (!processes.ok) {
        console.log(`  ${label}: processes could not be observed (${processes.reason}) — nothing was changed.`);
        return null;
      }
      const record = alive.find((entry) => entry.role === workerRole) ?? null;
      const attestation = await readAccountAttestation(account);
      const status = projectTopology({
        census: censusOf(processes.value, observeListeners()),
        ownedRoles: alive.map((entry) => entry.role),
        attestation: { [account]: attestation },
      });
      const workerView = status.roles.find((entry) => entry.role === workerRole);
      const controlView = status.roles.find((entry) => entry.role === controlRole);
      const nowMs = Date.now();
      // The same mapping the decision ladder is given below, so the restart
      // budget and the decision cannot disagree about what they are watching.
      const health = (view: RoleStatus | undefined): RoleHealth => {
        if (view?.attestation === "HEALTHY") return "HEALTHY";
        if (view === undefined) return "OFF";
        // A role that is not running and publishes nothing is OFF. Routing it
        // through the STALE fallback would describe an absent runtime as a
        // faulty one, and supervision would act on the difference.
        if (view.presence === "OFF") return "OFF";
        return view.attestation === "ABSENT" ? "OFF" : "STALE";
      };
      budget = observeWorkerHealth(budget, health(workerView), nowMs);

      // The decision ladder is the tested one. Its record type names the legacy
      // single-stack role; only `pid` is read from it, and the role this pass
      // is about is fixed above — so an A pass can never act on B's process.
      const decision = decideWorkerSupervision({
        record: record === null ? null : { role: "worker", pid: record.pid, startedAtMs: record.startedAtMs },
        ownership: record === null ? null : { owned: true },
        workerHealth: health(workerView),
        backendHealth: health(controlView),
        budget,
        nowMs,
        hasRuntimeState: state !== null,
      });

      if (decision.action !== "NONE") {
        // ONE fenced sequence, shared with generic analysis: re-prove, refuse
        // to spawn on any non-GONE ownership failure, terminate, prove the old
        // tree actually exited, re-census, then spawn at most one.
        const outcome = restartOwnedRole(decision, workerRole, budget.attempts + 1);
        if (outcome.outcome === "RESTARTED" && outcome.newPid !== null) {
          recordReplacement(
            workerRole,
            outcome.newPid,
            replacementStartedAt(outcome.newPid)
          );
        }
        // The attempt is spent whatever the outcome, so a refusal cannot spin:
        // backoff and the ceiling apply to attempts, not to successes.
        budget = recordRestartAttempt(budget, nowMs);
      }
      return { decision, budget };
    });

    if (pass.ran && pass.result !== null) {
      const stamp = new Date().toISOString().slice(11, 19);
      for (const line of renderSupervisionState(pass.result.decision, pass.result.budget)) {
        console.log(`[${stamp}] ${label}: ${line}`);
      }
      if (pass.result.decision.state === "WORKER_RECOVERY_FAILED") {
        console.log("");
        console.log(`Automatic recovery for ${label} has STOPPED. Nothing further will be restarted.`);
        return;
      }
    }
    await sleep(WORKER_SUPERVISION_INTERVAL_MS);
  }
}

/**
 * Supervises the GENERIC ANALYSIS role, and nothing else.
 *
 * Deliberately its own menu action rather than a silent addition to Account
 * A/B supervision: an operator who starts supervision should know exactly
 * which role is being watched and which one may therefore be restarted.
 *
 * It never changes a deployment gate, never arms, never touches an
 * authorization window and never opens a database, Redis or Binance client. A
 * SAFE runtime stays SAFE, and both accounts are untouched.
 */
async function superviseGenericAnalysis(ask: (question: string) => Promise<string>): Promise<void> {
  const label = ROLE_CONTRACTS[GENERIC_ANALYSIS_ROLE].label;

  console.log("");
  console.log(`Supervision watches ${label} ONLY.`);
  console.log("It restarts no other role: not the generic backend, and neither account's");
  console.log("control plane or execution worker.");
  console.log("");
  console.log("It acts only on a tree THIS launcher started and can still prove it owns.");
  console.log("An analysis runtime somebody else started is reported and left alone.");
  console.log("");
  console.log("It runs only while this launcher is open. Press Ctrl+C to stop it.");
  console.log("");
  if ((await ask(`Start supervising ${label}? (y/N) `)).trim().toLowerCase() !== "y") {
    console.log("Nothing was changed.");
    return;
  }

  let budget: RestartBudget = EMPTY_RESTART_BUDGET;
  for (;;) {
    const pass = await runSupervisionSingleFlight(async () => {
      const state = readState();
      const ownership = ownedRolesAlive(state);
      if (!ownership.ok) {
        console.log(`  ${label}: processes could not be observed (${ownership.reason}) — nothing was changed.`);
        return null;
      }
      const { alive } = ownership.value;
      const processes = observeProcesses();
      if (!processes.ok) {
        console.log(`  ${label}: processes could not be observed (${processes.reason}) — nothing was changed.`);
        return null;
      }
      const record = alive.find((entry) => entry.role === GENERIC_ANALYSIS_ROLE) ?? null;
      // No attestation is read: a generic role publishes none, and inventing a
      // health signal it does not emit is exactly what this must not do.
      const status = projectTopology({
        census: censusOf(processes.value, observeListeners()),
        ownedRoles: alive.map((entry) => entry.role),
        attestation: {},
      });
      const nowMs = Date.now();
      // The SAME health function the decision is given below, so the restart
      // budget and the decision cannot disagree about what they are watching.
      const health = genericAnalysisHealth({ status, ownedRootAlive: record !== null });
      budget = observeWorkerHealth(budget, health, nowMs);

      const decision = decideGenericAnalysisSupervision({
        record: record === null ? null : { pid: record.pid, startedAtMs: record.startedAtMs },
        ownership: record === null ? null : { owned: true },
        status,
        budget,
        nowMs,
        hasRuntimeState: state !== null,
      });

      if (decision.action !== "NONE") {
        // The SAME fenced sequence the account workers use. Every safety step
        // -- re-prove, refuse on non-GONE, terminate, prove exit, re-census --
        // lives in `executeWorkerRestart`, so the two supervisors cannot drift.
        const outcome = restartOwnedRole(decision, GENERIC_ANALYSIS_ROLE, budget.attempts + 1);
        if (outcome.outcome === "RESTARTED" && outcome.newPid !== null) {
          recordReplacement(
            GENERIC_ANALYSIS_ROLE,
            outcome.newPid,
            replacementStartedAt(outcome.newPid)
          );
        }
        budget = recordRestartAttempt(budget, nowMs);
      }
      return { decision, budget };
    });

    if (pass.ran && pass.result !== null) {
      const stamp = new Date().toISOString().slice(11, 19);
      for (const line of renderGenericAnalysisSupervision(pass.result.decision, pass.result.budget)) {
        console.log(`[${stamp}] ${line}`);
      }
      // The replacement is VERIFIED by the next pass, not by a bespoke wait:
      // after the stabilization window the leaf count decides again, and a
      // replacement that never produced a runtime simply spends another
      // attempt until the reviewed budget is exhausted.
      if (pass.result.decision.state === "WORKER_RECOVERY_FAILED") {
        console.log("");
        console.log(`Automatic recovery for ${label} has STOPPED. Nothing further will be restarted.`);
        return;
      }
    }
    await sleep(WORKER_SUPERVISION_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> =>
    new Promise((done) => rl.question(question, (answer) => done(answer)));

  try {
    for (;;) {
      let snapshot: Awaited<ReturnType<typeof collectStatus>>;
      try {
        snapshot = await collectStatus();
      } catch (error) {
        if (!(error instanceof ProcessObservationError)) throw error;
        // Deliberately NOT rendered as an empty topology: six OFF roles and
        // "the machine could not be read" look identical on screen and mean
        // opposite things. The menu is not offered over a state nobody knows.
        console.log("");
        console.log(`RUNTIME STATE UNKNOWN — ${error.message}`);
        console.log("No action is offered until the machine can be observed again.");
        console.log("");
        if ((await ask("Retry? (y/N) ")).trim().toLowerCase() === "y") continue;
        break;
      }
      const { status, disowned, effectiveGates } = snapshot;
      for (const line of renderTopology(status, disowned, effectiveGates)) console.log(line);

      console.log("");
      console.log("1. Show Status");
      console.log("2. Start SAFE (six-role dual-account topology)");
      console.log("3. Prepare LIVE-READY (unavailable — see why)");
      console.log("4. Stop Runtime (requires SAFE)");
      console.log("5. Supervise Account A Worker");
      console.log("6. Supervise Account B Worker");
      console.log("7. Supervise Generic Analysis");
      console.log("8. Exit");
      console.log("");

      const choice = (await ask("Choose: ")).trim();
      if (choice === "8") break;
      try {
        if (choice === "1") continue;
        else if (choice === "2") await startSafe();
        else if (choice === "3") {
          console.log("");
          for (const line of LIVE_READY_UNAVAILABLE) console.log(line);
        } else if (choice === "4") await stopRuntime();
        else if (choice === "5") await superviseAccountWorker("ACCOUNT_A", ask);
        else if (choice === "6") await superviseAccountWorker("ACCOUNT_B", ask);
        else if (choice === "7") await superviseGenericAnalysis(ask);
        else console.log("Unrecognised choice. Nothing was changed.");
      } catch (error) {
        // Any action that needs to see the machine refuses when it cannot.
        // Nothing was started, stopped or recorded on this path: the actions
        // read the topology BEFORE they act.
        if (!(error instanceof ProcessObservationError)) throw error;
        console.log("");
        console.log(`REFUSED — ${error.message}`);
        console.log("Nothing was changed.");
      }
    }
  } finally {
    rl.close();
  }
}

void main();
