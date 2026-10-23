import { writeFileSync } from "node:fs";
import path from "node:path";

import { verifyOwnership } from "../operator/runtime-launcher";
import { ALWAYS_ON_DEFAULTS, ALWAYS_ON_INSTANCE_PORT, ALWAYS_ON_NOTICE, ALWAYS_ON_REQUEST_SCHEMA, type AlwaysOnRole } from "./always-on-contract";
import { ALWAYS_ON_CLI_USAGE, AlwaysOnCliUsageError, parseAlwaysOnCliArgs, type AlwaysOnRunRequest } from "./always-on-cli-args";
import {
  assertLoopbackBaseUrl,
  buildVerdictFor,
  createSpawner,
  genericEnvKeyNames,
  observeProcessTree,
  probeProcess,
  publicBinanceReachable,
  realFileSystem,
  realHttp,
  realInstanceLock,
  realMutation,
  selfStartedAtMs,
  terminateTree,
} from "./always-on-machine";
import { parseOwnership, type OwnershipFile } from "./always-on-ownership";
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

function readOwnership(paths: AlwaysOnPaths): OwnershipFile | null {
  const read = parseOwnership(realFileSystem.readText(paths.ownership));
  return read.kind === "VALID" ? read.file : null;
}

/** The recorded supervisor, if it is provably still running (pid + OS creation time + this repository). */
function liveSupervisor(paths: AlwaysOnPaths): { readonly generation: number; readonly pid: number } | null {
  const file = readOwnership(paths);
  if (file === null || file.supervisor === null) return null;
  const probed = probeProcess(file.supervisor.pid);
  if (!probed.observed) return null;
  return verifyOwnership(file.supervisor, probed.process, file.repoRoot).owned ? { generation: file.generation, pid: file.supervisor.pid } : null;
}

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
    say(JSON.stringify({ supervisorRunning: live !== null, status }, null, 2));
    return 0;
  }
  banner("ALWAYS-ON MONITORING — STATUS (read-only)");
  say(live === null ? "Supervisor: NOT RUNNING (no live supervisor is recorded)" : `Supervisor: RUNNING (pid ${live.pid}, generation ${live.generation})`);
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
  if (live === null) {
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
    if (liveSupervisor(paths) === null) {
      say("The supervisor has exited.");
      return 0;
    }
  }
  say(`Still running after ${waitSeconds}s; the stop continues in the supervisor (check: monitoring:always-on status).`);
  return 1;
}

function requestClearLatch(paths: AlwaysOnPaths, role: AlwaysOnRole | null): number {
  banner("ALWAYS-ON MONITORING — CLEAR LATCH");
  const live = liveSupervisor(paths);
  if (live === null) {
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
      selfPid: process.pid,
      selfStartedAtMs: selfStartedAtMs(),
      env: process.env,
      paths,
      observeTree: observeProcessTree,
      probe: probeProcess,
      spawn: spawner.spawn,
      terminate: terminateTree,
      exitCodeOf: spawner.exitCodeOf,
      fs: realFileSystem,
      http: realHttp,
      publicConnectivity: () => publicBinanceReachable(),
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
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`monitoring:always-on failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`);
    process.exit(1);
  });
