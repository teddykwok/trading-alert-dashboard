import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Alert, PrismaClient } from "@prisma/client";
import {
  EXTREME_RR_LEVERAGE_PRESETS,
  EXTREME_RR_LOOKBACKS,
  buildLeverageAnalysis,
  calculateExtremeCandidate,
  calculateExtremeMoney,
} from "@trading-alert-dashboard/shared";
import {
  ExtremeRRService,
  buildCandidates,
  type StoredCandidate,
} from "../src/modules/extreme-rr/extreme-rr.service";
import { extremeRRSelectionSchema } from "../src/modules/extreme-rr/extreme-rr.schema";
import type { SnapshotCandle } from "../src/modules/market-data/market-data.types";
import { NotFoundError, ValidationError } from "../src/utils/errors";

const CUTOFF = new Date("2026-08-01T12:00:00Z");
const MINUTE = 60_000;

/** Builds `count` sequential 1-minute candles, the LAST closing exactly at the cutoff. */
function makeCandles(
  count: number,
  { high = "190", low = "185" }: { high?: string; low?: string } = {}
): SnapshotCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const closeTimeMs = CUTOFF.getTime() - (count - 1 - i) * MINUTE;
    return { openTimeMs: closeTimeMs - MINUTE, closeTimeMs, high, low };
  });
}

const ALERT_FIXTURE = {
  id: "alert_1",
  signal: "LONG",
  symbol: "BTCUSDT",
  assetType: "CRYPTO",
  exchange: "BINANCE",
  timeframe: "15m",
  price: 188,
  triggeredAt: CUTOFF,
  rawPayload: { symbol: "BINANCE:BTCUSDT.P" },
} as unknown as Alert;

const TEMPLATE_ROW = {
  id: "tpl_1",
  name: "Current $400",
  referenceCapital: "400",
  riskPercent: "1",
  rewardRatio: "1.5",
  isActive: true,
  createdAt: CUTOFF,
  updatedAt: CUTOFF,
};

interface MockOptions {
  alert?: Alert | null;
  existingPlan?: Record<string, unknown> | null;
  activeTemplate?: typeof TEMPLATE_ROW | null;
}

