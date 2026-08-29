import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import { CanaryAuthorizationService, NaturalWindowValidationError } from "../execution/canary-authorization.service";
import { CanaryPreflightService } from "../execution/canary-preflight.service";
import { CANARY_NATURAL_MAX_CLAIMS } from "../execution/canary-readiness";
import {
  SESSION_DURATION_PRESET_MINUTES,
  derivedSessionStatus,
  validateSessionBudget,
  validateSessionDuration,
} from "../execution/trading-session";
import {
  OPEN_POSITION_STATUSES,
  PENDING_ENTRY_STATUSES,
  TOTAL_ACTIVE_STATUSES,
} from "../execution/capacity-status";
import type { TradeExecutionStatusName } from "../execution/execution-status";
import { evaluateResumeReadiness } from "../execution/resume-readiness";
import { env } from "../../config/env";
import { resolveSessionCapability } from "./session-capability";
import {
  findCurrentSession,
  pauseSession,
  resumeSession,
  revokeCurrentSession,
} from "../execution/trading-session.service";
import { logger } from "../../config/logger";
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

/**
 * The trade budget a session gets when the caller does not choose one.
 *
 * Deliberately the historical claim budget. Before sessions, a Start Trading
 * with no budget argument produced a window that could admit five executions;
 * it now produces a session that can OPEN five trades. That is the same
 * posture expressed in better units — and a caller who never mentions a budget
 * is never silently given a larger one.
 */
export const START_TRADING_DEFAULT_TRADE_BUDGET = CANARY_NATURAL_MAX_CLAIMS;

/**
 * The durations the panel offers as one-click choices.
 *
 * The historical 15/30/60 set is now 1h/6h/12h/24h/3d/7d/30d, and the set is
 * not exhaustive: a CUSTOM duration is accepted too. What makes that safe is
 * that presets and custom values run through the SAME validator
 * (`validateSessionDuration`), which enforces the 30-day ceiling. A preset is
 * a convenience, never a second code path that could admit what custom cannot.
 *
 * Derived from the session module's presets rather than restated, so the panel
 * cannot offer a duration the validator would refuse.
 */
export const START_TRADING_DURATION_CHOICES = SESSION_DURATION_PRESET_MINUTES;
export type StartTradingDuration = (typeof START_TRADING_DURATION_CHOICES)[number];

/**
 * Resolves a submitted duration, FAIL CLOSED.
 *
 * `undefined` means "not supplied" and takes the reviewed default. Everything
 * else — preset or custom — is judged by the session validator, so a numeric
 * string, a float, a negative or a value past 30 days are refusals rather than
 * coercions.
 */
export function resolveStartTradingDuration(
  value: unknown
): { ok: true; minutes: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, minutes: START_TRADING_TTL_MINUTES };
  if (typeof value !== "number") {
    return { ok: false, message: "durationMinutes must be a number of minutes. Nothing was changed." };
  }
  const verdict = validateSessionDuration(value);
  return verdict.ok
    ? { ok: true, minutes: verdict.minutes }
    : { ok: false, message: `${verdict.reason} Nothing was changed.` };
}

/**
 * Resolves a submitted trade budget, FAIL CLOSED.
 *
 * `unlimitedPermitted` is decided by the SERVER from the execution
 * environment. A request for unlimited that the server cannot justify is
 * refused outright rather than downgraded to a finite budget — quietly trading
 * a different configuration from the one asked for is worse than refusing.
 */
export function resolveStartTradingBudget(
  value: unknown,
  unlimited: unknown
): { ok: true; tradeBudget: number | null; unlimited: boolean } | { ok: false; message: string } {
  // Not supplied means "the reviewed default", exactly as an unsupplied
  // duration does. The default is the HISTORICAL budget, so a caller that says
  // nothing about trades gets precisely the posture it got before sessions
  // existed — this feature widens what an operator may ASK for, it does not
  // quietly widen what an existing caller receives.
  if (value === undefined && unlimited === undefined) {
    return { ok: true, tradeBudget: START_TRADING_DEFAULT_TRADE_BUDGET, unlimited: false };
  }
  const capability = resolveSessionCapability();
  const verdict = validateSessionBudget(value, {
    unlimited,
    unlimitedPermitted: capability.unlimitedPermitted,
  });
  return verdict.ok
    ? { ok: true, tradeBudget: verdict.tradeBudget, unlimited: verdict.unlimited }
    : { ok: false, message: `${verdict.reason} Nothing was changed.` };
}

