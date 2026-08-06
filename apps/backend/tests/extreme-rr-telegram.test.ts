import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Alert, PrismaClient } from "@prisma/client";
import {
  buildLeverageAnalysis,
  calculateExtremeMoney,
  type ExtremeRRCandidate,
  type ExtremeRRPlanDto,
} from "@trading-alert-dashboard/shared";
import type { AlertMessageContext } from "../src/modules/notifications/extreme-rr-telegram";

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
  "PUBLIC_DASHBOARD_URL",
] as const;
const originalEnv = Object.fromEntries(TELEGRAM_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = global.fetch;

const ENABLED = {
  TELEGRAM_NOTIFICATIONS_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_ID: "123456",
};

/**
 * Applies a deterministic Telegram env. PUBLIC_DASHBOARD_URL always gets an
 * explicit value (a real public URL unless a test overrides it), because
 * config/env.ts loads dotenv — without this, the developer's local .env would
 * decide whether the link section appears.
 */
function setEnv(overrides: Record<string, string> = {}): void {
  for (const key of TELEGRAM_KEYS) delete process.env[key];
  process.env.PUBLIC_DASHBOARD_URL = "https://public.example";
  Object.assign(process.env, overrides);
}

// Every test needs the deterministic baseline, including those that don't
// otherwise touch env.
beforeEach(() => setEnv(ENABLED));

async function loadFormatter() {
  vi.resetModules();
  return import("../src/modules/notifications/extreme-rr-telegram");
}

/**
 * Every test re-resolves the notification module (vi.resetModules + dynamic
 * import) so config/env.ts re-reads the toggled Telegram variables. That module
 * setup is the entire cost here — the tests themselves are deterministic, with
 * no filesystem, timer or network dependence — but under parallel suite load it
 * can exceed the 5s default. The allowance is for setup only.
 */
vi.setConfig({ testTimeout: 20_000 });

async function loadService() {
  vi.resetModules();
  return import("../src/modules/notifications/notification.service");
}

// ---------------------------------------------------------------------------
// Fixtures — the spec's USELESSUSDT LONG example. Money is built through the
// REAL shared engine so numbers stay authoritative and deterministic.
// ---------------------------------------------------------------------------

const ENTRY = "0.04737";
const RISK_AMOUNT = "4";

function money(takeProfit: string, stopLoss: string) {
  const riskDistance = String(Number(ENTRY) - Number(stopLoss) > 0
    ? (Number(ENTRY) * 1e8 - Number(stopLoss) * 1e8) / 1e8
    : (Number(stopLoss) * 1e8 - Number(ENTRY) * 1e8) / 1e8);
  const rewardDistance = String(Math.abs((Number(takeProfit) * 1e8 - Number(ENTRY) * 1e8) / 1e8));
  const base = calculateExtremeMoney({ entryPrice: ENTRY, riskDistance, rewardDistance, riskAmount: RISK_AMOUNT });
  return { ...base, leverage: buildLeverageAnalysis(base.positionNotionalRaw, RISK_AMOUNT) };
}

function candidate(
  lookback: 100 | 200 | 300,
  takeProfit: string,
  stopLoss: string,
  overrides: Partial<ExtremeRRCandidate> = {}
): ExtremeRRCandidate {
  return {
    requestedCandles: lookback,
    actualCandles: lookback,
    complete: true,
    extremeType: "HIGHEST_HIGH",
    extremePrice: takeProfit,
    oldestCandleOpenTime: "2026-08-01T00:00:00.000Z",
    newestCandleCloseTime: "2026-08-05T00:00:00.000Z",
    valid: true,
    invalidReason: null,
    takeProfit,
    stopLoss,
    rewardDistance: "0",
    riskDistance: "0",
    riskRewardRatio: "1.5",
    money: money(takeProfit, stopLoss),
    ...overrides,
  };
}

/**
 * Alert-side context passed to the builders. Defaults mirror a real teddy
 * alert: BINANCE, 15m chart, 1W GREEN level touched from above.
 */
function ctx(overrides: Partial<AlertMessageContext> = {}): AlertMessageContext {
  return {
    symbol: "USELESSUSDT",
    exchange: "BINANCE",
    timeframe: "15m",
    levelContext: {
      eventType: "LEVEL_TOUCHED",
      levelColor: "GREEN",
      sourceTimeframe: "1W",
      touchDirection: "FROM_ABOVE",
      levelPrice: 0.2707,
      chartTimeframe: "15m",
    },
    ...overrides,
  };
}

/**
 * A persisted alert row as the worker hands it to the notifier. Structured
 * level-context columns are populated the way real ingested alerts are, so
 * these tests exercise the shared buildAlertContext path end to end.
 */
function alertRow(overrides: Record<string, unknown> = {}): Alert {
  return {
    id: "alert_tg_1",
    symbol: "USELESSUSDT",
    exchange: "BINANCE",
    timeframe: "15m",
    signal: "LONG",
    status: "ANALYZED",
    eventType: "LEVEL_TOUCHED",
    levelColor: "GREEN",
    sourceTimeframe: "1W",
    touchDirection: "FROM_ABOVE",
    rawPayload: {
      note: "eventType=LEVEL_TOUCHED | levelColor=GREEN | sourceTf=1W | touchDirection=FROM_ABOVE | chartTf=15m",
    },
    ...overrides,
  } as unknown as Alert;
}

function plan(overrides: Partial<ExtremeRRPlanDto> = {}): ExtremeRRPlanDto {
  return {
    id: "plan_tg_1",
    alertId: "alert_tg_1",
    status: "READY",
    direction: "LONG",
    entryBasis: "ALERT_PRICE",
    entryPrice: ENTRY,
    cutoffAt: "2026-08-05T10:00:00.000Z",
    timeframe: "15m",
    template: {
      riskTemplateId: "tpl_1",
      name: "Current $400",
      referenceCapital: "400",
      riskPercent: "1",
      rewardRatio: "1.5",
      riskAmount: RISK_AMOUNT,
      targetAmount: "6",
    },
    candidates: [
      candidate(100, "0.0491", "0.04622"),
      candidate(200, "0.04985", "0.04572"),
      candidate(300, "0.05061", "0.04521"),
    ],
    selectedLookback: 300,
    selectedLeverage: null,
    precision: "UNROUNDED",
    leverageLimitVerified: false,
    errorReason: null,
    generatedAt: "2026-08-05T10:00:05.000Z",
    createdAt: "2026-08-05T10:00:00.000Z",
    updatedAt: "2026-08-05T10:00:05.000Z",
    ...overrides,
  };
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

// ---------------------------------------------------------------------------
// READY message content
// ---------------------------------------------------------------------------

describe("buildExtremeRRReadyMessage content", () => {
  it("LONG uses the green heading; execution info precedes alternatives", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan(), ctx())!;
    const lines = text.split("\n");

    expect(lines[0]).toBe("🟢 LONG — USELESSUSDT");
    const order = [
      "LEVERAGE:",
      "Entry: 0.04737",
      "Stop-loss: 0.04521",
      "Take-profit: 0.05061",
      "Position notional: $",
      "LOOKBACK ALTERNATIVES",
      "Verify leverage support on Binance.",
      "Open Trade Plan:",
    ].map((needle) => text.indexOf(needle));
    expect(order.every((index) => index !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("SHORT uses the red heading", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const short = plan({
      direction: "SHORT",
      candidates: [
        candidate(100, "0.0455", "0.04862", { extremeType: "LOWEST_LOW" }),
        candidate(200, "0.0451", "0.04888", { extremeType: "LOWEST_LOW" }),
        candidate(300, "0.0449", "0.04902", { extremeType: "LOWEST_LOW" }),
      ],
    });
    const text = buildExtremeRRReadyMessage(short, ctx())!;
    expect(text.startsWith("🔴 SHORT — USELESSUSDT")).toBe(true);
    // SHORT TP is the frozen lowest low of the selected (300) candidate.
    expect(text).toContain("Take-profit: 0.0449");
    expect(text).toContain("Stop-loss: 0.04902");
  });

  it("contains no AI summary, confidence or risk-note content", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan(), ctx())!;
    for (const forbidden of ["AI", "confidence", "Confidence", "Risks", "Summary", "analysis"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("links the public dashboard alert URL with trailing slash normalized", async () => {
    setEnv({ ...ENABLED, PUBLIC_DASHBOARD_URL: "https://public.example/" });
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan(), ctx())!;
    expect(text).toContain("Open Trade Plan:\nhttps://public.example/alerts/alert_tg_1");
    expect(text).not.toContain("public.example//alerts");
  });

  it("preserves small prices and formats round prices plainly", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const tiny = plan({
      entryPrice: "0.002034",
      candidates: [
        candidate(100, "0.002286", "0.001866"),
        candidate(200, "0.002286", "0.001866"),
        candidate(300, "0.002286", "0.001866"),
      ],
    });
    const text = buildExtremeRRReadyMessage(tiny, ctx({ symbol: "TACUSDT" }))!;
    expect(text).toContain("Entry: 0.002034");
    expect(text).toContain("Take-profit: 0.002286");

    const round = plan({
      entryPrice: "188",
      candidates: [candidate(100, "200", "180"), candidate(200, "200", "180"), candidate(300, "200", "180")],
    });
    const roundText = buildExtremeRRReadyMessage(round, ctx({ symbol: "BTCUSDT" }))!;
    expect(roundText).toContain("Entry: 188");
    expect(roundText).toContain("Take-profit: 200");
    expect(roundText).toContain("Stop-loss: 180");
  });

  it("never calls fetch (no market data, no recalculation)", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    buildExtremeRRReadyMessage(plan(), ctx());
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Exchange / chart and level-context lines
// ---------------------------------------------------------------------------

describe("exchange, chart and level context lines", () => {
  it("renders both lines for a LONG alert in the required position", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan(), ctx())!;

    expect(text).toContain("Exchange: BINANCE · Chart: 15m");
    expect(text).toContain("Level: 1W GREEN · From above");

    // After the lookback block, before the Binance warning and the link.
    const lines = text.split("\n");
    const lastAlternative = lines.findIndex((l) => l.startsWith("300c →"));
    const exchangeIndex = lines.indexOf("Exchange: BINANCE · Chart: 15m");
    const levelIndex = lines.indexOf("Level: 1W GREEN · From above");
    const warningIndex = lines.indexOf("Verify leverage support on Binance.");
    const linkIndex = lines.indexOf("Open Trade Plan:");

    expect(exchangeIndex).toBe(lastAlternative + 2); // blank separator between
    expect(levelIndex).toBe(exchangeIndex + 1);
    expect(warningIndex).toBeGreaterThan(levelIndex);
    expect(linkIndex).toBeGreaterThan(warningIndex);
  });

  it("renders a SHORT alert's RED level touched from below", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const short = plan({
      direction: "SHORT",
      candidates: [
        candidate(100, "0.0455", "0.04862", { extremeType: "LOWEST_LOW" }),
        candidate(200, "0.0451", "0.04888", { extremeType: "LOWEST_LOW" }),
        candidate(300, "0.0449", "0.04902", { extremeType: "LOWEST_LOW" }),
      ],
    });
    const text = buildExtremeRRReadyMessage(
      short,
      ctx({
        levelContext: {
          eventType: "LEVEL_TOUCHED",
          levelColor: "RED",
          sourceTimeframe: "1D",
          touchDirection: "FROM_BELOW",
          levelPrice: 0.045,
          chartTimeframe: "15m",
        },
      })
    )!;

    expect(text).toContain("Level: 1D RED · From below");
    expect(text).toContain("Exchange: BINANCE · Chart: 15m");
  });

  it("never confuses the level's source timeframe with the chart timeframe", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(
      plan(),
      ctx({
        timeframe: "1h",
        levelContext: {
          eventType: "LEVEL_TOUCHED",
          levelColor: "GREEN",
          sourceTimeframe: "3M",
          touchDirection: "FROM_ABOVE",
          levelPrice: null,
          // A stale/other chartTf in the note must not win over the alert's.
          chartTimeframe: "5m",
        },
      })
    )!;

    expect(text).toContain("Exchange: BINANCE · Chart: 1h");
    expect(text).toContain("Level: 3M GREEN · From above");
    expect(text).not.toContain("Chart: 3M");
    expect(text).not.toContain("Chart: 5m");
    expect(text).not.toContain("Level: 1h");
  });

  it("omits ONLY the level line when level context is missing", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan(), ctx({ levelContext: null }))!;

    expect(text).toContain("Exchange: BINANCE · Chart: 15m");
    expect(text).not.toContain("Level:");
    expect(text).not.toContain("Unknown");
    expect(text).not.toContain("N/A");
  });

  it("omits the level line when the level's timeframe or colour is missing", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const partials = [
      { levelColor: "GREEN", sourceTimeframe: null },
      { levelColor: null, sourceTimeframe: "1W" },
      { levelColor: null, sourceTimeframe: null },
    ] as const;

    for (const partial of partials) {
      const text = buildExtremeRRReadyMessage(
        plan(),
        ctx({
          levelContext: {
            eventType: "LEVEL_TOUCHED",
            touchDirection: "FROM_ABOVE",
            levelPrice: null,
            chartTimeframe: "15m",
            ...partial,
          },
        })
      )!;
      expect(text).not.toContain("Level:");
      expect(text).toContain("Exchange: BINANCE · Chart: 15m");
    }
  });

  it("drops an unknown touch direction instead of printing it", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(
      plan(),
      ctx({
        levelContext: {
          eventType: "LEVEL_TOUCHED",
          levelColor: "GREEN",
          sourceTimeframe: "1W",
          touchDirection: "UNKNOWN",
          levelPrice: null,
          chartTimeframe: "15m",
        },
      })
    )!;

    expect(text).toContain("Level: 1W GREEN");
    expect(text).not.toContain("UNKNOWN");
    expect(text).not.toContain("Level: 1W GREEN ·");
  });

  it("never invents BINANCE when the exchange is absent", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    for (const exchange of [null, undefined, "  "]) {
      const text = buildExtremeRRReadyMessage(plan(), ctx({ exchange }))!;
      expect(text).toContain("Chart: 15m");
      expect(text).not.toContain("Exchange:");
      // "Binance" only remains in the leverage-verification sentence.
      expect(text).not.toContain("BINANCE");
      expect(text).not.toContain("· Chart");
    }
  });

  it("keeps a different exchange verbatim", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan(), ctx({ exchange: "BYBIT" }))!;
    expect(text).toContain("Exchange: BYBIT · Chart: 15m");
  });

  it("produces no dangling separator when the chart timeframe is missing", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan(), ctx({ timeframe: null }))!;

    expect(text).toContain("Exchange: BINANCE");
    expect(text).not.toContain("Chart:");
    expect(text).not.toContain("Exchange: BINANCE ·");
  });

  it("omits the whole context block (and its blank line) when nothing is known", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const bare = buildExtremeRRReadyMessage(
      plan(),
      { symbol: "USELESSUSDT", exchange: null, timeframe: null, levelContext: null }
    )!;

    expect(bare).not.toContain("Exchange:");
    expect(bare).not.toContain("Chart:");
    expect(bare).not.toContain("Level:");
    expect(bare).not.toContain("\n\n\n"); // no doubled blank separator
    expect(bare).toContain("300c → TP 0.05061 · SL 0.04521 ← Selected\n\nVerify leverage support on Binance.");
  });

  it("does not crash on a legacy free-text note (no level metadata)", async () => {
    const { buildAlertContext } = await import("../src/modules/alerts/alert-context");
    const legacy = buildAlertContext({
      eventType: null,
      levelColor: null,
      sourceTimeframe: null,
      touchDirection: null,
      timeframe: "1h",
      rawPayload: { note: "Bullish reversal zone detected!!! ==== |||| " },
    } as unknown as Alert);
    expect(legacy).toBeNull();

    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan(), ctx({ timeframe: "1h", levelContext: legacy }))!;
    expect(text).toContain("Exchange: BINANCE · Chart: 1h");
    expect(text).not.toContain("Level:");
  });

  it("derives the context from a real alert row through the shared parser", async () => {
    setEnv(ENABLED);
    const { notifyExtremeRRPlanOutcome } = await loadService();
    const { prisma } = mockPrisma();

    await notifyExtremeRRPlanOutcome(prisma, plan(), alertRow());

    const body = JSON.parse(String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(body.text).toContain("Exchange: BINANCE · Chart: 15m");
    expect(body.text).toContain("Level: 1W GREEN · From above");
  });

  it("falls back to the note when structured columns are empty (legacy rows)", async () => {
    setEnv(ENABLED);
    const { notifyExtremeRRPlanOutcome } = await loadService();
    const { prisma } = mockPrisma();

    await notifyExtremeRRPlanOutcome(
      prisma,
      plan(),
      alertRow({
        eventType: null,
        levelColor: null,
        sourceTimeframe: null,
        touchDirection: null,
        rawPayload: {
          note: "eventType=LEVEL_TOUCHED | levelColor=RED | sourceTf=6M | touchDirection=FROM_BELOW | chartTf=15m",
        },
      })
    );

    const body = JSON.parse(String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(body.text).toContain("Level: 6M RED · From below");
  });
});

