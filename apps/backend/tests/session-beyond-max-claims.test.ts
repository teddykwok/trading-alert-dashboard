import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";

/**
 * The contradiction this file exists to disprove.
 *
 * The first cut of session budgets left `maxClaims = 5` gating the natural
 * window AND put the claim BEFORE the session reservation. Both statements
 * could not be true at once:
 *
 *     "a session may open 100 trades"
 *     "the window refuses the 6th ADMISSION"
 *
 * With five filled trades the window read 5/5 and the sixth alert was refused
 * with NATURAL_AUTHORIZATION_EXHAUSTED while the session still showed 95
 * remaining. The old admissions cap was the real ceiling, and the feature did
 * not deliver what it claimed.
 *
 * The fix splits the two questions. A SESSION-BACKED window — one linked to a
 * TradingSession — answers only permission: is it live, is the direction
 * admitted, was it revoked. It spends NO claim, so `claimedCount` stays 0 and
 * `maxClaims` never gates it. How many trades it may produce is the session's
 * budget, counted in trades that actually obtained exposure.
 *
 * A LEGACY window — no session link — is untouched, and `natural-admission`
 * proves that at its original assertions.
 *
 * These tests drive the accounting primitives directly. The wiring that calls
 * them from admission is pinned structurally in `trading-session.test.ts`; what
 * is proven here is the ARITHMETIC the operator was promised.
 */

const TAG = "beyond-claims-synthetic";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { effectiveNaturalWindowState, isSessionBackedWindow, naturalWindowState } = await import(
  "../src/modules/execution/natural-authorization"
);
const {
  applySessionAccountingForStatus,
  reserveSessionSlot,
} = await import("../src/modules/execution/trading-session.service");

const maybe = () => (available ? it : it.skip);

let profileId = "";
let sessionId = "";
let windowId = "";
let sequence = 0;

/** The historical claim budget, still pinned by the arming checks. */
const HISTORICAL_MAX_CLAIMS = 5;

async function openSession(tradeBudget: number) {
  await prisma!.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
  await prisma!.tradingSessionSlot.deleteMany({
    where: { tradingSession: { executionProfileId: profileId } },
  });
  await prisma!.tradingSession.deleteMany({ where: { executionProfileId: profileId } });

  const session = await prisma!.tradingSession.create({
    data: {
      executionProfileId: profileId,
      status: "ACTIVE",
      tradeBudget,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    },
  });
  sessionId = session.id;

  // A window exactly as Start Trading creates it: maxClaims still pinned to
  // the historical 5 so the reviewed arming checks pass unchanged, and LINKED
  // to the session, which is what stops that 5 from being a trade ceiling.
  const window = await prisma!.executionCanaryAuthorization.create({
    data: {
      executionProfileId: profileId,
      authorizationType: "NATURAL_WINDOW",
      allowedDirections: ["LONG", "SHORT"],
      maxClaims: HISTORICAL_MAX_CLAIMS,
      claimedCount: 0,
      tradingSessionId: session.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    },
  });
  windowId = window.id;
  return { session, window };
}

const nextExecutionId = () => {
  sequence += 1;
  return `${TAG}-exec-${sequence}`;
};

const reserve = (tradeExecutionId: string) =>
  reserveSessionSlot(prisma!, {
    executionProfileId: profileId,
    tradingSessionId: sessionId,
    tradeExecutionId,
    now: new Date(),
  });

const readSession = () => prisma!.tradingSession.findUniqueOrThrow({ where: { id: sessionId } });
const readWindow = () =>
  prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: windowId } });

/** Admit a trade and let it obtain exposure. */
async function openTrade() {
  const id = nextExecutionId();
  const reservation = await reserve(id);
  if (reservation.reserved) {
    await applySessionAccountingForStatus(prisma!, {
      tradeExecutionId: id,
      status: "ENTRY_FILLED",
      firstFillAt: new Date(),
      now: new Date(),
    });
  }
  return reservation;
}

/** Admit a trade whose entry never fills, then let it expire. */
async function expireUnfilled() {
  const id = nextExecutionId();
  const reservation = await reserve(id);
  if (reservation.reserved) {
    await applySessionAccountingForStatus(prisma!, {
      tradeExecutionId: id,
      status: "ENTRY_EXPIRED",
      firstFillAt: null,
      now: new Date(),
    });
  }
  return reservation;
}

beforeAll(async () => {
  if (!prisma || !available) return;
  const profile = await prisma.executionProfile.create({
    data: {
      name: "Beyond max claims synthetic profile",
      accountIdentifier: `${TAG}-account`,
      environment: "TESTNET",
      isEnabled: false,
    },
  });
  profileId = profile.id;
});

