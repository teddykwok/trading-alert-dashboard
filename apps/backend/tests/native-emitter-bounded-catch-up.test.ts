import { describe, expect, it } from "vitest";
import type { SourceTimeframe } from "@trading-alert-dashboard/shared";

import {
  MultiSymbolNativeEmitter,
  bindPinnedRun,
  runMultiSymbolEmitter,
  type EmitterCursor,
  type MultiEmitterDeps,
  type MultiEmitterEvent,
  type PinnedRun,
} from "../src/modules/native-alerts/multi-symbol-emitter";
import type { NativeDeliveryLedgerV2, NativeDeliveryResult } from "../src/modules/native-alerts/native-alert-ledger";
import { selectNativeDeliveriesV2, type NativeDeliveryContextV2, type NativeDeliveryDecisionV2 } from "../src/modules/native-alerts/native-delivery-policy-v2";
import { ShadowLogError, ShadowLogTail, parseShadowEventLog } from "../src/modules/native-alerts/shadow-log-reader";
import type { ShadowRecord } from "../src/modules/native-scanner/live-shadow-store";
import { TEDDY_AGGRESSIVE_V1, engineFingerprintOf, profileLineageIdFor, profileSummaryOf } from "../src/modules/native-scanner/scanner-profile";
import { SUPERVISOR_RUN_MANIFEST_SCHEMA, buildRunManifest, makeRunId } from "../src/modules/native-scanner/supervisor-run-manifest";
import { BAR0, M15, bar, commit, lineOf, logOf, observation } from "./helpers/native-alert-fixtures";

/**
 * BOUNDED EMITTER CATCH-UP (Always-On Monitoring V1). A real catch-up of
 * 14,088 records failed closed with EMITTER_QUEUE_OVERFLOW against a 10,000
 * queue, because every new record was admitted before anything drained. The
 * queue stays bounded; a backlog many times its size now drains in fair
 * rounds, with every COMMIT safety property intact.
 */

const T = TEDDY_AGGRESSIVE_V1; // dashboard TFs 1D / 1W / 1M
const ENGINE = engineFingerprintOf(T);
const RUN_ID = makeRunId(Date.UTC(2026, 9, 1, 11, 0), "1a2b3c4d");
const BOOT = "c".repeat(64);
const lineageOf = (symbol: string) => profileLineageIdFor(T, symbol, BOOT);
const DELIVERABLE: SourceTimeframe[] = ["1D", "1W", "1M"];

function pinned(symbols: string[]): PinnedRun {
  const manifest = buildRunManifest({
    schema: SUPERVISOR_RUN_MANIFEST_SCHEMA,
    runId: RUN_ID,
    startedAt: "2026-10-01T11:00:00.000Z",
    gitHead: "test",
    marketType: "USDM_PERPETUAL",
    chartInterval: "15m",
    engineFingerprint: ENGINE,
    profile: profileSummaryOf(T),
    stateLayout: "ENGINE_NAMESPACE",
    selection: { mode: "TARGET", universeActive: 523, targetEligible: symbols.length, candidatesTested: symbols.length, acceptedEligible: symbols.length, skippedTooNew: 0, skippedInsufficientHistory: 0, skippedOther: 0, universeExhausted: false },
    symbols: symbols.map((symbol) => ({ symbol, lineageId: lineageOf(symbol), bootstrapInputSha256: BOOT })),
    actionable: false,
  });
  return bindPinnedRun({
    manifest,
    expect: { profileId: T.profileId, runId: RUN_ID, engineFingerprint: ENGINE },
    checkpointOf: (symbol) => ({ lineageId: lineageOf(symbol), symbol, chartInterval: "15m", marketType: "USDM_PERPETUAL" }),
  });
}

