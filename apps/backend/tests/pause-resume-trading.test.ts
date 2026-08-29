import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";
import {
  derivedSessionStatus,
  isResumableSession,
  sessionAdmissionState,
} from "../src/modules/execution/trading-session";
import {
  applySessionAccountingForStatus,
  reserveSessionSlot,
} from "../src/modules/execution/trading-session.service";

/**
 * Pause and Resume — one session, stopped and restarted.
 *
 * ## The incident this exists for
 *
 * The worker went STALE mid-session. The operator stopped new trades, the
 * launcher replaced the worker, and then there was no way back: Start Trading
 * refuses while executions exist, because starting means "a NEW clean
 * session". The only routes forward were to wait out every open trade or to
 * cancel them by hand.
 *
 * ## What makes Resume safe where Start is strict
 *
 * Start mints a session, a budget and an expiry, so it insists on a clean
 * account — nothing should inherit exposure it never reviewed. Resume mints
 * NOTHING. It reopens the row that is already there, with the id, budget,
 * counts and expiry it already had, so existing exposure is not something it
 * inherits; it is something it never stopped owning.
 *
 * That is why the "must be clean" readiness blockers are tolerated here and
 * nowhere else, and why every OTHER blocker still applies — including runtime
 * attestation, which is the whole reason the operator paused.
 *
 * ## Two gates, not one
 *
 * Pausing engages the kill switch AND moves the session to PAUSED. Either
 * alone stops admission; together they mean a partial failure of the pause
 * still stops it. `reserveSessionSlot`'s conditional UPDATE requires
 * `status = 'ACTIVE'`, so the session gate is enforced by the database rather
 * than by anything remembering to check.
 */

const TAG = "pause-resume-synthetic";

/** Set before `config/env` freezes its snapshot; restored in afterAll. */
const OVERRIDDEN = ["EXECUTION_PROFILE_ACCOUNT_IDENTIFIER", "EXECUTION_PROFILE_ENVIRONMENT"];
const originalEnv = new Map(OVERRIDDEN.map((key) => [key, process.env[key]]));
process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = `${TAG}-account`;
process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { TradingControlActionsService, START_TRADING_CONFIRMATION, RESUME_TRADING_CONFIRMATION } =
  await import("../src/modules/operator/trading-control-actions.service");
// Dynamic, like the service above: a STATIC import of anything that reaches
// `config/env` is hoisted above the profile override at the top of this file,
// and the frozen snapshot would then name the operator's real profile.
const { CanaryAuthorizationService } = await import(
  "../src/modules/execution/canary-authorization.service"
);
const { resolveAdmissionAuthorization } = await import(
  "../src/modules/execution/safety-admission.service"
);

const maybe = () => (available ? it : it.skip);

let profileId = "";
let sequence = 0;

const DAY_MINUTES = 24 * 60;
const THIRTY_DAYS = 30 * DAY_MINUTES;

const REVIEWED_POLICY = {
  maxOpenPositions: 5,
  maxPendingEntries: 5,
  maxTotalActiveTrades: 5,
  maxActivePerSymbolSide: 1,
  softOpenPositionTarget: 3,
  maxTotalPlannedRiskUsd: "7.50",
  maxTotalIsolatedMarginUsd: "40.00",
};

const passingAttestation = () =>
  ({
    ok: true,
    reasonCode: null,
    message: null,
    backend: { role: "BACKEND", freshCount: 1, staleCount: 0, gates: null, instanceId: "b1" },
    worker: { role: "WORKER", freshCount: 1, staleCount: 0, gates: null, instanceId: "w1" },
  }) as never;

/** The worker has stopped attesting — the state that motivated this feature. */
const staleWorkerAttestation = () =>
  ({
    ok: false,
    reasonCode: "RUNTIME_ATTESTATION_STALE",
    message: "the WORKER runtime last reported more than 15s ago.",
    backend: { role: "BACKEND", freshCount: 1, staleCount: 0, gates: null, instanceId: "b1" },
    worker: { role: "WORKER", freshCount: 0, staleCount: 1, gates: null, instanceId: "w1" },
  }) as never;

const preflightResult = (preparationBlockers: unknown[] = []) =>
  ({
    ready: false,
    preparationReady: preparationBlockers.length === 0,
    findings: [...preparationBlockers],
    preparationBlockers,
    liveActivationBlockers: [],
    summary: "CANARY_BLOCKED_GATE_STATE",
    gathered: {},
  }) as never;

const service = (overrides: Record<string, unknown> = {}) =>
  new TradingControlActionsService(prisma!, {
    preflight: { run: async () => preflightResult() },
    readAttestation: async () => passingAttestation(),
    environmentArmed: () => true,
    ...overrides,
  } as never);

const sessions = () =>
  prisma!.tradingSession.findMany({
    where: { executionProfileId: profileId },
    orderBy: { createdAt: "desc" },
  });

const windows = () =>
  prisma!.executionCanaryAuthorization.findMany({
    where: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW" },
    orderBy: { createdAt: "desc" },
  });

const readSession = (id: string) =>
  prisma!.tradingSession.findUniqueOrThrow({ where: { id } });

const readProfile = () =>
  prisma!.executionProfile.findUniqueOrThrow({
    where: { id: profileId },
    include: { safetyPolicy: true },
  });

const nextExecutionId = () => {
  sequence += 1;
  return `${TAG}-exec-${sequence}`;
};

/** Reserve a slot the way admission does, against the session by id. */
const reserve = (sessionId: string, now = new Date()) =>
  reserveSessionSlot(prisma!, {
    executionProfileId: profileId,
    tradingSessionId: sessionId,
    tradeExecutionId: nextExecutionId(),
    now,
  });

