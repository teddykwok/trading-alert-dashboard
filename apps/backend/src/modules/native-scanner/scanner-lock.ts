import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

import { canonicalJson } from "./canonical-json";

/**
 * One live-shadow writer per symbol directory.
 *
 * A symbol's checkpoint and event log are written by exactly one process. Two
 * writers — the single-symbol CLI and the supervisor, or two supervisors —
 * would interleave appends and checkpoint replacements and corrupt the
 * evidence. The lock is a file created with O_EXCL (`wx`): the filesystem
 * decides the winner. A lock whose owner process is gone is stale and is
 * reclaimed; a lock whose owner is alive is a refusal, never an override.
 */

export const LIVE_SHADOW_LOCK_FILE = "live-shadow.lock";
export const LIVE_SHADOW_LOCK_SCHEMA = "teddy.native-scanner.live-shadow-lock.v1";

export class ScannerLockError extends Error {
  constructor(
    readonly code: "LOCKED_BY_LIVE_PROCESS" | "LOCK_UNREADABLE",
    message: string
  ) {
    super(message);
    this.name = "ScannerLockError";
  }
}

export interface ScannerLock {
  readonly file: string;
  release(): void;
}

export interface LockDeps {
  readonly pid: number;
  readonly owner: string;
  readonly startedAt: string;
  /** Whether a process with this id is alive (injected: tests never need a real process). */
  readonly isProcessAlive: (pid: number) => boolean;
}

export function acquireLiveShadowLock(dir: string, deps: LockDeps): ScannerLock {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LIVE_SHADOW_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx");
      try {
        writeSync(fd, `${canonicalJson({ schema: LIVE_SHADOW_LOCK_SCHEMA, pid: deps.pid, owner: deps.owner, startedAt: deps.startedAt })}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        file,
        release: () => {
          if (released) return;
          released = true;
          // Only remove our own lock.
          try {
            const held = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
            if (held.pid === deps.pid) unlinkSync(file);
          } catch {
            // Already gone or unreadable: nothing of ours to remove.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder: { pid?: unknown; owner?: unknown };
      try {
        holder = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; owner?: unknown };
      } catch {
        throw new ScannerLockError("LOCK_UNREADABLE", `${file} exists but cannot be read; remove it only after confirming no scanner owns this symbol`);
      }
      if (typeof holder.pid !== "number" || !Number.isSafeInteger(holder.pid)) {
        throw new ScannerLockError("LOCK_UNREADABLE", `${file} names no process id`);
      }
      if (deps.isProcessAlive(holder.pid)) {
        throw new ScannerLockError("LOCKED_BY_LIVE_PROCESS", `this symbol is owned by live process ${holder.pid} (${String(holder.owner)})`);
      }
      // Stale: its owner is gone. Remove it and try once more; a racing reclaimer loses on EEXIST.
      if (existsSync(file)) unlinkSync(file);
    }
  }
  throw new ScannerLockError("LOCKED_BY_LIVE_PROCESS", `${file} was re-taken while reclaiming a stale lock`);
}