/** `bars` bars from `fromBar`: per bar one live observation per deliverable TF (3 deliveries), then its commit. */
function backlog(symbol: string, fromBar: number, bars: number): ShadowRecord[] {
  const lineageId = lineageOf(symbol);
  const records: ShadowRecord[] = [];
  for (let n = fromBar; n < fromBar + bars; n += 1) {
    DELIVERABLE.forEach((tf, i) =>
      records.push(
        observation({ symbol, lineageId, barMs: bar(n), sourceTf: tf, candidateSequence: i, updateSequence: 2 + i, eventTimeMs: bar(n) + 60_000 + i, levelPrice: 1 + i / 10, createdBarOpenTimeMs: BAR0 - (i + 1) * 30 * 96 * M15 })
      )
    );
    records.push(commit(bar(n), "SHADOW_LIVE_ONLY", lineageId, symbol));
  }
  return records;
}

const activationLog = (symbol: string) => logOf([commit(bar(0), "QUARANTINED_CURRENT_BAR", lineageOf(symbol), symbol)]);

/** Every delivery the records hold, in log order (the reference: an unbounded, one-pass evaluation). */
function expectedDeliveries(symbol: string, text: string): string[] {
  const records = parseShadowEventLog(text, { lineageId: lineageOf(symbol), marketType: "USDM_PERPETUAL", symbol, chartInterval: "15m" });
  return selectNativeDeliveriesV2(records, T.delivery).flatMap((s) => (s.kind === "DELIVER" ? [s.decision.deliveryKey] : []));
}

const recordCount = (text: string) => text.split("\n").filter((line) => line !== "").length;

/** In-memory ledger with the real ledger's idempotency, an optional injected failure, and an ordered audit trail. */
class AuditLedger implements NativeDeliveryLedgerV2 {
  readonly rows = new Map<string, NativeDeliveryDecisionV2>();
  readonly trail: string[];
  calls = 0;
  failOnCall: number | null = null;
  onCall: () => void = () => undefined;
  constructor(trail: string[]) {
    this.trail = trail;
  }
  async lookupV2(decision: NativeDeliveryDecisionV2) {
    return this.rows.has(decision.deliveryKey) ? ({ state: "DELIVERED", alertId: "a" } as const) : ({ state: "NOT_DELIVERED" } as const);
  }
  async deliverV2(decision: NativeDeliveryDecisionV2, _context: NativeDeliveryContextV2): Promise<NativeDeliveryResult> {
    this.calls += 1;
    this.onCall();
    if (this.failOnCall === this.calls) throw new Error("injected database failure before commit");
    if (this.rows.has(decision.deliveryKey)) return { outcome: "ALREADY_DELIVERED", deliveryKey: decision.deliveryKey, alertId: "a" };
    this.rows.set(decision.deliveryKey, decision);
    this.trail.push(`ledger:${decision.winner.symbol}:${decision.winner.eventId}`);
    return { outcome: "CREATED", deliveryKey: decision.deliveryKey, alertId: `alert-${this.rows.size}` };
  }
}

class AuditCursors {
  readonly saved = new Map<string, EmitterCursor>();
  readonly trail: string[];
  failAfterSaves: number | null = null;
  saves = 0;
  constructor(trail: string[]) {
    this.trail = trail;
  }
  load(symbol: string) {
    return this.saved.get(symbol) ?? null;
  }
  save(cursor: EmitterCursor) {
    if (this.failAfterSaves !== null && this.saves >= this.failAfterSaves) throw new Error("injected crash after the ledger commit, before the cursor write");
    this.saves += 1;
    this.saved.set(cursor.symbol, cursor);
    this.trail.push(`cursor:${cursor.symbol}:${cursor.consumedChars}`);
  }
}

interface Rig {
  emitter: MultiSymbolNativeEmitter;
  events: MultiEmitterEvent[];
  depths: number[];
}

