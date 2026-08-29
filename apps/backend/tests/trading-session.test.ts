import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";

/**
 * Session trade budgets — bounded by trades that actually obtained exposure.
 *
 * ## The bug this replaces
 *
 * `ExecutionCanaryAuthorization.claimedCount` is spent at ADMISSION and, in its
 * own schema's words, is "NEVER decremented — a claim is not refunded when its
 * execution later expires unfilled". So five claims bought five ADMISSIONS, not
 * five positions. The 2026-08-26 session is the proof: one claim died on an
 * entry that never filled and the window still read 5/5, having produced four
 * positions.
 *
 * A session counts what actually happened. A slot is RESERVED at admission and
 * becomes OPENED only when the execution first holds a non-zero position; an
 * entry that expires, is cancelled or fails without ever filling gives its slot
 * back.
 *
 * ## The invariant these tests exist to defend
 *
 *     openedCount + reservedCount <= tradeBudget       (always, for finite)
 *
 * under concurrency, retries, restarts, partial fills, cancel races and
 * repeated recovery. Most of what follows attacks that one line.
 */

const SYNTHETIC_TAG = "session-budget-synthetic";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const BACKEND = path.resolve(__dirname, "..");
const codeOf = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SERVICE_SOURCE = readFileSync(
  path.join(BACKEND, "src/modules/execution/trading-session.service.ts"),
  "utf8"
);
const SERVICE_CODE = codeOf(SERVICE_SOURCE);
const ADMISSION_CODE = codeOf(
  readFileSync(path.join(BACKEND, "src/modules/execution/safety-admission.service.ts"), "utf8")
);
const ENTRY_CODE = codeOf(
  readFileSync(path.join(BACKEND, "src/modules/execution/entry-lifecycle.service.ts"), "utf8")
);

const {
  SESSION_BUDGET_PRESETS,
  SESSION_DURATION_PRESET_MINUTES,
  SESSION_MAX_DURATION_MINUTES,
  SESSION_MAX_TRADE_BUDGET,
  releasesSessionSlot,
  sessionAdmissionState,
  validateSessionBudget,
  validateSessionDuration,
} = await import("../src/modules/execution/trading-session");

const {
  applySessionAccountingForStatus,
  openSessionSlot,
  releaseSessionSlot,
  reserveSessionSlot,
  revokeCurrentSession,
} = await import("../src/modules/execution/trading-session.service");

const maybe = () => (available ? it : it.skip);

let profileId = "";
let sequence = 0;

async function newSession(options: { budget?: number | null; unlimited?: boolean; minutes?: number } = {}) {
  await prisma!.tradingSessionSlot.deleteMany({
    where: { tradingSession: { executionProfileId: profileId } },
  });
  await prisma!.tradingSession.deleteMany({ where: { executionProfileId: profileId } });
  const created = await prisma!.tradingSession.create({
    data: {
      executionProfileId: profileId,
      status: "ACTIVE",
      tradeBudget: options.unlimited ? null : (options.budget ?? 100),
      unlimited: options.unlimited ?? false,
      expiresAt: new Date(Date.now() + (options.minutes ?? 60) * 60_000),
    },
  });
  currentSessionId = created.id;
  return created;
}

/** A synthetic execution id. No TradeExecution row is needed: slots key on id. */
const nextExecutionId = () => {
  sequence += 1;
  return `${SYNTHETIC_TAG}-exec-${sequence}`;
};

/**
 * Reserve against the CURRENT session by id.
 *
 * The id is passed explicitly because production does: a window names the
 * session it authorizes for, so an older window can never spend a newer
 * session's budget.
 */
let currentSessionId = "";
const reserve = (tradeExecutionId: string, now = new Date()) =>
  reserveSessionSlot(prisma!, {
    executionProfileId: profileId,
    tradingSessionId: currentSessionId,
    tradeExecutionId,
    now,
  });

const readSession = async () =>
  prisma!.tradingSession.findFirstOrThrow({
    where: { executionProfileId: profileId },
    orderBy: { startedAt: "desc" },
  });

beforeAll(async () => {
  if (!prisma || !available) return;
  const profile = await prisma.executionProfile.create({
    data: {
      name: "Session budget synthetic profile",
      accountIdentifier: `${SYNTHETIC_TAG}-account`,
      environment: "TESTNET",
      isEnabled: false,
    },
  });
  profileId = profile.id;
});