afterEach(async () => {
  if (!prisma || !available) return;
  await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
  await prisma.tradingSessionSlot.deleteMany({
    where: { tradingSession: { executionProfileId: profileId } },
  });
  await prisma.tradingSession.deleteMany({ where: { executionProfileId: profileId } });
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.tradingSessionSlot.deleteMany({
      where: { tradingSession: { executionProfileId: profileId } },
    });
    await prisma.tradingSession.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionProfile.deleteMany({ where: { id: profileId } });
  }
  await prisma.$disconnect();
});

// ===========================================================================
// TEST A — the sixth opened trade
// ===========================================================================

describe("A. a session-backed window goes past the historical five", () => {
  maybe()("opens a sixth trade, and the budget is what bounds it", async () => {
    await openSession(10);

    for (let i = 0; i < HISTORICAL_MAX_CLAIMS; i += 1) {
      expect((await openTrade()).reserved, `trade ${i + 1}`).toBe(true);
    }
    expect((await readSession()).openedCount).toBe(5);

    // The sixth. This is the trade the old model refused.
    const sixth = await openTrade();
    expect(sixth.reserved).toBe(true);

    const after = await readSession();
    expect(after.openedCount).toBe(6);
    expect(after.reservedCount).toBe(0);
    // 10 budget - 6 opened = 4 remaining.
    expect(after.tradeBudget! - after.openedCount - after.reservedCount).toBe(4);
  });

  maybe()("and it spends no claim doing it", async () => {
    await openSession(10);
    for (let i = 0; i < 6; i += 1) await openTrade();

    const window = await readWindow();
    // Zero, not six. `isNaturalWindow` refuses any row whose claimedCount
    // exceeds maxClaims, so incrementing past the pinned 5 would make the
    // window INVALID and refuse everything. No claims spent is both the honest
    // record and the only valid one.
    expect(window.claimedCount).toBe(0);
    expect(window.maxClaims).toBe(HISTORICAL_MAX_CLAIMS);
  });

  maybe()("EXHAUSTED is not a state a session-backed window can be in", async () => {
    const { window } = await openSession(10);
    // Force the counter to the cap: the LEGACY reading is EXHAUSTED...
    const maxed = { ...window, claimedCount: HISTORICAL_MAX_CLAIMS };
    expect(naturalWindowState(maxed, new Date())).toBe("EXHAUSTED");
    // ...and the EFFECTIVE reading, which admission uses, is not.
    expect(isSessionBackedWindow(maxed)).toBe(true);
    expect(effectiveNaturalWindowState(maxed, new Date())).toBe("AVAILABLE");
  });

  maybe()("but permission still governs: revoked and expired still refuse", async () => {
    const { window } = await openSession(10);
    const now = new Date();
    expect(
      effectiveNaturalWindowState({ ...window, revokedAt: now }, now)
    ).toBe("REVOKED");
    expect(
      effectiveNaturalWindowState({ ...window, expiresAt: new Date(now.getTime() - 1000) }, now)
    ).toBe("EXPIRED");
  });
});

// ===========================================================================
// TEST B — unfilled attempts do not consume the budget
// ===========================================================================

describe("B. attempts that never fill cost nothing", () => {
  maybe()("five unfilled expiries leave the budget untouched, and a sixth still admits", async () => {
    // This is the whole point of the feature: the old claim counter would be
    // at 5/5 here, having produced zero trades.
    await openSession(10);

    for (let i = 0; i < 5; i += 1) {
      expect((await expireUnfilled()).reserved, `attempt ${i + 1}`).toBe(true);
    }

    const before = await readSession();
    expect(before.openedCount).toBe(0);
    expect(before.reservedCount).toBe(0);

    const sixth = await openTrade();
    expect(sixth.reserved).toBe(true);
    expect((await readSession()).openedCount).toBe(1);
  });

  maybe()("a cancel and a failure before any fill are the same", async () => {
    await openSession(10);
    for (const status of ["CANCELED", "FAILED"]) {
      const id = nextExecutionId();
      expect((await reserve(id)).reserved).toBe(true);
      await applySessionAccountingForStatus(prisma!, {
        tradeExecutionId: id,
        status,
        firstFillAt: null,
        now: new Date(),
      });
    }
    const after = await readSession();
    expect(after.openedCount).toBe(0);
    expect(after.reservedCount).toBe(0);
  });
});

// ===========================================================================
// TEST C — the budget is still finite
// ===========================================================================

describe("C. the session budget is a real ceiling", () => {
  maybe()("refuses the 11th trade on a budget of 10, for the SESSION reason", async () => {
    await openSession(10);
    for (let i = 0; i < 10; i += 1) {
      expect((await openTrade()).reserved, `trade ${i + 1}`).toBe(true);
    }
    expect((await readSession()).openedCount).toBe(10);

    const eleventh = await reserve(nextExecutionId());
    expect(eleventh.reserved).toBe(false);
    if (!eleventh.reserved) {
      // The SESSION reason, not an authorization one: the operator's remedy is
      // a bigger budget, not a new window, and reporting the wrong one would
      // send them to the wrong control.
      expect(eleventh.reasonCode).toBe("SESSION_BUDGET_EXHAUSTED");
      expect(eleventh.reasonCode).not.toBe("NATURAL_AUTHORIZATION_EXHAUSTED");
    }
  });
});

