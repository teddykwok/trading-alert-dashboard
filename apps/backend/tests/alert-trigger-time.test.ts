import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";

import { handleTradingViewWebhook } from "../src/modules/webhook/webhook.service";
import { tradingViewWebhookSchema } from "../src/modules/webhook/webhook.schema";
import { parseIsoDateStrict } from "../src/utils/date";
import { ValidationError } from "../src/utils/errors";
import {
  evaluateSafetyAdmission,
  type SafetyEvaluationInput,
} from "../src/modules/execution/safety-engine";

/**
 * Alert freshness is judged from WHEN THE LEVEL WAS TOUCHED.
 *
 * The defect this file pins: Pine stamped `triggeredAt` with `time`, which is
 * the SOURCE CANDLE'S OPENING TIME, not the moment the alert fired. On a 15m
 * chart a level touched at 11:07:24 and delivered at 11:07:25 therefore
 * arrived already claiming to be 7 minutes 24 seconds old, and the 300-second
 * freshness gate refused it as ALERT_STALE — a signal that could not have been
 * fresher.
 *
 * The rule itself was never wrong; it was being fed a timestamp that meant
 * something else. So the fix is at the producer, and what these tests defend is
 * the MEANING of the field rather than any new arithmetic: the age must track
 * the touch, and the candle's opening time must not be able to age a signal.
 *
 * Nothing here reaches Binance, a runtime database or a live order.
 */

// ---------------------------------------------------------------------------
// The user's scenario, in the units the operator described it
// ---------------------------------------------------------------------------

const BAR_OPENED_AT = new Date("2026-08-25T11:00:00.000Z");
const MAX_ALERT_AGE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Freshness, exercised through the real engine
// ---------------------------------------------------------------------------

/**
 * A synthetic admission that passes on every axis except freshness, so a
 * refusal here can only have come from the signal-time rule.
 */
function evaluateFreshness(input: { signalTriggeredAt: Date | null; evaluatedAt: Date }) {
  const evaluation: SafetyEvaluationInput = {
    evaluatedAt: input.evaluatedAt,
    proposed: {
      executionId: "exec-1",
      profileId: "profile-1",
      symbol: "BTCUSDT",
      positionSide: "LONG",
      signalTriggeredAt: input.signalTriggeredAt,
      sourceTimeframe: "1W",
      currentStatus: "PLAN_READY",
      riskBudgetUsd: "1.50",
      actualPlannedLoss: "1.50",
      estimatedInitialMargin: "3.75",
      maximumIsolatedMargin: "5.00",
      estimatedLiquidationPrice: "90.1",
      requiredLiquidationBoundary: "94",
      marginPlanStatus: "READY",
      selectedLeverage: 10,
      hasMarginPlanSnapshot: true,
    },
    policy: {
      killSwitchActive: false,
      globalKillSwitchActive: false,
      profileKillSwitchActive: false,
      policyPresent: true,
      profileEnabled: true,
      environmentMatchesConnector: true,
      expectedPositionMode: "HEDGE",
      expectedMarginType: "ISOLATED",
      maxOpenPositions: 5,
      maxPendingEntries: 5,
      maxTotalActiveTrades: 5,
      maxTotalPlannedRiskUsd: "100.00",
      maxTotalIsolatedMarginUsd: "500.00",
      maxActivePerSymbolSide: 1,
      maxAlertAgeSeconds: MAX_ALERT_AGE_SECONDS,
      softOpenPositionTarget: 5,
      signalFutureToleranceSeconds: 30,
      allowedSymbols: [],
      allowedSourceTimeframes: ["1W", "1M"],
    } as unknown as SafetyEvaluationInput["policy"],
    local: {
      alreadyAdmitted: false,
      openPositionCount: 0,
      pendingEntryCount: 0,
      totalActiveCount: 0,
      activeSymbolSideKeys: [],
      reservedRiskUsd: "0",
      reservedMaximumMarginUsd: "0",
    } as unknown as SafetyEvaluationInput["local"],
    binance: {
      available: true,
      positionMode: "HEDGE",
      assetMode: "SINGLE_ASSET",
      usdtAvailableBalance: "5000.00",
      symbolsWithPosition: [],
      symbolsWithOpenOrder: [],
      snapshotAt: input.evaluatedAt,
    } as unknown as SafetyEvaluationInput["binance"],
    symbolState: {
      available: true,
      exists: true,
      status: "TRADING",
      contractType: "PERPETUAL",
      quoteAsset: "USDT",
      marginAsset: "USDT",
      hasFiltersSnapshot: true,
      hasBracketSnapshot: true,
    } as unknown as SafetyEvaluationInput["symbolState"],
  };
  return evaluateSafetyAdmission(evaluation);
}

