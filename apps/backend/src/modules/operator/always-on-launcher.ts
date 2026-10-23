import { ALWAYS_ON_NOTICE, ALWAYS_ON_REQUEST_SCHEMA } from "../always-on/always-on-contract";
import { parseOwnership } from "../always-on/always-on-ownership";
import { alwaysOnPaths, type AlwaysOnPaths } from "../always-on/always-on-paths";
import { credentialNamesPresent, genericEnvFilePath } from "../always-on/always-on-roles";
import { renderAlwaysOnStatus, type AlwaysOnStatusDto } from "../always-on/always-on-status";
import { parseEnvFileStrict } from "./dual-account-topology";
import { withMutationLock, type MutationLockAdapters } from "./mutation-lock";
import { verifyOwnership, type Observation, type ProcessProbe } from "./runtime-launcher";

/**
 * The runtime launcher's ALWAYS-ON MONITORING controls (menu 16 / 17 / 18).
 *
 * MONITORING ONLY · NO ACCOUNT EXECUTION · NATIVE EXECUTION HARD-DISABLED.
 *
 *  - Start launches the supervisor (`monitoring:always-on run`) detached, its
 *    output in a durable log (logs\always-on-supervisor.log) — the launcher's
 *    rule for every process it starts. The supervisor then owns its children
 *    (backend, scanner, emitter, planner); the launcher owns nothing new. (For
 *    a visible console, double-click `Always-On Monitoring.cmd` instead.)
 *  - Status reads the supervisor's status artifact and proves whether the
 *    recorded supervisor is still alive (pid + OS creation time + repository).
 *  - Stop writes a generation-tagged stop REQUEST (through the always-on
 *    module's request writer — the launcher's only Always-On write, never its
 *    own state and never an env file) and waits; the supervisor performs every
 *    stop itself, through its own fenced primitives. The launcher never
 *    terminates the supervisor or any of its children.
 *
 * None of Start SAFE, Stop Runtime, LIVE-READY, the account roles, the optional
 * Native planner action or the non-watch backend action changes. While
 * Always-On owns the backend and the planner, those launcher actions see them
 * as external and refuse to start a second copy — exactly as for any external
 * process today; and the Always-On supervisor in turn reports any launcher-owned
 * planner or backend as a CONFLICT and never touches it.
 */

export interface AlwaysOnLauncherAdapters {
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly probeProcesses: (pids: number[]) => Observation<Map<number, ProcessProbe>>;
  readonly readText: (file: string) => string | null;
  readonly writeTextAtomic: (file: string, text: string) => void;
  /** Starts the supervisor detached with a durable log (always-on-launch.ts). Returns its root pid. */
  readonly startSupervisor: (env: NodeJS.ProcessEnv) => number | null;
  readonly lockAdapters: () => MutationLockAdapters;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<unknown>;
  readonly now: () => number;
}

export interface AlwaysOnLauncher {
  start(ask: (question: string) => Promise<string>): Promise<void>;
  showStatus(): void;
  stop(): Promise<void>;
  statusLine(): string;
}

/** Seconds the launcher waits to SEE the supervisor take ownership after opening its console. */
export const ALWAYS_ON_START_WAIT_MS = 90_000;
/** Seconds the launcher waits for a graceful stop before handing the wait back to the operator. */
export const ALWAYS_ON_STOP_WAIT_MS = 600_000;

/** The supervisor's environment: every credential name removed (it strips them again itself). */
export function alwaysOnLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const drop = new Set(credentialNamesPresent(env).map((name) => name.toUpperCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!drop.has(key.toUpperCase())) out[key] = value;
  return out;
}

