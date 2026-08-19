import { afterAll, describe, expect, it } from "vitest";
import type { ExecutionCanaryAuthorization, PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * Phase 12.2 — NATURAL_WINDOW domain and service primitives.
 *
 * Nothing here is wired to production. These tests prove the primitives a later
 * admission integration will call, and pin the properties that must hold before
 * anything is allowed to call them.
 *
 * Every database case uses the DEDICATED test database through the shared
 * helper, which refuses to fall back to the runtime/canary database. The REAL
 * MAINNET profile is never read or written.
 */

const TAG = "phase12-natural";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const {
  CanaryAuthorizationAlreadyActiveError,
  CanaryAuthorizationService,
  NaturalWindowValidationError,
  claimNaturalWindow,
} = await import("../src/modules/execution/canary-authorization.service");

const {
  MAXIMUM_AUTHORIZATION_TTL_MINUTES,
  describeNaturalWindow,
  isNaturalWindow,
  isNaturalWindowAvailable,
  isNaturalWindowOpen,
  naturalWindowAdmitsDirection,
  naturalWindowState,
  normalizeNaturalDirections,
  remainingNaturalClaims,
} = await import("../src/modules/execution/natural-authorization");

const profileIds: string[] = [];
let seq = 0;

async function newProfile(): Promise<string> {
  seq += 1;
  const profile = await prisma!.executionProfile.create({
    data: {
      name: `${TAG}-${seq}`,
      accountIdentifier: `${TAG}-${seq}-${Date.now().toString(36)}`,
      environment: "TESTNET",
    },
  });
  await prisma!.executionSafetyPolicy.create({ data: { executionProfileId: profile.id } });
  profileIds.push(profile.id);
  return profile.id;
}

const service = () => new CanaryAuthorizationService(prisma!);

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    await prisma.executionCanaryAuthorization.deleteMany({ where: { executionProfileId: { in: profileIds } } });
    await prisma.executionSafetyPolicy.deleteMany({ where: { executionProfileId: { in: profileIds } } });
    await prisma.executionProfile.deleteMany({ where: { id: { in: profileIds } } });
  }
  await prisma.$disconnect();
});

const describeDb = available ? describe : describe.skip;

const HOUR = 3_600_000;

/** A well-formed natural window as a plain object, for the pure-domain cases. */
function naturalRow(overrides: Partial<ExecutionCanaryAuthorization> = {}): ExecutionCanaryAuthorization {
  return {
    id: "nat-1",
    executionProfileId: "profile-1",
    authorizationType: "NATURAL_WINDOW",
    allowedSymbol: null,
    allowedDirection: null,
    tokenHash: null,
    allowedDirections: ["LONG"],
    maxClaims: 5,
    claimedCount: 0,
    version: 1,
    expiresAt: new Date(Date.now() + HOUR),
    createdAt: new Date(),
    consumedAt: null,
    consumedAlertId: null,
    consumedExecutionId: null,
    revokedAt: null,
    ...overrides,
  } as ExecutionCanaryAuthorization;
}

const NOW = () => new Date();

// ---------------------------------------------------------------------------
// 19. Domain validation — pure, no database
// ---------------------------------------------------------------------------

