import { Prisma, PrismaClient } from "@prisma/client";

import { SOURCE_TIMEFRAMES } from "@trading-alert-dashboard/shared";

import { env } from "../../config/env";
import { describeStoredSelection } from "./source-timeframe-policy";
import { describeStoredLookback } from "./extreme-rr-lookback.service";
import {
  CanaryPreflightService,
  type CanaryPreflightOptions,
} from "../execution/canary-preflight.service";
import type {
  CanaryAuthorizationMode,
  CanaryFinding,
  CanaryPreflightInput,
  CanaryPreflightResult,
} from "../execution/canary-readiness";
import type { ExecutionSafetyPolicy } from "@prisma/client";
import {
  OPEN_POSITION_STATUSES,
  PENDING_ENTRY_STATUSES,
  TOTAL_ACTIVE_STATUSES,
} from "../execution/capacity-status";
import type { TradeExecutionStatusName } from "../execution/execution-status";
import { mergeCapacityLimits } from "../execution/safety-engine";
import { findCurrentSession, toSessionView } from "../execution/trading-session.service";
import { configuredProfileIdentity, resolveExecutionProfile } from "../execution/execution-profile.service";
import { describeNaturalWindow } from "../execution/natural-authorization";
import {
  configuredRuntimeIdentity,
  currentProcessGateSnapshot,
  readRuntimeAttestationStatusOnce,
  type RuntimeAttestationStatus,
} from "../runtime/runtime-attestation";

/**
 * The READ-ONLY status feed behind the dashboard's Trading Control panel.
 *
 * Every number here comes from a service that already owns it — the canary
 * preflight evaluator, the natural-authorization describer, the capacity status
 * groups, the one min-merge in `safety-engine`. Nothing in this file decides
 * whether trading is safe; it only reports what those authorities already
 * concluded, so the panel can never disagree with the CLI an operator would run
 * to check the same thing.
 *
 * It is also strictly read-only. There is no mutation path here, no ARM, no
 * CLOSE and no DISARM, and no route in this module writes anything.
 */

// ---------------------------------------------------------------------------
// The locked state model
// ---------------------------------------------------------------------------

export const TRADING_SYSTEM_STATES = ["SAFE_OFF", "ARMED", "SAFE_RECOVERY", "INVALID", "UNKNOWN"] as const;
export type TradingSystemState = (typeof TRADING_SYSTEM_STATES)[number];

/**
 * The two durable flags, mapped exactly as the operator commands define them.
 *
 * `false/false` is INVALID rather than a fourth working mode: no command ever
 * commits it, so seeing it means something wrote the profile outside the
 * operator path and the panel must say so loudly.
 *
 * UNKNOWN is not a fifth state of the system — it is the absence of a reading.
 * A profile or policy row that could not be read must never be rendered as
 * SAFE, because "we could not tell" and "it is off" are different facts.
 */
