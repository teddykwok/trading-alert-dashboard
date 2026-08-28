import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import {
  BACKEND_PORT,
  FRONTEND_PORT,
  FileStateStore,
  LAUNCHER_ROLES,
  LIVE_READY_CONFIRMATION,
  applyGates,
  classifyDiskMode,
  defaultStatePath,
  evaluateDurableSafety,
  evaluateStartPreconditions,
  gatesFor,
  isLiveReadyConfirmed,
  operatorTokenState,
  presentStatus,
  readGates,
  renderStatus,
  cleanupAfterModeMismatch,
  expectedGateSnapshotFor,
  verifyOwnership,
  verifyRuntimeMode,
  windowsSpawnPlan,
  type DiskMode,
  type LauncherRole,
  type OwnedProcess,
  type AttestationRoleView,
  type AttestationStatusView,
  type DurableTradingState,
  judgeRoleHealth,
  type ProcessProbe,
  type RoleHealth,
  type RuntimeState,
} from "./runtime-launcher";
import {
  EMPTY_RESTART_BUDGET,
  WORKER_RESTART_STABILIZATION_MS,
  WORKER_SUPERVISION_INTERVAL_MS,
  decideWorkerSupervision,
  executeWorkerRestart,
  observeWorkerHealth,
  recordRestartAttempt,
  renderSupervisionState,
  runSupervisionSingleFlight,
  withReplacedWorker,
  type RestartBudget,
  type SupervisionDecision,
} from "./worker-supervision";

/**
 * The local Windows runtime launcher — CLI and adapters.
 *
 *   pnpm --filter @trading-alert-dashboard/backend runtime:launcher
 *
 * or double-click `Trading Runtime Launcher.cmd` at the repository root.
 *
 * This file holds only the parts that must touch the machine: reading the real
 * `.env`, probing PIDs, spawning and terminating the repo's own dev processes.
 * Every decision it makes comes from `runtime-launcher.ts`, which is pure and
 * tested.
 *
 * It is a DEPLOYMENT tool. It cannot arm, cannot create an authorization
 * window, cannot reach Binance and never touches the execution profile. Even
 * LIVE-READY only loads the process prerequisites; the durable ARM stays in the
 * authenticated Trading Control page where it is confirmed and audited.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const BACKEND_DIR = path.join(REPO_ROOT, "apps", "backend");
const ENV_PATH = path.join(BACKEND_DIR, ".env");
const store = new FileStateStore(defaultStatePath());

// ---------------------------------------------------------------------------
// Machine adapters
// ---------------------------------------------------------------------------

function readEnvText(): string {
  return readFileSync(ENV_PATH, "utf8");
}

/** Atomic replace, so a failed write can never leave a truncated `.env`. */
function writeEnvText(text: string): void {
  const temporary = `${ENV_PATH}.tmp`;
  writeFileSync(temporary, text, "utf8");
  renameSync(temporary, ENV_PATH);
}