// ---------------------------------------------------------------------------
// Optional PUBLIC_DASHBOARD_URL
// ---------------------------------------------------------------------------

describe("optional PUBLIC_DASHBOARD_URL link section", () => {
  /** Every message must end with real content — never a blank/whitespace line. */
  function expectNoTrailingBlankLine(text: string): void {
    expect(text).toBe(text.trimEnd());
    expect(text.endsWith("\n")).toBe(false);
    const lines = text.split("\n");
    expect(lines[lines.length - 1].trim()).not.toBe("");
  }

  // A genuinely missing value resolves to "" via the schema default and is
  // covered end-to-end in dashboard-url.test.ts (dotenv makes "absent"
  // untestable here without leaking the local .env).
  const OMITTED = [
    ["empty", { PUBLIC_DASHBOARD_URL: "" }],
    ["whitespace only", { PUBLIC_DASHBOARD_URL: "   " }],
    ["localhost", { PUBLIC_DASHBOARD_URL: "http://localhost:5173" }],
    ["127.0.0.1", { PUBLIC_DASHBOARD_URL: "http://127.0.0.1:5173" }],
    ["not an absolute URL", { PUBLIC_DASHBOARD_URL: "my-dashboard" }],
  ] as const;

  for (const [label, override] of OMITTED) {
    it(`omits the whole link section when the URL is ${label} (READY)`, async () => {
      setEnv({ ...ENABLED, ...override });
      const { buildExtremeRRReadyMessage } = await loadFormatter();
      const text = buildExtremeRRReadyMessage(plan(), ctx())!;

      expect(text).not.toContain("Open Trade Plan:");
      expect(text).not.toContain("/alerts/alert_tg_1");
      expect(text.endsWith("Verify leverage support on Binance.")).toBe(true);
      expectNoTrailingBlankLine(text);
    });
  }

  it("keeps the rest of the READY message identical when the link is omitted", async () => {
    setEnv({ ...ENABLED, PUBLIC_DASHBOARD_URL: "" });
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const withoutLink = buildExtremeRRReadyMessage(plan(), ctx())!;

    setEnv({ ...ENABLED, PUBLIC_DASHBOARD_URL: "https://public.example" });
    const { buildExtremeRRReadyMessage: buildWithLink } = await loadFormatter();
    const withLink = buildWithLink(plan(), ctx())!;

    // The only difference is the appended link section.
    expect(withLink).toBe(`${withoutLink}\n\nOpen Trade Plan:\nhttps://public.example/alerts/alert_tg_1`);
    // Everything else survives untouched.
    for (const needle of [
      "🟢 LONG — USELESSUSDT",
      "LEVERAGE: 10x · Estimated isolated margin: $8.77",
      "Entry: 0.04737",
      "Stop-loss: 0.04521",
      "Take-profit: 0.05061",
      "LOOKBACK ALTERNATIVES",
      "300c → TP 0.05061 · SL 0.04521 ← Selected",
      "Verify leverage support on Binance.",
    ]) {
      expect(withoutLink).toContain(needle);
    }
  });

  it("omits the link section for INVALID and ERROR too, with no trailing blank line", async () => {
    setEnv({ ...ENABLED, PUBLIC_DASHBOARD_URL: "http://localhost:5173" });
    const { buildExtremeRRInvalidMessage, buildExtremeRRErrorMessage } = await loadFormatter();

    const invalid = buildExtremeRRInvalidMessage(plan({ status: "INVALID" }), ctx());
    expect(invalid).not.toContain("Open Alert:");
    expect(invalid.startsWith("⚠️ PLAN INVALID — USELESSUSDT")).toBe(true);
    expectNoTrailingBlankLine(invalid);

    const error = buildExtremeRRErrorMessage(plan({ status: "ERROR" }), ctx());
    expect(error).not.toContain("Open Alert:");
    expect(error.endsWith("Reason: Unable to generate the frozen Extreme RR plan.")).toBe(true);
    expectNoTrailingBlankLine(error);
  });

  it("keeps the link section for INVALID and ERROR when a public URL is configured", async () => {
    setEnv({ ...ENABLED, PUBLIC_DASHBOARD_URL: "https://public.example" });
    const { buildExtremeRRInvalidMessage, buildExtremeRRErrorMessage } = await loadFormatter();

    expect(buildExtremeRRInvalidMessage(plan({ status: "INVALID" }), ctx({ symbol: "X" }))).toContain(
      "Open Alert:\nhttps://public.example/alerts/alert_tg_1"
    );
    expect(buildExtremeRRErrorMessage(plan({ status: "ERROR" }), ctx({ symbol: "X" }))).toContain(
      "Open Alert:\nhttps://public.example/alerts/alert_tg_1"
    );
  });

  it("treats a LAN/tailnet host as public (not auto-detected, just not loopback)", async () => {
    setEnv({ ...ENABLED, PUBLIC_DASHBOARD_URL: "http://192.168.1.50:5173" });
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan(), ctx())!;
    expect(text).toContain("Open Trade Plan:\nhttp://192.168.1.50:5173/alerts/alert_tg_1");
  });

  it("READY message still ends correctly with a valid URL (no trailing blank line)", async () => {
    setEnv({ ...ENABLED, PUBLIC_DASHBOARD_URL: "https://public.example//" });
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan(), ctx())!;
    expect(text.endsWith("https://public.example/alerts/alert_tg_1")).toBe(true);
    expectNoTrailingBlankLine(text);
  });
});

