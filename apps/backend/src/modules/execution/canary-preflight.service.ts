import { readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env";
import { BinanceAccountConnectionService } from "../binance/binance-account-connection.service";
import {
  evaluateCanaryPreflight,
  type AuthorizationReadinessState,
  type CanaryAuthorizationMode,
  type CanaryPolicyLimits,
  type CanaryPreflightInput,
  type CanaryPreflightResult,
  type RuntimeAttestationReadiness,
} from "./canary-readiness";
import { naturalWindowState } from "./natural-authorization";
import { configuredProfileIdentity, resolveExecutionProfile } from "./execution-profile.service";

/**
 * Phase 11A — READ-ONLY live-canary preflight.
 *
 * Issues only reads: allowlisted Binance GETs (through the Phase 10 read-only
 * health check), Prisma counts, and one trivial connectivity probe each for
 * Postgres and Redis. It sends ZERO Binance mutations, creates no execution
 * row, changes no gate and cancels or closes nothing.
 *
 * It reports counts and names. No balance, position symbol, quantity, order id,
 * account identifier, credential or signed URL ever leaves this module.
 */

/** Repeated signed checks: one success is luck, several is a usable link. */
export const REQUIRED_CONSECUTIVE_SIGNED_SUCCESSES = 3;

/** Local statuses that mean "this execution is still live work". */
const ACTIVE_STATUSES = [
  "PLAN_READY",
  "PREFLIGHT",
  "ENTRY_SUBMITTING",
  "ENTRY_PENDING",
  "PARTIALLY_FILLED",
  "ENTRY_FILLED",
  "PLACING_PROTECTION",
  "PROTECTED",
] as const;

const PENDING_ENTRY_STATUSES = ["ENTRY_SUBMITTING", "ENTRY_PENDING"] as const;
const OPEN_POSITION_STATUSES = ["PARTIALLY_FILLED", "ENTRY_FILLED", "PLACING_PROTECTION", "PROTECTED"] as const;

export interface CanaryPreflightOptions {
  binance?: BinanceAccountConnectionService;
  /** Injected in tests so no real Binance/Redis is contacted. */
  probes?: Partial<PreflightProbes>;
  signedCheckCount?: number;
}

export interface PreflightProbes {
  databaseReady: () => Promise<boolean>;
  redisReady: () => Promise<boolean>;
  executionWorkerReady: () => Promise<boolean>;
  notificationSchedulerReady: () => Promise<boolean>;
  executionOrchestrationWired: () => Promise<boolean>;
  /**
   * Phase 12.4D-A.1, OPTIONAL on purpose. When absent the readiness evaluation
   * records "not evaluated", which is never a blocker — so every existing
   * caller, and preparation while the runtime is intentionally down, behave
   * exactly as before. Only the preflight CLI opts in.
   */
  runtimeAttestation?: () => Promise<RuntimeAttestationReadiness>;
}

export class CanaryPreflightService {
  private readonly binance: BinanceAccountConnectionService;
  private readonly probes: PreflightProbes;
  private readonly signedCheckCount: number;

  constructor(
    private readonly prisma: PrismaClient,
    options: CanaryPreflightOptions = {}
  ) {
    this.binance = options.binance ?? new BinanceAccountConnectionService();
    this.signedCheckCount = options.signedCheckCount ?? REQUIRED_CONSECUTIVE_SIGNED_SUCCESSES;
    this.probes = {
      databaseReady: () => this.probeDatabase(),
      redisReady: () => probeRedis(),
      executionWorkerReady: () => detectWorkerRuntime(),
      notificationSchedulerReady: () => detectNotificationScheduler(),
      executionOrchestrationWired: () => detectExecutionOrchestration(),
      ...options.probes,
    };
  }

  /**
   * Gathers every input, then evaluates. Read-only from end to end.
   *
   * `mode` says which authorization the canary is being judged for. It defaults
   * to EXACT_SIGNAL so every existing caller — `prepare-canary`, `arm-canary`,
   * the preflight CLI — keeps its historical behaviour unchanged.
   */
  async run(
    mode: CanaryAuthorizationMode = "EXACT_SIGNAL"
  ): Promise<CanaryPreflightResult & { gathered: CanaryPreflightInput }> {
    const [databaseReady, redisReady, executionWorkerReady, notificationSchedulerReady, executionOrchestrationWired] =
      await Promise.all([
        this.probes.databaseReady(),
        this.probes.redisReady(),
        this.probes.executionWorkerReady(),
        this.probes.notificationSchedulerReady(),
        this.probes.executionOrchestrationWired(),
      ]);

    const runtimeAttestation: RuntimeAttestationReadiness = this.probes.runtimeAttestation
      ? await this.probes.runtimeAttestation()
      : { evaluated: false, ok: true, reasonCode: null, message: null };

    // Repeated signed health checks against the real account (GET only).
    let consecutiveSignedSuccesses = 0;
    let health = await this.binance.checkAccountConnection();
    for (let attempt = 0; attempt < this.signedCheckCount; attempt += 1) {
      const current = attempt === 0 ? health : await this.binance.checkAccountConnection();
      if (attempt > 0) health = current;
      if (!current.signedRequestWorks) break;
      consecutiveSignedSuccesses += 1;
    }

    const authenticationFailed = health.readinessCodes.includes("AUTHENTICATION_FAILED");
    const ipRestricted = health.warnings.some((warning) => /ip|restricted|-2015/i.test(warning));

    const local = databaseReady ? await this.readLocalExecutionState() : {
      activeExecutionCount: null,
      pendingEntryCount: null,
      openPositionCount: null,
      recoveryRequiredCount: null,
    };

    // ONE read of the configured profile's row supplies both the kill switch
    // and the limits, so the two can never describe different rows.
    const profileRow = databaseReady ? await this.readProfilePolicyRow() : null;
    const profileKillSwitchEngaged = profileRow ? profileRow.killSwitchActive : null;

    // Authorization readiness. READ ONLY — this never prepares, revokes,
    // consumes or claims anything.
    const authorization = databaseReady
      ? await this.readAuthorizationState(mode)
      : {
          mode,
          available: false,
          exactPrepared: false,
          naturalState: null,
          naturalAllowedDirections: [],
          naturalMaxClaims: null,
          naturalClaimedCount: null,
        };

    const gathered: CanaryPreflightInput = {
      infrastructure: {
        databaseReady,
        redisReady,
        executionWorkerReady,
        notificationSchedulerReady,
        executionOrchestrationWired,
      },
      binance: {
        connected: health.connected,
        signedRequestWorks: health.signedRequestWorks,
        consecutiveSignedSuccesses,
        requiredConsecutiveSuccesses: this.signedCheckCount,
        authenticationFailed,
        ipRestricted,
        positionMode: health.positionMode,
        assetMode: health.assetMode,
        nonZeroPositionCount: health.nonZeroPositionCount,
        openOrderCount: health.openOrderCount,
      },
      local,
      policy: {
        global: {
          maxOpenPositions: env.EXECUTION_MAX_OPEN_POSITIONS,
          maxPendingEntries: env.EXECUTION_MAX_PENDING_ENTRIES,
          maxTotalActiveTrades: env.EXECUTION_MAX_TOTAL_ACTIVE_TRADES,
          maxActivePerSymbolSide: env.EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE,
          softOpenPositionTarget: env.EXECUTION_SOFT_OPEN_POSITION_TARGET,
          maxTotalPlannedRiskUsd: env.EXECUTION_MAX_TOTAL_PLANNED_RISK_USD,
          maxTotalIsolatedMarginUsd: env.EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD,
        },
        // null when unreadable — the evaluator fails closed rather than
        // assuming the row agrees with the env.
        profile: profileRow ? profileRow.limits : null,
      },
      authorization,
      runtimeAttestation,
      gates: {
        globalKillSwitch: env.EXECUTION_GLOBAL_KILL_SWITCH,
        profileKillSwitchEngaged,
        liveEntryEnabled: env.EXECUTION_LIVE_ENTRY_ENABLED,
        protectionReady: env.EXECUTION_PROTECTION_READY,
        accountSetupMutationsEnabled: env.BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED,
        testOrderEnabled: env.BINANCE_TEST_ORDER_ENABLED,
        autoAddMarginEnabled: env.EXECUTION_AUTO_ADD_MARGIN_ENABLED,
        emergencyCloseMode: env.EXECUTION_EMERGENCY_CLOSE_MODE,
      },
    };

    return { ...evaluateCanaryPreflight(gathered), gathered };
  }

  /**
   * The authorization side of readiness, SANITIZED. Reads only — no token, no
   * hash and no row leaves this method.
   *
   * For NATURAL_WINDOW it describes the NEWEST window regardless of state, so
   * the finding can say REVOKED or EXPIRED rather than a uselessly generic
   * "none prepared". Preparation exclusivity guarantees a newer window implies
   * every older one was already shut.
   */
  private async readAuthorizationState(mode: CanaryAuthorizationMode): Promise<AuthorizationReadinessState> {
    const unavailable: AuthorizationReadinessState = {
      mode,
      available: false,
      exactPrepared: false,
      naturalState: null,
      naturalAllowedDirections: [],
      naturalMaxClaims: null,
      naturalClaimedCount: null,
    };

    try {
      const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
      if (!resolution.ok) return unavailable;
      const profileId = resolution.profile.id;
      const now = new Date();

      if (mode === "EXACT_SIGNAL") {
        const active = await this.prisma.executionCanaryAuthorization.count({
          where: {
            executionProfileId: profileId,
            authorizationType: "EXACT_SIGNAL",
            consumedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
        });
        return { ...unavailable, available: true, exactPrepared: active > 0 };
      }

      const window = await this.prisma.executionCanaryAuthorization.findFirst({
        where: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW" },
        orderBy: { createdAt: "desc" },
      });
      if (!window) return { ...unavailable, available: true };

      return {
        mode,
        available: true,
        exactPrepared: false,
        naturalState: naturalWindowState(window, now),
        naturalAllowedDirections: [...window.allowedDirections],
        naturalMaxClaims: window.maxClaims,
        naturalClaimedCount: window.claimedCount,
      };
    } catch {
      // Unreadable is never "ready": the evaluator turns this into a blocker.
      return unavailable;
    }
  }

  /** Counts only — never a symbol, quantity or id. */
  private async readLocalExecutionState() {
    try {
      const [activeExecutionCount, pendingEntryCount, openPositionCount, recoveryRequiredCount] = await Promise.all([
        this.prisma.tradeExecution.count({ where: { status: { in: [...ACTIVE_STATUSES] } } }),
        this.prisma.tradeExecution.count({ where: { status: { in: [...PENDING_ENTRY_STATUSES] } } }),
        this.prisma.tradeExecution.count({ where: { status: { in: [...OPEN_POSITION_STATUSES] } } }),
        this.prisma.tradeExecution.count({
          where: { OR: [{ status: "MANUAL_INTERVENTION" }, { requiresManualIntervention: true }] },
        }),
      ]);
      return { activeExecutionCount, pendingEntryCount, openPositionCount, recoveryRequiredCount };
    } catch {
      return {
        activeExecutionCount: null,
        pendingEntryCount: null,
        openPositionCount: null,
        recoveryRequiredCount: null,
      };
    }
  }

  /** True when the applicable profile's kill switch is engaged. */
  /**
   * The CONFIGURED profile's safety-policy row — kill switch and limits from
   * one read.
   *
   * Scoped to `EXECUTION_PROFILE_ACCOUNT_IDENTIFIER` + `EXECUTION_PROFILE_ENVIRONMENT`,
   * the same identity admission resolves, rather than "whichever policy row is
   * oldest". A preflight that judged one profile's limits while execution used
   * another's would be worse than no check at all.
   *
   * Returns null for every "we could not prove it" case — no profile
   * configured, no match, an ambiguous match, no policy row, or an unreachable
   * database. The evaluator turns that into a blocker.
   */
  private async readProfilePolicyRow(): Promise<{
    killSwitchActive: boolean;
    limits: CanaryPolicyLimits;
  } | null> {
    try {
      const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
      if (!resolution.ok) return null;
      const policy = resolution.profile.safetyPolicy;
      if (!policy) return null;
      return {
        killSwitchActive: policy.killSwitchActive,
        limits: {
          maxOpenPositions: policy.maxOpenPositions,
          maxPendingEntries: policy.maxPendingEntries,
          maxTotalActiveTrades: policy.maxTotalActiveTrades,
          maxActivePerSymbolSide: policy.maxActivePerSymbolSide,
          softOpenPositionTarget: policy.softOpenPositionTarget,
          maxTotalPlannedRiskUsd: policy.maxTotalPlannedRiskUsd.toFixed(),
          maxTotalIsolatedMarginUsd: policy.maxTotalIsolatedMarginUsd.toFixed(),
        },
      };
    } catch {
      return null;
    }
  }

  private async probeDatabase(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

const WORKER_ENTRYPOINT = path.join(
  process.cwd(),
  "src",
  "modules",
  "jobs",
  "vision-analysis.worker.ts"
);

/**
 * Whether a production caller actually drives the execution lifecycle.
 *
 * This is a SOURCE-level check on purpose. The Phase 5–7 services are fully
 * implemented and tested, but "the class exists" and "something calls it in
 * production" are different claims, and only the second one lets a real trade
 * happen. The check looks for a production construction of the orchestration
 * services outside the execution module itself.
 */
export async function detectExecutionOrchestration(): Promise<boolean> {
  try {
    const worker = readFileSync(WORKER_ENTRYPOINT, "utf8");
    const app = readFileSync(path.join(process.cwd(), "src", "app.ts"), "utf8");
    const combined = `${worker}\n${app}`;
    // The worker must actually START the orchestration scheduler, and that
    // scheduler must construct all three lifecycle services and run startup
    // recovery. Checking registration AND construction keeps this honest: a
    // module that is merely imported, or a scheduler that reconciles without
    // recovering, would not satisfy it.
    const scheduler = readFileSync(
      path.join(process.cwd(), "src", "modules", "jobs", "execution-orchestration.scheduler.ts"),
      "utf8"
    );
    return (
      /startExecutionOrchestrationScheduler\(\)/.test(combined) &&
      /new\s+SafetyAdmissionService/.test(scheduler) &&
      /new\s+EntryLifecycleService/.test(scheduler) &&
      /new\s+ProtectionLifecycleService/.test(scheduler) &&
      /runStartupRecovery\(/.test(scheduler)
    );
  } catch {
    return false;
  }
}

/** The Phase 9 scheduler must be registered in the same worker runtime. */
export async function detectNotificationScheduler(): Promise<boolean> {
  try {
    const worker = readFileSync(WORKER_ENTRYPOINT, "utf8");
    return worker.includes("startExecutionNotificationScheduler()");
  } catch {
    return false;
  }
}

/**
 * Whether a worker runtime that could run execution work exists at all.
 * Today this is the vision worker process; it hosts the schedulers.
 */
export async function detectWorkerRuntime(): Promise<boolean> {
  try {
    readFileSync(WORKER_ENTRYPOINT, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** A minimal Redis reachability probe that opens and closes one connection. */
export async function probeRedis(): Promise<boolean> {
  try {
    const { default: IORedis } = await import("ioredis");
    const client = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 3000,
    });
    try {
      await client.connect();
      await client.ping();
      return true;
    } finally {
      client.disconnect();
    }
  } catch {
    return false;
  }
}
