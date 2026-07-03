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
});
