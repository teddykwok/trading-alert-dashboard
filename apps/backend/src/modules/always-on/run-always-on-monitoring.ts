import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { ALWAYS_ON_DEFAULTS, ALWAYS_ON_INSTANCE_PORT, ALWAYS_ON_NOTICE, ALWAYS_ON_REQUEST_SCHEMA, type AlwaysOnRole } from "./always-on-contract";
import { ALWAYS_ON_CLI_USAGE, AlwaysOnCliUsageError, parseAlwaysOnCliArgs, type AlwaysOnCliRequest, type AlwaysOnRunRequest } from "./always-on-cli-args";
import { ALWAYS_ON_DRILL_FAULTS, ALWAYS_ON_DRILL_REQUEST_TTL_MS, drillRestoreRequestText, drillStartRequestText } from "./always-on-drill";
import {
  assertLoopbackBaseUrl,
  buildVerdictFor,
  createSpawner,
  genericEnvKeyNames,
  observeProcessTree,
  probeProcess,
  publicConnectivityProbe,
  publicStreamProbe,
  realFileSystem,
  realHttp,
  realInstanceLock,
  realMutation,
  selfStartedAtMs,
  terminateTree,
  verifyPrivateDirectories,
} from "./always-on-machine";
import { supervisorLiveness, type SupervisorLiveness } from "./always-on-ownership";
import { AlwaysOnPathError, alwaysOnPaths, type AlwaysOnPaths } from "./always-on-paths";
import { credentialNamesPresent } from "./always-on-roles";
import { renderAlwaysOnStatus, type AlwaysOnStatusDto } from "./always-on-status";
import { StartupTaskError, startupTaskCommands, startupTaskXml, startupTaskXmlBytes } from "./always-on-startup-task";
import { AlwaysOnSupervisor } from "./always-on-supervisor";

/**
 * ALWAYS-ON MONITORING V1 — `pnpm --filter @trading-alert-dashboard/backend monitoring:always-on <command>`
 *
 * MONITORING ONLY · NO ACCOUNT EXECUTION · NATIVE EXECUTION HARD-DISABLED.
 *
 * This entrypoint imports no database client, no environment configuration,
 * no Redis, no exchange client and no execution module: it is a deployment
 * tool, like the runtime launcher. It strips every credential name from its own
 * environment before anything else, and every child it starts is given the
 * generic env file with all account/credential variables removed.
 *
 *   run           own and supervise the monitoring stack (Ctrl+C: graceful stop of the stack;
 *                 closing the window or a second Ctrl+C: leave, children keep running and are adopted next start)
 *   status        print the status artifact (read-only)
 *   stop          graceful stop request to the running supervisor, then wait for it
 *   clear-latch   clear a latched role on the running supervisor
 *   startup-task  print (and with --write, save) the Windows logon task — never registers it
 *   drill         the operator network drill: start (against the running generation and scanner run), restore, status
 */

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const SUMMARY_EVERY_MS = 5 * 60_000;

const say = (line: string) => console.log(line);
const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");

function banner(title: string): void {
  say("==============================================================");
  say(title);
  say(ALWAYS_ON_NOTICE.join(" · "));
  say("==============================================================");
}

/** The recorded supervisor: provably RUNNING, provably NOT_RUNNING, or UNKNOWN (unreadable file, failed probe). */
const liveSupervisor = (paths: AlwaysOnPaths): SupervisorLiveness => supervisorLiveness(() => realFileSystem.readTextStrict(paths.ownership), probeProcess);

function readStatus(paths: AlwaysOnPaths): AlwaysOnStatusDto | null {
  const text = realFileSystem.readText(paths.status);
  if (text === null) return null;
  try {
    return JSON.parse(text) as AlwaysOnStatusDto;
  } catch {
    return null;
  }
}

