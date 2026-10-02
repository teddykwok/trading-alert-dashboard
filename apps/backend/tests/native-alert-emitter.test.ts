import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SWITCHOVER_TRUNCATED_CLOSED_BARS, createNativeEngineConfig, parseAlertNote, type NativeKline } from "@trading-alert-dashboard/shared";

import { canonicalSha256 } from "../src/modules/native-scanner/canonical-json";
import { LiveCheckpointStore } from "../src/modules/native-scanner/live-shadow-checkpoint";
import { LiveShadowSession, prepareLiveShadowState, type LiveShadowRequest } from "../src/modules/native-scanner/live-shadow-session";
import { LiveShadowEventStore, type LiveImmediateObservation, type ShadowRecord } from "../src/modules/native-scanner/live-shadow-store";
import { buildAlertContext } from "../src/modules/alerts/alert-context";
import { NATIVE_EMITTER_CLI_USAGE, NativeEmitterCliUsageError, parseNativeEmitterCliArgs } from "../src/modules/native-alerts/native-alert-cli-args";
import { NATIVE_INDICATOR_NAME, buildNativeAlertDraft } from "../src/modules/native-alerts/native-alert-draft";
import { NativeAlertEmitter, runNativeEmitterLoop, type NativeEmitterEvent } from "../src/modules/native-alerts/native-alert-emitter";
import type { NativeDeliveryLedger } from "../src/modules/native-alerts/native-alert-ledger";
import {
  NATIVE_DELIVERY_KEY_SCHEMA,
  NATIVE_DELIVERY_POLICY_VERSION,
  NATIVE_DELIVERY_V1_SOURCE_TFS,
  NativeDeliverySelector,
  ineligibilityOf,
  nativeDeliveryKey,
  selectNativeDeliveries,
  type NativeDeliveryDecision,
  type NativeSelection,
} from "../src/modules/native-alerts/native-delivery-policy";
import { ShadowLogError, ShadowLogTail, parseShadowEventLog } from "../src/modules/native-alerts/shadow-log-reader";
import { doji, repeat, type Ohlc } from "./helpers/native-signal-fixtures";
import { fifteenMinute } from "./helpers/native-scanner-fakes";
import { BAR0, IDENTITY, LINEAGE, M15, OTHER_LINEAGE, SYMBOL, bar, commit, lineOf, logOf, observation, realisticLog } from "./helpers/native-alert-fixtures";

/**
 * Native alert emitter — the pure half: the strict log reader, the
 * NATIVE_DELIVERY_V1 policy, the delivery key, the Alert mapping, the emitter's
 * DRY_RUN/COMMIT split, catch-up and follow, the CLI and the static fences.
 *
 * Nothing here opens a database, a socket or a real scanner directory. The DB
 * half (ledger, transactions, races, dashboard read path, execution fences)
 * is native-alert-delivery.integration.test.ts.
 */

const deliveries = (selections: readonly NativeSelection[]) =>
  selections.flatMap((s) => (s.kind === "DELIVER" ? [s.decision] : []));
const skips = (selections: readonly NativeSelection[]) =>
  selections.flatMap((s) => (s.kind === "SKIP" ? [[s.eventId, s.reason, s.supersededBy] as const] : []));
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ShadowLogError) return error.code;
    throw error;
  }
  return "ACCEPTED";
};
const parse = (records: readonly unknown[]) => parseShadowEventLog(logOf(records), IDENTITY);

// ===========================================================================
// NATIVE_DELIVERY_V1 eligibility and selection
// ===========================================================================

