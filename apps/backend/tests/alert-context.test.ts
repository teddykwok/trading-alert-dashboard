import { describe, expect, it } from "vitest";
import { buildAlertContext, withAlertContext } from "../src/modules/alerts/alert-context";

const TOUCH_NOTE =
  "eventType=LEVEL_TOUCHED | levelColor=RED | sourceTf=12M | touchDirection=FROM_BELOW | levelPrice=0.123 | chartTf=1h";

/** Alert row as stored AFTER the structured columns were added. */
const structuredAlert = {
  eventType: "LEVEL_TOUCHED" as const,
  levelColor: "RED" as const,
  sourceTimeframe: "12M",
  touchDirection: "FROM_BELOW" as const,
  timeframe: "1h",
  rawPayload: { note: TOUCH_NOTE },
};

/** Legacy alert row: structured columns null, metadata only in the note. */
const legacyAlert = {
  eventType: null,
  levelColor: null,
  sourceTimeframe: null,
  touchDirection: null,
  timeframe: "30m",
  rawPayload: { note: TOUCH_NOTE },
};

describe("buildAlertContext", () => {
  it("uses the structured columns when present", () => {
    expect(buildAlertContext(structuredAlert)).toEqual({
      eventType: "LEVEL_TOUCHED",
      levelColor: "RED",
      sourceTimeframe: "12M",
      touchDirection: "FROM_BELOW",
      levelPrice: 0.123,
      chartTimeframe: "1h",
    });
  });

  it("falls back to parsing the note for legacy alerts with null columns", () => {
    const context = buildAlertContext(legacyAlert);

    expect(context).not.toBeNull();
    expect(context?.eventType).toBe("LEVEL_TOUCHED");
    expect(context?.levelColor).toBe("RED");
    expect(context?.sourceTimeframe).toBe("12M");
    expect(context?.touchDirection).toBe("FROM_BELOW");
  });

  it("keeps chartTimeframe = Alert.timeframe, distinct from sourceTimeframe", () => {
    // Chart tf in the note says 1h, but the stored chart timeframe is 30m —
    // Alert.timeframe must win, and must never be overwritten by sourceTf.
    const context = buildAlertContext(legacyAlert);

    expect(context?.chartTimeframe).toBe("30m");
    expect(context?.sourceTimeframe).toBe("12M");
    expect(context?.chartTimeframe).not.toBe(context?.sourceTimeframe);
  });

  it("returns null for alerts without any level metadata", () => {
    expect(
      buildAlertContext({
        eventType: null,
        levelColor: null,
        sourceTimeframe: null,
        touchDirection: null,
        timeframe: "1h",
        rawPayload: { note: "Bullish reversal zone detected" },
      })
    ).toBeNull();

    expect(
      buildAlertContext({
        eventType: null,
        levelColor: null,
        sourceTimeframe: null,
        touchDirection: null,
        timeframe: "1h",
        rawPayload: {},
      })
    ).toBeNull();
  });

  it("never throws on a malformed rawPayload", () => {
    for (const rawPayload of [null, "a string", 42, { note: 7 }, []]) {
      expect(() =>
        buildAlertContext({
          eventType: null,
          levelColor: null,
          sourceTimeframe: null,
          touchDirection: null,
          timeframe: "1h",
          rawPayload,
        })
      ).not.toThrow();
    }
  });

  it("ignores an invalid stored sourceTimeframe instead of exposing it", () => {
    const context = buildAlertContext({
      ...structuredAlert,
      sourceTimeframe: "BOGUS",
      rawPayload: {},
    });

    expect(context?.sourceTimeframe).toBeNull();
  });
});

describe("withAlertContext", () => {
  it("attaches alertContext while leaving the alert fields untouched", () => {
    const serialized = withAlertContext({ ...structuredAlert, id: "alert_1" });

    expect(serialized.id).toBe("alert_1");
    expect(serialized.rawPayload).toEqual({ note: TOUCH_NOTE });
    expect(serialized.alertContext?.sourceTimeframe).toBe("12M");
  });

  it("attaches alertContext: null for alerts without metadata", () => {
    const serialized = withAlertContext({ ...legacyAlert, rawPayload: {} });

    expect(serialized.alertContext).toBeNull();
  });
});
