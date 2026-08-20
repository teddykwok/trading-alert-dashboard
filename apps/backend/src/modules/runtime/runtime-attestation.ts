import { randomBytes } from "node:crypto";
import type Redis from "ioredis";

import { env } from "../../config/env";

/**
 * Phase 12.4D-A.1 — runtime gate attestation.
 *
 * The problem this exists for: every `execution:*` CLI is a short-lived process
 * that parses `.env` when it starts, while an already-running backend and worker
 * are still using the snapshot they parsed at THEIR startup. An operator can
 * therefore edit `.env`, run `arm-natural-window`, and have the CLI report
 * "env gates armed" while the processes that actually execute trades are still
 * running the old, different configuration. Nothing previously proved otherwise:
 * the existing preflight "runtime readiness" probes are static source-file reads
 * that return true with zero processes running.
 *
 * Each runtime process therefore publishes, on a heartbeat, the execution gate
 * values IT ACTUALLY LOADED. An activation command reads those and refuses
 * unless exactly one fresh backend and one fresh worker agree with each other
 * and with the CLI's own snapshot.
 *
 * Scope discipline — this is an OPERATOR ACTIVATION INTERLOCK, not admission
 * authority. `SafetyAdmission` remains the runtime authority for admitting a
 * trade, and protection/reconciliation must keep working even if every
 * heartbeat disappears. Nothing in this module is imported by the execution
 * runtime path.
 */

/** Bumped only on a breaking payload change. An unknown version fails closed. */
export const RUNTIME_ATTESTATION_SCHEMA_VERSION = 1;

/** Publish cadence. Two publishers total, so Redis load is negligible. */
export const RUNTIME_ATTESTATION_HEARTBEAT_MS = 5_000;

/**
 * Redis key TTL. Three missed heartbeats. The reader ALSO checks `lastSeenAt`
 * age against this same bound, so a key that outlives its content — clock skew,
 * a half-written value, a Redis that failed to expire — still fails closed.
 */
export const RUNTIME_ATTESTATION_TTL_MS = 15_000;

export const RUNTIME_ROLES = ["BACKEND", "WORKER"] as const;
export type RuntimeRole = (typeof RUNTIME_ROLES)[number];

/**
 * The gate snapshot a process loaded. Explicitly enumerated — never a spread of
 * `env` and never a dictionary of `process.env` keys, so a future secret added
 * to configuration cannot reach Redis or operator output by accident.
 */
export interface RuntimeGateSnapshot {
  globalKillSwitch: boolean;
  liveEntryEnabled: boolean;
  protectionReady: boolean;
  accountSetupMutationsEnabled: boolean;
  testOrderEnabled: boolean;
  autoAddMarginEnabled: boolean;
  emergencyCloseMode: string;
}

export interface RuntimeAttestation {
  schemaVersion: number;
  role: RuntimeRole;
  instanceId: string;
  startedAt: string;
  lastSeenAt: string;
  accountIdentifier: string;
  environment: string;
  gates: RuntimeGateSnapshot;
}

