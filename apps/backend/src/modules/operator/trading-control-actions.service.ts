import type { PrismaClient } from "@prisma/client";

import { CanaryAuthorizationService, NaturalWindowValidationError } from "../execution/canary-authorization.service";
import { CanaryPreflightService } from "../execution/canary-preflight.service";
import { CANARY_NATURAL_MAX_CLAIMS } from "../execution/canary-readiness";
import { configuredProfileIdentity, resolveExecutionProfile } from "../execution/execution-profile.service";
import { armNaturalWindow } from "../execution/natural-arm";
import { NATURAL_DIRECTIONS, describeNaturalWindow } from "../execution/natural-authorization";
import {
  closeCanaryWindowOperation,
  disarmCanaryOperation,
  environmentIsArmed,
} from "../execution/operator-actions";
import {
  configuredRuntimeIdentity,
  currentProcessGateSnapshot,
  readRuntimeAttestationStatusOnce,
  type RuntimeAttestationStatus,
} from "../runtime/runtime-attestation";
import { mapTradingSystemState, type TradingSystemState } from "./trading-control.service";

/**
 * The three operator actions, over HTTP.
 *
 * Every one of them is a thin wrapper. Start prepares a natural window with the
 * reviewed service and hands it to `armNaturalWindow`; Stop New Trades calls
 * `closeCanaryWindowOperation`; Safe Off calls `disarmCanaryOperation`. Those
 * are the same functions the operator CLI calls, so there is exactly one
 * implementation of each control and one operator state machine.
 *
 * Nothing here re-implements admission, claims, locking or recovery. Nothing
 * here reaches the exchange, cancels an order or closes a position. Nothing
 * here writes an environment variable.
 *
 * ## Why Start can be BLOCKED on a correctly configured system
 *
 * Arming requires the ENVIRONMENT activation gates, and those are process
 * environment variables parsed once at import. No code in this repository
 * writes them, deliberately: a browser button that could flip
 * `EXECUTION_LIVE_ENTRY_ENABLED` would defeat the point of having the gate at
 * all. The runtime-attestation interlock then requires the running backend AND
 * worker to have loaded those same armed values.
 *
 * So Start Trading is the LAST step of activation, never the first: an operator
 * still edits `.env` and restarts the stack out of band, and this button
 * performs the durable state transition once that is true. Until then it
 * refuses with the authoritative reason.
 */

// The reviewed first-live defaults. The browser cannot change any of them.
export const START_TRADING_DIRECTIONS: readonly string[] = NATURAL_DIRECTIONS;
export const START_TRADING_TTL_MINUTES = 60;
export const START_TRADING_MAX_CLAIMS = CANARY_NATURAL_MAX_CLAIMS;

/** Typed exactly, so a near-miss is a refusal rather than a coercion. */
export const START_TRADING_CONFIRMATION = "START TRADING";

export type TradingControlActionOutcome =
  | "ARMED"
  | "ALREADY_ARMED"
  | "NEW_TRADES_BLOCKED"
  | "SAFE_OFF"
  | "SAFE_RECOVERY"
  | "BLOCKED"
  | "WINDOW_PREPARED_NOT_ARMED";

export interface ActionProfileDto {
  /** Environment only; the account identifier never leaves the server. */
  environment: string;
  isEnabled: boolean;
  killSwitchActive: boolean | null;
}

export interface ActionAuthorizationDto {
  /** The window id. It is an opaque row id and carries no secret. */
  id: string;
  state: string;
  expiresAt: string;
  maxClaims: number | null;
  claimedCount: number;
  remainingClaims: number;
}

export interface TradingControlActionResult {
  ok: boolean;
  outcome: TradingControlActionOutcome;
  systemState: TradingSystemState;
  profile: ActionProfileDto | null;
  authorization: ActionAuthorizationDto | null;
  outstandingExecutions: number | null;
  authorizationsRevoked: number | null;
  /** Sanitized, operator-readable. Never a stack trace or a connection string. */
  blockers: string[];
  message: string;
}

export interface TradingControlActionOptions {
  preflight?: Pick<CanaryPreflightService, "run">;
  readAttestation?: () => Promise<RuntimeAttestationStatus>;
  /** Injected so a test never depends on the suite process's own env snapshot. */
  environmentArmed?: () => boolean;
  now?: () => Date;
}

function blocked(blockers: string[], message: string): TradingControlActionResult {
  return {
    ok: false,
    outcome: "BLOCKED",
    systemState: "UNKNOWN",
    profile: null,
    authorization: null,
    outstandingExecutions: null,
    authorizationsRevoked: null,
    blockers,
    message,
  };
}

