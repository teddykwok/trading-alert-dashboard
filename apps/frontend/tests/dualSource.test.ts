import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { presentNativeScanner, presentTradingViewSource, type SignalSourcesStatusDto } from "../src/api/signalSources.api";
import { DIRECTIONAL_FILTER_LABEL, SOURCE_FILTER_OPTIONS } from "../src/components/alerts/AlertFilters";
import { NATIVE_AI_NOT_APPLICABLE } from "../src/components/alerts/AiOpinionPanel";
import { TRADINGVIEW_BADGE_TITLE } from "../src/components/alerts/SourceBadge";
import { NATIVE_SCREENSHOT_NOT_APPLICABLE, screenshotPlaceholderMessage } from "../src/components/charts/ScreenshotPreview";
import { matchesFilters } from "../src/features/alerts/alertFilterMatch";
import {
  NATIVE_EXECUTION_DISABLED,
  NATIVE_PIPELINE_NOT_APPLICABLE,
  SOURCE_KIND_DESCRIPTION,
  nativeDeliveryOf,
  signalPathRows,
  sourceKindOf,
} from "../src/features/alerts/signalPath";
import { DIRECTIONAL_SIGNALS, canonicalFilterSearch, parseFiltersFromSearch } from "../src/hooks/useFilters";
import { NATIVE_ALERT_BADGE_LABEL, nativeProfileOf } from "../src/utils/alertSource";
import type { Alert } from "../src/types/alert";

/**
 * TradingView and Native in ONE dashboard, never confused. Pure functions and
 * source checks (no DOM environment). The Native fixture is an isolated
 * equivalent of the ALICEUSDT NATIVE_DELIVERY_V2 smoke alerts — it never reads
 * or touches the real rows.
 */

const ENGINE = "3e21f1c15207b03b91315767a4b54c92b0e6a21da33149c02c4ec0ee7c903998";
const src = (rel: string) => readFileSync(path.join(process.cwd(), "src", rel), "utf8");
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function base(over: Partial<Alert>): Alert {
  return {
    id: "a", assetId: null, symbol: "BTCUSDT", assetType: "CRYPTO", exchange: "BINANCE", timeframe: "15m", price: 1, signal: "LONG",
    indicatorName: null, indicatorValue: null, rawPayload: {}, status: "RECEIVED", screenshotUrl: null, aiBias: null, aiConfidence: null,
    aiPattern: null, aiSummary: null, aiRiskNotes: null, aiProvider: null, eventType: "LEVEL_TOUCHED", levelColor: "GREEN", sourceTimeframe: "1D",
    touchDirection: "FROM_ABOVE", alertContext: null, duplicateCount: 0, lastDuplicateAt: null, errorMessage: null,
    triggeredAt: "2026-10-03T10:00:00.000Z", createdAt: "2026-10-03T10:00:01.000Z", updatedAt: "2026-10-03T10:00:01.000Z",
    ...over,
  } as Alert;
}

const native = (sourceTimeframe: "1W" | "1M") =>
  base({
    id: `native-${sourceTimeframe}`, symbol: "ALICEUSDT", source: "NATIVE", signal: "LONG", levelColor: "GREEN", sourceTimeframe, indicatorName: "Native Level Scanner",
    alertContext: { eventType: "LEVEL_TOUCHED", levelColor: "GREEN", sourceTimeframe, touchDirection: "FROM_ABOVE", levelPrice: 0.1, chartTf: "15m" } as never,
    rawPayload: {
      schema: "teddy.native-alerts.alert-payload.v2", source: "NATIVE", actionable: false,
      delivery: { policyVersion: "NATIVE_DELIVERY_V2", deliveryKey: "k".repeat(64), evidenceClass: "PROVEN_INTRABAR_POSSIBLE", sourceTimeframe, tradingViewEquivalenceClaimed: false },
      profile: {
        profileId: "TEDDY_AGGRESSIVE_V1", profileLabel: "Teddy Aggressive", runId: "20261003T063843Z-c877ccf5", engineFingerprint: ENGINE,
        engineSourceTimeframes: ["1D", "1W", "1M", "3M", "6M", "12M"], dashboardSourceTimeframes: ["1D", "1W", "1M"], futureExecutionSourceTimeframes: ["1D", "1W"],
        nativeExecutionEnabled: false, universeTargetEligible: 50,
      },
    },
  });
const tradingView = (over: Partial<Alert> = {}) =>
  base({ id: "tv", source: "TRADINGVIEW", indicatorName: "Teddy", alertContext: { eventType: "LEVEL_TOUCHED", levelColor: "GREEN", sourceTimeframe: "1D" } as never, ...over });
