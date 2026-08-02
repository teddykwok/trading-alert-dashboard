import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { handleTradingViewWebhook } from "../src/modules/webhook/webhook.service";
import { visionAnalysisQueue } from "../src/modules/jobs/queue";
import { UnauthorizedError, ValidationError } from "../src/utils/errors";

const NEW_ALERT_FIXTURE = {
  id: "alert_1",
  status: "RECEIVED",
  symbol: "BTCUSDT",
  assetType: "CRYPTO",
  signal: "LONG",
  timeframe: "1h",
  indicatorName: "My Custom Indicator",
  price: 64250.5,
  duplicateCount: 0,
};

/**
 * `existingDuplicate` simulates what a real Postgres query would return for
 * `findRecentDuplicate`: a matching alert row, or null when nothing matches
 * within the suppression window.
 */
function createMockPrisma(existingDuplicate: typeof NEW_ALERT_FIXTURE | null = null) {
  const asset = { id: "asset_1", symbol: "BTCUSDT", assetType: "CRYPTO" };

  const update = vi.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Prisma.AlertUpdateInput }) => {
    const base = existingDuplicate?.id === where.id ? existingDuplicate : NEW_ALERT_FIXTURE;
    const incremented = typeof data.duplicateCount === "object" ? base.duplicateCount + 1 : base.duplicateCount;
    return { ...base, duplicateCount: incremented, lastDuplicateAt: new Date() };
  });

  return {
    asset: { upsert: vi.fn().mockResolvedValue(asset) },
    alert: {
      create: vi.fn().mockResolvedValue(NEW_ALERT_FIXTURE),
      findFirst: vi.fn().mockResolvedValue(existingDuplicate),
      update,
    },
  } as unknown as PrismaClient;
}

