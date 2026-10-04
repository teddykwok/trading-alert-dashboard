import { spawn, spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import {
  applyGates,
  classifyDiskMode,
  defaultStatePath,
  parseLauncherStateStrict,
  expectedGateSnapshotFor,
  classifySpawnResult,
  executeRollback,
  LIVE_READY_GATES,
  SAFE_GATES,
  firstObservationFailure,
  judgeOwnedTree,
  classifyLeavesByAncestry,
  observed,
  parseProcessRows,
  parseProcessTreeRows,
  unobserved,
  verifyOwnership,
  type AttestationStatusView,
  type ObservedProcessNode,
  type OwnershipVerdict,
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
  classifyEntrypoint,
  dualSpawnPlan,
  envFilePathFor,
  roleLogDirectory,
  roleLogPath,
  rotatedRoleLogPath,
  ROLE_LOG_ROTATE_BYTES,
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
  type DualSpawnPlan,
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
  type LeafAccounting,
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
  decideModeTransition,
  describePendingTransition,
  judgeSupervisedRestart,
  effectiveModeFromWire,
  evaluateSecondProof,
  evaluateTransitionGate,
  evaluateTransitionPreconditions,
  executeAccountTransition,
  executeTransitionRecovery,
  judgeRoleMode,
  parseTransitionMarker,
  proveCurrentMode,
  rolesForAccount,
  selectedAccountStateFromWire,
  UNREAD_ACCOUNT_STATE,
  type GatheredAccountFacts,
  type ObservedMode,
  type PendingTransition,
  type RuntimeMode,
  type SelectedAccountState,
  type TransitionMarkerRead,
  type TransitionPhase,
} from "./account-runtime-transition";
// A pure counts parser and a counts TYPE. This module imports nothing from
// the binance package that exists at runtime: the launcher must never be able
// to construct a client or read a credential.
import { countsFromWire, type PreShutdownCounts } from "../binance/pre-shutdown-exchange-check";
import {
  listenerAuthority,
  withMutationLock,
  MUTATION_LOCK_HOST,
  MUTATION_LOCK_PORT,
  type ListenerHandle,
  type MutationAction,
  type MutationLockAdapters,
} from "./mutation-lock";
import {
  GENERIC_ANALYSIS_ROLE,
  decideGenericAnalysisSupervision,
  genericAnalysisHealth,
  renderGenericAnalysisSupervision,
} from "./generic-analysis-supervision";
import { createNativePlannerLauncher, type NativePlannerLauncher } from "./native-planner-launcher";

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
  /**
   * An in-flight SAFE <-> LIVE-READY transition, or null once one finishes.
   *
   * Phase, direction and two instants. Nothing read out of an env file and no
   * network address: this file is read by a status command an operator pastes
   * into a chat window.
   *
   * Optional, so a state file written before this existed still parses. An
   * ABSENT field is a proven absence; a field that is present and malformed
   * is not -- see `parseTransitionMarker`.
   */
  transition?: PendingTransition | null;
}