// ===========================================================================
// TEST D — pending reservations still prevent overshoot
// ===========================================================================

describe("D. reserved slots count against the budget", () => {
  maybe()("opened 8 + reserved 2 refuses an 11th even while permission is live", async () => {
    await openSession(10);
    for (let i = 0; i < 8; i += 1) await openTrade();
    // Two entries admitted and still on the book.
    for (let i = 0; i < 2; i += 1) expect((await reserve(nextExecutionId())).reserved).toBe(true);

    const before = await readSession();
    expect(before.openedCount).toBe(8);
    expect(before.reservedCount).toBe(2);

    const refused = await reserve(nextExecutionId());
    expect(refused.reserved).toBe(false);
    if (!refused.reserved) expect(refused.reasonCode).toBe("SESSION_BUDGET_EXHAUSTED");

    // The window itself is still perfectly usable — this is a budget refusal.
    const window = await readWindow();
    expect(window.revokedAt).toBeNull();
    expect(effectiveNaturalWindowState(window, new Date())).toBe("AVAILABLE");
  });
});

// ===========================================================================
// TEST E — legacy windows are untouched
// ===========================================================================

describe("E. a legacy window keeps the historical behaviour exactly", () => {
  maybe()("is not session-backed, and still reports EXHAUSTED at its cap", async () => {
    const window = await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG"],
        maxClaims: HISTORICAL_MAX_CLAIMS,
        claimedCount: HISTORICAL_MAX_CLAIMS,
        // No tradingSessionId. This is what "legacy" means.
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    expect(isSessionBackedWindow(window)).toBe(false);
    // Both readings agree for a legacy window, so the historical cap still
    // bites exactly as it always did.
    expect(naturalWindowState(window, new Date())).toBe("EXHAUSTED");
    expect(effectiveNaturalWindowState(window, new Date())).toBe("EXHAUSTED");
  });

  maybe()("a legacy window needs no session, and none is invented for it", async () => {
    await prisma!.tradingSession.deleteMany({ where: { executionProfileId: profileId } });
    const window = await prisma!.executionCanaryAuthorization.create({
      data: {
        executionProfileId: profileId,
        authorizationType: "NATURAL_WINDOW",
        allowedDirections: ["LONG"],
        maxClaims: HISTORICAL_MAX_CLAIMS,
        claimedCount: 2,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    expect(window.tradingSessionId).toBeNull();
    expect(effectiveNaturalWindowState(window, new Date())).toBe("AVAILABLE");
    // Nothing created a session on its behalf.
    expect(await prisma!.tradingSession.count({ where: { executionProfileId: profileId } })).toBe(0);
  });
});

// ===========================================================================
// Fail-closed: a session-backed window whose session is gone
// ===========================================================================

describe("a session-backed window fails CLOSED when its session cannot be read", () => {
  maybe()("refuses rather than falling back to unlimited admissions", async () => {
    await openSession(10);
    // The link survives but the session is unusable.
    await prisma!.tradingSession.update({
      where: { id: sessionId },
      data: { status: "REVOKED", endedAt: new Date() },
    });

    const refused = await reserve(nextExecutionId());
    expect(refused.reserved).toBe(false);
    if (!refused.reserved) expect(refused.reasonCode).toBe("SESSION_REVOKED");
  });

  maybe()("a null link is refused, never resolved to the newest session", async () => {
    await openSession(10);
    const orphan = await reserveSessionSlot(prisma!, {
      executionProfileId: profileId,
      tradingSessionId: null,
      tradeExecutionId: nextExecutionId(),
      now: new Date(),
    });
    expect(orphan.reserved).toBe(false);
    if (!orphan.reserved) expect(orphan.reasonCode).toBe("SESSION_REQUIRED");
    // And nothing was taken from the live session.
    expect((await readSession()).reservedCount).toBe(0);
  });

  maybe()("a session belonging to another profile is refused", async () => {
    await openSession(10);
    const other = await prisma!.executionProfile.create({
      data: {
        name: "Other synthetic profile",
        accountIdentifier: `${TAG}-other`,
        environment: "TESTNET",
        isEnabled: false,
      },
    });
    const otherSession = await prisma!.tradingSession.create({
      data: {
        executionProfileId: other.id,
        status: "ACTIVE",
        tradeBudget: 100,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    const refused = await reserveSessionSlot(prisma!, {
      executionProfileId: profileId,
      tradingSessionId: otherSession.id,
      tradeExecutionId: nextExecutionId(),
      now: new Date(),
    });
    expect(refused.reserved).toBe(false);

    await prisma!.tradingSession.deleteMany({ where: { executionProfileId: other.id } });
    await prisma!.executionProfile.deleteMany({ where: { id: other.id } });
  });
});
