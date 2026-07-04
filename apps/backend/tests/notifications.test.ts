import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Alert } from "@prisma/client";

/**
 * Telegram behavior is driven by env vars that config/env.ts reads once at
 * import. We toggle process.env and force a fresh import via vi.resetModules()
 * (same pattern as ai-vision-selection.test.ts). socket-events is mocked so
 * these tests don't touch Redis and stay focused on Telegram sends.
 */
vi.mock("../src/modules/notifications/socket-events", () => ({
  emitNewAlert: vi.fn(),
  emitAlertUpdated: vi.fn(),
  emitAlertFailed: vi.fn(),
  emitAlertDuplicate: vi.fn(),
}));

const TELEGRAM_KEYS = [
  "TELEGRAM_NOTIFICATIONS_ENABLED",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_SEND_SCREENSHOT",
  "TELEGRAM_NOTIFY_ON_FAILED",
  "TELEGRAM_MIN_CONFIDENCE",
] as const;

const originalEnv = Object.fromEntries(TELEGRAM_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = global.fetch;

/** Clears all Telegram env keys, then applies overrides (call before loadService). */
function setEnv(overrides: Record<string, string>): void {
  for (const key of TELEGRAM_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
}

const ENABLED = {
  TELEGRAM_NOTIFICATIONS_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_ID: "123456",
};

async function loadService() {
  vi.resetModules();
  return import("../src/modules/notifications/notification.service");
}

function analyzedAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "alert_test_1",
    symbol: "BTCUSDT",
    assetType: "CRYPTO",
    exchange: "BINANCE",
    timeframe: "1h",
    price: 64000,
    signal: "LONG",
    status: "ANALYZED",
    screenshotUrl: null,
    aiBias: "bullish_continuation",
    aiConfidence: 0.72,
    aiProvider: "mock",
    aiSummary: "The chart visually leans bullish.",
    aiRiskNotes: ["Possible fakeout near resistance."],
    errorMessage: null,
    ...overrides,
  } as Alert;
}

function fetchMock() {
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

function lastFetchUrl(): string {
  const calls = fetchMock().mock.calls;
  return String(calls[calls.length - 1][0]);
}

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const key of TELEGRAM_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.resetModules();
  vi.clearAllMocks();
});

describe("notifyAnalyzedAlert", () => {
  it("sends nothing when notifications are disabled (even with token/chat set)", async () => {
    setEnv({ ...ENABLED, TELEGRAM_NOTIFICATIONS_ENABLED: "false" });
    const { notifyAnalyzedAlert } = await loadService();

    await notifyAnalyzedAlert(analyzedAlert());

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("skips safely (no throw, no fetch) when enabled but token/chat id is missing", async () => {
    setEnv({ TELEGRAM_NOTIFICATIONS_ENABLED: "true", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" });
    const { notifyAnalyzedAlert } = await loadService();

    await expect(notifyAnalyzedAlert(analyzedAlert())).resolves.toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sends a text message for an analyzed alert (no screenshot)", async () => {
    setEnv({ ...ENABLED, TELEGRAM_SEND_SCREENSHOT: "false" });
    const { notifyAnalyzedAlert } = await loadService();

    await notifyAnalyzedAlert(analyzedAlert());

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(lastFetchUrl()).toContain("/sendMessage");
  });

  it("skips when aiConfidence is below TELEGRAM_MIN_CONFIDENCE", async () => {
    setEnv({ ...ENABLED, TELEGRAM_MIN_CONFIDENCE: "0.8" });
    const { notifyAnalyzedAlert } = await loadService();

    await notifyAnalyzedAlert(analyzedAlert({ aiConfidence: 0.5 }));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("still notifies when confidence meets the threshold", async () => {
    setEnv({ ...ENABLED, TELEGRAM_SEND_SCREENSHOT: "false", TELEGRAM_MIN_CONFIDENCE: "0.7" });
    const { notifyAnalyzedAlert } = await loadService();

    await notifyAnalyzedAlert(analyzedAlert({ aiConfidence: 0.72 }));

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the Telegram request fails", async () => {
    setEnv({ ...ENABLED, TELEGRAM_SEND_SCREENSHOT: "false" });
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const { notifyAnalyzedAlert } = await loadService();

    await expect(notifyAnalyzedAlert(analyzedAlert())).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalled();
  });

  it("does not notify for a non-ANALYZED alert (defensive duplicate/status guard)", async () => {
    setEnv({ ...ENABLED, TELEGRAM_SEND_SCREENSHOT: "false" });
    const { notifyAnalyzedAlert } = await loadService();

    await notifyAnalyzedAlert(analyzedAlert({ status: "IGNORED_DUPLICATE" }));

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("notifyAnalyzedAlert with screenshot", () => {
  const screenshotDir = path.join(process.cwd(), "src", "storage", "screenshots");
  const alertId = "tg_photo_test";
  const screenshotPath = path.join(screenshotDir, `${alertId}.png`);

  beforeEach(async () => {
    await mkdir(screenshotDir, { recursive: true });
    await writeFile(screenshotPath, Buffer.from("fake-png"));
  });

  afterEach(async () => {
    await rm(screenshotPath, { force: true });
  });

  it("sends a photo when a screenshot exists", async () => {
    setEnv({ ...ENABLED, TELEGRAM_SEND_SCREENSHOT: "true" });
    const { notifyAnalyzedAlert } = await loadService();

    await notifyAnalyzedAlert(analyzedAlert({ id: alertId, screenshotUrl: `/screenshots/${alertId}.png` }));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(lastFetchUrl()).toContain("/sendPhoto");
  });

  it("falls back to a text message when the photo send fails", async () => {
    setEnv({ ...ENABLED, TELEGRAM_SEND_SCREENSHOT: "true" });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad photo" })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" }) as unknown as typeof fetch;
    const { notifyAnalyzedAlert } = await loadService();

    await notifyAnalyzedAlert(analyzedAlert({ id: alertId, screenshotUrl: `/screenshots/${alertId}.png` }));

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(String(fetchMock().mock.calls[0][0])).toContain("/sendPhoto");
    expect(String(fetchMock().mock.calls[1][0])).toContain("/sendMessage");
  });
});

describe("notifyAlertFailed", () => {
  it("does not send Telegram when TELEGRAM_NOTIFY_ON_FAILED is false", async () => {
    setEnv({ ...ENABLED, TELEGRAM_NOTIFY_ON_FAILED: "false" });
    const { notifyAlertFailed } = await loadService();

    await notifyAlertFailed(analyzedAlert({ status: "FAILED", errorMessage: "boom" }));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sends a Telegram message when TELEGRAM_NOTIFY_ON_FAILED is true", async () => {
    setEnv({ ...ENABLED, TELEGRAM_NOTIFY_ON_FAILED: "true" });
    const { notifyAlertFailed } = await loadService();

    await notifyAlertFailed(analyzedAlert({ status: "FAILED", errorMessage: "boom" }));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(lastFetchUrl()).toContain("/sendMessage");
  });
});

describe("notifyNewAlert", () => {
  it("never sends Telegram from the webhook path even when enabled", async () => {
    setEnv({ ...ENABLED });
    const { notifyNewAlert } = await loadService();

    await notifyNewAlert(analyzedAlert({ status: "RECEIVED" }));

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
