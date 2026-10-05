/**
 * The machine-wide MUTATION authority for the runtime launcher.
 *
 * ## The race this closes
 *
 * The transition journal makes ONE transition crash-durable. It does not stop
 * a SECOND launcher process starting its own. Two launchers opened side by
 * side both read `transition = NONE`, both pass their preconditions, and both
 * proceed -- and because a human confirmation sits in the middle of that
 * window, it is seconds or minutes wide, not microseconds. Two transitions
 * aimed at OPPOSITE modes on the same account would then interleave a gate
 * rewrite with a role restart, and the account would end up running one mode
 * with the other one on disk.
 *
 * So every action that mutates runtime, process or environment state takes
 * this authority first, and holds it across the confirmation. Reading status
 * does not.
 *
 * ## Why a socket, and not a lock FILE
 *
 * A lock file was the obvious answer and it was wrong. `open(..., "wx")` is a
 * genuine atomic create, so two launchers can never both create the file --
 * but a file lock must also be RECOVERABLE, because a crashed launcher leaves
 * its file behind. Recovery means proving the recorded owner is dead and then
 * removing the file, and that removal is the hole:
 *
 *   - A reads the stale lock L0 and proves its owner dead.
 *   - B proves the same thing first, removes L0, and creates its own live lock
 *     L_B. B now holds authority and starts mutating.
 *   - A resumes and removes "the lock" -- which is now L_B, not L0. Whether it
 *     unlinks or renames it aside, the path is briefly EMPTY.
 *   - C creates the lock successfully and believes it holds authority.
 *
 *   B and C are now mutating at the same time. A noticing afterwards that what
 *   it took was not L0, and putting it back, does not undo C's acquisition.
 *
 * The missing primitive is "remove this path only if it STILL holds instance
 * L0" -- a compare-and-swap that portable filesystem calls do not offer. No
 * amount of re-reading supplies it; each extra read only narrows a window that
 * stays open.
 *
 * A listening socket has no such problem, because there is nothing to recover.
 * The OS holds the binding and the OS releases it when the process dies, for
 * any reason, with no cooperation from the dying process. There is no stale
 * owner to infer, no pid to observe, no creation time to compare, no reused
 * pid to reason about -- and, crucially, no file anyone can delete to hand
 * themselves authority.
 *
 * ## Loopback only
 *
 * The listener binds 127.0.0.1 and nothing else. It is a mutex, not a service:
 * binding a routable address would publish a port to the network for no
 * reason, from the process that arms a real-money runtime.
 *
 * ## A port held by something else
 *
 * If an unrelated program holds the port, this refuses. That is an
 * availability failure, and refusing is the right answer to it -- there is no
 * version of "evict whatever is on the port" that is safe when the thing being
 * protected is a live trading runtime.
 *
 * ## What this does NOT replace
 *
 * The transition journal. The mutex serialises launcher PROCESSES; the journal
 * makes one account transition crash-durable. A crash releases the mutex
 * instantly and correctly, and the account is still half-moved -- which is
 * exactly what the journal is for.
 */

/** Every launcher action that changes runtime, process or environment state. */
export const MUTATION_ACTIONS = [
  "START_SAFE",
  "STOP_RUNTIME",
  "PREPARE_LIVE_READY",
  "RETURN_TO_SAFE",
  "RECOVER_TRANSITION",
  "SUPERVISE_RESTART",
  // The OPTIONAL Native planner role's own explicit start / stop (never part of Start SAFE).
  "NATIVE_PLANNER_START",
  "NATIVE_PLANNER_STOP",
  // The generic backend's explicit NON-WATCH start / stop (never part of Start SAFE).
  "GENERIC_BACKEND_NONWATCH_START",
  "GENERIC_BACKEND_NONWATCH_STOP",
] as const;

export type MutationAction = (typeof MUTATION_ACTIONS)[number];

/**
 * The loopback address the mutex binds.
 *
 * Constants rather than configuration: two launchers pointed at different
 * ports would not exclude each other, which is the one thing this exists to
 * do. 4009 is clear of the six-role ports (4000, 4001, 4002) and near enough
 * to them that an operator reading a `netstat` recognises it as this tool's.
 */
export const MUTATION_LOCK_HOST = "127.0.0.1";
export const MUTATION_LOCK_PORT = 4009;

export type AuthorityRefusal = "BUSY" | "UNAVAILABLE" | "UNKNOWN";

/**
 * Turns a bind failure into a decision. Pure, so every case is testable.
 *
 * Every one of them refuses; the distinction is only what the operator is
 * told. EADDRINUSE is the ordinary case -- another launcher, or conceivably an
 * unrelated program -- and neither is a reason to proceed, nor to evict.
 */
