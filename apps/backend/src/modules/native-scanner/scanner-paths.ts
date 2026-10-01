import path from "node:path";

/**
 * Where the scanner keeps machine-local data: under %LOCALAPPDATA%, beside the
 * launcher's env/, logs/ and state file — never inside a git worktree, where a
 * cache or a replay is one `git add -A` away from being committed.
 */

export class ScannerPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScannerPathError";
  }
}

/** `%LOCALAPPDATA%\trading-alert-dashboard\scanner`. Refuses when LOCALAPPDATA is unset. */
export function scannerRootDir(env: NodeJS.ProcessEnv): string {
  const base = env.LOCALAPPDATA?.trim();
  if (!base) throw new ScannerPathError("LOCALAPPDATA is not set, so there is no machine-local scanner directory");
  return path.join(base, "trading-alert-dashboard", "scanner");
}

export const scannerKlineCacheDir = (env: NodeJS.ProcessEnv) => path.join(scannerRootDir(env), "klines");
export const scannerReplayDir = (env: NodeJS.ProcessEnv) => path.join(scannerRootDir(env), "replays");

/** Returns `dir` resolved, or refuses if it is the repository or anywhere inside it. */
export function assertOutsideRepository(dir: string, repoRoot: string): string {
  const resolvedDir = path.resolve(dir);
  const resolvedRepo = path.resolve(repoRoot);
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const inside =
    norm(resolvedDir) === norm(resolvedRepo) || norm(resolvedDir).startsWith(norm(resolvedRepo) + path.sep);
  if (inside) throw new ScannerPathError(`scanner data must live outside the repository (${resolvedDir})`);
  return resolvedDir;
}