afterEach(async () => {
  if (!prisma || !available) return;
  await prisma.tradingSessionSlot.deleteMany({
    where: { tradingSession: { executionProfileId: profileId } },
  });
  await prisma.tradingSession.deleteMany({ where: { executionProfileId: profileId } });
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    await prisma.tradingSessionSlot.deleteMany({
      where: { tradingSession: { executionProfileId: profileId } },
    });
    await prisma.tradingSession.deleteMany({ where: { executionProfileId: profileId } });
    await prisma.executionProfile.deleteMany({ where: { id: profileId } });
  }
  await prisma.$disconnect();
});

// ===========================================================================
// A-E. Creation, durations and budgets
// ===========================================================================

describe("A-E. session shape, durations and budgets", () => {
  it("B. offers 1h, 6h, 12h and 24h", () => {
    expect([...SESSION_DURATION_PRESET_MINUTES]).toEqual([60, 360, 720, 1440]);
    for (const minutes of SESSION_DURATION_PRESET_MINUTES) {
      expect(validateSessionDuration(minutes), String(minutes)).toEqual({ ok: true, minutes });
    }
  });

  it("C. accepts a custom duration and refuses past 24 hours", () => {
    for (const good of [1, 45, 90, 1439, SESSION_MAX_DURATION_MINUTES]) {
      expect(`${good}:${validateSessionDuration(good).ok}`).toBe(`${good}:true`);
    }
    for (const bad of [0, -1, 1441, 2880, 1.5, Number.NaN, "60", null, {}]) {
      expect(`${String(bad)}:${validateSessionDuration(bad).ok}`).toBe(`${String(bad)}:false`);
    }
  });

  it("C2. presets and custom values share ONE validator", () => {
    // A preset is a convenience, never a second code path that could admit
    // what custom cannot.
    for (const minutes of SESSION_DURATION_PRESET_MINUTES) {
      expect(validateSessionDuration(minutes).ok).toBe(true);
    }
    expect(Math.max(...SESSION_DURATION_PRESET_MINUTES)).toBe(SESSION_MAX_DURATION_MINUTES);
  });

  it("D. offers 10/50/100/200/300", () => {
    expect([...SESSION_BUDGET_PRESETS]).toEqual([10, 50, 100, 200, 300]);
  });

  it("E. accepts a custom finite budget and refuses a malformed one", () => {
    for (const good of [1, 7, 300, SESSION_MAX_TRADE_BUDGET]) {
      const verdict = validateSessionBudget(good, { unlimitedPermitted: false });
      expect(`${good}:${verdict.ok}`).toBe(`${good}:true`);
    }
    for (const bad of [0, -1, 1.5, SESSION_MAX_TRADE_BUDGET + 1, Number.NaN, "10", null]) {
      const verdict = validateSessionBudget(bad, { unlimitedPermitted: false });
      expect(`${String(bad)}:${verdict.ok}`).toBe(`${String(bad)}:false`);
    }
  });
});

// ===========================================================================
// F/G. Unlimited
// ===========================================================================

describe("F/G. unlimited is a server decision", () => {
  it("F. accepted only when the server says the environment is non-live", () => {
    const permitted = validateSessionBudget(undefined, {
      unlimited: true,
      unlimitedPermitted: true,
    });
    expect(permitted).toEqual({ ok: true, tradeBudget: null, unlimited: true });
  });

  it("G. refused on a live account, and NOT silently downgraded", () => {
    const refused = validateSessionBudget(100, { unlimited: true, unlimitedPermitted: false });
    expect(refused.ok).toBe(false);
    // Quietly trading a different configuration from the one asked for is
    // worse than refusing, so it does not fall back to the finite 100.
    expect(refused).not.toMatchObject({ ok: true });
  });

  it("G2. the capability is derived from the SERVER, never from a request body", () => {
    const capability = codeOf(
      readFileSync(path.join(BACKEND, "src/modules/operator/session-capability.ts"), "utf8")
    );
    // Both facts must agree, and UNKNOWN is not permission.
    expect(capability).toContain('profileEnvironment === "TESTNET"');
    expect(capability).toContain('connectorEnvironment === "TESTNET"');
    expect(capability).not.toMatch(/request|body|req\./);
  });
});

// ===========================================================================
// H-K. Reservation and the budget invariant
// ===========================================================================

