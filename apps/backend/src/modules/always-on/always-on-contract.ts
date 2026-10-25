/**
 * ALWAYS-ON MONITORING V1 — the contract: names, schemas, states and policy
 * constants shared by the supervisor, its status artifact, its CLI and the
 * runtime launcher. Pure data; nothing here touches a process or a file.
 *
 * MONITORING ONLY. NO ACCOUNT EXECUTION. NATIVE EXECUTION HARD-DISABLED.
 *
 * The supervisor owns the monitoring DATA PLANE and nothing else: the generic
 * backend (non-watch), the Native live-shadow scanner, the Native multi-symbol
 * emitter (COMMIT + follow: DASHBOARD WRITES ONLY) and the Native planner
 * (PLANNING ONLY). It never starts an account role, never reads a credential,
 * never calls a signed endpoint, and its child processes are spawned with every
 * account/credential variable removed from their environment.
 */

export const ALWAYS_ON_STATUS_SCHEMA = "teddy.native-monitoring.always-on-status.v1";
export const ALWAYS_ON_INCIDENT_SCHEMA = "teddy.native-monitoring.always-on-incident.v1";
export const ALWAYS_ON_OWNERSHIP_SCHEMA = "teddy.native-monitoring.always-on-ownership.v1";
export const ALWAYS_ON_REQUEST_SCHEMA = "teddy.native-monitoring.always-on-request.v1";

/** Printed by every Always-On surface (CLI banner, status artifact, launcher). */
export const ALWAYS_ON_NOTICE = Object.freeze(["MONITORING ONLY", "NO ACCOUNT EXECUTION", "NATIVE EXECUTION HARD-DISABLED"] as const);

/** The roles the supervisor can own, in START order (stop order is the reverse). */
export const ALWAYS_ON_ROLES = Object.freeze(["backend", "scanner", "emitter", "planner"] as const);
export type AlwaysOnRole = (typeof ALWAYS_ON_ROLES)[number];

export const ALWAYS_ON_ROLE_LABELS: Readonly<Record<AlwaysOnRole, string>> = Object.freeze({
  backend: "Generic Backend (non-watch)",
  scanner: "Native Live-Shadow Scanner",
  emitter: "Native Multi-Symbol Emitter (COMMIT, follow)",
  planner: "Native Planner (planning only)",
});

/**
 * The supervisor as a whole.
 *
 *  STARTING   — taking ownership; no role has been judged yet.
 *  RUNNING    — every owned role is healthy (normal running).
 *  DEGRADED   — something is unhealthy, blocked, or in conflict; nothing is being restarted right now.
 *  RECOVERING — a fenced restart or the scanner recovery sequence is in progress.
 *  BACKOFF    — a restart is due but its backoff has not elapsed (no process is being spawned).
 *  LATCHED    — a role exhausted its recovery attempts: no further automatic restarts (failed/latching).
 *  STOPPING   — a graceful stop of the owned stack is in progress.
 *  STOPPED    — nothing is owned; the supervisor has exited (or is about to).
 */
export const ALWAYS_ON_SUPERVISOR_STATES = Object.freeze(["STARTING", "RUNNING", "DEGRADED", "RECOVERING", "BACKOFF", "LATCHED", "STOPPING", "STOPPED"] as const);
export type AlwaysOnSupervisorState = (typeof ALWAYS_ON_SUPERVISOR_STATES)[number];

/** The public stream probe's answer: UNREACHABLE only on positive evidence of failure; UNKNOWN never suppresses a recovery. */
export type PublicStreamProbeOutcome = "REACHABLE" | "UNREACHABLE" | "UNKNOWN";

/**
 * One role.
 *
 *  OFF        — not running and not wanted yet (or not owned by this configuration).
 *  STARTING   — spawned; waiting for its first evidence of health.
 *  RUNNING    — healthy.
 *  DEGRADED   — unhealthy, inside its grace period or for a reason a restart cannot fix.
 *  RECOVERING — being stopped and/or restarted by the supervisor.
 *  BACKOFF    — a restart is due; waiting out the backoff.
 *  LATCHED    — automatic recovery stopped after repeated failure; operator required.
 *  CONFLICT   — a process the supervisor does not own is doing this role's job; it is reported, never killed.
 *  BLOCKED    — a dependency is not ready (the scanner run, the backend, a fresh build, the data store).
 *  STOPPING   — part of a graceful stop.
 *  DISABLED   — excluded from this supervisor by configuration (--roles).
 */
export const ALWAYS_ON_ROLE_STATES = Object.freeze(["OFF", "STARTING", "RUNNING", "DEGRADED", "RECOVERING", "BACKOFF", "LATCHED", "CONFLICT", "BLOCKED", "STOPPING", "DISABLED"] as const);
export type AlwaysOnRoleState = (typeof ALWAYS_ON_ROLE_STATES)[number];

