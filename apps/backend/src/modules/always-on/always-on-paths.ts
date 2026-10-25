import path from "node:path";

import { emitterRunDir } from "../native-alerts/native-emitter-state-files";
import { scannerRootDir } from "../native-scanner/scanner-paths";
import type { AlwaysOnRole } from "./always-on-contract";

/**
 * Where Always-On Monitoring keeps its durable local state — all of it under
 * the existing LocalAppData runtime tree, OUTSIDE the repository, beside the
 * launcher's state, the scanner's data and the role logs:
 *
 *   %LOCALAPPDATA%\trading-alert-dashboard\monitoring\always-on\
 *     ownership.json   the owning supervisor generation and its children (atomic replace)
 *     status.json      teddy.native-monitoring.always-on-status.v1 (atomic replace, every tick)
 *     incidents.jsonl  append-only transitions journal (fsync per line)
 *     requests\        operator requests (stop, clear-latch, drill, drill-restore) the running supervisor consumes
 *     stop\            one cooperative stop file per spawned scanner/emitter child, and the owned scanner's
 *                     drill file beside its stop file while an operator drill is active (always-on-drill.ts)
 *   %LOCALAPPDATA%\trading-alert-dashboard\logs\always-on-<role>.log   each child's stdout+stderr
 *
 * No path here is derived from anything an operator types except the profile
 * name, which is validated against the scanner's own profile table before use.
 */

export interface AlwaysOnPaths {
  readonly dir: string;
  readonly ownership: string;
  readonly status: string;
  readonly incidents: string;
  readonly requestsDir: string;
  readonly stopRequest: string;
  readonly clearLatchRequest: string;
  /** An operator's drill request (`monitoring:always-on drill start`), consumed once by the running supervisor. */
  readonly drillRequest: string;
  /** An operator's drill restore request: honoured by any running generation (it can only end a fault). */
  readonly drillRestoreRequest: string;
  readonly stopDir: string;
  readonly logsDir: string;
  readonly scannerRoot: string;
  /** The live-shadow supervisor's latest status (its own pid inside proves which run wrote it). */
  readonly scannerStatus: string;
}

export class AlwaysOnPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlwaysOnPathError";
  }
}

export function alwaysOnPaths(env: NodeJS.ProcessEnv): AlwaysOnPaths {
  const base = env.LOCALAPPDATA?.trim();
  if (!base) throw new AlwaysOnPathError("LOCALAPPDATA is not set, so there is no machine-local runtime directory");
  const root = path.join(base, "trading-alert-dashboard");
  const dir = path.join(root, "monitoring", "always-on");
  const requestsDir = path.join(dir, "requests");
  const scannerRoot = scannerRootDir(env);
  return {
    dir,
    ownership: path.join(dir, "ownership.json"),
    status: path.join(dir, "status.json"),
    incidents: path.join(dir, "incidents.jsonl"),
    requestsDir,
    stopRequest: path.join(requestsDir, "stop.json"),
    clearLatchRequest: path.join(requestsDir, "clear-latch.json"),
    drillRequest: path.join(requestsDir, "drill.json"),
    drillRestoreRequest: path.join(requestsDir, "drill-restore.json"),
    stopDir: path.join(dir, "stop"),
    logsDir: path.join(root, "logs"),
    scannerRoot,
    scannerStatus: path.join(scannerRoot, "live-shadow-supervisor", "status.json"),
  };
}

/** The scanner run's own directory (manifest, per-run status, membership journal). */
export const scannerRunDir = (paths: AlwaysOnPaths, runId: string) => path.join(paths.scannerRoot, "live-shadow-supervisor", "runs", runId);

/** The run manifest a pinned emitter binds to. */
export const scannerRunManifest = (paths: AlwaysOnPaths, runId: string) => path.join(scannerRunDir(paths, runId), "manifest.json");

/** The COMMIT emitter's status file for one pinned run. */
export const emitterCommitStatus = (paths: AlwaysOnPaths, runId: string) => path.join(emitterRunDir(paths.scannerRoot, runId), "status-commit.json");

/** One role's durable log. A fixed name per role: no identifier, token or value in the path. */
export const alwaysOnRoleLog = (paths: AlwaysOnPaths, role: AlwaysOnRole) => path.join(paths.logsDir, `always-on-${role}.log`);

/** A unique cooperative stop file for one spawned child (role, generation, spawn sequence). */
export const childStopFile = (paths: AlwaysOnPaths, role: AlwaysOnRole, generation: number, sequence: number) =>
  path.join(paths.stopDir, `${role}-g${generation}-s${sequence}.stop`);