describe("H-K. reservation", () => {
  maybe()("H. a new session starts at zero", async () => {
    const session = await newSession({ budget: 100 });
    expect(session.openedCount).toBe(0);
    expect(session.reservedCount).toBe(0);
  });

  maybe()("I. an admission reserves exactly one", async () => {
    await newSession({ budget: 100 });
    const result = await reserve(nextExecutionId());
    expect(result.reserved).toBe(true);
    const after = await readSession();
    expect(after.reservedCount).toBe(1);
    expect(after.openedCount).toBe(0);
  });

  maybe()("J. remaining reflects what is already taken", async () => {
    await newSession({ budget: 3 });
    for (let i = 0; i < 3; i += 1) expect((await reserve(nextExecutionId())).reserved).toBe(true);

    const full = await readSession();
    expect(full.reservedCount).toBe(3);
    const refused = await reserve(nextExecutionId());
    expect(refused.reserved).toBe(false);
    if (!refused.reserved) expect(refused.reasonCode).toBe("SESSION_BUDGET_EXHAUSTED");
  });

  maybe()("K. the final slot admits exactly ONE of two racers", async () => {
    await newSession({ budget: 1 });
    const [a, b] = await Promise.all([reserve(nextExecutionId()), reserve(nextExecutionId())]);

    const winners = [a, b].filter((r) => r.reserved);
    expect(winners).toHaveLength(1);
    const after = await readSession();
    expect(after.reservedCount).toBe(1);
  });

  maybe()("AD. a budget of 20 never lets opened+reserved exceed 20, under a stampede", async () => {
    await newSession({ budget: 20 });
    const attempts = await Promise.all(
      Array.from({ length: 60 }, () => reserve(nextExecutionId()))
    );

    expect(attempts.filter((r) => r.reserved)).toHaveLength(20);
    const after = await readSession();
    expect(after.reservedCount + after.openedCount).toBe(20);
    expect(after.reservedCount + after.openedCount).toBeLessThanOrEqual(20);
  });

  maybe()("an unlimited session reserves without a ceiling", async () => {
    await newSession({ unlimited: true });
    for (let i = 0; i < 25; i += 1) expect((await reserve(nextExecutionId())).reserved).toBe(true);
    expect((await readSession()).reservedCount).toBe(25);
  });
});

// ===========================================================================
// L-Q. Opening, releasing, and what must never be refunded
// ===========================================================================

describe("L-Q. slot resolution", () => {
  maybe()("O. a first fill converts the reservation to opened", async () => {
    await newSession({ budget: 10 });
    const id = nextExecutionId();
    await reserve(id);

    await openSessionSlot(prisma!, { tradeExecutionId: id, openedAt: new Date() });

    const after = await readSession();
    expect(after.openedCount).toBe(1);
    expect(after.reservedCount).toBe(0);
  });

  maybe()("P. a full fill after a partial does not count twice", async () => {
    await newSession({ budget: 10 });
    const id = nextExecutionId();
    await reserve(id);

    // PARTIALLY_FILLED, then ENTRY_FILLED — the same execution, twice.
    await applySessionAccountingForStatus(prisma!, {
      tradeExecutionId: id,
      status: "PARTIALLY_FILLED",
      firstFillAt: new Date(),
      now: new Date(),
    });
    await applySessionAccountingForStatus(prisma!, {
      tradeExecutionId: id,
      status: "ENTRY_FILLED",
      firstFillAt: new Date(),
      now: new Date(),
    });

    expect((await readSession()).openedCount).toBe(1);
  });

  maybe()("L/M/N. an unfilled expiry, cancel or failure releases the slot", async () => {
    for (const status of ["ENTRY_EXPIRED", "CANCELED", "FAILED", "SKIPPED"]) {
      await newSession({ budget: 10 });
      const id = nextExecutionId();
      await reserve(id);

      await applySessionAccountingForStatus(prisma!, {
        tradeExecutionId: id,
        status,
        firstFillAt: null,
        now: new Date(),
      });

      const after = await readSession();
      expect(`${status}:${after.reservedCount}`, status).toBe(`${status}:0`);
      expect(`${status}:${after.openedCount}`, status).toBe(`${status}:0`);
    }
  });

  maybe()("S. a partially filled entry that is later cancelled KEEPS its opened trade", async () => {
    // It touched the exchange. A trade that happened is not refundable.
    await newSession({ budget: 10 });
    const id = nextExecutionId();
    await reserve(id);
    const filledAt = new Date();

    await applySessionAccountingForStatus(prisma!, {
      tradeExecutionId: id,
      status: "PARTIALLY_FILLED",
      firstFillAt: filledAt,
      now: new Date(),
    });
    // The remainder is then cancelled — but firstFillAt is set, so this is not
    // a release.
    await applySessionAccountingForStatus(prisma!, {
      tradeExecutionId: id,
      status: "CANCELED",
      firstFillAt: filledAt,
      now: new Date(),
    });

    const after = await readSession();
    expect(after.openedCount).toBe(1);
    expect(after.reservedCount).toBe(0);
  });

  it("the release rule requires BOTH a terminal status and no fill", () => {
    expect(releasesSessionSlot("ENTRY_EXPIRED", null)).toBe(true);
    expect(releasesSessionSlot("ENTRY_EXPIRED", new Date())).toBe(false);
    expect(releasesSessionSlot("PROTECTED", null)).toBe(false);
    expect(releasesSessionSlot("CLOSED_TP", new Date())).toBe(false);
  });

  maybe()("Q. closing a position never refunds the opened count", async () => {
    await newSession({ budget: 10 });
    const id = nextExecutionId();
    await reserve(id);
    const filledAt = new Date();
    await applySessionAccountingForStatus(prisma!, {
      tradeExecutionId: id,
      status: "ENTRY_FILLED",
      firstFillAt: filledAt,
      now: new Date(),
    });

    for (const closed of ["CLOSED_TP", "CLOSED_SL", "CLOSED_EXTERNAL"]) {
      await applySessionAccountingForStatus(prisma!, {
        tradeExecutionId: id,
        status: closed,
        firstFillAt: filledAt,
        now: new Date(),
      });
    }

    expect((await readSession()).openedCount).toBe(1);
  });

  maybe()("a released slot is never re-reserved", async () => {
    await newSession({ budget: 10 });
    const id = nextExecutionId();
    await reserve(id);
    await releaseSessionSlot(prisma!, { tradeExecutionId: id, releasedAt: new Date(), reason: "ENTRY_EXPIRED" });

    const again = await reserve(id);
    expect(again.reserved).toBe(false);
    expect((await readSession()).reservedCount).toBe(0);
  });
});