/**
 * Credential and identity variables NO monitoring child may inherit. The
 * operator's established pattern strips these five before starting a scanner
 * or emitter; the supervisor enforces it for every child it spawns, on top of
 * the launcher's own account-key sanitiser.
 */
export const STRIPPED_CREDENTIAL_KEYS = Object.freeze(["BINANCE_API_KEY", "BINANCE_API_SECRET", "EXECUTION_PROFILE_ACCOUNT_IDENTIFIER", "API_KEY", "API_SECRET"] as const);

/**
 * The supervisor's single-instance authority: an exclusive loopback listener
 * held for the supervisor's whole life (the OS releases it on any exit, so
 * there is no stale owner to infer). Clear of 4000-4002 and the launcher's
 * mutation lock on 4009.
 */
export const ALWAYS_ON_INSTANCE_HOST = "127.0.0.1";
export const ALWAYS_ON_INSTANCE_PORT = 4019;

/** The profile the supervisor runs by default (the operator's documented scanner/emitter profile). */
export const ALWAYS_ON_DEFAULT_PROFILE = "teddy-7-all-active";

/**
 * Policy defaults. Every one is an operational bound — none touches strategy,
 * thresholds, planning or execution. None depends on the universe size: the
 * active Binance membership changes legitimately (524 → 522 is healthy).
 */
export const ALWAYS_ON_DEFAULTS = Object.freeze({
  /** How often the stack is observed and judged. */
  pollMs: 15_000,
  /** Faster cadence while a stop or restart is being carried out. */
  transitionPollMs: 2_000,
  /** How long a role may be unhealthy before the supervisor acts. */
  degradedGraceMs: 90_000,
  /** After connectivity returns, how long the scanner gets to heal itself before a fresh run is started. */
  postNetworkGraceMs: 120_000,
  /** How often the public connectivity probe may run while the scanner is degraded. */
  connectivityProbeEveryMs: 30_000,
  /** Restart backoff steps (attempt 1, 2, 3, …; the last step repeats). */
  backoffStepsMs: Object.freeze([30_000, 60_000, 120_000, 300_000, 600_000, 900_000]),
  /** Recovery attempts (since the last forgiveness) before a role LATCHES. */
  maxRecoveryAttempts: 6,
  /** Continuous health that forgives the attempt counter. */
  healthyForgivenessMs: 30 * 60_000,
  /** A scanner start-up (FAST_RECOVERY_V1 replay, manifest, first status) may take this long. */
  scannerStartupTimeoutMs: 45 * 60_000,
  /** The scanner writes status.json every 60 s by default; older than this proves nothing. */
  scannerStatusFreshMs: 180_000,
  /** The newest per-symbol market message must be at least this recent across the universe. */
  marketDataFreshMs: 180_000,
  /** Quarantine of the current bar is expected after (re)connects; persisting this long is degraded. */
  quarantinePersistentMs: 35 * 60_000,
  /** The emitter writes status every 30 s (and during catch-up); older than this proves nothing. */
  emitterStatusFreshMs: 5 * 60_000,
  /** An emitter that is alive but has not written status for this long is hung and restarted. */
  emitterHungMs: 10 * 60_000,
  /** A fresh emitter must write its first status within this. */
  emitterStartupTimeoutMs: 10 * 60_000,
  /** A queue at or above this fraction of capacity, or lanes behind their log, is a large backlog. */
  largeBacklogFraction: 0.5,
  /** Cooperative stop windows before the fenced (forced) stop. */
  emitterStopWaitMs: 90_000,
  scannerStopWaitMs: 180_000,
  /** The backend must answer /health within this after starting, and may fail it this long before a restart. */
  backendStartupTimeoutMs: 120_000,
  backendGraceMs: 120_000,
  /** Planner heartbeat may be absent this long (process alive) before the planner is restarted. */
  plannerGraceMs: 120_000,
  /** Pending Native plans present continuously this long are a persistent backlog. */
  plannerPendingPersistentMs: 15 * 60_000,
  /** One HTTP read of the local backend. */
  httpTimeoutMs: 5_000,
  /** A sleep/hibernate is assumed when one tick follows the previous after more than this many poll intervals. */
  resumeGapPolls: 4,
  emitterQueueCapacity: 10_000,
});

/** The policy shape: the defaults' keys, with operator-tunable number values (not the defaults' literal types). */
export type AlwaysOnPolicy = {
  readonly [K in keyof typeof ALWAYS_ON_DEFAULTS]: (typeof ALWAYS_ON_DEFAULTS)[K] extends number ? number : readonly number[];
};

/** The delay before restart attempt `attempt` (1-based). */
export function backoffDelayMs(policy: Pick<AlwaysOnPolicy, "backoffStepsMs">, attempt: number): number {
  const steps = policy.backoffStepsMs;
  if (steps.length === 0) return 0;
  return steps[Math.min(Math.max(attempt, 1), steps.length) - 1];
}
