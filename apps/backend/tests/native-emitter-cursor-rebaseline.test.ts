import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { MULTI_EMITTER_DEFAULTS } from "../src/modules/native-alerts/multi-emitter-cli-args";
import { EMITTER_CURSOR_SCHEMA, MultiSymbolNativeEmitter, QueueOverflowError, bindPinnedRun, cursorMismatch, type EmitterCursor, type MultiEmitterEvent } from "../src/modules/native-alerts/multi-symbol-emitter";
import {
  PLAN_FILE,
  RESULT_FILE,
  RebaselineRefusal,
  TRANSACTION_FILE,
  beforeFileOf,
  commitRebaseline,
  cursorFileText,
  openOperations,
  prepareRebaseline,
  resumeRebaseline,
  targetCursorOf,
  type RebaselineSource,
  type RebaselineStore,
} from "../src/modules/native-alerts/native-emitter-cursor-rebaseline";
import { RebaselineCliUsageError, parseRebaselineCliArgs } from "../src/modules/native-alerts/native-emitter-rebaseline-cli-args";
import { NativeDeliverySelectorV2 } from "../src/modules/native-alerts/native-delivery-policy-v2";
import { FileEmitterCursorStore, FileRebaselineStore, emitterCursorDir, emitterRebaselineDir } from "../src/modules/native-alerts/native-emitter-state-files";
import { LIVE_CHECKPOINT_SCHEMA, LiveCheckpointStore } from "../src/modules/native-scanner/live-shadow-checkpoint";
import type { MembershipChange } from "../src/modules/native-scanner/live-shadow-supervisor";
import { membershipLine } from "../src/modules/native-scanner/run-membership";
import { HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1, type SymbolHistoryOrigin } from "../src/modules/native-scanner/scanner-lineage";
import { TEDDY_7_ALL_ACTIVE_V1, engineFingerprintOf, liveShadowEngineDir, profileLineageIdFor, profileSummaryOf } from "../src/modules/native-scanner/scanner-profile";
import { buildRunManifest, makeRunId, runManifestText } from "../src/modules/native-scanner/supervisor-run-manifest";
import { M15, commit as fixtureCommit, lineOf, logOf, observation } from "./helpers/native-alert-fixtures";

/**
 * NATIVE_EMITTER_CURSOR_REBASELINE_V1: acknowledge a STOPPED run's durable
 * shadow logs as historical for delivery by advancing the emitter's production
 * cursors to their exact durable EOF — and nothing else. Synthetic state only:
 * in-memory sources and stores, temp directories, and the real CLI against a
 * temp LOCALAPPDATA. Nothing here reads the real scanner tree or any network.
 */

const N = TEDDY_7_ALL_ACTIVE_V1;
const FP = engineFingerprintOf(N);
const RUN_ID = makeRunId(Date.UTC(2026, 9, 9, 6, 53), "bbb0c078");
const BOOT = "e".repeat(64);
const iso = (s: string) => Date.parse(s);
const PROFILE_ORIGIN: SymbolHistoryOrigin = {
  semantics: HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1, kind: "PROFILE_CONTEXT" as const, firstClosedBarOpenTimeMs: null,
  effectiveContextStartMs: iso("2025-12-29T00:00:00Z"), effectiveHistoryStartMs: iso("2026-01-01T00:00:00Z"), effectiveSwitchoverMs: iso("2026-09-12T01:00:00Z"),
};
const LISTING_ORIGIN: SymbolHistoryOrigin = {
  semantics: HISTORY_ORIGIN_SYMBOL_FIRST_CLOSED_BAR_V1, kind: "SYMBOL_FIRST_CLOSED_BAR" as const, firstClosedBarOpenTimeMs: iso("2026-10-01T10:00:00Z"),
  effectiveContextStartMs: iso("2026-10-01T10:00:00Z"), effectiveHistoryStartMs: iso("2026-10-01T10:00:00Z"), effectiveSwitchoverMs: iso("2026-10-01T10:15:00Z"),
};
const JOINED = new Set(["龙虾USDT", "NEWUSDT"]);
const originOf = (symbol: string) => (JOINED.has(symbol) ? LISTING_ORIGIN : PROFILE_ORIGIN);
const lineageOf = (symbol: string) => profileLineageIdFor(N, symbol, BOOT, originOf(symbol));
const BAR = Date.UTC(2026, 9, 9, 2, 0);
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** n live, DELIVERABLE (1D/1W/1M) observations each followed by its bar commit: a real backlog. */
function logFor(symbol: string, n: number): string {
  const records = [];
  for (let i = 0; i < n; i += 1) {
    records.push(observation({ symbol, lineageId: lineageOf(symbol), barMs: BAR + i * M15, sourceTf: (["1D", "1W", "1M"] as const)[i % 3], createdBarOpenTimeMs: BAR - 96 * M15 - i * 96 * M15, levelPrice: 1 + i }));
    records.push(fixtureCommit(BAR + i * M15, "SHADOW_LIVE_ONLY", lineageOf(symbol), symbol));
  }
  return logOf(records);
}
/** Record boundaries (end offsets) of a log, for valid cursor positions. */
const boundaries = (text: string) => [0, ...[...text.matchAll(/\n/g)].map((m) => (m.index as number) + 1)];

function cursorAt(symbol: string, text: string, consumedChars: number, activationChars = consumedChars, over: Partial<EmitterCursor> = {}): EmitterCursor {
  return {
    schema: EMITTER_CURSOR_SCHEMA, profileId: N.profileId, engineFingerprint: FP, deliveryPolicyVersion: "NATIVE_DELIVERY_V2", marketType: "USDM_PERPETUAL", chartInterval: "15m",
    symbol, lineageId: lineageOf(symbol), consumedChars, consumedSha256: sha(text.slice(0, consumedChars)), activationChars, activatedAt: "2026-10-05T10:50:00.000Z", activatedByRunId: makeRunId(Date.UTC(2026, 9, 5, 10, 49), "bae13f47"), updatedAt: "2026-10-05T11:10:00.000Z",
    ...over,
  };
}