const validPayload = {
  secret: "test-secret",
  symbol: "BTCUSDT",
  assetType: "crypto",
  timeframe: "1h",
  price: 64250.5,
  signal: "LONG",
  indicatorName: "My Custom Indicator",
  indicatorValue: 87.2,
  triggeredAt: "2026-07-02T10:30:00Z",
  exchange: "BINANCE",
  note: "Bullish reversal zone detected",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleTradingViewWebhook", () => {
  it("creates an alert for a valid payload (first alert)", async () => {
    const prisma = createMockPrisma(null);

    const result = await handleTradingViewWebhook(prisma, validPayload);

    expect(result).toEqual({ id: "alert_1", status: "RECEIVED" });
    expect(prisma.alert.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.asset.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.alert.create).toHaveBeenCalledTimes(1);
    expect(visionAnalysisQueue.add).toHaveBeenCalledTimes(1);
  });

  // The teddy Pine script sends its minimum-movement threshold here in
  // percentage points (15 = 15%); the exact number must reach the database
  // untouched — integers and decimals alike.
  it("stores indicatorValue exactly as received, for integers and decimals", async () => {
    for (const indicatorValue of [15, 12.5]) {
      const prisma = createMockPrisma(null);
      await handleTradingViewWebhook(prisma, { ...validPayload, indicatorValue });
      expect((prisma.alert.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toEqual(
        expect.objectContaining({ indicatorValue })
      );
    }
  });

  it("rejects a webhook whose secret does not match WEBHOOK_SECRET", async () => {
    const prisma = createMockPrisma(null);

    await expect(
      handleTradingViewWebhook(prisma, { ...validPayload, secret: "wrong-secret" })
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prisma.alert.findFirst).not.toHaveBeenCalled();
    expect(prisma.asset.upsert).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload missing required fields", async () => {
    const prisma = createMockPrisma(null);
    const { symbol: _symbol, ...missingSymbol } = validPayload;

    await expect(handleTradingViewWebhook(prisma, missingSymbol)).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.alert.findFirst).not.toHaveBeenCalled();
    expect(prisma.asset.upsert).not.toHaveBeenCalled();
  });

  describe("symbol normalization", () => {
    function createCall(prisma: PrismaClient) {
      return (prisma.alert.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    }

    it("stores the bare symbol and prefix exchange for BINANCE:BTCUSDT when exchange is missing", async () => {
      const prisma = createMockPrisma(null);
      const { exchange: _exchange, ...noExchange } = validPayload;

      await handleTradingViewWebhook(prisma, { ...noExchange, symbol: "BINANCE:BTCUSDT" });

      expect(createCall(prisma).data).toEqual(
        expect.objectContaining({ symbol: "BTCUSDT", exchange: "BINANCE" })
      );
      expect(prisma.asset.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { symbol_assetType: { symbol: "BTCUSDT", assetType: "CRYPTO" } },
        })
      );
    });

    it("uses NASDAQ from the prefix for NASDAQ:AAPL when exchange is missing", async () => {
      const prisma = createMockPrisma(null);
      const { exchange: _exchange, ...noExchange } = validPayload;

      await handleTradingViewWebhook(prisma, {
        ...noExchange,
        symbol: "NASDAQ:AAPL",
        assetType: "stock",
      });

      expect(createCall(prisma).data).toEqual(
        expect.objectContaining({ symbol: "AAPL", exchange: "NASDAQ" })
      );
    });

    it("lets an explicit payload.exchange win over the symbol prefix", async () => {
      const prisma = createMockPrisma(null);

      await handleTradingViewWebhook(prisma, {
        ...validPayload,
        symbol: "COINBASE:BTCUSDT",
        exchange: "BINANCE",
      });

      expect(createCall(prisma).data).toEqual(
        expect.objectContaining({ symbol: "BTCUSDT", exchange: "BINANCE" })
      );
    });

    it("strips the .P perpetual suffix for storage while preserving it in rawPayload", async () => {
      const prisma = createMockPrisma(null);

      await handleTradingViewWebhook(prisma, { ...validPayload, symbol: "BINANCE:GRASSUSDT.P" });

      expect(createCall(prisma).data).toEqual(
        expect.objectContaining({ symbol: "GRASSUSDT", exchange: "BINANCE" })
      );
      expect(createCall(prisma).data.rawPayload).toEqual(
        expect.objectContaining({ symbol: "BINANCE:GRASSUSDT.P" })
      );
    });

    it("preserves the original prefixed symbol inside rawPayload", async () => {
      const prisma = createMockPrisma(null);

      await handleTradingViewWebhook(prisma, { ...validPayload, symbol: "BINANCE:BTCUSDT" });

      expect(createCall(prisma).data.rawPayload).toEqual(
        expect.objectContaining({ symbol: "BINANCE:BTCUSDT" })
      );
    });

    it("rejects an empty symbol", async () => {
      const prisma = createMockPrisma(null);

      await expect(
        handleTradingViewWebhook(prisma, { ...validPayload, symbol: "   " })
      ).rejects.toBeInstanceOf(ValidationError);
      expect(prisma.alert.create).not.toHaveBeenCalled();
    });

    it("rejects a comma-separated multi-symbol paste before any DB write", async () => {
      const prisma = createMockPrisma(null);

      await expect(
        handleTradingViewWebhook(prisma, { ...validPayload, symbol: "BTCUSDT, ETHUSDT, SOLUSDT" })
      ).rejects.toBeInstanceOf(ValidationError);
      expect(prisma.asset.upsert).not.toHaveBeenCalled();
      expect(prisma.alert.create).not.toHaveBeenCalled();
    });

    it("runs duplicate suppression against the normalized symbol", async () => {
      const prisma = createMockPrisma(NEW_ALERT_FIXTURE); // existing bare-symbol alert

      const result = await handleTradingViewWebhook(prisma, {
        ...validPayload,
        symbol: "BINANCE:BTCUSDT", // prefixed re-fire of the same alert
      });

      const lookupArgs = (prisma.alert.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(lookupArgs.where.symbol).toBe("BTCUSDT");
      expect(result.status).toBe("IGNORED_DUPLICATE");
      expect(prisma.alert.create).not.toHaveBeenCalled();
    });
  });

  describe("level context ingestion", () => {
    const TOUCH_NOTE =
      "eventType=LEVEL_TOUCHED | levelColor=RED | sourceTf=12M | touchDirection=FROM_BELOW | levelPrice=0.123 | chartTf=1h | alertTiming=Immediate";

    function createData(prisma: PrismaClient) {
      return (prisma.alert.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    }

    it("stores the parsed source timeframe, color, event type, and direction", async () => {
      const prisma = createMockPrisma(null);

      await handleTradingViewWebhook(prisma, { ...validPayload, note: TOUCH_NOTE });

      expect(createData(prisma)).toEqual(
        expect.objectContaining({
          eventType: "LEVEL_TOUCHED",
          levelColor: "RED",
          sourceTimeframe: "12M",
          touchDirection: "FROM_BELOW",
        })
      );
    });

    it("keeps sourceTimeframe distinct from the chart timeframe field", async () => {
      const prisma = createMockPrisma(null);

      await handleTradingViewWebhook(prisma, { ...validPayload, note: TOUCH_NOTE });

      const data = createData(prisma);
      expect(data.timeframe).toBe("1h"); // chart timeframe from the payload
      expect(data.sourceTimeframe).toBe("12M"); // level origin from the note
    });

    it("preserves the original note verbatim inside rawPayload", async () => {
      const prisma = createMockPrisma(null);

      await handleTradingViewWebhook(prisma, { ...validPayload, note: TOUCH_NOTE });

      expect(createData(prisma).rawPayload).toEqual(expect.objectContaining({ note: TOUCH_NOTE }));
    });

    it("stores null context fields for a free-text note without guessing from the signal", async () => {
      const prisma = createMockPrisma(null);

      await handleTradingViewWebhook(prisma, { ...validPayload, note: "Bullish reversal zone detected" });

      expect(createData(prisma)).toEqual(
        expect.objectContaining({
          eventType: null,
          levelColor: null,
          sourceTimeframe: null,
          touchDirection: null,
        })
      );
    });

    it("stores null context fields when the note is missing", async () => {
      const prisma = createMockPrisma(null);
      const { note: _note, ...noNote } = validPayload;

      await handleTradingViewWebhook(prisma, noNote);

      expect(createData(prisma)).toEqual(
        expect.objectContaining({ eventType: null, sourceTimeframe: null })
      );
    });

    it("still suppresses duplicates identically when the note carries level context", async () => {
      const prisma = createMockPrisma(NEW_ALERT_FIXTURE);

      const result = await handleTradingViewWebhook(prisma, { ...validPayload, note: TOUCH_NOTE });

      expect(result.status).toBe("IGNORED_DUPLICATE");
      expect(prisma.alert.create).not.toHaveBeenCalled();

      // The duplicate lookup must not have gained any level-context fields.
      const lookupWhere = (prisma.alert.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
      expect(Object.keys(lookupWhere).sort()).toEqual(
        ["assetType", "createdAt", "indicatorName", "signal", "symbol", "timeframe"].sort()
      );
    });
  });

  describe("duplicate suppression", () => {
    it("increments duplicateCount instead of creating a new alert when a matching alert exists within the window", async () => {
      const existing = { ...NEW_ALERT_FIXTURE, duplicateCount: 0 };
      const prisma = createMockPrisma(existing);

      const result = await handleTradingViewWebhook(prisma, validPayload);

      expect(result).toEqual({
        id: existing.id,
        status: "IGNORED_DUPLICATE",
        duplicate: true,
        duplicateCount: 1,
      });
      expect(prisma.alert.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: existing.id },
          data: expect.objectContaining({
            duplicateCount: { increment: 1 },
            lastDuplicateAt: expect.any(Date),
          }),
        })
      );
    });

    it("does not create a new alert or touch the asset for a duplicate", async () => {
      const prisma = createMockPrisma(NEW_ALERT_FIXTURE);

      await handleTradingViewWebhook(prisma, validPayload);

      expect(prisma.asset.upsert).not.toHaveBeenCalled();
      expect(prisma.alert.create).not.toHaveBeenCalled();
    });

    it("does not enqueue a vision-analysis job for a duplicate", async () => {
      const prisma = createMockPrisma(NEW_ALERT_FIXTURE);

      await handleTradingViewWebhook(prisma, validPayload);

      expect(visionAnalysisQueue.add).not.toHaveBeenCalled();
    });

    it("creates a new alert when no matching alert exists within the suppression window", async () => {
      const prisma = createMockPrisma(null); // simulates: DB found nothing recent enough

      const result = await handleTradingViewWebhook(prisma, validPayload);

      expect(result).toEqual({ id: "alert_1", status: "RECEIVED" });
      expect(prisma.alert.create).toHaveBeenCalledTimes(1);
      expect(visionAnalysisQueue.add).toHaveBeenCalledTimes(1);

      // The lookup should ask for alerts created within the configured window
      // (60s by default) — confirms the window itself is computed correctly.
      const lookupArgs = (prisma.alert.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const since: Date = lookupArgs.where.createdAt.gte;
      const expectedSince = Date.now() - 60_000;
      expect(Math.abs(since.getTime() - expectedSince)).toBeLessThan(2000);
    });
  });

  describe("extreme RR plan scheduling", () => {
    it("keeps the alert even when plan scheduling fails entirely", async () => {
      // createMockPrisma has NO extremeRRPlan model, so ensurePendingPlan
      // throws internally — the webhook must swallow that, never the alert.
      const prisma = createMockPrisma(null);

      const result = await handleTradingViewWebhook(prisma, validPayload);

      expect(result).toEqual({ id: "alert_1", status: "RECEIVED" });
      expect(prisma.alert.create).toHaveBeenCalledTimes(1);
    });

    it("creates a PENDING plan row for actionable alerts, but not for WATCH", async () => {
      const prisma = createMockPrisma(null);
      const extremeRRPlan = {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "plan_1" }),
      };
      (prisma as unknown as Record<string, unknown>).extremeRRPlan = extremeRRPlan;

      await handleTradingViewWebhook(prisma, validPayload); // signal LONG
      expect(extremeRRPlan.create).toHaveBeenCalledTimes(1);
      expect(extremeRRPlan.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ alertId: "alert_1", status: "PENDING" })
      );

      const prismaWatch = createMockPrisma(null);
      const watchPlan = { findUnique: vi.fn(), create: vi.fn() };
      (prismaWatch as unknown as Record<string, unknown>).extremeRRPlan = watchPlan;

      await handleTradingViewWebhook(prismaWatch, { ...validPayload, signal: "WATCH" });
      expect(watchPlan.create).not.toHaveBeenCalled();
    });
  });
});