// ===========================================================================
// U-Y. Idempotency and recovery
// ===========================================================================

describe("U-Y. repeated accounting converges", () => {
  maybe()("U/W/X. repeated open is idempotent across recovery passes", async () => {
    await newSession({ budget: 10 });
    const id = nextExecutionId();
    await reserve(id);
    const filledAt = new Date();

    for (let pass = 0; pass < 5; pass += 1) {
      await openSessionSlot(prisma!, { tradeExecutionId: id, openedAt: filledAt });
    }

    const after = await readSession();
    expect(after.openedCount).toBe(1);
    expect(after.reservedCount).toBe(0);
  });

  maybe()("Y. repeated release is idempotent", async () => {
    await newSession({ budget: 10 });
    const id = nextExecutionId();
    await reserve(id);

    for (let pass = 0; pass < 5; pass += 1) {
      await releaseSessionSlot(prisma!, {
        tradeExecutionId: id,
        releasedAt: new Date(),
        reason: "ENTRY_EXPIRED",
      });
    }

    const after = await readSession();
    expect(after.reservedCount).toBe(0);
    expect(after.openedCount).toBe(0);
  });

  maybe()("a redelivered admission does not take a second slot", async () => {
    await newSession({ budget: 10 });
    const id = nextExecutionId();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await reserve(id)).reserved, `attempt ${attempt}`).toBe(true);
    }

    expect((await readSession()).reservedCount).toBe(1);
    expect(
      await prisma!.tradingSessionSlot.count({ where: { tradeExecutionId: id } })
    ).toBe(1);
  });

  maybe()("V. a cancel that lost to a fill is counted exactly once", async () => {
    // The cancel is requested, the fill lands anyway, and reconciliation sees
    // both. firstFillAt decides, and it decides once.
    await newSession({ budget: 10 });
    const id = nextExecutionId();
    await reserve(id);
    const filledAt = new Date();

    await applySessionAccountingForStatus(prisma!, {
      tradeExecutionId: id, status: "PARTIALLY_FILLED", firstFillAt: filledAt, now: new Date(),
    });
    await applySessionAccountingForStatus(prisma!, {
      tradeExecutionId: id, status: "CANCELED", firstFillAt: filledAt, now: new Date(),
    });
    await applySessionAccountingForStatus(prisma!, {
      tradeExecutionId: id, status: "ENTRY_FILLED", firstFillAt: filledAt, now: new Date(),
    });

    expect((await readSession()).openedCount).toBe(1);
  });

  maybe()("AJ. accounting survives service reconstruction", async () => {
    // The counters live in the database, not in any object. Rebuilding every
    // service — a worker restart — changes nothing.
    await newSession({ budget: 10 });
    const id = nextExecutionId();
    await reserve(id);

    const rebuilt = await import("../src/modules/execution/trading-session.service");
    await rebuilt.openSessionSlot(prisma!, { tradeExecutionId: id, openedAt: new Date() });

    expect((await readSession()).openedCount).toBe(1);
  });

  maybe()("uniqueness is enforced by the DATABASE, not by the caller", async () => {
    await newSession({ budget: 10 });
    const id = nextExecutionId();
    await reserve(id);
    const session = await readSession();

    await expect(
      prisma!.tradingSessionSlot.create({
        data: { tradingSessionId: session.id, tradeExecutionId: id, state: "RESERVED" },
      })
    ).rejects.toThrow();
  });
});