function createMockPrisma(options: MockOptions = {}) {
  const stored: { plan: Record<string, unknown> | null } = {
    plan: options.existingPlan ?? null,
  };

  const extremeRRPlan = {
    findUnique: vi.fn().mockImplementation(async () => stored.plan),
    create: vi.fn().mockImplementation(async ({ data }) => {
      stored.plan = {
        id: "plan_1",
        selectedLookback: 300,
        selectedLeverage: null,
        errorReason: null,
        generatedAt: null,
        createdAt: CUTOFF,
        updatedAt: CUTOFF,
        ...data,
      };
      return stored.plan;
    }),
    upsert: vi.fn().mockImplementation(async ({ create, update }) => {
      stored.plan = stored.plan
        ? { ...stored.plan, ...update, updatedAt: CUTOFF }
        : {
            id: "plan_1",
            selectedLookback: 300,
            selectedLeverage: null,
            generatedAt: null,
            createdAt: CUTOFF,
            updatedAt: CUTOFF,
            ...create,
          };
      return stored.plan;
    }),
    update: vi.fn().mockImplementation(async ({ data }) => {
      stored.plan = { ...(stored.plan ?? {}), ...data, updatedAt: CUTOFF };
      return stored.plan;
    }),
  };

  return {
    prisma: {
      alert: {
        findUnique: vi.fn().mockResolvedValue(options.alert === undefined ? ALERT_FIXTURE : options.alert),
      },
      extremeRRPlan,
      riskTemplate: {
        findFirst: vi
          .fn()
          .mockResolvedValue(options.activeTemplate === undefined ? TEMPLATE_ROW : options.activeTemplate),
      },
    } as unknown as PrismaClient,
    stored,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Candidate calculation
// ---------------------------------------------------------------------------

describe("calculateExtremeCandidate", () => {
  it("LONG 188 / highest high 200 / RR 1.5 -> TP 200, reward 12, risk 8, SL 180", () => {
    const c = calculateExtremeCandidate({
      direction: "LONG",
      entryPrice: "188",
      extremePrice: "200",
      rewardRatio: "1.5",
    });
    expect(c).toMatchObject({
      valid: true,
      extremeType: "HIGHEST_HIGH",
      takeProfit: "200",
      rewardDistance: "12",
      riskDistance: "8",
      stopLoss: "180",
      riskRewardRatio: "1.5",
    });
  });

  it("SHORT 188 / lowest low 180 / RR 1.5 -> TP 180, reward 8, risk 5.333…, SL 193.333…", () => {
    const c = calculateExtremeCandidate({
      direction: "SHORT",
      entryPrice: "188",
      extremePrice: "180",
      rewardRatio: "1.5",
    });
    expect(c.valid).toBe(true);
    expect(c.extremeType).toBe("LOWEST_LOW");
    expect(c.takeProfit).toBe("180");
    expect(c.rewardDistance).toBe("8");
    expect(c.riskDistance!.startsWith("5.33333333")).toBe(true);
    expect(c.stopLoss!.startsWith("193.33333333")).toBe(true);
  });

  it("LONG rejects highestHigh <= entry", () => {
    for (const extreme of ["188", "187.9"]) {
      const c = calculateExtremeCandidate({
        direction: "LONG",
        entryPrice: "188",
        extremePrice: extreme,
        rewardRatio: "1.5",
      });
      expect(c.valid).toBe(false);
      expect(c.invalidReason).toMatch(/not above entry/);
      expect(c.stopLoss).toBeNull();
    }
  });

  it("SHORT rejects lowestLow >= entry", () => {
    for (const extreme of ["188", "188.1"]) {
      const c = calculateExtremeCandidate({
        direction: "SHORT",
        entryPrice: "188",
        extremePrice: extreme,
        rewardRatio: "1.5",
      });
      expect(c.valid).toBe(false);
      expect(c.invalidReason).toMatch(/not below entry/);
    }
  });

  it("validation invariants hold: LONG SL<entry<TP, SHORT TP<entry<SL", () => {
    const long = calculateExtremeCandidate({ direction: "LONG", entryPrice: "188", extremePrice: "200", rewardRatio: "1.5" });
    expect(Number(long.stopLoss)).toBeLessThan(188);
    expect(Number(long.takeProfit)).toBeGreaterThan(188);

    const short = calculateExtremeCandidate({ direction: "SHORT", entryPrice: "188", extremePrice: "180", rewardRatio: "1.5" });
    expect(Number(short.takeProfit)).toBeLessThan(188);
    expect(Number(short.stopLoss)).toBeGreaterThan(188);
  });
});

describe("buildCandidates (direction uses only its own extreme)", () => {
  it("LONG uses the highest HIGH and never the lowest low", () => {
    // Lows dip far below entry; if lows leaked into a LONG plan the numbers would differ.
    const candles = makeCandles(300, { high: "200", low: "10" });
    const [c100] = buildCandidates(candles, "LONG", "188", "1.5", CUTOFF);
    expect(c100.extremeType).toBe("HIGHEST_HIGH");
    expect(c100.extremePrice).toBe("200");
    expect(c100.takeProfit).toBe("200");
    expect(c100.stopLoss).toBe("180"); // derived from RR, not from the low (10)
  });

  it("SHORT uses the lowest LOW and never the highest high", () => {
    const candles = makeCandles(300, { high: "10000", low: "180" });
    const [c100] = buildCandidates(candles, "SHORT", "188", "1.5", CUTOFF);
    expect(c100.extremeType).toBe("LOWEST_LOW");
    expect(c100.extremePrice).toBe("180");
    expect(c100.takeProfit).toBe("180");
    expect(c100.stopLoss!.startsWith("193.33333333")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lookback behavior
// ---------------------------------------------------------------------------

describe("lookback candidates", () => {
  it("computes 50/100/200/300 from trailing subsets of ONE frozen dataset", () => {
    // Newest 100 candles high=210, the 100 before high=220, the 100 before
    // high=230 — and inside the newest 100, the last 50 only reach 205.
    const oldest = makeCandles(300, { high: "230" }).slice(0, 100);
    const middle = makeCandles(300, { high: "220" }).slice(100, 200);
    const newest = makeCandles(300, { high: "210" }).slice(200, 300);
    // Flatten the trailing 50 so the shortest window sees a LOWER extreme.
    const candles = [...oldest, ...middle, ...newest].map((candle, index) =>
      index >= 250 ? { ...candle, high: "205" } : candle
    );

    const [c50, c100, c200, c300] = buildCandidates(candles, "LONG", "188", "1.5", CUTOFF);
    expect(c50).toMatchObject({ requestedCandles: 50, actualCandles: 50, complete: true, extremePrice: "205" });
    expect(c100).toMatchObject({ requestedCandles: 100, actualCandles: 100, complete: true, extremePrice: "210" });
    expect(c200).toMatchObject({ requestedCandles: 200, actualCandles: 200, complete: true, extremePrice: "220" });
    expect(c300).toMatchObject({ requestedCandles: 300, actualCandles: 300, complete: true, extremePrice: "230" });

    // The point of the whole feature: the window length changes the extreme,
    // and therefore the take-profit, on identical data.
    expect(c50.extremePrice).not.toBe(c300.extremePrice);
    expect(c50.takeProfit).not.toBe(c300.takeProfit);
  });

  it("SHORT uses the lowest low, and the window length changes it too", () => {
    const older = makeCandles(300, { low: "80" }).slice(0, 250);
    const newest = makeCandles(300, { low: "95" }).slice(250, 300);
    const [c50, , , c300] = buildCandidates([...older, ...newest], "SHORT", "188", "1.5", CUTOFF);
    expect(c50).toMatchObject({ requestedCandles: 50, extremePrice: "95" });
    expect(c300).toMatchObject({ requestedCandles: 300, extremePrice: "80" });
    expect(c50.takeProfit).not.toBe(c300.takeProfit);
  });

  it("excludes any candle closing after triggeredAt", () => {
    const closed = makeCandles(50, { high: "200" });
    const formingAndLater: SnapshotCandle[] = [
      // Still forming at the cutoff (closes 30s after) with a tempting higher high.
      { openTimeMs: CUTOFF.getTime() - 30_000, closeTimeMs: CUTOFF.getTime() + 30_000, high: "999", low: "1" },
      // Created entirely after the alert.
      { openTimeMs: CUTOFF.getTime() + MINUTE, closeTimeMs: CUTOFF.getTime() + 2 * MINUTE, high: "1000", low: "1" },
    ];
    const [c100] = buildCandidates([...closed, ...formingAndLater], "LONG", "188", "1.5", CUTOFF);
    expect(c100.extremePrice).toBe("200"); // 999/1000 never leak in
    expect(c100.actualCandles).toBe(50);
    expect(new Date(c100.newestCandleCloseTime!).getTime()).toBeLessThanOrEqual(CUTOFF.getTime());
  });

  it("reports fewer-than-requested candle counts honestly", () => {
    const [c50, c100, c200, c300] = buildCandidates(makeCandles(150, { high: "200" }), "LONG", "188", "1.5", CUTOFF);
    expect(c50).toMatchObject({ actualCandles: 50, complete: true });
    expect(c100).toMatchObject({ actualCandles: 100, complete: true });
    expect(c200).toMatchObject({ actualCandles: 150, complete: false });
    expect(c300).toMatchObject({ actualCandles: 150, complete: false });
  });

  it("selection schema accepts only 50/100/200/300 and 5/10/15/20/25", () => {
    // Pinned so the operator-facing vocabulary cannot change silently.
    expect([...EXTREME_RR_LOOKBACKS]).toEqual([50, 100, 200, 300]);
    for (const lookback of EXTREME_RR_LOOKBACKS) {
      expect(extremeRRSelectionSchema.safeParse({ selectedLookback: lookback }).success).toBe(true);
    }
    for (const bad of [49, 51, 150, 250, 301, 400, 0, -50, "300", null]) {
      expect(extremeRRSelectionSchema.safeParse({ selectedLookback: bad }).success).toBe(false);
    }
    for (const leverage of EXTREME_RR_LEVERAGE_PRESETS) {
      expect(extremeRRSelectionSchema.safeParse({ selectedLeverage: leverage }).success).toBe(true);
    }
    for (const bad of [1, 50, 100, "10"]) {
      expect(extremeRRSelectionSchema.safeParse({ selectedLeverage: bad }).success).toBe(false);
    }
    expect(extremeRRSelectionSchema.safeParse({}).success).toBe(false);
  });

  it("client-supplied SL/TP/quantity are stripped, never accepted", () => {
    const parsed = extremeRRSelectionSchema.safeParse({
      selectedLookback: 200,
      stopLoss: "1",
      takeProfit: "9999",
      quantityRaw: "1000000",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ selectedLookback: 200 });
    }
  });
});

// ---------------------------------------------------------------------------
// Risk template snapshot + money
// ---------------------------------------------------------------------------

describe("risk template snapshot and money management", () => {
  const fetcher = vi.fn().mockResolvedValue(makeCandles(300, { high: "200", low: "170" }));

  it("$400 at 1% RR 1.5 -> $4 risk, $6 target, quantity 0.5, planned loss $4 / profit $6", async () => {
    const { prisma } = createMockPrisma();
    const service = new ExtremeRRService(prisma, fetcher);

    const plan = await service.generateForAlert("alert_1");

    expect(plan.status).toBe("READY");
    expect(plan.template).toMatchObject({
      name: "Current $400",
      referenceCapital: "400",
      riskPercent: "1",
      rewardRatio: "1.5",
      riskAmount: "4",
      targetAmount: "6",
    });

    const c300 = plan.candidates.find((c) => c.requestedCandles === 300)!;
    // entry 188, TP 200 (highest high), reward 12, risk 8, SL 180.
    expect(c300).toMatchObject({ stopLoss: "180", takeProfit: "200" });
    // quantity = 4 / 8 = 0.5; loss = 0.5*8 = $4; profit = 0.5*12 = $6.
    expect(c300.money).toMatchObject({
      quantityRaw: "0.5",
      plannedLossRaw: "4",
      plannedProfitRaw: "6",
      positionNotionalRaw: "94", // 0.5 × 188
    });
  });

  it("decimal template values stay exact", () => {
    // riskAmount 3.5, risk distance 0.004086 -> quantity is an exact decimal string.
    const money = calculateExtremeMoney({
      entryPrice: "0.02",
      riskDistance: "0.004086",
      rewardDistance: "0.006129",
      riskAmount: "3.5",
    });
    expect(money.plannedLossRaw).toBe("3.5");
    expect(money.quantityRaw.startsWith("856.5834")).toBe(true);
  });

  it("no active template -> price extremes saved, money marked unavailable", async () => {
    const { prisma } = createMockPrisma({ activeTemplate: null });
    const service = new ExtremeRRService(prisma, fetcher);

    const plan = await service.generateForAlert("alert_1");

    expect(plan.template).toBeNull();
    const c300 = plan.candidates.find((c) => c.requestedCandles === 300)!;
    expect(c300.extremePrice).toBe("200"); // price data still frozen
    expect(c300.takeProfit).toBe("200");
    expect(c300.valid).toBe(false); // SL underivable without a reward ratio
    expect(c300.invalidReason).toMatch(/No active risk template/);
    expect(c300.money).toBeNull();
    // No invented $400 / 1% / 1.5 anywhere.
    expect(JSON.stringify(plan.template)).not.toMatch(/400|1\.5/);
  });

  it("later template changes never mutate an existing plan snapshot", async () => {
    const { prisma, stored } = createMockPrisma();
    const service = new ExtremeRRService(prisma, fetcher);
    await service.generateForAlert("alert_1");

    // The template row changes AFTER generation…
    (prisma.riskTemplate.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...TEMPLATE_ROW,
      referenceCapital: "1000",
      riskPercent: "2",
    });

    // …but the READY plan keeps its frozen snapshot on every read.
    const reread = await service.getForAlert("alert_1");
    expect(reread!.template).toMatchObject({ referenceCapital: "400", riskAmount: "4" });
    expect(stored.plan!.referenceCapital).toBe("400");
  });
});

// ---------------------------------------------------------------------------
// Leverage / margin
// ---------------------------------------------------------------------------

describe("leverage and estimated margin", () => {
  it("quantity and planned PnL are identical across presets; only margin changes", () => {
    // notional $94 (quantity 0.5 × entry 188)
    const analysis = buildLeverageAnalysis("94", "4");
    expect(analysis.options.map((o) => o.leverage)).toEqual([5, 10, 15, 20, 25]);
    const margins = analysis.options.map((o) => o.estimatedInitialMargin);
    expect(margins).toEqual(["18.8", "9.4", "6.266666666666666666666666666666666666667", "4.7", "3.76"]);
    // Quantity/PnL live outside the leverage analysis entirely — margin is the
    // ONLY per-leverage output.
  });

  it("marks presets with margin inside the configured $6–$10 band as preferred", () => {
    const analysis = buildLeverageAnalysis("94", "4");
    const preferred = analysis.options.filter((o) => o.preferred).map((o) => o.leverage);
    expect(preferred).toEqual([10, 15]); // 9.4 and 6.2666… are inside [6, 10]
    expect(analysis.closestToPreferred).toBeNull(); // several match -> no silent pick
  });

  it("suggests only the closest preset when none is preferred", () => {
    // Tiny notional: margins 4, 2, 1.33…, 1, 0.8 — none inside [6, 10].
    const analysis = buildLeverageAnalysis("20", "4");
    expect(analysis.options.some((o) => o.preferred)).toBe(false);
    expect(analysis.closestToPreferred).toBe(5); // margin 4 is closest to the band
  });

  it("warns when estimated margin is at or below the planned loss budget", () => {
    const analysis = buildLeverageAnalysis("94", "4");
    const byLeverage = Object.fromEntries(analysis.options.map((o) => [o.leverage, o]));
    expect(byLeverage[5].marginAtOrBelowRisk).toBe(false); // 18.8 > 4
    expect(byLeverage[25].marginAtOrBelowRisk).toBe(true); // 3.76 <= 4
  });

  it("persists only preset leverages; unknown limits stay explicitly unverified", async () => {
    const fetcher = vi.fn().mockResolvedValue(makeCandles(300, { high: "200" }));
    const { prisma } = createMockPrisma();
    const service = new ExtremeRRService(prisma, fetcher);
    await service.generateForAlert("alert_1");

    const updated = await service.updateSelection("alert_1", { selectedLeverage: 10 });
    expect(updated.selectedLeverage).toBe(10);
    // No verified symbol-limit source exists — the DTO must say so.
    expect(updated.leverageLimitVerified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reliability / lifecycle
// ---------------------------------------------------------------------------

describe("plan lifecycle and reliability", () => {
  it("generation failure records status ERROR and never throws", async () => {
    const failingFetcher = vi.fn().mockRejectedValue(new Error("Binance unreachable"));
    const { prisma } = createMockPrisma();
    const service = new ExtremeRRService(prisma, failingFetcher);

    const plan = await service.generateForAlert("alert_1");
    expect(plan.status).toBe("ERROR");
    expect(plan.errorReason).toMatch(/Binance unreachable/);
  });

  it("only one authoritative plan per alert: regeneration upserts the same row", async () => {
    const fetcher = vi.fn().mockResolvedValue(makeCandles(300, { high: "200" }));
    const { prisma } = createMockPrisma();
    const service = new ExtremeRRService(prisma, fetcher);

    await service.generateForAlert("alert_1"); // READY now
    const again = await service.generateForAlert("alert_1");

    // READY plans are frozen: no second fetch, no second computation.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(again.id).toBe("plan_1");
    expect(prisma.extremeRRPlan.upsert).toHaveBeenCalledTimes(1);
  });

  it("historical generation uses the alert's ORIGINAL triggeredAt as cutoff", async () => {
    const fetcher = vi.fn().mockResolvedValue(makeCandles(300, { high: "200" }));
    const { prisma } = createMockPrisma();
    const service = new ExtremeRRService(prisma, fetcher);

    const plan = await service.generateForAlert("alert_1");
    expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({ id: "alert_1" }), CUTOFF, 300);
    expect(plan.cutoffAt).toBe(CUTOFF.toISOString());
  });

  it("rejects non-directional alerts and missing alerts", async () => {
    const watchAlert = { ...ALERT_FIXTURE, signal: "WATCH" } as Alert;
    const { prisma } = createMockPrisma({ alert: watchAlert });
    const service = new ExtremeRRService(prisma);
    await expect(service.generateForAlert("alert_1")).rejects.toBeInstanceOf(ValidationError);

    const missing = createMockPrisma({ alert: null });
    await expect(new ExtremeRRService(missing.prisma).generateForAlert("nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("getForAlert returns null when no plan exists (pre-feature alerts)", async () => {
    const { prisma } = createMockPrisma({ existingPlan: null });
    const service = new ExtremeRRService(prisma);
    expect(await service.getForAlert("alert_1")).toBeNull();
  });

  it("plan status INVALID when no candidate is valid (e.g. highest high below entry)", async () => {
    const fetcher = vi.fn().mockResolvedValue(makeCandles(300, { high: "150", low: "100" }));
    const { prisma } = createMockPrisma();
    const service = new ExtremeRRService(prisma, fetcher);

    const plan = await service.generateForAlert("alert_1");
    expect(plan.status).toBe("INVALID");
    expect(plan.candidates.every((c) => !c.valid)).toBe(true);
  });
});