// ---------------------------------------------------------------------------
// Lookback alternatives
// ---------------------------------------------------------------------------

describe("lookback alternatives", () => {
  it("shows 100/200/300 in order with the default 300 marked selected", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan(), ctx())!;
    const i100 = text.indexOf("100c → TP 0.0491 · SL 0.04622");
    const i200 = text.indexOf("200c → TP 0.04985 · SL 0.04572");
    const i300 = text.indexOf("300c → TP 0.05061 · SL 0.04521 ← Selected");
    expect(i100).toBeGreaterThan(-1);
    expect(i200).toBeGreaterThan(i100);
    expect(i300).toBeGreaterThan(i200);
    expect(text.match(/← Selected/g)).toHaveLength(1);
  });

  it("respects a persisted selected 100 or 200 for marker AND main values", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan({ selectedLookback: 200 }), ctx())!;
    expect(text).toContain("200c → TP 0.04985 · SL 0.04572 ← Selected");
    expect(text).toContain("Stop-loss: 0.04572");
    expect(text).toContain("Take-profit: 0.04985");

    const text100 = buildExtremeRRReadyMessage(plan({ selectedLookback: 100 }), ctx())!;
    expect(text100).toContain("100c → TP 0.0491 · SL 0.04622 ← Selected");
    expect(text100).toContain("Take-profit: 0.0491");
  });

  it("shows an invalid candidate truthfully without invented prices", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const withInvalid = plan({
      candidates: [
        candidate(100, "0.0491", "0.04622", {
          valid: false,
          invalidReason: "Highest high (0.046) is not above entry (0.04737) — no valid LONG target in this lookback",
          takeProfit: null,
          stopLoss: null,
          money: null,
        }),
        candidate(200, "0.04985", "0.04572"),
        candidate(300, "0.05061", "0.04521"),
      ],
    });
    const text = buildExtremeRRReadyMessage(withInvalid, ctx())!;
    expect(text).toContain("100c → Invalid target");
    expect(text).not.toContain("100c → TP");
  });

  it("reports insufficient candles honestly", async () => {
    const { buildExtremeRRReadyMessage, lookbackLine } = await loadFormatter();
    const short = plan({
      candidates: [
        candidate(100, "0.0491", "0.04622", { actualCandles: 82, complete: false }),
        candidate(200, "0.04985", "0.04572", {
          actualCandles: 0,
          complete: false,
          valid: false,
          invalidReason: "No closed candles available before the alert",
          takeProfit: null,
          stopLoss: null,
          money: null,
        }),
        candidate(300, "0.05061", "0.04521"),
      ],
    });
    const text = buildExtremeRRReadyMessage(short, ctx())!;
    // Valid-but-incomplete keeps honest prices plus the actual count.
    expect(text).toContain("100c → TP 0.0491 · SL 0.04622 (82/100)");
    expect(text).toContain("200c → Insufficient candles (0/200)");
    expect(lookbackLine(short, 200)).toBe("200c → Insufficient candles (0/200)");
  });
});