export class TradingControlActionsService {
  private readonly preflight: Pick<CanaryPreflightService, "run">;
  private readonly readAttestation: () => Promise<RuntimeAttestationStatus>;
  private readonly environmentArmed: () => boolean;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    options: TradingControlActionOptions = {}
  ) {
    this.preflight = options.preflight ?? new CanaryPreflightService(prisma);
    this.readAttestation =
      options.readAttestation ??
      (() =>
        readRuntimeAttestationStatusOnce({
          identity: configuredRuntimeIdentity(),
          expected: currentProcessGateSnapshot(),
        }));
    this.environmentArmed = options.environmentArmed ?? environmentIsArmed;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * START TRADING — prepare one natural window, then arm on it.
   *
   * The confirmation phrase is checked on the SERVER. The browser dialog is a
   * courtesy to the operator; it is not the boundary, because anything a
   * browser enforces can be skipped by not using a browser.
   */
  async startTrading(confirmation: unknown): Promise<TradingControlActionResult> {
    if (confirmation !== START_TRADING_CONFIRMATION) {
      return blocked(
        ["CONFIRMATION_REQUIRED"],
        `This action requires the exact confirmation phrase "${START_TRADING_CONFIRMATION}". Nothing was changed.`
      );
    }

    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    if (!resolution.ok) return blocked([`${resolution.reasonCode}`], resolution.message);
    const profile = resolution.profile;
    const policy = profile.safetyPolicy;
    if (!policy) {
      return blocked(["PROFILE_POLICY_MISSING"], "The profile has no safety policy row; effective limits cannot be proven.");
    }

    // --- Everything that does not depend on the window, FIRST ---------------
    // Checked before preparing so a refusal we could already predict does not
    // leave an orphan window behind.
    const blockers: string[] = [];

    // The same staged rule the arm CLI applies: preparation must be complete,
    // and the dimensions arming does NOT resolve must already pass. Demanding a
    // fully READY verdict would be unsatisfiable, because the profile kill
    // switch is itself a live-activation blocker and is exactly what arming
    // releases.
    const preflight = await this.preflight.run("NATURAL_WINDOW");
    for (const finding of preflight.preparationBlockers) blockers.push(`${finding.code}: ${finding.detail}`);
    for (const finding of preflight.liveActivationBlockers) {
      if (finding.code === "CANARY_BLOCKED_POLICY") blockers.push(`${finding.code}: ${finding.detail}`);
    }

    // Environment gates are NOT database state and nothing here writes them.
    // `.env` plus a restart is the only way they move.
    if (!this.environmentArmed()) {
      blockers.push(
        "ENVIRONMENT_GATES_NOT_ARMED: the activation gates are not in the required state. Edit .env and restart the runtime first."
      );
    }

    // This process's own env snapshot proves nothing about what the RUNNING
    // backend and worker loaded. Read before any write.
    const attestation = await this.readAttestation();
    if (!attestation.ok) blockers.push(`${attestation.reasonCode}: ${attestation.message}`);

    if (blockers.length > 0) {
      const state = await this.describeProfile(profile.id);
      return {
        ...blocked(blockers, "Start refused. No window was created and the profile was not armed."),
        systemState: state.systemState,
        profile: state.profile,
      };
    }

    // --- Prepare ONE window with the reviewed service -----------------------
    let window;
    try {
      window = await new CanaryAuthorizationService(this.prisma).prepareNaturalWindow({
        executionProfileId: profile.id,
        allowedDirections: START_TRADING_DIRECTIONS,
        maxClaims: START_TRADING_MAX_CLAIMS,
        ttlMinutes: START_TRADING_TTL_MINUTES,
        now: this.now(),
      });
    } catch (error) {
      // Preparation refuses an already-active window by design; that refusal is
      // the reviewed exclusivity rule, not an error to work around.
      const reason =
        error instanceof NaturalWindowValidationError
          ? `${error.reasonCode}: ${error.message}`
          : error instanceof Error && error.name === "CanaryAuthorizationAlreadyActiveError"
            ? `AUTHORIZATION_ALREADY_ACTIVE: ${error.message}`
            : "PREPARATION_FAILED: the natural window could not be prepared.";
      const state = await this.describeProfile(profile.id);
      return {
        ...blocked([reason], "Start refused during preparation. The profile was not armed."),
        systemState: state.systemState,
        profile: state.profile,
      };
    }

    // --- Arm on it. Re-reads everything under the shared advisory lock. -----
    const result = await this.prisma.$transaction((tx) =>
      armNaturalWindow(tx, {
        executionProfileId: profile.id,
        authorizationId: window.id,
        expectedWindowVersion: window.version,
        expectedPolicyVersion: policy.version,
        expectedAllowedSymbols: policy.allowedSymbols,
      })
    );

    const state = await this.describeProfile(profile.id);
    const authorization = await this.describeAuthorization(window.id);

    if (!result.ok) {
      // The reviewed semantics, reported honestly: preparation is NOT rolled
      // back, so a window now exists while the profile is still safe. Inventing
      // a cross-operation rollback here would be a new behaviour nobody has
      // reviewed; showing the truth lets the operator disarm or retry.
      return {
        ok: false,
        outcome: "WINDOW_PREPARED_NOT_ARMED",
        systemState: state.systemState,
        profile: state.profile,
        authorization,
        outstandingExecutions: null,
        authorizationsRevoked: null,
        blockers: [`${result.reasonCode}: ${result.message}`],
        message:
          "A natural window was prepared but arming refused. The profile was NOT armed. Use Safe Off to revoke the unused window.",
      };
    }

    return {
      ok: true,
      outcome: result.alreadyArmed ? "ALREADY_ARMED" : "ARMED",
      systemState: state.systemState,
      profile: state.profile,
      authorization,
      outstandingExecutions: null,
      authorizationsRevoked: null,
      blockers: [],
      message: result.alreadyArmed
        ? "The profile was already armed; nothing was changed."
        : "Armed. No signal was sent, no execution was created and no claim was spent.",
    };
  }

  /**
   * STOP NEW TRADES — the reviewed CLOSE.
   *
   * Engages the profile kill switch so no new admission is possible. It cancels
   * nothing, closes nothing and revokes nothing: existing executions stay under
   * the worker's protection and reconciliation, which is the whole difference
   * between this and Safe Off.
   */
  async stopNewTrades(): Promise<TradingControlActionResult> {
    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    if (!resolution.ok) return blocked([`${resolution.reasonCode}`], resolution.message);
    const profile = resolution.profile;

    const outcome = await closeCanaryWindowOperation(this.prisma, profile.id);
    const state = await this.describeProfile(profile.id);

    return {
      ok: true,
      outcome: "NEW_TRADES_BLOCKED",
      systemState: state.systemState,
      profile: state.profile,
      authorization: null,
      outstandingExecutions: outcome.active,
      authorizationsRevoked: null,
      blockers: [],
      message:
        outcome.active > 0 || outcome.recovery > 0
          ? "New admission is blocked. A live execution still exists — it was NOT cancelled or closed, and protection and reconciliation continue."
          : "New admission is blocked. No live execution remains.",
    };
  }

  /**
   * SAFE OFF — the reviewed DISARM.
   *
   * Kill switch first, then revoke anything unused, then disable the profile
   * ONLY when nothing is left running. Recovery is never disabled beneath an
   * open execution.
   */
  async safeOff(): Promise<TradingControlActionResult> {
    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    if (!resolution.ok) return blocked([`${resolution.reasonCode}`], resolution.message);
    const profile = resolution.profile;

    const outcome = await disarmCanaryOperation(this.prisma, profile.id);
    const state = await this.describeProfile(profile.id);

    return {
      ok: true,
      outcome: outcome.outstanding > 0 ? "SAFE_RECOVERY" : "SAFE_OFF",
      systemState: state.systemState,
      profile: state.profile,
      authorization: null,
      outstandingExecutions: outcome.outstanding,
      authorizationsRevoked: outcome.revoked,
      blockers: [],
      message:
        outcome.outstanding > 0
          ? "Disarmed for new work. Outstanding executions remain managed, so the profile was NOT disabled and nothing was cancelled."
          : "Safe off. The profile is disabled and the kill switch is engaged.",
    };
  }

  private async describeProfile(
    profileId: string
  ): Promise<{ systemState: TradingSystemState; profile: ActionProfileDto | null }> {
    const row = await this.prisma.executionProfile.findUnique({
      where: { id: profileId },
      include: { safetyPolicy: true },
    });
    if (!row) return { systemState: "UNKNOWN", profile: null };
    const killSwitchActive = row.safetyPolicy?.killSwitchActive ?? null;
    return {
      systemState: mapTradingSystemState(row.isEnabled, killSwitchActive),
      profile: { environment: row.environment, isEnabled: row.isEnabled, killSwitchActive },
    };
  }

  private async describeAuthorization(authorizationId: string): Promise<ActionAuthorizationDto | null> {
    const row = await this.prisma.executionCanaryAuthorization.findUnique({ where: { id: authorizationId } });
    if (!row) return null;
    // Described by the authority that owns the semantics. The row itself, which
    // can carry a token hash for exact authorizations, never leaves here.
    const described = describeNaturalWindow(row, this.now());
    return {
      id: row.id,
      state: described.state,
      expiresAt: described.expiresAt,
      maxClaims: described.maxClaims,
      claimedCount: described.claimedCount,
      remainingClaims: described.remainingClaims,
    };
  }
}
