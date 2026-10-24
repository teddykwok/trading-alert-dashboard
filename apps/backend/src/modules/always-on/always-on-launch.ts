import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AlwaysOnPaths } from "./always-on-paths";

/**
 * How the runtime launcher starts the Always-On SUPERVISOR (menu 16): detached,
 * console hidden, stdout+stderr to a durable log — the same rule every role the
 * launcher starts follows (a process whose output goes nowhere is never
 * started). The supervisor records its own identity in ownership.json; the
 * launcher keeps no record and never terminates it (it asks it to stop).
 *
 * For a visible console, double-click `Always-On Monitoring.cmd` at the
 * repository root instead (Ctrl+C there stops the stack gracefully).
 */

const LOG_ROTATE_BYTES = 32 * 1024 * 1024;
const PLAIN_REPO = /^[A-Za-z]:\\[^\s"&|<>^%!]*$/;

export const alwaysOnSupervisorLog = (paths: AlwaysOnPaths) => path.join(paths.logsDir, "always-on-supervisor.log");

/** The supervisor's command: `cmd /d /s /c pnpm -C <repo> --filter … monitoring:always-on run` (repo-controlled). */
export function alwaysOnSupervisorArgs(repoRoot: string): string[] {
  if (!PLAIN_REPO.test(repoRoot)) throw new Error("the repository path must be a plain absolute path (no spaces or shell characters) to start Always-On unattended");
  return ["/d", "/s", "/c", "pnpm", "-C", repoRoot, "--filter", "@trading-alert-dashboard/backend", "monitoring:always-on", "run"];
}

/** Reads an Always-On file (status, ownership), or null. */
export function readAlwaysOnText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Writes ONE Always-On REQUEST file (stop / clear-latch) atomically. The
 * launcher's only Always-On write: never launcher state, never an env file.
 */
export function writeAlwaysOnRequest(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, text, "utf8");
  renameSync(temporary, file);
}

/** Starts the supervisor with durable output, or not at all. Returns the root pid. */
export function spawnAlwaysOnSupervisor(paths: AlwaysOnPaths, repoRoot: string, env: NodeJS.ProcessEnv): number | null {
  const args = alwaysOnSupervisorArgs(repoRoot);
  let fd: number;
  try {
    mkdirSync(paths.logsDir, { recursive: true });
    const file = alwaysOnSupervisorLog(paths);
    try {
      if (statSync(file).size >= LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // No file yet.
    }
    fd = openSync(file, "a");
  } catch {
    return null;
  }
  try {
    const child = spawn(env.ComSpec ?? "cmd.exe", args, { cwd: repoRoot, env, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
    // A run-time spawn failure has no pid and reports through 'error' on the next tick: handled here, so it is
    // "could not be started" — never an uncaught exception that ends the runtime launcher.
    child.on("error", () => undefined);
    if (child.pid === undefined) return null;
    child.unref();
    return child.pid;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The child holds its own copy.
    }
  }
}