export function createAlwaysOnLauncher(adapters: AlwaysOnLauncherAdapters): AlwaysOnLauncher {
  const env = adapters.env ?? process.env;
  const say = (line: string) => adapters.log(line);
  const paths = (): AlwaysOnPaths => alwaysOnPaths(env);

  const live = (): { generation: number; pid: number } | null | "UNKNOWN" => {
    const read = parseOwnership(adapters.readText(paths().ownership));
    if (read.kind !== "VALID" || read.file.supervisor === null) return null;
    const supervisor = read.file.supervisor;
    const probed = adapters.probeProcesses([supervisor.pid]);
    if (!probed.ok) return "UNKNOWN";
    return verifyOwnership(supervisor, probed.value.get(supervisor.pid) ?? null, read.file.repoRoot).owned ? { generation: read.file.generation, pid: supervisor.pid } : null;
  };

  const readStatus = (): AlwaysOnStatusDto | null => {
    const text = adapters.readText(paths().status);
    if (text === null) return null;
    try {
      return JSON.parse(text) as AlwaysOnStatusDto;
    } catch {
      return null;
    }
  };

  const start = async (ask: (question: string) => Promise<string>): Promise<void> => {
    say("");
    say(`ALWAYS-ON MONITORING — ${ALWAYS_ON_NOTICE.join(" · ")}`);
    say("Starts the supervisor detached (log: logs\\always-on-supervisor.log). It owns the generic backend (non-watch), the Native scanner,");
    say("the Native emitter (COMMIT, follow — dashboard writes only) and the Native planner (planning only).");
    say("It never starts Account A or Account B and never touches a process it did not start.");
    const now = live();
    if (now === "UNKNOWN") {
      say("The recorded supervisor could not be observed; nothing was started.");
      return;
    }
    if (now !== null) {
      say(`Always-On is already running (pid ${now.pid}, generation ${now.generation}). Nothing was started.`);
      return;
    }
    const generic = parseEnvFileStrict(genericEnvFilePath(env));
    if (!generic.ok) {
      say(`BLOCKED — the generic environment file cannot be read (${generic.reasonCode}); every monitoring child is started from it. Nothing was started.`);
      return;
    }
    say("Roles the launcher already owns (Native Planner, Non-Watch Backend) are reported by Always-On as CONFLICT and left running;");
    say("stop them first (13 / 15) if Always-On should own them.");
    if ((await ask("Start Always-On Monitoring? (y/N) ")).trim().toLowerCase() !== "y") {
      say("Nothing was changed.");
      return;
    }
    // The lock is held only around the spawn: the supervisor takes the same lock for each child it starts.
    const held = await withMutationLock("ALWAYS_ON_START", adapters.lockAdapters(), async () => {
      try {
        return adapters.startSupervisor(alwaysOnLaunchEnv(env));
      } catch (error) {
        say(`BLOCKED — ${(error as Error).message}`);
        return null;
      }
    });
    if (!held.ran) {
      for (const reason of held.reasons) say(`  ${reason}`);
      say("Nothing was started.");
      return;
    }
    if (held.result === null) {
      say("The supervisor could not be started (its log could not be opened, or the spawn failed). Nothing was started.");
      return;
    }
    say(`Supervisor started (root pid ${held.result}); waiting for it to take ownership…`);
    for (let waited = 0; waited < ALWAYS_ON_START_WAIT_MS; waited += 2_000) {
      await adapters.sleep(2_000);
      const up = live();
      if (up !== null && up !== "UNKNOWN") {
        say(`Always-On is running: pid ${up.pid}, generation ${up.generation}. Its state: 17. Show Always-On Status.`);
        return;
      }
    }
    say("The supervisor has not recorded ownership yet; read logs\\always-on-supervisor.log (it may have refused, e.g. another instance or a missing env file).");
  };

  const showStatus = (): void => {
    say("");
    const now = live();
    say(now === "UNKNOWN" ? "Always-On supervisor: UNKNOWN (could not be observed)" : now === null ? "Always-On supervisor: NOT RUNNING" : `Always-On supervisor: RUNNING (pid ${now.pid}, generation ${now.generation})`);
    const status = readStatus();
    if (status === null) {
      say("No Always-On status artifact yet.");
      return;
    }
    for (const line of renderAlwaysOnStatus(status, adapters.now())) say(line);
  };

  const stop = async (): Promise<void> => {
    say("");
    const now = live();
    if (now === "UNKNOWN") {
      say("The recorded supervisor could not be observed; nothing was requested.");
      return;
    }
    if (now === null) {
      say("Always-On is not running; nothing to stop.");
      return;
    }
    // The request is written under the mutation lock and the lock is RELEASED before waiting: the supervisor
    // needs that same lock for each of its own fenced stops.
    const held = await withMutationLock("ALWAYS_ON_STOP", adapters.lockAdapters(), async () =>
      adapters.writeTextAtomic(paths().stopRequest, `${JSON.stringify({ schema: ALWAYS_ON_REQUEST_SCHEMA, kind: "STOP", generation: now.generation, requestedAt: new Date(adapters.now()).toISOString() })}\n`)
    );
    if (!held.ran) {
      for (const reason of held.reasons) say(`  ${reason}`);
      say("Nothing was requested.");
      return;
    }
    say(`Graceful stop requested (generation ${now.generation}): emitter → scanner → planner → backend, each through the supervisor's fenced stop.`);
    let last = "";
    for (let waited = 0; waited < ALWAYS_ON_STOP_WAIT_MS; waited += 2_000) {
      await adapters.sleep(2_000);
      const status = readStatus();
      const line = status === null ? "" : `${status.state} (${status.reasonCode})`;
      if (line !== "" && line !== last) say(`  ${line}`);
      last = line;
      const still = live();
      if (still === null) {
        say("Always-On has stopped. Every role it owned was stopped by it; nothing else was touched.");
        return;
      }
    }
    say("Still stopping; the supervisor continues on its own. Check again with 17.");
  };

  const statusLine = (): string => {
    const now = live();
    if (now === "UNKNOWN") return "Always-On Monitoring (monitoring only): UNKNOWN (could not be observed)";
    if (now === null) return "Always-On Monitoring (monitoring only): OFF";
    const status = readStatus();
    return `Always-On Monitoring (monitoring only): RUNNING — generation ${now.generation}${status === null ? "" : `, ${status.state} (${status.reasonCode})`}`;
  };

  return { start, showStatus, stop, statusLine };
}