function printStatus(paths: AlwaysOnPaths, json: boolean): number {
  const status = readStatus(paths);
  const live = liveSupervisor(paths);
  if (json) {
    // null: it could not be observed this time (never reported as not running).
    say(JSON.stringify({ supervisorRunning: live.kind === "UNKNOWN" ? null : live.kind === "RUNNING", status }, null, 2));
    return 0;
  }
  banner("ALWAYS-ON MONITORING — STATUS (read-only)");
  say(
    live.kind === "RUNNING"
      ? `Supervisor: RUNNING (pid ${live.pid}, generation ${live.generation})`
      : live.kind === "NOT_RUNNING"
        ? "Supervisor: NOT RUNNING (no live supervisor is recorded)"
        : `Supervisor: UNKNOWN (${live.reason}; ask again)`
  );
  if (status === null) {
    say("No status artifact yet.");
    return 0;
  }
  for (const line of renderAlwaysOnStatus(status, Date.now())) say(line);
  say(`Status file: ${paths.status}`);
  say(`Incident journal: ${paths.incidents}`);
  return 0;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function requestStop(paths: AlwaysOnPaths, waitSeconds: number): Promise<number> {
  banner("ALWAYS-ON MONITORING — STOP");
  const live = liveSupervisor(paths);
  if (live.kind === "UNKNOWN") {
    say(`The recorded supervisor could not be observed (${live.reason}); nothing was requested. Try again.`);
    return 1;
  }
  if (live.kind === "NOT_RUNNING") {
    say("No running Always-On supervisor is recorded; nothing was requested.");
    return 0;
  }
  const requestedAt = new Date().toISOString();
  realFileSystem.writeTextAtomic(paths.stopRequest, `${JSON.stringify({ schema: ALWAYS_ON_REQUEST_SCHEMA, kind: "STOP", generation: live.generation, requestedAt })}\n`);
  say(`Graceful stop requested from generation ${live.generation} (pid ${live.pid}): emitter, scanner, planner, backend — cooperatively where they support it.`);
  const deadline = Date.now() + waitSeconds * 1000;
  let last = "";
  while (Date.now() < deadline) {
    await sleep(2_000);
    const status = readStatus(paths);
    const line = status === null ? "no status" : `${status.state} (${status.reasonCode})`;
    if (line !== last) say(`  ${stamp()}  ${line}`);
    last = line;
    const still = liveSupervisor(paths);
    // Only a PROVEN exit ends the wait: a probe or read that failed this once says nothing.
    if (still.kind === "NOT_RUNNING") {
      say("The supervisor has exited.");
      return 0;
    }
    if (still.kind === "UNKNOWN") say(`  ${stamp()}  the supervisor could not be observed this time (${still.reason}); still waiting`);
  }
  say(`Still running after ${waitSeconds}s; the stop continues in the supervisor (check: monitoring:always-on status).`);
  return 1;
}

function requestClearLatch(paths: AlwaysOnPaths, role: AlwaysOnRole | null): number {
  banner("ALWAYS-ON MONITORING — CLEAR LATCH");
  const live = liveSupervisor(paths);
  if (live.kind === "UNKNOWN") {
    say(`The recorded supervisor could not be observed (${live.reason}); nothing was requested. Try again.`);
    return 1;
  }
  if (live.kind === "NOT_RUNNING") {
    say("No running Always-On supervisor is recorded; nothing was requested (a fresh start begins with no latch).");
    return 0;
  }
  realFileSystem.writeTextAtomic(paths.clearLatchRequest, `${JSON.stringify({ schema: ALWAYS_ON_REQUEST_SCHEMA, kind: "CLEAR_LATCH", role, generation: live.generation, requestedAt: new Date().toISOString() })}\n`);
  say(`Requested: clear the latch ${role === null ? "of every role" : `of the ${role}`} on generation ${live.generation}. It is applied at the supervisor's next tick.`);
  return 0;
}

function printStartupTask(paths: AlwaysOnPaths, taskName: string, emitterActivateAtEof: boolean, write: boolean): number {
  banner("ALWAYS-ON MONITORING — WINDOWS STARTUP TASK (nothing is registered)");
  const userId = process.env.USERNAME ? (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME) : null;
  let xml: string;
  try {
    xml = startupTaskXml({ taskName, repoRoot: REPO_ROOT, runArgs: emitterActivateAtEof ? ["--emitter-activate-at-eof"] : [], userId });
  } catch (error) {
    if (!(error instanceof StartupTaskError)) throw error;
    say(`REFUSED: ${error.message}`);
    return 2;
  }
  const xmlPath = path.join(paths.dir, "startup-task.xml");
  say("It starts ONLY the monitoring supervisor at logon (one minute after), as you, never Account A or Account B.");
  say("");
  if (write) {
    realFileSystem.ensureDir(paths.dir);
    writeFileSync(xmlPath, startupTaskXmlBytes(xml));
    say(`Task definition written (UTF-16): ${xmlPath}`);
  } else {
    say("Task definition (save it with --write):");
    say(xml);
  }
  say("Register it LATER, deliberately, from PowerShell (this repository never runs these):");
  for (const command of startupTaskCommands(taskName, xmlPath)) say(`  ${command}`);
  return 0;
}

// ---------------------------------------------------------------------------
// The operator network drill (always-on-drill.ts)
// ---------------------------------------------------------------------------

/** The supervisor's verdict on one request, from the incident journal (null: none yet). */
function drillRejection(paths: AlwaysOnPaths, requestId: string): { reasonCode: string; detail: string } | null {
  const text = realFileSystem.readText(paths.incidents);
  if (text === null) return null;
  for (const line of text.split(/\r?\n/).reverse()) {
    if (!line.includes(requestId)) continue;
    try {
      const record = JSON.parse(line) as { kind?: unknown; reasonCode?: unknown; detail?: unknown; facts?: { requestId?: unknown } };
      if (record.kind === "DRILL_REJECTED" && record.facts?.requestId === requestId) return { reasonCode: String(record.reasonCode), detail: String(record.detail) };
    } catch {
      // A torn last line: the next poll reads it whole.
    }
  }
  return null;
}

/**
 * `drill start`: refuses unless the running supervisor is the named generation and owns the named scanner run, then
 * writes ONE request naming them and this process (the controller the supervisor verifies) and waits for the verdict.
 * The drill itself never depends on this process: it ends at its expiry whatever happens here.
 */
async function requestDrillStart(paths: AlwaysOnPaths, request: Extract<AlwaysOnCliRequest, { command: "drill-start" }>): Promise<number> {
  banner("ALWAYS-ON MONITORING — OPERATOR NETWORK DRILL (start)");
  const refuse = (why: string) => {
    say(`REFUSED: ${why}. Nothing was requested.`);
    return 1;
  };
  const live = liveSupervisor(paths);
  if (live.kind === "UNKNOWN") return refuse(`the recorded supervisor could not be observed (${live.reason})`);
  if (live.kind === "NOT_RUNNING") return refuse("Supervisor: NOT RUNNING — a drill runs only against a running Always-On supervisor");
  if (live.generation !== request.generation) return refuse(`the running supervisor is generation ${live.generation}, not ${request.generation}`);
  const status = readStatus(paths);
  if (status === null || status.generation !== request.generation) return refuse(`the status artifact does not show generation ${request.generation}`);
  if (status.roles.scanner.runId !== request.runId) return refuse(`the owned scanner runs ${status.roles.scanner.runId ?? "nothing"}, not ${request.runId}`);
  if (status.drill?.state === "ACTIVE") return refuse(`drill ${status.drill.drillId} is already active (end it with: monitoring:always-on drill restore)`);
  if (realFileSystem.exists(paths.drillRequest)) return refuse("another drill request is already waiting for the supervisor");
  const selfStart = selfStartedAtMs();
  if (selfStart === null) return refuse("this process's own OS creation time could not be read, so the supervisor could never verify it");
  const requestId = randomBytes(16).toString("hex");
  const user = (process.env.USERNAME ?? "").replace(/[\u0000-\u001f\u007f|]/g, "_").slice(0, 64) || "unknown";
  realFileSystem.writeTextAtomic(
    paths.drillRequest,
    drillStartRequestText({ requestId, generation: request.generation, runId: request.runId, fault: request.fault, durationSeconds: request.durationSeconds, requestedAtMs: Date.now(), controller: { pid: process.pid, startedAtMs: selfStart, user } })
  );
  say(`Requested ${request.fault} (${ALWAYS_ON_DRILL_FAULTS[request.fault].summary}) for ${request.durationSeconds}s`);
  say(`  on generation ${request.generation}, scanner run ${request.runId}; request ${requestId}. Waiting for the supervisor's verdict...`);
  const deadline = Date.now() + ALWAYS_ON_DRILL_REQUEST_TTL_MS + 15_000;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const drill = readStatus(paths)?.drill ?? null;
    if (drill !== null && drill.drillId === requestId) {
      say(`ACCEPTED: drill ${drill.state} since ${drill.startedAt}; restored automatically by ${drill.expiresAt} at the latest.`);
      say("End it earlier with: monitoring:always-on drill restore. Follow it with: monitoring:always-on drill status");
      return 0;
    }
    const rejected = drillRejection(paths, requestId);
    if (rejected !== null) {
      say(`REFUSED by the supervisor (${rejected.reasonCode}): ${rejected.detail}`);
      return 1;
    }
  }
  // Withdrawn only if it is still OUR request; an unconsumed request also expires on its own after 60 s.
  if ((realFileSystem.readText(paths.drillRequest) ?? "").includes(requestId)) realFileSystem.remove(paths.drillRequest);
  say("NOT ACCEPTED: the supervisor gave no verdict in time; the request was withdrawn. Nothing was drilled.");
  return 1;
}