function rig(input: {
  symbols: string[];
  logs: Record<string, string>;
  capacity: number;
  mode?: "DRY_RUN" | "COMMIT_DASHBOARD_ALERTS";
  ledger?: AuditLedger;
  cursors?: AuditCursors;
  activateAtEof?: boolean;
  baseline?: "PRODUCTION_CURSOR" | "DRY_RUN_FROM_START";
}): Rig {
  const events: MultiEmitterEvent[] = [];
  const depths: number[] = [];
  const commit_ = (input.mode ?? "DRY_RUN") === "COMMIT_DASHBOARD_ALERTS";
  let emitter: MultiSymbolNativeEmitter | null = null;
  const sample = () => {
    if (emitter !== null) depths.push(emitter.status().queueDepth);
  };
  if (input.ledger) input.ledger.onCall = sample;
  const deps: MultiEmitterDeps = {
    mode: input.mode ?? "DRY_RUN",
    run: pinned(input.symbols),
    readLog: (symbol) => input.logs[symbol] ?? null,
    cursors: input.cursors ?? { load: () => null },
    cursorWriter: commit_ ? (input.cursors as AuditCursors) : null,
    ledger: commit_ ? (input.ledger as AuditLedger) : null,
    baseline: input.baseline ?? (commit_ ? "PRODUCTION_CURSOR" : "DRY_RUN_FROM_START"),
    activateAtEof: input.activateAtEof ?? false,
    queueCapacity: input.capacity,
    pendingTailPolls: 0,
    nowIso: () => "2026-10-23T00:00:00.000Z",
    report: (event) => events.push(event),
    progress: sample,
  };
  emitter = new MultiSymbolNativeEmitter(deps);
  return { emitter, events, depths };
}

const once = (emitter: MultiSymbolNativeEmitter, shouldStop: () => boolean = () => false) =>
  runMultiSymbolEmitter(emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop });

/** The symbol of every processed record, in processing order (SKIPPED + DECISION events report each one). */
const processed = (events: MultiEmitterEvent[]) => events.filter((e) => e.type === "SKIPPED" || e.type === "DECISION").map((e) => (e as { symbol: string }).symbol);

/** COMMIT world: lanes activated at EOF, then a backlog appended to each. */
async function activatedWorld(symbols: string[], bars: number, capacity: number) {
  const trail: string[] = [];
  const ledger = new AuditLedger(trail);
  const cursors = new AuditCursors(trail);
  const logs: Record<string, string> = Object.fromEntries(symbols.map((s) => [s, activationLog(s)]));
  await once(rig({ symbols, logs, capacity, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors, activateAtEof: true }).emitter);
  for (const s of symbols) logs[s] += logOf(backlog(s, 1, bars));
  return { trail, ledger, cursors, logs };
}

// ===========================================================================
// The tail reader: bounded reads are the unbounded read, in pieces
// ===========================================================================

describe("ShadowLogTail.readBounded", () => {
  const symbol = "AAAUSDT";
  const identity = { lineageId: lineageOf(symbol), marketType: "USDM_PERPETUAL" as const, symbol, chartInterval: "15m" as const };
  const text = logOf(backlog(symbol, 1, 5));

  it("chunked reads return exactly the records and offsets of one unbounded read, in order", () => {
    const whole = new ShadowLogTail(identity, 0).readWithOffsets(text);
    const chunked = new ShadowLogTail(identity, 0);
    const pieces: { endChars: number; eventId: string }[] = [];
    for (let guard = 0; guard < 100 && chunked.consumedLength < text.length; guard += 1) {
      for (const e of chunked.readBounded(text, { maxRecords: 3, judgeTail: guard === 0 })) pieces.push({ endChars: e.endChars, eventId: e.record.eventId });
    }
    expect(pieces).toEqual(whole.map((e) => ({ endChars: e.endChars, eventId: e.record.eventId })));
    expect(chunked.consumedLength).toBe(text.length);
  });

  it("maxRecords 0 verifies the consumed bytes and judges the tail, consuming nothing", () => {
    const tail = new ShadowLogTail(identity, 0);
    expect(tail.readBounded(text, { maxRecords: 0, judgeTail: true })).toEqual([]);
    expect(tail.consumedLength).toBe(0);
  });

  it("stopAtChars stops at a record boundary at or before it", () => {
    const tail = new ShadowLogTail(identity, 0);
    const firstEnd = text.indexOf("\n") + 1;
    const secondEnd = text.indexOf("\n", firstEnd) + 1;
    const got = tail.readBounded(text, { maxRecords: 100, stopAtChars: secondEnd + 5, judgeTail: true });
    expect(got.map((e) => e.endChars)).toEqual([firstEnd, secondEnd]);
    expect(tail.consumedLength).toBe(secondEnd);
    expect(lineOf(backlog(symbol, 1, 5)[0]).length).toBe(firstEnd);
  });

  it("a rewritten prefix is still refused between chunks", () => {
    const tail = new ShadowLogTail(identity, 0);
    tail.readBounded(text, { maxRecords: 2, judgeTail: true });
    const rewritten = `${text.slice(0, 10)}X${text.slice(11)}`;
    expect(() => tail.readBounded(rewritten, { maxRecords: 2, judgeTail: true })).toThrow(ShadowLogError);
  });

  it("a partial final line is judged once per freshly loaded text, not once per chunk", () => {
    const partial = `${text}{"incomplete`;
    const tail = new ShadowLogTail(identity, 1);
    tail.readBounded(partial, { maxRecords: 1, judgeTail: true });
    for (let i = 0; i < 30; i += 1) tail.readBounded(partial, { maxRecords: 1, judgeTail: false });
    expect(() => tail.readBounded(partial, { maxRecords: 1, judgeTail: true })).toThrow(/torn line/);
  });
});

