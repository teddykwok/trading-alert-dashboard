import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectTestDatabase } from "./helpers/test-database";

/**
 * Phase 11F — the Extreme RR lookback is GLOBAL, against a real Postgres.
 *
 * ## What changed, and why this suite changed with it
 *
 * This file used to prove the durable behaviour of a PER-PROFILE lookback: the
 * save guard re-checking safe state INSIDE the profile advisory lock, the value
 * surviving a fresh service instance, a policy change leaving an already
 * created execution byte-identical.
 *
 * Phase 11E made an ExtremeRRPlan GLOBAL — one plan per alert, adopted
 * independently by every account — which made a per-account input wrong: a
 * window owned by Account A's policy shaped a plan Account B would also trade.
 * Phase 11F moved it to deployment configuration, so there is no per-profile
 * save left to guard.
 *
 * The SAFE_OFF / active-execution / manual-intervention / authorization gates
 * that half this file used to exercise are unchanged and still covered by
 * allowlist-service, policy-editor and source-timeframe-policy — the three
 * controls that still write. Here the save is refused UNCONDITIONALLY, which is
 * strictly stricter than the gates it replaced.
 *
 * What a real database is still needed for is the property 11E created: two
 * profiles holding DIFFERENT legacy values must produce ONE plan whose window
 * came from neither.
 *
 * Every row is synthetic and removed in afterAll. Nothing arms, claims,
 * executes, or contacts an exchange.
 */

const TAG = "rr-lookback-global";

// The GLOBAL window under test. Set BEFORE the dynamic imports: `env` is parsed
// once at module load, and a value assigned afterwards would not be read.
// Deliberately 200 — a SUPPORTED window (the vocabulary is 50/100/200/300)
// matching NEITHER legacy value below, so a plan at 200 came only from here.
process.env.EXTREME_RR_LOOKBACK_CANDLES = "200";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;
const describeDb = available && prisma ? describe : describe.skip;

const { ExtremeRrLookbackService } = await import(
  "../src/modules/operator/extreme-rr-lookback.service"
);
const { ExtremeRRService } = await import("../src/modules/extreme-rr/extreme-rr.service");

describeDb("rr lookback: one global window, whatever the profiles hold", () => {
  let sequence = 0;
  const profileIds: string[] = [];
  const alertIds: string[] = [];

  /** A profile whose LEGACY column holds `legacyLookback`. */
  async function profileWithLegacy(alias: string, legacyLookback: number): Promise<string> {
    sequence += 1;
    const profile = await prisma!.executionProfile.create({
      data: {
        name: `${TAG} ${alias} ${sequence}`,
        accountIdentifier: `${TAG}-${alias}-${sequence}`,
        environment: "TESTNET",
        isEnabled: false,
      },
      select: { id: true },
    });
    await prisma!.executionSafetyPolicy.create({
      data: { executionProfileId: profile.id, extremeRrLookbackCandles: legacyLookback },
    });
    profileIds.push(profile.id);
    return profile.id;
  }

  async function directionalAlert(): Promise<string> {
    sequence += 1;
    const alert = await prisma!.alert.create({
      data: {
        symbol: `RRLB${sequence}USDT`,
        assetType: "CRYPTO",
        exchange: "SYNTHETIC",
        timeframe: "15m",
        price: 100,
        signal: "LONG",
        indicatorName: `${TAG}-${sequence}`,
        rawPayload: { note: TAG },
        triggeredAt: new Date(Date.now() - 60_000),
      },
      select: { id: true },
    });
    alertIds.push(alert.id);
    return alert.id;
  }

  /** PENDING creation only: it chooses the window and reaches no exchange. */
  async function planLookbackFor(alertId: string): Promise<number> {
    const alert = await prisma!.alert.findUniqueOrThrow({ where: { id: alertId } });
    await new ExtremeRRService(prisma!).ensurePendingPlan(alert);
    const plan = await prisma!.extremeRRPlan.findUniqueOrThrow({ where: { alertId } });
    return plan.selectedLookback;
  }

  beforeAll(async () => {
    if (!available) return;
    await prisma!.alert.deleteMany({ where: { indicatorName: { startsWith: TAG } } });
    await prisma!.executionProfile.deleteMany({
      where: { accountIdentifier: { startsWith: TAG } },
    });
  });

  afterAll(async () => {
    if (!available) return;
    await prisma!.alert.deleteMany({ where: { id: { in: alertIds } } });
    await prisma!.executionSafetyPolicy.deleteMany({
      where: { executionProfileId: { in: profileIds } },
    });
    await prisma!.executionProfile.deleteMany({ where: { id: { in: profileIds } } });
    await prisma!.$disconnect();
  });

  it("generates ONE plan at the global window, from neither profile", async () => {
    // The multi-account thought test, durably: A says 300, B says 700, the
    // global window says 200.
    const profileA = await profileWithLegacy("a", 300);
    const profileB = await profileWithLegacy("b", 700);

    const lookback = await planLookbackFor(await directionalAlert());

    expect(lookback).toBe(200);
    expect(lookback).not.toBe(300);
    expect(lookback).not.toBe(700);

    // Both legacy columns are exactly as they were: generation read neither.
    const [a, b] = await Promise.all([
      prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileA } }),
      prisma!.executionSafetyPolicy.findUniqueOrThrow({ where: { executionProfileId: profileB } }),
    ]);
    expect(a.extremeRrLookbackCandles).toBe(300);
    expect(b.extremeRrLookbackCandles).toBe(700);
  });

  it("reports the global window, not a profile's legacy value", async () => {
    await profileWithLegacy("reader", 50);
    const read = await new ExtremeRrLookbackService(prisma!).read();

    expect(read.stored).toBe(200);
    expect(read.effective).toBe(200);
    expect(read.valid).toBe(true);
    expect(read.supported).toEqual([50, 100, 200, 300]);
  });

  it("REFUSES to save, and writes no profile column while refusing", async () => {
    // The failure this prevents: an endpoint reporting success while changing a
    // value nothing reads.
    const profileId = await profileWithLegacy("writer", 300);
    const before = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
      where: { executionProfileId: profileId },
    });

    const result = await new ExtremeRrLookbackService(prisma!).save(100);

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("BLOCKED");
    expect(result.blockers).toEqual(["DEPLOYMENT_OWNED"]);
    expect(result.message).toContain("EXTREME_RR_LOOKBACK_CANDLES");
    expect(result.extremeRrLookbackCandles).toBeNull();

    const after = await prisma!.executionSafetyPolicy.findUniqueOrThrow({
      where: { executionProfileId: profileId },
    });
    expect(after.extremeRrLookbackCandles).toBe(before.extremeRrLookbackCandles);
    expect(after.version).toBe(before.version);
  });

  it("rejects an unsupported value as unsupported, before mentioning ownership", async () => {
    // An operator who typed 150 should be told 150 is not a window, not lectured
    // about deployment configuration.
    const result = await new ExtremeRrLookbackService(prisma!).save(150);
    expect(result.blockers).toEqual(["VALIDATION_REFUSED"]);
    expect(result.message).toContain("50, 100, 200, 300");
  });

  it("a later legacy-column edit still cannot reach plan generation", async () => {
    // The regression that matters most: an operator, a migration or a stray
    // script writing the old column must remain a no-op for planning.
    const profileId = await profileWithLegacy("drifter", 300);
    await prisma!.executionSafetyPolicy.update({
      where: { executionProfileId: profileId },
      data: { extremeRrLookbackCandles: 50 },
    });

    expect(await planLookbackFor(await directionalAlert())).toBe(200);
  });
});
