import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { NATIVE_SCREENSHOT_NOT_APPLICABLE, screenshotPlaceholderMessage } from "../src/components/charts/ScreenshotPreview";
import { matchesFilters } from "../src/features/alerts/alertFilterMatch";
import { NATIVE_EXECUTION_DISABLED, NATIVE_PIPELINE_NOT_APPLICABLE, signalPathRows, sourceKindOf } from "../src/features/alerts/signalPath";
import { insertLiveAlert } from "../src/features/alerts/liveAlerts";
import { nativeProfileOf } from "../src/utils/alertSource";
import type { Alert } from "../src/types/alert";
import type { AlertListQuery } from "../src/types/api";

/**
 * A Native V2 alert pushed LIVE through the canonical `new_alert` socket event
 * joins the dashboard exactly like one loaded over REST: deduplicated by Alert
 * ID, subject to the current source and direction filters, and rendered as
 * Native (dashboard only, no screenshot pending, execution disabled).
 */

const src = (rel: string) => readFileSync(path.join(process.cwd(), "src", rel), "utf8");

function alert(over: Partial<Alert>): Alert {
  return {
    id: "x", assetId: null, symbol: "BTCUSDT", assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 1, signal: "LONG",
    indicatorName: null, indicatorValue: null, rawPayload: {}, status: "RECEIVED", screenshotUrl: null, aiBias: null, aiConfidence: null,
    aiPattern: null, aiSummary: null, aiRiskNotes: null, aiProvider: null, eventType: "LEVEL_TOUCHED", levelColor: "GREEN", sourceTimeframe: "1M",
    touchDirection: "FROM_ABOVE", alertContext: { eventType: "LEVEL_TOUCHED", levelColor: "GREEN", sourceTimeframe: "1M", touchDirection: "FROM_ABOVE", levelPrice: 0.1, chartTimeframe: "15m" } as never,
    duplicateCount: 0, lastDuplicateAt: null, errorMessage: null, triggeredAt: "2026-10-03T12:00:00.000Z", createdAt: "2026-10-03T12:00:01.000Z", updatedAt: "2026-10-03T12:00:01.000Z",
    ...over,
  } as Alert;
}

/** The serialized shape `withAlertContext` pushes for a committed Native V2 alert (isolated fixture, never a real row). */
const liveNative = (id = "cmlivenative000000000000001", signal: Alert["signal"] = "LONG") =>
  alert({
    id, symbol: "ALICEUSDT", source: "NATIVE", signal, indicatorName: "Native Level Scanner",
    rawPayload: {
      schema: "teddy.native-alerts.alert-payload.v2", source: "NATIVE", actionable: false,
      delivery: { policyVersion: "NATIVE_DELIVERY_V2", evidenceClass: "PROVEN_INTRABAR_POSSIBLE", sourceTimeframe: "1M" },
      profile: {
        profileId: "TEDDY_AGGRESSIVE_V1", profileLabel: "Teddy Aggressive", runId: "20261003T063843Z-c877ccf5",
        engineFingerprint: "3e21f1c15207b03b91315767a4b54c92b0e6a21da33149c02c4ec0ee7c903998",
        engineSourceTimeframes: ["1D", "1W", "1M", "3M", "6M", "12M"], dashboardSourceTimeframes: ["1D", "1W", "1M"], futureExecutionSourceTimeframes: ["1D", "1W"],
        nativeExecutionEnabled: false, universeTargetEligible: 50,
      },
    },
  });
const liveTradingView = (id = "cmlivetradingview000000001") => alert({ id, source: "TRADINGVIEW", indicatorName: "Teddy", sourceTimeframe: "1D" });

/** What the dashboard shows: the live insert, then the page's own filter matcher. */
const visibleAfterPush = (rest: Alert[], pushed: Alert, filters: AlertListQuery) => insertLiveAlert(rest, pushed).filter((a) => matchesFilters(a, filters)).map((a) => a.id);