function manifestTextFor(symbols: readonly string[], dynamic = true, fingerprint = FP): string {
  return runManifestText(
    buildRunManifest({
      schema: "teddy.native-scanner.supervisor-run-manifest.v2",
      runId: RUN_ID, startedAt: "2026-10-09T06:53:09.738Z", gitHead: "t", marketType: "USDM_PERPETUAL", chartInterval: "15m",
      engineFingerprint: fingerprint, profile: profileSummaryOf(N), stateLayout: "ENGINE_NAMESPACE",
      selection: { mode: "ALL_ACTIVE", universeActive: symbols.length, targetEligible: null, candidatesTested: symbols.length, acceptedEligible: symbols.length, skippedTooNew: 0, skippedInsufficientHistory: 0, skippedOther: 0, universeExhausted: true },
      symbols: symbols.map((symbol) => ({ symbol, lineageId: lineageOf(symbol), bootstrapInputSha256: BOOT, symbolHistoryOrigin: originOf(symbol) })),
      actionable: false,
      membership: dynamic ? { mode: "DYNAMIC_JOURNAL", journal: "membership.jsonl", journalSchema: "teddy.native-scanner.run-membership.v1" } : null,
    })
  );
}
const change = (kind: MembershipChange["kind"], symbol: string, lineageId: string | null = lineageOf(symbol)): MembershipChange => ({
  kind, symbol, lineageId, bootstrapInputSha256: kind === "JOINED" || kind === "REACTIVATED" ? BOOT : null, symbolHistoryOrigin: originOf(symbol), reason: null, at: "2026-10-09T07:30:00.000Z",
});
function journalOf(changes: readonly MembershipChange[]): string {
  let previous: string | null = null;
  let text = "";
  changes.forEach((c, i) => {
    const line = membershipLine(RUN_ID, i + 1, previous, c);
    text += line;
    previous = line.slice(0, -1);
  });
  return text;
}
const statusText = (runState: string, runId = RUN_ID, fingerprint = FP) => JSON.stringify({ runId, runState, engineFingerprint: fingerprint, symbols: [] });

/** An in-memory world: the pinned run, its logs, checkpoints and cursors. */
function world(opts: { manifest?: readonly string[]; journal?: readonly MembershipChange[] | string; logs?: Record<string, string>; cursors?: Record<string, string>; runState?: string } = {}) {
  const manifest = opts.manifest ?? ["AAAUSDT", "BBBUSDT", "CCCUSDT"];
  const logs: Record<string, string> = { ...Object.fromEntries([...manifest, ...JOINED].map((s) => [s, logFor(s, 4)])), ...opts.logs };
  const cursors: Record<string, string> = { ...opts.cursors };
  const journal = typeof opts.journal === "string" ? opts.journal : journalOf(opts.journal ?? []);
  const writers: Record<string, string> = {};
  const unreadable = new Set<string>();
  const source: RebaselineSource = {
    manifestText: manifestTextFor(manifest),
    runStatusText: statusText(opts.runState ?? "STOPPED"),
    membershipText: () => (journal === "" ? null : journal),
    readLog: (s) => {
      if (unreadable.has(s)) throw new Error("EACCES: permission denied");
      return logs[s] ?? null;
    },
    checkpointOf: (s) => ({ lineageId: lineageOf(s), symbol: s, chartInterval: "15m", marketType: "USDM_PERPETUAL" }),
    readCursorFile: (s) => cursors[s] ?? null,
    liveWriterOf: (s) => writers[s] ?? null,
  };
  const evidence = new Map<string, string>();
  let writesUntilCrash = Number.POSITIVE_INFINITY;
  const cursorWrites: string[] = [];
  const store: RebaselineStore = {
    listOperations: () => [...new Set([...evidence.keys()].map((k) => k.split("/")[0]))],
    readEvidence: (op, name) => evidence.get(`${op}/${name}`) ?? null,
    writeEvidenceOnce: (op, name, text) => {
      if (evidence.has(`${op}/${name}`)) throw new Error("EEXIST");
      evidence.set(`${op}/${name}`, text);
    },
    replaceEvidence: (op, name, text) => void evidence.set(`${op}/${name}`, text),
    readCursorFile: (s) => cursors[s] ?? null,
    writeCursor: (c) => {
      if (writesUntilCrash <= 0) throw new Error("SIMULATED CRASH");
      writesUntilCrash -= 1;
      cursors[c.symbol] = cursorFileText(c);
      cursorWrites.push(c.symbol);
    },
  };
  const request = { profileId: N.profileId, runId: RUN_ID, engineFingerprint: FP };
  return {
    source, store, logs, cursors, writers, unreadable, evidence, cursorWrites, request,
    crashAfter: (n: number) => (writesUntilCrash = n),
    noCrash: () => (writesUntilCrash = Number.POSITIVE_INFINITY),
    prepare: () => prepareRebaseline(request, source),
  };
}
type World = ReturnType<typeof world>;