// ===========================================================================
// 1. A backlog several times the queue drains, never above the bound
// ===========================================================================

describe("1. a backlog of several times the queue capacity drains completely, maxQueueDepth <= capacity", () => {
  it("one lane, 12x the queue: every record read once, every delivery made once, the queue never above 10", async () => {
    const symbol = "AAAUSDT";
    const logs = { [symbol]: logOf(backlog(symbol, 1, 30)) }; // 120 records, 90 deliveries
    const r = rig({ symbols: [symbol], logs, capacity: 10 });
    await once(r.emitter);
    const s = r.emitter.status();
    expect(recordCount(logs[symbol])).toBe(120);
    expect(s.eventsRead).toBe(120);
    expect(s.wouldCreate).toBe(expectedDeliveries(symbol, logs[symbol]).length);
    expect(s.wouldCreate).toBe(90);
    expect(s.maxQueueDepth).toBeLessThanOrEqual(10);
    expect(Math.max(...r.depths)).toBeLessThanOrEqual(10);
    expect(s.queueDepth).toBe(0);
    expect(s.catchUp.rounds).toBeGreaterThanOrEqual(12);
    expect(s.catchUp.recordsAdmitted).toBe(120);
    expect(s.catchUp.backlogLanes).toBe(0);
  });

  it("COMMIT, five lanes, a backlog > 3x the queue: drains to zero, every Alert once, queueDepth <= capacity at every ledger call", async () => {
    const symbols = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"];
    const w = await activatedWorld(symbols, 4, 16); // 5 x 16 records = 80 > 3 x 16
    const r = rig({ symbols, logs: w.logs, capacity: 16, mode: "COMMIT_DASHBOARD_ALERTS", ledger: w.ledger, cursors: w.cursors });
    await once(r.emitter);
    const s = r.emitter.status();
    expect(s.created).toBe(symbols.length * 4 * 3);
    expect(s.ledgerDuplicates).toBe(0);
    expect(w.ledger.rows.size).toBe(60);
    expect(s.maxQueueDepth).toBeLessThanOrEqual(16);
    expect(Math.max(...r.depths)).toBeLessThanOrEqual(16);
    expect(r.depths.length).toBeGreaterThan(60);
    for (const sym of symbols) expect(w.cursors.saved.get(sym)?.consumedChars).toBe(w.logs[sym].length);
    expect(s.queueDepth).toBe(0);
  });

  it("follow mode: a backlog appended after start (larger than the queue) is drained by poll() in rounds", async () => {
    const symbols = ["AAAUSDT", "BBBUSDT"];
    const logs: Record<string, string> = { AAAUSDT: "", BBBUSDT: "" };
    const r = rig({ symbols, logs, capacity: 10 });
    await r.emitter.initialize();
    for (const s of symbols) logs[s] = logOf(backlog(s, 1, 10));
    await r.emitter.poll();
    const st = r.emitter.status();
    expect(st.eventsRead).toBe(80);
    expect(st.maxQueueDepth).toBeLessThanOrEqual(10);
    expect(st.queueDepth).toBe(0);
  });

  it("when everything fits, one round admits it all and the processing order is exactly the unbounded order", async () => {
    const symbols = ["AAAUSDT", "BBBUSDT", "CCCUSDT"];
    const logs = Object.fromEntries(symbols.map((s) => [s, logOf(backlog(s, 1, 3))]));
    const big = rig({ symbols, logs, capacity: 100_000 });
    const exact = rig({ symbols, logs, capacity: 36 }); // exactly the backlog
    await once(big.emitter);
    await once(exact.emitter);
    expect(exact.emitter.status().catchUp.rounds).toBe(1);
    expect(processed(exact.events)).toEqual(processed(big.events));
    expect(exact.events.filter((e) => e.type === "DECISION").map((e) => (e as { decision: { deliveryKey: string } }).decision.deliveryKey)).toEqual(
      big.events.filter((e) => e.type === "DECISION").map((e) => (e as { decision: { deliveryKey: string } }).decision.deliveryKey)
    );
  });
});