/** Every drill file in the stop directory (they exist only while a drill is active, or after a crash). */
function drillFilesOf(paths: AlwaysOnPaths): string[] {
  return realFileSystem.listDir(paths.stopDir).filter((name) => name.toLowerCase().endsWith(".drill"));
}

/**
 * `drill restore`: asks a running supervisor to end its drill (journaled as an operator restore), then removes any drill
 * file still present — removing one can only end a fault, so this also works when no supervisor runs (after a crash).
 */
async function requestDrillRestore(paths: AlwaysOnPaths): Promise<number> {
  banner("ALWAYS-ON MONITORING — OPERATOR NETWORK DRILL (restore)");
  const live = liveSupervisor(paths);
  if (live.kind === "RUNNING") {
    realFileSystem.writeTextAtomic(paths.drillRestoreRequest, drillRestoreRequestText({ generation: live.generation, requestedAtMs: Date.now() }));
    say(`Restore requested from generation ${live.generation} (pid ${live.pid}).`);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && realFileSystem.exists(paths.drillRestoreRequest)) await sleep(1_000);
    const drill = readStatus(paths)?.drill ?? null;
    say(drill === null ? "The supervisor records no drill." : `Drill ${drill.drillId} (${drill.fault}): ${drill.state}${drill.endReason ? ` (${drill.endReason})` : ""}; restore ${drill.restore}.`);
  } else {
    say(live.kind === "NOT_RUNNING" ? "No running Always-On supervisor is recorded." : `The recorded supervisor could not be observed (${live.reason}).`);
  }
  let failed = 0;
  for (const name of drillFilesOf(paths)) {
    try {
      realFileSystem.remove(path.join(paths.stopDir, name));
      say(`Removed drill file ${name}: its scanner (if still running) ends the drill within a second.`);
    } catch (error) {
      failed += 1;
      say(`Could NOT remove drill file ${name} (${(error as NodeJS.ErrnoException).code ?? "error"}); it still ends at its expiry on its own.`);
    }
  }
  if (failed > 0) return 1;
  say("No drill file remains.");
  return 0;
}

