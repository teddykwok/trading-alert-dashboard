/**
 * Read-only list loading for tables whose query changes quickly (search,
 * filters, pages). Framework-free so the rules can be tested without a DOM:
 *
 *  - only the NEWEST request may publish: a slower, older response never
 *    overwrites a newer one, and a superseded request is aborted;
 *  - the same request is never sent twice while it is in flight, so an
 *    unstable re-render cannot turn into a fetch loop; a refresh is explicit;
 *  - after dispose nothing publishes at all (no state update after unmount).
 */

export type LoaderStatus = "idle" | "loading" | "ready" | "error";

export interface LoaderState<T> {
  readonly status: LoaderStatus;
  /** The request the status describes. */
  readonly key: string | null;
  /** The newest data that arrived, for whichever key it was (shown dimmed while a newer request loads). */
  readonly data: T | null;
  /** The key `data` belongs to. */
  readonly dataKey: string | null;
  readonly message: string | null;
}

export const IDLE_LOADER_STATE: LoaderState<never> = Object.freeze({ status: "idle", key: null, data: null, dataKey: null, message: null });

export type CancellableFetcher<T> = (key: string, signal: AbortSignal) => Promise<T>;

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The request failed.";
}

export class LatestOnlyLoader<T> {
  private controller: AbortController | null = null;
  private generation = 0;
  private inFlightKey: string | null = null;
  private state: LoaderState<T> = IDLE_LOADER_STATE;

  constructor(
    private readonly fetcher: CancellableFetcher<T>,
    private readonly publish: (state: LoaderState<T>) => void
  ) {}

  current(): LoaderState<T> {
    return this.state;
  }

  /** Requests `key`, aborting anything older. A key already in flight is not requested again unless forced. */
  load(key: string, force = false): void {
    if (!force && key === this.inFlightKey) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const mine = ++this.generation;
    this.inFlightKey = key;
    this.set({ ...this.state, status: "loading", key, message: null });

    let pending: Promise<T>;
    try {
      pending = this.fetcher(key, controller.signal);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (data) => {
        if (mine !== this.generation) return;
        this.inFlightKey = null;
        this.controller = null;
        this.set({ status: "ready", key, data, dataKey: key, message: null });
      },
      (error: unknown) => {
        if (mine !== this.generation) return;
        this.inFlightKey = null;
        this.controller = null;
        this.set({ ...this.state, status: "error", key, message: messageOf(error) });
      }
    );
  }

  /** Aborts whatever is in flight; nothing published after this. */
  dispose(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.inFlightKey = null;
  }

  private set(state: LoaderState<T>): void {
    this.state = state;
    this.publish(state);
  }
}

// ---------------------------------------------------------------------------
// Debounce (search boxes): one emission after the input settles
// ---------------------------------------------------------------------------

export interface Timers {
  readonly set: (callback: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const browserTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Debouncer<V> {
  /** Restarts the wait with the newest value. */
  push(value: V): void;
  /** Emits the pending value now, if any. */
  flush(): void;
  /** Drops the pending value. */
  cancel(): void;
}

export function createDebouncer<V>(waitMs: number, emit: (value: V) => void, timers: Timers = browserTimers): Debouncer<V> {
  let handle: unknown = null;
  let pending: { value: V } | null = null;
  const fire = () => {
    handle = null;
    const next = pending;
    pending = null;
    if (next !== null) emit(next.value);
  };
  return {
    push(value) {
      pending = { value };
      if (handle !== null) timers.clear(handle);
      handle = timers.set(fire, waitMs);
    },
    flush() {
      if (handle !== null) timers.clear(handle);
      fire();
    },
    cancel() {
      if (handle !== null) timers.clear(handle);
      handle = null;
      pending = null;
    },
  };
}