function readState(): DualRuntimeState | null {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as DualRuntimeState;
    return Array.isArray(parsed.processes) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The raw `transition` value, and whether the file could be read at all.
 *
 * Raw and unvalidated on purpose. Every writer below carries this value
 * forward verbatim, so a marker this launcher version does not understand is
 * still preserved for one that does -- and a corrupt one keeps blocking
 * instead of being quietly normalised away.
 */
function readRawTransition(): { readable: boolean; value: unknown } {
  let text: string;
  try {
    text = readFileSync(STATE_PATH, "utf8");
  } catch (error) {
    // No state file at all is a PROVEN absence: nothing has ever been started.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { readable: true, value: undefined };
    return { readable: false, value: undefined };
  }
  try {
    return { readable: true, value: (JSON.parse(text) as { transition?: unknown }).transition };
  } catch {
    return { readable: false, value: undefined };
  }
}

/**
 * A state file that exists but cannot be parsed still means something.
 *
 * Rewriting it without a marker would turn "this machine may be mid-transition"
 * into "this machine is idle", which is the one conversion that must never
 * happen silently. So an unreadable file is rewritten with a marker that is
 * deliberately unparseable-but-present, and the gate keeps refusing until an
 * operator recovers.
 */
const UNREADABLE_MARKER = { corrupt: "the previous launcher state could not be parsed" } as const;

function carriedTransition(): unknown {
  const raw = readRawTransition();
  return raw.readable ? raw.value : UNREADABLE_MARKER;
}

/**
 * Writes the six role records, CARRYING THE TRANSITION MARKER FORWARD.
 *
 * The marker is not something a caller can forget. Every other writer of this
 * file is about processes -- a rollback, a replacement, a clear -- and any one
 * of them rewriting the file without the marker would erase the record of an
 * interrupted transition at exactly the moment it matters most.
 */
function writeState(state: { repoRoot: string; startedAtMs: number; processes: OwnedRole[] }): void {
  writeStateFile({ ...state, transition: carriedTransition() as PendingTransition | null | undefined });
}

/** The only function that touches the file. Atomic: write a temp, then rename. */
function writeStateFile(state: DualRuntimeState): void {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const temporary = `${STATE_PATH}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  renameSync(temporary, STATE_PATH);
}

/**
 * The launcher state, or a throw. NEVER a substitute.
 *
 * `readState` collapses every failure into null, which is right for a status
 * read that then reports "nothing is running". It is completely wrong for a
 * READ-MODIFY-WRITE of the marker: a transient parse failure would make the
 * modify step rewrite the file with `processes: []`, erasing every ownership
 * record on the machine at the exact moment a transition is relying on them.
 * Six roles would become unowned, unstoppable by this tool, and invisible to
 * the census that keeps a second copy from being spawned.
 *
 * So this validates instead of defaulting, and throws on anything it does not
 * fully understand. Callers turn the throw into a refusal.
 */
function readStateStrict(): DualRuntimeState {
  // A MISSING file throws here, deliberately. Once an account-scoped
  // transition is under way its precondition is that both selected roles are
  // launcher-owned, so a state file that has vanished is not an empty runtime
  // -- it is the loss of the records the transition is standing on.
  const text = readFileSync(STATE_PATH, "utf8");
  const parsed = parseLauncherStateStrict(text, REPO_ROOT);
  if (!parsed.ok) throw new Error(parsed.reason);
  return {
    repoRoot: parsed.value.repoRoot,
    startedAtMs: parsed.value.startedAtMs,
    processes: parsed.value.processes as OwnedRole[],
    transition: parsed.value.transition as PendingTransition | null | undefined,
  };
}

/**
 * Persists one transition phase, or throws.
 *
 * Throwing is the contract: the sequence treats an unwritable marker as a
 * reason to stop rather than a reason to continue unrecorded, and it cannot
 * make that decision if this swallows the failure. The ownership records are
 * carried through EXACTLY as they were read -- this function's only edit is
 * the marker.
 */
function writeTransitionMarker(transition: PendingTransition | null): void {
  const current = readStateStrict();
  writeStateFile({
    repoRoot: current.repoRoot,
    startedAtMs: current.startedAtMs,
    processes: current.processes,
    transition,
  });
}

function readTransitionMarker(): TransitionMarkerRead {
  const raw = readRawTransition();
  if (!raw.readable) {
    return { status: "UNREADABLE", reason: "the launcher state file could not be read" };
  }
  return parseTransitionMarker(raw.value);
}

/**
 * Refuses an action whose roles are fenced by an in-flight transition.
 *
 * Returns true when the action may proceed. Printing happens here so every
 * call site refuses in the same words.
 *
 * ## What this does NOT do
 *
 * It is not a lock. It serialises one launcher process against ITSELF and
 * against the residue of a previous run, which is what an interrupted
 * transition leaves behind. Two launcher processes started side by side can
 * both read NONE before either writes a marker, and would then both proceed --
 * the check-then-act window between the read here and the first `journal` call
 * is wide open. There is no inter-process lock in this tool to close it with:
 * the only locking primitive in the repository is a Postgres advisory lock,
 * and this launcher deliberately holds no database connection.
 *
 * The consequence is bounded rather than silent. Both runs would go on to take
 * the SAME fenced stop and fenced start, and the second one's pre-spawn census
 * would meet a runtime the first had started and refuse -- so the failure mode
 * is a refusal and an INCOMPLETE marker, not two workers. It is still a race,
 * and closing it properly needs a lock this slice does not introduce.
 */
function transitionGateAllows(roles: readonly DualRole[]): boolean {
  const verdict = evaluateTransitionGate(readTransitionMarker(), roles);
  if (verdict.ok) return true;
  console.log("");
  console.log("BLOCKED — nothing was changed:");
  for (const reason of verdict.reasons) console.log(`  - ${reason}`);
  return false;
}

// ---------------------------------------------------------------------------
// The machine-wide mutation lock
// ---------------------------------------------------------------------------

/**
 * One exclusive loopback binding, as the authority module wants it.
 *
 * Deliberately NOT a lock file. A file has to be recoverable after a crash,
 * recovery means deleting somebody's file, and "delete this path only if it
 * still holds the record I proved stale" is a compare-and-swap the filesystem
 * does not offer -- so a third launcher can always slip into the moment the
 * path is empty. The OS releases a socket binding on process death without
 * anyone deleting anything, so that moment never exists.
 */
function openMutationListener(): ListenerHandle {
  const server = createServer();
  // It is a mutex, not a service. Anything that connects is dropped at once.
  server.on("connection", (socket) => socket.destroy());
  return {
    listen: (host, port) =>
      new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => {
          server.removeListener("listening", bound);
          reject(error);
        };
        const bound = (): void => {
          server.removeListener("error", failed);
          resolve();
        };
        server.once("error", failed);
        server.once("listening", bound);
        // `exclusive` so the handle is never shared, and the host is pinned to
        // loopback: this must not become a routable port on a machine that
        // arms a real-money runtime.
        server.listen({ host, port, exclusive: true });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          server.close();
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const lockAdapters = (): MutationLockAdapters => ({
  authority: listenerAuthority(openMutationListener),
  log: (line) => console.log(`  ${line}`),
});

/** Prints one refusal, in the same words everywhere. */
function reportLockRefusal(outcome: string, reasons: readonly string[]): void {
  console.log("");
  console.log("BLOCKED — another launcher holds mutation authority on this machine:");
  for (const reason of reasons) console.log(`  - ${reason}`);
  if (outcome !== "BUSY") {
    console.log(`  The mutex is an exclusive binding on ${MUTATION_LOCK_HOST}:${MUTATION_LOCK_PORT}.`);
    console.log("  There is no lock file to clear: the binding is released when its owner exits.");
  }
  console.log("Nothing was started, stopped, written or restarted.");
}

/**
 * Runs one mutating action under machine-wide mutation authority.
 *
 * Every launcher action that changes runtime, process or environment state
 * goes through here. Show Status does not: reading the topology mutates
 * nothing, and blocking it would leave an operator unable to see why they are
 * blocked.
 */
async function underMutationLock(action: MutationAction, run: () => Promise<void>): Promise<void> {
  const held = await withMutationLock(action, lockAdapters(), run);
  if (!held.ran) reportLockRefusal(held.outcome, held.reasons);
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

/**
 * Every node and cmd process on the machine, WITH its parent link.
 *
 * Separate from `observeProcesses` rather than replacing it: that one feeds
 * the entrypoint census, whose all-or-nothing parsing and node-only filter are
 * load-bearing and separately tested. This one answers a different question --
 * which tree a runtime hangs in -- and needs `cmd.exe` because the chain from
 * an owned root to its runtime runs through two of them:
 *
 *   cmd.exe (owned root) -> node (pnpm) -> cmd.exe (tsx) -> node (tsx cli)
 *     -> node (the runtime)
 *
 * Read-only, and the minimum widening that makes ancestry provable: a parent
 * column and one extra executable name.
 */
function observeProcessTree(): Observation<ObservedProcessNode[]> {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe'\" | " +
    "ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, " +
    "([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), ($_.CommandLine -replace '\\|',' ') }";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  const classified = classifySpawnResult(result);
  if (!classified.ok) return classified;
  // ALL OR NOTHING: a half-parsed tree would leave a leaf looking parentless,
  // and a parentless leaf reads as somebody else's.
  return parseProcessTreeRows(classified.value);
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

  // An interrupted transition means at least one account's gates and processes
  // may not agree. Starting the whole topology over that is how a half-moved
  // account becomes a running one nobody has judged.
  if (!transitionGateAllows(DUAL_ROLES)) return;

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
    const pid = spawnRoleWithDurableLog(role, plan);
    if (pid === null) {
      rollback(`${contract.label} could not be spawned.`);
      return;
    }
    const probes = probeProcesses([pid]);
    const startedAtMs = probes.ok ? probes.value.get(pid)?.startedAtMs : undefined;
    started.push({
      role,
      pid,
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
  // Stopping every role includes the two an interrupted transition left in an
  // unjudged state, so the marker is honoured here too.
  if (!transitionGateAllows(DUAL_ROLES)) return;

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
 * Opens ONE role's durable output sink, or returns null.
 *
 * Returning null is a refusal, not a downgrade: a role whose log could not be
 * opened is NOT started. Falling back to `stdio: "ignore"` would reproduce
 * exactly the condition that made the incident unexplainable, and it would do
 * it silently, at the moment something is already going wrong.
 *
 * Rotation is one generation and touches ONLY this role's own two filenames,
 * so a busy account can never rename or delete another role's log.
 */
function openRoleLogSink(role: DualRole): { fd: number; close: () => void } | null {
  try {
    mkdirSync(roleLogDirectory(), { recursive: true });
    const file = roleLogPath(role);
    try {
      if (statSync(file).size >= ROLE_LOG_ROTATE_BYTES) renameSync(file, rotatedRoleLogPath(role));
    } catch {
      // No file yet, or it cannot be measured. Appending is still correct.
    }
    const fd = openSync(file, "a");
    return {
      fd,
      close: () => {
        try {
          closeSync(fd);
        } catch {
          // Already closed, or never valid. Nothing is leaked either way.
        }
      },
    };
  } catch {
    return null;
  }
}

/**
 * Spawns ONE role with its output going somewhere durable.
 *
 * The plan's own `stdio` is the pure module's safe default; the sink is opened
 * here because opening a file is not a decision a pure planner may make. The
 * parent's copy of the descriptor is closed in a `finally` -- on success, on a
 * spawn that returned no pid, and on a throw -- so a launcher that runs for
 * days across many restarts never accumulates descriptors.
 *
 * stdout and stderr share one descriptor deliberately: interleaved output in
 * the order the process actually produced it is what makes a crash readable.
 */
function spawnRoleWithDurableLog(role: DualRole, plan: DualSpawnPlan): number | null {
  const sink = openRoleLogSink(role);
  if (sink === null) {
    console.log(
      `  ${ROLE_CONTRACTS[role].label}: its log file could not be opened, so it was NOT started. ` +
        "A runtime whose output goes nowhere is how the last incident became unexplainable."
    );
    return null;
  }
  try {
    const child = spawn(plan.command, plan.args, {
      ...plan.options,
      stdio: ["ignore", sink.fd, sink.fd],
    });
    if (child.pid === undefined) return null;
    child.unref();
    return child.pid;
  } catch {
    return null;
  } finally {
    // The child has its own copy from here on.
    sink.close();
  }
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
        return spawnRoleWithDurableLog(role, dualSpawnPlan(role, REPO_ROOT));
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
  // Supervision restarts this worker on whatever the file currently says. Mid
  // transition that is a coin toss between two modes, so it refuses -- but only
  // for the account the marker names.
  const { control: supervisedControl } = rolesForAccount(account);
  if (!transitionGateAllows([supervisedControl, workerRole])) return;

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

  /**
   * One observation and one decision, with NO side effect.
   *
   * Separated so it can be run twice: once to find out whether a restart is
   * needed at all, and again under the mutation lock to re-prove it. Both
   * calls are given the SAME starting budget and only one result is
   * committed, so a tick can never count a health observation twice.
   */
  const assess = async (
    from: RestartBudget
  ): Promise<{ budget: RestartBudget; decision: ReturnType<typeof decideWorkerSupervision> } | null> => {
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
      // The DURABLE record, not merely the alive ones.
      //
      // `ownedRolesAlive` drops a record whose process is conclusively GONE,
      // and the old code then passed `record: null` -- which the ladder reads
      // as "nothing is owned here" and refuses. That is what made the
      // process-is-gone case unreachable: the very evidence that justifies a
      // start-only repair was being thrown away before the decision saw it.
      const durable = state?.processes.find((entry) => entry.role === workerRole) ?? null;
      const aliveRecord = alive.find((entry) => entry.role === workerRole) ?? null;

      let ownershipVerdict: OwnershipVerdict | null = null;
      if (durable !== null && state !== null) {
        if (aliveRecord !== null) {
          ownershipVerdict = { owned: true };
        } else {
          // Re-probed HERE so the verdict is as fresh as the decision. An
          // unobservable machine returns without a verdict: UNKNOWN must never
          // become GONE, because GONE is what authorises a spawn.
          const probed = probeProcesses([durable.pid]);
          if (!probed.ok) {
            console.log(`  ${label}: the recorded worker PID could not be observed (${probed.reason}) — nothing was changed.`);
            return null;
          }
          ownershipVerdict = verifyOwnership(durable, probed.value.get(durable.pid) ?? null, state.repoRoot);
        }
      }

      // BOTH accounts' attestation. The other account's health is not idle
      // curiosity: it is the only thing that can explain a runtime leaf, and
      // the two account workers share one entrypoint.
      const attestation = await readAllAttestation();
      const status = projectTopology({
        census: censusOf(processes.value, observeListeners()),
        ownedRoles: alive.map((entry) => entry.role),
        attestation,
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
      const observedBudget = observeWorkerHealth(from, health(workerView), nowMs);

      // WHOSE TREE each runtime hangs in.
      //
      // Counting could never answer this: both accounts run the same
      // entrypoint with the same command line, and the only thing that differs
      // is an environment variable the process table does not expose. Ancestry
      // is the one available discriminator, and it is what separates "our
      // wrapper is empty" from "our worker is alive but has stopped working".
      const entrypoint = ROLE_CONTRACTS[workerRole].entrypoint;
      const tree = observeProcessTree();
      const leaves: LeafAccounting = !tree.ok
        ? { known: false, reason: tree.reason }
        : durable === null
          ? { known: false, reason: "no durable root to trace leaves to" }
          : {
              known: true,
              ...classifyLeavesByAncestry({
                processes: tree.value,
                // The SAME entrypoint rule the census uses, and the same
                // executable filter: the census only ever sees node.exe, so a
                // `cmd /c tsx <entrypoint>` wrapper must be excluded here too
                // or one healthy worker would look like a duplicate.
                isLeaf: (node) =>
                  node.executable.toLowerCase() === "node.exe" &&
                  classifyEntrypoint(node.commandLine) === entrypoint,
                selectedRootPid: durable.pid,
                // ONLY roles whose contract runs this same entrypoint may
                // absorb one of its runtimes. `alive` holds every owned role
                // -- both control planes and both generic roles -- and none of
                // them is ever supposed to have an execution runtime beneath
                // it. Letting them absorb one would turn a rogue worker
                // hanging off a control plane into somebody's legitimate leaf,
                // and the repair would proceed over the top of it.
                otherOwnedRootPids: alive
                  .filter(
                    (entry) =>
                      entry.role !== workerRole &&
                      ROLE_CONTRACTS[entry.role].entrypoint === entrypoint
                  )
                  .map((entry) => entry.pid),
              }),
            };

      // The decision ladder is the tested one. Its record type names the legacy
      // single-stack role; only `pid` is read from it, and the role this pass
      // is about is fixed above — so an A pass can never act on B's process.
      const decision = decideWorkerSupervision({
        record: durable === null ? null : { role: "worker", pid: durable.pid, startedAtMs: durable.startedAtMs },
        ownership: ownershipVerdict,
        workerHealth: health(workerView),
        backendHealth: health(controlView),
        budget: observedBudget,
        nowMs,
        hasRuntimeState: state !== null,
        leaves,
      });
      return { budget: observedBudget, decision };
  };

  let budget: RestartBudget = EMPTY_RESTART_BUDGET;
  for (;;) {
    const pass = await runSupervisionSingleFlight(async () => {
      const first = await assess(budget);
      if (first === null) return null;

      // Nothing to mutate, so no lock is taken. A supervisor sitting open must
      // not block an operator's actions merely by existing.
      if (first.decision.action === "NONE") {
        budget = first.budget;
        return first;
      }

      const held = await withMutationLock("SUPERVISE_RESTART", lockAdapters(), async () => {
        // The marker is read AGAIN, here, under the mutex. The check when this
        // supervisor started is hours old by now, and a transition that began
        // and crashed since then would have left this account PENDING -- with
        // the mutex released by the OS, so nothing else stands in the way.
        const gate = judgeSupervisedRestart(readTransitionMarker(), [supervisedControl, workerRole]);
        if (gate.act === "REFUSE") {
          for (const reason of gate.reasons) console.log(`  ${label}: ${reason}`);
          return null;
        }

        // RE-PROVEN under the lock. The health that justified this restart was
        // observed before mutation authority existed, and an operator's
        // transition could have moved the very role this is about.
        const now = await assess(budget);
        if (now === null) return null;
        if (now.decision.action === "NONE") {
          console.log(`  ${label}: the restart was no longer needed once mutation authority was held.`);
          budget = now.budget;
          return now;
        }

        // ONE fenced sequence, shared with generic analysis: re-prove, refuse
        // to spawn on any non-GONE ownership failure, terminate, prove the old
        // tree actually exited, re-census, then spawn at most one.
        const outcome = restartOwnedRole(now.decision, workerRole, now.budget.attempts + 1);
        if (outcome.outcome === "RESTARTED" && outcome.newPid !== null) {
          recordReplacement(workerRole, outcome.newPid, replacementStartedAt(outcome.newPid));
        }
        // The attempt is spent whatever the outcome, so a refusal cannot spin:
        // backoff and the ceiling apply to attempts, not to successes.
        budget = recordRestartAttempt(now.budget, Date.now());
        return { budget, decision: now.decision };
      });

      if (held.ran) return held.result;
      // No attempt is spent: nothing was tried, because authority was refused.
      for (const reason of held.reasons) console.log(`  ${label}: ${reason}`);
      console.log(`  ${label}: nothing was restarted.`);
      return null;
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
  // The generic role belongs to neither account, so a PENDING marker for one
  // account does not fence it. An UNREADABLE marker does: it does not say
  // which account it was about, and this process shares the state file.
  if (!transitionGateAllows([GENERIC_ANALYSIS_ROLE])) return;
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

  /** One observation and one decision, with NO side effect. Run twice. */
  const assess = async (
    from: RestartBudget
  ): Promise<{
    budget: RestartBudget;
    decision: ReturnType<typeof decideGenericAnalysisSupervision>;
  } | null> => {
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
      const observedBudget = observeWorkerHealth(from, health, nowMs);

      const decision = decideGenericAnalysisSupervision({
        record: record === null ? null : { pid: record.pid, startedAtMs: record.startedAtMs },
        ownership: record === null ? null : { owned: true },
        status,
        budget: observedBudget,
        nowMs,
        hasRuntimeState: state !== null,
      });
      return { budget: observedBudget, decision };
  };

  let budget: RestartBudget = EMPTY_RESTART_BUDGET;
  for (;;) {
    const pass = await runSupervisionSingleFlight(async () => {
      const first = await assess(budget);
      if (first === null) return null;

      // Nothing to mutate, so no lock is taken.
      if (first.decision.action === "NONE") {
        budget = first.budget;
        return first;
      }

      const held = await withMutationLock("SUPERVISE_RESTART", lockAdapters(), async () => {
        // The same fresh read the account supervisors take. The generic role
        // belongs to neither account, so an account's PENDING marker leaves it
        // alone -- but a marker nobody can READ fences it too, because it does
        // not say which account it was about.
        const gate = judgeSupervisedRestart(readTransitionMarker(), [GENERIC_ANALYSIS_ROLE]);
        if (gate.act === "REFUSE") {
          for (const reason of gate.reasons) console.log(`  ${label}: ${reason}`);
          return null;
        }

        // RE-PROVEN under the lock, for the same reason the account
        // supervisors re-prove: the health that justified this was observed
        // before mutation authority existed.
        const now = await assess(budget);
        if (now === null) return null;
        if (now.decision.action === "NONE") {
          console.log(`  ${label}: the restart was no longer needed once mutation authority was held.`);
          budget = now.budget;
          return now;
        }

        // The SAME fenced sequence the account workers use. Every safety step
        // -- re-prove, refuse on non-GONE, terminate, prove exit, re-census --
        // lives in `executeWorkerRestart`, so the two supervisors cannot drift.
        const outcome = restartOwnedRole(now.decision, GENERIC_ANALYSIS_ROLE, now.budget.attempts + 1);
        if (outcome.outcome === "RESTARTED" && outcome.newPid !== null) {
          recordReplacement(GENERIC_ANALYSIS_ROLE, outcome.newPid, replacementStartedAt(outcome.newPid));
        }
        budget = recordRestartAttempt(now.budget, Date.now());
        return { budget, decision: now.decision };
      });

      if (held.ran) return held.result;
      for (const reason of held.reasons) console.log(`  ${label}: ${reason}`);
      console.log(`  ${label}: nothing was restarted.`);
      return null;
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
// Native planner — the OPTIONAL generic role, wired to its own module
// ---------------------------------------------------------------------------

/**
 * Everything about the optional Native planner lives in native-planner-launcher.ts
 * (its own state file, its own fenced start / stop / supervision). This CLI only
 * hands it the machine primitives it already owns -- by reference, so the
 * six-role fences above (the ONE gate printer, the ownership-proving probes, the
 * shared mutation lock, the durable role log) are the ones it uses. It is never
 * part of Start SAFE, Stop Runtime or the six-role state file.
 */
let nativePlannerLauncher: NativePlannerLauncher | null = null;
function nativePlanner(): NativePlannerLauncher {
  nativePlannerLauncher ??= createNativePlannerLauncher({
    repoRoot: REPO_ROOT,
    statePath: `${defaultStatePath()}.native-planner.json`,
    observeProcesses,
    observeListeners,
    probeProcesses,
    terminate: terminateTree,
    spawnRole: spawnRoleWithDurableLog,
    gateAllows: transitionGateAllows,
    readTransitionMarker,
    lockAdapters,
    log: (line) => console.log(line),
    sleep,
  });
  return nativePlannerLauncher;
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Account-scoped SAFE <-> LIVE-READY transition
//
// Every DECISION here lives in `account-runtime-transition.ts` and is exercised
// by its own behavioural tests. What follows supplies the machine calls: an
// HTTP read of one control plane, one env file rewrite, and the two fenced
// primitives restart supervision already uses.
// ---------------------------------------------------------------------------

/** One authenticated loopback GET against ONE account's own control plane. */
async function readControlPlane<T>(
  account: Exclude<RuntimeAccount, "GENERIC">,
  route: string
): Promise<T | null> {
  const { control } = rolesForAccount(account);
  const port = ROLE_CONTRACTS[control].port;
  const token = envValue(control, "OPERATOR_API_TOKEN");
  if (port === null || token === null) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // Message deliberately dropped: it can carry a token or an endpoint.
    return null;
  }
}


/**
 * ONE status read, mapped two ways.
 *
 * Both the account's self-report and the gates it has LOADED come from the
 * same body, so the two can never describe different moments. The mapping
 * itself is pure and lives in the transition module, where it is tested
 * against real HTTP bodies -- including the ones missing a field.
 */
async function readSelectedAccount(account: Exclude<RuntimeAccount, "GENERIC">): Promise<{
  readonly selected: SelectedAccountState;
  readonly effectiveMode: ObservedMode | null;
}> {
  const body = await readControlPlane<unknown>(account, "/api/operator/trading-control/status");
  if (body === null) return { selected: UNREAD_ACCOUNT_STATE, effectiveMode: null };
  return { selected: selectedAccountStateFromWire(body), effectiveMode: effectiveModeFromWire(body) };
}

/**
 * The selected account's EXCHANGE flatness, from its own signed reads.
 *
 * Null -- which refuses -- whenever the route could not be reached. A count the
 * route reports as unknown stays unknown here; this never turns one into zero.
 */
async function readAccountFlatness(
  account: Exclude<RuntimeAccount, "GENERIC">
): Promise<PreShutdownCounts | null> {
  const body = await readControlPlane<Parameters<typeof countsFromWire>[0]>(
    account,
    "/api/operator/trading-control/exchange-flatness"
  );
  // Null, not three zeroes: a route that did not answer has proven nothing.
  if (!body) return null;
  // The mapping is shared with the route's own type and refuses to turn an
  // unexpected shape into a zero.
  return countsFromWire(body);
}

/** Ownership of exactly the two selected roles, or the reason it is unknown. */
function selectedRoleOwnership(
  account: Exclude<RuntimeAccount, "GENERIC">
): Observation<{ controlOwned: boolean; workerOwned: boolean }> {
  const ownership = ownedRolesAlive(readState());
  if (!ownership.ok) return ownership;
  const { control, worker } = rolesForAccount(account);
  const alive = ownership.value.alive;
  return observed({
    controlOwned: alive.some((entry) => entry.role === control),
    workerOwned: alive.some((entry) => entry.role === worker),
  });
}

/**
 * Rewrites ONLY the three gates of ONLY the selected account's env file.
 *
 * `applyGates` changes three lines and preserves every other byte -- line
 * endings, comments, ordering and every unrelated value, credentials included.
 * The write is atomic: a temp file in the same directory, then a rename, so an
 * interruption can leave the old file or the new one but never half of either.
 *
 * ## The temp file holds the credentials too
 *
 * It is a complete copy of the account's environment, so a rename that fails
 * would otherwise leave a second file on disk holding the same API key under a
 * name nobody is watching. It is removed on every failure path, best-effort,
 * and its contents are never logged -- the failure message names no path and
 * quotes nothing. A crash between the write and the rename can still leave it;
 * that residue is the known cost of atomic replacement, and it sits in the
 * same directory, inheriting the same ACL as the file it is replacing.
 */
function writeAccountGates(
  account: Exclude<RuntimeAccount, "GENERIC">,
  mode: RuntimeMode
): { ok: true } | { ok: false; reason: string } {
  const { control } = rolesForAccount(account);
  const file = envFilePathFor(control);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: "the account's environment file could not be read" };
  }

  const rewritten = applyGates(text, mode === "SAFE" ? SAFE_GATES : LIVE_READY_GATES);
  if (!rewritten.ok) return { ok: false, reason: rewritten.reason };

  const temporary = `${file}.tmp`;
  try {
    writeFileSync(temporary, rewritten.text, "utf8");
    renameSync(temporary, file);
    return { ok: true };
  } catch {
    // Leave no credential-bearing copy behind. Best-effort: if this fails too,
    // the original file is still intact and the operator is told nothing was
    // replaced, which is the fact that matters.
    try {
      unlinkSync(temporary);
    } catch {
      // Already gone, or never created.
    }
    // No path, no contents: this message reaches a terminal scrollback.
    return { ok: false, reason: "the account's environment file could not be replaced" };
  }
}

/** What the account's env FILE declares, or null when it cannot be read. */
function diskModeFor(account: Exclude<RuntimeAccount, "GENERIC">): ObservedMode | null {
  const { control } = rolesForAccount(account);
  const parsed = parseEnvFileStrict(envFilePathFor(control));
  if (!parsed.ok) return null;
  // `classifyDiskMode` never normalises: a half-open triple stays INVALID.
  return classifyDiskMode(declaredGateValues(control));
}

/**
 * Proves ONE role reached the target mode, by asking the control plane.
 *
 * The control plane answers for the gates IT loaded, so this is a statement
 * about the running process rather than about the file that was written. The
 * worker is proven through the same report's ATTESTATION, which the control
 * plane judges against its own gate snapshot -- which is exactly why both
 * roles have to move together.
 */
async function verifyRoleMode(
  account: Exclude<RuntimeAccount, "GENERIC">,
  role: DualRole,
  mode: RuntimeMode
): Promise<{ ok: true } | { ok: false; reasons: string[] }> {
  const { worker } = rolesForAccount(account);
  const deadline = Date.now() + 90_000;
  let last = "the control plane did not answer";

  for (;;) {
    const controlStatus = await readControlPlane<unknown>(account, "/api/operator/trading-control/status");
    // The worker leg is proven by the DEPLOYMENT attestation for the target
    // mode -- never by the control plane's arming verdict, which a correctly
    // deployed SAFE runtime can never satisfy.
    const deployment = role === worker && controlStatus !== null ? await readDeploymentForMode(account, mode) : null;
    const verdict = judgeRoleMode(account, role, mode, { controlStatus, deployment });
    if (verdict.ok) return { ok: true };
    last = verdict.reason;
    if (Date.now() >= deadline) return { ok: false, reasons: [`${last}.`] };
    await new Promise((done) => setTimeout(done, 3_000));
  }
}

/**
 * The account's DEPLOYMENT attestation, judged against `mode`'s exact gates.
 *
 * Read directly from the attestation store under the account's own identity,
 * the same way the topology view reads it. Null -- which refuses -- whenever
 * the identity is not configured or the store cannot be read. The identifier
 * is used to build the scan pattern and is never logged.
 */
async function readDeploymentForMode(
  account: Exclude<RuntimeAccount, "GENERIC">,
  mode: RuntimeMode
): Promise<AttestationStatusView | null> {
  const controlRole: DualRole = account === "ACCOUNT_A" ? "account-a-control" : "account-b-control";
  const accountIdentifier = envValue(controlRole, "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER");
  const environment = envValue(controlRole, "EXECUTION_PROFILE_ENVIRONMENT");
  if (accountIdentifier === null || environment === null) return null;
  try {
    const { readRuntimeDeploymentAttestationStatusOnce } = await import("../runtime/runtime-attestation");
    return await readRuntimeDeploymentAttestationStatusOnce({
      identity: { accountIdentifier, environment },
      expected: expectedGateSnapshotFor(mode),
    });
  } catch {
    // Message deliberately dropped: it can carry an endpoint.
    return null;
  }
}

/**
 * The machine adapters the transition sequence runs on.
 *
 * `fromMode` and `startedAtMs` are passed in rather than derived, because the
 * marker this writes is what recovery reads: a guessed direction here becomes
 * a recovery that skips the gate rewrite it needed.
 */
function transitionAdapters(
  account: Exclude<RuntimeAccount, "GENERIC">,
  run: { readonly fromMode: RuntimeMode; readonly targetMode: RuntimeMode; readonly startedAtMs: number }
) {
  const { fromMode, targetMode, startedAtMs } = run;
  return {
    repoRoot: REPO_ROOT,
    /**
     * A FRESH ownership check of one role, from the machine.
     *
     * Deliberately not `selectedRoleOwnership`, which answers for both roles
     * at once: this is asked per role, at the end, about the record as it
     * stands after everything the sequence did to it.
     */
    proveOwned: (role: DualRole): Observation<boolean> => {
      const state = readState();
      const record = state?.processes.find((entry) => entry.role === role) ?? null;
      if (!record || !state) return observed(false);
      const probed = probeProcesses([record.pid]);
      if (!probed.ok) return probed;
      return observed(verifyOwnership(record, probed.value.get(record.pid) ?? null, state.repoRoot).owned);
    },
    recordFor: (role: DualRole) => readState()?.processes.find((entry) => entry.role === role) ?? null,
    stop: {
      probe: (pid: number) => {
        const probed = probeProcesses([pid]);
        return probed.ok ? { observed: true as const, process: probed.value.get(pid) ?? null } : { observed: false as const };
      },
      terminate: (pid: number) => {
        terminateTree(pid);
        return true;
      },
      log: (line: string) => console.log(`  ${line}`),
    },
    startFor: (role: DualRole) => ({
      probe: (pid: number) => {
        const probed = probeProcesses([pid]);
        return probed.ok ? { observed: true as const, process: probed.value.get(pid) ?? null } : { observed: false as const };
      },
      unaccountedLeaves: () => unaccountedLeavesFor(role, role),
      spawnWorker: () => {
        // The SAME reviewed spawn plan every start of that role uses, so the
        // role keeps its own DOTENV_CONFIG_PATH. No operator input reaches it.
        return spawnRoleWithDurableLog(role, dualSpawnPlan(role, REPO_ROOT));
      },
      recordOwnership: (pid: number, startedAt: number) => recordReplacement(role, pid, startedAt),
      log: (line: string) => console.log(`  ${line}`),
    }),
    journal: (phase: TransitionPhase) => {
      writeTransitionMarker({
        account,
        // PROVEN before this run began, never inferred from the target.
        fromMode,
        targetMode,
        phase,
        startedAtMs,
        updatedAtMs: Date.now(),
      });
    },
    clearJournal: () => writeTransitionMarker(null),
    writeGates: (mode: RuntimeMode) => writeAccountGates(account, mode),
    verify: (role: DualRole, mode: RuntimeMode) => verifyRoleMode(account, role, mode),
    log: (line: string) => console.log(`  ${line}`),
  };
}

/**
 * Asks which account, and accepts nothing else.
 *
 * Two answers and a cancel. There is deliberately no option that selects more
 * than one account: a single action that moved two accounts would restart four
 * processes on one confirmation, and the whole design of this transition is
 * that one account's exposure is proven before one account's runtime moves.
 */
async function askAccount(
  ask: (question: string) => Promise<string>,
  verb: string
): Promise<Exclude<RuntimeAccount, "GENERIC"> | null> {
  console.log("");
  console.log(`Which account should be ${verb}? One account only.`);
  const answer = (await ask("  a = Account A, b = Account B, anything else cancels: ")).trim().toLowerCase();
  if (answer === "a") return "ACCOUNT_A";
  if (answer === "b") return "ACCOUNT_B";
  console.log("Cancelled. Nothing was changed.");
  return null;
}

/**
 * Moves ONE account between SAFE and LIVE-READY.
 *
 * Preconditions first, and every one of them is about the SELECTED account:
 * its own control plane's report, its own signed exchange reads, and launcher
 * ownership of its own two roles. The other account and the two generic roles
 * are never read, never stopped and never started.
 */
/**
 * Gathers EVERY fact the decision depends on, in one pass.
 *
 * One function, called twice: once to decide what to propose, and once after
 * the operator has confirmed. Both readings therefore have identical shape and
 * identical strictness, so the comparison between them is meaningful.
 */
async function gatherAccountFacts(
  account: Exclude<RuntimeAccount, "GENERIC">
): Promise<GatheredAccountFacts> {
  const [report, exchange] = await Promise.all([
    readSelectedAccount(account),
    readAccountFlatness(account),
  ]);
  return {
    mode: proveCurrentMode({ disk: diskModeFor(account), effective: report.effectiveMode }),
    selected: report.selected,
    exchange,
    ownership: selectedRoleOwnership(account),
    marker: readTransitionMarker(),
  };
}

const printBlocked = (reasons: readonly string[]): void => {
  console.log("");
  console.log("BLOCKED — nothing was changed:");
  for (const reason of reasons) console.log(`  - ${reason}`);
};

/**
 * Moves ONE account between SAFE and LIVE-READY.
 *
 * Preconditions first, and every one of them is about the SELECTED account:
 * its own control plane's report, its own signed exchange reads, its own
 * configured and loaded gates, and launcher ownership of its own two roles.
 * The other account and the two generic roles are never read, never stopped
 * and never started.
 *
 * ## Proven twice, side by side
 *
 * The facts are gathered, shown, and then a human types an account name. That
 * gap is human-sized and the facts are perishable -- a position opened by
 * hand, an algo order triggering, a profile enabled from the dashboard, a
 * second launcher window starting its own transition. So everything is
 * gathered AGAIN after the confirmation and must pass on its own AND still
 * describe the same runtime. Only then is the first process touched.
 */
async function transitionAccount(
  targetMode: RuntimeMode,
  ask: (question: string) => Promise<string>
): Promise<void> {
  const account = await askAccount(ask, targetMode === "SAFE" ? "returned to SAFE" : "prepared LIVE-READY");
  if (!account) return;

  // Machine-wide authority FIRST, and held across the confirmation. Without
  // that, a second launcher could take its own decision and act on it during
  // the seconds or minutes an operator spends deciding -- and two transitions
  // aimed at opposite modes would interleave a gate rewrite with a restart.
  const held = await withMutationLock(
    targetMode === "SAFE" ? "RETURN_TO_SAFE" : "PREPARE_LIVE_READY",
    lockAdapters(),
    () => runAccountTransition(account, targetMode, ask)
  );
  if (!held.ran) reportLockRefusal(held.outcome, held.reasons);
}

async function runAccountTransition(
  account: Exclude<RuntimeAccount, "GENERIC">,
  targetMode: RuntimeMode,
  ask: (question: string) => Promise<string>
): Promise<void> {
  const { control, worker } = rolesForAccount(account);
  if (!transitionGateAllows([control, worker])) return;

  console.log("");
  console.log(`Checking ${account} before changing anything…`);
  const first = await gatherAccountFacts(account);

  // The mode this account is ACTUALLY in, from its file and its running
  // control plane. Never inferred from what was asked for.
  if (!first.mode.ok) {
    printBlocked([
      ...first.mode.reasons,
      "An account whose current mode is not proven cannot be moved; return it to SAFE first.",
    ]);
    return;
  }
  const decision = decideModeTransition(first.mode.mode, targetMode);
  if (decision.kind === "ALREADY") {
    console.log("");
    console.log(`${account} is already ${decision.mode}. Nothing to do, and nothing was changed.`);
    return;
  }

  const verdict = evaluateTransitionPreconditions({
    account,
    targetMode,
    selected: first.selected,
    exchange: first.exchange,
    ownership: first.ownership,
    pending: first.marker.status === "PENDING" ? first.marker.transition : null,
  });
  if (!verdict.ok) {
    printBlocked(verdict.reasons);
    return;
  }

  console.log("");
  console.log(`${account} is ${decision.fromMode} and will be moved to ${targetMode}.`);
  console.log("Its two roles are stopped, its three gates are rewritten, and its two roles are restarted.");
  console.log("This arms NOTHING: no profile is enabled, no kill switch is released, no window is created.");
  console.log("The other account and the two generic roles are not touched.");
  const confirmation = (await ask(`Type ${account} to proceed: `)).trim();
  if (confirmation !== account) {
    console.log("Cancelled. Nothing was changed.");
    return;
  }

  // EVERYTHING again, now, before the first kill.
  console.log("");
  console.log("Re-proving before touching anything…");
  const second = await gatherAccountFacts(account);
  const settled = evaluateSecondProof({ account, targetMode, first, second });
  if (!settled.ok) {
    printBlocked([
      ...settled.reasons,
      "These facts changed while the confirmation was open, so nothing was stopped, written or started.",
    ]);
    return;
  }

  const result = await executeAccountTransition(
    { account, fromMode: decision.fromMode, targetMode, startedAtMs: Date.now() },
    transitionAdapters(account, { fromMode: decision.fromMode, targetMode, startedAtMs: Date.now() })
  );
  console.log("");
  if (result.ok) {
    console.log(`${account} is now ${result.mode}. Trading remains OFF until it is armed separately.`);
    return;
  }
  for (const reason of result.reasons) console.log(`  - ${reason}`);
  if (result.state === "REFUSED") console.log(`REFUSED at ${result.phase} — nothing was changed.`);
  else if (result.state === "RECOVERED") console.log(`ROLLED BACK — ${account} was returned to SAFE and proven.`);
  else {
    console.log(`INCOMPLETE at ${result.phase} — ${account} could NOT be proven SAFE.`);
    console.log("The transition marker was KEPT. Use 'Recover an INCOMPLETE transition'.");
  }
}

/**
 * Finishes an interrupted transition, in the only safe direction: SAFE.
 *
 * It never resumes towards LIVE-READY. A transition nobody watched finish is
 * not a transition anybody should continue, and the operator can simply run
 * Prepare again once the account is proven SAFE.
 *
 * The existing marker is handed to the recovery engine AS IT STANDS. It is not
 * replaced by a fresh one: its phase and its proven `fromMode` are the only
 * record of how far the interrupted run got and which gates the file may still
 * hold, and a recovery that overwrote them would be planning from its own
 * assumptions instead of from the evidence.
 */
async function recoverIncompleteTransition(ask: (question: string) => Promise<string>): Promise<void> {
  // Taken before the marker is even read, so the record an operator is shown
  // is the record that is still there when they confirm.
  const held = await withMutationLock("RECOVER_TRANSITION", lockAdapters(), () => runRecoveryAction(ask));
  if (!held.ran) reportLockRefusal(held.outcome, held.reasons);
}

async function runRecoveryAction(ask: (question: string) => Promise<string>): Promise<void> {
  const marker = readTransitionMarker();
  console.log("");
  if (marker.status === "NONE") {
    console.log("There is no incomplete transition recorded. Nothing was changed.");
    return;
  }
  if (marker.status === "UNREADABLE") {
    console.log(`The transition marker is present but unreadable — ${marker.reason}.`);
    console.log("It does not say which account it was about, so no account can be recovered automatically.");
    console.log("Stop the runtime, confirm both accounts' gates by hand, and clear the launcher state.");
    return;
  }

  const pending = marker.transition;
  const { account } = pending;
  console.log("INCOMPLETE TRANSITION");
  for (const line of describePendingTransition(pending, Date.now())) console.log(`  ${line}`);
  console.log("");
  console.log(`${account} will be returned to SAFE: its gates rewritten if needed, and its roles restarted.`);
  console.log("The marker is cleared ONLY if SAFE is proven afterwards.");
  const confirmation = (await ask(`Type ${account} to recover: `)).trim();
  if (confirmation !== account) {
    console.log("Cancelled. Nothing was changed.");
    return;
  }

  const result = await executeTransitionRecovery(
    pending,
    transitionAdapters(account, {
      fromMode: pending.fromMode,
      targetMode: pending.targetMode,
      startedAtMs: pending.startedAtMs,
    })
  );
  console.log("");
  if (result.ok === false && result.state === "RECOVERED") {
    console.log(`${account} is SAFE again and the transition marker was cleared.`);
    return;
  }
  if (result.ok === false) {
    for (const reason of result.reasons) console.log(`  - ${reason}`);
    console.log(`RECOVERY DID NOT FINISH (${result.state} at ${result.phase}). The marker was KEPT.`);
  }
}

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
      console.log(nativePlanner().statusLine(status));

      console.log("");
      console.log("1. Show Status");
      console.log("2. Start SAFE (six-role dual-account topology)");
      console.log("3. Prepare ONE account LIVE-READY");
      console.log("4. Stop Runtime (requires SAFE)");
      console.log("5. Supervise Account A Worker");
      console.log("6. Supervise Account B Worker");
      console.log("7. Supervise Generic Analysis");
      console.log("8. Exit");
      console.log("9. Return ONE account to SAFE");
      console.log("10. Recover an INCOMPLETE transition");
      console.log("11. Start Native Planner (optional, generic, planning only)");
      console.log("12. Supervise Native Planner");
      console.log("13. Stop Native Planner");
      console.log("");

      const choice = (await ask("Choose: ")).trim();
      if (choice === "8") break;
      try {
        if (choice === "1") continue;
        else if (choice === "2") await underMutationLock("START_SAFE", startSafe);
        else if (choice === "3") await transitionAccount("LIVE_READY", ask);
        else if (choice === "4") await underMutationLock("STOP_RUNTIME", stopRuntime);
        else if (choice === "5") await superviseAccountWorker("ACCOUNT_A", ask);
        else if (choice === "6") await superviseAccountWorker("ACCOUNT_B", ask);
        else if (choice === "7") await superviseGenericAnalysis(ask);
        else if (choice === "9") await transitionAccount("SAFE", ask);
        else if (choice === "10") await recoverIncompleteTransition(ask);
        else if (choice === "11") await nativePlanner().start();
        else if (choice === "12") await nativePlanner().supervise(ask);
        else if (choice === "13") await nativePlanner().stop();
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