describe("NATIVE_DELIVERY_V1 policy", () => {
  it("1. one live 1D observation becomes one decision recording winner, policy and shadow event", () => {
    const o = observation();
    const [decision] = deliveries(selectNativeDeliveries(parse([o])));
    expect(decision.winner).toEqual(o);
    expect(decision.provenance).toMatchObject({
      policyVersion: "NATIVE_DELIVERY_V1",
      winningShadowEventId: o.eventId,
      lineageId: LINEAGE,
      symbol: SYMBOL,
      chartInterval: "15m",
      barOpenTimeMs: BAR0,
      sourceTf: "1D",
      evidenceBasis: "IMMEDIATE_INTRABAR",
      evidenceClass: "PROVEN_INTRABAR_POSSIBLE",
    });
    expect(decision.provenanceSha256).toBe(canonicalSha256(decision.provenance));
  });

  it("2. a live 1W observation is delivered too", () => {
    expect(deliveries(selectNativeDeliveries(parse([observation({ sourceTf: "1W" })]))).length).toBe(1);
  });

  it("3. 1M/3M/6M/12M are never delivered, and never block a later 1D on the same bar", () => {
    expect(NATIVE_DELIVERY_V1_SOURCE_TFS).toEqual(["1D", "1W"]);
    for (const tf of ["1M", "3M", "6M", "12M"] as const) {
      const long = observation({ sourceTf: tf });
      const daily = observation({ sourceTf: "1D", candidateSequence: 1, createdBarOpenTimeMs: BAR0 - 5 * M15 });
      const selections = selectNativeDeliveries(parse([long, daily]));
      expect(skips(selections)).toEqual([[long.eventId, "SOURCE_TF_NOT_DELIVERED", null]]);
      expect(deliveries(selections).map((d) => d.winner.eventId)).toEqual([daily.eventId]);
    }
  });

  it("4. at most one Alert per bar: the EARLIEST eligible observation wins; later ones are superseded by it", () => {
    const records = realisticLog();
    const selections = selectNativeDeliveries(parse(records));
    const decided = deliveries(selections);
    expect(decided.map((d) => [d.winner.barOpenTimeMs, d.winner.sourceTf, d.winner.levelPrice])).toEqual([
      [bar(1), "1D", 0.81],
      [bar(2), "1W", 0.95],
    ]);
    const winner = decided[0].winner.eventId;
    expect(skips(selections).filter(([, reason]) => reason === "SUPERSEDED_SAME_BAR")).toEqual([
      [(records[3] as LiveImmediateObservation).eventId, "SUPERSEDED_SAME_BAR", winner],
      [(records[4] as LiveImmediateObservation).eventId, "SUPERSEDED_SAME_BAR", winner],
    ]);
  });

  it("5. different bars are different deliveries", () => {
    const a = observation({ barMs: bar(0) });
    const b = observation({ barMs: bar(1) });
    expect(deliveries(selectNativeDeliveries(parse([a, commit(bar(0)), b]))).map((d) => d.deliveryKey)).toEqual([
      nativeDeliveryKey(a),
      nativeDeliveryKey(b),
    ]);
  });

  it("6. a BAR_CLOSE_COMMIT is never delivered on its own — whatever its classification or committed candidates", () => {
    for (const classification of ["SHADOW_LIVE_ONLY", "QUARANTINED_CURRENT_BAR", "REPLAYED_NON_ACTIONABLE"] as const) {
      const selections = selectNativeDeliveries(parse([commit(BAR0, classification)]));
      expect(deliveries(selections)).toEqual([]);
      expect(skips(selections)[0][1]).toBe("BAR_CLOSE_COMMIT_NEVER_DELIVERED");
    }
  });

  it("7. a QUARANTINED_CURRENT_BAR observation is refused by the reader AND by the policy", () => {
    const forged = { ...observation(), classification: "QUARANTINED_CURRENT_BAR" };
    expect(refusal(() => parse([forged]))).toBe("INVALID_SCHEMA");
    expect(ineligibilityOf(forged as unknown as ShadowRecord)).toBe("NOT_SHADOW_LIVE_ONLY");
    expect(new NativeDeliverySelector().consider(forged as unknown as ShadowRecord).kind).toBe("SKIP");
  });

  it("8. a REPLAYED_NON_ACTIONABLE observation is refused by the reader AND by the policy", () => {
    const forged = { ...observation(), classification: "REPLAYED_NON_ACTIONABLE" };
    expect(refusal(() => parse([forged]))).toBe("INVALID_SCHEMA");
    expect(ineligibilityOf(forged as unknown as ShadowRecord)).toBe("NOT_SHADOW_LIVE_ONLY");
    expect(new NativeDeliverySelector().consider(forged as unknown as ShadowRecord).kind).toBe("SKIP");
  });

  it("9. an actionable record is refused by the reader AND by the policy", () => {
    const forged = { ...observation(), actionable: true };
    expect(refusal(() => parse([forged]))).toBe("ACTIONABLE_RECORD");
    expect(ineligibilityOf(forged as unknown as ShadowRecord)).toBe("ACTIONABLE_RECORD");
  });

  it("10. anything but IMMEDIATE_INTRABAR live evidence (a bar-close or historical reconstruction) is refused", () => {
    const committedBasis = { ...observation(), evidence: { basis: "COMMITTED_BAR_CLOSE", evidenceClass: "COMMITTED_BAR_CLOSE", proof: { bandEnteredBeforeClosingUpdate: true, levelPresentOnEveryUpdate: true } } };
    expect(refusal(() => parse([committedBasis]))).toBe("INVALID_SCHEMA");
    expect(ineligibilityOf(committedBasis as unknown as ShadowRecord)).toBe("NOT_IMMEDIATE_INTRABAR");
  });

  it("11. a POSSIBLE_ONLY live observation is delivered, and its evidence class is kept, never collapsed", () => {
    const [decision] = deliveries(selectNativeDeliveries(parse([observation({ evidenceClass: "POSSIBLE_ONLY" })])));
    expect(decision.provenance.evidenceClass).toBe("POSSIBLE_ONLY");
    expect((buildNativeAlertDraft(decision).rawPayload as { delivery: { evidenceClass: string } }).delivery.evidenceClass).toBe("POSSIBLE_ONLY");
  });

  it("12. the selector itself never delivers one event twice", () => {
    const selector = new NativeDeliverySelector();
    const o = observation();
    expect(selector.consider(o).kind).toBe("DELIVER");
    expect(selector.consider(o)).toEqual({ kind: "SKIP", eventId: o.eventId, reason: "DUPLICATE_EVENT", supersededBy: null });
  });
});

// ===========================================================================
// The delivery key
// ===========================================================================

