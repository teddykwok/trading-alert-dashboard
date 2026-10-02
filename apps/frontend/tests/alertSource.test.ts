import { describe, expect, it } from "vitest";

import {
  NATIVE_ALERT_BADGE_LABEL,
  NATIVE_ALERT_BADGE_TITLE,
  NATIVE_ALERT_PLAN_NOTICE,
  isNativeAlert,
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
    expect(NATIVE_ALERT_PLAN_NOTICE).toMatch(/execution are hard-disabled/i);
  });
});