// ===========================================================================
// R/S/T. Session end
// ===========================================================================

describe("R-T. expiry and revocation", () => {
  maybe()("S. an expired session admits nothing new", async () => {
    await newSession({ budget: 100, minutes: -1 });
    const refused = await reserve(nextExecutionId());
    expect(refused.reserved).toBe(false);
    if (!refused.reserved) expect(refused.reasonCode).toBe("SESSION_EXPIRED");
  });

  maybe()("AH. a revoked session admits nothing new", async () => {
    await newSession({ budget: 100 });
    await revokeCurrentSession(prisma!, profileId, new Date());

    const refused = await reserve(nextExecutionId());
    expect(refused.reserved).toBe(false);
    if (!refused.reserved) expect(refused.reasonCode).toBe("SESSION_REVOKED");
  });

  maybe()("R. revoking preserves the opened history", async () => {
    await newSession({ budget: 100 });
    const id = nextExecutionId();
    await reserve(id);
    await openSessionSlot(prisma!, { tradeExecutionId: id, openedAt: new Date() });

    await revokeCurrentSession(prisma!, profileId, new Date());

    const after = await readSession();
    expect(after.status).toBe("REVOKED");
    expect(after.openedCount).toBe(1);
    expect(after.endedAt).not.toBeNull();
  });

  maybe()("T. an ended session leaves reserved slots to resolve normally", async () => {
    // Expiry prevents NEW admission. It does not reach back and cancel an
    // entry that is still on the book, and a fill that lands afterwards still
    // converts exactly once.
    await newSession({ budget: 100 });
    const id = nextExecutionId();
    await reserve(id);
    await revokeCurrentSession(prisma!, profileId, new Date());

    await applySessionAccountingForStatus(prisma!, {
      tradeExecutionId: id,
      status: "ENTRY_FILLED",
      firstFillAt: new Date(),
      now: new Date(),
    });

    const after = await readSession();
    expect(after.openedCount).toBe(1);
    expect(after.reservedCount).toBe(0);
  });

  maybe()("revoking twice is safe", async () => {
    await newSession({ budget: 10 });
    const first = await revokeCurrentSession(prisma!, profileId, new Date());
    const second = await revokeCurrentSession(prisma!, profileId, new Date());
    expect(first.revoked).toBe(true);
    expect(second.revoked).toBe(false);
  });

  it("time is judged before budget, so the operator is sent to the right control", () => {
    const both = sessionAdmissionState(
      {
        status: "ACTIVE",
        expiresAt: new Date(Date.now() - 1000),
        tradeBudget: 1,
        unlimited: false,
        openedCount: 1,
        reservedCount: 0,
      },
      new Date()
    );
    expect(both.admits).toBe(false);
    if (!both.admits) expect(both.reasonCode).toBe("SESSION_EXPIRED");
  });
});

// ===========================================================================
// AE-AG, Z-AC. What the session must NOT do
// ===========================================================================