// ---------------------------------------------------------------------------
// Leverage recommendation
// ---------------------------------------------------------------------------

describe("leverage recommendation", () => {
  it("recommends the single in-range preset ($8.77 at 10x for the spec notional)", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan(), ctx())!;
    expect(text).toContain("LEVERAGE: 10x · Estimated isolated margin: $8.77");
    expect(text).not.toContain("SUGGESTED");
    expect(text).not.toContain("selected ·");
  });

  it("selects the LOWEST leverage when several presets are in range", async () => {
    const { resolveLeverageChoice } = await loadFormatter();
    // Notional 90 -> margins 18 / 9 / 6 / 4.5 / 3.6: both 10x and 15x are in [6,10].
    const analysis = buildLeverageAnalysis("90", RISK_AMOUNT);
    const c = candidate(300, "0.05061", "0.04521");
    c.money = { ...c.money!, positionNotionalRaw: "90", leverage: analysis };
    const choice = resolveLeverageChoice(plan({ candidates: [c] }), c)!;
    expect(choice).toMatchObject({ leverage: 10, kind: "recommended" });
    expect(Number(choice.estimatedMargin)).toBe(9);
  });

  it("suggests the preset closest to $8 when none is in range", async () => {
    const { resolveLeverageChoice, buildExtremeRRReadyMessage } = await loadFormatter();
    // Notional 20 -> margins 4 / 2 / 1.33 / 1 / 0.8: none inside [6,10]; 4 is closest to 8.
    const analysis = buildLeverageAnalysis("20", RISK_AMOUNT);
    const c = candidate(300, "0.05061", "0.04521");
    c.money = { ...c.money!, positionNotionalRaw: "20", leverage: analysis };
    const p = plan({ candidates: [candidate(100, "0.0491", "0.04622"), candidate(200, "0.04985", "0.04572"), c] });
    const choice = resolveLeverageChoice(p, c)!;
    expect(choice).toMatchObject({ leverage: 5, kind: "suggested" });

    const text = buildExtremeRRReadyMessage(p, ctx())!;
    expect(text).toContain("SUGGESTED LEVERAGE: 5x · Estimated isolated margin: $4.00");
  });

  it("persisted selected leverage takes precedence and is labelled", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan({ selectedLeverage: 20 }), ctx())!;
    expect(text).toMatch(/LEVERAGE: 20x selected · Estimated isolated margin: \$\d+\.\d{2}/);
  });

  it("position notional line is identical regardless of leverage", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const notionalLine = (text: string) => text.split("\n").find((l) => l.startsWith("Position notional:"));
    const none = buildExtremeRRReadyMessage(plan(), ctx({ symbol: "X" }))!;
    const at5 = buildExtremeRRReadyMessage(plan({ selectedLeverage: 5 }), ctx({ symbol: "X" }))!;
    const at25 = buildExtremeRRReadyMessage(plan({ selectedLeverage: 25 }), ctx({ symbol: "X" }))!;
    expect(notionalLine(at5)).toBe(notionalLine(none));
    expect(notionalLine(at25)).toBe(notionalLine(none));
  });

  it("always includes the unverified-limit reminder after the execution block", async () => {
    const { buildExtremeRRReadyMessage } = await loadFormatter();
    const text = buildExtremeRRReadyMessage(plan(), ctx())!;
    const reminder = text.indexOf("Verify leverage support on Binance.");
    expect(reminder).toBeGreaterThan(text.indexOf("Position notional:"));
    expect(reminder).toBeLessThan(text.indexOf("Open Trade Plan:"));
  });
});