const codesOf = (result: ReturnType<typeof evaluateFreshness>) =>
  result.failedChecks.map((check) => check.reasonCode);

/** Seconds after the bar opened, as a Date. */
const afterBarOpen = (seconds: number) => new Date(BAR_OPENED_AT.getTime() + seconds * 1000);

describe("freshness is measured from the touch, not from the candle", () => {
  it("A. a mid-candle touch delivered instantly is FRESH", () => {
    // The exact case the operator described: 15m candle opens 11:00, the level
    // is touched at 11:07:24, the webhook lands at 11:07:25.
    const touchedAt = afterBarOpen(7 * 60 + 24); // 11:07:24
    const receivedAt = afterBarOpen(7 * 60 + 25); // 11:07:25

    const result = evaluateFreshness({ signalTriggeredAt: touchedAt, evaluatedAt: receivedAt });

    expect(result.signalAgeSeconds).toBe(1);
    expect(codesOf(result)).not.toContain("ALERT_STALE");
    expect(result.decision).toBe("PASS");
  });

  it("A2. the SAME delivery judged from the candle's open would have been refused", () => {
    // The regression, stated as the defect rather than as a passing assertion:
    // feeding the bar's opening time is what produced ALERT_STALE for a signal
    // delivered one second after the touch.
    const receivedAt = afterBarOpen(7 * 60 + 25);

    const fromBarOpen = evaluateFreshness({ signalTriggeredAt: BAR_OPENED_AT, evaluatedAt: receivedAt });

    expect(fromBarOpen.signalAgeSeconds).toBe(445);
    expect(codesOf(fromBarOpen)).toContain("ALERT_STALE");
  });

  it("B. a touch late in the SAME candle is still fresh", () => {
    // 11:14:30 on a 15m candle — almost the whole bar has elapsed, and the
    // signal is still one second old.
    const touchedAt = afterBarOpen(14 * 60 + 30);
    const receivedAt = afterBarOpen(14 * 60 + 31);

    const result = evaluateFreshness({ signalTriggeredAt: touchedAt, evaluatedAt: receivedAt });

    expect(result.signalAgeSeconds).toBe(1);
    expect(result.decision).toBe("PASS");
  });

  it("C. a genuinely old event is STILL refused", () => {
    // The gate must keep working. Touched at 11:00, delivered at 11:07: this
    // one really is seven minutes old.
    const result = evaluateFreshness({
      signalTriggeredAt: BAR_OPENED_AT,
      evaluatedAt: afterBarOpen(7 * 60),
    });

    expect(result.signalAgeSeconds).toBe(420);
    expect(codesOf(result)).toContain("ALERT_STALE");
    expect(result.decision).toBe("SKIP");
  });

  it("D. an event 299 seconds old is admitted", () => {
    const result = evaluateFreshness({
      signalTriggeredAt: BAR_OPENED_AT,
      evaluatedAt: new Date(BAR_OPENED_AT.getTime() + 299_000),
    });
    expect(result.signalAgeSeconds).toBe(299);
    expect(result.decision).toBe("PASS");
  });

  it("E. an event 301 seconds old is refused", () => {
    const result = evaluateFreshness({
      signalTriggeredAt: BAR_OPENED_AT,
      evaluatedAt: new Date(BAR_OPENED_AT.getTime() + 301_000),
    });
    expect(result.signalAgeSeconds).toBe(301);
    expect(codesOf(result)).toContain("ALERT_STALE");
  });

  it("F. bar age cannot make a recent touch stale — even a WEEKLY candle", () => {
    // The general statement of the fix. The level may have originated on a bar
    // opened days ago; what matters is when price came back and touched it.
    const weeklyBarOpenedAt = new Date("2026-08-18T00:00:00.000Z");
    const touchedAt = new Date("2026-08-25T11:07:24.000Z");
    const receivedAt = new Date("2026-08-25T11:07:25.000Z");

    expect(receivedAt.getTime() - weeklyBarOpenedAt.getTime()).toBeGreaterThan(
      MAX_ALERT_AGE_SECONDS * 1000
    );

    const result = evaluateFreshness({ signalTriggeredAt: touchedAt, evaluatedAt: receivedAt });
    expect(result.signalAgeSeconds).toBe(1);
    expect(result.decision).toBe("PASS");
  });

  it("H. a missing signal time is still refused, never inferred", () => {
    const result = evaluateFreshness({ signalTriggeredAt: null, evaluatedAt: afterBarOpen(60) });
    expect(codesOf(result)).toContain("SIGNAL_TIME_UNAVAILABLE");
    expect(result.decision).toBe("SKIP");
    expect(result.signalAgeSeconds).toBeNull();
  });

  it("H2. a future timestamp beyond the clock tolerance is still refused", () => {
    // Widening freshness must not open a door for a clock that runs ahead.
    const result = evaluateFreshness({
      signalTriggeredAt: new Date(BAR_OPENED_AT.getTime() + 120_000),
      evaluatedAt: BAR_OPENED_AT,
    });
    expect(codesOf(result)).toContain("SIGNAL_TIME_UNAVAILABLE");
    expect(result.decision).toBe("SKIP");
  });

  it("the 300-second threshold itself is unchanged by this feature", () => {
    // This task fixes what the timestamp MEANS, not how much age is tolerated.
    const at299 = evaluateFreshness({
      signalTriggeredAt: BAR_OPENED_AT,
      evaluatedAt: new Date(BAR_OPENED_AT.getTime() + 299_000),
    });
    const at301 = evaluateFreshness({
      signalTriggeredAt: BAR_OPENED_AT,
      evaluatedAt: new Date(BAR_OPENED_AT.getTime() + 301_000),
    });
    expect(at299.decision).toBe("PASS");
    expect(codesOf(at301)).toContain("ALERT_STALE");
  });
});