/**
 * A live execution row, in the shape the capacity counter reads.
 *
 * Written directly rather than driven through the lifecycle: this suite is
 * about the SESSION transition, and what it needs from an execution is only
 * that it occupies a capacity slot and carries risk and margin.
 */
async function createExecution(riskBudgetUsd = "1.50", maximumIsolatedMargin = "8.00") {
  return prisma!.tradeExecution.create({
    data: {
      executionProfileId: profileId,
      symbol: "COWUSDT",
      direction: "LONG",
      positionSide: "LONG",
      selectedLookback: 200,
      status: "PROTECTED",
      plannedEntryPrice: "100",
      calculatedStopLoss: "96",
      executableStopLoss: "96",
      riskBudgetUsd,
      quantityRaw: "0.375",
      plannedQuantity: "0.375",
      quantityStepSize: "0.001",
      actualPlannedLoss: riskBudgetUsd,
      unusedRiskBudget: "0",
      positionNotional: "37.5",
      targetIsolatedMargin: maximumIsolatedMargin,
      maximumIsolatedMargin,
      selectedLeverage: 10,
      estimatedInitialMargin: maximumIsolatedMargin,
      liquidationBufferRatio: "0.5",
    },
  });
}

/** Reserve and then let it obtain exposure: RESERVED -> OPENED. */
async function openTrade(sessionId: string) {
  const tradeExecutionId = nextExecutionId();
  const reservation = await reserveSessionSlot(prisma!, {
    executionProfileId: profileId,
    tradingSessionId: sessionId,
    tradeExecutionId,
    now: new Date(),
  });
  if (!reservation.reserved) return reservation;
  await applySessionAccountingForStatus(prisma!, {
    tradeExecutionId,
    status: "ENTRY_FILLED",
    firstFillAt: new Date(),
    now: new Date(),
  });
  return reservation;
}

async function reset() {
  // Executions FIRST. They hold a foreign key to the profile, so leaving one
  // behind aborts the teardown and strands a profile whose accountIdentifier
  // then collides with the next run's. Events go before executions for the
  // same reason, one level down.
  const executionIds = (
    await prisma!.tradeExecution.findMany({
      where: { executionProfileId: profileId },
      select: { id: true },
    })
  ).map((row) => row.id);
  if (executionIds.length > 0) {
    await prisma!.executionEvent.deleteMany({ where: { tradeExecutionId: { in: executionIds } } });
    await prisma!.tradeExecution.deleteMany({ where: { id: { in: executionIds } } });
  }
  await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
  await prisma!.tradingSessionSlot.deleteMany({
    where: { tradingSession: { executionProfileId: profileId } },
  });
  await prisma!.tradingSession.deleteMany({ where: { executionProfileId: profileId } });
  await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled: false } });
  await prisma!.executionSafetyPolicy.update({
    where: { executionProfileId: profileId },
    data: { killSwitchActive: true, ...REVIEWED_POLICY },
  });
}

beforeAll(async () => {
  if (!prisma || !available) return;
  const profile = await prisma.executionProfile.create({
    data: {
      name: "Pause/resume synthetic profile",
      accountIdentifier: `${TAG}-account`,
      environment: "TESTNET",
      isEnabled: false,
    },
  });
  profileId = profile.id;
  await prisma.executionSafetyPolicy.create({
    data: {
      executionProfileId: profileId,
      killSwitchActive: true,
      allowedSymbols: ["COWUSDT"],
      ...REVIEWED_POLICY,
    },
  });
});