// ===========================================================================
// 2. Per-lane order and cross-lane fairness
// ===========================================================================

describe("2. multiple lanes with large backlogs keep each lane's log order and drain fairly", () => {
  it("every lane's deliveries come out in its log order; no lane runs ahead of another by more than one round's share", async () => {
    const symbols = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT"];
    const logs = Object.fromEntries(symbols.map((s) => [s, logOf(backlog(s, 1, 25))])); // 100 records per lane
    const r = rig({ symbols, logs, capacity: 12 }); // share = 3 per lane per round
    await once(r.emitter);
    for (const s of symbols) {
      const got = r.events.filter((e) => e.type === "DECISION" && e.symbol === s).map((e) => (e as { decision: { deliveryKey: string } }).decision.deliveryKey);
      expect(got).toEqual(expectedDeliveries(s, logs[s]));
    }
    const order = processed(r.events);
    expect(order).toHaveLength(400);
    const counts = Object.fromEntries(symbols.map((s) => [s, 0]));
    let maxSpread = 0;
    for (const s of order) {
      counts[s] += 1;
      const values = Object.values(counts);
      maxSpread = Math.max(maxSpread, Math.max(...values) - Math.min(...values));
    }
    expect(maxSpread).toBeLessThanOrEqual(3);
    expect(r.emitter.status().maxQueueDepth).toBeLessThanOrEqual(12);
  });

  it("a lane with a small backlog finishes early; the big lane then gets the whole queue — nothing waits behind the bound", async () => {
    const logs = { AAAUSDT: logOf(backlog("AAAUSDT", 1, 1)), ZZZUSDT: logOf(backlog("ZZZUSDT", 1, 40)) };
    const r = rig({ symbols: ["AAAUSDT", "ZZZUSDT"], logs, capacity: 10 });
    await once(r.emitter);
    expect(r.emitter.status().eventsRead).toBe(4 + 160);
    expect(processed(r.events).slice(0, 8).filter((s) => s === "AAAUSDT")).toHaveLength(4);
  });
});

// ===========================================================================
// 3 / 4. COMMIT ordering: ledger first, cursor after; a failure never skips
// ===========================================================================