describe("the session is an ADDITIONAL gate, never a replacement", () => {
  it("AE/AF. nothing is counted before an entry can fill", () => {
    // The reservation happens at admission and the OPEN only at first fill, so
    // a READY plan and a merely-created TradeExecution count for nothing.
    expect(SERVICE_CODE).not.toMatch(/PLAN_READY|createExecutionFromReadyPlan/);
    // The one thing that opens a slot is a first fill.
    expect(SERVICE_CODE).toContain("openSessionSlot");
  });

  it("Z-AC. it changes no capacity, risk, margin or symbol-side limit", () => {
    for (const forbidden of [
      "maxOpenPositions",
      "maxPendingEntries",
      "maxTotalActiveTrades",
      "maxActivePerSymbolSide",
      "maxTotalPlannedRiskUsd",
      "maxTotalIsolatedMarginUsd",
      "executionSafetyPolicy",
    ]) {
      expect(`${forbidden}:${SERVICE_CODE.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("AG. session accounting makes no exchange call and no trading decision", () => {
    for (const forbidden of ["binance", "Binance", "fetch(", "submitOrder", "cancel", "leverage", "riskBudget"]) {
      expect(`${forbidden}:${SERVICE_CODE.toLowerCase().includes(forbidden.toLowerCase())}`).toBe(
        `${forbidden}:false`
      );
    }
    // It touches exactly two models, and both are its own.
    const models = [...SERVICE_CODE.matchAll(/db\.(\w+)\./g)].map((m) => m[1]);
    expect([...new Set(models)].sort()).toEqual(["tradingSession", "tradingSessionSlot"]);
  });

  it("a session-backed window and a legacy one are mutually exclusive branches", () => {
    // The correction that mattered. These were once sequential — claim, THEN
    // reserve — which meant a 100-trade session still stopped at the fifth
    // ADMISSION because maxClaims refused it first. They are now two branches,
    // and each mode has exactly ONE quantitative bound.
    expect(ADMISSION_CODE).toContain(
      'authorization.mode === "NATURAL" && isSessionBackedWindow(authorization.window)'
    );
    const sessionBranch = ADMISSION_CODE.indexOf("isSessionBackedWindow(authorization.window)");
    const legacyBranch = ADMISSION_CODE.indexOf('} else if (authorization.mode === "NATURAL") {');
    expect(sessionBranch).toBeGreaterThan(0);
    expect(legacyBranch).toBeGreaterThan(sessionBranch);

    // Session-backed: reserves, and spends no claim.
    const sessionCode = ADMISSION_CODE.slice(sessionBranch, legacyBranch);
    expect(sessionCode).toContain("reserveSessionSlot(tx");
    expect(sessionCode).not.toContain("claimNaturalWindow(tx");

    // Legacy: claims, and consults no session.
    const legacyCode = ADMISSION_CODE.slice(legacyBranch);
    expect(legacyCode).toContain("claimNaturalWindow(tx");
    expect(legacyCode).not.toContain("reserveSessionSlot(tx");
  });

  it("admission reads the EFFECTIVE window state, not the raw one", () => {
    // `naturalWindowState` still reports EXHAUSTED at maxClaims, and that is
    // correct for a legacy window. Admission must ask the session-aware
    // question instead, or the historical cap would refuse the sixth trade of
    // a hundred-trade session.
    expect(ADMISSION_CODE).toContain("effectiveNaturalWindowState(window, evaluatedAt)");
    expect(ADMISSION_CODE).not.toContain("switch (naturalWindowState(window, evaluatedAt))");
  });

  it("the reservation rides in the admission transaction, not beside it", () => {
    // `tx`, never `this.prisma`: it commits or rolls back with the capacity
    // reservation, so a slot cannot be held by an admission that failed.
    expect(ADMISSION_CODE).toContain("reserveSessionSlot(tx, {");
  });

  it("EVERY terminal path reaches the accounting, not just the happy one", () => {
    // Three hooks, and the count is pinned. Every fill or expiry discovery
    // funnels through `reconcileEntryOrder` — normal submission, restart
    // recovery, TTL expiry, the cancel-lost-to-fill race and the orchestrator's
    // periodic and startup reconciliation all call it — so one hook there
    // covers them. The other two cover the paths that do NOT funnel through it:
    // a PREFLIGHT released before any order existed, and a submission the
    // exchange rejected. A rejection was genuinely missing at first and would
    // have leaked a slot for the life of the session.
    expect(ENTRY_CODE.match(/applySessionAccountingForStatus\(tx, \{/g) ?? []).toHaveLength(3);
  });

  it("the fill hook rides in the transaction that sets firstFillAt", () => {
    expect(ENTRY_CODE).toContain("applySessionAccountingForStatus(tx, {");
    // Reads the COMMITTED row, so it cannot disagree with the status it is
    // accounting for.
    expect(ENTRY_CODE).toContain("firstFillAt: next.firstFillAt");
  });

  it("AC. the claim semantics it replaces are still described honestly", () => {
    // maxClaims still exists and still means what it meant; the session is a
    // separate, refundable budget rather than a redefinition of that column.
    expect(SERVICE_CODE).not.toContain("claimedCount");
    expect(SERVICE_CODE).not.toContain("maxClaims");
  });
});