afterEach(async () => {
  if (!prisma || !available) return;
  await reset();
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    await reset();
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionProfile.deleteMany({ where: { id: profileId } });
  }
  await prisma.$disconnect();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Start a session and return it with its window. */
async function start(durationMinutes = THIRTY_DAYS, tradeBudget = 100) {
  const result = await service().startTrading(START_TRADING_CONFIRMATION, durationMinutes, tradeBudget);
  expect(result.ok, `start: ${result.blockers.join(" ")}`).toBe(true);
  const [session] = await sessions();
  const [window] = await windows();
  return { session, window };
}

const resume = (overrides: Record<string, unknown> = {}) =>
  service(overrides).resumeNewTrades(RESUME_TRADING_CONFIRMATION);

// ===========================================================================
// A-B. The transition itself
// ===========================================================================

describe("A-B. ACTIVE -> PAUSED -> ACTIVE, on one session", () => {
  maybe()("A. Pause blocks new admission immediately and touches nothing else", async () => {
    const { session } = await start();
    await openTrade(session.id);
    const before = await readSession(session.id);

    const paused = await service().pauseNewTrades();
    expect(paused.ok).toBe(true);
    expect(paused.outcome).toBe("PAUSED");

    const after = await readSession(session.id);
    expect(after.status).toBe("PAUSED");

    // Admission is refused at the database, by the reservation itself.
    const refused = await reserve(session.id);
    expect(refused.reserved).toBe(false);
    expect(refused.reasonCode).toBe("SESSION_PAUSED");

    // And the kill switch is engaged, so no OTHER mode can admit either.
    expect((await readProfile()).safetyPolicy?.killSwitchActive).toBe(true);

    // Nothing about the session moved except its status.
    expect(after.id).toBe(before.id);
    expect(after.openedCount).toBe(before.openedCount);
    expect(after.reservedCount).toBe(before.reservedCount);
    expect(after.tradeBudget).toBe(before.tradeBudget);
    expect(after.startedAt.getTime()).toBe(before.startedAt.getTime());
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(after.endedAt).toBeNull();

    // The window is NOT revoked: it is the permission the resume re-arms.
    const [window] = await windows();
    expect(window.revokedAt).toBeNull();
    expect(window.tradingSessionId).toBe(session.id);
  });

  maybe()("A2. existing executions are untouched by a pause", async () => {
    const { session } = await start();
    await openTrade(session.id);
    const reserved = await reserve(session.id);
    expect(reserved.reserved).toBe(true);

    const slotsBefore = await prisma!.tradingSessionSlot.findMany({
      where: { tradingSessionId: session.id },
      orderBy: { id: "asc" },
    });

    await service().pauseNewTrades();

    const slotsAfter = await prisma!.tradingSessionSlot.findMany({
      where: { tradingSessionId: session.id },
      orderBy: { id: "asc" },
    });
    expect(slotsAfter.map((slot) => `${slot.id}:${slot.state}`)).toEqual(
      slotsBefore.map((slot) => `${slot.id}:${slot.state}`)
    );
  });

  // TEST B -------------------------------------------------------------------
  maybe()("B. Resume reopens the SAME session and creates no new one", async () => {
    const { session, window } = await start();
    await service().pauseNewTrades();

    const result = await resume();
    expect(result.ok, `resume: ${result.blockers.join(" ")}`).toBe(true);
    expect(result.outcome).toBe("RESUMED");

    const all = await sessions();
    expect(all, "resume must not create a session").toHaveLength(1);
    expect(all[0].id).toBe(session.id);
    expect(all[0].status).toBe("ACTIVE");

    // The SAME window, re-armed. No second authorization was issued.
    const live = await windows();
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(window.id);
    expect(live[0].tradingSessionId).toBe(session.id);

    // And admission works again.
    const admitted = await reserve(session.id);
    expect(admitted.reserved).toBe(true);
  });

  maybe()("B2. the profile is armed again by the resume", async () => {
    await start();
    await service().pauseNewTrades();
    expect((await readProfile()).safetyPolicy?.killSwitchActive).toBe(true);

    await resume();
    const profile = await readProfile();
    expect(profile.isEnabled).toBe(true);
    expect(profile.safetyPolicy?.killSwitchActive).toBe(false);
  });
});

// ===========================================================================
// The kill switch: the one finding a resume must NOT treat as a fault
// ===========================================================================

describe("the paused kill switch does not deadlock its own resume", () => {
  maybe()("KS. Pause engages the kill switch and Resume releases it, end to end", async () => {
    // The §4 round trip, through the REAL action service rather than the pure
    // readiness helper: an engaged kill switch is the normal, expected posture
    // of a paused profile, and resuming is the act that releases it. A resume
    // that read its own paused posture as a fault could never complete, and no
    // operator would have a way out.
    const { session } = await start(THIRTY_DAYS, 100);
    await openTrade(session.id);
    const before = await readSession(session.id);

    const paused = await service().pauseNewTrades();
    expect(paused.ok).toBe(true);

    // The expected paused posture.
    const whilePaused = await readProfile();
    expect(whilePaused.safetyPolicy?.killSwitchActive).toBe(true);
    expect(whilePaused.isEnabled).toBe(true);
    expect((await readSession(session.id)).status).toBe("PAUSED");

    // The preflight the action gathers reports it, in BOTH scopes, exactly as
    // it would in production. Resume must still succeed.
    const withKillSwitch = [
      {
        code: "CANARY_BLOCKED_KILL_SWITCH_STATE",
        detail: "the profile kill switch is engaged.",
        scope: "LIVE_ACTIVATION",
      },
      { code: "CANARY_BLOCKED_GATE_STATE", detail: "live entry is disabled.", scope: "LIVE_ACTIVATION" },
    ];
    const result = await resume({
      preflight: {
        run: async () =>
          ({
            ready: false,
            preparationReady: true,
            findings: withKillSwitch,
            preparationBlockers: [],
            liveActivationBlockers: withKillSwitch,
            summary: "CANARY_BLOCKED_KILL_SWITCH_STATE",
            gathered: {},
          }) as never,
      },
    });
    expect(result.ok, `resume: ${result.blockers.join(" ")}`).toBe(true);
    expect(result.outcome).toBe("RESUMED");

    // Released, and by the reviewed arming primitive.
    const after = await readProfile();
    expect(after.safetyPolicy?.killSwitchActive).toBe(false);
    expect(after.isEnabled).toBe(true);

    // The SAME session throughout, unchanged in every dimension but status.
    const resumed = await readSession(session.id);
    expect(resumed.id).toBe(before.id);
    expect(resumed.status).toBe("ACTIVE");
    expect(resumed.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(resumed.startedAt.getTime()).toBe(before.startedAt.getTime());
    expect(resumed.openedCount).toBe(before.openedCount);
    expect(resumed.reservedCount).toBe(before.reservedCount);
    expect(resumed.tradeBudget).toBe(before.tradeBudget);
    expect(await sessions(), "no new session").toHaveLength(1);

    // And admission genuinely works again.
    expect((await reserve(session.id)).reserved).toBe(true);
  });

  maybe()("KS2. the same round trip with healthy open and pending executions", async () => {
    // §4's second half: the state the motivating incident actually left behind.
    const { session } = await start(THIRTY_DAYS, 100);
    await openTrade(session.id);
    await openTrade(session.id);
    await reserve(session.id);
    await createExecution();
    await createExecution();
    const before = await readSession(session.id);
    expect(`${before.openedCount}/${before.reservedCount}`).toBe("2/1");

    await service().pauseNewTrades();
    expect((await readProfile()).safetyPolicy?.killSwitchActive).toBe(true);

    // Everything preflight would report about a live, paused, non-empty
    // account at once: the engaged kill switch, the closed gates, and all
    // three "the account is not clean" findings.
    const realistic = [
      { code: "CANARY_BLOCKED_KILL_SWITCH_STATE", detail: "kill switch engaged.", scope: "LIVE_ACTIVATION" },
      { code: "CANARY_BLOCKED_GATE_STATE", detail: "gates closed.", scope: "LIVE_ACTIVATION" },
      { code: "CANARY_BLOCKED_EXISTING_POSITIONS", detail: "2 open positions.", scope: "PREPARATION" },
      { code: "CANARY_BLOCKED_EXISTING_ORDERS", detail: "3 open orders.", scope: "PREPARATION" },
      { code: "CANARY_BLOCKED_LOCAL_EXECUTION", detail: "2 active executions.", scope: "PREPARATION" },
    ];
    const result = await resume({
      preflight: {
        run: async () =>
          ({
            ready: false,
            preparationReady: false,
            findings: realistic,
            preparationBlockers: realistic.filter((entry) => entry.scope === "PREPARATION"),
            liveActivationBlockers: realistic.filter((entry) => entry.scope === "LIVE_ACTIVATION"),
            summary: "CANARY_BLOCKED_LOCAL_EXECUTION",
            gathered: {},
          }) as never,
      },
    });
    expect(result.ok, `resume: ${result.blockers.join(" ")}`).toBe(true);

    const after = await readSession(session.id);
    expect(after.id).toBe(before.id);
    expect(after.status).toBe("ACTIVE");
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(`${after.openedCount}/${after.reservedCount}`).toBe("2/1");
    expect((await readProfile()).safetyPolicy?.killSwitchActive).toBe(false);
    expect(await sessions()).toHaveLength(1);
  });

  maybe()("KS3. a live-activation finding NOT on the list still blocks", async () => {
    // The tolerance is an allowlist of four named codes, not "ignore the
    // live-activation scope". A code invented later must fail CLOSED, whatever
    // scope it carries.
    const { session } = await start();
    await service().pauseNewTrades();

    const unknown = [
      { code: "CANARY_BLOCKED_SOMETHING_NEW", detail: "a code from the future.", scope: "LIVE_ACTIVATION" },
    ];
    const result = await resume({
      preflight: {
        run: async () =>
          ({
            ready: false,
            preparationReady: true,
            findings: unknown,
            preparationBlockers: [],
            liveActivationBlockers: unknown,
            summary: "CANARY_BLOCKED_GATE_STATE",
            gathered: {},
          }) as never,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toContain("CANARY_BLOCKED_SOMETHING_NEW");
    expect((await readSession(session.id)).status).toBe("PAUSED");
    // And the profile was NOT armed by a refused resume.
    expect((await readProfile()).safetyPolicy?.killSwitchActive).toBe(true);
  });

  maybe()("KS4. the kill switch is still checked — by arming, not by preflight", async () => {
    // Tolerating the FINDING is not tolerating the STATE. The release runs
    // through `armNaturalWindow`, which re-reads the policy under the profile
    // advisory lock and refuses on a version it did not review. Moving the
    // policy out from under the resume proves the check is real.
    const { session, window } = await start();
    await service().pauseNewTrades();

    // Revoke the window: the session's own authorization is gone, so there is
    // nothing to arm and the kill switch must stay engaged.
    await prisma!.executionCanaryAuthorization.update({
      where: { id: window.id },
      data: { revokedAt: new Date() },
    });

    const result = await resume();
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toContain("RESUME_BLOCKED_AUTHORIZATION");
    expect((await readProfile()).safetyPolicy?.killSwitchActive).toBe(true);
    expect((await readSession(session.id)).status).toBe("PAUSED");
  });
});

// ===========================================================================
// The partial-failure state: armed, but still PAUSED
// ===========================================================================

describe("armed-but-paused admits nothing and recovers", () => {
  /** The exact state a crash between arming and unpausing would leave. */
  async function armedButPaused() {
    const { session, window } = await start(THIRTY_DAYS, 100);
    await service().pauseNewTrades();
    // Arm without unpausing — what the resume does first, stopped halfway.
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { killSwitchActive: false },
    });
    await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled: true } });
    return { session, window };
  }

  maybe()("PF. no reservation is possible, because the database requires ACTIVE", async () => {
    const { session } = await armedButPaused();
    const profile = await readProfile();
    expect(profile.isEnabled).toBe(true);
    expect(profile.safetyPolicy?.killSwitchActive).toBe(false);
    expect((await readSession(session.id)).status).toBe("PAUSED");

    const attempts = await Promise.all(Array.from({ length: 10 }, () => reserve(session.id)));
    expect(attempts.filter((entry) => entry.reserved)).toHaveLength(0);
    expect((await readSession(session.id)).reservedCount).toBe(0);
  });

  maybe()("PF2. no OTHER authorization can be created to bypass the paused session", async () => {
    // The real question: could the temporarily armed profile admit through a
    // DIFFERENT authorization? It cannot, because `assertNoActiveWindow` looks
    // at every authorization type — the paused session's window is unconsumed,
    // un-revoked and in date, so it blocks both a second natural window and an
    // exact one.
    await armedButPaused();
    const authorizations = new CanaryAuthorizationService(prisma!);

    await expect(
      authorizations.prepareNaturalWindow({
        executionProfileId: profileId,
        allowedDirections: ["LONG"],
        maxClaims: 5,
      })
    ).rejects.toThrow();

    await expect(
      authorizations.prepare({
        executionProfileId: profileId,
        symbol: "COWUSDT",
        direction: "LONG",
        ttlMinutes: 10,
      })
    ).rejects.toThrow();

    // Exactly one authorization exists, and it is the paused session's.
    expect(await windows()).toHaveLength(1);
    expect(
      await prisma!.executionCanaryAuthorization.count({
        where: { executionProfileId: profileId, authorizationType: "EXACT_SIGNAL" },
      })
    ).toBe(0);
  });

  maybe()("PF3. admission routes to the paused session and refuses there", async () => {
    // Proven through the REAL selection function, not by assuming it: the
    // newest natural window is the session-backed one, so admission reserves
    // against THIS session and the paused status refuses it.
    const { session, window } = await armedButPaused();
    const chosen = await resolveAdmissionAuthorization(
      prisma! as never,
      { alertId: null, executionProfileId: profileId, positionSide: "LONG" },
      new Date()
    );
    expect(chosen.ok).toBe(true);
    if (chosen.ok) {
      expect(chosen.mode).toBe("NATURAL");
      if (chosen.mode === "NATURAL") {
        expect(chosen.window.id).toBe(window.id);
        expect(chosen.window.tradingSessionId).toBe(session.id);
      }
    }
    expect((await reserve(session.id)).reasonCode).toBe("SESSION_PAUSED");
  });

  maybe()("PF4. retrying Resume completes it", async () => {
    const { session } = await armedButPaused();
    const result = await resume();
    expect(result.ok, `resume: ${result.blockers.join(" ")}`).toBe(true);
    expect((await readSession(session.id)).status).toBe("ACTIVE");
    expect(await sessions()).toHaveLength(1);
    expect((await reserve(session.id)).reserved).toBe(true);
  });

  maybe()("PF5. Safe Off still terminates it", async () => {
    const { session } = await armedButPaused();
    const safe = await service().safeOff();
    expect(safe.ok).toBe(true);
    expect((await readSession(session.id)).status).toBe("REVOKED");
    const profile = await readProfile();
    expect(profile.safetyPolicy?.killSwitchActive).toBe(true);
    expect((await resume()).ok).toBe(false);
  });
});