/** `drill status`: read-only. */
function printDrillStatus(paths: AlwaysOnPaths): number {
  banner("ALWAYS-ON MONITORING — OPERATOR NETWORK DRILL (status, read-only)");
  const drill = readStatus(paths)?.drill ?? null;
  if (drill === null) say("The status artifact records no drill.");
  else {
    say(`Drill ${drill.drillId}: ${drill.fault} ${drill.state} on generation ${drill.generation}, scanner run ${drill.runId}`);
    say(`  started ${drill.startedAt}; restored by ${drill.expiresAt} at the latest`);
    say(`  activation ${drill.activation}; ${drill.state === "ENDED" ? `ended ${drill.endedAt} (${drill.endReason}); drill file removed: ${String(drill.fileRemoved)}; restore ${drill.restore}` : "still active"}`);
    say(`  controller pid ${drill.controller.pid} (${drill.controller.user})`);
  }
  const files = drillFilesOf(paths);
  say(files.length === 0 ? "No drill file is present." : `Drill file(s) present: ${files.join(", ")}`);
  return 0;
}

async function run(paths: AlwaysOnPaths, request: AlwaysOnRunRequest): Promise<number> {
  banner("ALWAYS-ON MONITORING V1 — SUPERVISOR");
  // Credentials: no monitoring process may hold one. Removed from this process FIRST (names only are reported).
  const stripped = credentialNamesPresent(process.env);
  for (const name of Object.keys(process.env)) if (stripped.some((s) => s.toUpperCase() === name.toUpperCase())) delete process.env[name];
  if (stripped.length > 0) say(`Removed from this process's environment (names only): ${stripped.join(", ")}`);
  let backendUrl: string;
  try {
    backendUrl = assertLoopbackBaseUrl(request.backendUrl);
  } catch (error) {
    say(`REFUSED: ${(error as Error).message}`);
    return 2;
  }
  const keys = genericEnvKeyNames(process.env);
  if (!keys.ok) {
    say(`REFUSED: the generic environment file cannot be read (${keys.reason}). Every monitoring child is started from it; nothing was started.`);
    return 1;
  }
  const lock = await realInstanceLock().acquire();
  if (!lock.ok) {
    say(`REFUSED: ${lock.reason}. Nothing was started or stopped.`);
    return 1;
  }
  // Recorded as this supervisor's identity: without its real OS creation time, stop / status / the launcher could never verify it.
  const selfStart = selfStartedAtMs();
  if (selfStart === null) {
    say("REFUSED: this process's own OS creation time could not be read (process observation failed), so its ownership record could never be verified. Nothing was started or stopped; try again.");
    await lock.held.release();
    return 1;
  }
  const spawner = createSpawner(paths, say);
  const supervisor = new AlwaysOnSupervisor(
    {
      repoRoot: REPO_ROOT,
      profileName: request.profileName,
      engineFingerprint: request.engineFingerprint,
      roles: request.roles,
      backendUrl,
      emitterQueueCapacity: request.emitterQueueCapacity,
      emitterActivateAtEof: request.emitterActivateAtEof,
      scannerExtraArgs: request.scannerExtraArgs,
      policy: { ...ALWAYS_ON_DEFAULTS, pollMs: request.pollMs, degradedGraceMs: request.degradedGraceMs, maxRecoveryAttempts: request.maxRecoveryAttempts },
      commandIdentity: `monitoring:always-on run --profile ${request.profileName} --roles ${request.roles.join(",")}`,
      instancePort: ALWAYS_ON_INSTANCE_PORT,
    },
    {
      now: () => Date.now(),
      monoNow: () => performance.now(),
      selfPid: process.pid,
      selfStartedAtMs: selfStart,
      env: process.env,
      paths,
      observeTree: observeProcessTree,
      probe: probeProcess,
      spawn: spawner.spawn,
      terminate: terminateTree,
      exitCodeOf: spawner.exitCodeOf,
      fs: realFileSystem,
      http: realHttp,
      publicConnectivity: publicConnectivityProbe,
      publicStreamConnectivity: publicStreamProbe,
      verifyPrivateDirectories,
      buildVerdict: buildVerdictFor(REPO_ROOT),
      genericEnvKeyNames: () => genericEnvKeyNames(process.env),
      mutation: realMutation(say),
      log: (line) => say(`${stamp()}  ${line}`),
    }
  );
  const started = await supervisor.start({ strippedCredentialNames: stripped });
  if (!started.ok) {
    say(`REFUSED: ${started.reason}`);
    await lock.held.release();
    return 1;
  }
  say(`Generation ${started.generation}; profile ${request.profileName}; roles ${request.roles.join(", ")}; status ${paths.status}`);
  say("Ctrl+C: graceful stop of the monitoring stack. Closing this window (or a second Ctrl+C): leave; children keep running and are adopted by the next start.");

  let wake: (() => void) | null = null;
  let interrupts = 0;
  const onInterrupt = () => {
    interrupts += 1;
    if (interrupts === 1) {
      say("Ctrl+C: stopping the monitoring stack gracefully (press Ctrl+C again to leave it running instead).");
      supervisor.requestShutdown("OPERATOR_CTRL_C");
    } else {
      supervisor.detach("OPERATOR_SECOND_CTRL_C");
    }
    wake?.();
  };
  const onDetach = (why: string) => () => {
    supervisor.detach(why);
    wake?.();
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGHUP", onDetach("CONSOLE_CLOSED"));
  process.on("SIGBREAK", onDetach("CTRL_BREAK"));

  let lastLine = "";
  let lastPrintMs = 0;
  let exitCode = 0;
  for (;;) {
    const outcome = await supervisor.tick();
    const status = supervisor.status();
    const line = `${status.state} (${status.reasonCode}) — ${status.reason}`;
    if (line !== lastLine || Date.now() - lastPrintMs >= SUMMARY_EVERY_MS) {
      say(`${stamp()}  ${line}`);
      lastLine = line;
      lastPrintMs = Date.now();
    }
    if (outcome === "FENCED") {
      say("A newer Always-On generation owns the stack; this supervisor controls nothing and exits.");
      exitCode = 1;
      break;
    }
    if (outcome === "STOPPED") break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, supervisor.nextDelayMs());
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = null;
  }
  await lock.held.release();
  say("Always-On supervisor exited.");
  return exitCode;
}

async function main(): Promise<number> {
  let request;
  try {
    request = parseAlwaysOnCliArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof AlwaysOnCliUsageError)) throw error;
    console.error(`monitoring:always-on: ${error.message}\n${ALWAYS_ON_CLI_USAGE}`);
    return 2;
  }
  let paths: AlwaysOnPaths;
  try {
    paths = alwaysOnPaths(process.env);
  } catch (error) {
    if (!(error instanceof AlwaysOnPathError)) throw error;
    console.error(`monitoring:always-on: ${error.message}`);
    return 2;
  }
  switch (request.command) {
    case "status":
      return printStatus(paths, request.json);
    case "stop":
      return requestStop(paths, request.waitSeconds);
    case "clear-latch":
      return requestClearLatch(paths, request.role);
    case "startup-task":
      return printStartupTask(paths, request.taskName, request.emitterActivateAtEof, request.write);
    case "run":
      return run(paths, request);
    case "drill-start":
      return requestDrillStart(paths, request);
    case "drill-restore":
      return requestDrillRestore(paths);
    case "drill-status":
      return printDrillStatus(paths);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`monitoring:always-on failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`);
    process.exit(1);
  });
