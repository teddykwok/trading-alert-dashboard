/**
 * The execution worker's liveness and its fatal-diagnostic handlers.
 *
 * Two small, separate concerns that share one property: both exist because a
 * long-lived authority process must not be able to disappear quietly.
 *
 * Neither of them makes the worker HEALTHY. Health is attestation, and
 * attestation is gated on `isReconciliationHealthy` — a worker whose
 * reconciliation has stalled stops attesting whether or not it is still
 * running. Keeping the process alive and claiming the process is well are
 * different statements, and only the first is made here.
 */

import { writeSync } from "node:fs";

/**
 * How often the keepalive wakes. It does nothing when it does.
 *
 * The interval is long because its only job is to exist: a referenced handle
 * on the event loop. A short interval would burn wakeups to achieve exactly
 * the same thing.
 */
export const WORKER_KEEPALIVE_INTERVAL_MS = 60_000;

export interface WorkerLiveness {
  /** Releases the handle so a clean shutdown can actually finish. */
  stop(): void;
  /** Test-only introspection. Never consulted by health or attestation. */
  readonly running: boolean;
  /**
   * Whether the handle actually holds the event loop open.
   *
   * The entire point of this object is a REFERENCED handle; an `unref()`'d
   * timer would look identical from the outside while keeping nothing alive.
   * Still not a health signal -- it says the process will not exit, not that
   * the process is well.
   */
  readonly referenced: boolean;
}

/**
 * Holds the Node event loop open for as long as the worker is meant to run.
 *
 * ## Why this is needed at all
 *
 * Every timer the worker owns is `unref()`'d — orchestration, plan adoption,
 * historical fill, the attestation heartbeat and its Redis retry. None of them
 * keeps the process alive. What actually kept it alive was the Prisma and
 * Redis sockets, which is an accident: if those handles ever released, the
 * event loop would drain and the process would exit ZERO, with no error, no
 * log line and no signal — indistinguishable from a clean shutdown nobody
 * asked for.
 *
 * So liveness becomes explicit and owned by the lifecycle, rather than a side
 * effect of a connection pool. The individual `unref()` calls are deliberately
 * left alone: they are correct for what they are (retry and polling timers
 * that must not by themselves prevent exit), and removing them would make
 * shutdown depend on clearing every one of them.
 *
 * ## What it is NOT
 *
 * It is not a health signal, it publishes nothing, and it is not consulted by
 * attestation. A worker held alive by this while its reconciliation is broken
 * still withdraws its attestation and is still recoverable by supervision —
 * which is the point of keeping the two ideas apart.
 */
export function startWorkerLiveness(
  intervalMs: number = WORKER_KEEPALIVE_INTERVAL_MS
): WorkerLiveness {
  // Deliberately NOT unref()'d. This is the one referenced handle.
  let timer: NodeJS.Timeout | null = setInterval(() => {
    // Intentionally empty. The handle is the product.
  }, intervalMs);

  return {
    get running() {
      return timer !== null;
    },
    get referenced() {
      return timer !== null && (timer.hasRef?.() ?? false);
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Fatal diagnostics
// ---------------------------------------------------------------------------

/**
 * Credential-shaped values, blanked before anything is written.
 *
 * A fatal error's message is the one place an endpoint, a connection string or
 * a key can escape: Prisma puts the datasource URL in some of its errors, and
 * an HTTP client can quote a signed query string. The stack is paths and
 * function names and is left intact, because that is what makes the record
 * worth having.
 */
export function redactSecrets(text: string): string {
  return text
    // scheme://user:password@host
    .replace(/(\w+:\/\/)[^:@\s/]+:[^@\s/]+@/g, "$1***:***@")
    // key=value for anything that smells like a credential
    .replace(/([?&](?:signature|api[_-]?key|apikey|secret|token|password|pwd)=)[^&\s]+/gi, "$1***")
    // bare assignments in a message, e.g. BINANCE_API_SECRET=abc
    .replace(/((?:API_KEY|API_SECRET|SECRET|TOKEN|PASSWORD)\s*[=:]\s*)\S+/gi, "$1***");
}

/** One line per fatal event, already redacted. Exported for testing. */
export function describeFatal(kind: string, error: unknown, nowIso: string): string {
  // A rejection reason is not required to be an Error. `String(reason)` on a
  // plain object gives "[object Object]", which records nothing, so the shape
  // is normalised rather than assumed.
  let name = "unknown";
  let message = "";
  let stack = "";
  if (error instanceof Error) {
    name = error.name;
    message = error.message;
    stack = error.stack ?? "";
  } else if (typeof error === "string") {
    name = "string";
    message = error;
  } else {
    name = error === null ? "null" : typeof error;
    try {
      message = JSON.stringify(error) ?? String(error);
    } catch {
      message = String(error);
    }
  }

  const body = [
    `[${nowIso}] FATAL ${kind}: ${name}`,
    message === "" ? null : `  message: ${message.slice(0, 2000)}`,
    stack === "" ? null : `  stack:\n${stack.slice(0, 8000)}`,
    "  This process is exiting. Its runtime authority is gone until it is restarted.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return `${redactSecrets(body)}\n`;
}

export interface FatalHandlerOptions {
  /** Defaults to writing synchronously to fd 2. */
  readonly write?: (text: string) => void;
  /** Defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  readonly now?: () => Date;
}

/**
 * Installs the handlers that turn a silent death into a recorded one.
 *
 * ## Why this writes synchronously to fd 2 rather than through the logger
 *
 * The application logger is pino with a `pino-pretty` transport, and a
 * transport is a worker thread: its writes are asynchronous and are not
 * guaranteed to be flushed before the process leaves. During an
 * `uncaughtException` that guarantee is exactly what is needed and exactly
 * what is missing, and `logger.flush()` on a transport is itself asynchronous.
 *
 * `writeSync(2, …)` has no such problem. It returns when the bytes are handed
 * to the OS, and since the launcher now points fd 2 at a real file, the record
 * lands on disk before the exit. The logger is not used here at all — not as a
 * fallback either, because a half-working logger is precisely what would eat
 * the message.
 *
 * ## Once only
 *
 * A fatal handler that throws, or that triggers a second fatal event while
 * running, must not recurse. The guard makes the first event the one that is
 * recorded and every later one a no-op, so the file records the cause rather
 * than a cascade.
 *
 * Nothing is swallowed: every path exits non-zero.
 */
export function installFatalHandlers(options: FatalHandlerOptions = {}): { readonly installed: boolean } {
  const write = options.write ?? ((text: string) => writeSync(2, text));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const now = options.now ?? (() => new Date());

  let fired = false;
  const fatal = (kind: string) => (error: unknown) => {
    if (fired) return;
    fired = true;
    try {
      write(describeFatal(kind, error, now().toISOString()));
    } catch {
      // Even the diagnostic failed. Exiting is still correct, and is the one
      // thing that must happen whatever else does not.
    }
    exit(1);
  };

  process.on("uncaughtException", fatal("uncaughtException"));
  process.on("unhandledRejection", fatal("unhandledRejection"));
  return { installed: true };
}