/** Only the two commands used, so tests need no Redis server. */
export interface RuntimeAttestationRedis {
  set(key: string, value: string, mode: "PX", ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  scan(cursor: string, matchToken: "MATCH", pattern: string, countToken: "COUNT", count: number): Promise<[string, string[]]>;
  get(key: string): Promise<string | null>;
}

export interface RuntimeIdentity {
  accountIdentifier: string;
  environment: string;
}

const KEY_PREFIX = "runtime:attestation";

/**
 * Scoped by execution identity AND environment, so a TESTNET process — or a
 * different account entirely — can never satisfy MAINNET activation readiness.
 */
export function runtimeAttestationKey(identity: RuntimeIdentity, role: RuntimeRole, instanceId: string): string {
  return `${KEY_PREFIX}:${identity.accountIdentifier}:${identity.environment}:${role}:${instanceId}`;
}

/**
 * The identity this process's configuration points at.
 *
 * Callers use this instead of naming `accountIdentifier` themselves: the
 * preflight CLI is structurally forbidden from mentioning the account
 * identifier at all, so that it can never be printed.
 */
export function configuredRuntimeIdentity(): RuntimeIdentity {
  return {
    accountIdentifier: env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER.trim(),
    environment: env.EXECUTION_PROFILE_ENVIRONMENT,
  };
}

export function runtimeAttestationPattern(identity: RuntimeIdentity): string {
  return `${KEY_PREFIX}:${identity.accountIdentifier}:${identity.environment}:*`;
}

/**
 * Reads the gate values THIS process already parsed at import time.
 *
 * The single most important line in the feature is that this touches `env` and
 * never the filesystem: re-reading `.env` here would reproduce exactly the bug
 * the interlock exists to catch, because a stale process would start attesting
 * values it is not actually running on.
 */
export function currentProcessGateSnapshot(): RuntimeGateSnapshot {
  return {
    globalKillSwitch: env.EXECUTION_GLOBAL_KILL_SWITCH,
    liveEntryEnabled: env.EXECUTION_LIVE_ENTRY_ENABLED,
    protectionReady: env.EXECUTION_PROTECTION_READY,
    accountSetupMutationsEnabled: env.BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED,
    testOrderEnabled: env.BINANCE_TEST_ORDER_ENABLED,
    autoAddMarginEnabled: env.EXECUTION_AUTO_ADD_MARGIN_ENABLED,
    emergencyCloseMode: env.EXECUTION_EMERGENCY_CLOSE_MODE,
  };
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

export interface RuntimeAttestationPublisherOptions {
  role: RuntimeRole;
  redis: RuntimeAttestationRedis;
  identity?: RuntimeIdentity;
  /** Captured ONCE at construction. A restart is the only way to change it. */
  gates?: RuntimeGateSnapshot;
  now?: () => Date;
  intervalMs?: number;
  ttlMs?: number;
  onError?: (error: unknown) => void;
}

export interface RuntimeAttestationPublisher {
  readonly instanceId: string;
  readonly key: string;
  publishOnce(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

/**
 * One publisher per process. The gate snapshot and instanceId are captured at
 * construction, so every subsequent heartbeat republishes the SAME snapshot with
 * only `lastSeenAt` advancing.
 */
export function createRuntimeAttestationPublisher(
  options: RuntimeAttestationPublisherOptions
): RuntimeAttestationPublisher {
  const now = options.now ?? (() => new Date());
  const identity: RuntimeIdentity = options.identity ?? {
    accountIdentifier: env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER.trim(),
    environment: env.EXECUTION_PROFILE_ENVIRONMENT,
  };
  // Frozen at construction, and COPIED: a caller that keeps a reference to the
  // object it passed must not be able to change what this process attests.
  // Only a restart may change an attested snapshot.
  const gates: RuntimeGateSnapshot = Object.freeze({ ...(options.gates ?? currentProcessGateSnapshot()) });
  const instanceId = randomBytes(8).toString("hex");
  const startedAt = now().toISOString();
  const key = runtimeAttestationKey(identity, options.role, instanceId);
  const intervalMs = options.intervalMs ?? RUNTIME_ATTESTATION_HEARTBEAT_MS;
  const ttlMs = options.ttlMs ?? RUNTIME_ATTESTATION_TTL_MS;

  let timer: NodeJS.Timeout | null = null;

  async function publishOnce(): Promise<void> {
    const payload: RuntimeAttestation = {
      schemaVersion: RUNTIME_ATTESTATION_SCHEMA_VERSION,
      role: options.role,
      instanceId,
      startedAt,
      lastSeenAt: now().toISOString(),
      accountIdentifier: identity.accountIdentifier,
      environment: identity.environment,
      gates,
    };
    await options.redis.set(key, JSON.stringify(payload), "PX", ttlMs);
  }

  return {
    instanceId,
    key,
    publishOnce,
    start() {
      if (timer) return;
      void publishOnce().catch((error) => options.onError?.(error));
      timer = setInterval(() => {
        void publishOnce().catch((error) => options.onError?.(error));
      }, intervalMs);
      // Never hold the process open for a heartbeat.
      timer.unref?.();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Best effort only. Crash safety is the TTL's job, never this.
      try {
        await options.redis.del(key);
      } catch (error) {
        options.onError?.(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export type RuntimeAttestationReasonCode =
  | "RUNTIME_ATTESTATION_UNAVAILABLE"
  | "RUNTIME_ATTESTATION_MISSING"
  | "RUNTIME_ATTESTATION_STALE"
  | "RUNTIME_ATTESTATION_DUPLICATE"
  | "RUNTIME_ATTESTATION_MISMATCH";

export interface RuntimeRoleStatus {
  role: RuntimeRole;
  freshCount: number;
  staleCount: number;
  gates: RuntimeGateSnapshot | null;
  instanceId: string | null;
}

export interface RuntimeAttestationStatus {
  ok: boolean;
  reasonCode: RuntimeAttestationReasonCode | null;
  message: string | null;
  backend: RuntimeRoleStatus;
  worker: RuntimeRoleStatus;
}

/** Every gate the activation interlock requires, in one place. */
export function gatesAreLive(gates: RuntimeGateSnapshot): boolean {
  return (
    !gates.globalKillSwitch &&
    gates.liveEntryEnabled &&
    gates.protectionReady &&
    !gates.accountSetupMutationsEnabled &&
    !gates.testOrderEnabled &&
    !gates.autoAddMarginEnabled &&
    gates.emergencyCloseMode === "DISABLED"
  );
}

export function sameGates(a: RuntimeGateSnapshot, b: RuntimeGateSnapshot): boolean {
  return (
    a.globalKillSwitch === b.globalKillSwitch &&
    a.liveEntryEnabled === b.liveEntryEnabled &&
    a.protectionReady === b.protectionReady &&
    a.accountSetupMutationsEnabled === b.accountSetupMutationsEnabled &&
    a.testOrderEnabled === b.testOrderEnabled &&
    a.autoAddMarginEnabled === b.autoAddMarginEnabled &&
    a.emergencyCloseMode === b.emergencyCloseMode
  );
}

function parseAttestation(raw: string): RuntimeAttestation | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<RuntimeAttestation>;
  if (candidate.schemaVersion !== RUNTIME_ATTESTATION_SCHEMA_VERSION) return null;
  if (candidate.role !== "BACKEND" && candidate.role !== "WORKER") return null;
  if (typeof candidate.instanceId !== "string" || candidate.instanceId === "") return null;
  if (typeof candidate.lastSeenAt !== "string") return null;
  if (typeof candidate.accountIdentifier !== "string" || typeof candidate.environment !== "string") return null;
  const gates = candidate.gates as Partial<RuntimeGateSnapshot> | undefined;
  if (!gates) return null;
  for (const flag of [
    "globalKillSwitch",
    "liveEntryEnabled",
    "protectionReady",
    "accountSetupMutationsEnabled",
    "testOrderEnabled",
    "autoAddMarginEnabled",
  ] as const) {
    if (typeof gates[flag] !== "boolean") return null;
  }
  if (typeof gates.emergencyCloseMode !== "string") return null;
  if (Number.isNaN(Date.parse(candidate.lastSeenAt))) return null;
  return candidate as RuntimeAttestation;
}

export interface ReadRuntimeAttestationOptions {
  redis: RuntimeAttestationRedis;
  identity: RuntimeIdentity;
  /** The CLI's own parsed snapshot, which both runtimes must agree with. */
  expected: RuntimeGateSnapshot;
  now?: Date;
  ttlMs?: number;
  scanCount?: number;
}

function emptyRole(role: RuntimeRole): RuntimeRoleStatus {
  return { role, freshCount: 0, staleCount: 0, gates: null, instanceId: null };
}

function blocked(
  reasonCode: RuntimeAttestationReasonCode,
  message: string,
  backend: RuntimeRoleStatus,
  worker: RuntimeRoleStatus
): RuntimeAttestationStatus {
  return { ok: false, reasonCode, message, backend, worker };
}

/**
 * Enumerates attestations for ONE execution identity and judges them.
 *
 * Fails closed on every ambiguity, including infrastructure failure: a Redis
 * that cannot be read is reported UNAVAILABLE rather than treated as "no
 * problem found". Duplicates are refused outright — picking the newest would
 * silently authorise a topology nobody intended.
 */
export async function readRuntimeAttestationStatus(
  options: ReadRuntimeAttestationOptions
): Promise<RuntimeAttestationStatus> {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? RUNTIME_ATTESTATION_TTL_MS;
  const scanCount = options.scanCount ?? 100;
  const pattern = runtimeAttestationPattern(options.identity);

  const byRole: Record<RuntimeRole, RuntimeRoleStatus> = {
    BACKEND: emptyRole("BACKEND"),
    WORKER: emptyRole("WORKER"),
  };

  try {
    // SCAN, never KEYS: bounded iteration that cannot block Redis.
    let cursor = "0";
    const seen = new Set<string>();
    let guard = 0;
    do {
      const [next, keys] = await options.redis.scan(cursor, "MATCH", pattern, "COUNT", scanCount);
      cursor = next;
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        const raw = await options.redis.get(key);
        if (raw === null) continue; // expired between SCAN and GET
        const attestation = parseAttestation(raw);
        if (!attestation) {
          return blocked(
            "RUNTIME_ATTESTATION_MISMATCH",
            "a runtime attestation record is malformed or uses an unknown schema version.",
            byRole.BACKEND,
            byRole.WORKER
          );
        }
        // Defence in depth: the key is already identity-scoped, but a record
        // whose body disagrees with its key is not trustworthy.
        if (
          attestation.accountIdentifier !== options.identity.accountIdentifier ||
          attestation.environment !== options.identity.environment
        ) {
          continue;
        }
        const status = byRole[attestation.role];
        const ageMs = now.getTime() - Date.parse(attestation.lastSeenAt);
        // lastSeenAt age is checked independently of key existence.
        if (ageMs > ttlMs || ageMs < -ttlMs) {
          status.staleCount += 1;
          continue;
        }
        status.freshCount += 1;
        status.gates = attestation.gates;
        status.instanceId = attestation.instanceId;
      }
      guard += 1;
    } while (cursor !== "0" && guard < 1000);
  } catch (error) {
    return blocked(
      "RUNTIME_ATTESTATION_UNAVAILABLE",
      `runtime attestation could not be read (${error instanceof Error ? error.message : String(error)}).`,
      byRole.BACKEND,
      byRole.WORKER
    );
  }

  const backend = byRole.BACKEND;
  const worker = byRole.WORKER;

  for (const status of [backend, worker]) {
    if (status.freshCount === 0) {
      const stale = status.staleCount > 0;
      return blocked(
        stale ? "RUNTIME_ATTESTATION_STALE" : "RUNTIME_ATTESTATION_MISSING",
        stale
          ? `the ${status.role} runtime last reported more than ${ttlMs / 1000}s ago.`
          : `no ${status.role} runtime is attesting for this execution identity.`,
        backend,
        worker
      );
    }
    if (status.freshCount > 1) {
      return blocked(
        "RUNTIME_ATTESTATION_DUPLICATE",
        `${status.freshCount} fresh ${status.role} runtimes are attesting; exactly one is required.`,
        backend,
        worker
      );
    }
  }

  const backendGates = backend.gates as RuntimeGateSnapshot;
  const workerGates = worker.gates as RuntimeGateSnapshot;

  if (!sameGates(backendGates, workerGates)) {
    return blocked(
      "RUNTIME_ATTESTATION_MISMATCH",
      "the backend and worker runtimes loaded different execution gates.",
      backend,
      worker
    );
  }
  if (!sameGates(backendGates, options.expected)) {
    return blocked(
      "RUNTIME_ATTESTATION_MISMATCH",
      "the running processes loaded different execution gates than this command did; restart them after editing .env.",
      backend,
      worker
    );
  }
  if (!gatesAreLive(backendGates)) {
    return blocked(
      "RUNTIME_ATTESTATION_MISMATCH",
      "the running processes did not load the activation gate values required to arm.",
      backend,
      worker
    );
  }

  return { ok: true, reasonCode: null, message: null, backend, worker };
}

/** Narrow adapter so long-lived runtimes can pass the shared ioredis client. */
export function asAttestationRedis(client: Redis): RuntimeAttestationRedis {
  return client as unknown as RuntimeAttestationRedis;
}

/**
 * Reads attestation from a SHORT-LIVED client and always disconnects.
 *
 * Operator CLIs are one-shot processes: holding the shared BullMQ connection
 * would keep their event loop alive and the command would never exit. This
 * mirrors the existing `probeRedis` pattern in canary-preflight.service.ts.
 * Long-lived runtimes use `asAttestationRedis(bullConnection)` instead.
 */
export async function readRuntimeAttestationStatusOnce(
  options: Omit<ReadRuntimeAttestationOptions, "redis">
): Promise<RuntimeAttestationStatus> {
  const { default: IORedis } = await import("ioredis");
  const client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 3000,
  });
  try {
    await client.connect();
    return await readRuntimeAttestationStatus({ ...options, redis: asAttestationRedis(client) });
  } catch (error) {
    // Infrastructure failure is never a PASS.
    return {
      ok: false,
      reasonCode: "RUNTIME_ATTESTATION_UNAVAILABLE",
      message: `runtime attestation could not be read (${error instanceof Error ? error.message : String(error)}).`,
      backend: emptyRole("BACKEND"),
      worker: emptyRole("WORKER"),
    };
  } finally {
    client.disconnect();
  }
}
