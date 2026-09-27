import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import {
  defaultStatePath,
  expectedGateSnapshotFor,
  verifyOwnership,
  type RoleHealth,
  type ProcessProbe,
} from "./runtime-launcher";
import {
  ACCOUNT_SENSITIVE_KEYS,
  DUAL_ROLES,
  SAFE_GATE_CONTRACT,
  accountIdentitiesAreDistinct,
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
  observeWorkerHealth,
  recordRestartAttempt,
  renderSupervisionState,
  runSupervisionSingleFlight,
  type RestartBudget,
} from "./worker-supervision";

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
function observeProcesses(): ObservedProcess[] {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, " +
    "([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), ($_.CommandLine -replace '\\|',' ') }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  const observed: ObservedProcess[] = [];
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const [pid, startedAtMs, commandLine] = line.trim().split("|");
    if (!pid || !startedAtMs) continue;
    observed.push({
      pid: Number(pid),
      startedAtMs: Number(startedAtMs),
      commandLine: commandLine ?? "",
    });
  }
  return observed;
}

/** Listening sockets on the three contracted ports, with their bind address. */
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

function probeProcesses(pids: number[]): Map<number, ProcessProbe> {
  const found = new Map<number, ProcessProbe>();
  if (pids.length === 0) return found;
  const wanted = new Set(pids);
  for (const observed of observeProcesses()) {
    if (wanted.has(observed.pid)) found.set(observed.pid, observed);
  }
  return found;
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

function ownedRolesAlive(state: DualRuntimeState | null): { alive: OwnedRole[]; disowned: string[] } {
  if (!state) return { alive: [], disowned: [] };
  const probes = probeProcesses(state.processes.map((entry) => entry.pid));
  const alive: OwnedRole[] = [];
  const disowned: string[] = [];
  for (const record of state.processes) {
    const verdict = verifyOwnership(record, probes.get(record.pid) ?? null, state.repoRoot);
    if (verdict.owned) alive.push(record);
    else if (verdict.reason !== "GONE") {
      disowned.push(`${record.role} pid ${record.pid}: ${verdict.reason} — NOT terminated`);
    }
  }
  return { alive, disowned };
}

async function collectStatus(): Promise<{
  status: TopologyStatus;
  alive: OwnedRole[];
  disowned: string[];
  effectiveGates: Partial<Record<RuntimeAccount, GateTriple | null>>;
}> {
  const state = readState();
  const { alive, disowned } = ownedRolesAlive(state);
  const census = censusOf(observeProcesses(), observeListeners());
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
    for (const record of [...started].reverse()) {
      const probes = probeProcesses([record.pid]);
      const owned = verifyOwnership(record, probes.get(record.pid) ?? null, REPO_ROOT);
      if (!owned.owned) {
        console.log(`  ${record.role}: ${owned.reason} — NOT terminated`);
        continue;
      }
      console.log(`  ${record.role}: ${terminateTree(record.pid) ? "terminated" : "TERMINATION FAILED"}`);
    }
    clearState();
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
    started.push({
      role,
      pid: child.pid,
      startedAtMs: probes.get(child.pid)?.startedAtMs ?? Date.now(),
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
      const probes = probeProcesses([record.pid]);
      const owned = verifyOwnership(record, probes.get(record.pid) ?? null, REPO_ROOT);
      if (!owned.owned) {
        console.log(`  ${record.role}: ${owned.reason} — NOT terminated`);
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
      const { alive } = ownedRolesAlive(state);
      const record = alive.find((entry) => entry.role === workerRole) ?? null;
      const attestation = await readAccountAttestation(account);
      const status = projectTopology({
        census: censusOf(observeProcesses(), observeListeners()),
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

      if (decision.action === "TERMINATE_THEN_RESTART" && decision.terminatePid !== null) {
        const probes = probeProcesses([decision.terminatePid]);
        const owned =
          record !== null && verifyOwnership(record, probes.get(decision.terminatePid) ?? null, REPO_ROOT).owned;
        if (owned) terminateTree(decision.terminatePid);
      }
      if (decision.action === "RESTART" || decision.action === "TERMINATE_THEN_RESTART") {
        // The SAME role, so the SAME env file. A restart cannot change account.
        const plan = dualSpawnPlan(workerRole, REPO_ROOT);
        const child = spawn(plan.command, plan.args, plan.options);
        if (child.pid !== undefined) {
          child.unref();
          const probes = probeProcesses([child.pid]);
          const next = readState() ?? { repoRoot: REPO_ROOT, startedAtMs: Date.now(), processes: [] };
          next.processes = [
            ...next.processes.filter((entry) => entry.role !== workerRole),
            {
              role: workerRole,
              pid: child.pid,
              startedAtMs: probes.get(child.pid)?.startedAtMs ?? Date.now(),
              envAlias: ROLE_CONTRACTS[workerRole].envAlias,
              port: null,
            },
          ];
          writeState(next);
        }
        budget = recordRestartAttempt(budget, nowMs);
      }
      return { decision, budget };
    });

    if (pass.ran) {
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

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> =>
    new Promise((done) => rl.question(question, (answer) => done(answer)));

  try {
    for (;;) {
      const { status, disowned, effectiveGates } = await collectStatus();
      for (const line of renderTopology(status, disowned, effectiveGates)) console.log(line);

      console.log("");
      console.log("1. Show Status");
      console.log("2. Start SAFE (six-role dual-account topology)");
      console.log("3. Prepare LIVE-READY (unavailable — see why)");
      console.log("4. Stop Runtime (requires SAFE)");
      console.log("5. Supervise Account A Worker");
      console.log("6. Supervise Account B Worker");
      console.log("7. Exit");
      console.log("");

      const choice = (await ask("Choose: ")).trim();
      if (choice === "1") continue;
      else if (choice === "2") await startSafe();
      else if (choice === "3") {
        console.log("");
        for (const line of LIVE_READY_UNAVAILABLE) console.log(line);
      } else if (choice === "4") await stopRuntime();
      else if (choice === "5") await superviseAccountWorker("ACCOUNT_A", ask);
      else if (choice === "6") await superviseAccountWorker("ACCOUNT_B", ask);
      else if (choice === "7") break;
      else console.log("Unrecognised choice. Nothing was changed.");
    }
  } finally {
    rl.close();
  }
}

void main();