// ---------------------------------------------------------------------------
// INVALID / ERROR fallbacks
// ---------------------------------------------------------------------------

describe("INVALID and ERROR fallback messages", () => {
  it("builds a concise INVALID message with the candidate reason", async () => {
    const { buildExtremeRRInvalidMessage } = await loadFormatter();
    const invalid = plan({
      status: "INVALID",
      candidates: plan().candidates.map((c) => ({
        ...c,
        valid: false,
        invalidReason: "Highest high (0.046) is not above entry (0.04737) — no valid LONG target in this lookback",
        takeProfit: null,
        stopLoss: null,
        money: null,
      })),
    });
    const text = buildExtremeRRInvalidMessage(invalid, ctx());
    expect(text.startsWith("⚠️ PLAN INVALID — USELESSUSDT")).toBe(true);
    expect(text).toContain("Direction: LONG");
    expect(text).toContain("Reason: Highest high");
    expect(text).toContain("/alerts/alert_tg_1");
  });

  it("builds a generic ERROR message that never leaks internal error detail", async () => {
    const { buildExtremeRRErrorMessage } = await loadFormatter();
    const error = plan({
      status: "ERROR",
      errorReason: "Binance futures klines request failed with status 500: Internal Server Error at fetchWithTimeout (...)",
    });
    const text = buildExtremeRRErrorMessage(error, ctx());
    expect(text.startsWith("❌ PLAN ERROR — USELESSUSDT")).toBe(true);
    expect(text).toContain("Reason: Unable to generate the frozen Extreme RR plan.");
    expect(text).not.toContain("500");
    expect(text).not.toContain("fetchWithTimeout");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle / idempotency (orchestrator)
// ---------------------------------------------------------------------------

interface MockPlanState {
  telegramStatus: string | null;
  telegramNotifiedAt?: Date | null;
  telegramLastError?: string | null;
  selectedLeverage?: unknown;
}

function mockPrisma(initialStatus: string | null = null) {
  const state: MockPlanState = { telegramStatus: initialStatus };
  return {
    prisma: {
      extremeRRPlan: {
        updateMany: vi.fn().mockImplementation(async () => {
          if (state.telegramStatus === null || state.telegramStatus === "FAILED") {
            state.telegramStatus = "SENDING";
            return { count: 1 };
          }
          return { count: 0 };
        }),
        update: vi.fn().mockImplementation(async ({ data }: { data: Partial<MockPlanState> }) => {
          Object.assign(state, data);
          return state;
        }),
      },
    } as unknown as PrismaClient,
    state,
  };
}

describe("notifyExtremeRRPlanOutcome lifecycle", () => {
  it("never sends for a PENDING plan", async () => {
    setEnv(ENABLED);
    const { notifyExtremeRRPlanOutcome } = await loadService();
    const { prisma } = mockPrisma();

    await notifyExtremeRRPlanOutcome(prisma, plan({ status: "PENDING" }), alertRow());

    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.extremeRRPlan.updateMany).not.toHaveBeenCalled();
  });

  it("sends exactly one message for READY and records SENT", async () => {
    setEnv(ENABLED);
    const { notifyExtremeRRPlanOutcome } = await loadService();
    const { prisma, state } = mockPrisma();

    await notifyExtremeRRPlanOutcome(prisma, plan(), alertRow());

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(state.telegramStatus).toBe("SENT");
    expect(state.telegramNotifiedAt).toBeInstanceOf(Date);
  });

  it("a retry after success does not send again (claim fails on SENT)", async () => {
    setEnv(ENABLED);
    const { notifyExtremeRRPlanOutcome } = await loadService();
    const { prisma } = mockPrisma("SENT");

    await notifyExtremeRRPlanOutcome(prisma, plan(), alertRow());

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("concurrent attempts cannot both send (atomic claim)", async () => {
    setEnv(ENABLED);
    const { notifyExtremeRRPlanOutcome } = await loadService();
    const { prisma } = mockPrisma();

    await Promise.all([
      notifyExtremeRRPlanOutcome(prisma, plan(), alertRow()),
      notifyExtremeRRPlanOutcome(prisma, plan(), alertRow()),
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("a Telegram failure records FAILED, throws for READY, and can be retried", async () => {
    setEnv(ENABLED);
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => "bad gateway" }) as unknown as typeof fetch;
    const { notifyExtremeRRPlanOutcome } = await loadService();
    const { prisma, state } = mockPrisma();

    await expect(notifyExtremeRRPlanOutcome(prisma, plan(), alertRow())).rejects.toThrow(/Telegram notification failed/);
    expect(state.telegramStatus).toBe("FAILED");

    // Retry: FAILED is claimable; a now-healthy Telegram succeeds.
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" }) as unknown as typeof fetch;
    await notifyExtremeRRPlanOutcome(prisma, plan(), alertRow());
    expect(state.telegramStatus).toBe("SENT");
  });

  it("INVALID fallback failure is best-effort: recorded, never thrown", async () => {
    setEnv(ENABLED);
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => "down" }) as unknown as typeof fetch;
    const { notifyExtremeRRPlanOutcome } = await loadService();
    const { prisma, state } = mockPrisma();

    await expect(
      notifyExtremeRRPlanOutcome(prisma, plan({ status: "INVALID" }), alertRow())
    ).resolves.toBeUndefined();
    expect(state.telegramStatus).toBe("FAILED");
  });

  it("records SKIPPED without sending when Telegram is not configured", async () => {
    setEnv({ TELEGRAM_NOTIFICATIONS_ENABLED: "false" });
    const { notifyExtremeRRPlanOutcome } = await loadService();
    const { prisma, state } = mockPrisma();

    await notifyExtremeRRPlanOutcome(prisma, plan(), alertRow());

    expect(global.fetch).not.toHaveBeenCalled();
    expect(state.telegramStatus).toBe("SKIPPED");
  });

  it("never persists a leverage recommendation and never leaks secrets", async () => {
    setEnv(ENABLED);
    const { notifyExtremeRRPlanOutcome } = await loadService();
    const { prisma } = mockPrisma();

    await notifyExtremeRRPlanOutcome(prisma, plan(), alertRow());

    const updates = (prisma.extremeRRPlan.update as ReturnType<typeof vi.fn>).mock.calls;
    for (const [args] of updates) {
      expect(args.data).not.toHaveProperty("selectedLeverage");
      expect(args.data).not.toHaveProperty("selectedLookback");
    }
    const body = JSON.parse(String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(body.text).not.toContain("test-token");
    expect(String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("sendMessage");
  });
});