const legacy = () => {
  const a = tradingView({ id: "legacy" });
  delete (a as { source?: unknown }).source;
  return a;
};
const watch = (source: "NATIVE" | "TRADINGVIEW") => base({ id: `watch-${source}`, source, signal: "WATCH" });

describe("source filter", () => {
  const all = [native("1W"), native("1M"), tradingView(), legacy(), watch("NATIVE"), watch("TRADINGVIEW")];
  const ids = (filters: Parameters<typeof matchesFilters>[1]) => all.filter((a) => matchesFilters(a, filters)).map((a) => a.id);

  it("offers exactly All sources / TradingView / Native", () => {
    expect(SOURCE_FILTER_OPTIONS).toEqual([
      { value: "", label: "All sources" },
      { value: "TRADINGVIEW", label: "TradingView" },
      { value: "NATIVE", label: "Native" },
    ]);
  });

  it("All shows both sources; TradingView shows TradingView only (legacy rows count as TradingView); Native shows Native only", () => {
    expect(ids({})).toEqual(["native-1W", "native-1M", "tv", "legacy", "watch-NATIVE", "watch-TRADINGVIEW"]);
    expect(ids({ source: "TRADINGVIEW" })).toEqual(["tv", "legacy", "watch-TRADINGVIEW"]);
    expect(ids({ source: "NATIVE" })).toEqual(["native-1W", "native-1M", "watch-NATIVE"]);
  });

  it("composes with — and never reinterprets — the signal-direction filter", () => {
    expect(ids({ source: "NATIVE", signals: ["LONG", "SHORT"] })).toEqual(["native-1W", "native-1M"]);
    expect(ids({ source: "TRADINGVIEW", signals: ["WATCH"] })).toEqual(["watch-TRADINGVIEW"]);
    expect(ids({ signals: ["LONG", "SHORT"] })).toEqual(["native-1W", "native-1M", "tv", "legacy"]);
    expect([...DIRECTIONAL_SIGNALS]).toEqual(["LONG", "SHORT"]);
    expect(DIRECTIONAL_FILTER_LABEL).toBe("Long + Short only");
    expect(src("components/alerts/AlertFilters.tsx")).not.toContain("Actionable only");
  });

  it("switching the source filter never alters the data", () => {
    const snapshot = JSON.stringify(all);
    for (const source of [undefined, "TRADINGVIEW", "NATIVE"] as const) all.filter((a) => matchesFilters(a, { source }));
    expect(JSON.stringify(all)).toBe(snapshot);
  });

  it("lives in the URL like every other filter; the default view stays clean; junk is ignored", () => {
    expect(parseFiltersFromSearch(new URLSearchParams("source=NATIVE")).source).toBe("NATIVE");
    expect(parseFiltersFromSearch(new URLSearchParams("source=TRADINGVIEW")).source).toBe("TRADINGVIEW");
    expect(parseFiltersFromSearch(new URLSearchParams("source=ALL")).source).toBeUndefined();
    expect(parseFiltersFromSearch(new URLSearchParams("source=native")).source).toBeUndefined();
    expect(canonicalFilterSearch(parseFiltersFromSearch(new URLSearchParams("")))).toBe("");
    expect(canonicalFilterSearch({ signals: ["LONG", "SHORT"], source: "NATIVE" })).toBe("source=NATIVE");
    // The default direction view is unchanged by adding a source.
    expect(parseFiltersFromSearch(new URLSearchParams("source=NATIVE")).signals).toEqual(["LONG", "SHORT"]);
  });

  it("the dashboard applies the shared matcher to live socket inserts too", () => {
    const dashboard = code("pages/DashboardPage.tsx");
    expect(dashboard).toContain('import { matchesFilters } from "../features/alerts/alertFilterMatch";');
    expect(dashboard).not.toMatch(/function matchesFilters/);
  });
});

