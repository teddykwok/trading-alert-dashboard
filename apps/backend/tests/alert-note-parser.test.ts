import { describe, expect, it } from "vitest";
import { parseAlertNote, hasLevelMetadata } from "@trading-alert-dashboard/shared";

const EMPTY = {
  eventType: null,
  levelColor: null,
  sourceTimeframe: null,
  touchDirection: null,
  levelPrice: null,
  chartTimeframe: null,
};

describe("parseAlertNote", () => {
  it("parses a complete LEVEL_TOUCHED note", () => {
    const note =
      "eventType=LEVEL_TOUCHED | levelColor=RED | sourceTf=12M | touchDirection=FROM_BELOW | levelPrice=0.123 | chartTf=1h";

    expect(parseAlertNote(note)).toEqual({
      eventType: "LEVEL_TOUCHED",
      levelColor: "RED",
      sourceTimeframe: "12M",
      touchDirection: "FROM_BELOW",
      levelPrice: 0.123,
      chartTimeframe: "1h",
    });
  });

  it("parses a LEVEL_CREATED note (no touchDirection)", () => {
    const note =
      "eventType=LEVEL_CREATED | levelColor=GREEN | sourceTf=1D | levelPrice=64250.5 | chartTf=30m";

    expect(parseAlertNote(note)).toEqual({
      eventType: "LEVEL_CREATED",
      levelColor: "GREEN",
      sourceTimeframe: "1D",
      touchDirection: null,
      levelPrice: 64250.5,
      chartTimeframe: "30m",
    });
  });

  it("tolerates a different key order", () => {
    const note = "chartTf=4h | sourceTf=6M | eventType=LEVEL_TOUCHED | levelColor=GREEN";
    const parsed = parseAlertNote(note);

    expect(parsed.eventType).toBe("LEVEL_TOUCHED");
    expect(parsed.levelColor).toBe("GREEN");
    expect(parsed.sourceTimeframe).toBe("6M");
    expect(parsed.chartTimeframe).toBe("4h");
  });

  it("tolerates extra spaces around separators", () => {
    const note = "  eventType =  LEVEL_TOUCHED |levelColor= RED|  sourceTf = 1W  ";
    const parsed = parseAlertNote(note);

    expect(parsed.eventType).toBe("LEVEL_TOUCHED");
    expect(parsed.levelColor).toBe("RED");
    expect(parsed.sourceTimeframe).toBe("1W");
  });

  it("ignores unknown keys (e.g. alertTiming from the Pine script)", () => {
    const note =
      "eventType=LEVEL_TOUCHED | levelColor=RED | sourceTf=3M | alertTiming=Immediate | somethingNew=42";
    const parsed = parseAlertNote(note);

    expect(parsed.eventType).toBe("LEVEL_TOUCHED");
    expect(parsed.sourceTimeframe).toBe("3M");
  });

  it("returns all-null for a malformed note and never throws", () => {
    expect(parseAlertNote("||| = | = = |")).toEqual(EMPTY);
    expect(parseAlertNote("just|pipes|no=known=keys")).toEqual(EMPTY);
  });

  it("returns all-null for null, undefined, and empty notes", () => {
    expect(parseAlertNote(null)).toEqual(EMPTY);
    expect(parseAlertNote(undefined)).toEqual(EMPTY);
    expect(parseAlertNote("")).toEqual(EMPTY);
    expect(parseAlertNote("   ")).toEqual(EMPTY);
  });

  it("rejects an unsupported sourceTf without affecting other fields", () => {
    const parsed = parseAlertNote("eventType=LEVEL_TOUCHED | sourceTf=5H | levelColor=RED");

    expect(parsed.sourceTimeframe).toBeNull();
    expect(parsed.eventType).toBe("LEVEL_TOUCHED");
    expect(parsed.levelColor).toBe("RED");
  });

  it("rejects an unsupported levelColor and a non-numeric levelPrice", () => {
    const parsed = parseAlertNote("levelColor=BLUE | levelPrice=abc | sourceTf=1M");

    expect(parsed.levelColor).toBeNull();
    expect(parsed.levelPrice).toBeNull();
    expect(parsed.sourceTimeframe).toBe("1M");
  });

  it("returns all-null for a legacy free-text note without guessing", () => {
    expect(parseAlertNote("Bullish reversal zone detected")).toEqual(EMPTY);
  });
});

describe("hasLevelMetadata", () => {
  it("is false for null context and for chart-timeframe-only context", () => {
    expect(hasLevelMetadata(null)).toBe(false);
    expect(hasLevelMetadata({ ...EMPTY, chartTimeframe: "1h" })).toBe(false);
  });

  it("is true when any level field is present", () => {
    expect(hasLevelMetadata({ ...EMPTY, sourceTimeframe: "12M" })).toBe(true);
    expect(hasLevelMetadata({ ...EMPTY, levelColor: "GREEN" })).toBe(true);
  });
});