export function classifyBindFailure(code: string | undefined): AuthorityRefusal {
  if (code === "EADDRINUSE") return "BUSY";
  if (code === "EACCES" || code === "EPERM") return "UNAVAILABLE";
  return "UNKNOWN";
}

export interface AuthorityHeld {
  readonly action: MutationAction;
  /** Gives the authority back. Idempotent; a failure is reported, never thrown. */
  release(): Promise<{ readonly released: boolean; readonly reason?: string }>;
}

export type AcquireResult =
  | { readonly ok: true; readonly held: AuthorityHeld }
  | { readonly ok: false; readonly outcome: AuthorityRefusal; readonly reasons: readonly string[] };

/**
 * The one capability this module needs from the machine.
 *
 * Injected so the state machine above it is behaviour-tested without binding
 * real ports, while one integration test exercises real EADDRINUSE semantics.
 */
export interface MutationAuthority {
  acquire(action: MutationAction): Promise<AcquireResult>;
}

export interface MutationLockAdapters {
  readonly authority: MutationAuthority;
  readonly log: (line: string) => void;
}

export type WithAuthorityResult<T> =
  | { readonly ran: true; readonly result: T }
  | { readonly ran: false; readonly outcome: AuthorityRefusal; readonly reasons: readonly string[] };

/**
 * Runs one mutating action while holding machine-wide authority.
 *
 * The single place acquire and release are paired, so no caller can hold
 * authority past its work or forget to take it. A refusal returns
 * `ran: false`, and the caller mutates nothing.
 *
 * Release happens in a `finally`, so a throwing action still gives authority
 * back -- and if the process dies instead, the OS gives it back anyway.
 */
export async function withMutationLock<T>(
  action: MutationAction,
  adapters: MutationLockAdapters,
  run: () => Promise<T>
): Promise<WithAuthorityResult<T>> {
  const acquired = await adapters.authority.acquire(action);
  if (!acquired.ok) return { ran: false, outcome: acquired.outcome, reasons: acquired.reasons };

  adapters.log(`mutation lock: acquired for ${action}`);
  try {
    return { ran: true, result: await run() };
  } finally {
    const released = await acquired.held.release();
    if (released.released) {
      adapters.log(`mutation lock: released after ${action}`);
    } else {
      // Worth saying, and not worth alarm: the binding goes away when this
      // process does, so nothing can be permanently wedged by it.
      adapters.log(`mutation lock: ${released.reason ?? "the authority could not be released cleanly"}`);
      adapters.log("mutation lock: it is released when this launcher exits, whatever happens.");
    }
  }
}

// ---------------------------------------------------------------------------
// The real authority: an exclusive loopback binding
// ---------------------------------------------------------------------------

/** The two calls the real implementation makes, so a test can supply them. */
export interface ListenerHandle {
  /** Resolves once bound; rejects with an errno-bearing error otherwise. */
  listen(host: string, port: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Machine-wide authority backed by an exclusive loopback binding.
 *
 * Nothing here needs cleaning up. There is no file, no recorded owner and no
 * staleness: the binding lasts exactly as long as the process holding it, and
 * a crash releases it as reliably as a clean exit.
 */
export function listenerAuthority(
  openListener: () => ListenerHandle,
  options: { readonly host?: string; readonly port?: number } = {}
): MutationAuthority {
  const host = options.host ?? MUTATION_LOCK_HOST;
  const port = options.port ?? MUTATION_LOCK_PORT;

  return {
    acquire: async (action) => {
      const handle = openListener();
      try {
        await handle.listen(host, port);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const outcome = classifyBindFailure(code);
        // A failed bind should leave nothing behind either.
        try {
          await handle.close();
        } catch {
          // Nothing was bound; there is nothing to close.
        }
        return {
          ok: false,
          outcome,
          reasons: [
            outcome === "BUSY"
              ? `another launcher on this machine holds mutation authority (${host}:${port} is in use).`
              : `mutation authority could not be taken on ${host}:${port} (${code ?? "unknown"}).`,
          ],
        };
      }

      let released = false;
      return {
        ok: true,
        held: {
          action,
          release: async () => {
            if (released) return { released: true };
            try {
              await handle.close();
              released = true;
              return { released: true };
            } catch (error) {
              const code = (error as NodeJS.ErrnoException)?.code;
              return {
                released: false,
                reason: `the mutation listener could not be closed (${code ?? "unknown"})`,
              };
            }
          },
        },
      };
    },
  };
}