// ---------------------------------------------------------------------------
// The contract: what the webhook accepts and stores
// ---------------------------------------------------------------------------

const NEW_ALERT_FIXTURE = {
  id: "alert_1",
  status: "RECEIVED",
  symbol: "BTCUSDT",
  assetType: "CRYPTO",
  signal: "SHORT",
  timeframe: "15m",
  indicatorName: "teddy v5.5",
  price: 64250.5,
  duplicateCount: 0,
};

function createMockPrisma() {
  return {
    asset: { upsert: vi.fn().mockResolvedValue({ id: "asset_1", symbol: "BTCUSDT", assetType: "CRYPTO" }) },
    alert: {
      create: vi.fn().mockResolvedValue(NEW_ALERT_FIXTURE),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(NEW_ALERT_FIXTURE),
    },
  } as unknown as PrismaClient & {
    alert: { create: ReturnType<typeof vi.fn> };
  };
}

const payload = (overrides: Record<string, unknown> = {}) => ({
  secret: "test-secret",
  symbol: "BTCUSDT",
  assetType: "crypto",
  timeframe: "15m",
  price: 64250.5,
  signal: "SHORT",
  indicatorName: "teddy v5.5",
  // The touch, not the candle.
  triggeredAt: "2026-08-25T11:07:24Z",
  barTime: "2026-08-25T11:00:00Z",
  exchange: "BINANCE",
  note: "eventType=LEVEL_TOUCHED | levelColor=RED | sourceTf=1W | touchDirection=FROM_BELOW",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the webhook contract carries both timestamps", () => {
  it("G. accepts barTime instead of discarding it as an unknown field", () => {
    // The schema strips unknown keys, so a field Pine sends but the schema
    // does not declare would vanish silently.
    const parsed = tradingViewWebhookSchema.parse(payload());
    expect(parsed.triggeredAt).toBe("2026-08-25T11:07:24Z");
    expect(parsed.barTime).toBe("2026-08-25T11:00:00Z");
  });

  it("G2. treats barTime as OPTIONAL, so an older Pine build still validates", () => {
    const { barTime: _omitted, ...withoutBarTime } = payload();
    const parsed = tradingViewWebhookSchema.parse(withoutBarTime);
    expect(parsed.barTime).toBeUndefined();
    expect(parsed.triggeredAt).toBe("2026-08-25T11:07:24Z");
  });

  it("G3. persists the TOUCH as triggeredAt and keeps the bar time as context", async () => {
    const prisma = createMockPrisma();

    await handleTradingViewWebhook(prisma, payload());

    const created = (prisma.alert.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    // Freshness reads this column, so it must be the touch.
    expect(created.triggeredAt).toEqual(new Date("2026-08-25T11:07:24Z"));
    // And the candle context survives, in a column that already existed — the
    // raw payload is JSON, so nothing here needs a migration.
    expect((created.rawPayload as { barTime?: string }).barTime).toBe("2026-08-25T11:00:00Z");
  });

  it("G4. never lets the secret ride along into storage", async () => {
    const prisma = createMockPrisma();
    await handleTradingViewWebhook(prisma, payload());
    const created = (prisma.alert.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(JSON.stringify(created.rawPayload)).not.toContain("test-secret");
  });

  it("G5. an alert with no barTime still stores its touch time", async () => {
    const prisma = createMockPrisma();
    const { barTime: _omitted, ...withoutBarTime } = payload();

    await handleTradingViewWebhook(prisma, withoutBarTime);

    const created = (prisma.alert.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(created.triggeredAt).toEqual(new Date("2026-08-25T11:07:24Z"));
  });
});

// ---------------------------------------------------------------------------
// The producer, pinned at the source
// ---------------------------------------------------------------------------

describe("the Pine payload stamps the event, not the bar", () => {
  const pine = readFileSync(
    path.resolve(__dirname, "../../../docs/pine/teddy-v5.5-current.pine"),
    "utf8"
  );

  it("sends timenow as triggeredAt", () => {
    // `timenow` is the wall clock at the moment the alert fires. `time` is the
    // bar's opening time. This one substitution is the entire defect, and the
    // whole backend rule depends on it, so it is pinned where it lives.
    expect(pine).toContain('\'"triggeredAt":"\' + str.format_time(timenow,');
    expect(pine).not.toContain('\'"triggeredAt":"\' + str.format_time(time,');
  });

  it("still sends the bar's opening time, separately", () => {
    expect(pine).toContain('\'"barTime":"\' + str.format_time(time,');
  });

  it("keeps firing the touch alert intrabar, which is what makes timenow the event", () => {
    // "Immediate" uses freq_once_per_bar, so the alert runs in realtime at the
    // touch rather than at the close. If that ever became a bar-close-only
    // script, `timenow` would silently start meaning something else.
    expect(pine).toContain("alert.freq_once_per_bar)");
  });
});

// ---------------------------------------------------------------------------
// An unusable event time must be REFUSED, never replaced
// ---------------------------------------------------------------------------

/**
 * The fail-open this closes: `parseOrNowDate` substituted `new Date()` whenever
 * `triggeredAt` could not be parsed. A malformed timestamp therefore became the
 * current time — and the current time is, by definition, maximally fresh. The
 * one field standing between a garbled payload and a real order was the field
 * that silently repaired itself.
 *
 * Freshness is now judged only on a timestamp the sender actually supplied.
 */
describe("an unusable triggeredAt is refused, not repaired", () => {
  /** Every value that must never be accepted as an event time. */
  const UNUSABLE = [
    ["malformed text", "abc"],
    ["a bare word", "not-a-date"],
    ["epoch milliseconds as a string", "1787627047543"],
    // V8 does NOT reject this: it rolls the impossible day forward to
    // 2026-03-02, so a NaN check alone would accept a date nobody sent.
    ["a day the calendar does not have", "2026-02-30T00:00:00Z"],
    ["an impossible clock time", "2026-13-45T99:99:99Z"],
    ["whitespace", "   "],
  ] as const;

  it("C/D. the strict parser returns null for every unusable value", () => {
    for (const [label, value] of UNUSABLE) {
      expect(parseIsoDateStrict(value), label).toBeNull();
    }
    expect(parseIsoDateStrict(undefined)).toBeNull();
    expect(parseIsoDateStrict(null)).toBeNull();
  });

  it("A. and parses a real supplied timestamp exactly, without shifting it", () => {
    expect(parseIsoDateStrict("2026-08-25T11:07:24Z")).toEqual(new Date("2026-08-25T11:07:24Z"));
    // Date-only stays acceptable: it is unambiguous and simply reads as old.
    expect(parseIsoDateStrict("2026-08-25")).toEqual(new Date("2026-08-25"));
  });

  it("C/D. the webhook REJECTS every unusable value through the real path", async () => {
    for (const [label, value] of UNUSABLE) {
      const prisma = createMockPrisma();
      await expect(
        handleTradingViewWebhook(prisma, payload({ triggeredAt: value })),
        label
      ).rejects.toBeInstanceOf(ValidationError);
      // The decisive assertion: nothing was written, so no synthesized "now"
      // could have reached the database.
      expect((prisma.alert.create as ReturnType<typeof vi.fn>).mock.calls.length, label).toBe(0);
    }
  });

  it("B. a MISSING triggeredAt is refused too", async () => {
    const prisma = createMockPrisma();
    const { triggeredAt: _omitted, ...withoutTrigger } = payload();

    await expect(handleTradingViewWebhook(prisma, withoutTrigger)).rejects.toBeInstanceOf(ValidationError);
    expect((prisma.alert.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("B2. an EMPTY triggeredAt is refused", async () => {
    const prisma = createMockPrisma();
    await expect(handleTradingViewWebhook(prisma, payload({ triggeredAt: "" }))).rejects.toBeInstanceOf(
      ValidationError
    );
    expect((prisma.alert.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("no refusal path ever stores a timestamp near the current time", async () => {
    // Stated as the property rather than as a mechanism: whatever the failure,
    // the outcome must be that nothing was persisted at all.
    for (const value of ["abc", "", "2026-02-30T00:00:00Z"]) {
      const prisma = createMockPrisma();
      await expect(handleTradingViewWebhook(prisma, payload({ triggeredAt: value }))).rejects.toThrow();
      expect((prisma.alert.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    }
  });

  it("H. barTime is NEVER promoted to stand in for a broken triggeredAt", async () => {
    // A recent candle is not evidence that the touch was recent. Supplying a
    // perfectly good barTime must not rescue an unusable event time.
    const prisma = createMockPrisma();

    await expect(
      handleTradingViewWebhook(
        prisma,
        payload({ triggeredAt: "abc", barTime: new Date().toISOString() })
      )
    ).rejects.toBeInstanceOf(ValidationError);
    expect((prisma.alert.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    // And the service never reads barTime for a timestamp decision at all.
    const service = readFileSync(
      path.resolve(__dirname, "../src/modules/webhook/webhook.service.ts"),
      "utf8"
    );
    expect(service).not.toMatch(/triggeredAt:\s*[^,\n]*barTime/);
    expect(service).toContain("parseIsoDateStrict(payload.triggeredAt)");
  });

  it("I. a payload from an older Pine build — no barTime — is still accepted", async () => {
    const prisma = createMockPrisma();
    const { barTime: _omitted, ...withoutBarTime } = payload();

    await handleTradingViewWebhook(prisma, withoutBarTime);

    const created = (prisma.alert.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(created.triggeredAt).toEqual(new Date("2026-08-25T11:07:24Z"));
  });

  it("the webhook no longer reaches the fallback-to-now helper", () => {
    // `parseOrNowDate` still exists for any non-safety caller, but the alert
    // path must not be one: its whole failure mode was looking fresh.
    const service = readFileSync(
      path.resolve(__dirname, "../src/modules/webhook/webhook.service.ts"),
      "utf8"
    );
    expect(service).not.toContain("parseOrNowDate");
    expect(service).not.toContain("new Date()");
  });
});
