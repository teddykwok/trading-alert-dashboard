import { describe, expect, it } from "vitest";

import {
  NATIVE_ALERT_BADGE_LABEL,
  NATIVE_ALERT_BADGE_TITLE,
  NATIVE_ALERT_PLAN_NOTICE,
  NATIVE_FUTURE_EXECUTION_NOTICE,
  isNativeAlert,
  nativeProfileOf,
} from "../src/utils/alertSource";

/**
 * The dashboard's NATIVE distinction. Pure functions only, like the rest of
 * this suite: whether an alert is shown as native is decided here, and the
 * card and detail page only render the answer.
 */
describe("native alert presentation", () => {
  it("only source NATIVE is native; TRADINGVIEW and a pre-column payload (no source) are not", () => {
    expect(isNativeAlert({ source: "NATIVE" })).toBe(true);
    expect(isNativeAlert({ source: "TRADINGVIEW" })).toBe(false);
    expect(isNativeAlert({})).toBe(false);
  });

  it("the badge says Native and never presents the alert as a TradingView or executable one", () => {
    expect(NATIVE_ALERT_BADGE_LABEL).toBe("Native");
    expect(NATIVE_ALERT_BADGE_TITLE).toMatch(/dashboard only/i);
    expect(NATIVE_ALERT_BADGE_TITLE).toMatch(/not a TradingView alert/i);
    expect(NATIVE_ALERT_PLAN_NOTICE).toMatch(/planning only/i);
    expect(NATIVE_ALERT_PLAN_NOTICE).toMatch(/execution is hard-disabled/i);
  });
});

describe("native scanner profile display", () => {
  const profile = {
    profileId: "TEDDY_AGGRESSIVE_V1",
    profileLabel: "Teddy Aggressive",
    runId: "20261001T110000Z-1a2b3c4d",
    engineFingerprint: "a".repeat(64),
    engineSourceTimeframes: ["1D", "1W", "1M", "3M", "6M", "12M"],
    dashboardSourceTimeframes: ["1D", "1W", "1M"],
    futureExecutionSourceTimeframes: ["1D", "1W"],
    nativeExecutionEnabled: false,
    universeTargetEligible: 50,
  };

  it("reads the profile a V2 native alert records; 1M is a delivery TF, never an execution TF", () => {
    const shown = nativeProfileOf({ source: "NATIVE", rawPayload: { profile } });
    expect(shown).toMatchObject({ profileLabel: "Teddy Aggressive", profileId: "TEDDY_AGGRESSIVE_V1", universeTargetEligible: 50 });
    expect(shown?.dashboardSourceTimeframes).toContain("1M");
    expect(shown?.futureExecutionSourceTimeframes).not.toContain("1M");
    expect(NATIVE_FUTURE_EXECUTION_NOTICE).toMatch(/NOT enabled/);
    expect(NATIVE_FUTURE_EXECUTION_NOTICE).toMatch(/hard-disabled for every source timeframe/);
  });

  it("shows nothing for TradingView alerts, V1 native alerts, malformed payloads, or a payload claiming native execution", () => {
    expect(nativeProfileOf({ source: "TRADINGVIEW", rawPayload: { profile } })).toBeNull();
    expect(nativeProfileOf({ source: "NATIVE", rawPayload: { delivery: { policyVersion: "NATIVE_DELIVERY_V1" } } })).toBeNull();
    expect(nativeProfileOf({ source: "NATIVE", rawPayload: { profile: { ...profile, dashboardSourceTimeframes: "1D" } } })).toBeNull();
    expect(nativeProfileOf({ source: "NATIVE", rawPayload: null })).toBeNull();
    expect(nativeProfileOf({ source: "NATIVE", rawPayload: { profile: { ...profile, nativeExecutionEnabled: true } } })).toBeNull();
  });

  it("a profile is never an account: nothing Account A/B-specific is read or shown", () => {
    const shown = nativeProfileOf({ source: "NATIVE", rawPayload: { profile: { ...profile, account: "A" } } });
    expect(Object.keys(shown ?? {})).not.toContain("account");
    expect(JSON.stringify(shown)).not.toMatch(/Account ?[AB]\b/);
  });
});