describe("natural window: shape validation", () => {
  it("A. accepts a well-formed NATURAL_WINDOW", () => {
    expect(isNaturalWindow(naturalRow())).toBe(true);
    expect(naturalWindowState(naturalRow(), NOW())).toBe("AVAILABLE");
  });

  it("B. rejects a non-null tokenHash", () => {
    // A window authorizes server-side. A secret on the row means it is not one.
    expect(isNaturalWindow(naturalRow({ tokenHash: "deadbeef" }))).toBe(false);
  });

  it("C. rejects a non-null allowedSymbol", () => {
    // The locked design: a window names NO symbol, ever.
    expect(isNaturalWindow(naturalRow({ allowedSymbol: "BTCUSDT" }))).toBe(false);
  });

  it("D. rejects a non-null allowedDirection", () => {
    // The singular column belongs to exact mode; natural uses the array.
    expect(isNaturalWindow(naturalRow({ allowedDirection: "LONG" }))).toBe(false);
  });

  it("E. rejects an empty allowedDirections", () => {
    // Empty is a REJECTION, never an implicit "all directions".
    expect(isNaturalWindow(naturalRow({ allowedDirections: [] }))).toBe(false);
    expect(naturalWindowState(naturalRow({ allowedDirections: [] }), NOW())).toBe("INVALID");
  });

  it("F. canonicalizes duplicate and unordered directions", () => {
    expect(normalizeNaturalDirections(["LONG", "LONG"])).toEqual(["LONG"]);
    expect(normalizeNaturalDirections(["SHORT", "LONG"])).toEqual(["LONG", "SHORT"]);
    expect(normalizeNaturalDirections([" long ", "SHORT"])).toEqual(["LONG", "SHORT"]);
    // ...and refuses anything that is not a direction, with no partial credit.
    expect(normalizeNaturalDirections([])).toBeNull();
    expect(normalizeNaturalDirections(["LONG", "SIDEWAYS"])).toBeNull();
    expect(normalizeNaturalDirections(["*"])).toBeNull();
    expect(normalizeNaturalDirections(["BOTH"])).toBeNull();
    // A row that somehow stored duplicates is malformed, not de-duplicated.
    expect(isNaturalWindow(naturalRow({ allowedDirections: ["LONG", "LONG"] }))).toBe(false);
  });

  it("G. rejects a null maxClaims", () => {
    // Null is malformed, NOT unlimited. There is no unlimited representation.
    expect(isNaturalWindow(naturalRow({ maxClaims: null }))).toBe(false);
  });

  it("H. rejects maxClaims below 1", () => {
    for (const maxClaims of [0, -1, 2.5, Number.NaN]) {
      expect(isNaturalWindow(naturalRow({ maxClaims }))).toBe(false);
    }
  });

  it("I. rejects a negative claimedCount", () => {
    expect(isNaturalWindow(naturalRow({ claimedCount: -1 }))).toBe(false);
  });

  it("J. rejects claimedCount above maxClaims", () => {
    // Only something other than the guarded claim could produce this, so the
    // row cannot be trusted.
    expect(isNaturalWindow(naturalRow({ maxClaims: 3, claimedCount: 4 }))).toBe(false);
    // The boundary itself is valid — spent, not corrupt.
    expect(isNaturalWindow(naturalRow({ maxClaims: 3, claimedCount: 3 }))).toBe(true);
  });

  it("rejects a non-positive version and an unusable expiry", () => {
    expect(isNaturalWindow(naturalRow({ version: 0 }))).toBe(false);
    expect(isNaturalWindow(naturalRow({ expiresAt: new Date(Number.NaN) }))).toBe(false);
  });

  it("reads the discriminator, never the populated columns", () => {
    // An exact row carrying every exact field is not rescued into natural mode,
    // and a natural-shaped row that declares EXACT_SIGNAL is not a window.
    expect(isNaturalWindow(naturalRow({ authorizationType: "EXACT_SIGNAL" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 19 K-M. Window state
// ---------------------------------------------------------------------------

describe("natural window: state", () => {
  it("K. an expired window is neither open nor available", () => {
    const expired = naturalRow({ expiresAt: new Date(Date.now() - 1000) });
    expect(naturalWindowState(expired, NOW())).toBe("EXPIRED");
    expect(isNaturalWindowOpen(expired, NOW())).toBe(false);
    expect(isNaturalWindowAvailable(expired, NOW())).toBe(false);
  });

  it("L. a revoked window is neither open nor available", () => {
    const revoked = naturalRow({ revokedAt: new Date() });
    expect(naturalWindowState(revoked, NOW())).toBe("REVOKED");
    expect(isNaturalWindowOpen(revoked, NOW())).toBe(false);
    expect(isNaturalWindowAvailable(revoked, NOW())).toBe(false);
  });

  it("M. an exhausted window is OPEN but not AVAILABLE", () => {
    // The distinction operator tooling will eventually need: the window is
    // still in date and still describes what it authorized — it simply has
    // nothing left to spend.
    const spent = naturalRow({ maxClaims: 2, claimedCount: 2 });
    expect(naturalWindowState(spent, NOW())).toBe("EXHAUSTED");
    expect(isNaturalWindowOpen(spent, NOW())).toBe(true);
    expect(isNaturalWindowAvailable(spent, NOW())).toBe(false);
    expect(remainingNaturalClaims(spent, NOW())).toBe(0);
  });

  it("revocation outranks expiry, and malformed outranks everything", () => {
    const both = naturalRow({ revokedAt: new Date(), expiresAt: new Date(Date.now() - 1000) });
    expect(naturalWindowState(both, NOW())).toBe("REVOKED");
    const broken = naturalRow({ maxClaims: null, revokedAt: new Date() });
    expect(naturalWindowState(broken, NOW())).toBe("INVALID");
  });

  it("reports remaining budget only while available", () => {
    expect(remainingNaturalClaims(naturalRow({ maxClaims: 5, claimedCount: 2 }), NOW())).toBe(3);
    expect(remainingNaturalClaims(naturalRow({ revokedAt: new Date() }), NOW())).toBe(0);
  });

  it("describes a window without any secret", () => {
    const status = describeNaturalWindow(naturalRow({ maxClaims: 4, claimedCount: 1 }), NOW());
    expect(status).toMatchObject({
      state: "AVAILABLE",
      allowedDirections: ["LONG"],
      maxClaims: 4,
      claimedCount: 1,
      remainingClaims: 3,
      version: 1,
    });
    expect(JSON.stringify(status)).not.toMatch(/token|hash|secret/i);
  });
});

// ---------------------------------------------------------------------------
// 19 N-O. Direction eligibility — no symbol appears anywhere here
// ---------------------------------------------------------------------------

describe("natural window: direction eligibility", () => {
  it("N. a LONG-only window refuses SHORT", () => {
    const longOnly = naturalRow({ allowedDirections: ["LONG"] });
    expect(naturalWindowAdmitsDirection(longOnly, "LONG", NOW())).toBe(true);
    expect(naturalWindowAdmitsDirection(longOnly, "SHORT", NOW())).toBe(false);
  });

  it("O. a LONG+SHORT window permits each explicitly", () => {
    const both = naturalRow({ allowedDirections: ["LONG", "SHORT"] });
    expect(naturalWindowAdmitsDirection(both, "LONG", NOW())).toBe(true);
    expect(naturalWindowAdmitsDirection(both, "SHORT", NOW())).toBe(true);
  });

  it("never implicitly enables a direction", () => {
    const shortOnly = naturalRow({ allowedDirections: ["SHORT"] });
    expect(naturalWindowAdmitsDirection(shortOnly, "LONG", NOW())).toBe(false);
    // Nothing that is not a direction is admitted, including wildcards.
    for (const bogus of ["*", "ALL", "BOTH", "", "long "]) {
      const value = naturalWindowAdmitsDirection(naturalRow({ allowedDirections: ["LONG", "SHORT"] }), bogus, NOW());
      expect(`${bogus}:${value}`).toBe(`${bogus}:${bogus.trim().toUpperCase() === "LONG"}`);
    }
  });

  it("refuses every direction once the window is unusable", () => {
    for (const overrides of [
      { revokedAt: new Date() },
      { expiresAt: new Date(Date.now() - 1000) },
      { maxClaims: 1, claimedCount: 1 },
      { allowedDirections: [] },
    ]) {
      const row = naturalRow({ allowedDirections: ["LONG", "SHORT"], ...overrides });
      expect(naturalWindowAdmitsDirection(row, "LONG", NOW())).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 20. Preparation
// ---------------------------------------------------------------------------

describeDb("natural window: preparation", () => {
  it("A-E. creates exactly the reviewed shape", async () => {
    const profileId = await newProfile();
    const window = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["SHORT", "LONG", "LONG"],
      maxClaims: 5,
      ttlMinutes: 30,
    });

    expect(window.authorizationType).toBe("NATURAL_WINDOW");
    // B. No token was generated, and none is stored.
    expect(window.tokenHash).toBeNull();
    // C. No singular symbol or direction.
    expect(window.allowedSymbol).toBeNull();
    expect(window.allowedDirection).toBeNull();
    // Canonicalized and de-duplicated.
    expect(window.allowedDirections).toEqual(["LONG", "SHORT"]);
    expect(window.maxClaims).toBe(5);
    // D/E.
    expect(window.claimedCount).toBe(0);
    expect(window.version).toBe(1);
    // Exact-consumption fields stay untouched.
    expect(window.consumedAt).toBeNull();
    expect(window.consumedAlertId).toBeNull();
    expect(window.consumedExecutionId).toBeNull();
    expect(window.revokedAt).toBeNull();
    expect(isNaturalWindow(window)).toBe(true);
  });

  it("F. requires a bounded expiry and defaults to the exact-mode TTL", async () => {
    const profileId = await newProfile();
    const before = Date.now();
    const window = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims: 1,
    });
    // Always in the future, and never beyond the hard cap.
    expect(window.expiresAt.getTime()).toBeGreaterThan(before);
    expect(window.expiresAt.getTime()).toBeLessThanOrEqual(
      before + MAXIMUM_AUTHORIZATION_TTL_MINUTES * 60_000
    );
  });

  it("F. rejects a TTL beyond the hard cap and a non-positive one", async () => {
    const profileId = await newProfile();
    for (const ttlMinutes of [0, -5, MAXIMUM_AUTHORIZATION_TTL_MINUTES + 1, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(
        service().prepareNaturalWindow({
          executionProfileId: profileId,
          allowedDirections: ["LONG"],
          maxClaims: 1,
          ttlMinutes,
        })
      ).rejects.toBeInstanceOf(NaturalWindowValidationError);
    }
    // Nothing was written by any rejected attempt.
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  it("G. rejects an invalid maxClaims, including 'unlimited'", async () => {
    const profileId = await newProfile();
    for (const maxClaims of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        service().prepareNaturalWindow({
          executionProfileId: profileId,
          allowedDirections: ["LONG"],
          maxClaims,
        })
      ).rejects.toBeInstanceOf(NaturalWindowValidationError);
    }
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  it("H. rejects empty or invalid directions", async () => {
    const profileId = await newProfile();
    for (const allowedDirections of [[], ["BOTH"], ["*"], ["LONG", "SIDEWAYS"]]) {
      await expect(
        service().prepareNaturalWindow({ executionProfileId: profileId, allowedDirections, maxClaims: 1 })
      ).rejects.toBeInstanceOf(NaturalWindowValidationError);
    }
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(0);
  });

  it("I-K. touches no policy field and no profile gate", async () => {
    const profileId = await newProfile();
    const policyBefore = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
      where: { executionProfileId: profileId },
    });
    const profileBefore = await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } });

    await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG", "SHORT"],
      maxClaims: 3,
    });

    // I. allowedSymbols is NOT narrowed — unlike exact preparation, a natural
    // window authorizes no ticker and must not pretend to.
    // J/K. No capacity field, kill switch or version moved.
    expect(
      await prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileId } })
    ).toEqual(policyBefore);
    expect(await prisma!.executionProfile.findUniqueOrThrow({ where: { id: profileId } })).toEqual(profileBefore);
  });

  it("L. an active EXACT window blocks natural preparation", async () => {
    const profileId = await newProfile();
    await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });

    await expect(
      service().prepareNaturalWindow({ executionProfileId: profileId, allowedDirections: ["LONG"], maxClaims: 2 })
    ).rejects.toBeInstanceOf(CanaryAuthorizationAlreadyActiveError);

    expect(
      await prisma!.executionCanaryAuthorization.count({
        where: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW" },
      })
    ).toBe(0);
  });

  it("M. an open NATURAL window blocks exact preparation", async () => {
    const profileId = await newProfile();
    await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims: 2,
    });

    await expect(
      service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" })
    ).rejects.toBeInstanceOf(CanaryAuthorizationAlreadyActiveError);

    expect(
      await prisma!.executionCanaryAuthorization.count({
        where: { executionProfileId: profileId, authorizationType: "EXACT_SIGNAL" },
      })
    ).toBe(0);
  });

  it("M. an open NATURAL window also blocks a second natural preparation", async () => {
    const profileId = await newProfile();
    await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims: 2,
    });
    await expect(
      service().prepareNaturalWindow({ executionProfileId: profileId, allowedDirections: ["SHORT"], maxClaims: 2 })
    ).rejects.toBeInstanceOf(CanaryAuthorizationAlreadyActiveError);
  });

  it("N. a revoked or expired window no longer blocks, matching exact semantics", async () => {
    // Exclusivity is "active", not "on record" — the same rule exact mode has
    // always used, reached here through the SAME predicate.
    const profileId = await newProfile();
    const first = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims: 1,
    });
    await service().revokeNaturalWindow(profileId, first.id);

    const second = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["SHORT"],
      maxClaims: 1,
    });
    expect(second.id).not.toBe(first.id);

    // Now expire the second and prove an EXACT preparation is unblocked too.
    await prisma!.executionCanaryAuthorization.update({
      where: { id: second.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const exact = await service().prepare({
      executionProfileId: profileId,
      symbol: "BTCUSDT",
      direction: "LONG",
    });
    expect(exact.authorization.authorizationType).toBe("EXACT_SIGNAL");
    // History is never deleted.
    expect(await prisma!.executionCanaryAuthorization.count({ where: { executionProfileId: profileId } })).toBe(3);
  });

  it("finds the open natural window, and stops finding it once shut", async () => {
    const profileId = await newProfile();
    const window = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims: 2,
    });
    expect((await service().findNaturalWindow(profileId))?.id).toBe(window.id);

    await service().revokeNaturalWindow(profileId, window.id);
    expect(await service().findNaturalWindow(profileId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 12. Revocation
// ---------------------------------------------------------------------------

describeDb("natural window: revocation", () => {
  it("shuts the window without erasing anything", async () => {
    const profileId = await newProfile();
    const window = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG", "SHORT"],
      maxClaims: 4,
    });
    await claimNaturalWindow(prisma!, {
      authorizationId: window.id,
      expectedVersion: 1,
      direction: "LONG",
      evaluatedAt: new Date(),
    });

    expect(await service().revokeNaturalWindow(profileId, window.id)).toBe(true);

    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.revokedAt).not.toBeNull();
    // The row survives, and the audit facts survive with it.
    expect(after.claimedCount).toBe(1);
    expect(after.allowedDirections).toEqual(["LONG", "SHORT"]);
    expect(after.maxClaims).toBe(4);
    expect(naturalWindowState(after, new Date())).toBe("REVOKED");
  });

  it("is idempotent and never touches an exact row", async () => {
    const profileId = await newProfile();
    const window = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims: 1,
    });
    expect(await service().revokeNaturalWindow(profileId, window.id)).toBe(true);
    // Second call moves nothing and does not raise.
    expect(await service().revokeNaturalWindow(profileId, window.id)).toBe(false);

    // An EXACT row is unreachable from this method even by id.
    await prisma!.executionCanaryAuthorization.update({
      where: { id: window.id },
      data: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) },
    });
    const exact = await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });
    expect(await service().revokeNaturalWindow(profileId, exact.authorization.id)).toBe(false);
    expect(
      (await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: exact.authorization.id } }))
        .revokedAt
    ).toBeNull();
  });

  it("is profile scoped", async () => {
    const owner = await newProfile();
    const stranger = await newProfile();
    const window = await service().prepareNaturalWindow({
      executionProfileId: owner,
      allowedDirections: ["LONG"],
      maxClaims: 1,
    });

    expect(await service().revokeNaturalWindow(stranger, window.id)).toBe(false);
    expect(
      (await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } })).revokedAt
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 21. Claim
// ---------------------------------------------------------------------------