const refusal = (fn: () => unknown): RebaselineRefusal => {
  try {
    fn();
  } catch (error) {
    if (error instanceof RebaselineRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};
const laneCodes = (r: RebaselineRefusal) => r.lanes.map((l) => [l.symbol, l.code]);
const commitAll = (w: World, createdAt = "2026-10-10T01:00:00.000Z") => {
  const prepared = w.prepare();
  return commitRebaseline({ prepared, expectedPlanSha256: prepared.planSha256, createdAt, nowIso: () => "2026-10-10T01:00:01.000Z", store: w.store, readLog: w.source.readLog });
};

// ===========================================================================
// CLI
// ===========================================================================

describe("CLI arguments", () => {
  const base = ["--profile", "teddy-7-all-active", "--run-id", RUN_ID, "--expect-engine-fingerprint", FP];
  it("is a DRY RUN by default; commit needs --commit-rebaseline AND the reviewed plan hash", () => {
    expect(parseRebaselineCliArgs(base)).toMatchObject({ mode: "DRY_RUN", expectPlanSha256: null, top: 10, verbose: false, json: false });
    expect(parseRebaselineCliArgs([...base, "--commit-rebaseline", "--expect-plan-sha256", "a".repeat(64)])).toMatchObject({ mode: "COMMIT_REBASELINE", expectPlanSha256: "a".repeat(64) });
    expect(() => parseRebaselineCliArgs([...base, "--commit-rebaseline"])).toThrow(/expect-plan-sha256/);
    expect(() => parseRebaselineCliArgs([...base, "--expect-plan-sha256", "a".repeat(64)])).toThrow(/only applies with --commit-rebaseline/);
  });

  it("requires profile, run and fingerprint; refuses bad values, unknown and duplicate arguments", () => {
    for (const drop of ["--profile", "--run-id", "--expect-engine-fingerprint"]) {
      const i = base.indexOf(drop);
      expect(() => parseRebaselineCliArgs([...base.slice(0, i), ...base.slice(i + 2)]), drop).toThrow(RebaselineCliUsageError);
    }
    const bad = (args: string[]) => () => parseRebaselineCliArgs(args);
    expect(bad(["--profile", "teddy-7-all-active", "--run-id", "run-1", "--expect-engine-fingerprint", FP])).toThrow(/run-id/);
    expect(bad(["--profile", "teddy-7-all-active", "--run-id", RUN_ID, "--expect-engine-fingerprint", "XYZ"])).toThrow(/fingerprint/);
    expect(bad([...base, "--commit-rebaseline", "--expect-plan-sha256", "nothex"])).toThrow(/SHA-256/);
    for (const unknown of ["--activate-at-eof", "--commit-dashboard-alerts", "--queue-capacity", "--account", "--binance", "--execute", "--force"]) {
      expect(bad([...base, unknown, "1"]), unknown).toThrow(/unexpected argument/);
    }
    expect(bad([...base, "--run-id", RUN_ID])).toThrow(/given twice/);
    expect(bad([...base, "--verbose", "--verbose"])).toThrow(/given twice/);
    expect(bad([...base, "--commit-rebaseline", "--expect-plan-sha256", "a".repeat(64), "--json"])).toThrow(/dry-run output/);
  });
});

// ===========================================================================
// Run fencing
// ===========================================================================

describe("run fencing", () => {
  it("binds the exact profile, run and engine fingerprint; any mismatch refuses", () => {
    const w = world();
    expect(refusal(() => prepareRebaseline({ ...w.request, profileId: "TEDDY_AGGRESSIVE_V1" }, w.source)).message).toMatch(/PROFILE_MISMATCH/);
    expect(refusal(() => prepareRebaseline({ ...w.request, engineFingerprint: "9".repeat(64) }, { ...w.source, runStatusText: statusText("STOPPED", RUN_ID, "9".repeat(64)) })).message).toMatch(/ENGINE_FINGERPRINT_MISMATCH/);
    expect(refusal(() => prepareRebaseline({ ...w.request, runId: makeRunId(Date.UTC(2026, 9, 9, 7, 0), "12345678") }, w.source)).code).toBe("RUN_STATUS_UNKNOWN");
    expect(refusal(() => prepareRebaseline(w.request, { ...w.source, manifestText: null })).code).toBe("NO_MANIFEST");
  });

  it("the pinned run must be durably STOPPED: RUNNING, unknown or unreadable status refuses", () => {
    expect(refusal(() => world({ runState: "RUNNING" }).prepare()).code).toBe("RUN_NOT_STOPPED");
    const w = world();
    expect(refusal(() => prepareRebaseline(w.request, { ...w.source, runStatusText: null })).code).toBe("RUN_STATUS_UNKNOWN");
    expect(refusal(() => prepareRebaseline(w.request, { ...w.source, runStatusText: "{torn" })).code).toBe("RUN_STATUS_UNKNOWN");
    expect(world().prepare().body.runState).toBe("STOPPED");
  });

  it("a live writer holding a lane's scanner lock refuses; an unknowable lock refuses (unknown is not absent)", () => {
    const w = world();
    w.writers.BBBUSDT = "live process 4242 (scanner:live-shadow-supervisor) holds the lane's scanner lock";
    expect(laneCodes(refusal(() => w.prepare()))).toEqual([["BBBUSDT", "LIVE_WRITER"]]);
    const u = world();
    const unknowable: RebaselineSource = {
      ...u.source,
      liveWriterOf: (s: string) => {
        if (s === "CCCUSDT") throw new Error("lock unreadable");
        return null;
      },
    };
    expect(laneCodes(refusal(() => prepareRebaseline(u.request, unknowable)))).toEqual([["CCCUSDT", "LOCK_UNKNOWN"]]);
  });
});

// ===========================================================================
// Cursor behaviour
// ===========================================================================

describe("cursor behaviour", () => {
  it("behind EOF -> WOULD_ADVANCE, at EOF -> ALREADY_AT_EOF, missing -> WOULD_INITIALIZE (reported separately)", () => {
    const logA = logFor("AAAUSDT", 4);
    const logB = logFor("BBBUSDT", 4);
    const w = world({ cursors: { AAAUSDT: cursorFileText(cursorAt("AAAUSDT", logA, boundaries(logA)[2], boundaries(logA)[1])), BBBUSDT: cursorFileText(cursorAt("BBBUSDT", logB, logB.length)) } });
    const { body } = w.prepare();
    expect(body.lanes.map((l) => [l.symbol, l.action, l.previous?.cursor.consumedChars ?? null, l.eofChars])).toEqual([
      ["AAAUSDT", "WOULD_ADVANCE", boundaries(logA)[2], logA.length],
      ["BBBUSDT", "ALREADY_AT_EOF", logB.length, logB.length],
      ["CCCUSDT", "WOULD_INITIALIZE", null, w.logs.CCCUSDT.length],
    ]);
    expect(body.totals).toMatchObject({ lanes: 3, existingCursors: 2, missingCursors: 1, alreadyAtEof: 1, wouldAdvance: 1, wouldInitialize: 1, proposedEofChars: logA.length + logB.length + w.logs.CCCUSDT.length });
  });

  it("a cursor beyond EOF, a rewritten log, a cursor off a record boundary or for another lineage refuses the whole operation", () => {
    const log = logFor("AAAUSDT", 4);
    const beyond = world({ cursors: { AAAUSDT: cursorFileText(cursorAt("AAAUSDT", `${log}${lineOf({ x: 1 })}`, log.length + 8)) } });
    expect(laneCodes(refusal(() => beyond.prepare()))).toEqual([["AAAUSDT", "CURSOR_BEYOND_EOF"]]);
    const rewritten = world({ cursors: { AAAUSDT: cursorFileText({ ...cursorAt("AAAUSDT", log, boundaries(log)[2]), consumedSha256: "f".repeat(64) }) } });
    expect(laneCodes(refusal(() => rewritten.prepare()))).toEqual([["AAAUSDT", "LOG_REWRITTEN"]]);
    const offBoundary = world({ cursors: { AAAUSDT: cursorFileText(cursorAt("AAAUSDT", log, 7, 0)) } });
    expect(laneCodes(refusal(() => offBoundary.prepare()))).toEqual([["AAAUSDT", "CURSOR_NOT_ON_RECORD_BOUNDARY"]]);
    const otherLineage = world({ cursors: { AAAUSDT: cursorFileText(cursorAt("AAAUSDT", log, 0, 0, { lineageId: "1".repeat(64) })) } });
    expect(laneCodes(refusal(() => otherLineage.prepare()))).toEqual([["AAAUSDT", "CURSOR_MISMATCH"]]);
    const corrupt = world({ cursors: { AAAUSDT: "{not json" } });
    expect(laneCodes(refusal(() => corrupt.prepare()))).toEqual([["AAAUSDT", "CURSOR_UNREADABLE"]]);
  });

  it("a lineage the profile does not rebuild, or a missing/different checkpoint, refuses", () => {
    const w = world();
    const bad = refusal(() => prepareRebaseline(w.request, { ...w.source, checkpointOf: (s) => (s === "BBBUSDT" ? { lineageId: "2".repeat(64), symbol: s, chartInterval: "15m", marketType: "USDM_PERPETUAL" } : s === "CCCUSDT" ? null : w.source.checkpointOf(s)) }));
    expect(bad.lanes.map((l) => [l.symbol, l.code, l.detail.split(":")[0]])).toEqual([["BBBUSDT", "BINDING", "CHECKPOINT_MISMATCH"], ["CCCUSDT", "BINDING", "CHECKPOINT_MISSING"]]);
  });

  it("COMMIT advances exactly to the preflighted EOF, keeps the original activation, and initializes AT EOF", () => {
    const logA = logFor("AAAUSDT", 4);
    const original = cursorAt("AAAUSDT", logA, boundaries(logA)[2], boundaries(logA)[1]);
    const w = world({ cursors: { AAAUSDT: cursorFileText(original) } });
    const outcome = commitAll(w);
    expect(outcome.kind).toBe("COMMITTED");
    const a = JSON.parse(w.cursors.AAAUSDT) as EmitterCursor;
    expect(a).toEqual({ ...original, consumedChars: logA.length, consumedSha256: sha(logA), updatedAt: "2026-10-10T01:00:00.000Z" });
    expect([a.activationChars, a.activatedAt, a.activatedByRunId]).toEqual([original.activationChars, original.activatedAt, original.activatedByRunId]);
    const c = JSON.parse(w.cursors.CCCUSDT) as EmitterCursor;
    expect(c).toMatchObject({ consumedChars: w.logs.CCCUSDT.length, activationChars: w.logs.CCCUSDT.length, activatedByRunId: RUN_ID, activatedAt: "2026-10-10T01:00:00.000Z" });
    // Every written cursor is one the normal emitter accepts for its lane.
    for (const s of ["AAAUSDT", "BBBUSDT", "CCCUSDT"]) {
      expect(cursorMismatch(JSON.parse(w.cursors[s]), { profileId: N.profileId, engineFingerprint: FP, chartInterval: "15m", symbol: s, lineageId: lineageOf(s) })).toBeNull();
    }
  });
});

// ===========================================================================
// Log integrity
// ===========================================================================

describe("log integrity: EOF is the end of the last COMPLETE record", () => {
  it("a complete log is accepted; a torn final record, a malformed tail, an empty line, an unreadable or missing log refuse", () => {
    expect(() => world().prepare()).not.toThrow();
    const log = logFor("AAAUSDT", 4);
    expect(laneCodes(refusal(() => world({ logs: { AAAUSDT: `${log}{"partial":` } }).prepare()))).toEqual([["AAAUSDT", "TORN_LINE"]]);
    expect(laneCodes(refusal(() => world({ logs: { AAAUSDT: `${log}not json\n` } }).prepare()))).toEqual([["AAAUSDT", "NOT_JSON"]]);
    expect(laneCodes(refusal(() => world({ logs: { AAAUSDT: `${log}\n` } }).prepare()))).toEqual([["AAAUSDT", "TORN_LINE"]]);
    const u = world();
    u.unreadable.add("BBBUSDT");
    expect(laneCodes(refusal(() => u.prepare()))).toEqual([["BBBUSDT", "LOG_UNREADABLE"]]);
    const missing = world();
    delete missing.logs.CCCUSDT;
    expect(laneCodes(refusal(() => missing.prepare()))).toEqual([["CCCUSDT", "LOG_MISSING"]]);
  });

  it("every lane is preflighted before the first write: one bad lane at the end refuses and nothing is written", () => {
    const w = world({ manifest: ["AAAUSDT", "BBBUSDT", "ZZZUSDT"], logs: { ZZZUSDT: `${logFor("ZZZUSDT", 2)}{"torn` } });
    expect(laneCodes(refusal(() => commitAll(w)))).toEqual([["ZZZUSDT", "TORN_LINE"]]);
    expect(w.cursorWrites).toEqual([]);
    expect(w.evidence.size).toBe(0);
  });
});

// ===========================================================================
// Dynamic universe and Unicode
// ===========================================================================

describe("dynamic universe membership", () => {
  it("covers the manifest's lanes AND every valid later JOINED lane (Unicode included, exact identity and encoded path)", () => {
    const w = world({ journal: [change("JOINED", "龙虾USDT"), change("INACTIVE", "AAAUSDT"), change("JOINED", "NEWUSDT")] });
    const { body } = w.prepare();
    expect(body.lanes.map((l) => [l.symbol, l.segment])).toEqual([
      ["AAAUSDT", "AAAUSDT"],
      ["BBBUSDT", "BBBUSDT"],
      ["CCCUSDT", "CCCUSDT"],
      ["NEWUSDT", "NEWUSDT"],
      ["龙虾USDT", `u-${Buffer.from("龙虾", "utf8").toString("hex")}${Buffer.from("USDT").toString("hex")}`],
    ]);
    expect(body.membership).toMatchObject({ dynamic: true, records: 3 });
    commitAll(w);
    expect(JSON.parse(w.cursors["龙虾USDT"])).toMatchObject({ symbol: "龙虾USDT", lineageId: lineageOf("龙虾USDT"), consumedChars: w.logs["龙虾USDT"].length });
  });

  it("an INACTIVE or QUARANTINED record never creates (or initializes) a lane — with or without a lineage", () => {
    for (const withLineage of [false, true]) {
      const w = world({
        journal: [change("INACTIVE", "NEWUSDT", withLineage ? lineageOf("NEWUSDT") : null), change("QUARANTINED", "龙虾USDT", withLineage ? lineageOf("龙虾USDT") : null)],
      });
      expect(w.prepare().body.lanes.map((l) => l.symbol), String(withLineage)).toEqual(["AAAUSDT", "BBBUSDT", "CCCUSDT"]);
    }
  });

  it("an invalid journal (broken hash chain, partial line) or a changed lineage refuses everything before any write", () => {
    const valid = journalOf([change("JOINED", "龙虾USDT"), change("JOINED", "NEWUSDT")]);
    const broken = valid.replace('"seq":2', '"seq":3');
    expect(refusal(() => world({ journal: broken }).prepare()).code).toBe("MEMBERSHIP_INVALID");
    expect(refusal(() => world({ journal: `${valid}{"partial` }).prepare()).code).toBe("MEMBERSHIP_INVALID");
    const changed = world({ journal: [change("REACTIVATED", "AAAUSDT", lineageOf("NEWUSDT"))] });
    expect(laneCodes(refusal(() => changed.prepare()))).toEqual([["AAAUSDT", "BINDING"]]);
  });

  it("is never truncated: every one of 600 accepted lanes is planned", () => {
    const symbols = Array.from({ length: 600 }, (_, i) => `S${String(i).padStart(4, "0")}USDT`);
    const logs = Object.fromEntries(symbols.map((s) => [s, logFor(s, 1)]));
    const w = world({ manifest: symbols, logs });
    expect(w.prepare().body.totals.lanes).toBe(600);
  });
});

// ===========================================================================
// No delivery evaluation; idempotency; transaction safety
// ===========================================================================

describe("no delivery evaluation and the durable transaction", () => {
  it("never runs a record through the delivery selector (a deliverable backlog is acknowledged, not evaluated)", () => {
    const consider = vi.spyOn(NativeDeliverySelectorV2.prototype, "consider");
    const w = world({ journal: [change("JOINED", "龙虾USDT")] });
    const outcome = commitAll(w);
    expect(outcome.kind).toBe("COMMITTED");
    expect(consider).not.toHaveBeenCalled();
    consider.mockRestore();
  });

  it("the plan hash is deterministic, and changes when any durable fact changes", () => {
    const a = world().prepare();
    const b = world().prepare();
    expect(a.planSha256).toBe(b.planSha256);
    expect(world({ logs: { BBBUSDT: logFor("BBBUSDT", 5) } }).prepare().planSha256).not.toBe(a.planSha256);
  });

  it("a commit applies only the reviewed plan: changed facts since the dry run refuse (PLAN_CHANGED), nothing written", () => {
    const w = world();
    const reviewed = w.prepare().planSha256;
    w.logs.AAAUSDT = logFor("AAAUSDT", 5);
    const now = w.prepare();
    expect(refusal(() => commitRebaseline({ prepared: now, expectedPlanSha256: reviewed, createdAt: "2026-10-10T01:00:00.000Z", nowIso: () => "t", store: w.store, readLog: w.source.readLog })).code).toBe("PLAN_CHANGED");
    expect(w.cursorWrites).toEqual([]);
    expect(w.evidence.size).toBe(0);
  });

  it("a log that changes between preflight and its cursor write -> RECOVERY_REQUIRED, durably recorded", () => {
    const w = world();
    const prepared = w.prepare();
    const grown = logFor("BBBUSDT", 5);
    const readLog = (s: string) => (s === "BBBUSDT" ? grown : w.logs[s]);
    const r = refusal(() => commitRebaseline({ prepared, expectedPlanSha256: prepared.planSha256, createdAt: "2026-10-10T01:00:00.000Z", nowIso: () => "t", store: w.store, readLog }));
    expect(r.code).toBe("RECOVERY_REQUIRED");
    expect(w.cursorWrites).toEqual(["AAAUSDT"]); // AAAUSDT was written; BBBUSDT and later never
    const op = openOperations(w.store);
    expect(op).toMatchObject([{ state: "RECOVERY_REQUIRED", planSha256: prepared.planSha256 }]);
    expect(refusal(() => resumeRebaseline({ store: w.store, operationId: op[0].operationId, expectedPlanSha256: prepared.planSha256, nowIso: () => "t", readLog })).code).toBe("RECOVERY_REQUIRED");
    // Even once the cause is gone (the log is back to its planned bytes), RECOVERY_REQUIRED stays refused: an operator decides.
    const again = refusal(() => resumeRebaseline({ store: w.store, operationId: op[0].operationId, expectedPlanSha256: prepared.planSha256, nowIso: () => "t", readLog: w.source.readLog }));
    expect([again.code, /needs investigation/.test(again.message)]).toEqual(["RECOVERY_REQUIRED", true]);
    expect(w.cursorWrites).toEqual(["AAAUSDT"]);
  });

  it("a crash mid-commit is resumed deterministically by the SAME plan; a different operation is never started beside it", () => {
    const logA = logFor("AAAUSDT", 4);
    const w = world({ cursors: { AAAUSDT: cursorFileText(cursorAt("AAAUSDT", logA, boundaries(logA)[2], boundaries(logA)[1])) } });
    const prepared = w.prepare();
    w.crashAfter(1);
    expect(() => commitRebaseline({ prepared, expectedPlanSha256: prepared.planSha256, createdAt: "2026-10-10T01:00:00.000Z", nowIso: () => "t", store: w.store, readLog: w.source.readLog })).toThrow("SIMULATED CRASH");
    const [open] = openOperations(w.store);
    expect(open).toMatchObject({ state: "COMMITTING", planSha256: prepared.planSha256 });
    // The operator can see exactly which lanes changed: every lane is either its before bytes or its target bytes.
    const plan = JSON.parse(w.evidence.get(`${open.operationId}/${PLAN_FILE}`) as string);
    const states = plan.body.lanes.map((l: never) => {
      const lane = l as { symbol: string; previous: { fileSha256: string } | null };
      const target = targetCursorOf(plan.body, l, plan.createdAt);
      const current = w.cursors[lane.symbol] ?? null;
      return [lane.symbol, target !== null && current === cursorFileText(target) ? "TARGET" : current === null || sha(current) === lane.previous?.fileSha256 ? "BEFORE" : "?"];
    });
    expect(states).toEqual([["AAAUSDT", "TARGET"], ["BBBUSDT", "BEFORE"], ["CCCUSDT", "BEFORE"]]);
    // A new commit is refused while the operation is open; dry facts now differ (one lane already advanced).
    const fresh = w.prepare();
    expect(refusal(() => commitRebaseline({ prepared: fresh, expectedPlanSha256: fresh.planSha256, createdAt: "2026-10-10T02:00:00.000Z", nowIso: () => "t", store: w.store, readLog: w.source.readLog })).code).toBe("OPERATION_OPEN");
    // Resuming with another plan hash is refused; with its own it completes.
    expect(refusal(() => resumeRebaseline({ store: w.store, operationId: open.operationId, expectedPlanSha256: fresh.planSha256, nowIso: () => "t", readLog: w.source.readLog })).code).toBe("PLAN_CHANGED");
    w.noCrash();
    const result = resumeRebaseline({ store: w.store, operationId: open.operationId, expectedPlanSha256: prepared.planSha256, nowIso: () => "t", readLog: w.source.readLog });
    expect(result).toMatchObject({ state: "COMMITTED", advanced: 1, initialized: 2, resumedLanes: 1, cursorWrites: 2, alertsCreated: 0, databaseOpened: false, binanceCalled: false, nativeExecution: "DISABLED_UNCHANGED" });
    expect(openOperations(w.store)).toEqual([]);
  });

  it("a foreign cursor change during an interrupted operation is RECOVERY_REQUIRED, never overwritten", () => {
    const w = world();
    const prepared = w.prepare();
    w.crashAfter(1);
    expect(() => commitRebaseline({ prepared, expectedPlanSha256: prepared.planSha256, createdAt: "2026-10-10T01:00:00.000Z", nowIso: () => "t", store: w.store, readLog: w.source.readLog })).toThrow("SIMULATED CRASH");
    w.noCrash();
    w.cursors.BBBUSDT = cursorFileText(cursorAt("BBBUSDT", w.logs.BBBUSDT, 0, 0)); // someone else wrote it meanwhile
    const [open] = openOperations(w.store);
    expect(refusal(() => resumeRebaseline({ store: w.store, operationId: open.operationId, expectedPlanSha256: prepared.planSha256, nowIso: () => "t", readLog: w.source.readLog })).code).toBe("RECOVERY_REQUIRED");
    expect(JSON.parse(w.cursors.BBBUSDT).consumedChars).toBe(0);
  });

  it("a cursor write that silently does not land is never claimed COMMITTED (final verification)", () => {
    const w = world();
    const prepared = w.prepare();
    const lossy: RebaselineStore = { ...w.store, writeCursor: (c) => (c.symbol === "BBBUSDT" ? undefined : w.store.writeCursor(c)) };
    const r = refusal(() => commitRebaseline({ prepared, expectedPlanSha256: prepared.planSha256, createdAt: "2026-10-10T01:00:00.000Z", nowIso: () => "t", store: lossy, readLog: w.source.readLog }));
    expect(r.code).toBe("RECOVERY_REQUIRED");
    expect(r.message).toMatch(/BBBUSDT: not at its planned final state/);
    expect(openOperations(w.store)).toMatchObject([{ state: "RECOVERY_REQUIRED" }]);
  });

  it("is idempotent: a second dry run shows every lane ALREADY_AT_EOF and a second commit is a NOOP that writes nothing", () => {
    const w = world({ journal: [change("JOINED", "龙虾USDT")] });
    commitAll(w);
    const writes = w.cursorWrites.length;
    const evidence = w.evidence.size;
    const again = w.prepare();
    expect(again.body.totals).toMatchObject({ alreadyAtEof: 4, wouldAdvance: 0, wouldInitialize: 0 });
    expect(commitRebaseline({ prepared: again, expectedPlanSha256: again.planSha256, createdAt: "2026-10-10T03:00:00.000Z", nowIso: () => "t", store: w.store, readLog: w.source.readLog })).toEqual({ kind: "NOOP", planSha256: again.planSha256 });
    expect([w.cursorWrites.length, w.evidence.size]).toEqual([writes, evidence]);
  });

  it("the audit evidence proves a complete commit: plan, exact before bytes, COMMITTED transaction, result", () => {
    const logA = logFor("AAAUSDT", 4);
    const before = cursorFileText(cursorAt("AAAUSDT", logA, boundaries(logA)[2], boundaries(logA)[1]));
    const w = world({ cursors: { AAAUSDT: before } });
    const outcome = commitAll(w);
    if (outcome.kind !== "COMMITTED") throw new Error("expected a commit");
    const op = outcome.operationId;
    expect(w.evidence.get(`${op}/${beforeFileOf("AAAUSDT")}`)).toBe(before);
    expect(JSON.parse(w.evidence.get(`${op}/${TRANSACTION_FILE}`) as string)).toMatchObject({ state: "COMMITTED", planSha256: outcome.result.planSha256 });
    expect(JSON.parse(w.evidence.get(`${op}/${RESULT_FILE}`) as string)).toMatchObject({ state: "COMMITTED", lanes: 3, advanced: 1, initialized: 2, alreadyAtEof: 0, cursorWrites: 3, alertsCreated: 0 });
    expect(JSON.parse(w.evidence.get(`${op}/${PLAN_FILE}`) as string)).toMatchObject({ operationId: op, planSha256: outcome.result.planSha256 });
  });
});

// ===========================================================================
// The normal emitter is unchanged, and honours a rebaselined cursor
// ===========================================================================

describe("the normal emitter after a rebaseline", () => {
  it("queue default stays 10000 and overflow still fails closed", async () => {
    expect(MULTI_EMITTER_DEFAULTS.queueCapacity).toBe(10_000);
    const w = world();
    const run = bindPinnedRun({ manifest: JSON.parse(w.source.manifestText as string), expect: w.request, checkpointOf: w.source.checkpointOf });
    const emitter = new MultiSymbolNativeEmitter({
      mode: "DRY_RUN", run, readLog: (s) => w.logs[s] ?? null, cursors: { load: () => null }, cursorWriter: null, ledger: null, baseline: "DRY_RUN_FROM_START", activateAtEof: false,
      queueCapacity: 10, pendingTailPolls: 0, nowIso: () => "t", report: () => undefined,
    });
    await expect(emitter.initialize()).rejects.toBeInstanceOf(QueueOverflowError);
  });

  it("a rebaselined lane delivers NONE of its old backlog, and a record appended later IS deliverable", async () => {
    const w = world();
    commitAll(w);
    const run = bindPinnedRun({ manifest: JSON.parse(w.source.manifestText as string), expect: w.request, checkpointOf: w.source.checkpointOf });
    const events: MultiEmitterEvent[] = [];
    const emitter = new MultiSymbolNativeEmitter({
      mode: "DRY_RUN", run, readLog: (s) => w.logs[s] ?? null, cursors: { load: (s) => (w.cursors[s] === undefined ? null : JSON.parse(w.cursors[s])) }, cursorWriter: null, ledger: null,
      baseline: "PRODUCTION_CURSOR", activateAtEof: false, queueCapacity: 10_000, pendingTailPolls: 0, nowIso: () => "t", report: (e) => events.push(e),
    });
    await emitter.initialize();
    await emitter.drain();
    expect(emitter.status()).toMatchObject({ symbolsHealthy: 3, eventsEligible: 0, wouldCreate: 0 });
    expect(events.filter((e) => e.type === "LANE_FAILED")).toEqual([]);
    // A new, post-cutoff live observation on a fresh bar is delivered.
    w.logs.AAAUSDT += logOf([observation({ symbol: "AAAUSDT", lineageId: lineageOf("AAAUSDT"), barMs: BAR + 10 * M15, sourceTf: "1D", createdBarOpenTimeMs: BAR - 500 * M15, levelPrice: 42 })]);
    await emitter.poll();
    expect(events.filter((e) => e.type === "DECISION").map((e) => [e.symbol, (e as { result: string }).result])).toEqual([["AAAUSDT", "WOULD_CREATE"]]);
  });
});

// ===========================================================================
// Safety by construction: what the rebaseline can reach
// ===========================================================================

describe("safety by construction", () => {
  const BACKEND = path.resolve(__dirname, "..");
  const SRC = path.join(BACKEND, "src");
  /** Runtime (non type-only) imports of a module, resolved transitively inside src. */
  function runtimeGraph(entry: string): { files: Set<string>; bare: Set<string> } {
    const files = new Set<string>();
    const bare = new Set<string>();
    const visit = (file: string) => {
      if (files.has(file)) return;
      files.add(file);
      const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const specs = [
        ...[...text.matchAll(/^\s*import\s+(?!type\b)[^;]*?\bfrom\s+"([^"]+)"/gm)].map((m) => m[1]),
        ...[...text.matchAll(/^\s*import\s+"([^"]+)"/gm)].map((m) => m[1]),
        ...[...text.matchAll(/^\s*export\s+(?!type\b)[^;]*?\bfrom\s+"([^"]+)"/gm)].map((m) => m[1]),
        ...[...text.matchAll(/await import\("([^"]+)"\)/g)].map((m) => m[1]),
      ];
      for (const spec of specs) {
        if (!spec.startsWith(".")) {
          bare.add(spec);
          continue;
        }
        const resolved = [`${path.resolve(path.dirname(file), spec)}.ts`, path.join(path.resolve(path.dirname(file), spec), "index.ts")].find((f) => existsSync(f));
        if (resolved !== undefined) visit(resolved);
      }
    };
    visit(entry);
    return { files, bare };
  }

  it("the rebaseline CLI can reach no database, queue, dashboard push, plan, Alert creation, Binance, account or execution module", () => {
    const { files, bare } = runtimeGraph(path.join(SRC, "modules/native-alerts/run-native-emitter-cursor-rebaseline.ts"));
    const rel = [...files].map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    // (native-scanner/binance-public-futures.ts — the scanner's pure market constants and parsers — is reached through the checkpoint;
    //  it has no network primitive, asserted below. The signed clients live in modules/binance/ and are unreachable.)
    for (const forbidden of [/native-alert-ledger/, /native-alert-draft/, /notifications\//, /native-planning\//, /jobs\//, /execution\//, /^modules\/binance\//, /binance-execution|binance\.client|binance-read-only|binance-account/, /kline-fetcher/, /live-kline-stream/, /webhook/, /alerts\.service/, /extreme-rr/, /operator\//, /account/]) {
      // config/account-env.ts is the generic bootstrap's own fence (the account key NAMES it refuses to start with): allowed, nothing else.
      expect({ forbidden: String(forbidden), hits: rel.filter((f) => forbidden.test(f) && f !== "config/account-env.ts") }).toEqual({ forbidden: String(forbidden), hits: [] });
    }
    expect(rel).toContain("config/bootstrap-generic.ts");
    for (const pkg of ["@prisma/client", "ioredis", "bullmq", "@socket.io/redis-emitter", "socket.io", "axios"]) expect({ pkg, reached: bare.has(pkg) }).toEqual({ pkg, reached: false });
    // No reached module (the CLI excepted, which only reads files) holds a network primitive.
    for (const f of rel.filter((f) => !f.endsWith("run-native-emitter-cursor-rebaseline.ts"))) {
      const text = readFileSync(path.join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect({ f, hit: text.match(/fetch\s*\(|new WebSocket|https?\.request|createHmac|X-MBX-APIKEY/)?.[0] ?? null }).toEqual({ f, hit: null });
    }
  });

  it("the rebaseline modules never call the delivery path, the ledger or a database", () => {
    for (const file of ["native-emitter-cursor-rebaseline.ts", "native-emitter-rebaseline-cli-args.ts", "run-native-emitter-cursor-rebaseline.ts"]) {
      const text = readFileSync(path.join(SRC, "modules/native-alerts", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect({ file, hit: text.match(/MultiSymbolNativeEmitter|NativeDeliverySelector|selectNativeDeliveries|\.consider\(|deliverV2|NativeDeliveryLedger|PrismaClient|\$transaction|enqueue|publish|nativeExecutionEnabled\s*:\s*true/)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });

  it("identity: engine and delivery-policy fingerprints are unchanged; native execution stays hard-disabled", () => {
    expect(FP).toBe("35f1a32d82ac2786ee67dd4c5146760bf1f29d5025cafe01da5394b79a9b47fb");
    expect(profileSummaryOf(N).deliveryPolicyFingerprint).toBe("c40d2157f253a8b5a4fda0fbeb30ec2208e4f3941e92c19baea9926cbd4e3a34");
    expect(N.execution.nativeExecutionEnabled).toBe(false);
  });
});

// ===========================================================================
// End to end: the real CLI against a temp LOCALAPPDATA
// ===========================================================================

describe("end to end: the real rebaseline CLI on a temp scanner tree", () => {
  const BACKEND = path.resolve(__dirname, "..");
  const TSX = path.join(BACKEND, "node_modules", "tsx", "dist", "cli.mjs");
  const RUNNER = path.join(BACKEND, "src", "modules", "native-alerts", "run-native-emitter-cursor-rebaseline.ts");

  function tree(opts: { runState?: string; extraRunningRun?: boolean; torn?: boolean } = {}) {
    const local = mkdtempSync(path.join(tmpdir(), "rebaseline-e2e-"));
    const root = path.join(local, "trading-alert-dashboard", "scanner");
    const runDir = path.join(root, "live-shadow-supervisor", "runs", RUN_ID);
    mkdirSync(runDir, { recursive: true });
    const manifestSymbols = ["AAAUSDT", "BBBUSDT"];
    writeFileSync(path.join(runDir, "manifest.json"), manifestTextFor(manifestSymbols));
    writeFileSync(path.join(runDir, "status.json"), statusText(opts.runState ?? "STOPPED"));
    writeFileSync(path.join(runDir, "membership.jsonl"), journalOf([change("JOINED", "龙虾USDT")]));
    if (opts.extraRunningRun) {
      const other = path.join(root, "live-shadow-supervisor", "runs", makeRunId(Date.UTC(2026, 9, 1, 0, 0), "deadbeef"));
      mkdirSync(other, { recursive: true });
      writeFileSync(path.join(other, "status.json"), statusText("RUNNING", makeRunId(Date.UTC(2026, 9, 1, 0, 0), "deadbeef")));
    }
    for (const symbol of [...manifestSymbols, "龙虾USDT"]) {
      const dir = liveShadowEngineDir(root, FP, "USDM_PERPETUAL", symbol, "15m");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "events.jsonl"), logFor(symbol, 3) + (opts.torn && symbol === "BBBUSDT" ? '{"torn' : ""));
      const switchover = Date.UTC(2026, 8, 12, 1, 0);
      new LiveCheckpointStore(dir).save(
        { schema: LIVE_CHECKPOINT_SCHEMA, lineageId: lineageOf(symbol), marketType: "USDM_PERPETUAL", symbol, chartInterval: "15m", compatibilitySwitchoverMs: switchover, stateSha256AtSwitchover: "a".repeat(64), hwmOpenTimeMs: switchover + 4 * M15, lastCommittedBarOpenTimeMs: switchover + 3 * M15, causalBarCount: 4, causalInputSha256ThroughHwm: "b".repeat(64), stateSha256: "c".repeat(64) },
        "2026-10-09T07:53:00.000Z"
      );
    }
    // AAAUSDT already has a production cursor, behind EOF.
    const aLog = logFor("AAAUSDT", 3);
    new FileEmitterCursorStore(emitterCursorDir(root, N.profileId, FP, "USDM_PERPETUAL", "15m")).save(cursorAt("AAAUSDT", aLog, boundaries(aLog)[2], boundaries(aLog)[1]));
    const envFile = path.join(local, "generic.env");
    writeFileSync(envFile, "");
    return { local, root, envFile };
  }

  function cli(t: ReturnType<typeof tree>, args: string[]) {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: process.env.TEMP, TMP: process.env.TMP, LOCALAPPDATA: t.local, DOTENV_CONFIG_PATH: t.envFile };
    const r = spawnSync(process.execPath, [TSX, RUNNER, "--profile", "teddy-7-all-active", "--run-id", RUN_ID, "--expect-engine-fingerprint", FP, ...args], { cwd: BACKEND, env, encoding: "utf8", timeout: 120_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  }
  /** Every file under the tree with its bytes (the dry run must not change one). */
  function files(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const f = path.join(d, e);
        if (statSync(f).isDirectory()) walk(f);
        else out[path.relative(dir, f)] = readFileSync(f, "utf8");
      }
    };
    walk(dir);
    return out;
  }
  const scannerFiles = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([k]) => k.includes("live-shadow-engines") || k.includes("live-shadow-supervisor")));

  it("dry run writes nothing; commit advances exactly; a second dry run is all at EOF; a second commit is a NOOP; scanner files never change", () => {
    const t = tree({ extraRunningRun: true });
    const start = files(t.local);
    const dry = cli(t, []);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain("DRY RUN — WRITES NOTHING");
    expect(dry.out).toContain("NO ALERTS / NO DATABASE / NO BINANCE / NO EXECUTION");
    expect(dry.out).toMatch(/wouldAdvance\s+1/);
    expect(dry.out).toMatch(/wouldInitialize\s+2/);
    expect(files(t.local)).toEqual(start);
    const plan = /plan hash\s+([0-9a-f]{64})/.exec(dry.out)![1];

    expect(cli(t, ["--commit-rebaseline"]).code).toBe(2);
    const committed = cli(t, ["--commit-rebaseline", "--expect-plan-sha256", plan]);
    expect(committed.code, committed.out).toBe(0);
    for (const line of ["PRODUCTION DELIVERY CURSORS WILL ADVANCE TO CURRENT DURABLE EOF", "REBASELINE COMMITTED", "Alerts created: 0", "Database opened: NO", "Binance called: NO", "Native execution: DISABLED / UNCHANGED"]) expect(committed.out).toContain(line);
    const after = files(t.local);
    expect(scannerFiles(after)).toEqual(scannerFiles(start)); // no checkpoint, log or lock left behind
    const cursors = new FileEmitterCursorStore(emitterCursorDir(t.root, N.profileId, FP, "USDM_PERPETUAL", "15m"));
    for (const s of ["AAAUSDT", "BBBUSDT", "龙虾USDT"]) expect(cursors.load(s)?.consumedChars, s).toBe(logFor(s, 3).length);
    const evidence = new FileRebaselineStore(emitterRebaselineDir(t.root, N.profileId, FP, "USDM_PERPETUAL", "15m"), cursors);
    const [op] = evidence.listOperations();
    expect(JSON.parse(evidence.readEvidence(op, TRANSACTION_FILE) as string)).toMatchObject({ state: "COMMITTED", planSha256: plan });
    expect(JSON.parse(evidence.readEvidence(op, RESULT_FILE) as string)).toMatchObject({ advanced: 1, initialized: 2, cursorWrites: 3 });

    const second = cli(t, []);
    expect(second.out).toMatch(/alreadyAtEof\s+3/);
    expect(second.out).toMatch(/wouldAdvance\s+0/);
    expect(second.out).toMatch(/wouldInitialize\s+0/);
    const plan2 = /plan hash\s+([0-9a-f]{64})/.exec(second.out)![1];
    const noop = cli(t, ["--commit-rebaseline", "--expect-plan-sha256", plan2]);
    expect(noop.code, noop.out).toBe(0);
    expect(noop.out).toContain("REBASELINE NOOP");
    expect(files(t.local)).toEqual(after);
  }, 240_000);

  it("refuses a RUNNING pinned run, a torn log and a lane held by a live scanner — writing nothing", () => {
    const running = tree({ runState: "RUNNING" });
    const before = files(running.local);
    const r = cli(running, []);
    expect([r.code, /RUN_NOT_STOPPED/.test(r.out)]).toEqual([1, true]);
    expect(files(running.local)).toEqual(before);

    const torn = tree({ torn: true });
    const t = cli(torn, []);
    expect([t.code, /BBBUSDT TORN_LINE/.test(t.out)]).toEqual([1, true]);

    const live = tree();
    const lockDir = liveShadowEngineDir(live.root, FP, "USDM_PERPETUAL", "BBBUSDT", "15m");
    // The test runner itself is a live process: its pid holds the lane like a running scanner would.
    writeFileSync(path.join(lockDir, "live-shadow.lock"), `${JSON.stringify({ schema: "teddy.native-scanner.live-shadow-lock.v1", pid: process.pid, owner: "scanner:live-shadow-supervisor", startedAt: "t" })}\n`);
    const snapshot = files(live.local);
    const l = cli(live, []);
    expect([l.code, /BBBUSDT LIVE_WRITER/.test(l.out)]).toEqual([1, true]);
    const c = cli(live, ["--commit-rebaseline", "--expect-plan-sha256", "a".repeat(64)]);
    expect([c.code, /LOCKED_BY_LIVE_PROCESS/.test(c.out)]).toEqual([1, true]);
    expect(files(live.local)).toEqual(snapshot);
  }, 240_000);
});
