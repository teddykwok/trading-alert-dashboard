/**
 * The Native planner worker's liveness HEARTBEAT, in Redis.
 *
 * One key, written by the one worker, read by the generic backend's read-only
 * status endpoint. No database row is written for it (no migration), and it is
 * not an account attestation: the planner holds no account and arms nothing.
 *
 *  - published on start, then every NATIVE_PLANNER_HEARTBEAT_INTERVAL_MS;
 *  - expires on its own (TTL) if the process dies without cleaning up;
 *  - deleted on a graceful shutdown, but only if it is still this process's.
 *
 * It carries no secret, no path, no host and no account. The pid is stored so
 * a shutdown never deletes a successor's key; the public status never echoes it.
 */

export const NATIVE_PLANNER_HEARTBEAT_KEY = "native-planner:heartbeat";
export const NATIVE_PLANNER_HEARTBEAT_SCHEMA = "teddy.native-planner.heartbeat.v1";
export const NATIVE_PLANNER_HEARTBEAT_INTERVAL_MS = 15_000;
/** Redis expiry: a dead process's key disappears without anyone deleting it. */
export const NATIVE_PLANNER_HEARTBEAT_TTL_SECONDS = 60;
/** Older than this (but not yet expired) reads as STALE. */
export const NATIVE_PLANNER_HEARTBEAT_STALE_MS = 45_000;

export interface NativePlannerSweepView {
  readonly at: string;
  readonly phase: "STARTUP" | "PERIODIC";
  readonly inspected: number;
  readonly recovered: number;
  readonly alreadyQueued: number;
  readonly closedAsError: number;
  readonly queueUnavailable: boolean;
}

export interface NativePlannerHeartbeat {
  readonly schema: typeof NATIVE_PLANNER_HEARTBEAT_SCHEMA;
  readonly role: "native-planner";
  readonly queue: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly beatAt: string;
  /** BullMQ's own answer: is the queue consumer running. */
  readonly consumerRunning: boolean;
  readonly lastSweep: NativePlannerSweepView | null;
  /** A failed sweep's error NAME only. */
  readonly lastSweepError: string | null;
  readonly nativeExecutionEnabled: false;
}

/** The three Redis calls the heartbeat needs. ioredis satisfies it; tests use a map. */
export interface HeartbeatStore {
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

export interface HeartbeatPublisherDeps {
  readonly store: HeartbeatStore;
  readonly queue: string;
  readonly pid: number;
  readonly consumerRunning: () => boolean;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  readonly ttlSeconds?: number;
  /** Content-free: an error NAME, never a value. */
  readonly log?: (line: string) => void;
}

export interface HeartbeatPublisher {
  start(): Promise<void>;
  recordSweep(sweep: NativePlannerSweepView | { readonly errorName: string }): void;
  /** One heartbeat now. Never throws. */
  publish(): Promise<boolean>;
  /** Stops beating and deletes the key if it is still ours. Never throws. */
  stop(): Promise<void>;
  readonly current: NativePlannerHeartbeat;
}

export function createHeartbeatPublisher(deps: HeartbeatPublisherDeps): HeartbeatPublisher {
  const now = deps.now ?? (() => new Date());
  const intervalMs = deps.intervalMs ?? NATIVE_PLANNER_HEARTBEAT_INTERVAL_MS;
  const ttlSeconds = deps.ttlSeconds ?? NATIVE_PLANNER_HEARTBEAT_TTL_SECONDS;
  const startedAt = now().toISOString();
  let lastSweep: NativePlannerSweepView | null = null;
  let lastSweepError: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const snapshot = (): NativePlannerHeartbeat => ({
    schema: NATIVE_PLANNER_HEARTBEAT_SCHEMA,
    role: "native-planner",
    queue: deps.queue,
    pid: deps.pid,
    startedAt,
    beatAt: now().toISOString(),
    consumerRunning: deps.consumerRunning(),
    lastSweep,
    lastSweepError,
    nativeExecutionEnabled: false,
  });

  const publish = async (): Promise<boolean> => {
    if (stopped) return false;
    try {
      await deps.store.set(NATIVE_PLANNER_HEARTBEAT_KEY, JSON.stringify(snapshot()), ttlSeconds);
      return true;
    } catch (error) {
      deps.log?.(`native planner heartbeat not published (${error instanceof Error ? error.name : "unknown"})`);
      return false;
    }
  };

  return {
    async start() {
      await publish();
      timer = setInterval(() => void publish(), intervalMs);
      // Liveness is held by the BullMQ worker's connection; the heartbeat must never keep a stopping process alive.
      timer.unref?.();
    },
    recordSweep(sweep) {
      if ("errorName" in sweep) {
        lastSweepError = sweep.errorName;
      } else {
        lastSweep = sweep;
        lastSweepError = null;
      }
    },
    publish,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      try {
        const raw = await deps.store.get(NATIVE_PLANNER_HEARTBEAT_KEY);
        const held = raw === null ? null : (JSON.parse(raw) as { pid?: unknown });
        if (held !== null && held.pid === deps.pid) await deps.store.del(NATIVE_PLANNER_HEARTBEAT_KEY);
      } catch {
        // The TTL removes it anyway.
      }
    },
    get current() {
      return snapshot();
    },
  };
}