describe("live insert under the source filter", () => {
  const rest = [liveTradingView("cmresttradingview00000001")];
  it("All sources: a live Native alert appears at the top", () => {
    expect(visibleAfterPush(rest, liveNative(), {})).toEqual(["cmlivenative000000000000001", "cmresttradingview00000001"]);
  });
  it("Native: a live Native alert appears", () => {
    expect(visibleAfterPush(rest, liveNative(), { source: "NATIVE" })).toEqual(["cmlivenative000000000000001"]);
  });
  it("TradingView: a live Native alert is NOT shown", () => {
    expect(visibleAfterPush(rest, liveNative(), { source: "TRADINGVIEW" })).toEqual(["cmresttradingview00000001"]);
  });
  it("Native: a live TradingView alert is NOT shown", () => {
    expect(visibleAfterPush([liveNative()], liveTradingView(), { source: "NATIVE" })).toEqual(["cmlivenative000000000000001"]);
  });
  it("source composes with the 'Long + Short only' direction filter, which is not reinterpreted", () => {
    const longShort: AlertListQuery = { signals: ["LONG", "SHORT"] };
    expect(visibleAfterPush([], liveNative("cmlivenative000000000000002", "SHORT"), { ...longShort, source: "NATIVE" })).toEqual(["cmlivenative000000000000002"]);
    expect(visibleAfterPush([], liveNative("cmlivenative000000000000003", "WATCH"), { ...longShort, source: "NATIVE" })).toEqual([]);
    expect(visibleAfterPush([], liveNative("cmlivenative000000000000004", "WATCH"), { signals: ["WATCH"], source: "NATIVE" })).toEqual(["cmlivenative000000000000004"]);
  });
  it("the dashboard filters the live list with the shared matcher", () => {
    expect(src("pages/DashboardPage.tsx")).toContain("alerts.filter((alert) => matchesFilters(alert, filters))");
    expect(src("hooks/useSocketAlerts.ts")).toContain("setAlerts((prev) => insertLiveAlert(prev, alert));");
  });
});

describe("REST / socket race: one card per Alert ID", () => {
  it("REST already holds Alert X, then the socket pushes Alert X: exactly one X", () => {
    const x = liveNative("cmlivenative00000000000000x");
    const rest = [liveTradingView(), x];
    const after = insertLiveAlert(rest, { ...x });
    expect(after.filter((a) => a.id === x.id)).toHaveLength(1);
    expect(after).toHaveLength(2);
  });
  it("a repeated push of the same alert never duplicates it, and other alerts are untouched", () => {
    const x = liveNative("cmlivenative00000000000000y");
    let list = insertLiveAlert([liveTradingView()], x);
    list = insertLiveAlert(list, x);
    list = insertLiveAlert(list, x);
    expect(list.map((a) => a.id)).toEqual(["cmlivenative00000000000000y", "cmlivetradingview000000001"]);
  });
});

describe("a live Native alert renders exactly like a REST-loaded one", () => {
  it("Native badge, dashboard only, source TF, profile, no screenshot pending, no AI wait, execution disabled", () => {
    const pushed = liveNative();
    const fromRest = JSON.parse(JSON.stringify(pushed)) as Alert;
    expect(signalPathRows(pushed)).toEqual(signalPathRows(fromRest));
    expect(sourceKindOf(pushed)).toBe("NATIVE");
    const rows = Object.fromEntries(signalPathRows(pushed).map((r) => [r.label, r.value]));
    expect(rows["Source timeframe"]).toBe("1M");
    expect(rows["Screenshot & AI"]).toBe(NATIVE_PIPELINE_NOT_APPLICABLE);
    expect(rows.Execution).toBe(NATIVE_EXECUTION_DISABLED);
    expect(nativeProfileOf(pushed)?.profileLabel).toBe("Teddy Aggressive");
    expect(screenshotPlaceholderMessage(pushed.status, pushed.source)).toBe(NATIVE_SCREENSHOT_NOT_APPLICABLE);
    expect(JSON.stringify(signalPathRows(pushed))).not.toMatch(/Pending|Waiting|In progress/);
    // The card decides "Dashboard only" from the source alone, whichever way the alert arrived.
    expect(src("components/alerts/AlertCard.tsx")).toContain("{isNativeAlert(alert) ? (");
  });
  it("a live TradingView alert keeps its TradingView pipeline", () => {
    expect(signalPathRows(liveTradingView()).map((r) => r.label)).toEqual(["Source", "Screenshot", "AI analysis", "Extreme RR plan"]);
    expect(screenshotPlaceholderMessage("RECEIVED", "TRADINGVIEW")).toBe("Screenshot pending…");
  });
});