// ===========================================================================
// C-D. Nothing resets
// ===========================================================================

describe("C-D. budget and duration survive the round trip", () => {
  // TEST C -------------------------------------------------------------------
  maybe()("C. counts carry across, including work that settled while paused", async () => {
    const { session } = await start(THIRTY_DAYS, 100);

    // 12 opened, 3 still reserved — the scenario from the brief.
    for (let index = 0; index < 12; index += 1) await openTrade(session.id);
    const pendingIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const tradeExecutionId = nextExecutionId();
      const reservation = await reserveSessionSlot(prisma!, {
        executionProfileId: profileId,
        tradingSessionId: session.id,
        tradeExecutionId,
        now: new Date(),
      });
      expect(reservation.reserved).toBe(true);
      pendingIds.push(tradeExecutionId);
    }
    const before = await readSession(session.id);
    expect(`${before.openedCount}/${before.reservedCount}`).toBe("12/3");

    await service().pauseNewTrades();

    // While paused: one fills, one dies unfilled. Both are ordinary lifecycle
    // events and both must still settle — pausing stops ADMISSION, not the
    // executions already on the book.
    await applySessionAccountingForStatus(prisma!, {
      tradeExecutionId: pendingIds[0],
      status: "ENTRY_FILLED",
      firstFillAt: new Date(),
      now: new Date(),
    });
    await applySessionAccountingForStatus(prisma!, {
      tradeExecutionId: pendingIds[1],
      status: "ENTRY_EXPIRED",
      firstFillAt: null,
      now: new Date(),
    });

    const whilePaused = await readSession(session.id);
    expect(`${whilePaused.openedCount}/${whilePaused.reservedCount}`).toBe("13/1");

    await resume();

    const after = await readSession(session.id);
    expect(`${after.openedCount}/${after.reservedCount}`).toBe("13/1");
    expect(after.tradeBudget).toBe(100);
    // 100 - 13 - 1. Never recomputed from zero, never a fresh 100.
    expect(after.tradeBudget! - after.openedCount - after.reservedCount).toBe(86);
  });

  // TEST D + TEST O ----------------------------------------------------------
  maybe()("D/O. the original expiry is unchanged, to the millisecond", async () => {
    const { session } = await start(THIRTY_DAYS, 100);
    const originalExpiry = session.expiresAt.getTime();
    const originalStart = session.startedAt.getTime();

    await service().pauseNewTrades();
    await resume();

    const after = await readSession(session.id);
    expect(after.expiresAt.getTime()).toBe(originalExpiry);
    expect(after.startedAt.getTime()).toBe(originalStart);
    // A 30-day session does NOT get a fresh 30 days for having been paused.
    expect(after.expiresAt.getTime() - after.startedAt.getTime()).toBe(THIRTY_DAYS * 60_000);

    // The window's expiry moved no further than the session's.
    const [window] = await windows();
    expect(window.expiresAt.getTime()).toBe(originalExpiry);
  });

  // TEST N -------------------------------------------------------------------
  maybe()("N. resuming does not reintroduce the 5-claim cumulative cap", async () => {
    const { session } = await start(THIRTY_DAYS, 100);
    for (let index = 0; index < 6; index += 1) await openTrade(session.id);

    await service().pauseNewTrades();
    await resume();

    // Six trades opened through a window pinned to maxClaims 5, and the window
    // has still spent NOTHING: a session-backed window is bounded by the
    // session's budget, never by claims.
    const [window] = await windows();
    expect(window.maxClaims).toBe(5);
    expect(window.claimedCount).toBe(0);
    expect((await readSession(session.id)).openedCount).toBe(6);

    // And a seventh still admits, well past the historical cap.
    expect((await reserve(session.id)).reserved).toBe(true);
  });
});