/** One PowerShell round-trip for every recorded PID. */
function probeProcesses(pids: number[]): Map<number, ProcessProbe> {
  const found = new Map<number, ProcessProbe>();
  if (pids.length === 0) return found;
  const script =
    `Get-CimInstance Win32_Process -Filter "${pids.map((pid) => `ProcessId=${pid}`).join(" OR ")}" | ` +
    `ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), ($_.CommandLine -replace '\\|',' ') }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const [pid, startedAtMs, commandLine] = line.trim().split("|");
    if (!pid || !startedAtMs) continue;
    found.set(Number(pid), {
      pid: Number(pid),
      startedAtMs: Number(startedAtMs),
      commandLine: commandLine ?? "",
    });
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

/**
 * Starts one role. The command shape lives in `windowsSpawnPlan`, which is pure
 * and tested; this only performs the spawn.
 */
function spawnRole(role: LauncherRole, mode: "SAFE" | "LIVE_READY"): ChildProcess {
  const plan = windowsSpawnPlan(role, REPO_ROOT, mode);
  return spawn(plan.command, plan.args, plan.options);
}

/**
 * Reads the runtime attestation both roles publish, with a bounded wait.
 *
 * Heartbeats are periodic, so the first read after startup can legitimately
 * find nothing. This waits a bounded number of cycles and then gives up: it
 * never retries forever, and a timeout is a refusal, not a shrug.
 */
async function readRuntimeModeAttestation(
  mode: "SAFE" | "LIVE_READY"
): Promise<AttestationStatusView | null> {
  // DEPLOYMENT reader, not the arming interlock: this asks whether the
  // processes loaded the mode that was just requested. SAFE is a valid answer,
  // and the arming reader refuses SAFE by design.
  const { configuredRuntimeIdentity, readRuntimeDeploymentAttestationStatusOnce } = await import(
    "../runtime/runtime-attestation"
  );
  const expected = expectedGateSnapshotFor(mode);
  // Heartbeat is 5s and the TTL is 15s, so ~30s covers a slow cold start
  // without turning a failure into an indefinite wait.
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      const status = await readRuntimeDeploymentAttestationStatusOnce({
        identity: configuredRuntimeIdentity(),
        expected,
      });
      if (verifyRuntimeMode(status, mode).ok) return status;
      // Keep the LAST reading so the refusal can name what was actually seen.
      if (attempt === 14) return status;
    } catch {
      // Message deliberately dropped: it can carry a Redis endpoint.
      if (attempt === 14) return null;
    }
    await sleep(2000);
  }
  return null;
}

/**
 * ONE attestation reading for the status screen.
 *
 * Single shot, unlike the post-start verification loop: the status menu is
 * asking what is true now, not waiting for something to become true. The
 * reader owns a short-lived client with a bounded connect timeout and always
 * disconnects, so an unreachable Redis costs seconds and reports UNKNOWN
 * rather than blocking the menu.
 *
 * `expected` only affects the overall verdict, which this caller ignores; the
 * per-role fresh counts it reads are reported regardless of gate agreement.
 */
async function readAttestationRoles(
  diskMode: DiskMode
): Promise<{ backend: AttestationRoleView; worker: AttestationRoleView } | null> {
  try {
    const { configuredRuntimeIdentity, readRuntimeDeploymentAttestationStatusOnce } = await import(
      "../runtime/runtime-attestation"
    );
    const status = await readRuntimeDeploymentAttestationStatusOnce({
      identity: configuredRuntimeIdentity(),
      expected: expectedGateSnapshotFor(diskMode === "LIVE_READY" ? "LIVE_READY" : "SAFE"),
    });
    // A Redis we could not read reports zero fresh instances for every role,
    // which is indistinguishable from a silent runtime by count alone. Saying
    // UNKNOWN points at the actual fault instead of blaming the processes.
    if (status.reasonCode === "RUNTIME_ATTESTATION_UNAVAILABLE") return null;
    return { backend: status.backend, worker: status.worker };
  } catch {
    // Message deliberately dropped: it can carry a Redis endpoint.
    return null;
  }
}

/** taskkill /T on ONE verified repo-owned root. Never a name-based sweep. */
function terminateTree(pid: number): boolean {
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
  return result.status === 0;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function liveProcesses(state: RuntimeState | null): { alive: OwnedProcess[]; disowned: string[] } {
  if (!state) return { alive: [], disowned: [] };
  const probes = probeProcesses(state.processes.map((entry) => entry.pid));
  const alive: OwnedProcess[] = [];
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

async function currentStatus(): Promise<{ lines: string[]; diskMode: DiskMode; aliveCount: number }> {
  const envText = readEnvText();
  const gates = readGates(envText);
  const diskMode: DiskMode = gates.ok ? classifyDiskMode(gates.values) : "INVALID";
  const state = store.read();
  const { alive, disowned } = liveProcesses(state);
  const running = Object.fromEntries(
    LAUNCHER_ROLES.map((role) => [role, alive.some((entry) => entry.role === role)])
  ) as Record<LauncherRole, boolean>;

  const [backendPortOpen, frontendPortOpen, attestationRoles] = await Promise.all([
    portOpen(BACKEND_PORT),
    portOpen(FRONTEND_PORT),
    // Only worth asking when we believe something of ours is running; with
    // nothing owned, OFF is already the whole answer.
    alive.length > 0 ? readAttestationRoles(diskMode) : Promise.resolve(null),
  ]);

  const view = presentStatus({
    diskMode,
    running,
    backendPortOpen,
    frontendPortOpen,
    operatorToken: operatorTokenState(envText),
    attestationRoles,
  });

  const lines = renderStatus(view);
  if (!gates.ok) lines.push("", `  Gate file problem: ${gates.reason}`);
  for (const note of disowned) lines.push("", `  ${note}`);
  return { lines, diskMode, aliveCount: alive.length };
}

/**
 * ONE supervision observation: ownership plus health, for both roles.
 *
 * Reuses `liveProcesses`, `readAttestationRoles` and `judgeRoleHealth` exactly
 * as the status screen does, so supervision can never disagree with what the
 * operator is being shown.
 */
async function observeRuntimeForSupervision(): Promise<{
  state: RuntimeState | null;
  workerRecord: OwnedProcess | null;
  workerHealth: RoleHealth;
  backendHealth: RoleHealth;
}> {
  const state = store.read();
  const { alive } = liveProcesses(state);
  const running = (role: LauncherRole) => alive.some((entry) => entry.role === role);

  const envText = readEnvText();
  const gates = readGates(envText);
  const diskMode: DiskMode = gates.ok ? classifyDiskMode(gates.values) : "INVALID";
  const roles = alive.length > 0 ? await readAttestationRoles(diskMode) : null;

  return {
    state,
    workerRecord: state?.processes.find((entry) => entry.role === "worker") ?? null,
    workerHealth: judgeRoleHealth(running("worker"), roles?.worker ?? null),
    backendHealth: judgeRoleHealth(running("backend"), roles?.backend ?? null),
  };
}

/**
 * ONE supervision pass: observe, decide, and act only if the decision says so.
 *
 * Held under the single-flight guard so two overlapping passes cannot each
 * conclude "no worker" and each start one.
 *
 * The launcher deliberately spawns the replacement with the mode already
 * RECORDED in runtime state. Restarting a worker is infrastructure recovery,
 * not an operator decision to trade: no gate is written, no `.env` byte moves,
 * and a SAFE runtime comes back SAFE.
 */
async function superviseWorkerOnce(budget: RestartBudget): Promise<{
  budget: RestartBudget;
  decision: SupervisionDecision;
}> {
  const observed = await observeRuntimeForSupervision();
  const nowMs = Date.now();
  const observedBudget = observeWorkerHealth(budget, observed.workerHealth, nowMs);

  const decision = decideWorkerSupervision({
    record: observed.workerRecord,
    ownership: observed.workerRecord
      ? verifyOwnership(
          observed.workerRecord,
          probeProcesses([observed.workerRecord.pid]).get(observed.workerRecord.pid) ?? null,
          observed.state?.repoRoot ?? REPO_ROOT
        )
      : null,
    workerHealth: observed.workerHealth,
    backendHealth: observed.backendHealth,
    budget: observedBudget,
    nowMs,
    hasRuntimeState: observed.state !== null,
  });

  if (decision.action === "NONE" || !observed.state) {
    return { budget: observedBudget, decision };
  }

  const state = observed.state;
  const attemptNumber = observedBudget.attempts + 1;
  const result = executeWorkerRestart(decision, state, attemptNumber, {
    probe: (pid) => probeProcesses([pid]).get(pid) ?? null,
    terminate: (pid) => terminateTree(pid),
    spawnWorker: () => {
      // The RECORDED mode, never a fresh choice. `windowsSpawnPlan` pins the
      // three gates into the child environment, so this reproduces exactly the
      // posture the stack was started in.
      const child = spawnRole("worker", state.mode);
      if (typeof child.pid !== "number") return null;
      child.unref();
      return child.pid;
    },
    log: (line) => console.log(`  ${line}`),
  });

  // Only the worker record is replaced; the backend and frontend records are
  // left exactly as they were, so the launcher can still stop them.
  if (result.outcome === "RESTARTED" && result.record) {
    store.write(withReplacedWorker(state, result.record));
  }

  return { budget: recordRestartAttempt(observedBudget, nowMs), decision };
}

/**
 * The supervision loop.
 *
 * ## Scope, stated plainly
 *
 * This supervises the worker for as long as the launcher is running it. It is
 * NOT a Windows service and it does not survive this console closing. That is
 * a deliberate limit: the launcher is what owns the process records, and a new
 * always-on daemon is a bigger change than this fix is allowed to make.
 *
 * The loop is interruptible with Ctrl+C and reports every tick, so an operator
 * can watch a recovery happen rather than trusting that one did.
 */
async function superviseWorker(ask: (question: string) => Promise<string>): Promise<void> {
  console.log("");
  console.log("Worker supervision watches the WORKER role only.");
  console.log("It never changes a deployment gate, never arms, and never touches an");
  console.log("authorization window. A SAFE runtime stays SAFE.");
  console.log("");
  console.log("It runs only while this launcher is open. Press Ctrl+C to stop it.");
  console.log("");
  const answer = (await ask("Start supervising the worker? (y/N) ")).trim().toLowerCase();
  if (answer !== "y") {
    console.log("Nothing was changed.");
    return;
  }

  let budget = EMPTY_RESTART_BUDGET;
  for (;;) {
    const pass = await runSupervisionSingleFlight(() => superviseWorkerOnce(budget));
    if (pass.ran) {
      budget = pass.result.budget;
      const stamp = new Date().toISOString().slice(11, 19);
      for (const line of renderSupervisionState(pass.result.decision, budget)) {
        console.log(`[${stamp}] ${line}`);
      }
      if (pass.result.decision.state === "WORKER_RECOVERY_FAILED") {
        console.log("");
        console.log("Automatic worker recovery has STOPPED. Nothing further will be restarted.");
        console.log("Investigate the worker before starting anything else, and do NOT start a");
        console.log("second stack while this runtime is still owned.");
        return;
      }
    }
    await sleep(WORKER_SUPERVISION_INTERVAL_MS);
  }
}

/**
 * The DURABLE trading state, through the SAME read-only service the dashboard
 * uses. No second definition of "is anything still running", no readiness
 * engine and no Binance call: this is the cheap DB/Redis status path.
 *
 * Every field falls to null on any failure, and null refuses.
 */
async function readDurableState(): Promise<DurableTradingState> {
  const unknown: DurableTradingState = {
    systemState: null,
    activeExecutions: null,
    manualIntervention: null,
    authorizationState: null,
    warnings: null,
  };
  try {
    const { PrismaClient } = await import("@prisma/client");
    const { TradingControlService } = await import("./trading-control.service");
    const prisma = new PrismaClient();
    try {
      const status = await new TradingControlService(prisma).readStatus();
      return {
        systemState: status.systemState,
        activeExecutions: status.capacity.totalActive,
        manualIntervention: status.manualIntervention.count,
        authorizationState: status.authorization?.state ?? null,
        warnings: status.warnings.map((warning) => warning.code),
      };
    } finally {
      await prisma.$disconnect();
    }
  } catch {
    // Message deliberately dropped: it can carry a connection string.
    return unknown;
  }
}

/** Prints the refusal both flows share, so the wording cannot drift. */
function reportDurableRefusal(reason: string, what: string): void {
  console.log("");
  console.log(`BLOCKED — ${reason}`);
  console.log(`${what} This tool is a deployment launcher; it never disarms, revokes or closes anything.`);
}

async function waitForPorts(): Promise<{ backend: boolean; frontend: boolean }> {
  // Dev servers take a few seconds; give them a bounded window rather than
  // declaring failure immediately or waiting forever.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const [backend, frontend] = await Promise.all([portOpen(BACKEND_PORT), portOpen(FRONTEND_PORT)]);
    if (backend && frontend) return { backend, frontend };
    await sleep(1000);
  }
  const [backend, frontend] = await Promise.all([portOpen(BACKEND_PORT), portOpen(FRONTEND_PORT)]);
  return { backend, frontend };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function startRuntime(mode: "SAFE" | "LIVE_READY"): Promise<void> {
  const state = store.read();
  const { alive } = liveProcesses(state);
  const [backendPortOpen, frontendPortOpen] = await Promise.all([
    portOpen(BACKEND_PORT),
    portOpen(FRONTEND_PORT),
  ]);
  const precondition = evaluateStartPreconditions({
    recordedProcessesAlive: alive.length,
    backendPortOpen,
    frontendPortOpen,
  });
  if (!precondition.ok) {
    console.log(`BLOCKED — ${precondition.reason}`);
    return;
  }

  // --- Write the gates BEFORE spawning, so the new processes load them ------
  const envText = readEnvText();
  const rewritten = applyGates(envText, gatesFor(mode));
  if (!rewritten.ok) {
    console.log(`BLOCKED — the deployment gates could not be rewritten: ${rewritten.reason}`);
    console.log("Nothing was started and .env was not modified.");
    return;
  }
  writeEnvText(rewritten.text);
  console.log(`Deployment gates written: ${mode}`);

  const started: OwnedProcess[] = [];
  for (const role of LAUNCHER_ROLES) {
    const child = spawnRole(role, mode);
    if (typeof child.pid !== "number") {
      console.log(`FAILED — ${role} could not be started.`);
      break;
    }
    child.unref();
    // Read the OS's own creation time so the ownership check compares like
    // with like when this PID is verified later.
    const probe = probeProcesses([child.pid]).get(child.pid);
    started.push({ role, pid: child.pid, startedAtMs: probe?.startedAtMs ?? Date.now() });
  }

  store.write({
    repoRoot: REPO_ROOT,
    mode,
    startedAtMs: Date.now(),
    processes: started,
  });

  if (started.length !== LAUNCHER_ROLES.length) {
    console.log("");
    console.log("PARTIAL START — not every process launched.");
    console.log("Run 'Stop Runtime & Return SAFE' to clean up before trying again.");
    return;
  }

  console.log("Waiting for the expected ports…");
  const ports = await waitForPorts();
  console.log("");
  for (const line of (await currentStatus()).lines) console.log(line);

  if (!ports.backend || !ports.frontend) {
    console.log("");
    console.log("WARNING — an expected port did not open. The stack may be starting slowly, or it failed.");
    console.log("Check the spawned windows, then use 'Stop Runtime & Return SAFE' if needed.");
    return;
  }

  // --- The running processes must ATTEST the requested mode ---------------
  // Open ports and a rewritten file prove only that this tool did its part.
  // Nothing may be reported as active before the runtime itself agrees.
  console.log("");
  console.log("Verifying the running runtime attested the requested mode…");
  const verification = verifyRuntimeMode(await readRuntimeModeAttestation(mode), mode);
  if (!verification.ok) {
    console.log("");
    console.log(`BLOCKED — runtime did not attest the requested deployment mode: ${verification.reason}`);
    // A mismatch means the running configuration is not the one that was asked
    // for, and it may be the MORE permissive one. Refusing to print success is
    // not enough: the untrusted runtime is taken back down here.
    console.log("Shutting the unverified runtime back down…");
    const cleanup = cleanupAfterModeMismatch(store.read() ?? { repoRoot: REPO_ROOT, mode, startedAtMs: Date.now(), processes: started }, {
      probe: (pid) => probeProcesses([pid]).get(pid) ?? null,
      terminate: (pid) => terminateTree(pid),
      restoreSafeGates: () => {
        const restored = applyGates(readEnvText(), gatesFor("SAFE"));
        if (!restored.ok) return false;
        writeEnvText(restored.text);
        return true;
      },
      clearState: () => store.clear(),
      log: (line) => console.log(line),
    });

    console.log("");
    console.log(cleanup.safeGatesRestored ? "Deployment gates restored: SAFE" : "WARNING — the deployment gates could NOT be restored to SAFE.");
    if (cleanup.unresolved.length > 0) {
      console.log("");
      console.log("OPERATOR RECOVERY REQUIRED — these roots are not provably stopped:");
      for (const entry of cleanup.unresolved) console.log(`  ${entry.role} pid ${entry.pid}: ${entry.outcome}`);
      console.log("Launcher ownership state was KEPT so 'Stop Runtime & Return SAFE' can still find them.");
    } else {
      console.log("The unverified runtime was stopped and launcher state was cleared.");
    }
    console.log("Nothing was armed and no durable trading state was changed.");
    return;
  }
  console.log(`Runtime attested ${mode}.`);

  if (mode === "LIVE_READY") {
    console.log("");
    console.log("The runtime is LIVE-READY. NOTHING IS ARMED and no order was placed.");
    console.log("Open Trading Control, press 'Check Readiness', then arm there if you intend to trade.");
  }
}

async function startLiveReady(ask: (question: string) => Promise<string>): Promise<void> {
  console.log("");
  console.log("LIVE-READY DOES NOT START A TRADE.");
  console.log("");
  console.log("It only loads the runtime prerequisites that allow the authenticated");
  console.log("Trading Control page to ARM later. This tool never creates an authorization");
  console.log("window, never arms, never sends a webhook and never calls Binance.");
  console.log("");

  // The durable state is checked BEFORE the confirmation prompt, and therefore
  // long before any gate is written or any process is spawned. A profile still
  // ARMED, or holding an AVAILABLE window, would become executable again the
  // moment a live-ready worker started - with no fresh Start Trading action.
  console.log("Reading the durable Trading Control state...");
  const verdict = evaluateDurableSafety(await readDurableState(), "LIVE_READY");
  if (!verdict.safe) {
    reportDurableRefusal(verdict.reason, "No deployment gate was changed and nothing was started.");
    return;
  }
  console.log("Durable state: SAFE OFF and clean.");
  console.log("");

  const typed = await ask(`Type ${LIVE_READY_CONFIRMATION} to continue: `);
  if (!isLiveReadyConfirmed(typed)) {
    console.log("Cancelled. Nothing was changed.");
    return;
  }
  await startRuntime("LIVE_READY");
}

async function stopRuntime(): Promise<void> {
  const state = store.read();
  const { alive, disowned } = liveProcesses(state);
  for (const note of disowned) console.log(`  ${note}`);

  if (alive.length > 0) {
    // The worker protects and reconciles open positions, and an armed profile
    // with an open window can admit one at any moment. "Zero active
    // executions" is NOT "durably disarmed", so the authoritative durable state
    // is what decides — checked BEFORE any process is terminated.
    const verdict = evaluateDurableSafety(await readDurableState(), "SHUTDOWN");
    if (!verdict.safe) {
      reportDurableRefusal(verdict.reason, "The runtime was NOT stopped and no deployment gate was changed.");
      return;
    }
  }

  for (const record of alive) {
    const ok = terminateTree(record.pid);
    console.log(`  ${record.role} pid ${record.pid}: ${ok ? "stopped" : "could not be stopped"}`);
  }
  store.clear();

  // Restore SAFE only after the processes are gone, so no running process is
  // left believing a mode the file no longer states.
  const envText = readEnvText();
  const rewritten = applyGates(envText, gatesFor("SAFE"));
  if (!rewritten.ok) {
    console.log("");
    console.log(`WARNING — the deployment gates could NOT be restored to SAFE: ${rewritten.reason}`);
    console.log("Inspect the deployment configuration before starting the runtime again.");
    return;
  }
  writeEnvText(rewritten.text);

  console.log("");
  for (const line of (await currentStatus()).lines) console.log(line);
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!existsSync(ENV_PATH)) {
    console.log("BLOCKED — the backend .env was not found. Nothing was changed.");
    process.exitCode = 1;
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string) =>
    new Promise<string>((done) => rl.question(question, (answer) => done(answer)));

  try {
    for (;;) {
      const status = await currentStatus();
      console.log("");
      console.log("================================================");
      console.log("TRADING RUNTIME LAUNCHER");
      console.log("================================================");
      console.log("");
      for (const line of status.lines) console.log(line);
      console.log("");
      console.log("1. Show Status");
      console.log("2. Start SAFE");
      console.log("3. Start LIVE-READY");
      console.log("4. Stop Runtime & Return SAFE");
      console.log("5. Supervise Worker (auto-restart the worker role)");
      console.log("6. Exit");
      console.log("");

      const choice = (await ask("Choose: ")).trim();
      if (choice === "1") continue;
      else if (choice === "2") await startRuntime("SAFE");
      else if (choice === "3") await startLiveReady(ask);
      else if (choice === "4") await stopRuntime();
      else if (choice === "5") await superviseWorker(ask);
      else if (choice === "6") break;
      else console.log("Unrecognised choice. Nothing was changed.");
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  // Never the raw error: it can carry a path or a connection string.
  console.error(`Launcher failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