describeDb("natural window: claim", () => {
  const openWindow = async (
    overrides: { allowedDirections?: string[]; maxClaims?: number } = {}
  ): Promise<{ profileId: string; window: ExecutionCanaryAuthorization }> => {
    const profileId = await newProfile();
    const window = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: overrides.allowedDirections ?? ["LONG"],
      maxClaims: overrides.maxClaims ?? 3,
    });
    return { profileId, window };
  };

  const read = (id: string) => prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id } });

  it("A-F. an available LONG window claims LONG and moves only the counters", async () => {
    const { window } = await openWindow();
    const result = await claimNaturalWindow(prisma!, {
      authorizationId: window.id,
      expectedVersion: 1,
      direction: "LONG",
      evaluatedAt: new Date(),
    });

    expect(result.ok).toBe(true);
    const after = await read(window.id);
    expect(after.claimedCount).toBe(1); // B. 0 -> 1
    expect(after.version).toBe(2); // C. 1 -> 2
    expect(after.consumedAt).toBeNull(); // D.
    expect(after.consumedAlertId).toBeNull(); // E.
    expect(after.consumedExecutionId).toBeNull(); // F.
    // Nothing else moved either.
    expect(after.allowedDirections).toEqual(window.allowedDirections);
    expect(after.maxClaims).toBe(window.maxClaims);
    expect(after.revokedAt).toBeNull();
  });

  it("works with a real transaction client, which is how admission will call it", async () => {
    // The contract that matters for Phase 3: the claim commits or rolls back
    // with whatever else the caller's transaction does.
    const { window } = await openWindow();
    await prisma!.$transaction(async (tx) => {
      const result = await claimNaturalWindow(tx, {
        authorizationId: window.id,
        expectedVersion: 1,
        direction: "LONG",
        evaluatedAt: new Date(),
      });
      expect(result.ok).toBe(true);
    });
    expect((await read(window.id)).claimedCount).toBe(1);
  });

  it("rolls the claim back when the caller's transaction fails", async () => {
    // The whole reason the primitive takes a client instead of opening its own
    // transaction: a claim must not survive a capacity refusal.
    const { window } = await openWindow();
    await expect(
      prisma!.$transaction(async (tx) => {
        const result = await claimNaturalWindow(tx, {
          authorizationId: window.id,
          expectedVersion: 1,
          direction: "LONG",
          evaluatedAt: new Date(),
        });
        expect(result.ok).toBe(true);
        throw new Error("caller refused after claiming");
      })
    ).rejects.toThrow(/caller refused/);

    const after = await read(window.id);
    expect(after.claimedCount).toBe(0);
    expect(after.version).toBe(1);
  });

  it.each([
    [
      "G. wrong direction",
      "DIRECTION_NOT_ALLOWED",
      async (id: string) => id,
      { direction: "SHORT", expectedVersion: 1 },
    ],
    [
      "H. expired",
      "EXPIRED",
      async (id: string) => {
        await prisma!.executionCanaryAuthorization.update({
          where: { id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
        return id;
      },
      { direction: "LONG", expectedVersion: 1 },
    ],
    [
      "I. revoked",
      "REVOKED",
      async (id: string) => {
        await prisma!.executionCanaryAuthorization.update({ where: { id }, data: { revokedAt: new Date() } });
        return id;
      },
      { direction: "LONG", expectedVersion: 1 },
    ],
    [
      "J. exhausted",
      "EXHAUSTED",
      async (id: string) => {
        await prisma!.executionCanaryAuthorization.update({
          where: { id },
          data: { claimedCount: 3, version: 4 },
        });
        return id;
      },
      { direction: "LONG", expectedVersion: 4 },
    ],
    [
      "K. stale version",
      "VERSION_CONFLICT",
      async (id: string) => id,
      { direction: "LONG", expectedVersion: 99 },
    ],
  ])("%s does not increment (%s)", async (_label, expected, mutate, args) => {
    const { window } = await openWindow();
    await mutate(window.id);
    const before = await read(window.id);

    const result = await claimNaturalWindow(prisma!, {
      authorizationId: window.id,
      expectedVersion: args.expectedVersion,
      direction: args.direction,
      evaluatedAt: new Date(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe(expected);
    // L. every failure leaves the counters exactly as they were.
    const after = await read(window.id);
    expect(after.claimedCount).toBe(before.claimedCount);
    expect(after.version).toBe(before.version);
  });

  it("refuses a non-natural row and a malformed one", async () => {
    const profileId = await newProfile();
    const exact = await service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" });
    const notNatural = await claimNaturalWindow(prisma!, {
      authorizationId: exact.authorization.id,
      expectedVersion: 1,
      direction: "LONG",
      evaluatedAt: new Date(),
    });
    expect(notNatural.ok).toBe(false);
    if (!notNatural.ok) expect(notNatural.reasonCode).toBe("NOT_NATURAL");

    const missing = await claimNaturalWindow(prisma!, {
      authorizationId: "no-such-authorization",
      expectedVersion: 1,
      direction: "LONG",
      evaluatedAt: new Date(),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reasonCode).toBe("NATURAL_WINDOW_NOT_FOUND");

    // A row declaring NATURAL_WINDOW while carrying exact identity is refused
    // as malformed rather than coerced into something usable.
    await prisma!.executionCanaryAuthorization.update({
      where: { id: exact.authorization.id },
      data: { authorizationType: "NATURAL_WINDOW", allowedDirections: ["LONG"], maxClaims: 2 },
    });
    const malformed = await claimNaturalWindow(prisma!, {
      authorizationId: exact.authorization.id,
      expectedVersion: 1,
      direction: "LONG",
      evaluatedAt: new Date(),
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.reasonCode).toBe("MALFORMED_NATURAL_WINDOW");
  });

  it("M. spending the budget makes the window EXHAUSTED and refuses the next claim", async () => {
    const { window } = await openWindow({ maxClaims: 3 });

    for (let expected = 1; expected <= 3; expected += 1) {
      const current = await read(window.id);
      const result = await claimNaturalWindow(prisma!, {
        authorizationId: window.id,
        expectedVersion: current.version,
        direction: "LONG",
        evaluatedAt: new Date(),
      });
      expect(result.ok).toBe(true);
      expect((await read(window.id)).claimedCount).toBe(expected);
    }

    const spent = await read(window.id);
    expect(naturalWindowState(spent, new Date())).toBe("EXHAUSTED");
    expect(spent.claimedCount).toBe(3);
    expect(spent.version).toBe(4);

    const overspend = await claimNaturalWindow(prisma!, {
      authorizationId: window.id,
      expectedVersion: spent.version,
      direction: "LONG",
      evaluatedAt: new Date(),
    });
    expect(overspend.ok).toBe(false);
    if (!overspend.ok) expect(overspend.reasonCode).toBe("EXHAUSTED");
    expect((await read(window.id)).claimedCount).toBe(3);
  });

  it("N. exposes no refund, release or decrement path", () => {
    // Locked design: a claim spent on an execution that later expires unfilled
    // is NOT returned. A mutable counter could be raced and would stop being a
    // durable audit fact.
    const serviceApi = Object.getOwnPropertyNames(CanaryAuthorizationService.prototype);
    for (const forbidden of ["refundClaim", "releaseClaim", "restoreClaim", "unclaim", "decrementClaim"]) {
      expect(`${forbidden}:${serviceApi.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

// ---------------------------------------------------------------------------
// 22. Concurrency boundary — the HONEST contract of this primitive alone
// ---------------------------------------------------------------------------

describeDb("natural window: concurrency boundary", () => {
  /**
   * What the guarded claim guarantees BY ITSELF, with no lock:
   *
   *   - a stale evaluated version can never win
   *   - claimedCount can never exceed maxClaims
   *   - version advances only on a successful claim
   *
   * What it deliberately does NOT provide here: "10 contenders, 5 slots, 5
   * winners in one pass". That needs the caller to re-read and retry under a
   * serializing lock — which SafetyAdmissionService ALREADY holds
   * (`pg_advisory_xact_lock`) and already implements as a bounded retry loop.
   * Phase 3 gets that property for free by claiming inside that transaction.
   *
   * Adding a second lock here purely to make a stronger test pass would create
   * exactly the duplicate concurrency mechanism the design forbids, so that
   * property is deferred rather than faked.
   */
  it("admits exactly one of ten contenders sharing the same evaluated version", async () => {
    const profileId = await newProfile();
    const window = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims: 5,
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        claimNaturalWindow(prisma!, {
          authorizationId: window.id,
          expectedVersion: 1,
          direction: "LONG",
          evaluatedAt: new Date(),
        })
      )
    );

    // The version CAS is the whole mechanism: one winner, nine refusals.
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reasonCode === "VERSION_CONFLICT")).toBe(true);

    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.claimedCount).toBe(1);
    expect(after.version).toBe(2);
  });

  it("never exceeds maxClaims even when far more claimants re-read and retry", async () => {
    // The caller's loop, modelled: re-read, claim, repeat. This is the shape
    // SafetyAdmissionService already uses, and it is what Phase 3 will supply.
    const profileId = await newProfile();
    const window = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims: 5,
    });

    let granted = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
      const result = await claimNaturalWindow(prisma!, {
        authorizationId: window.id,
        expectedVersion: current.version,
        direction: "LONG",
        evaluatedAt: new Date(),
      });
      if (result.ok) granted += 1;
    }

    expect(granted).toBe(5);
    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.claimedCount).toBe(5);
    // Version advanced ONLY on the five successes.
    expect(after.version).toBe(6);
    expect(naturalWindowState(after, new Date())).toBe("EXHAUSTED");
  });

  it("leaves the counter untouched when every contender is stale", async () => {
    const profileId = await newProfile();
    const window = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims: 5,
    });
    // Move the version out from under them.
    await claimNaturalWindow(prisma!, {
      authorizationId: window.id,
      expectedVersion: 1,
      direction: "LONG",
      evaluatedAt: new Date(),
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        claimNaturalWindow(prisma!, {
          authorizationId: window.id,
          expectedVersion: 1,
          direction: "LONG",
          evaluatedAt: new Date(),
        })
      )
    );

    expect(results.every((r) => !r.ok)).toBe(true);
    expect(
      (await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } })).claimedCount
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Claim CAS — the budget the ceiling was derived from must still be the budget
// ---------------------------------------------------------------------------

describeDb("natural window: stale-budget CAS", () => {
  const read = (id: string) => prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id } });

  const openWindow = async (maxClaims: number) => {
    const profileId = await newProfile();
    return service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims,
    });
  };

  /** A client that mutates the row after the claim reads it, before it updates. */
  const racingClient = (
    id: string,
    interference: Record<string, unknown>,
    state: { fired: boolean }
  ): Parameters<typeof claimNaturalWindow>[0] =>
    ({
      executionCanaryAuthorization: {
        findUnique: async (args: never) => {
          const row = await prisma!.executionCanaryAuthorization.findUnique(args);
          if (!state.fired) {
            state.fired = true;
            await prisma!.executionCanaryAuthorization.update({ where: { id }, data: interference });
          }
          // The caller receives the STALE row, which was consistent when read.
          return row;
        },
        updateMany: (args: never) => prisma!.executionCanaryAuthorization.updateMany(args),
        findUniqueOrThrow: (args: never) => prisma!.executionCanaryAuthorization.findUniqueOrThrow(args),
      },
    }) as unknown as Parameters<typeof claimNaturalWindow>[0];

  it("refuses when the budget was already shrunk before the call, at the same version", async () => {
    // The evaluated budget (5) exceeds the current one (2) and the version did
    // not move. Caught early because the claim re-reads and classifies the row
    // EXHAUSTED before the update is ever attempted.
    const window = await openWindow(5);
    await prisma!.executionCanaryAuthorization.update({
      where: { id: window.id },
      data: { maxClaims: 2, claimedCount: 2 },
    });

    const result = await claimNaturalWindow(prisma!, {
      authorizationId: window.id,
      expectedVersion: window.version,
      direction: "LONG",
      evaluatedAt: new Date(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("EXHAUSTED");
    expect((await read(window.id)).claimedCount).toBe(2);
  });

  /**
   * The gap the `maxClaims` equality actually closes.
   *
   * The row is CONSISTENT when the claim reads it and becomes inconsistent
   * before the guarded update runs, so re-reading cannot help. The version
   * guard cannot help either, because the interfering write leaves `version`
   * alone. Only asserting that `maxClaims` still equals the value the ceiling
   * was derived from refuses this.
   *
   * Without that clause the update matches on `claimedCount(2) < 5` and
   * `version = N`, granting a third claim against a budget of two.
   */
  it("refuses when the budget is shrunk BETWEEN the read and the guarded update", async () => {
    const window = await openWindow(5);
    const state = { fired: false };

    const result = await claimNaturalWindow(
      racingClient(window.id, { maxClaims: 2, claimedCount: 2 }, state),
      {
        authorizationId: window.id,
        expectedVersion: window.version,
        direction: "LONG",
        evaluatedAt: new Date(),
      }
    );

    expect(state.fired).toBe(true);
    expect(result.ok).toBe(false);
    // Reported as a conflict: the row moved under the evaluation.
    if (!result.ok) expect(result.reasonCode).toBe("VERSION_CONFLICT");

    // The decisive assertion: the budget was NOT overspent.
    const after = await read(window.id);
    expect(after.claimedCount).toBe(2);
    expect(after.maxClaims).toBe(2);
    expect(after.version).toBe(window.version);
    expect(after.claimedCount).toBeLessThanOrEqual(after.maxClaims!);
  });

  it("refuses when the budget GREW between the read and the update", async () => {
    // The predicate asserts equality, not "at least". A budget that changed at
    // all invalidates the evaluation that was built on it.
    const window = await openWindow(2);
    const state = { fired: false };

    const result = await claimNaturalWindow(racingClient(window.id, { maxClaims: 99 }, state), {
      authorizationId: window.id,
      expectedVersion: window.version,
      direction: "LONG",
      evaluatedAt: new Date(),
    });

    expect(state.fired).toBe(true);
    expect(result.ok).toBe(false);
    expect((await read(window.id)).claimedCount).toBe(0);
  });

  it("still grants normally when nothing interferes", async () => {
    // Guards against the fix over-tightening into "never claims".
    const window = await openWindow(5);
    const result = await claimNaturalWindow(prisma!, {
      authorizationId: window.id,
      expectedVersion: window.version,
      direction: "LONG",
      evaluatedAt: new Date(),
    });

    expect(result.ok).toBe(true);
    const after = await read(window.id);
    expect(after.claimedCount).toBe(1);
    expect(after.maxClaims).toBe(5);
    expect(after.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Exhausted-window exclusivity — a spent budget is NOT a free slot
// ---------------------------------------------------------------------------

describeDb("natural window: exhausted exclusivity", () => {
  /**
   * Locked product behaviour: an unexpired, unrevoked natural window stays
   * EXCLUSIVE after its budget is spent.
   *
   * `maxClaims` is a CUMULATIVE authorization, so letting a replacement window
   * be prepared the moment the old one exhausts would silently refill a budget
   * the operator deliberately bounded. The window must expire or be revoked
   * first, and both of those are explicit acts.
   */
  const exhaust = async () => {
    const profileId = await newProfile();
    const window = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims: 2,
    });
    for (let i = 0; i < 2; i += 1) {
      const current = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
      const result = await claimNaturalWindow(prisma!, {
        authorizationId: window.id,
        expectedVersion: current.version,
        direction: "LONG",
        evaluatedAt: new Date(),
      });
      expect(result.ok).toBe(true);
    }
    const spent = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(naturalWindowState(spent, new Date())).toBe("EXHAUSTED");
    return { profileId, window: spent };
  };

  it("an EXHAUSTED window still blocks a replacement natural window", async () => {
    const { profileId } = await exhaust();
    await expect(
      service().prepareNaturalWindow({ executionProfileId: profileId, allowedDirections: ["LONG"], maxClaims: 5 })
    ).rejects.toBeInstanceOf(CanaryAuthorizationAlreadyActiveError);
    // The budget was not refilled by a second window appearing beside it.
    expect(
      await prisma!.executionCanaryAuthorization.count({
        where: { executionProfileId: profileId, authorizationType: "NATURAL_WINDOW" },
      })
    ).toBe(1);
  });

  it("an EXHAUSTED window also blocks an EXACT preparation", async () => {
    const { profileId } = await exhaust();
    await expect(
      service().prepare({ executionProfileId: profileId, symbol: "BTCUSDT", direction: "LONG" })
    ).rejects.toBeInstanceOf(CanaryAuthorizationAlreadyActiveError);
  });

  it("only expiry or explicit revocation releases the exclusivity", async () => {
    const { profileId, window } = await exhaust();
    // Revocation is one of the two doors.
    expect(await service().revokeNaturalWindow(profileId, window.id)).toBe(true);
    const replacement = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["SHORT"],
      maxClaims: 1,
    });
    expect(replacement.claimedCount).toBe(0);

    // Expiry is the other.
    await prisma!.executionCanaryAuthorization.update({
      where: { id: replacement.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const third = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims: 1,
    });
    expect(third.id).not.toBe(replacement.id);
  });

  it("revocation records revokedAt without moving version, and that is sufficient", async () => {
    // Documented, not changed. `revokeNaturalWindow` sets only `revokedAt`, and
    // the claim predicate independently requires `revokedAt: null` — so a
    // revoked row cannot be claimed even by a holder of the pre-revocation
    // version. A version bump would be symmetry, not safety.
    const profileId = await newProfile();
    const window = await service().prepareNaturalWindow({
      executionProfileId: profileId,
      allowedDirections: ["LONG"],
      maxClaims: 3,
    });
    const staleVersion = window.version;

    await service().revokeNaturalWindow(profileId, window.id);
    const after = await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } });
    expect(after.version).toBe(staleVersion);
    expect(after.revokedAt).not.toBeNull();

    const result = await claimNaturalWindow(prisma!, {
      authorizationId: window.id,
      expectedVersion: staleVersion,
      direction: "LONG",
      evaluatedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe("REVOKED");
    expect(
      (await prisma!.executionCanaryAuthorization.findUniqueOrThrow({ where: { id: window.id } })).claimedCount
    ).toBe(0);
  });
});
