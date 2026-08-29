import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";
import {
  MAXIMUM_AUTHORIZATION_TTL_MINUTES,
  MAXIMUM_SESSION_BACKED_AUTHORIZATION_TTL_MINUTES,
  maximumAuthorizationTtlMinutes,
} from "../src/modules/execution/natural-authorization";
import {
  SESSION_MAX_DURATION_MINUTES,
  sessionAdmissionState,
} from "../src/modules/execution/trading-session";
import {
  applySessionAccountingForStatus,
  findCurrentSession,
  reserveSessionSlot,
  revokeCurrentSession,
} from "../src/modules/execution/trading-session.service";

/**
 * A trading session may now run for up to 30 days.
 *
 * ## What actually had to change, and what did not
 *
 * The session model was already durable and derived: `expiresAt` is a
 * persisted timestamp and every expiry decision is `expiresAt <= now` computed
 * on read. Nothing counts down in memory, so a longer duration needed no new
 * machinery — the ceiling moved from 1440 to 43200 minutes and the model was
 * already correct for it. Tests H and K below assert exactly that.
 *
 * ## The one real hazard
 *
 * A session-backed NATURAL window carries the PERMISSION, and permission used
 * to be capped at 24 hours by `MAXIMUM_AUTHORIZATION_TTL_MINUTES`. A 30-day
 * session under a 24-hour window would have stopped admitting after day one
 * while still reporting 29 days remaining — silent, and worse than refusing
 * outright. Test E is the guard.
 *
 * The legacy 24-hour cap is deliberately still there for windows that nothing
 * is counting; only a session-backed window may outlive it, because a session
 * bounds it with a finite trade budget instead.
 */

const TAG = "session-30d-synthetic";

/**
 * Set BEFORE `config/env` is evaluated: `configuredProfileIdentity()` reads a
 * frozen snapshot, so `beforeAll` would be too late and Start Trading would
 * resolve the operator's real profile instead of this synthetic one.
 */
const OVERRIDDEN = ["EXECUTION_PROFILE_ACCOUNT_IDENTIFIER", "EXECUTION_PROFILE_ENVIRONMENT"];
const originalEnv = new Map(OVERRIDDEN.map((key) => [key, process.env[key]]));
process.env.EXECUTION_PROFILE_ACCOUNT_IDENTIFIER = `${TAG}-account`;
process.env.EXECUTION_PROFILE_ENVIRONMENT = "TESTNET";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { TradingControlActionsService, START_TRADING_CONFIRMATION, START_TRADING_DURATION_CHOICES } =
  await import("../src/modules/operator/trading-control-actions.service");
const { CanaryAuthorizationService } = await import(
  "../src/modules/execution/canary-authorization.service"
);

const maybe = () => (available ? it : it.skip);

let profileId = "";
let sequence = 0;

const DAY_MINUTES = 24 * 60;
const THIRTY_DAYS = 30 * DAY_MINUTES;

/** The envelope Start Trading requires the persisted policy to be armable under. */
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