describe("the idempotent delivery key", () => {
  const parts = { lineageId: LINEAGE, marketType: "USDM_PERPETUAL", symbol: SYMBOL, chartInterval: "15m", barOpenTimeMs: BAR0 };

  it("13. is the versioned canonical hash of exactly schema, policy, lineage, market, symbol, interval and bar", () => {
    expect(nativeDeliveryKey(parts)).toBe(
      canonicalSha256({
        schema: NATIVE_DELIVERY_KEY_SCHEMA,
        policyVersion: NATIVE_DELIVERY_POLICY_VERSION,
        lineageId: LINEAGE,
        marketType: "USDM_PERPETUAL",
        symbol: SYMBOL,
        chartInterval: "15m",
        barOpenTimeMs: BAR0,
      })
    );
    expect(NATIVE_DELIVERY_KEY_SCHEMA).toBe("teddy.native-alerts.delivery-key.v1");
  });

  it("14. changes with every identity field, and only with them", () => {
    const base = nativeDeliveryKey(parts);
    for (const changed of [
      { ...parts, lineageId: OTHER_LINEAGE },
      { ...parts, barOpenTimeMs: BAR0 + M15 },
      { ...parts, symbol: "THETAUSDT" },
      { ...parts, chartInterval: "1h" },
      { ...parts, marketType: "SPOT" },
    ]) {
      expect(nativeDeliveryKey(changed)).not.toBe(base);
    }
    // Two different candidates on one bar share one key: that IS "one Alert per bar".
    const a = observation({ sourceTf: "1D" });
    const b = observation({ sourceTf: "1W", signal: "SHORT", levelPrice: 0.9, candidateSequence: 1 });
    expect(nativeDeliveryKey(a)).toBe(base);
    expect(nativeDeliveryKey(b)).toBe(base);
  });

  it("15. is deterministic: no clock, no process state — a fresh process derives the same key", () => {
    vi.useFakeTimers();
    try {
      const first = nativeDeliveryKey(parts);
      vi.setSystemTime(Date.UTC(2031, 0, 1));
      expect(nativeDeliveryKey(parts)).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// The strict reader
// ===========================================================================

describe("the strict shadow-log reader fails closed", () => {
  it("16. accepts a realistic log and returns every record in order", () => {
    expect(parse(realisticLog())).toEqual(realisticLog());
  });

  it("17. a torn final line", () => {
    const text = logOf([observation()]) + lineOf(commit(BAR0)).slice(0, 40);
    expect(refusal(() => parseShadowEventLog(text, IDENTITY))).toBe("TORN_LINE");
  });

  it("18. a line that is not JSON, an empty line, an unknown kind or schema, missing or extra fields", () => {
    expect(refusal(() => parseShadowEventLog("{nope\n", IDENTITY))).toBe("NOT_JSON");
    expect(refusal(() => parseShadowEventLog(`${lineOf(observation())}\n`, IDENTITY))).toBe("TORN_LINE");
    expect(refusal(() => parse([{ ...observation(), kind: "SOMETHING_ELSE" }]))).toBe("INVALID_SCHEMA");
    expect(refusal(() => parse([{ ...observation(), schema: "teddy.native-scanner.live-shadow-event.v2" }]))).toBe("INVALID_SCHEMA");
    expect(refusal(() => parse([{ ...observation(), extra: 1 }]))).toBe("INVALID_SCHEMA");
    const { levelPrice: _dropped, ...missing } = observation();
    expect(refusal(() => parse([missing]))).toBe("INVALID_SCHEMA");
    expect(refusal(() => parse([{ ...observation(), levelPrice: -1 }]))).toBe("INVALID_SCHEMA");
    expect(refusal(() => parse([{ ...observation(), barOpenTime: "2026-10-01T12:00:01.000Z" }]))).toBe("INVALID_SCHEMA");
  });

  it("19. an event identity that does not match its content", () => {
    expect(refusal(() => parse([{ ...observation(), eventId: "f".repeat(64) }]))).toBe("INVALID_EVENT_IDENTITY");
    expect(refusal(() => parse([{ ...observation(), sourceTf: "1W", levelKey: observation().levelKey.replace("1D", "1W") }]))).toBe(
      "INVALID_EVENT_IDENTITY"
    );
    expect(refusal(() => parse([{ ...commit(BAR0), eventId: "e".repeat(64) }]))).toBe("INVALID_EVENT_IDENTITY");
    expect(refusal(() => parse([{ ...observation(), eventId: "not-a-hash" }]))).toBe("INVALID_EVENT_IDENTITY");
  });

  it("20. a duplicate event, identical or conflicting", () => {
    const o = observation();
    expect(refusal(() => parse([o, o]))).toBe("DUPLICATE_EVENT_ID");
    expect(refusal(() => parse([o, { ...o, firstObservedAtMs: o.firstObservedAtMs + 1 }]))).toBe("CONFLICTING_DUPLICATE_EVENT_ID");
  });

  it("21. another lineage, market, symbol or interval", () => {
    expect(refusal(() => parse([observation({ lineageId: OTHER_LINEAGE })]))).toBe("LINEAGE_MISMATCH");
    expect(refusal(() => parse([observation({ symbol: "THETAUSDT" })]))).toBe("SYMBOL_MISMATCH");
    expect(refusal(() => parse([{ ...observation(), marketType: "SPOT" }]))).toBe("MARKET_MISMATCH");
    expect(refusal(() => parse([{ ...observation(), chartInterval: "1h" }]))).toBe("INTERVAL_MISMATCH");
    expect(refusal(() => parseShadowEventLog("", { ...IDENTITY, lineageId: "short" }))).toBe("LINEAGE_MISMATCH");
    expect(refusal(() => parseShadowEventLog("", { ...IDENTITY, chartInterval: "1h" as "15m" }))).toBe("INTERVAL_MISMATCH");
  });

  it("22. impossible ordering: after the bar's commit, backwards in bars, a sequence gap, event time before the bar, a commit going back", () => {
    expect(refusal(() => parse([commit(BAR0), observation({ barMs: BAR0 })]))).toBe("IMPOSSIBLE_ORDERING");
    expect(refusal(() => parse([observation({ barMs: bar(2) }), observation({ barMs: bar(1) })]))).toBe("IMPOSSIBLE_ORDERING");
    expect(refusal(() => parse([observation({ candidateSequence: 1 })]))).toBe("IMPOSSIBLE_ORDERING");
    expect(refusal(() => parse([observation({ eventTimeMs: BAR0 - 1 })]))).toBe("IMPOSSIBLE_ORDERING");
    expect(
      refusal(() => parse([observation({ updateSequence: 3 }), observation({ candidateSequence: 1, updateSequence: 2, createdBarOpenTimeMs: 1 })]))
    ).toBe("IMPOSSIBLE_ORDERING");
    expect(refusal(() => parse([commit(bar(2)), commit(bar(1))]))).toBe("IMPOSSIBLE_ORDERING");
    expect(refusal(() => parse([observation({ barMs: bar(2) }), commit(bar(1))]))).toBe("IMPOSSIBLE_ORDERING");
  });

  it("23. a refused log delivers nothing: the refusal happens before any selection", () => {
    const records = [observation(), { ...observation({ barMs: bar(1) }), actionable: true }];
    let selected = 0;
    expect(() => {
      for (const s of selectNativeDeliveries(parse(records))) if (s.kind === "DELIVER") selected += 1;
    }).toThrow(ShadowLogError);
    expect(selected).toBe(0);
  });
});

// ===========================================================================
// Follow mode: append-only, prefix-deterministic
// ===========================================================================

describe("following an append-only log", () => {
  it("24. returns only newly completed records, holds a partial line briefly, then refuses it as torn", () => {
    const records = realisticLog();
    const full = logOf(records);
    const tail = new ShadowLogTail(IDENTITY, 2);
    expect(tail.read(null)).toEqual([]);
    const cut = full.indexOf("\n", full.length / 2) + 1;
    const first = tail.read(full.slice(0, cut + 10));
    expect(first.length).toBeGreaterThan(0);
    expect(tail.read(full.slice(0, cut + 10))).toEqual([]); // same partial, 2nd poll: tolerated
    expect(refusal(() => tail.read(full.slice(0, cut + 10)))).toBe("TORN_LINE"); // 3rd poll: torn
    const again = new ShadowLogTail(IDENTITY, 2);
    expect([...again.read(full.slice(0, cut + 10)), ...again.read(full)]).toEqual(records);
  });

  it("25. a rewritten, truncated or deleted log is refused", () => {
    const text = logOf(realisticLog());
    const t1 = new ShadowLogTail(IDENTITY, 0);
    t1.read(text);
    expect(refusal(() => t1.read(text.replace("QUARANTINED_CURRENT_BAR", "SHADOW_LIVE_ONLY_XXXXXX")))).toBe("LOG_REWRITTEN");
    const t2 = new ShadowLogTail(IDENTITY, 0);
    t2.read(text);
    expect(refusal(() => t2.read(text.slice(0, 10)))).toBe("LOG_REWRITTEN");
    const t3 = new ShadowLogTail(IDENTITY, 0);
    t3.read(text);
    expect(refusal(() => t3.read(null))).toBe("LOG_REWRITTEN");
  });

  it("26. every split of the log into polls selects exactly what one catch-up read selects", () => {
    const text = logOf(realisticLog());
    const expected = selectNativeDeliveries(parseShadowEventLog(text, IDENTITY));
    for (let cut = 0; cut <= text.length; cut += 37) {
      const tail = new ShadowLogTail(IDENTITY, 1);
      const selector = new NativeDeliverySelector();
      const got = [...tail.read(text.slice(0, cut)), ...tail.read(text)].map((r) => selector.consider(r));
      expect(got).toEqual(expected);
    }
  });
});

// ===========================================================================
// Genuine scanner output
// ===========================================================================

describe("the reader and policy on records written by the real live shadow session", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("27. a real session's log is accepted; the quarantined readiness bar delivers nothing; the first 1D observation wins", () => {
    const D = (d: number, h = 0, m = 0) => Date.UTC(2025, 0, d, h, m);
    const rows: Ohlc[] = [];
    rows.push(...repeat(doji(100), 96));
    rows.push([100, 120, 99, 99], ...repeat(doji(99), 95));
    rows.push(...repeat(doji(99), 96));
    rows.push([99, 121, 98.5, 99], ...repeat(doji(99), 94), [99, 99, 98.9, 98.9]);
    rows.push([98.9, 123, 98.9, 123], ...repeat(doji(123), 95));
    rows.push([123, 123, 119.5, 122.5], ...repeat(doji(122.5), 8));
    const bars: NativeKline[] = fifteenMinute(D(6), rows);
    const request: LiveShadowRequest = {
      symbol: "TESTUSDT",
      marketType: "USDM_PERPETUAL",
      chartInterval: "15m",
      historyStartMs: D(6),
      switchoverMs: D(10, 12),
      engine: createNativeEngineConfig({ minMovePct: 0.07, enabledSourceTfs: ["1D"] }),
      partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
      expectedLineageId: null,
    };
    const dir = mkdtempSync(path.join(tmpdir(), "native-emitter-genuine-"));
    dirs.push(dir);
    const checkpoints = new LiveCheckpointStore(dir);
    const plan = prepareLiveShadowState(bars, request, D(10, 23, 45), null);
    checkpoints.save(plan.checkpointBody, "2025-01-01T00:00:00.000Z");
    const events = new LiveShadowEventStore(dir);
    let now = D(10, 23, 59);
    const session = new LiveShadowSession({ plan, checkpoints, events, nowMs: () => now, nowIso: () => new Date(now).toISOString(), persistClosedBar: () => undefined });
    const update = (openTimeMs: number, [o, h, l, c]: Ohlc, closed: boolean, eventTimeMs: number) => {
      now = eventTimeMs;
      return { symbol: "TESTUSDT", interval: "15m" as const, eventTimeMs, openTimeMs, closeTimeMs: openTimeMs + M15 - 1, open: o, high: h, low: l, close: c, closed };
    };
    const ready = update(D(10, 23, 45), [123, 123, 123, 123], false, D(10, 23, 59));
    session.markStreamReady(ready);
    session.onUpdate(ready);
    session.onUpdate(update(D(10, 23, 45), [123, 123, 123, 123], true, D(11) + 1));
    const L0 = D(11);
    session.onUpdate(update(L0, [123, 123, 123, 123], false, L0 + 1_000));
    session.onUpdate(update(L0, [123, 123, 121.5, 122], false, L0 + 60_000));
    session.onUpdate(update(L0, [123, 123, 119.5, 122.5], true, L0 + M15));

    const text = readFileSync(events.file, "utf8");
    const records = parseShadowEventLog(text, { lineageId: plan.lineageId, marketType: "USDM_PERPETUAL", symbol: "TESTUSDT", chartInterval: "15m" });
    expect(records.map((r) => [r.kind, r.classification])).toEqual([
      ["BAR_CLOSE_COMMIT", "QUARANTINED_CURRENT_BAR"],
      ["LIVE_IMMEDIATE_OBSERVATION", "SHADOW_LIVE_ONLY"],
      ["LIVE_IMMEDIATE_OBSERVATION", "SHADOW_LIVE_ONLY"],
      ["BAR_CLOSE_COMMIT", "SHADOW_LIVE_ONLY"],
    ]);
    const decided = deliveries(selectNativeDeliveries(records));
    expect(decided.map((d) => [d.winner.levelPrice, d.winner.sourceTf, d.winner.exchangeEventTimeMs])).toEqual([[121, "1D", L0 + 60_000]]);
    expect(buildNativeAlertDraft(decided[0]).triggeredAt.getTime()).toBe(L0 + 60_000);
  });
});

// ===========================================================================
// The canonical Alert
// ===========================================================================

describe("the canonical native Alert", () => {
  const decisionFor = (o: LiveImmediateObservation) => deliveries(selectNativeDeliveries(parse([o])))[0];

  afterEach(() => {
    vi.useRealTimers();
  });

  it("28. is explicitly NATIVE, on Binance, for the bare symbol, on the 15m chart, at the level price", () => {
    const o = observation({ signal: "SHORT", levelPrice: 0.95, sourceTf: "1W" });
    const draft = buildNativeAlertDraft(decisionFor(o));
    expect(draft).toMatchObject({
      source: "NATIVE",
      exchange: "BINANCE",
      assetType: "CRYPTO",
      symbol: "LDOUSDT",
      timeframe: "15m",
      price: 0.95,
      signal: "SHORT",
      eventType: "LEVEL_TOUCHED",
      levelColor: "RED",
      sourceTimeframe: "1W",
      touchDirection: "FROM_BELOW",
      indicatorName: NATIVE_INDICATOR_NAME,
      indicatorValue: null,
      assetId: null,
    });
    expect(draft.indicatorName?.toLowerCase().startsWith("teddy")).toBe(false);
  });

  it("29. triggeredAt is the exchange event time of the first observation — never the emitter's or the database's clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2030, 5, 1));
    const o = observation({ eventTimeMs: BAR0 + 123_456 });
    const draft = buildNativeAlertDraft(decisionFor(o));
    expect(draft.triggeredAt.getTime()).toBe(BAR0 + 123_456);
    expect((draft.rawPayload as { triggeredAt: string }).triggeredAt).toBe(new Date(BAR0 + 123_456).toISOString());
  });

  it("30. carries bar time, lineage, shadow event and policy; no secret, no TradingView claim, no large payload", () => {
    const o = observation();
    const decision = decisionFor(o);
    const payload = buildNativeAlertDraft(decision).rawPayload as Record<string, unknown> & { delivery: Record<string, unknown> };
    expect(payload).toMatchObject({ source: "NATIVE", barTime: o.barOpenTime, symbol: "LDOUSDT", marketType: "USDM_PERPETUAL" });
    expect(payload.delivery).toMatchObject({
      policyVersion: "NATIVE_DELIVERY_V1",
      lineageId: LINEAGE,
      shadowEventId: o.eventId,
      deliveryKey: decision.deliveryKey,
      provenanceSha256: decision.provenanceSha256,
      tradingViewEquivalenceClaimed: false,
    });
    const json = JSON.stringify(payload);
    expect(json).not.toMatch(/secret|canary|apiKey|signature/i);
    expect(json.length).toBeLessThan(2_000);
  });

  it("31. the dashboard's own context builder reads the same level context from the row and its note", () => {
    const o = observation({ levelPrice: 0.8123 });
    const draft = buildNativeAlertDraft(decisionFor(o));
    const note = (draft.rawPayload as { note: string }).note;
    expect(parseAlertNote(note)).toEqual({
      eventType: "LEVEL_TOUCHED",
      levelColor: "GREEN",
      sourceTimeframe: "1D",
      touchDirection: "FROM_ABOVE",
      levelPrice: 0.8123,
      chartTimeframe: "15m",
    });
    expect(buildAlertContext(draft as never)).toMatchObject({ levelPrice: 0.8123, sourceTimeframe: "1D", chartTimeframe: "15m" });
  });
});

// ===========================================================================
// The emitter: DRY_RUN vs COMMIT, catch-up and follow
// ===========================================================================

function fakeLedger(options: { delivered?: Set<string> } = {}) {
  const delivered = options.delivered ?? new Set<string>();
  const calls: string[] = [];
  const ledger: NativeDeliveryLedger = {
    status: async () => ({ available: true, delivered: delivered.size, detail: "fake" }),
    lookup: async (d: NativeDeliveryDecision) => {
      calls.push(`lookup:${d.deliveryKey}`);
      return delivered.has(d.deliveryKey) ? { state: "DELIVERED", alertId: `alert-${d.deliveryKey.slice(0, 6)}` } : { state: "NOT_DELIVERED" };
    },
    deliver: async (d: NativeDeliveryDecision) => {
      calls.push(`deliver:${d.deliveryKey}`);
      if (delivered.has(d.deliveryKey)) return { outcome: "ALREADY_DELIVERED", deliveryKey: d.deliveryKey, alertId: `alert-${d.deliveryKey.slice(0, 6)}` };
      delivered.add(d.deliveryKey);
      return { outcome: "CREATED", deliveryKey: d.deliveryKey, alertId: `alert-${d.deliveryKey.slice(0, 6)}` };
    },
  };
  return { ledger, calls, delivered };
}

describe("the emitter", () => {
  it("32. DRY_RUN never calls deliver: it only looks keys up and reports what it would do", async () => {
    const { ledger, calls } = fakeLedger();
    const events: NativeEmitterEvent[] = [];
    const emitter = new NativeAlertEmitter({ mode: "DRY_RUN", ledger, report: (e) => events.push(e) });
    await emitter.process(parse(realisticLog()));
    expect(calls.every((c) => c.startsWith("lookup:"))).toBe(true);
    expect(calls.length).toBe(2);
    expect(emitter.tally).toMatchObject({ decisions: 2, created: 0, wouldCreate: 2 });
    expect(events.flatMap((e) => (e.type === "DECISION" ? [e.result] : []))).toEqual(["WOULD_CREATE", "WOULD_CREATE"]);
  });

  it("33. DRY_RUN without a ledger still writes nothing; COMMIT without a ledger cannot be constructed", async () => {
    const emitter = new NativeAlertEmitter({ mode: "DRY_RUN", ledger: null, report: () => undefined });
    await emitter.process(parse(realisticLog()));
    expect(emitter.tally.wouldCreate).toBe(2);
    expect(() => new NativeAlertEmitter({ mode: "COMMIT_DASHBOARD_ALERTS", ledger: null, report: () => undefined })).toThrow();
  });

  it("34. COMMIT delivers each decision once, in log order; a restart from the first byte delivers nothing new", async () => {
    const shared = new Set<string>();
    const first = fakeLedger({ delivered: shared });
    const run1 = new NativeAlertEmitter({ mode: "COMMIT_DASHBOARD_ALERTS", ledger: first.ledger, report: () => undefined });
    await run1.process(parse(realisticLog()));
    expect(run1.tally).toMatchObject({ created: 2, alreadyDelivered: 0 });
    const second = fakeLedger({ delivered: shared });
    const run2 = new NativeAlertEmitter({ mode: "COMMIT_DASHBOARD_ALERTS", ledger: second.ledger, report: () => undefined });
    await run2.process(parse(realisticLog()));
    expect(run2.tally).toMatchObject({ created: 0, alreadyDelivered: 2 });
    expect(shared.size).toBe(2);
  });

  it("35. catch-up, then follow: appended records are delivered as they become durable; a refusal stops the loop", async () => {
    const records = realisticLog();
    let text = logOf(records.slice(0, 3));
    const { ledger, delivered } = fakeLedger();
    const emitter = new NativeAlertEmitter({ mode: "COMMIT_DASHBOARD_ALERTS", ledger, report: () => undefined });
    let polls = 0;
    let caughtUp = 0;
    await runNativeEmitterLoop({
      tail: new ShadowLogTail(IDENTITY, 2),
      readLog: () => text,
      emitter,
      follow: true,
      pollMs: 1_000,
      sleep: async () => {
        polls += 1;
        if (polls === 1) expect(delivered.size).toBe(1);
        text = logOf(records);
      },
      shouldStop: () => polls >= 2,
      onCaughtUp: () => (caughtUp = emitter.tally.records),
    });
    expect(caughtUp).toBe(3);
    expect(delivered.size).toBe(2);

    const broken = new NativeAlertEmitter({ mode: "COMMIT_DASHBOARD_ALERTS", ledger: fakeLedger().ledger, report: () => undefined });
    let bad = logOf(records.slice(0, 2));
    await expect(
      runNativeEmitterLoop({
        tail: new ShadowLogTail(IDENTITY, 0),
        readLog: () => bad,
        emitter: broken,
        follow: true,
        pollMs: 1,
        sleep: async () => {
          bad = `${bad}${lineOf({ ...observation({ barMs: bar(9) }), actionable: true })}`;
        },
        shouldStop: () => false,
      })
    ).rejects.toMatchObject({ code: "ACTIONABLE_RECORD" });
  });
});

// ===========================================================================
// CLI arguments
// ===========================================================================

describe("native-alerts:emitter arguments", () => {
  const base = ["--symbol", "LDOUSDT", "--interval", "15m", "--lineage-id", LINEAGE];

  it("36. defaults to a DRY RUN; writing takes the explicit --commit-dashboard-alerts flag", () => {
    expect(parseNativeEmitterCliArgs(base)).toEqual({
      symbol: "LDOUSDT",
      chartInterval: "15m",
      lineageId: LINEAGE,
      shadowDir: null,
      mode: "DRY_RUN",
      follow: false,
      pollMs: 2_000,
    });
    expect(parseNativeEmitterCliArgs([...base, "--commit-dashboard-alerts", "--follow", "--poll-ms", "500"])).toMatchObject({
      mode: "COMMIT_DASHBOARD_ALERTS",
      follow: true,
      pollMs: 500,
    });
    expect(NATIVE_EMITTER_CLI_USAGE).toContain("DRY RUN");
  });

  it("37. refuses every account, execution, order, credential or unknown argument, and bad identities", () => {
    for (const extra of [
      ["--execute"],
      ["--account", "A"],
      ["--profile", "x"],
      ["--execution-profile", "x"],
      ["--api-key", "x"],
      ["--live-orders"],
      ["--commit"],
      ["--enable-execution"],
    ]) {
      expect(() => parseNativeEmitterCliArgs([...base, ...extra])).toThrow(NativeEmitterCliUsageError);
    }
    expect(() => parseNativeEmitterCliArgs(["--symbol", "LDOUSDT", "--interval", "15m"])).toThrow(/lineage-id is required/);
    expect(() => parseNativeEmitterCliArgs(["--symbol", "ldo", "--interval", "15m", "--lineage-id", LINEAGE])).toThrow(NativeEmitterCliUsageError);
    expect(() => parseNativeEmitterCliArgs(["--symbol", "LDOUSDT", "--interval", "1h", "--lineage-id", LINEAGE])).toThrow(NativeEmitterCliUsageError);
    expect(() => parseNativeEmitterCliArgs(["--symbol", "LDOUSDT", "--interval", "15m", "--lineage-id", "abc"])).toThrow(NativeEmitterCliUsageError);
    expect(() => parseNativeEmitterCliArgs([...base, "--poll-ms", "500"])).toThrow(/only applies with --follow/);
    expect(() => parseNativeEmitterCliArgs([...base, "--commit-dashboard-alerts", "--commit-dashboard-alerts"])).toThrow(/twice/);
  });
});

// ===========================================================================
// Static fences
// ===========================================================================

const BACKEND = path.resolve(__dirname, "..");
const EMITTER_DIR = path.join(BACKEND, "src/modules/native-alerts");
const SCANNER_DIR = path.join(BACKEND, "src/modules/native-scanner");
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const importsOf = (text: string) =>
  [...code(text).matchAll(/^\s*(?:import|export)\s[^;]*?\bfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gm)].map((m) => m[1] ?? m[2]);
const emitterSources = readdirSync(EMITTER_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((file) => ({ file, text: readFileSync(path.join(EMITTER_DIR, file), "utf8") }));
const CLI = "run-native-alert-emitter.ts";
const read = (rel: string) => code(readFileSync(path.join(BACKEND, rel), "utf8"));

describe("static fences", () => {
  it("38. the emitter is exactly these modules, importing only node built-ins, Prisma, the shared package, scanner evidence readers and the alert source/types", () => {
    expect(emitterSources.map((s) => s.file).sort()).toEqual([
      "native-alert-cli-args.ts",
      "native-alert-draft.ts",
      "native-alert-emitter.ts",
      "native-alert-ledger.ts",
      "native-delivery-policy.ts",
      "run-native-alert-emitter.ts",
      "shadow-log-reader.ts",
    ]);
    const allowed = new Set([
      "@prisma/client",
      "@trading-alert-dashboard/shared",
      "../native-scanner/canonical-json",
      "../native-scanner/live-shadow-store",
      "../native-scanner/live-shadow-checkpoint",
      "../native-scanner/scanner-paths",
      "../alerts/alert-source",
      "../alerts/alerts.types",
    ]);
    for (const { file, text } of emitterSources) {
      for (const specifier of importsOf(text)) {
        const ok =
          specifier.startsWith("node:") ||
          /^\.\/[a-z-]+$/.test(specifier) ||
          allowed.has(specifier) ||
          (file === CLI && specifier === "../../config/bootstrap-generic");
        expect({ file, specifier, ok }).toEqual({ file, specifier, ok: true });
      }
      // Only the ledger and the CLI may touch the database client at all.
      if (!["native-alert-ledger.ts", CLI].includes(file)) {
        expect({ file, hit: /PrismaClient|\$transaction/.test(code(text).replace(/import[^;]*;/g, "")) }).toEqual({ file, hit: false });
      }
    }
  });

  it.each([
    ["queues", /bullmq|enqueue|\/jobs\/|redis/i],
    ["notifications and sockets", /notification|notify|socket|telegram/i],
    ["the webhook", /webhook|handleTradingView/i],
    ["plans, adoption and execution", /extreme-rr|ExtremeRR|selected-plan|\/execution\/|createExecution|tradeExecution|binanceOrder/],
    ["Binance clients, endpoints and signing", /binance-execution|binance\.client|binance-read-only|binance-account|binance-public-futures|kline-fetcher|fapi|createHmac|X-MBX|WebSocket|\bfetch\s*\(/],
    ["credentials and the full runtime env", /BINANCE_API_KEY|BINANCE_API_SECRET|apiSecret|OPERATOR_API_TOKEN|WEBHOOK_SECRET|REDIS_URL|config\/env"|bootstrap-account|account-env/],
    ["actionable records", /actionable:\s*true/],
  ])("39. the emitter never references %s", (_label, pattern) => {
    for (const { file, text } of emitterSources) {
      expect({ file, hit: code(text).match(pattern)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });

  it("40. only the CLI reads the environment, the clock, the file system or timers; its FIRST import is the credential-free bootstrap", () => {
    for (const { file, text } of emitterSources) {
      if (file === CLI) continue;
      expect({ file, hit: code(text).match(/process\.env|Date\.now|new Date\(\)|setTimeout|setInterval|readFileSync|existsSync|"node:fs"/)?.[0] ?? null }).toEqual({ file, hit: null });
    }
    const cli = emitterSources.find((s) => s.file === CLI)!.text;
    expect(importsOf(cli)[0]).toBe("../../config/bootstrap-generic");
    for (const banner of ["NATIVE ALERT EMITTER", "DASHBOARD WRITES ONLY", "EXECUTION FOR NATIVE ALERTS IS HARD-DISABLED"]) {
      expect(cli).toContain(`console.log("${banner}")`);
    }
  });

  it("41. the scanner stays DB-free and never imports the emitter or the alerts module", () => {
    for (const file of readdirSync(SCANNER_DIR).filter((f) => f.endsWith(".ts"))) {
      const text = code(readFileSync(path.join(SCANNER_DIR, file), "utf8"));
      for (const specifier of importsOf(text)) {
        expect({ file, specifier, bad: /prisma|native-alerts|\/alerts\//i.test(specifier) }).toEqual({ file, specifier, bad: false });
      }
      expect({ file, hit: /PrismaClient|@prisma\/client/.test(text) }).toEqual({ file, hit: false });
    }
  });

  it("42. the package exposes exactly one emitter script, outside the scanner script namespace", () => {
    const scripts = (JSON.parse(readFileSync(path.join(BACKEND, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(Object.entries(scripts).filter(([name, command]) => /native-alerts/.test(name) || /native-alerts/.test(command))).toEqual([
      ["native-alerts:emitter", "tsx src/modules/native-alerts/run-native-alert-emitter.ts"],
    ]);
  });

  it("43. every execution-side fence is in place, in code, with no switch", () => {
    const fence = read("src/modules/alerts/alert-source.ts");
    expect(fence).toContain('EXECUTABLE_ALERT_SOURCE = "TRADINGVIEW"');
    expect(fence).not.toMatch(/process\.env|\benv\.|config\/env|ENABLE|ALLOW_NATIVE/);

    const adoption = read("src/modules/jobs/selected-plan-adoption.service.ts");
    const discover = adoption.slice(adoption.indexOf("private async discover("), adoption.indexOf("private async claim("));
    expect(discover).toContain("alert: { source: EXECUTABLE_ALERT_SOURCE },");
    expect(discover).toContain("plans.filter((plan) => plan.alert.source === EXECUTABLE_ALERT_SOURCE)");

    const execution = read("src/modules/execution/execution.service.ts");
    const create = execution.slice(execution.indexOf("async createExecutionFromReadyPlan("), execution.indexOf("tx.tradeExecution.create("));
    expect(create).toContain('assertExecutableAlertSource({ id: input.alertId, source: alert.source }, "execution");');

    const plans = read("src/modules/extreme-rr/extreme-rr.service.ts");
    for (const method of ["async ensurePendingPlan(", "async generateForAlert("]) {
      const body = plans.slice(plans.indexOf(method), plans.indexOf(method) + 400);
      expect(body).toContain('assertNotNativeAlert(alert, "Extreme RR planning");');
    }

    expect(read("src/modules/jobs/alert-queue-recovery.service.ts")).toContain(
      'where: { status: "RECEIVED", createdAt: { lte: cutoff }, source: "TRADINGVIEW" },'
    );

    const webhook = read("src/modules/webhook/webhook.service.ts");
    expect(webhook).toContain("source: EXECUTABLE_ALERT_SOURCE,");
    expect(webhook).toContain("const existingDuplicate = recentMatch?.source === NATIVE_ALERT_SOURCE ? null : recentMatch;");
  });
});