export type NativePlannerWorkerState = "RUNNING" | "STALE" | "OFF" | "UNREADABLE";

export interface NativePlannerWorkerView {
  readonly state: NativePlannerWorkerState;
  readonly reason: string;
  readonly startedAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly ageSeconds: number | null;
  readonly consumerRunning: boolean | null;
  readonly lastSweep: NativePlannerSweepView | null;
  readonly lastSweepError: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Judges a raw heartbeat value. Pure. Only a fresh, well-formed heartbeat whose
 * consumer is running reads RUNNING; no key is OFF (never started, stopped, or
 * dead long enough to expire); anything malformed is UNREADABLE, never RUNNING.
 */
export function judgeNativePlannerHeartbeat(raw: string | null, nowMs: number): NativePlannerWorkerView {
  const none = { startedAt: null, lastHeartbeatAt: null, ageSeconds: null, consumerRunning: null, lastSweep: null, lastSweepError: null };
  if (raw === null) return { ...none, state: "OFF", reason: "No Native planner heartbeat: the worker is not running (or stopped long enough for its heartbeat to expire)." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...none, state: "UNREADABLE", reason: "The Native planner heartbeat could not be parsed." };
  }
  if (!isRecord(parsed) || parsed.schema !== NATIVE_PLANNER_HEARTBEAT_SCHEMA || typeof parsed.beatAt !== "string" || typeof parsed.startedAt !== "string") {
    return { ...none, state: "UNREADABLE", reason: "The Native planner heartbeat has an unknown shape." };
  }
  const beatMs = Date.parse(parsed.beatAt);
  if (!Number.isFinite(beatMs)) return { ...none, state: "UNREADABLE", reason: "The Native planner heartbeat has no valid time." };
  const ageMs = Math.max(0, nowMs - beatMs);
  const view = {
    startedAt: parsed.startedAt,
    lastHeartbeatAt: parsed.beatAt,
    ageSeconds: Math.round(ageMs / 1000),
    consumerRunning: typeof parsed.consumerRunning === "boolean" ? parsed.consumerRunning : null,
    lastSweep: isRecord(parsed.lastSweep) ? (parsed.lastSweep as unknown as NativePlannerSweepView) : null,
    lastSweepError: typeof parsed.lastSweepError === "string" ? parsed.lastSweepError : null,
  };
  if (ageMs > NATIVE_PLANNER_HEARTBEAT_STALE_MS) return { ...view, state: "STALE", reason: `The last heartbeat is ${view.ageSeconds}s old.` };
  if (view.consumerRunning !== true) return { ...view, state: "STALE", reason: "The worker is alive but reports its queue consumer is not running." };
  return { ...view, state: "RUNNING", reason: "Fresh heartbeat; queue consumer running." };
}