const preflightResult = () =>
  ({
    ready: false,
    preparationReady: true,
    findings: [],
    preparationBlockers: [],
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

const windows = () =>
  prisma!.executionCanaryAuthorization.findMany({
    where: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW" },
    orderBy: { createdAt: "desc" },
  });

const sessions = () =>
  prisma!.tradingSession.findMany({
    where: { executionProfileId: profileId },
    orderBy: { startedAt: "desc" },
  });

const nextExecutionId = () => {
  sequence += 1;
  return `${TAG}-exec-${sequence}`;
};

async function reset() {
  await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
  await prisma!.tradingSessionSlot.deleteMany({
    where: { tradingSession: { executionProfileId: profileId } },
  });
  await prisma!.tradingSession.deleteMany({ where: { executionProfileId: profileId } });
  await prisma!.executionProfile.update({ where: { id: profileId }, data: { isEnabled: false } });
  await prisma!.executionSafetyPolicy.update({
    where: { executionProfileId: profileId },
    data: { killSwitchActive: true },
  });
}

beforeAll(async () => {
  if (!prisma || !available) return;
  const profile = await prisma.executionProfile.create({
    data: {
      name: "30-day session synthetic profile",
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

/** Start a session and return the committed session and its window. */
async function start(durationMinutes: number, tradeBudget: number) {
  const result = await service().startTrading(START_TRADING_CONFIRMATION, durationMinutes, tradeBudget);
  expect(result.ok, `start ${durationMinutes}m: ${result.blockers.join(" ")}`).toBe(true);
  const [session] = await sessions();
  const [window] = await windows();
  return { session, window };
}

// ===========================================================================
// A-D. The duration itself
// ===========================================================================

describe("A-D. a 30-day session is accepted and stored as one fixed window", () => {
  maybe()("A. the 30-day preset is offered and accepted end to end", async () => {
    expect([...START_TRADING_DURATION_CHOICES]).toContain(THIRTY_DAYS);
    const { session } = await start(THIRTY_DAYS, 10);
    expect(session.status).toBe("ACTIVE");
    expect(session.tradeBudget).toBe(10);
    expect(session.unlimited).toBe(false);
  });

  maybe()("B. a custom 43200 is accepted", async () => {
    const { session } = await start(43_200, 10);
    expect(session).toBeDefined();
    expect(Math.round((session.expiresAt.getTime() - session.startedAt.getTime()) / 60_000)).toBe(43_200);
  });

  maybe()("C. 43201 is refused and nothing is written", async () => {
    const result = await service().startTrading(START_TRADING_CONFIRMATION, 43_201, 10);
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toBe("DURATION_INVALID");
    expect(await sessions()).toHaveLength(0);
    expect(await windows()).toHaveLength(0);
  });

  maybe()("D. expiresAt is exactly startedAt plus the requested duration", async () => {
    for (const minutes of [60, DAY_MINUTES, 3 * DAY_MINUTES, 7 * DAY_MINUTES, THIRTY_DAYS]) {
      await reset();
      const { session } = await start(minutes, 10);
      // EXACT, not approximate: both timestamps come from one instant read
      // once, so there is no drift to tolerate.
      expect(session.expiresAt.getTime() - session.startedAt.getTime(), `${minutes}m`).toBe(
        minutes * 60_000
      );
    }
  });

  maybe()("D2. a 30-day expiry is a real timestamp roughly 30 days out", async () => {
    const before = Date.now();
    const { session } = await start(THIRTY_DAYS, 10);
    const after = Date.now();
    const thirtyDaysMs = THIRTY_DAYS * 60_000;
    expect(session.expiresAt.getTime()).toBeGreaterThanOrEqual(before + thirtyDaysMs);
    expect(session.expiresAt.getTime()).toBeLessThanOrEqual(after + thirtyDaysMs);
  });
});

// ===========================================================================
// E. The coupling that makes a 30-day session mean anything
// ===========================================================================

describe("E. the authorization lasts exactly as long as its session", () => {
  maybe()("E. a 30-day session's window expires WITH it, not 24 hours in", async () => {
    const { session, window } = await start(THIRTY_DAYS, 10);

    // The hazard, named: a window that expired first would stop admission on
    // day one while the session still reported 29 days remaining.
    expect(window.tradingSessionId).toBe(session.id);
    expect(window.expiresAt.getTime()).toBe(session.expiresAt.getTime());
    expect(window.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * DAY_MINUTES * 60_000);
  });

  maybe()("E2. every duration keeps the two expiries identical", async () => {
    for (const minutes of [60, 720, DAY_MINUTES, 7 * DAY_MINUTES, THIRTY_DAYS]) {
      await reset();
      const { session, window } = await start(minutes, 10);
      expect(window.expiresAt.getTime(), `${minutes}m`).toBe(session.expiresAt.getTime());
    }
  });

  maybe()("E3. the session ceiling never exceeds the session-backed window ceiling", () => {
    // If this ever inverts, a legal session could not get a window that lives
    // as long as it — the exact failure E guards against, arriving by
    // constant drift rather than by code change.
    expect(SESSION_MAX_DURATION_MINUTES).toBeLessThanOrEqual(
      MAXIMUM_SESSION_BACKED_AUTHORIZATION_TTL_MINUTES
    );
    expect(MAXIMUM_SESSION_BACKED_AUTHORIZATION_TTL_MINUTES).toBe(THIRTY_DAYS);
  });

  maybe()("E4. a LEGACY window keeps the 24-hour ceiling", async () => {
    // Nothing counts a legacy window's trades but maxClaims and time, so time
    // still has to be short. Unchanged by this feature, on purpose.
    expect(MAXIMUM_AUTHORIZATION_TTL_MINUTES).toBe(DAY_MINUTES);
    expect(maximumAuthorizationTtlMinutes(false)).toBe(DAY_MINUTES);
    expect(maximumAuthorizationTtlMinutes(true)).toBe(THIRTY_DAYS);

    const authorizations = new CanaryAuthorizationService(prisma!);
    await expect(
      authorizations.prepareNaturalWindow({
        executionProfileId: profileId,
        allowedDirections: ["LONG"],
        maxClaims: 5,
        ttlMinutes: DAY_MINUTES + 1,
      })
    ).rejects.toThrow(/ttlMinutes must be between 1 and 1440/);
    expect(await windows()).toHaveLength(0);
  });

  maybe()("E5. a session-backed window past 30 days is still refused", async () => {
    const session = await prisma!.tradingSession.create({
      data: {
        executionProfileId: profileId,
        status: "ACTIVE",
        tradeBudget: 10,
        expiresAt: new Date(Date.now() + THIRTY_DAYS * 60_000),
      },
    });
    const authorizations = new CanaryAuthorizationService(prisma!);
    await expect(
      authorizations.prepareNaturalWindow({
        executionProfileId: profileId,
        allowedDirections: ["LONG"],
        maxClaims: 5,
        ttlMinutes: THIRTY_DAYS + 1,
        tradingSessionId: session.id,
      })
    ).rejects.toThrow(/ttlMinutes must be between 1 and 43200/);
  });
});

// ===========================================================================
// F-G. Duration and budget remain independent stop conditions
// ===========================================================================

describe("F-G. expiry and budget stop admission independently", () => {
  maybe()("F. a 30-day session still stops at its finite budget", async () => {
    const { session } = await start(THIRTY_DAYS, 10);

    for (let index = 0; index < 10; index += 1) {
      const tradeExecutionId = nextExecutionId();
      const reservation = await reserveSessionSlot(prisma!, {
        executionProfileId: profileId,
        tradingSessionId: session.id,
        tradeExecutionId,
        now: new Date(),
      });
      expect(reservation.reserved, `trade ${index + 1}`).toBe(true);
      // Actual exposure: RESERVED -> OPENED, which is what the budget counts.
      await applySessionAccountingForStatus(prisma!, {
        tradeExecutionId,
        status: "ENTRY_FILLED",
        firstFillAt: new Date(),
        now: new Date(),
      });
    }

    const after = await prisma!.tradingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.openedCount).toBe(10);

    // The 11th, with 29-odd days of duration still to run.
    const refused = await reserveSessionSlot(prisma!, {
      executionProfileId: profileId,
      tradingSessionId: session.id,
      tradeExecutionId: nextExecutionId(),
      now: new Date(),
    });
    expect(refused.reserved).toBe(false);
    expect(refused.reasonCode).toBe("SESSION_BUDGET_EXHAUSTED");
    expect(after.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MINUTES * 60_000);
  });

  maybe()("G. expiry stops admission even with the whole budget unused", async () => {
    const { session } = await start(THIRTY_DAYS, 300);

    // Judged at an instant past the expiry rather than by waiting: the model
    // takes `now` as an argument precisely so this is testable.
    const afterExpiry = new Date(session.expiresAt.getTime() + 1_000);
    const refused = await reserveSessionSlot(prisma!, {
      executionProfileId: profileId,
      tradingSessionId: session.id,
      tradeExecutionId: nextExecutionId(),
      now: afterExpiry,
    });
    expect(refused.reserved).toBe(false);
    expect(refused.reasonCode).toBe("SESSION_EXPIRED");

    // Budget was never touched, so the refusal really is about time.
    const after = await prisma!.tradingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.openedCount).toBe(0);
    expect(after.reservedCount).toBe(0);
    expect(after.tradeBudget).toBe(300);
  });

  maybe()("G2. time is reported before budget when both are gone", async () => {
    const expired = {
      status: "ACTIVE" as const,
      expiresAt: new Date(Date.now() - 1_000),
      tradeBudget: 10,
      unlimited: false,
      openedCount: 10,
      reservedCount: 0,
    };
    const verdict = sessionAdmissionState(expired, new Date());
    expect(verdict.admits).toBe(false);
    if (!verdict.admits) expect(verdict.reasonCode).toBe("SESSION_EXPIRED");
  });
});

// ===========================================================================
// H. Restart and recovery
// ===========================================================================

describe("H. a long session is durable across a restart", () => {
  maybe()("H. re-reading preserves the original expiry and the TTL only shrinks", async () => {
    const { session } = await start(THIRTY_DAYS, 100);
    const originalExpiry = session.expiresAt.getTime();
    const originalStart = session.startedAt.getTime();

    // A restart is, to this model, nothing more than reading the row again:
    // there is no in-memory countdown to lose and no scheduler to re-arm.
    const reread = await prisma!.tradingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(reread.expiresAt.getTime()).toBe(originalExpiry);
    expect(reread.startedAt.getTime()).toBe(originalStart);

    // Remaining time is computed from the persisted expiry, so it falls as the
    // clock advances and is never reset to a fresh 30 days.
    const earlier = Math.floor((reread.expiresAt.getTime() - Date.now()) / 1000);
    const laterInstant = new Date(Date.now() + 60 * 60_000);
    const later = Math.floor((reread.expiresAt.getTime() - laterInstant.getTime()) / 1000);
    expect(later).toBeLessThan(earlier);
    expect(earlier - later).toBe(3_600);

    // And it still admits, an hour in.
    expect(sessionAdmissionState(reread, laterInstant).admits).toBe(true);
  });

  maybe()("H2. a revoked session does not resume on re-read", async () => {
    const { session } = await start(THIRTY_DAYS, 100);
    await service().stopNewTrades();

    const reread = await prisma!.tradingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(reread.status).toBe("REVOKED");
    // 29 days of duration remain and none of it grants anything.
    expect(reread.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MINUTES * 60_000);
    const verdict = sessionAdmissionState(reread, new Date());
    expect(verdict.admits).toBe(false);
    if (!verdict.admits) expect(verdict.reasonCode).toBe("SESSION_REVOKED");
  });
});

// ===========================================================================
// H3-H5. The signed 32-bit millisecond boundary
// ===========================================================================

describe("H3-H5. a 30-day session crosses the int32 millisecond ceiling safely", () => {
  const INT32_MAX = 2 ** 31 - 1;

  maybe()("H3. a persisted 30-day session outlives the int32 timer ceiling", async () => {
    // 30 days is 2,592,000,000 ms; a signed 32-bit delay tops out at
    // 2,147,483,647 ms (~24.855 days). A single `setTimeout` for the session
    // length would overflow and fire almost immediately instead of on day 30.
    //
    // Nothing schedules one — this proves the consequence: the session is
    // still admitting on day 25, well past where an overflowed timer would
    // already have misfired.
    const { session } = await start(THIRTY_DAYS, 300);
    const lifetimeMs = session.expiresAt.getTime() - session.startedAt.getTime();
    expect(lifetimeMs).toBe(2_592_000_000);
    expect(lifetimeMs).toBeGreaterThan(INT32_MAX);

    const dayTwentyFive = new Date(session.startedAt.getTime() + 25 * 86_400_000);
    expect(dayTwentyFive.getTime() - session.startedAt.getTime()).toBeGreaterThan(INT32_MAX);

    const reserved = await reserveSessionSlot(prisma!, {
      executionProfileId: profileId,
      tradingSessionId: session.id,
      tradeExecutionId: nextExecutionId(),
      now: dayTwentyFive,
    });
    expect(reserved.reserved, "day 25 must still admit").toBe(true);
  });

  maybe()("H4. and stops at day 30, decided by comparison against the stored row", async () => {
    const { session } = await start(THIRTY_DAYS, 300);

    // The authoritative `now` is supplied, so expiry needs no waiting and no
    // timer: the SQL reservation guard is `"expiresAt" > now` against the
    // persisted column.
    const justBefore = new Date(session.expiresAt.getTime() - 1_000);
    const admitted = await reserveSessionSlot(prisma!, {
      executionProfileId: profileId,
      tradingSessionId: session.id,
      tradeExecutionId: nextExecutionId(),
      now: justBefore,
    });
    expect(admitted.reserved).toBe(true);

    const refused = await reserveSessionSlot(prisma!, {
      executionProfileId: profileId,
      tradingSessionId: session.id,
      tradeExecutionId: nextExecutionId(),
      now: new Date(session.expiresAt.getTime() + 1_000),
    });
    expect(refused.reserved).toBe(false);
    expect(refused.reasonCode).toBe("SESSION_EXPIRED");

    // The stored expiry never moved through any of that.
    const reread = await prisma!.tradingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(reread.expiresAt.getTime()).toBe(session.expiresAt.getTime());
  });

  maybe()("H5. session lookup orders on the DATABASE clock, not the supplied one", async () => {
    // `startedAt` is supplied by Start Trading so a session and its window can
    // share ONE instant. That makes it application-controlled — and therefore
    // the wrong thing to decide which session is "current". A backend whose
    // clock had stepped backwards could write a newer session that sorted
    // older, and Stop would then act on the wrong row.
    //
    // `createdAt` is `@default(now())` and is never supplied by any caller, so
    // it is the DATABASE's clock and cannot be skewed by an application.
    //
    // The hazard is forged directly here, because Start Trading's own
    // exclusivity rules make it unreachable through the normal path: an older
    // REVOKED row whose startedAt is NEWER than the live ACTIVE row's.
    const stale = await prisma!.tradingSession.create({
      data: {
        executionProfileId: profileId,
        status: "REVOKED",
        tradeBudget: 10,
        startedAt: new Date("2030-01-01T00:00:00.000Z"),
        expiresAt: new Date("2030-01-31T00:00:00.000Z"),
        endedAt: new Date("2030-01-02T00:00:00.000Z"),
      },
    });
    const live = await prisma!.tradingSession.create({
      data: {
        executionProfileId: profileId,
        status: "ACTIVE",
        tradeBudget: 100,
        startedAt: new Date("2020-01-01T00:00:00.000Z"),
        expiresAt: new Date(Date.now() + THIRTY_DAYS * 60_000),
      },
    });
    // Sorting by startedAt would name the REVOKED row as current...
    expect(stale.startedAt.getTime()).toBeGreaterThan(live.startedAt.getTime());
    // ...while the database's own clock names the live one, correctly.
    expect(live.createdAt.getTime()).toBeGreaterThanOrEqual(stale.createdAt.getTime());

    const outcome = await revokeCurrentSession(prisma!, profileId, new Date());

    // Ordering by startedAt would have found the REVOKED row, reported
    // `revoked: false`, and left the live session ACTIVE with 30 days of
    // duration on it.
    expect(outcome.revoked).toBe(true);
    expect(outcome.sessionId).toBe(live.id);
    const reread = await prisma!.tradingSession.findUniqueOrThrow({ where: { id: live.id } });
    expect(reread.status).toBe("REVOKED");
  });

  maybe()("H6. the status panel reports the newest session by the database clock", async () => {
    // Same reasoning, the read side. `findCurrentSession` backs the Current
    // Session panel, so a skewed startedAt must not make it report a session
    // the operator already ended.
    await prisma!.tradingSession.create({
      data: {
        executionProfileId: profileId,
        status: "REVOKED",
        tradeBudget: 10,
        startedAt: new Date("2030-01-01T00:00:00.000Z"),
        expiresAt: new Date("2030-01-31T00:00:00.000Z"),
      },
    });
    const live = await prisma!.tradingSession.create({
      data: {
        executionProfileId: profileId,
        status: "ACTIVE",
        tradeBudget: 100,
        startedAt: new Date("2020-01-01T00:00:00.000Z"),
        expiresAt: new Date(Date.now() + THIRTY_DAYS * 60_000),
      },
    });

    const current = await findCurrentSession(prisma!, profileId);
    expect(current?.id).toBe(live.id);
  });
});

// ===========================================================================
// I. Operator controls outrank remaining duration
// ===========================================================================

describe("I. Stop and Safe Off end a 30-day session immediately", () => {
  maybe()("I. Stop New Trades blocks admission with 29 days left", async () => {
    const { session } = await start(THIRTY_DAYS, 300);
    await service().stopNewTrades();

    const policy = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
      where: { executionProfileId: profileId },
    });
    expect(policy.killSwitchActive).toBe(true);

    const refused = await reserveSessionSlot(prisma!, {
      executionProfileId: profileId,
      tradingSessionId: session.id,
      tradeExecutionId: nextExecutionId(),
      now: new Date(),
    });
    expect(refused.reserved).toBe(false);
    expect(refused.reasonCode).toBe("SESSION_REVOKED");
  });

  maybe()("I2. Safe Off disarms and revokes the window, whatever duration remains", async () => {
    await start(THIRTY_DAYS, 300);
    await service().safeOff();

    const profile = await prisma!.executionProfile.findUniqueOrThrow({
      where: { id: profileId },
      include: { safetyPolicy: true },
    });
    expect(profile.isEnabled).toBe(false);
    expect(profile.safetyPolicy?.killSwitchActive).toBe(true);

    const live = (await windows()).filter((row) => row.revokedAt === null);
    expect(live, "Safe Off must leave no live window").toHaveLength(0);

    const [session] = await sessions();
    expect(session.status).toBe("REVOKED");
  });
});

// ===========================================================================
// J-K. Nothing else moved
// ===========================================================================

describe("J-K. the shorter durations and the legacy modes are unchanged", () => {
  maybe()("J. the 24-hour preset behaves exactly as before", async () => {
    const { session, window } = await start(DAY_MINUTES, 100);
    expect(session.expiresAt.getTime() - session.startedAt.getTime()).toBe(DAY_MINUTES * 60_000);
    expect(window.expiresAt.getTime()).toBe(session.expiresAt.getTime());
    expect(window.maxClaims).toBe(5);
    // Session-backed windows still spend no claims.
    expect(window.claimedCount).toBe(0);
    expect(sessionAdmissionState(session, new Date()).admits).toBe(true);
  });

  maybe()("J2. an unsupplied duration still takes the reviewed one-hour default", async () => {
    const result = await service().startTrading(START_TRADING_CONFIRMATION);
    expect(result.ok).toBe(true);
    const [session] = await sessions();
    // Unchanged by this feature: widening what may be ASKED for never widens
    // what an existing caller silently receives.
    expect(session.expiresAt.getTime() - session.startedAt.getTime()).toBe(60 * 60_000);
    expect(session.tradeBudget).toBe(5);
  });

  maybe()("K. a legacy NATURAL window is still legacy, unlinked and 24h-bounded", async () => {
    const authorizations = new CanaryAuthorizationService(prisma!);
    const legacy = await authorizations.prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims: 5,
      ttlMinutes: DAY_MINUTES,
    });
    expect(legacy.tradingSessionId).toBeNull();
    expect(legacy.maxClaims).toBe(5);
    expect(Math.round((legacy.expiresAt.getTime() - legacy.createdAt.getTime()) / 60_000)).toBe(
      DAY_MINUTES
    );
  });

  maybe()("K2. EXACT_SIGNAL preparation is untouched by the session ceiling", async () => {
    // The exact path has its own TTL handling and no session at all. Proving
    // it still refuses a 30-day TTL shows the new ceiling did not leak into it.
    const authorizations = new CanaryAuthorizationService(prisma!);
    const prepared = await authorizations.prepare({
      executionProfileId: profileId,
      symbol: "COWUSDT",
      direction: "LONG",
      ttlMinutes: 10,
    });
    expect(prepared.authorization.authorizationType).toBe("EXACT_SIGNAL");
    // Never session-backed, and one-shot: an exact authorization names a
    // symbol and a direction and carries no claim budget at all. Unchanged.
    expect(prepared.authorization.tradingSessionId).toBeNull();
    expect(prepared.authorization.maxClaims).toBeNull();
    expect(prepared.authorization.allowedSymbol).toBe("COWUSDT");
    expect(prepared.authorization.tokenHash).not.toBeNull();
    // Its TTL still comes from its own default path, untouched by the
    // session ceiling: 10 minutes asked for, 10 minutes granted.
    expect(
      Math.round(
        (prepared.authorization.expiresAt.getTime() - prepared.authorization.createdAt.getTime()) / 60_000
      )
    ).toBe(10);
  });
});