describe("source identity and signal path", () => {
  it("every alert names its source; legacy rows are TradingView", () => {
    expect([sourceKindOf(native("1W")), sourceKindOf(tradingView()), sourceKindOf(legacy())]).toEqual(["NATIVE", "TRADINGVIEW", "TRADINGVIEW"]);
    expect(TRADINGVIEW_BADGE_TITLE).toContain("Actual TradingView webhook delivery");
    expect(NATIVE_ALERT_BADGE_LABEL).toBe("Native");
    for (const rel of ["components/alerts/AlertCard.tsx", "pages/AlertDetailPage.tsx"]) expect(code(rel)).toContain("<SourceBadge alert={alert} />");
  });

  it("a Native alert shows its profile, run, engine, source TF, evidence and the stop before execution — and no TradingView processing", () => {
    for (const tf of ["1W", "1M"] as const) {
      const rows = Object.fromEntries(signalPathRows(native(tf)).map((r) => [r.label, r]));
      expect(rows.Source.detail).toBe(SOURCE_KIND_DESCRIPTION.NATIVE);
      expect(rows.Delivery.value).toBe("NATIVE_DELIVERY_V2");
      expect(rows.Profile.value).toBe("Teddy Aggressive (TEDDY_AGGRESSIVE_V1)");
      expect(rows["Scanner run"].value).toBe("20261003T063843Z-c877ccf5");
      expect(rows["Engine fingerprint"].value).toBe(ENGINE.slice(0, 12));
      expect(rows["Source timeframe"].value).toBe(tf);
      expect(rows.Evidence.value).toBe("PROVEN_INTRABAR_POSSIBLE");
      // PROVEN_INTRABAR_POSSIBLE never reads as "TradingView sent this".
      expect(rows.Evidence.detail).toMatch(/not proof that TradingView sent an alert/);
      expect(rows["Screenshot & AI"].value).toBe(NATIVE_PIPELINE_NOT_APPLICABLE);
      expect(rows.Execution.value).toBe(NATIVE_EXECUTION_DISABLED);
      expect(JSON.stringify(rows)).not.toMatch(/Pending|In progress|Waiting/);
      expect(nativeDeliveryOf(native(tf)).actionable).toBe(false);
    }
  });

  it("a TradingView alert shows its own pipeline and never Native metadata — even if its payload carries a 'profile' key", () => {
    const masquerade = tradingView({ rawPayload: { profile: native("1W").rawPayload && (native("1W").rawPayload as Record<string, unknown>).profile, delivery: { policyVersion: "NATIVE_DELIVERY_V2" } } });
    for (const alert of [tradingView(), masquerade, legacy()]) {
      const labels = signalPathRows(alert).map((r) => r.label);
      expect(labels).toEqual(["Source", "Screenshot", "AI analysis", "Extreme RR plan"]);
      expect(JSON.stringify(signalPathRows(alert))).not.toMatch(/Teddy Aggressive|NATIVE_DELIVERY_V2|Engine fingerprint|Native/);
      expect(nativeProfileOf(alert)).toBeNull();
    }
  });

  it("TradingView processing states are reported as they are", () => {
    const row = (a: Alert, label: string) => signalPathRows(a).find((r) => r.label === label)?.value;
    expect(row(tradingView({ status: "RECEIVED" }), "Screenshot")).toBe("Pending");
    expect(row(tradingView({ screenshotUrl: "/screenshots/x.png", status: "ANALYZED", aiProvider: "openai" }), "Screenshot")).toBe("Captured");
    expect(row(tradingView({ screenshotUrl: "/screenshots/x.png", status: "ANALYZED", aiProvider: "openai" }), "AI analysis")).toBe("Analyzed (openai)");
    expect(row(tradingView({ status: "ANALYZED" }), "Screenshot")).toBe("Expired (retention)");
    expect(row(tradingView({ status: "ANALYZING_WITH_AI" }), "AI analysis")).toBe("In progress");
    expect(row(tradingView({ status: "FAILED" }), "AI analysis")).toBe("Failed");
    expect(row(tradingView({ signal: "WATCH" }), "Extreme RR plan")).toBe("Not applicable (LONG/SHORT only)");
  });
});