describe("3. COMMIT: the ledger transaction succeeds BEFORE any cursor advances past its record", () => {
  it("for every cursor write, every delivery at or before that position is already in the ledger", async () => {
    const symbols = ["AAAUSDT", "BBBUSDT", "CCCUSDT"];
    const w = await activatedWorld(symbols, 5, 10);
    w.trail.length = 0;
    const r = rig({ symbols, logs: w.logs, capacity: 10, mode: "COMMIT_DASHBOARD_ALERTS", ledger: w.ledger, cursors: w.cursors });
    await once(r.emitter);
    const committed = new Set<string>();
    for (const entry of w.trail) {
      const [kind, symbol, value] = entry.split(":");
      if (kind === "ledger") {
        committed.add(value);
        continue;
      }
      const position = Number(value);
      const text = w.logs[symbol].slice(0, position);
      for (const line of text.split("\n").filter((l) => l !== "")) {
        // The activation log holds only a commit, so every observation here is post-activation and deliverable.
        const record = JSON.parse(line) as { kind: string; sourceTf?: string; eventId: string };
        if (record.kind === "LIVE_IMMEDIATE_OBSERVATION" && DELIVERABLE.includes(record.sourceTf as SourceTimeframe)) {
          expect({ cursor: entry, event: record.eventId, committed: committed.has(record.eventId) }).toEqual({ cursor: entry, event: record.eventId, committed: true });
        }
      }
    }
    expect(w.ledger.rows.size).toBe(45);
  });
});

describe("4. a ledger failure never advances a cursor past the failed record; the restart delivers it", () => {
  it("fails on the 9th delivery mid-catch-up: no cursor passes it, and the restart completes with each Alert exactly once", async () => {
    const symbols = ["AAAUSDT", "BBBUSDT"];
    const w = await activatedWorld(symbols, 6, 10);
    w.ledger.failOnCall = w.ledger.calls + 9;
    let failedKey: string | null = null;
    const r = rig({ symbols, logs: w.logs, capacity: 10, mode: "COMMIT_DASHBOARD_ALERTS", ledger: w.ledger, cursors: w.cursors });
    const original = w.ledger.deliverV2.bind(w.ledger);
    w.ledger.deliverV2 = async (decision, context) => {
      if (w.ledger.calls + 1 === w.ledger.failOnCall) failedKey = `${decision.winner.symbol}:${decision.winner.eventId}`;
      return original(decision, context);
    };
    await expect(once(r.emitter)).rejects.toThrow(/database failure/);
    const [failedSymbol, failedEvent] = (failedKey as unknown as string).split(":");
    const failedLineEnd = w.logs[failedSymbol].indexOf(failedEvent);
    expect(w.cursors.saved.get(failedSymbol)!.consumedChars).toBeLessThan(failedLineEnd);
    expect(w.ledger.rows.has(failedKey!)).toBe(false);
    w.ledger.failOnCall = null;
    const again = rig({ symbols, logs: w.logs, capacity: 10, mode: "COMMIT_DASHBOARD_ALERTS", ledger: w.ledger, cursors: w.cursors });
    await once(again.emitter);
    expect(w.ledger.rows.size).toBe(2 * 6 * 3);
    for (const sym of symbols) expect(w.cursors.saved.get(sym)!.consumedChars).toBe(w.logs[sym].length);
  });
});

// ===========================================================================
// 5 / 6. Stops and crashes: only processed positions persist; never a duplicate
// ===========================================================================

describe("5. a graceful stop with queued (and unadmitted) work persists only processed positions; the restart re-reads the rest", () => {
  it("stops mid-catch-up: cursors are at processed records only, the restart finishes, no Alert is lost or duplicated", async () => {
    const symbols = ["AAAUSDT", "BBBUSDT", "CCCUSDT"];
    const w = await activatedWorld(symbols, 8, 10);
    let processedCount = 0;
    const r = rig({ symbols, logs: w.logs, capacity: 10, mode: "COMMIT_DASHBOARD_ALERTS", ledger: w.ledger, cursors: w.cursors });
    const stopAt = 20;
    await once(r.emitter, () => {
      processedCount = processed(r.events).length;
      return processedCount >= stopAt;
    });
    const stopped = r.emitter.status();
    expect(stopped.stoppedWithPending + stopped.catchUp.backlogLanes).toBeGreaterThan(0);
    for (const sym of symbols) {
      const cursor = w.cursors.saved.get(sym)!;
      expect(cursor.consumedChars).toBeLessThan(w.logs[sym].length);
      expect(w.logs[sym].slice(0, cursor.consumedChars).endsWith("\n")).toBe(true);
    }
    const createdBefore = w.ledger.rows.size;
    expect(createdBefore).toBeGreaterThan(0);
    const restart = rig({ symbols, logs: w.logs, capacity: 10, mode: "COMMIT_DASHBOARD_ALERTS", ledger: w.ledger, cursors: w.cursors });
    await once(restart.emitter);
    expect(w.ledger.rows.size).toBe(3 * 8 * 3);
    expect(restart.emitter.status().ledgerDuplicates).toBe(0);
  });
});