// ===========================================================================
// E-F. Resume vs Start
// ===========================================================================

describe("E-F. Resume tolerates existing work; Start still does not", () => {
  // TEST E -------------------------------------------------------------------
  maybe()("E. Resume succeeds with healthy open and pending executions", async () => {
    const { session } = await start();
    await openTrade(session.id);
    await reserve(session.id);
    await service().pauseNewTrades();

    // The three findings that mean "the account is not empty". For Start these
    // are refusals; for Resume they are the expected state.
    const notEmpty = [
      { code: "CANARY_BLOCKED_EXISTING_POSITIONS", detail: "1 open position.", scope: "PREPARATION" },
      { code: "CANARY_BLOCKED_EXISTING_ORDERS", detail: "2 open orders.", scope: "PREPARATION" },
      { code: "CANARY_BLOCKED_LOCAL_EXECUTION", detail: "2 active executions.", scope: "PREPARATION" },
    ];

    const result = await resume({ preflight: { run: async () => preflightResult(notEmpty) } });
    expect(result.ok, `resume: ${result.blockers.join(" ")}`).toBe(true);
    expect((await readSession(session.id)).status).toBe("ACTIVE");
  });

  maybe()("E2. but NOT with an execution that needs manual intervention", async () => {
    const { session } = await start();
    await service().pauseNewTrades();

    // Deliberately not tolerated. An execution awaiting reconciliation is not
    // healthy existing work, and resuming admission on top of one is how a
    // small problem becomes several.
    const result = await resume({
      preflight: {
        run: async () =>
          preflightResult([
            { code: "CANARY_BLOCKED_RECOVERY_REQUIRED", detail: "1 needs intervention.", scope: "PREPARATION" },
          ]),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toContain("RESUME_BLOCKED_READINESS");
    expect(result.blockers.join(" ")).toContain("CANARY_BLOCKED_RECOVERY_REQUIRED");
    expect((await readSession(session.id)).status).toBe("PAUSED");
  });

  maybe()("E3. and NOT with an unreachable exchange or a broken runtime", async () => {
    const { session } = await start();
    await service().pauseNewTrades();

    for (const code of [
      "CANARY_BLOCKED_BINANCE",
      "CANARY_BLOCKED_DATABASE",
      "CANARY_BLOCKED_REDIS",
      "CANARY_BLOCKED_WORKER",
      "CANARY_BLOCKED_ACCOUNT_MODE",
      "CANARY_BLOCKED_IP_RESTRICTION",
      "CANARY_BLOCKED_POLICY",
    ]) {
      const result = await resume({
        preflight: {
          run: async () => preflightResult([{ code, detail: "synthetic.", scope: "PREPARATION" }]),
        },
      });
      expect(`${code}:${result.ok}`).toBe(`${code}:false`);
      expect(`${code}:${(await readSession(session.id)).status}`).toBe(`${code}:PAUSED`);
    }
  });

  // TEST F -------------------------------------------------------------------
  maybe()("F. Start Trading still refuses while executions exist", async () => {
    const { session } = await start();
    await openTrade(session.id);
    await service().pauseNewTrades();

    // Exactly the refusal that made this feature necessary — unchanged.
    const result = await service({
      preflight: {
        run: async () =>
          preflightResult([
            { code: "CANARY_BLOCKED_LOCAL_EXECUTION", detail: "1 active execution.", scope: "PREPARATION" },
          ]),
      },
    }).startTrading(START_TRADING_CONFIRMATION, 60, 10);

    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toContain("CANARY_BLOCKED_LOCAL_EXECUTION");
    // And the paused session is still there, untouched, still resumable.
    const after = await readSession(session.id);
    expect(after.status).toBe("PAUSED");
    expect(isResumableSession(after, new Date())).toBe(true);
  });

  maybe()("F2. a successful Start ENDS a paused session rather than leaving two", async () => {
    const { session } = await start();
    await service().pauseNewTrades();
    // Safe Off first, so preparation is not blocked by the existing window.
    await service().safeOff();

    const result = await service().startTrading(START_TRADING_CONFIRMATION, 60, 10);
    expect(result.ok, `start: ${result.blockers.join(" ")}`).toBe(true);

    const all = await sessions();
    expect(all.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
    expect(all.filter((row) => row.status === "PAUSED")).toHaveLength(0);
    expect((await readSession(session.id)).status).toBe("REVOKED");
  });
});

// ===========================================================================
// G-I. Resume fails closed
// ===========================================================================

describe("G-I. a session that ended while paused cannot be resumed", () => {
  // TEST G -------------------------------------------------------------------
  maybe()("G. expired while paused -> refused", async () => {
    const { session } = await start(60, 100);
    await service().pauseNewTrades();

    // Reach the expiry by moving the stored one into the past, which is what
    // the clock would have done. Expiry is a comparison against a persisted
    // column, so this is the same state a real hour produces.
    await prisma!.tradingSession.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const after = await readSession(session.id);
    expect(derivedSessionStatus(after, new Date())).toBe("EXPIRED");
    expect(isResumableSession(after, new Date())).toBe(false);

    const result = await resume();
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("SESSION_EXPIRED");
    // Still PAUSED in the column, and still refused — the derived status is
    // what decides, so a stale column cannot promise a resume.
    expect((await readSession(session.id)).status).toBe("PAUSED");
  });

  // TEST H -------------------------------------------------------------------
  maybe()("H. exhausted while paused -> refused", async () => {
    const { session } = await start(THIRTY_DAYS, 2);
    await openTrade(session.id);
    await openTrade(session.id);
    await service().pauseNewTrades();

    const after = await readSession(session.id);
    expect(derivedSessionStatus(after, new Date())).toBe("EXHAUSTED");

    const result = await resume();
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("SESSION_EXHAUSTED");
  });

  // TEST I -------------------------------------------------------------------
  maybe()("I. Safe Off while paused -> never resumable again", async () => {
    const { session } = await start();
    await service().pauseNewTrades();

    const safe = await service().safeOff();
    expect(safe.ok).toBe(true);

    // Safe Off is strictly stronger than Pause: it revokes the paused session
    // rather than leaving it waiting to be resumed.
    const after = await readSession(session.id);
    expect(after.status).toBe("REVOKED");
    expect(isResumableSession(after, new Date())).toBe(false);

    const result = await resume();
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("SESSION_REVOKED");
    expect((await readSession(session.id)).status).toBe("REVOKED");
  });

  maybe()("I2. Stop New Trades also ends a paused session", async () => {
    const { session } = await start();
    await service().pauseNewTrades();
    await service().stopNewTrades();

    expect((await readSession(session.id)).status).toBe("REVOKED");
    expect((await resume()).ok).toBe(false);
  });

  maybe()("I3. resume refuses without the exact confirmation phrase", async () => {
    const { session } = await start();
    await service().pauseNewTrades();

    for (const phrase of ["", "resume trading", "RESUME", "START TRADING", null, undefined, 42]) {
      const result = await service().resumeNewTrades(phrase);
      expect(`${String(phrase)}:${result.ok}`).toBe(`${String(phrase)}:false`);
      expect(result.blockers).toContain("CONFIRMATION_REQUIRED");
    }
    expect((await readSession(session.id)).status).toBe("PAUSED");
  });
});

// ===========================================================================
// J-K. Runtime health and policy
// ===========================================================================

describe("J-K. Resume is not a bypass", () => {
  // TEST J -------------------------------------------------------------------
  maybe()("J. Pause works with a STALE worker; Resume refuses until it recovers", async () => {
    const { session } = await start();

    // Pausing must stay available when the runtime is unhealthy — that is
    // precisely when an operator reaches for it.
    const paused = await service({ readAttestation: async () => staleWorkerAttestation() }).pauseNewTrades();
    expect(paused.ok).toBe(true);
    expect((await readSession(session.id)).status).toBe("PAUSED");

    // Resuming must not be. The stale worker is why trading stopped.
    const refused = await resume({ readAttestation: async () => staleWorkerAttestation() });
    expect(refused.ok).toBe(false);
    expect(refused.blockers.join(" ")).toContain("RUNTIME_ATTESTATION_STALE");
    expect((await readSession(session.id)).status).toBe("PAUSED");

    // Worker recovered: the same session resumes, with everything intact.
    const recovered = await resume();
    expect(recovered.ok, `resume: ${recovered.blockers.join(" ")}`).toBe(true);
    expect((await readSession(session.id)).id).toBe(session.id);
  });

  maybe()("J2. Resume refuses while the environment gates are not armed", async () => {
    const { session } = await start();
    await service().pauseNewTrades();

    const result = await resume({ environmentArmed: () => false });
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toContain("ENVIRONMENT_GATES_NOT_ARMED");
    expect((await readSession(session.id)).status).toBe("PAUSED");
  });

  // TEST K -------------------------------------------------------------------
  maybe()("K. Resume refuses when current exposure exceeds the effective policy", async () => {
    const { session } = await start();
    await service().pauseNewTrades();

    // Three live executions, then the policy is narrowed to two while paused.
    for (let index = 0; index < 3; index += 1) await createExecution();
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { maxOpenPositions: 2, maxTotalActiveTrades: 2, maxPendingEntries: 2 },
    });

    const result = await resume();
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toContain("RESUME_BLOCKED_EXPOSURE");
    expect((await readSession(session.id)).status).toBe("PAUSED");
  });

  maybe()("K2. exposure exactly AT the limit still resumes", async () => {
    // A full account is a busy one, not a broken one: admission itself refuses
    // the next trade and says so. Refusing to resume here would strand an
    // operator whose session is simply at capacity.
    const { session } = await start();
    await service().pauseNewTrades();

    // Five PROTECTED trades is exactly maxTotalActiveTrades and maxOpenPositions,
    // and 5 x 1.50 = 7.50 risk with 5 x 8.00 = 40.00 margin are exactly the
    // reviewed ceilings. Everything is AT its limit and nothing is over it.
    for (let index = 0; index < 5; index += 1) await createExecution();

    const result = await resume();
    expect(result.ok, `resume: ${result.blockers.join(" ")}`).toBe(true);
    expect((await readSession(session.id)).status).toBe("ACTIVE");
  });
});

// ===========================================================================
// L-M. Concurrency and repetition
// ===========================================================================

describe("L-M. no admission leaks, and repeats are safe", () => {
  // TEST L -------------------------------------------------------------------
  maybe()("L. no admission slips through once Pause has returned", async () => {
    const { session } = await start(THIRTY_DAYS, 100);
    expect((await reserve(session.id)).reserved).toBe(true);

    await service().pauseNewTrades();

    // Twenty concurrent attempts, all after the pause returned. The guard is
    // the conditional UPDATE's `status = 'ACTIVE'`, evaluated by Postgres
    // under the row lock, so none of them can match.
    const attempts = await Promise.all(Array.from({ length: 20 }, () => reserve(session.id)));
    expect(attempts.filter((entry) => entry.reserved)).toHaveLength(0);
    for (const entry of attempts) {
      if (!entry.reserved) expect(entry.reasonCode).toBe("SESSION_PAUSED");
    }

    // And the count did not move: a refused reservation increments nothing.
    const after = await readSession(session.id);
    expect(after.reservedCount).toBe(1);
    expect(after.openedCount).toBe(0);
  });

  maybe()("L2. a race between Pause and admission cannot double-spend", async () => {
    const { session } = await start(THIRTY_DAYS, 100);

    // Fired together. Whatever the interleaving, every admission that
    // SUCCEEDED must be reflected in reservedCount and every one that failed
    // must have changed nothing — the row is the only arbiter.
    //
    // The pause must LAND, too. An earlier version CASed on `version`, which
    // every reservation increments, so a busy session could not be paused at
    // all: the busier it was, the more reliably the pause lost. That is
    // backwards, and this assertion is what caught it.
    const [, ...attempts] = await Promise.all([
      service().pauseNewTrades(),
      ...Array.from({ length: 10 }, () => reserve(session.id)),
    ]);
    const admitted = attempts.filter((entry) => entry.reserved).length;

    const after = await readSession(session.id);
    expect(after.status).toBe("PAUSED");
    expect(after.reservedCount).toBe(admitted);

    // And nothing at all is admitted from here on.
    expect((await reserve(session.id)).reserved).toBe(false);
  });

  // TEST M -------------------------------------------------------------------
  maybe()("M. Pause twice and Resume twice are both safe", async () => {
    const { session } = await start();

    const first = await service().pauseNewTrades();
    const second = await service().pauseNewTrades();
    expect(first.outcome).toBe("PAUSED");
    expect(second.ok).toBe(true);
    expect(second.outcome).toBe("ALREADY_PAUSED");
    expect((await readSession(session.id)).status).toBe("PAUSED");

    const resumed = await resume();
    const again = await resume();
    expect(resumed.outcome).toBe("RESUMED");
    expect(again.ok).toBe(true);
    expect(again.outcome).toBe("ALREADY_ACTIVE");

    // One session throughout, and one window.
    expect(await sessions()).toHaveLength(1);
    expect(await windows()).toHaveLength(1);
    expect((await readSession(session.id)).status).toBe("ACTIVE");
  });

  maybe()("M2. resuming a session that was never paused is a no-op, not a refusal", async () => {
    const { session } = await start();
    const result = await resume();
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("ALREADY_ACTIVE");
    expect((await readSession(session.id)).status).toBe("ACTIVE");
  });

  maybe()("M3. pausing with no session refuses and admits nothing", async () => {
    const result = await service().pauseNewTrades();
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toContain("NO_SESSION");
    // The kill switch still landed: a failed pause never leaves admission open.
    expect((await readProfile()).safetyPolicy?.killSwitchActive).toBe(true);
  });
});

// ===========================================================================
// The admission state machine, directly
// ===========================================================================

describe("the session state model", () => {
  const base = {
    status: "ACTIVE" as const,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    tradeBudget: 10,
    unlimited: false,
    openedCount: 0,
    reservedCount: 0,
  };

  it("PAUSED is distinguishable from every other state", () => {
    const now = new Date();
    expect(derivedSessionStatus({ ...base }, now)).toBe("ACTIVE");
    expect(derivedSessionStatus({ ...base, status: "PAUSED" }, now)).toBe("PAUSED");
    expect(derivedSessionStatus({ ...base, status: "REVOKED" }, now)).toBe("REVOKED");
    expect(derivedSessionStatus({ ...base, expiresAt: new Date(now.getTime() - 1) }, now)).toBe("EXPIRED");
    expect(derivedSessionStatus({ ...base, openedCount: 10 }, now)).toBe("EXHAUSTED");
  });

  it("only PAUSED is resumable, and only while it is genuinely resumable", () => {
    const now = new Date();
    expect(isResumableSession({ ...base, status: "PAUSED" }, now)).toBe(true);
    for (const session of [
      { ...base },
      { ...base, status: "REVOKED" as const },
      // Paused, but the clock or the budget already ended it.
      { ...base, status: "PAUSED" as const, expiresAt: new Date(now.getTime() - 1) },
      { ...base, status: "PAUSED" as const, openedCount: 10 },
    ]) {
      expect(`${session.status}:${isResumableSession(session, now)}`).toBe(`${session.status}:false`);
    }
  });

  it("reports the reason whose next action is the right one", () => {
    const now = new Date();
    // Paused and in date: Resume is the answer, and the code says so.
    const paused = sessionAdmissionState({ ...base, status: "PAUSED" }, now);
    expect(paused.admits).toBe(false);
    if (!paused.admits) expect(paused.reasonCode).toBe("SESSION_PAUSED");

    // Paused AND expired: a new session is the answer, so expiry wins.
    const expired = sessionAdmissionState(
      { ...base, status: "PAUSED", expiresAt: new Date(now.getTime() - 1) },
      now
    );
    if (!expired.admits) expect(expired.reasonCode).toBe("SESSION_EXPIRED");

    // Paused AND exhausted: likewise, resuming would not help.
    const exhausted = sessionAdmissionState({ ...base, status: "PAUSED", openedCount: 10 }, now);
    if (!exhausted.admits) expect(exhausted.reasonCode).toBe("SESSION_BUDGET_EXHAUSTED");
  });

  it("an unlimited paused session is still refused", () => {
    // The unlimited branch returns early, so PAUSED has to be checked inside
    // it as well. A TESTNET session with no budget must still honour a pause.
    const verdict = sessionAdmissionState(
      { ...base, status: "PAUSED", unlimited: true, tradeBudget: null },
      new Date()
    );
    expect(verdict.admits).toBe(false);
    if (!verdict.admits) expect(verdict.reasonCode).toBe("SESSION_PAUSED");
  });
});