describe("screenshot and AI by source", () => {
  it("TradingView keeps its pending/expired/no-screenshot placeholders; a completed screenshot still renders as an image", () => {
    expect(screenshotPlaceholderMessage("RECEIVED", "TRADINGVIEW")).toBe("Screenshot pending…");
    expect(screenshotPlaceholderMessage("ANALYZED", "TRADINGVIEW")).toBe("Screenshot expired");
    expect(screenshotPlaceholderMessage("FAILED", "TRADINGVIEW")).toBe("No screenshot");
    const preview = code("components/charts/ScreenshotPreview.tsx");
    // The placeholder is used ONLY without a URL; with one, the image renders whatever the source.
    expect(preview.indexOf("if (!screenshotUrl) {")).toBeLessThan(preview.indexOf("screenshotPlaceholderMessage(status, source)"));
    expect(preview).toContain("src={resolveScreenshotUrl(screenshotUrl)}");
  });

  it("Native never shows 'Screenshot pending', is never polled, and its AI tab says not applicable", () => {
    for (const status of ["RECEIVED", "ANALYZING_WITH_AI", "ANALYZED"] as const) expect(screenshotPlaceholderMessage(status, "NATIVE")).toBe(NATIVE_SCREENSHOT_NOT_APPLICABLE);
    for (const rel of ["components/charts/ScreenshotPreview.tsx", "components/alerts/AlertCard.tsx"]) expect(code(rel)).not.toMatch(/setInterval|setTimeout|fetch\(/);
    expect(NATIVE_AI_NOT_APPLICABLE).toMatch(/Not applicable/);
    expect(code("components/alerts/AiOpinionPanel.tsx").indexOf("if (isNativeAlert(alert))")).toBeLessThan(code("components/alerts/AiOpinionPanel.tsx").indexOf("Waiting for analysis"));
    const detail = code("pages/AlertDetailPage.tsx");
    // The TradingView processing timeline is not shown for Native alerts, nor its status badge, nor the execution panel.
    expect(detail).toContain("alert.alertContext && !isNativeAlert(alert) && statusTimelineCard");
    expect(detail).toContain("!alert.alertContext && !isNativeAlert(alert) && statusTimelineCard");
    expect(detail).toContain("isNativeAlert(alert) ? null : <StatusBadge status={alert.status} />");
    expect(detail).toMatch(/Execution is disabled for Native scanner alerts, for every source timeframe/);
  });
});

describe("Signal Sources: truthful wording", () => {
  const status = (over: Partial<SignalSourcesStatusDto["native"]> = {}, lastTv: string | null = null): SignalSourcesStatusDto => ({
    generatedAt: "2026-10-03T12:00:00.000Z",
    tradingView: { webhook: "READY", webhookRoute: "/api/webhooks/tradingview", lastReceivedAt: lastTv, lastReceivedSymbol: null },
    native: {
      state: "STOPPED", reason: "", profileId: "TEDDY_AGGRESSIVE_V1", profileLabel: "Teddy Aggressive", runId: "20261003T063843Z-c877ccf5", engineFingerprintPrefix: ENGINE.slice(0, 12),
      targetEligible: 50, acceptedEligible: 50, selected: 50, liveEligible: 0, failed: 0, writtenAt: "2026-10-03T07:28:49.000Z", ageSeconds: 9000,
      freshnessWindowSeconds: 300, lastDeliveredAt: null, lastDeliveredSymbol: null, ...over,
    },
  });

  it("TradingView says 'Webhook ready', never 'connected', and silence is not unhealthy", () => {
    const quiet = presentTradingViewSource(status(), false);
    expect(quiet).toEqual({ webhook: "Webhook ready", tone: "green", last: "No TradingView alert received yet" });
    expect(presentTradingViewSource(status({}, "2026-10-02T09:00:00.000Z"), false).last).toBe("2026-10-02T09:00:00.000Z");
    expect(presentTradingViewSource(null, true).webhook).toBe("Backend unreachable");
    expect(src("api/signalSources.api.ts") + src("components/alerts/SignalSourcesCard.tsx")).not.toMatch(/TradingView connected|"Connected"/);
  });

  it("the Native scanner shows RUNNING only when the backend proved it; a stopped run shows its last accepted count and no live count", () => {
    expect(presentNativeScanner(status())).toMatchObject({ state: "STOPPED", tone: "gray", eligible: "50/50", live: "—", profile: "Teddy Aggressive" });
    expect(presentNativeScanner(status({ state: "RUNNING", liveEligible: 49 }))).toMatchObject({ state: "RUNNING", tone: "green", live: "49" });
    expect(presentNativeScanner(status({ state: "STALE" }))).toMatchObject({ state: "STALE", tone: "yellow", live: "—" });
    expect(presentNativeScanner(status({ profileLabel: null, profileId: null }))).toMatchObject({ profile: "Legacy (explicit flags)" });
    expect(presentNativeScanner(null)).toMatchObject({ state: "UNKNOWN" });
    expect(code("components/alerts/SignalSourcesCard.tsx")).toContain("Native execution is disabled");
  });

  it("the Native profile metadata stays as merged: delivery 1D/1W/1M, future execution 1D/1W, execution never enabled", () => {
    const profile = nativeProfileOf(native("1M"));
    expect(profile?.dashboardSourceTimeframes).toEqual(["1D", "1W", "1M"]);
    expect(profile?.futureExecutionSourceTimeframes).toEqual(["1D", "1W"]);
    expect(profile?.engineFingerprint).toBe(ENGINE);
  });
});