describe("6. a crash (no graceful stop) mid-catch-up cannot create a duplicate Alert", () => {
  it("cursor writes die after the ledger commits; the restart replays harmlessly — the ledger is the final duplicate fence", async () => {
    const symbols = ["AAAUSDT", "BBBUSDT"];
    const w = await activatedWorld(symbols, 7, 10);
    w.cursors.failAfterSaves = w.cursors.saves + 4; // dies a few writes into the catch-up
    const crashing = rig({ symbols, logs: w.logs, capacity: 10, mode: "COMMIT_DASHBOARD_ALERTS", ledger: w.ledger, cursors: w.cursors });
    await expect(once(crashing.emitter)).rejects.toThrow(/cursor write/);
    const afterCrash = w.ledger.rows.size;
    expect(afterCrash).toBeGreaterThan(0);
    w.cursors.failAfterSaves = null;
    const restart = rig({ symbols, logs: w.logs, capacity: 10, mode: "COMMIT_DASHBOARD_ALERTS", ledger: w.ledger, cursors: w.cursors });
    await once(restart.emitter);
    const s = restart.emitter.status();
    expect(w.ledger.rows.size).toBe(2 * 7 * 3);
    expect(s.created).toBe(2 * 7 * 3 - afterCrash);
    // The record whose cursor write died was committed but not cursored: replayed, deduplicated by the ledger.
    expect(s.ledgerDuplicates).toBeGreaterThan(0);
  });
});

describe("a refused line fails its lane closed; nothing of the failing batch is delivered; other lanes finish", () => {
  it("met on a second read inside one admission round: the lane's already-queued records are DROPPED unprocessed, its cursor stays put", async () => {
    const symbols = ["AAAUSDT", "BBBUSDT"];
    const trail: string[] = [];
    const ledger = new AuditLedger(trail);
    const cursors = new AuditCursors(trail);
    const logs: Record<string, string> = Object.fromEntries(symbols.map((s) => [s, activationLog(s)]));
    await once(rig({ symbols, logs, capacity: 12, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors, activateAtEof: true }).emitter);
    const before = cursors.saved.get("BBBUSDT")!.consumedChars;
    // AAA: one record. BBB: 7 valid records, then a refused one. Capacity 12, two lanes: round 1 gives each a
    // share of 6 (AAA takes 1, BBB takes 6 — queued); round 2 gives BBB the remaining 5 and meets the bad line.
    logs.AAAUSDT += logOf([commit(bar(1), "SHADOW_LIVE_ONLY", lineageOf("AAAUSDT"), "AAAUSDT")]);
    logs.BBBUSDT += `${logOf(backlog("BBBUSDT", 1, 2).slice(0, 7))}{"not": "a shadow record"}\n`;
    const r = rig({ symbols, logs, capacity: 12, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors });
    await once(r.emitter);
    const s = r.emitter.status();
    expect(s.symbolsFailed).toBe(1);
    expect(s.cursors.lanes.find((l) => l.symbol === "BBBUSDT")?.failure).toMatch(/^ACTIONABLE_RECORD/);
    // None of BBB's six queued records — three of them deliverable — reached the ledger.
    expect(r.events.filter((e) => e.type === "DECISION" && e.symbol === "BBBUSDT")).toEqual([]);
    expect(ledger.calls).toBe(0);
    expect(cursors.saved.get("BBBUSDT")!.consumedChars).toBe(before);
    expect(cursors.saved.get("AAAUSDT")!.consumedChars).toBe(logs.AAAUSDT.length);
    expect(s.queueDepth).toBe(0);
    expect(s.maxQueueDepth).toBeLessThanOrEqual(12);
  });
});
