import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { presentNativeScanner, type SignalSourcesStatusDto } from "../src/api/signalSources.api";
import { nativeProfileOf } from "../src/utils/alertSource";

/**
 * Teddy 7% All Active needs no dashboard change: the Signal Sources card and
 * the alert detail already read the profile label and the selection from the
 * supervisor status and the Alert payload. An ALL_ACTIVE run has no target
 * count; it is shown as accepted/accepted and never as "Teddy Aggressive".
 */

const native = (over: Partial<SignalSourcesStatusDto["native"]>): SignalSourcesStatusDto => ({
  generatedAt: "2026-10-04T01:00:00.000Z",
  tradingView: { webhook: "READY", webhookRoute: "/api/webhooks/tradingview", lastReceivedAt: null, lastReceivedSymbol: null },
  native: {
    state: "RUNNING", reason: "fresh", profileId: "TEDDY_7_ALL_ACTIVE_V1", profileLabel: "Teddy 7% All Active", runId: "20261004T010000Z-7a11ac71",
    engineFingerprintPrefix: "47d661a531c9", targetEligible: null, acceptedEligible: 471, selected: 471, liveEligible: 465, failed: 0,
    writtenAt: "2026-10-04T01:00:00.000Z", ageSeconds: 5, freshnessWindowSeconds: 300, lastDeliveredAt: null, lastDeliveredSymbol: null,
    ...over,
  },
});

describe("Teddy 7% All Active on the dashboard", () => {
  it("the Signal Sources card names the profile and shows every accepted symbol, with no invented target", () => {
    const shown = presentNativeScanner(native({}));
    expect(shown.profile).toBe("Teddy 7% All Active");
    expect(shown.eligible).toBe("471/471");
    expect(shown.live).toBe("465");
    expect(JSON.stringify(shown)).not.toMatch(/Teddy Aggressive|\/50\b/);
  });

  it("an alert of the profile shows its label and no scanner target row", () => {
    const profile = {
      profileId: "TEDDY_7_ALL_ACTIVE_V1", profileLabel: "Teddy 7% All Active", runId: "20261004T010000Z-7a11ac71", engineFingerprint: "47d661a5".padEnd(64, "0"),
      engineSourceTimeframes: ["1D", "1W", "1M", "3M", "6M", "12M"], dashboardSourceTimeframes: ["1D", "1W", "1M"], futureExecutionSourceTimeframes: ["1D", "1W"],
      nativeExecutionEnabled: false, universeTargetEligible: null,
    };
    const shown = nativeProfileOf({ source: "NATIVE", rawPayload: { profile } });
    expect(shown).toMatchObject({ profileLabel: "Teddy 7% All Active", universeTargetEligible: null, dashboardSourceTimeframes: ["1D", "1W", "1M"] });
    const detail = readFileSync(path.join(process.cwd(), "src", "pages", "AlertDetailPage.tsx"), "utf8");
    expect(detail).toContain("{profile.universeTargetEligible !== null && <Row label=\"Scanner target\"");
    // Still refused as a profile if a payload ever claimed native execution.
    expect(nativeProfileOf({ source: "NATIVE", rawPayload: { profile: { ...profile, nativeExecutionEnabled: true } } })).toBeNull();
  });
});
