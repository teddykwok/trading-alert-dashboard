import path from "node:path";

import { assertOutsideRepository } from "./scanner-paths";

/**
 * COOPERATIVE STOP for the long-running Native monitoring processes (the
 * live-shadow supervisor and the multi-symbol emitter).
 *
 * ## Why a file, not a signal
 *
 * On Windows a parent cannot deliver Ctrl+C to a detached child: `process.kill`
 * with any signal terminates it abruptly, and `taskkill /F` skips the graceful
 * path — the scanner's kline-cache flush and final STOPPED status, the
 * emitter's cursor persistence of everything it processed. So a supervisor that
 * owns these processes asks them to stop by creating ONE file whose exact path
 * it handed the child at spawn time (`--stop-file <path>`); the child polls for
 * it and runs its own, existing graceful stop — the same one Ctrl+C runs.
 *
 * A fresh path is used for every spawned child, so a stale request can never
 * stop a newer process. The path must be absolute and outside the repository.
 * Nothing here reads the file's content, deletes it, or kills anything.
 */

export class CooperativeStopUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CooperativeStopUsageError";
  }
}

/** Validates a `--stop-file` value: absolute, outside the repository, a plain file name. */
export function validateStopFilePath(value: string, repoRoot: string): string {
  if (!path.isAbsolute(value)) throw new CooperativeStopUsageError("--stop-file must be an absolute path");
  if (!/\.stop$/i.test(path.basename(value))) throw new CooperativeStopUsageError("--stop-file must name a file ending in .stop");
  try {
    return assertOutsideRepository(value, repoRoot);
  } catch {
    throw new CooperativeStopUsageError("--stop-file must live outside the repository");
  }
}

export interface CooperativeStopWatch {
  /** Stops watching (idempotent). */
  close(): void;
}

/**
 * Polls for `file`; the first time it exists, calls `onStop` once and stops
 * watching. Timers and the existence check are injected so the behaviour is
 * testable without a clock or a file system.
 */
export function watchCooperativeStop(input: {
  readonly file: string;
  readonly onStop: () => void;
  readonly exists: (file: string) => boolean;
  readonly every: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
  readonly cancel: (handle: unknown) => void;
  readonly intervalMs?: number;
}): CooperativeStopWatch {
  let closed = false;
  const handle = input.every(() => {
    if (closed) return;
    let requested = false;
    try {
      requested = input.exists(input.file);
    } catch {
      requested = false;
    }
    if (!requested) return;
    closed = true;
    input.cancel(handle);
    input.onStop();
  }, input.intervalMs ?? 1_000);
  (handle as { unref?: () => void } | null)?.unref?.();
  return {
    close: () => {
      if (closed) return;
      closed = true;
      input.cancel(handle);
    },
  };
}