/** Typed exactly, so a near-miss is a refusal rather than a coercion. */
export const START_TRADING_CONFIRMATION = "START TRADING";

/**
 * Resume reopens LIVE admission, so it is confirmed exactly as starting is.
 *
 * Pause deliberately has NO confirmation phrase. It only ever makes the system
 * safer, and an operator reaching for it during an incident should not have to
 * type anything to stop new trades.
 */
export const RESUME_TRADING_CONFIRMATION = "RESUME TRADING";

export type TradingControlActionOutcome =
  | "ARMED"
  | "ALREADY_ARMED"
  | "NEW_TRADES_BLOCKED"
  | "SAFE_OFF"
  | "SAFE_RECOVERY"
  | "BLOCKED"
  | "WINDOW_PREPARED_NOT_ARMED"
  | "PAUSED"
  | "ALREADY_PAUSED"
  | "RESUMED"
  | "ALREADY_ACTIVE";

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
  async startTrading(
    confirmation: unknown,
    durationMinutes?: unknown,
    tradeBudget?: unknown,
    unlimited?: unknown
  ): Promise<TradingControlActionResult> {
    if (confirmation !== START_TRADING_CONFIRMATION) {
      return blocked(
        ["CONFIRMATION_REQUIRED"],
        `This action requires the exact confirmation phrase "${START_TRADING_CONFIRMATION}". Nothing was changed.`
      );
    }

    // Validated before the profile is even resolved: a duration nobody
    // reviewed must not reach preparation.
    const duration = resolveStartTradingDuration(durationMinutes);
    if (!duration.ok) return blocked(["DURATION_INVALID"], duration.message);

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

    // Validated before anything is prepared, for the same reason the duration
    // is: a budget nobody reviewed must not reach session creation. The
    // unlimited rule is decided here from the SERVER's own view of the
    // execution environment, never from what the browser claimed.
    const budget = resolveStartTradingBudget(tradeBudget, unlimited);
    if (!budget.ok) return blocked(["SESSION_BUDGET_INVALID"], budget.message);

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

    // --- The session, BEFORE the window it will back ------------------------
    //
    // Ordering is the whole safety argument, and it used to run the other way.
    // The window was prepared and ARMED first and linked afterwards, which
    // left a committed state of: armed profile + usable NATURAL window +
    // tradingSessionId null. A crash there produced a window indistinguishable
    // from a LEGACY one — and a legacy window admits up to maxClaims trades
    // with no session at all, the exact opposite of what a session-backed
    // start promises.
    //
    // Creating the session first turns every crash window into a safe one:
    //
    //   after this write  session exists, NO window   -> admits nothing;
    //                     admission requires an authorization
    //   after prepare     window exists ALREADY LINKED, profile not armed
    //                     -> admits nothing; kill switch still engaged
    //   after arm         the intended state
    //
    // At no point does a USABLE window exist with a null link.
    //
    // Any older ACTIVE session is retired in the same transaction, so a
    // profile never carries two. It cannot strand a live window: preparation
    // below refuses outright while an active authorization exists, so at this
    // point no window is pointing at the session being retired.
    //
    // ONE instant, read once, used by BOTH writes.
    //
    // The session and its authorization used to derive their expiry from
    // separate `this.now()` reads. At an hour that drift was invisible; the
    // rule it broke was not, and the rule matters more the longer a session
    // runs: the window says trading is permitted and until when, so a window
    // that expires even a moment before its session stops admission while the
    // session still reports time remaining. Deriving both from `startedAt`
    // makes them equal by construction rather than by luck.
    //
    // `startedAt` is also written explicitly rather than left to the column's
    // `now()` default, so `expiresAt - startedAt` IS the requested duration
    // and does not straddle two clocks.
    const startedAt = this.now();
    const expiresAt = new Date(startedAt.getTime() + duration.minutes * 60_000);

    const session = await this.prisma.$transaction(async (tx) => {
      // ACTIVE **or PAUSED**. Starting a new session must not leave a paused
      // one behind: it would still be resumable, and resuming it would put a
      // second session's authorization beside the new one's.
      await tx.tradingSession.updateMany({
        where: { executionProfileId: profile.id, status: { in: ["ACTIVE", "PAUSED"] } },
        data: { status: "REVOKED", endedAt: startedAt, version: { increment: 1 } },
      });
      return tx.tradingSession.create({
        data: {
          executionProfileId: profile.id,
          status: "ACTIVE",
          tradeBudget: budget.tradeBudget,
          unlimited: budget.unlimited,
          startedAt,
          expiresAt,
        },
      });
    });

    /**
     * Retires the session this call just opened.
     *
     * Only ever reached on a path that leaves NOTHING armed, so it is cleanup
     * rather than a rollback of a reviewed primitive. A failure to clean up is
     * swallowed on purpose: an orphan ACTIVE session with no armed profile and
     * no window can admit nothing, and letting cleanup failure mask the
     * refusal being reported would be the worse outcome.
     */
    const abandonSession = async () => {
      try {
        await this.prisma.tradingSession.updateMany({
          where: { id: session.id, status: "ACTIVE" },
          data: { status: "REVOKED", endedAt: this.now(), version: { increment: 1 } },
        });
      } catch {
        // Intentionally ignored; see above.
      }
    };

    // --- Prepare ONE window with the reviewed service -----------------------
    let window;
    try {
      window = await new CanaryAuthorizationService(this.prisma).prepareNaturalWindow({
        executionProfileId: profile.id,
        allowedDirections: START_TRADING_DIRECTIONS,
        maxClaims: START_TRADING_MAX_CLAIMS,
        ttlMinutes: duration.minutes,
        // Linked at CREATION, never afterwards.
        tradingSessionId: session.id,
        // The SAME instant the session was measured from, so the window's
        // expiry lands exactly on the session's rather than milliseconds
        // before it.
        now: startedAt,
      });
    } catch (error) {
      await abandonSession();
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
      // Nothing is armed on this path, so the session opened above is retired.
      // The WINDOW is deliberately left alone — see below.
      await abandonSession();
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

    // The window was created already carrying this session's id, so there is
    // no linking step left to fail, and nothing to reconcile here.
    //
    // `alreadyArmed` describes the PROFILE, not the window: it means the kill
    // switch was already released, so arming had no state to change. The
    // window prepared moments ago is still the live one — preparation refuses
    // outright while another active authorization exists — so this session is
    // the session backing it, and reporting an older one instead would point
    // the operator at a session no window is bound to.
    logger.info(
      {
        sessionId: session.id,
        durationMinutes: duration.minutes,
        tradeBudget: budget.tradeBudget,
        unlimited: budget.unlimited,
      },
      "Trading session opened"
    );

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
        : `Armed for ${duration.minutes} minutes with a budget of ${
            budget.unlimited ? "unlimited" : budget.tradeBudget
          } opened trade(s). No signal was sent and no execution was created.`,
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
    // The session ends with the same control that blocks admission, so there
    // is no second "stop" an operator has to remember. Ending it prohibits new
    // RESERVATIONS; it erases no history and touches no live execution —
    // openedCount stays exactly where it is, and slots already reserved still
    // resolve normally as their entries fill or expire.
    await revokeCurrentSession(this.prisma, profile.id, this.now());
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
    // Safe Off ends the session for the same reason it revokes the window:
    // both are permission to start something new, and neither disturbs work
    // already running. Existing executions keep their protection and
    // reconciliation, and their reserved slots still resolve normally.
    await revokeCurrentSession(this.prisma, profile.id, this.now());
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

  /**
   * PAUSE NEW TRADES — stop admitting, keep the session.
   *
   * The difference from Stop New Trades is one word in the session write:
   * PAUSED rather than REVOKED. Everything else is identical, and identical on
   * purpose — the kill switch is engaged through the same reviewed primitive,
   * nothing is cancelled, nothing is closed, and every execution already on the
   * book keeps its normal lifecycle.
   *
   * TWO gates end up closed, which is deliberate rather than redundant:
   *
   *   - the kill switch, which blocks admission for every mode including
   *     legacy and EXACT_SIGNAL;
   *   - the session status, which `reserveSessionSlot`'s conditional UPDATE
   *     requires to be ACTIVE before it will take a slot.
   *
   * Either alone would stop new trades. Together they mean a partial failure
   * of this method still stops them: the kill switch lands first, so a crash
   * before the session write leaves admission blocked and the session still
   * ACTIVE — visible, recoverable, and never permissive.
   */
  async pauseNewTrades(): Promise<TradingControlActionResult> {
    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    if (!resolution.ok) return blocked([`${resolution.reasonCode}`], resolution.message);
    const profile = resolution.profile;

    // Kill switch FIRST. Pausing is a safety action, so the half that makes
    // the system safer must not wait on the half that is bookkeeping.
    const outcome = await closeCanaryWindowOperation(this.prisma, profile.id);
    const paused = await pauseSession(this.prisma, profile.id, this.now());
    const state = await this.describeProfile(profile.id);

    if (!paused.ok) {
      // Admission is ALREADY blocked by the kill switch above, so this is a
      // reporting failure rather than a safety one. Said plainly rather than
      // dressed up as success: the operator asked for a resumable pause and
      // did not get one, and Start Trading is now the way forward.
      return {
        ok: false,
        outcome: "BLOCKED",
        systemState: state.systemState,
        profile: state.profile,
        authorization: null,
        outstandingExecutions: outcome.active,
        authorizationsRevoked: null,
        blockers: [`${paused.reasonCode}: ${paused.message}`],
        message:
          "New admission is blocked and nothing was cancelled, but the session could not be " +
          "paused, so it cannot be resumed. Use Start Trading for a new session, or Safe Off.",
      };
    }

    return {
      ok: true,
      outcome: paused.alreadyThere ? "ALREADY_PAUSED" : "PAUSED",
      systemState: state.systemState,
      profile: state.profile,
      authorization: null,
      outstandingExecutions: outcome.active,
      authorizationsRevoked: null,
      blockers: [],
      message:
        outcome.active > 0 || outcome.recovery > 0
          ? "New trades are paused. Live executions remain managed — nothing was cancelled or closed, and protection and reconciliation continue. Resume when ready."
          : "New trades are paused. No live execution remains. Resume when ready.",
    };
  }

  /**
   * RESUME NEW TRADES — reopen admission for the SAME session.
   *
   * Not a lighter Start Trading. Start mints a session and demands a clean
   * account; Resume mints nothing and expects a busy one. The session it
   * reopens is the row that is already there, with its original id, budget,
   * counts and expiry — this method has no path that can create a session,
   * move an expiry, or change a count.
   *
   * The order is: prove everything, arm, then unpause. Arming last is what
   * makes a crash safe, and the reasoning is worth stating because the obvious
   * order is wrong:
   *
   *   crash after arm, before unpause -> profile armed, session PAUSED.
   *     `reserveSessionSlot` requires ACTIVE, so nothing is admitted, and
   *     pressing Resume again completes the transition.
   *   crash after unpause, before arm -> session ACTIVE, kill switch engaged.
   *     Nothing is admitted either, but the session no longer reads PAUSED, so
   *     Resume would refuse and the operator would be stuck with a session
   *     that looks live and cannot trade.
   *
   * The first is recoverable and the second is a trap, so the session write
   * goes last.
   */
  async resumeNewTrades(confirmation: unknown): Promise<TradingControlActionResult> {
    if (confirmation !== RESUME_TRADING_CONFIRMATION) {
      return blocked(
        ["CONFIRMATION_REQUIRED"],
        `Resume requires the exact confirmation phrase "${RESUME_TRADING_CONFIRMATION}". Nothing was changed.`
      );
    }

    const resolution = await resolveExecutionProfile(this.prisma, configuredProfileIdentity());
    if (!resolution.ok) return blocked([`${resolution.reasonCode}`], resolution.message);
    const profile = resolution.profile;

    const session = await findCurrentSession(this.prisma, profile.id);
    if (!session) {
      return blocked(
        ["NO_SESSION"],
        "There is no trading session to resume. Use Start Trading to begin a new one."
      );
    }
    // Checked BEFORE any work, and again inside `resumeSession` under a CAS.
    // This one produces the operator-facing message; that one is the guard.
    //
    // ACTIVE is allowed through deliberately, so a second Resume is a no-op
    // rather than an error: it re-runs every check and every guard, finds
    // nothing to change, and reports ALREADY_ACTIVE. Only a TERMINAL session
    // is refused here — those are the ones a resume would have to resurrect.
    const derived = derivedSessionStatus(session, this.now());
    if (derived !== "PAUSED" && derived !== "ACTIVE") {
      return blocked(
        [`SESSION_${derived}`],
        `The trading session is ${derived} and cannot be resumed. Use Start Trading to begin a new one.`
      );
    }

    const blockers: string[] = [];

    // Environment gates are NOT database state; nothing here writes them.
    if (!this.environmentArmed()) {
      blockers.push(
        "ENVIRONMENT_GATES_NOT_ARMED: the activation gates are not in the required state. Edit .env and restart the runtime first."
      );
    }

    // The whole point of the motivating incident. A worker that went stale is
    // exactly why the operator paused, so Resume must prove the runtime came
    // back rather than assume it. Never a bypass.
    const attestation = await this.readAttestation();
    if (!attestation.ok) blockers.push(`${attestation.reasonCode}: ${attestation.message}`);

    // The same evidence Start Trading gathers, judged by the RESUME rule.
    //
    // EVERY finding is handed over, both scopes, deliberately. The evaluator
    // owns the decision about which ones a resume may pass, and one of them —
    // the engaged kill switch — is the normal posture of a paused profile and
    // is released by the arming below. Filtering here instead would put half
    // that decision in this file and make it look like a scope question.
    const preflight = await this.preflight.run("NATURAL_WINDOW");
    const readiness = evaluateResumeReadiness({
      findings: preflight.findings,
      globalLimits: {
        maxOpenPositions: env.EXECUTION_MAX_OPEN_POSITIONS,
        maxPendingEntries: env.EXECUTION_MAX_PENDING_ENTRIES,
        maxTotalActiveTrades: env.EXECUTION_MAX_TOTAL_ACTIVE_TRADES,
        maxActivePerSymbolSide: env.EXECUTION_MAX_ACTIVE_PER_SYMBOL_SIDE,
        softOpenPositionTarget: env.EXECUTION_SOFT_OPEN_POSITION_TARGET,
        maxTotalPlannedRiskUsd: env.EXECUTION_MAX_TOTAL_PLANNED_RISK_USD,
        maxTotalIsolatedMarginUsd: env.EXECUTION_MAX_TOTAL_ISOLATED_MARGIN_USD,
      },
      profileLimits: await this.readProfileLimits(profile.id),
      exposure: await this.readExposure(profile.id),
    });
    blockers.push(...readiness.blockers);

    // The window that already backs THIS session, found by the session's own
    // id rather than by "the newest window": a stale window belonging to an
    // older session must never be the one re-armed.
    const window = await this.prisma.executionCanaryAuthorization.findFirst({
      where: {
        executionProfileId: profile.id,
        authorizationType: "NATURAL_WINDOW",
        tradingSessionId: session.id,
        revokedAt: null,
        expiresAt: { gt: this.now() },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!window) {
      blockers.push(
        "RESUME_BLOCKED_AUTHORIZATION: this session has no live authorization window. " +
          "It was revoked or has expired, so admission cannot be reopened for it."
      );
    }

    const policy = await this.prisma.executionSafetyPolicy.findUnique({
      where: { executionProfileId: profile.id },
    });
    if (!policy) blockers.push("POLICY_MISSING: the profile has no safety policy row.");

    if (blockers.length > 0 || !window || !policy) {
      const state = await this.describeProfile(profile.id);
      return {
        ...blocked(blockers, "Resume refused. Nothing was changed and the session is still paused."),
        systemState: state.systemState,
        profile: state.profile,
      };
    }

    // Re-arms the EXISTING window through the reviewed primitive, so every
    // arming guard applies again: window version, policy version, allowlist,
    // remaining TTL and the pinned maxClaims are all re-read under the profile
    // advisory lock and compared by CAS. No new authorization is created, so
    // the session keeps the window it was born with and the session-backed
    // rule that it spends NO claims is untouched.
    const armed = await this.prisma.$transaction((tx) =>
      armNaturalWindow(tx, {
        executionProfileId: profile.id,
        authorizationId: window.id,
        expectedWindowVersion: window.version,
        expectedPolicyVersion: policy.version,
        expectedAllowedSymbols: policy.allowedSymbols,
      })
    );
    if (!armed.ok) {
      const state = await this.describeProfile(profile.id);
      return {
        ...blocked(
          [`${armed.reasonCode}: ${armed.message}`],
          "Resume refused while re-arming. The profile was NOT armed and the session is still paused."
        ),
        systemState: state.systemState,
        profile: state.profile,
      };
    }

    const resumed = await resumeSession(this.prisma, profile.id, this.now());
    const state = await this.describeProfile(profile.id);
    if (!resumed.ok) {
      // Armed, but the session did not move. Admission stays closed because
      // the session gate is the one that refuses, so this is safe — and
      // pressing Resume again re-runs the whole thing idempotently.
      return {
        ...blocked(
          [`${resumed.reasonCode}: ${resumed.message}`],
          "Resume did not complete: the session was not reopened, so no new trade is admitted. Try again, or use Safe Off."
        ),
        systemState: state.systemState,
        profile: state.profile,
      };
    }

    logger.info(
      {
        sessionId: resumed.session.id,
        openedCount: resumed.session.openedCount,
        reservedCount: resumed.session.reservedCount,
        expiresAt: resumed.session.expiresAt.toISOString(),
        alreadyActive: resumed.alreadyThere,
      },
      "operator resumed new trades on the existing trading session"
    );

    return {
      ok: true,
      outcome: resumed.alreadyThere ? "ALREADY_ACTIVE" : "RESUMED",
      systemState: state.systemState,
      profile: state.profile,
      authorization: await this.describeAuthorization(window.id),
      outstandingExecutions: null,
      authorizationsRevoked: null,
      blockers: [],
      message:
        `New trades resumed on the existing session. Budget and expiry are unchanged: ` +
        `${resumed.session.openedCount} opened, ${resumed.session.reservedCount} reserved, ` +
        `expiring ${resumed.session.expiresAt.toISOString()}.`,
    };
  }

  /** This profile's stored limits, in the shape the resume evaluator wants. */
  private async readProfileLimits(profileId: string) {
    const row = await this.prisma.executionSafetyPolicy.findUnique({
      where: { executionProfileId: profileId },
    });
    if (!row) return null;
    return {
      maxOpenPositions: row.maxOpenPositions,
      maxPendingEntries: row.maxPendingEntries,
      maxTotalActiveTrades: row.maxTotalActiveTrades,
      maxActivePerSymbolSide: row.maxActivePerSymbolSide,
      softOpenPositionTarget: row.softOpenPositionTarget,
      maxTotalPlannedRiskUsd: row.maxTotalPlannedRiskUsd.toString(),
      maxTotalIsolatedMarginUsd: row.maxTotalIsolatedMarginUsd.toString(),
    };
  }

  /**
   * What this profile is carrying right now.
   *
   * Counted from `TradeExecution` using the SAME status groups the capacity
   * engine and the status panel use, so "active" means one thing everywhere.
   * Deliberately NOT Binance's open-order count: protection legs are orders
   * but are not executions, and an account with one position under a TP and an
   * SL shows three orders and one active trade.
   */
  private async readExposure(profileId: string) {
    const rows = await this.prisma.tradeExecution.findMany({
      where: {
        executionProfileId: profileId,
        status: { in: TOTAL_ACTIVE_STATUSES as unknown as Prisma.EnumTradeExecutionStatusFilter["in"] },
      },
      select: { status: true, riskBudgetUsd: true, maximumIsolatedMargin: true },
    });
    let openPositionCount = 0;
    let pendingEntryCount = 0;
    let reservedRisk = new Prisma.Decimal(0);
    let reservedMargin = new Prisma.Decimal(0);
    for (const row of rows) {
      const status = row.status as TradeExecutionStatusName;
      if (OPEN_POSITION_STATUSES.includes(status)) openPositionCount += 1;
      if (PENDING_ENTRY_STATUSES.includes(status)) pendingEntryCount += 1;
      reservedRisk = reservedRisk.plus(row.riskBudgetUsd);
      reservedMargin = reservedMargin.plus(row.maximumIsolatedMargin);
    }
    return {
      openPositionCount,
      pendingEntryCount,
      totalActiveCount: rows.length,
      reservedRiskUsd: reservedRisk.toString(),
      reservedMaximumMarginUsd: reservedMargin.toString(),
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