export function mapTradingSystemState(
  isEnabled: boolean | null | undefined,
  killSwitchActive: boolean | null | undefined
): TradingSystemState {
  if (typeof isEnabled !== "boolean" || typeof killSwitchActive !== "boolean") return "UNKNOWN";
  if (!isEnabled && killSwitchActive) return "SAFE_OFF";
  if (isEnabled && !killSwitchActive) return "ARMED";
  if (isEnabled && killSwitchActive) return "SAFE_RECOVERY";
  return "INVALID";
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export const TRADING_CONTROL_WARNING_CODES = [
  "INVALID_STATE",
  "STATE_UNKNOWN",
  "RUNTIME_ATTESTATION_BLOCKED",
  "MANUAL_INTERVENTION_REQUIRED",
  "FILLED_WITHOUT_VERIFIED_PROTECTION",
  "CAPACITY_EXHAUSTED",
  "NATURAL_AUTHORIZATION_EXPIRED",
] as const;
export type TradingControlWarningCode = (typeof TRADING_CONTROL_WARNING_CODES)[number];

export interface TradingControlWarning {
  code: TradingControlWarningCode;
  detail: string;
}

/**
 * Positions that exist but are not yet provably protected.
 *
 * MANUAL_INTERVENTION is deliberately excluded: it is already its own, louder
 * warning, and counting it twice would overstate how many unprotected fills
 * there are.
 */
const FILLED_UNPROTECTED_STATUSES: readonly TradeExecutionStatusName[] = [
  "PARTIALLY_FILLED",
  "ENTRY_FILLED",
  "PLACING_PROTECTION",
];

// ---------------------------------------------------------------------------
// Response shape — sanitized
// ---------------------------------------------------------------------------

export interface TradingControlProfileDto {
  /** Environment only. The account identifier never leaves the server. */
  environment: string;
  isEnabled: boolean | null;
  killSwitchActive: boolean | null;
}

export interface TradingControlGatesDto {
  globalKillSwitch: boolean;
  liveEntryEnabled: boolean;
  protectionReady: boolean;
}

export interface TradingControlAttestationDto {
  status: "PASS" | "BLOCKED" | "UNAVAILABLE";
  reasonCode: string | null;
  message: string | null;
  backendCount: number;
  workerCount: number;
}

export interface TradingControlReadinessDto {
  preparationReady: boolean;
  liveActivationReady: boolean;
  summary: string;
  preparationBlockers: CanaryFinding[];
  liveActivationBlockers: CanaryFinding[];
}

export interface TradingControlAuthorizationDto {
  state: string;
  expiresAt: string;
  remainingTtlSeconds: number;
  maxClaims: number | null;
  claimedCount: number;
  remainingClaims: number;
}

export interface TradingControlSessionDto {
  id: string;
  /** ACTIVE | PAUSED | EXHAUSTED | EXPIRED | REVOKED, derived at read time. */
  status: string;
  /**
   * Whether Resume is offerable RIGHT NOW.
   *
   * Decided by the server, never by the panel comparing strings. A session
   * that expired or exhausted itself while paused is not resumable however its
   * stored status reads, and the browser has no clock worth trusting for that
   * question.
   */
  resumable: boolean;
  /** Null when unlimited — which is not a number and must not render as one. */
  tradeBudget: number | null;
  unlimited: boolean;
  /** Trades that obtained exposure. Monotonic; a close never gives one back. */
  openedCount: number;
  /** Slots held by entries that can still fill. */
  reservedCount: number;
  /** budget - opened - reserved. Null when unlimited. */
  remaining: number | null;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  /** Seconds until expiry; 0 once it has ended. */
  remainingTtlSeconds: number;
}

export interface TradingControlCapacityDto {
  pending: number;
  open: number;
  totalActive: number;
  desiredOpen: number;
  hardTotal: number;
  /**
   * The effective per-group limits, so the panel can show each count against
   * the limit that actually governs it.
   *
   * Without these the UI has only `hardTotal` and would have to either omit a
   * denominator or borrow the wrong one — showing pending entries out of the
   * TOTAL-active limit reads as more headroom than the operator really has.
   * Both come from the same min-merge the admission engine uses.
   */
  maxOpen: number;
  maxPending: number;
}

export interface TradingControlReservationsDto {
  riskUsd: string;
  riskLimitUsd: string;
  marginUsd: string;
  marginLimitUsd: string;
}

export interface TradingControlLatestExecutionDto {
  symbol: string;
  direction: string;
  status: string;
  reason: string | null;
  /**
   * The SOURCE timeframe frozen on this execution, so the panel can say which
   * timeframe a SOURCE_TIMEFRAME_NOT_ALLOWED refusal was actually about
   * instead of naming the rule without its subject.
   *
   * Already persisted on the row and already sanitized — this exposes no new
   * information, it only stops the panel from having to omit it.
   */
  sourceTimeframe: string | null;
  updatedAt: string;
}

export interface TradingControlStatusDto {
  generatedAt: string;
  systemState: TradingSystemState;
  profile: TradingControlProfileDto | null;
  environmentGates: TradingControlGatesDto;
  /**
   * Startup-scoped configuration of THIS process, reported so an operator can
   * prove what the running runtime will do. Read-only: the environment is
   * parsed once per process, so changing a runtime's behaviour means launching
   * it with a different choice, never editing this.
   */
  startupConfiguration: { standardLimitTakeProfitEnabled: boolean };
  runtimeAttestation: TradingControlAttestationDto;
  allowedSymbols: string[];
  /**
   * The SOURCE timeframes that may create a live execution, as enforced.
   *
   * `enforceable` is what admission will actually accept; `valid` is false
   * when the stored policy admits nothing or carries an unrecognised value.
   * Reported rather than repaired — a configuration that cannot admit is a
   * thing the operator must see, never something to widen into all.
   */
  sourceTimeframes: {
    enforceable: string[];
    unrecognized: string[];
    valid: boolean;
    supported: string[];
  };
  /**
   * How many closed candles a NEW Extreme RR plan will search.
   *
   * `valid` is false when the stored value is not a supported lookback;
   * reported rather than repaired, because displaying 300 for a row that does
   * not say 300 would hide exactly the misconfiguration worth seeing.
   */
  rrLookback: { stored: number; effective: number | null; valid: boolean; supported: number[] };
  authorization: TradingControlAuthorizationDto | null;
  /**
   * The effective maximum age, in seconds, a signal may have and still be
   * admitted. Presentation reads it as policy — it is deliberately NOT
   * attached to an execution, because it describes the rule in force now
   * rather than the one that judged any particular row.
   */
  alertAgeLimitSeconds: number;
  /**
   * The trading SESSION — cumulative accounting, deliberately separate from
   * `capacity`.
   *
   * `capacity` answers "how much is open right now"; this answers "how many
   * trades has this session opened, out of how many it may". Merging them
   * would put a fact and a running total under one heading, which is exactly
   * the confusion the old CLAIMS row created.
   *
   * Null when no session has ever been started for this profile.
   */
  session: TradingControlSessionDto | null;
  capacity: TradingControlCapacityDto;
  reservations: TradingControlReservationsDto;
  latestExecution: TradingControlLatestExecutionDto | null;
  manualIntervention: { present: boolean; count: number };
  warnings: TradingControlWarning[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type PreflightRunner = {
  run(
    mode: CanaryAuthorizationMode
  ): Promise<CanaryPreflightResult & { gathered: CanaryPreflightInput }>;
};

export interface TradingControlOptions {
  /** Injected in tests so no signed Binance read happens in a suite. */
  preflight?: PreflightRunner;
  /** Injected in tests so no Redis connection is opened. */
  readAttestation?: () => Promise<RuntimeAttestationStatus>;
  now?: () => Date;
  preflightOptions?: CanaryPreflightOptions;
}

/**
 * The panel judges NATURAL_WINDOW readiness.
 *
 * That is the mode the operator actually runs on this account, so an EXACT
 * verdict on the dashboard would answer a question nobody asked — the same
 * class of mistake the `--mode` fail-closed parser exists to prevent.
 */
export const TRADING_CONTROL_DEFAULT_MODE: CanaryAuthorizationMode = "NATURAL_WINDOW";

export class TradingControlService {
  private readonly preflight: PreflightRunner;
  private readonly readAttestation: () => Promise<RuntimeAttestationStatus>;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    options: TradingControlOptions = {}
  ) {
    this.preflight = options.preflight ?? new CanaryPreflightService(prisma, options.preflightOptions);
    this.readAttestation =
      options.readAttestation ??
      (() =>
        readRuntimeAttestationStatusOnce({
          identity: configuredRuntimeIdentity(),
          expected: currentProcessGateSnapshot(),
        }));
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Readiness on its own, for the panel's explicit "Check Readiness" action.
   *
   * Same evaluator as the CLI preflight, so a blocker shown in the browser is
   * character-for-character the blocker the terminal would print.
   */
  async readReadiness(mode: CanaryAuthorizationMode = TRADING_CONTROL_DEFAULT_MODE): Promise<
    TradingControlReadinessDto & { mode: CanaryAuthorizationMode; generatedAt: string }
  > {
    const result = await this.preflight.run(mode);
    return {
      mode,
      generatedAt: this.now().toISOString(),
      ...describeReadiness(result),
    };
  }

  /**
   * The polled snapshot. DELIBERATELY CHEAP.
   *
   * This runs NO preflight and touches NO exchange. Every figure comes from the
   * profile row, the authorization row, the execution table, the parsed env
   * snapshot and Redis. The full canary preflight performs three signed reads
   * of the live account, and running that on a fifteen-second timer for every
   * open browser tab would turn a status card into a standing load on a
   * real-money API. Readiness is a question the operator asks, not a heartbeat.
   */
  async readStatus(): Promise<TradingControlStatusDto> {
    const now = this.now();
    const attestation = await this.readAttestationSafely();

    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    const profileRow = resolution.ok ? resolution.profile : null;

    const profile: TradingControlProfileDto | null = profileRow
      ? {
          environment: profileRow.environment,
          isEnabled: profileRow.isEnabled,
          killSwitchActive: profileRow.safetyPolicy?.killSwitchActive ?? null,
        }
      : null;

    const systemState = mapTradingSystemState(profile?.isEnabled, profile?.killSwitchActive);

    // The SAME min-merge admission enforces, over the SAME two sides the
    // preflight reads: the env-wide limits and this profile's policy row.
    // Recomputing it here with different arithmetic is exactly the drift the
    // shared helper exists to prevent.
    const limits = effectiveLimits(profileRow?.safetyPolicy ?? null);

    // Read-only. The status endpoint never writes session accounting, so an
    // operator refreshing the panel cannot move a counter.
    const sessionRow = profileRow ? await findCurrentSession(this.prisma, profileRow.id) : null;
    const sessionView = sessionRow ? toSessionView(sessionRow, now) : null;
    const sessionDto: TradingControlSessionDto | null = sessionView
      ? {
          id: sessionView.id,
          status: sessionView.status,
          tradeBudget: sessionView.tradeBudget,
          unlimited: sessionView.unlimited,
          openedCount: sessionView.openedCount,
          reservedCount: sessionView.reservedCount,
          remaining: sessionView.remaining,
          // Equivalent to isResumableSession by construction, and derived from
          // the same value the panel displays so the flag and the label can
          // never disagree: derivedSessionStatus reports PAUSED only after
          // ruling out revoked, expired and exhausted.
          resumable: sessionView.status === "PAUSED",
          startedAt: sessionView.startedAt.toISOString(),
          expiresAt: sessionView.expiresAt.toISOString(),
          endedAt: sessionView.endedAt?.toISOString() ?? null,
          remainingTtlSeconds: Math.max(
            0,
            Math.floor((sessionView.expiresAt.getTime() - now.getTime()) / 1000)
          ),
        }
      : null;

    const capacityRows = profileRow
      ? await this.prisma.tradeExecution.findMany({
          where: {
            executionProfileId: profileRow.id,
            status: { in: TOTAL_ACTIVE_STATUSES as unknown as Prisma.EnumTradeExecutionStatusFilter["in"] },
          },
          select: { status: true, riskBudgetUsd: true, maximumIsolatedMargin: true },
        })
      : [];

    let pending = 0;
    let open = 0;
    let reservedRisk = new Prisma.Decimal(0);
    let reservedMargin = new Prisma.Decimal(0);
    for (const row of capacityRows) {
      const status = row.status as TradeExecutionStatusName;
      if (PENDING_ENTRY_STATUSES.includes(status)) pending += 1;
      if (OPEN_POSITION_STATUSES.includes(status)) open += 1;
      reservedRisk = reservedRisk.plus(row.riskBudgetUsd);
      reservedMargin = reservedMargin.plus(row.maximumIsolatedMargin);
    }

    const authorization = await this.readAuthorization(profileRow?.id ?? null, now);
    const latestExecution = await this.readLatestExecution(profileRow?.id ?? null);
    const manualCount = profileRow
      ? await this.prisma.tradeExecution.count({
          where: { executionProfileId: profileRow.id, status: "MANUAL_INTERVENTION" },
        })
      : 0;
    const unprotectedCount = profileRow
      ? await this.prisma.tradeExecution.count({
          where: {
            executionProfileId: profileRow.id,
            status: { in: FILLED_UNPROTECTED_STATUSES as unknown as Prisma.EnumTradeExecutionStatusFilter["in"] },
          },
        })
      : 0;

    const capacity: TradingControlCapacityDto = {
      pending,
      open,
      totalActive: capacityRows.length,
      desiredOpen: limits.softOpenPositionTarget,
      hardTotal: limits.maxTotalActiveTrades,
      maxOpen: limits.maxOpenPositions,
      maxPending: limits.maxPendingEntries,
    };

    // Reported exactly as stored resolves, never repaired: a policy that
    // admits nothing is a state the operator must SEE, and widening it to
    // "all" here would be the one lie this control exists to prevent.
    const storedSourceTimeframes = describeStoredSelection(
      profileRow?.safetyPolicy?.allowedSourceTimeframes
    );

    return {
      generatedAt: now.toISOString(),
      systemState,
      profile,
      // The same three values the preflight reports, from the same parsed env
      // snapshot it reads them from. No exchange call is involved in either.
      environmentGates: {
        globalKillSwitch: env.EXECUTION_GLOBAL_KILL_SWITCH,
        liveEntryEnabled: env.EXECUTION_LIVE_ENTRY_ENABLED,
        protectionReady: env.EXECUTION_PROTECTION_READY,
      },
      /**
       * Which take-profit modality THIS PROCESS was started with.
       *
       * Read-only and startup-scoped: the environment is parsed once per
       * process, so this reports what the running runtime will do and cannot be
       * changed by looking at it. It also decides nothing for work already in
       * flight — an execution that already has a take profit keeps the modality
       * of its own lineage regardless of this value.
       */
      startupConfiguration: {
        standardLimitTakeProfitEnabled: env.EXECUTION_STANDARD_LIMIT_TAKE_PROFIT_ENABLED,
      },
      runtimeAttestation: attestation,
      allowedSymbols: profileRow?.safetyPolicy?.allowedSymbols ?? [],
      sourceTimeframes: { ...storedSourceTimeframes, supported: [...SOURCE_TIMEFRAMES] },
      // Phase 11F: the window that governs plan generation is GLOBAL
      // deployment configuration, not this profile's legacy column. Reporting
      // the column would show an operator a number nothing reads.
      rrLookback: describeStoredLookback(env.EXTREME_RR_LOOKBACK_CANDLES),
      authorization,
      session: sessionDto,
      capacity,
      reservations: {
        riskUsd: reservedRisk.toString(),
        riskLimitUsd: limits.maxTotalPlannedRiskUsd,
        marginUsd: reservedMargin.toString(),
        marginLimitUsd: limits.maxTotalIsolatedMarginUsd,
      },
      alertAgeLimitSeconds: limits.maxAlertAgeSeconds,
      latestExecution,
      manualIntervention: { present: manualCount > 0, count: manualCount },
      warnings: buildWarnings({
        systemState,
        attestation,
        manualCount,
        unprotectedCount,
        capacity,
        authorizationState: authorization?.state ?? null,
      }),
    };
  }

  /**
   * Attestation is advisory here, never fatal.
   *
   * Redis being unreachable must degrade the panel to "UNAVAILABLE" rather than
   * failing the whole status read — an operator looking at a screen because
   * something is wrong is exactly who must not be shown a blank page.
   */
  private async readAttestationSafely(): Promise<TradingControlAttestationDto> {
    try {
      const status = await this.readAttestation();
      return {
        status: status.ok ? "PASS" : "BLOCKED",
        reasonCode: status.reasonCode,
        message: status.message,
        backendCount: status.backend.freshCount,
        workerCount: status.worker.freshCount,
      };
    } catch {
      // The error text can carry a Redis endpoint, so it is deliberately dropped.
      return {
        status: "UNAVAILABLE",
        reasonCode: "RUNTIME_ATTESTATION_UNAVAILABLE",
        message: "Runtime attestation could not be read.",
        backendCount: 0,
        workerCount: 0,
      };
    }
  }

  /** The newest natural window, described by the authority that owns it. */
  private async readAuthorization(
    profileId: string | null,
    now: Date
  ): Promise<TradingControlAuthorizationDto | null> {
    if (!profileId) return null;
    const row = await this.prisma.executionCanaryAuthorization.findFirst({
      where: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW" },
      orderBy: { createdAt: "desc" },
    });
    if (!row) return null;

    const described = describeNaturalWindow(row, now);
    const remainingMs = row.expiresAt.getTime() - now.getTime();
    return {
      state: described.state,
      expiresAt: described.expiresAt,
      // Floored at zero: a negative countdown is noise, and EXPIRED already
      // carries that meaning.
      remainingTtlSeconds: Math.max(0, Math.floor(remainingMs / 1000)),
      maxClaims: described.maxClaims,
      claimedCount: described.claimedCount,
      remainingClaims: described.remainingClaims,
    };
  }

  private async readLatestExecution(profileId: string | null): Promise<TradingControlLatestExecutionDto | null> {
    if (!profileId) return null;
    const row = await this.prisma.tradeExecution.findFirst({
      where: { executionProfileId: profileId },
      orderBy: { updatedAt: "desc" },
      select: {
        symbol: true,
        direction: true,
        status: true,
        decisionReasonCode: true,
        exitReason: true,
        sourceTimeframe: true,
        updatedAt: true,
      },
    });
    if (!row) return null;
    return {
      symbol: row.symbol,
      direction: row.direction,
      status: row.status,
      // Both are sanitized codes the journal already shows; neither carries
      // account detail, an order id or a credential.
      reason: row.decisionReasonCode ?? row.exitReason ?? null,
      sourceTimeframe: row.sourceTimeframe,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so they can be tested without a database
// ---------------------------------------------------------------------------

export function describeReadiness(result: CanaryPreflightResult): TradingControlReadinessDto {
  return {
    preparationReady: result.preparationReady,
    // "Nothing blocks live activation" is exactly what an empty list means;
    // `ready` additionally requires preparation, which the panel shows apart.
    liveActivationReady: result.liveActivationBlockers.length === 0,
    summary: result.summary,
    preparationBlockers: result.preparationBlockers,
    liveActivationBlockers: result.liveActivationBlockers,
  };
}

/**
 * Effective limits, through the ONE min-merge.
 *
 * When the profile row is unreadable the global limits stand alone. That is the
 * honest reading: a limit that could not be read cannot be claimed to loosen or
 * tighten anything, and the readiness check raises the unreadable row as its
 * own blocker when the operator asks for it.
 */
function effectiveLimits(policy: ExecutionSafetyPolicy | null) {
  const global = {
    maxOpenPositions: env.EXECUTION_MAX_OPEN_POSITIONS,
    maxPendingEntries: env.EXECUTION_MAX_PENDING_ENTRIES,
    maxTotalActiveTrades: env.EXECUTION_MAX_TOTAL_ACTIVE_TRADES,
    maxActivePerSymbolSide: env.EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE,
    maxAlertAgeSeconds: env.EXECUTION_MAX_ALERT_AGE_SECONDS,
    softOpenPositionTarget: env.EXECUTION_SOFT_OPEN_POSITION_TARGET,
    maxTotalPlannedRiskUsd: env.EXECUTION_MAX_TOTAL_PLANNED_RISK_USD,
    maxTotalIsolatedMarginUsd: env.EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD,
  };
  if (!policy) return global;
  return mergeCapacityLimits(global, {
    maxOpenPositions: policy.maxOpenPositions,
    maxPendingEntries: policy.maxPendingEntries,
    maxTotalActiveTrades: policy.maxTotalActiveTrades,
    maxActivePerSymbolSide: policy.maxActivePerSymbolSide,
    maxAlertAgeSeconds: policy.maxAlertAgeSeconds,
    softOpenPositionTarget: policy.softOpenPositionTarget,
    // Decimals cross as STRINGS, never as numbers: the merge compares them as
    // decimals and returns the original string untouched.
    maxTotalPlannedRiskUsd: policy.maxTotalPlannedRiskUsd.toString(),
    maxTotalIsolatedMarginUsd: policy.maxTotalIsolatedMarginUsd.toString(),
  });
}

export function buildWarnings(input: {
  systemState: TradingSystemState;
  attestation: TradingControlAttestationDto;
  manualCount: number;
  unprotectedCount: number;
  capacity: TradingControlCapacityDto;
  authorizationState: string | null;
}): TradingControlWarning[] {
  const warnings: TradingControlWarning[] = [];

  if (input.systemState === "INVALID") {
    warnings.push({
      code: "INVALID_STATE",
      detail:
        "Profile is disabled with the kill switch released. No operator command commits this combination — the profile was changed outside the operator path.",
    });
  }
  if (input.systemState === "UNKNOWN") {
    warnings.push({
      code: "STATE_UNKNOWN",
      detail: "The execution profile or its safety policy could not be read, so the system state is unknown.",
    });
  }
  if (input.attestation.status !== "PASS") {
    warnings.push({
      code: "RUNTIME_ATTESTATION_BLOCKED",
      detail: input.attestation.message ?? "Runtime attestation is not passing.",
    });
  }
  if (input.manualCount > 0) {
    warnings.push({
      code: "MANUAL_INTERVENTION_REQUIRED",
      detail: `${input.manualCount} execution(s) require manual intervention.`,
    });
  }
  if (input.unprotectedCount > 0) {
    warnings.push({
      code: "FILLED_WITHOUT_VERIFIED_PROTECTION",
      detail: `${input.unprotectedCount} filled position(s) are not yet in a verified PROTECTED state.`,
    });
  }
  if (input.capacity.hardTotal > 0 && input.capacity.totalActive >= input.capacity.hardTotal) {
    warnings.push({
      code: "CAPACITY_EXHAUSTED",
      detail: `${input.capacity.totalActive} of ${input.capacity.hardTotal} total active slots are in use.`,
    });
  }
  if (input.authorizationState === "EXPIRED") {
    warnings.push({
      code: "NATURAL_AUTHORIZATION_EXPIRED",
      detail: "The most recent natural authorization window has expired.",
    });
  }

  return warnings;
}
