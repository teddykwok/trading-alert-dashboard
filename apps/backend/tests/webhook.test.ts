import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { handleTradingViewWebhook } from "../src/modules/webhook/webhook.service";
import { UnauthorizedError, ValidationError } from "../src/utils/errors";

function createMockPrisma() {
  const asset = { id: "asset_1", symbol: "BTCUSDT", assetType: "CRYPTO" };
  const alert = {
    id: "alert_1",
    status: "RECEIVED",
    symbol: "BTCUSDT",
    assetType: "CRYPTO",
    signal: "LONG",
    timeframe: "1h",
    price: 64250.5,
  };

  return {
    asset: { upsert: vi.fn().mockResolvedValue(asset) },
    alert: { create: vi.fn().mockResolvedValue(alert) },
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

describe("handleTradingViewWebhook", () => {
  it("creates an alert for a valid payload", async () => {
    const prisma = createMockPrisma();

    const result = await handleTradingViewWebhook(prisma, validPayload);

    expect(result).toEqual({ id: "alert_1", status: "RECEIVED" });
    expect(prisma.asset.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.alert.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a webhook whose secret does not match WEBHOOK_SECRET", async () => {
    const prisma = createMockPrisma();

    await expect(
      handleTradingViewWebhook(prisma, { ...validPayload, secret: "wrong-secret" })
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prisma.asset.upsert).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload missing required fields", async () => {
    const prisma = createMockPrisma();
    const { symbol: _symbol, ...missingSymbol } = validPayload;

    await expect(handleTradingViewWebhook(prisma, missingSymbol)).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.asset.upsert).not.toHaveBeenCalled();
  });
});
