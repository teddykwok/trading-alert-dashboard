import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SourceTimeframe } from "@trading-alert-dashboard/shared";

import { MultiEmitterCliUsageError, parseMultiEmitterCliArgs } from "../src/modules/native-alerts/multi-emitter-cli-args";
import {
  EMITTER_CURSOR_SCHEMA,
  MultiSymbolNativeEmitter,
  NotActivatedError,
  QueueOverflowError,
  RunBindingError,
  bindPinnedRun,
  cursorMismatch,
  runMultiSymbolEmitter,
  type EmitterCursor,
  type MultiEmitterDeps,
  type MultiEmitterEvent,
  type PinnedRun,
} from "../src/modules/native-alerts/multi-symbol-emitter";
import { NATIVE_INDICATOR_NAME, buildNativeAlertDraftV2 } from "../src/modules/native-alerts/native-alert-draft";
import type { NativeDeliveryLedgerV2, NativeDeliveryResult } from "../src/modules/native-alerts/native-alert-ledger";
import { NATIVE_DELIVERY_KEY_SCHEMA, nativeDeliveryKey, selectNativeDeliveries } from "../src/modules/native-alerts/native-delivery-policy";
import {
  NATIVE_DELIVERY_KEY_SCHEMA_V2,
  nativeDeliveryKeyV2,
  selectNativeDeliveriesV2,
  type NativeDeliveryContextV2,
  type NativeDeliveryDecisionV2,
} from "../src/modules/native-alerts/native-delivery-policy-v2";
import { FileEmitterCursorStore, emitterCursorDir } from "../src/modules/native-alerts/native-emitter-state-files";
import { parseShadowEventLog } from "../src/modules/native-alerts/shadow-log-reader";
import type { ShadowRecord } from "../src/modules/native-scanner/live-shadow-store";
import {
  TEDDY_AGGRESSIVE_V1,
  dashboardTimeframes,
  engineFingerprintOf,
  profileLineageIdFor,
  profileSummaryOf,
  type ScannerProfile,
} from "../src/modules/native-scanner/scanner-profile";
import { SUPERVISOR_RUN_MANIFEST_SCHEMA, buildRunManifest, makeRunId, type SupervisorRunManifest } from "../src/modules/native-scanner/supervisor-run-manifest";
import { BAR0, M15, bar, commit, lineOf, logOf, observation, realisticLog } from "./helpers/native-alert-fixtures";

/**
 * MULTI-SYMBOL NATIVE EMITTER: pinned-run binding, NATIVE_DELIVERY_V2
 * source-timeframe slots, restart-safe cursors, first-activation cutover,
 * bounded fair fan-in and per-lane isolation. Fake ledger and cursor store; no
 * database, no file system except the cursor-store tests' temporary directory.
 */

const T = TEDDY_AGGRESSIVE_V1;
const ENGINE = engineFingerprintOf(T);
const RUN_ID = makeRunId(Date.UTC(2026, 9, 1, 11, 0), "1a2b3c4d");
const BOOT = "c".repeat(64);
const lineageOf = (symbol: string) => profileLineageIdFor(T, symbol, BOOT);

function manifestFor(symbols: string[], over: { runId?: string; profile?: ReturnType<typeof profileSummaryOf> | null; engineFingerprint?: string; lineage?: Record<string, string> } = {}): SupervisorRunManifest {
  const profile = over.profile === undefined ? profileSummaryOf(T) : over.profile;
  return buildRunManifest({
    schema: SUPERVISOR_RUN_MANIFEST_SCHEMA,
    runId: over.runId ?? RUN_ID,
    startedAt: "2026-10-01T11:00:00.000Z",
    gitHead: "test",
    marketType: "USDM_PERPETUAL",
    chartInterval: "15m",
    engineFingerprint: over.engineFingerprint ?? ENGINE,
    profile,
    stateLayout: profile === null ? "LEGACY" : "ENGINE_NAMESPACE",
    selection: { mode: "TARGET", universeActive: 523, targetEligible: symbols.length, candidatesTested: symbols.length, acceptedEligible: symbols.length, skippedTooNew: 0, skippedInsufficientHistory: 0, skippedOther: 0, universeExhausted: false },
    symbols: symbols.map((symbol) => ({ symbol, lineageId: over.lineage?.[symbol] ?? lineageOf(symbol), bootstrapInputSha256: BOOT })),
    actionable: false,
  });
}

const checkpointOf = (overrides: Record<string, string | null> = {}) => (symbol: string) => {
  if (overrides[symbol] === null) return null;
  return { lineageId: overrides[symbol] ?? lineageOf(symbol), symbol, chartInterval: "15m", marketType: "USDM_PERPETUAL" };
};

function pinned(symbols: string[], checkpoints: Record<string, string | null> = {}): PinnedRun {
  return bindPinnedRun({ manifest: manifestFor(symbols), expect: { profileId: T.profileId, runId: RUN_ID, engineFingerprint: ENGINE }, checkpointOf: checkpointOf(checkpoints) });
}

/** An observation for `symbol` in that symbol's real lineage. */
const obs = (symbol: string, spec: Parameters<typeof observation>[0] = {}) => observation({ ...spec, symbol, lineageId: spec.lineageId ?? lineageOf(symbol) });
const com = (symbol: string, barMs: number, classification: Parameters<typeof commit>[1] = "SHADOW_LIVE_ONLY") => commit(barMs, classification, lineageOf(symbol), symbol);

/** In-memory ledger with the real ledger's idempotency: one row per key. */
class FakeLedger implements NativeDeliveryLedgerV2 {
  readonly rows = new Map<string, { decision: NativeDeliveryDecisionV2; context: NativeDeliveryContextV2 }>();
  calls = 0;
  failNext = 0;
  async lookupV2(decision: NativeDeliveryDecisionV2) {
    return this.rows.has(decision.deliveryKey) ? ({ state: "DELIVERED", alertId: "a" } as const) : ({ state: "NOT_DELIVERED" } as const);
  }
  async deliverV2(decision: NativeDeliveryDecisionV2, context: NativeDeliveryContextV2): Promise<NativeDeliveryResult> {
    this.calls += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("injected database failure before commit");
    }
    if (this.rows.has(decision.deliveryKey)) return { outcome: "ALREADY_DELIVERED", deliveryKey: decision.deliveryKey, alertId: "a" };
    this.rows.set(decision.deliveryKey, { decision, context });
    return { outcome: "CREATED", deliveryKey: decision.deliveryKey, alertId: `alert-${this.rows.size}` };
  }
}

class FakeCursors {
  readonly saved = new Map<string, EmitterCursor>();
  saves = 0;
  failSaves = 0;
  load(symbol: string) {
    return this.saved.get(symbol) ?? null;
  }
  save(cursor: EmitterCursor) {
    if (this.failSaves > 0) {
      this.failSaves -= 1;
      throw new Error("injected crash after the ledger commit, before the cursor write");
    }
    this.saves += 1;
    this.saved.set(cursor.symbol, cursor);
  }
}

interface Setup {
  run?: PinnedRun;
  logs: Record<string, string>;
  mode?: "DRY_RUN" | "COMMIT_DASHBOARD_ALERTS";
  ledger?: FakeLedger;
  cursors?: FakeCursors;
  activateAtEof?: boolean;
  baseline?: "PRODUCTION_CURSOR" | "DRY_RUN_FROM_START";
  queueCapacity?: number;
  readSpy?: string[];
}

function emitterFor(s: Setup) {
  const events: MultiEmitterEvent[] = [];
  const commitMode = (s.mode ?? "DRY_RUN") === "COMMIT_DASHBOARD_ALERTS";
  const cursors = s.cursors ?? new FakeCursors();
  const deps: MultiEmitterDeps = {
    mode: s.mode ?? "DRY_RUN",
    run: s.run ?? pinned(Object.keys(s.logs).sort()),
    readLog: (symbol) => {
      s.readSpy?.push(symbol);
      return s.logs[symbol] ?? null;
    },
    cursors,
    cursorWriter: commitMode ? cursors : null,
    ledger: commitMode ? (s.ledger ?? new FakeLedger()) : null,
    baseline: s.baseline ?? (commitMode ? "PRODUCTION_CURSOR" : "DRY_RUN_FROM_START"),
    activateAtEof: s.activateAtEof ?? false,
    queueCapacity: s.queueCapacity ?? 1_000,
    pendingTailPolls: 0,
    nowIso: () => "2026-10-01T12:00:00.000Z",
    report: (e) => events.push(e),
  };
  return { emitter: new MultiSymbolNativeEmitter(deps), events, cursors, deps };
}

async function runOnceDry(logs: Record<string, string>, extra: Partial<Setup> = {}) {
  const h = emitterFor({ logs, ...extra });
  await runMultiSymbolEmitter(h.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
  return { ...h, status: h.emitter.status(), decisions: h.events.filter((e): e is Extract<MultiEmitterEvent, { type: "DECISION" }> => e.type === "DECISION") };
}

/** One live bar per source TF, all on bar(1), then its commit. */
function allTfLog(symbol: string): string {
  const tfs: SourceTimeframe[] = ["1D", "1W", "1M", "3M", "6M", "12M"];
  const records: ShadowRecord[] = [com(symbol, bar(0), "QUARANTINED_CURRENT_BAR")];
  tfs.forEach((tf, i) => records.push(obs(symbol, { barMs: bar(1), sourceTf: tf, levelPrice: 0.8 + i / 100, candidateSequence: i, updateSequence: 2 + i, eventTimeMs: bar(1) + 60_000 + i, createdBarOpenTimeMs: BAR0 - (i + 1) * 96 * M15 })));
  records.push(com(symbol, bar(1)));
  return logOf(records);
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ===========================================================================
// Binding to the pinned run
// ===========================================================================

describe("pinned-run binding", () => {
  it("1. exactly the pinned run's accepted symbols are read — an unrelated log beside them is never opened", async () => {
    const readSpy: string[] = [];
    const logs = { AAAUSDT: allTfLog("AAAUSDT"), BBBUSDT: allTfLog("BBBUSDT"), ZZZUSDT: allTfLog("ZZZUSDT") };
    await runOnceDry(logs, { run: pinned(["AAAUSDT", "BBBUSDT"]), readSpy });
    expect([...new Set(readSpy)].sort()).toEqual(["AAAUSDT", "BBBUSDT"]);
  });

  it("2. another run, another profile, or a legacy run is refused before anything is read", () => {
    const expect_ = { profileId: T.profileId, runId: RUN_ID, engineFingerprint: ENGINE };
    const bind = (manifest: SupervisorRunManifest, e = expect_) => () => bindPinnedRun({ manifest, expect: e, checkpointOf: checkpointOf() });
    expect(bind(manifestFor(["AAAUSDT"], { runId: makeRunId(Date.UTC(2026, 9, 2), "ffffffff") }))).toThrow(expect.objectContaining({ code: "RUN_ID_MISMATCH" }));
    expect(bind(manifestFor(["AAAUSDT"], { profile: null }))).toThrow(expect.objectContaining({ code: "NOT_A_PROFILE_RUN" }));
    expect(bind(manifestFor(["AAAUSDT"]), { ...expect_, profileId: "OTHER_PROFILE_V1" })).toThrow(expect.objectContaining({ code: "PROFILE_MISMATCH" }));
  });

  it("3. a wrong engine fingerprint — pinned, in the manifest, or the old 7% engine — is refused", () => {
    const seven = engineFingerprintOf({ ...T, engine: { ...T.engine, minMovePercent: 7 } } as ScannerProfile);
    const tryBind = (manifest: SupervisorRunManifest, pin: string) => () => bindPinnedRun({ manifest, expect: { profileId: T.profileId, runId: RUN_ID, engineFingerprint: pin }, checkpointOf: checkpointOf() });
    expect(tryBind(manifestFor(["AAAUSDT"]), seven)).toThrow(RunBindingError);
    expect(tryBind(manifestFor(["AAAUSDT"], { engineFingerprint: seven, profile: { ...profileSummaryOf(T), engineFingerprint: seven } }), ENGINE)).toThrow(/ENGINE|engine/);
  });

  it("4. a wrong lineage fails that symbol's lane alone: not rebuilt from the engine, a different checkpoint, a missing checkpoint, or foreign events", async () => {
    const run = bindPinnedRun({
      manifest: manifestFor(["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"], { lineage: { BBBUSDT: "9".repeat(64) } }),
      expect: { profileId: T.profileId, runId: RUN_ID, engineFingerprint: ENGINE },
      checkpointOf: checkpointOf({ CCCUSDT: "8".repeat(64), DDDUSDT: null }),
    });
    const foreign = logOf([observation({ barMs: bar(1), symbol: "EEEUSDT", lineageId: "7".repeat(64) })]);
    const logs = { AAAUSDT: allTfLog("AAAUSDT"), BBBUSDT: allTfLog("BBBUSDT"), CCCUSDT: allTfLog("CCCUSDT"), DDDUSDT: allTfLog("DDDUSDT"), EEEUSDT: foreign };
    const r = await runOnceDry(logs, { run });
    const lanes = Object.fromEntries(r.status.cursors.lanes.map((l) => [l.symbol, l.failure?.split(":")[0] ?? l.state]));
    expect(lanes).toEqual({ AAAUSDT: "HEALTHY", BBBUSDT: "BINDING", CCCUSDT: "BINDING", DDDUSDT: "BINDING", EEEUSDT: "LINEAGE_MISMATCH" });
    expect(r.status.symbolsFailed).toBe(4);
    expect(r.status.skipCounts.lineageOrProfileMismatch).toBe(4);
    expect(r.decisions.every((d) => d.symbol === "AAAUSDT")).toBe(true);
    expect(r.decisions).toHaveLength(3);
  });
});

// ===========================================================================
// NATIVE_DELIVERY_V2 under Teddy Aggressive
// ===========================================================================

describe("Teddy Aggressive delivery: 1D/1W/1M deliverable, 3M/6M/12M engine-only", () => {
  it.each([
    ["11. 1D", "1D", true],
    ["12. 1W", "1W", true],
    ["13. 1M", "1M", true],
    ["14. 3M", "3M", false],
    ["15. 6M", "6M", false],
    ["16. 12M", "12M", false],
  ] as const)("%s", async (_label, tf, deliverable) => {
    const log = logOf([com("AAAUSDT", bar(0), "QUARANTINED_CURRENT_BAR"), obs("AAAUSDT", { barMs: bar(1), sourceTf: tf }), com("AAAUSDT", bar(1))]);
    const r = await runOnceDry({ AAAUSDT: log });
    expect(r.decisions.map((d) => d.decision.winner.sourceTf)).toEqual(deliverable ? [tf] : []);
    if (deliverable) expect(r.status.eligibleBySourceTf).toEqual({ [tf]: 1 });
    else {
      expect(r.status.skippedBySourceTf).toEqual({ [tf]: { SOURCE_TF_NOT_DELIVERED: 1 } });
      expect(r.status.skipCounts.deliveryTfNotAllowed).toBe(1);
    }
  });

  it("17. recovery and quarantine never deliver: their commits are non-actionable skips, and a non-live observation fails the lane closed", async () => {
    const r = await runOnceDry({ AAAUSDT: logOf([com("AAAUSDT", bar(0), "QUARANTINED_CURRENT_BAR"), com("AAAUSDT", bar(1), "REPLAYED_NON_ACTIONABLE"), com("AAAUSDT", bar(2))]) });
    expect(r.status.skipCounts).toMatchObject({ replayOrNonActionable: 2, barCloseCommit: 1 });
    expect(r.decisions).toHaveLength(0);
    const quarantinedObservation = { ...obs("BBBUSDT", { barMs: bar(1) }), classification: "QUARANTINED_CURRENT_BAR" };
    const actionable = { ...obs("CCCUSDT", { barMs: bar(1) }), actionable: true };
    const bad = await runOnceDry({ AAAUSDT: allTfLog("AAAUSDT"), BBBUSDT: lineOf(quarantinedObservation), CCCUSDT: lineOf(actionable) });
    expect(bad.status.cursors.lanes.map((l) => l.failure?.split(":")[0] ?? "HEALTHY")).toEqual(["HEALTHY", "INVALID_SCHEMA", "ACTIONABLE_RECORD"]);
    expect(bad.decisions.every((d) => d.symbol === "AAAUSDT")).toBe(true);
  });

  it("19/21. inside one source-TF slot the earliest observation wins, deterministically; later ones are SUPERSEDED_SAME_SLOT", async () => {
    const log = logOf([
      obs("AAAUSDT", { barMs: bar(1), sourceTf: "1D", levelPrice: 0.81, candidateSequence: 0, updateSequence: 2 }),
      obs("AAAUSDT", { barMs: bar(1), sourceTf: "1D", levelPrice: 0.8, candidateSequence: 1, updateSequence: 3, createdBarOpenTimeMs: BAR0 - 2 * 96 * M15 }),
      com("AAAUSDT", bar(1)),
    ]);
    const a = await runOnceDry({ AAAUSDT: log });
    const b = await runOnceDry({ AAAUSDT: log });
    expect(a.decisions.map((d) => d.decision.winner.levelPrice)).toEqual([0.81]);
    expect(b.decisions.map((d) => d.decision.deliveryKey)).toEqual(a.decisions.map((d) => d.decision.deliveryKey));
    expect(a.status.skipReasons.SUPERSEDED_SAME_SLOT).toBe(1);
  });

  it("22. different deliverable TFs on the same bar never suppress each other (V2: 1D + 1W + 1M), where V1 would keep only one", async () => {
    const r = await runOnceDry({ AAAUSDT: allTfLog("AAAUSDT") });
    expect(r.decisions.map((d) => d.decision.winner.sourceTf)).toEqual(["1D", "1W", "1M"]);
    expect(new Set(r.decisions.map((d) => d.decision.deliveryKey)).size).toBe(3);
    // V1 over the very same records: one Alert for the bar (the 1D); the 1W is suppressed as SUPERSEDED_SAME_BAR.
    const records = parseShadowEventLog(allTfLog("AAAUSDT"), { lineageId: lineageOf("AAAUSDT"), marketType: "USDM_PERPETUAL", symbol: "AAAUSDT", chartInterval: "15m" });
    const v1 = selectNativeDeliveries(records);
    expect(v1.filter((s) => s.kind === "DELIVER").map((s) => (s.kind === "DELIVER" ? s.decision.winner.sourceTf : ""))).toEqual(["1D"]);
    expect(v1.filter((s) => s.kind === "SKIP" && s.reason === "SUPERSEDED_SAME_BAR")).toHaveLength(1);
  });

  it("7. no cross-symbol contamination: the same bar and TF in two symbols are two slots, each in its own lineage", async () => {
    const r = await runOnceDry({ AAAUSDT: allTfLog("AAAUSDT"), BBBUSDT: allTfLog("BBBUSDT") });
    const bySymbol = (s: string) => r.decisions.filter((d) => d.symbol === s);
    expect(bySymbol("AAAUSDT")).toHaveLength(3);
    expect(bySymbol("BBBUSDT")).toHaveLength(3);
    for (const d of r.decisions) {
      expect(d.decision.winner.symbol).toBe(d.symbol);
      expect(d.decision.winner.lineageId).toBe(lineageOf(d.symbol));
    }
    expect(new Set(r.decisions.map((d) => d.decision.deliveryKey)).size).toBe(6);
  });

  it("6. per-symbol order is log order, and lanes are drained fairly (interleaved, not one symbol after another)", async () => {
    const two = (symbol: string) =>
      logOf([obs(symbol, { barMs: bar(1), sourceTf: "1D" }), com(symbol, bar(1)), obs(symbol, { barMs: bar(2), sourceTf: "1W", createdBarOpenTimeMs: BAR0 - 7 * 96 * M15 }), com(symbol, bar(2))]);
    const r = await runOnceDry({ AAAUSDT: two("AAAUSDT"), BBBUSDT: two("BBBUSDT") });
    expect(r.decisions.map((d) => `${d.symbol}:${d.decision.winner.barOpenTimeMs === bar(1) ? 1 : 2}`)).toEqual(["AAAUSDT:1", "BBBUSDT:1", "AAAUSDT:2", "BBBUSDT:2"]);
  });

  it("5/25. a malformed line fails only its own lane; the other symbols deliver unaffected", async () => {
    const torn = `${lineOf(obs("BBBUSDT", { barMs: bar(1) }))}{"not": "a shadow record"}\n`;
    const r = await runOnceDry({ AAAUSDT: allTfLog("AAAUSDT"), BBBUSDT: torn, CCCUSDT: allTfLog("CCCUSDT") });
    expect(r.status.symbolsHealthy).toBe(2);
    expect(r.status.skipCounts.malformed).toBe(1);
    expect(r.decisions.filter((d) => d.symbol !== "BBBUSDT")).toHaveLength(6);
  });
});

// ===========================================================================
// Cursors, activation, restarts
// ===========================================================================

describe("restart-safe cursors and first activation", () => {
  it("18. first activation never floods history: COMMIT without a cursor refuses unless activated, and activation starts at current EOF", async () => {
    const logs = { AAAUSDT: allTfLog("AAAUSDT") };
    const ledger = new FakeLedger();
    const cursors = new FakeCursors();
    const refused = emitterFor({ logs, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors });
    await expect(refused.emitter.initialize()).rejects.toBeInstanceOf(NotActivatedError);
    expect([ledger.calls, cursors.saves]).toEqual([0, 0]);

    const activated = emitterFor({ logs, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors, activateAtEof: true });
    await runMultiSymbolEmitter(activated.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    expect(ledger.calls).toBe(0);
    expect(activated.emitter.status().skipCounts.historicalBeforeActivationCutover).toBe(8);
    const cursor = cursors.saved.get("AAAUSDT") as EmitterCursor;
    expect(cursor.consumedChars).toBe(logs.AAAUSDT.length);
    expect(cursor.activationChars).toBe(logs.AAAUSDT.length);

    // Only what is appended AFTER activation is delivered.
    logs.AAAUSDT += logOf([obs("AAAUSDT", { barMs: bar(2), sourceTf: "1M", createdBarOpenTimeMs: BAR0 - 30 * 96 * M15 }), com("AAAUSDT", bar(2))]);
    const next = emitterFor({ logs, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors });
    await runMultiSymbolEmitter(next.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    expect([...ledger.rows.values()].map((r) => r.decision.winner.sourceTf)).toEqual(["1M"]);
    expect((cursors.saved.get("AAAUSDT") as EmitterCursor).consumedChars).toBe(logs.AAAUSDT.length);
  });

  function activatedState(logs: Record<string, string>) {
    const cursors = new FakeCursors();
    const ledger = new FakeLedger();
    const start = emitterFor({ logs: { ...logs, AAAUSDT: logOf([com("AAAUSDT", bar(0), "QUARANTINED_CURRENT_BAR")]) }, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors, activateAtEof: true });
    return { cursors, ledger, start };
  }

  it("8. a crash after the ledger commit but before the cursor write replays harmlessly: no second Alert", async () => {
    const { cursors, ledger, start } = activatedState({});
    await runMultiSymbolEmitter(start.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    const logs = { AAAUSDT: logOf([com("AAAUSDT", bar(0), "QUARANTINED_CURRENT_BAR"), obs("AAAUSDT", { barMs: bar(1), sourceTf: "1D" }), com("AAAUSDT", bar(1))]) };
    // A process death: neither the in-line cursor write nor the graceful-stop write ever happens.
    cursors.failSaves = 2;
    const crashing = emitterFor({ logs, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors });
    await expect(runMultiSymbolEmitter(crashing.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false })).rejects.toThrow(/cursor write/);
    expect(ledger.rows.size).toBe(1);
    const restarted = emitterFor({ logs, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors });
    await runMultiSymbolEmitter(restarted.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    expect(ledger.rows.size).toBe(1);
    expect(restarted.emitter.status()).toMatchObject({ created: 0, ledgerDuplicates: 1 });
    expect((cursors.saved.get("AAAUSDT") as EmitterCursor).consumedChars).toBe(logs.AAAUSDT.length);
  });

  it("8b. when only the in-line cursor write fails, the safe stop still persists the committed position (the event is not replayed, and not lost)", async () => {
    const { cursors, ledger, start } = activatedState({});
    await runMultiSymbolEmitter(start.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    const logs = { AAAUSDT: logOf([com("AAAUSDT", bar(0), "QUARANTINED_CURRENT_BAR"), obs("AAAUSDT", { barMs: bar(1), sourceTf: "1D" }), com("AAAUSDT", bar(1))]) };
    cursors.failSaves = 1;
    const crashing = emitterFor({ logs, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors });
    await expect(runMultiSymbolEmitter(crashing.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false })).rejects.toThrow(/cursor write/);
    const atCommit = (cursors.saved.get("AAAUSDT") as EmitterCursor).consumedChars;
    expect(logs.AAAUSDT.slice(0, atCommit)).toContain(ledger.rows.values().next().value!.decision.winner.eventId);
    const restarted = emitterFor({ logs, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors });
    await runMultiSymbolEmitter(restarted.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    expect(ledger.rows.size).toBe(1);
    expect(restarted.emitter.status()).toMatchObject({ created: 0, ledgerDuplicates: 0 });
  });

  it("9. a failed ledger commit never moves the cursor past its event; the restart delivers it", async () => {
    const { cursors, ledger, start } = activatedState({});
    await runMultiSymbolEmitter(start.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    const before = (cursors.saved.get("AAAUSDT") as EmitterCursor).consumedChars;
    const logs = { AAAUSDT: logOf([com("AAAUSDT", bar(0), "QUARANTINED_CURRENT_BAR"), obs("AAAUSDT", { barMs: bar(1), sourceTf: "1W", createdBarOpenTimeMs: BAR0 - 7 * 96 * M15 }), com("AAAUSDT", bar(1))]) };
    ledger.failNext = 1;
    const failing = emitterFor({ logs, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors });
    await expect(runMultiSymbolEmitter(failing.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false })).rejects.toThrow(/database failure/);
    expect((cursors.saved.get("AAAUSDT") as EmitterCursor).consumedChars).toBe(before);
    const retry = emitterFor({ logs, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors });
    await runMultiSymbolEmitter(retry.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    expect([...ledger.rows.values()].map((r) => r.decision.winner.sourceTf)).toEqual(["1W"]);
  });

  it("10. a dry run never writes a production cursor (it cannot even be given a writer) and never touches the ledger", async () => {
    const cursors = new FakeCursors();
    cursors.saved.set("AAAUSDT", {
      schema: EMITTER_CURSOR_SCHEMA, profileId: T.profileId, engineFingerprint: ENGINE, deliveryPolicyVersion: "NATIVE_DELIVERY_V2", marketType: "USDM_PERPETUAL",
      chartInterval: "15m", symbol: "AAAUSDT", lineageId: lineageOf("AAAUSDT"), consumedChars: 0, consumedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      activationChars: 0, activatedAt: "x", activatedByRunId: RUN_ID, updatedAt: "x",
    });
    const snapshot = JSON.stringify([...cursors.saved]);
    const r = await runOnceDry({ AAAUSDT: allTfLog("AAAUSDT") }, { cursors, baseline: "PRODUCTION_CURSOR" });
    expect(r.status.wouldCreate).toBe(3);
    expect([cursors.saves, JSON.stringify([...cursors.saved])]).toEqual([0, snapshot]);
    expect(r.status.cursors.kind).toBe("PRODUCTION_READ_ONLY");
    expect(r.status.cursors.writes).toBe(0);
    const base = emitterFor({ logs: { AAAUSDT: "" } }).deps;
    expect(() => new MultiSymbolNativeEmitter({ ...base, cursorWriter: cursors })).toThrow(/never writes a cursor/);
    expect(() => new MultiSymbolNativeEmitter({ ...base, ledger: new FakeLedger() })).toThrow(/database/);
    expect(() => new MultiSymbolNativeEmitter({ ...base, activateAtEof: true })).toThrow(/never activates/);
  });

  it("a dry run without a production cursor previews activation at EOF in memory only: everything existing is historical", async () => {
    const r = await runOnceDry({ AAAUSDT: allTfLog("AAAUSDT") }, { baseline: "PRODUCTION_CURSOR" });
    expect(r.status.wouldCreate).toBe(0);
    expect(r.status.skipCounts.historicalBeforeActivationCutover).toBe(8);
    expect(r.cursors.saves).toBe(0);
  });

  it("20. duplicate delivery is idempotent: two emitters over the same logs and ledger create each Alert once", async () => {
    const ledger = new FakeLedger();
    for (let i = 0; i < 2; i += 1) {
      const cursors = new FakeCursors();
      const logs = { AAAUSDT: logOf([com("AAAUSDT", bar(0), "QUARANTINED_CURRENT_BAR")]) };
      const a = emitterFor({ logs, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors, activateAtEof: true });
      await runMultiSymbolEmitter(a.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
      logs.AAAUSDT = allTfLog("AAAUSDT");
      const b = emitterFor({ logs, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors });
      await runMultiSymbolEmitter(b.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
      expect(b.emitter.status()).toMatchObject(i === 0 ? { created: 3, ledgerDuplicates: 0 } : { created: 0, ledgerDuplicates: 3 });
    }
    expect(ledger.rows.size).toBe(3);
  });

  it("23. graceful shutdown persists exactly what was processed; the restart finishes without loss or duplication", async () => {
    const { cursors, ledger, start } = activatedState({});
    await runMultiSymbolEmitter(start.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    const logs = { AAAUSDT: allTfLog("AAAUSDT") };
    let processed = 0;
    const first = emitterFor({ logs, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors });
    first.events.push = ((...items: MultiEmitterEvent[]) => {
      processed += items.length;
      return 0;
    }) as typeof first.events.push;
    await runMultiSymbolEmitter(first.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => processed >= 2 });
    const mid = cursors.saved.get("AAAUSDT") as EmitterCursor;
    expect(first.emitter.status().stoppedWithPending).toBeGreaterThan(0);
    expect(mid.consumedChars).toBeLessThan(logs.AAAUSDT.length);
    expect(logs.AAAUSDT.slice(0, mid.consumedChars).endsWith("\n")).toBe(true);
    const rest = emitterFor({ logs, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors });
    await runMultiSymbolEmitter(rest.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    expect([...ledger.rows.values()].map((r) => r.decision.winner.sourceTf).sort()).toEqual(["1D", "1M", "1W"]);
    expect(rest.emitter.status().ledgerDuplicates).toBe(0);
  });

  it("24. the queue is bounded: overflow fails closed with no ledger call and no cursor movement", async () => {
    const { cursors, ledger, start } = activatedState({});
    await runMultiSymbolEmitter(start.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    const before = JSON.stringify([...cursors.saved]);
    const records: ShadowRecord[] = [com("AAAUSDT", bar(0), "QUARANTINED_CURRENT_BAR")];
    for (let i = 1; i <= 12; i += 1) records.push(com("AAAUSDT", bar(i)));
    const big = emitterFor({ logs: { AAAUSDT: logOf(records) }, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors, queueCapacity: 10 });
    await expect(runMultiSymbolEmitter(big.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false })).rejects.toBeInstanceOf(QueueOverflowError);
    expect(ledger.calls).toBe(0);
    expect(JSON.stringify([...cursors.saved])).toBe(before);
  });

  it("follow mode: appended records are picked up, the queue depth is visible, and the maximum is tracked", async () => {
    const logs = { AAAUSDT: "", BBBUSDT: "" };
    const h = emitterFor({ logs });
    await h.emitter.initialize();
    logs.AAAUSDT = allTfLog("AAAUSDT");
    logs.BBBUSDT = allTfLog("BBBUSDT");
    await h.emitter.poll();
    const s = h.emitter.status();
    expect(s.wouldCreate).toBe(6);
    expect(s.queueDepth).toBe(0);
    expect(s.maxQueueDepth).toBe(16);
  });

  it("a cursor that does not match the lane (other lineage, profile or policy) or a rewritten log fails that lane alone", async () => {
    const cursors = new FakeCursors();
    const base = { schema: EMITTER_CURSOR_SCHEMA, profileId: T.profileId, engineFingerprint: ENGINE, deliveryPolicyVersion: "NATIVE_DELIVERY_V2", marketType: "USDM_PERPETUAL", chartInterval: "15m", activationChars: 0, activatedAt: "x", activatedByRunId: RUN_ID, updatedAt: "x", consumedChars: 0, consumedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" } as const;
    cursors.saved.set("AAAUSDT", { ...base, symbol: "AAAUSDT", lineageId: "1".repeat(64) });
    cursors.saved.set("BBBUSDT", { ...base, symbol: "BBBUSDT", lineageId: lineageOf("BBBUSDT"), consumedChars: 5, consumedSha256: "0".repeat(64) });
    const r = await runOnceDry({ AAAUSDT: allTfLog("AAAUSDT"), BBBUSDT: allTfLog("BBBUSDT"), CCCUSDT: allTfLog("CCCUSDT") }, { cursors, baseline: "PRODUCTION_CURSOR" });
    expect(r.status.cursors.lanes.map((l) => l.failure?.split(":")[0] ?? "HEALTHY")).toEqual(["CURSOR_MISMATCH", "LOG_REWRITTEN", "HEALTHY"]);
    expect(cursorMismatch({ ...base, symbol: "X", lineageId: "1".repeat(64), deliveryPolicyVersion: "NATIVE_DELIVERY_V1" as never }, { profileId: T.profileId, engineFingerprint: ENGINE, chartInterval: "15m", symbol: "X", lineageId: "1".repeat(64) })).toMatch(/NATIVE_DELIVERY_V1/);
  });
});

// ===========================================================================
// V2 keys and V1 compatibility
// ===========================================================================

describe("delivery keys: V2 regression vector, V1 untouched", () => {
  const parts = { lineageId: "1".repeat(64), marketType: "USDM_PERPETUAL", symbol: "LDOUSDT", chartInterval: "15m", barOpenTimeMs: BAR0, sourceTf: "1D" };

  it("V2 key: pinned bytes, source-TF aware, and a different schema from V1 for the very same event", () => {
    expect(NATIVE_DELIVERY_KEY_SCHEMA_V2).toBe("teddy.native-alerts.delivery-key.v2");
    expect(NATIVE_DELIVERY_KEY_SCHEMA).toBe("teddy.native-alerts.delivery-key.v1");
    const key = nativeDeliveryKeyV2(parts);
    expect(key).toBe(nativeDeliveryKeyV2({ ...parts }));
    expect(key).toMatchInlineSnapshot(`"62e67d1419c4eac8789eb4a2c76a4e68ed6d224117e40f639487212221ce3231"`);
    expect(nativeDeliveryKeyV2({ ...parts, sourceTf: "1W" })).not.toBe(key);
    expect(nativeDeliveryKey(parts)).not.toBe(key);
  });

  it("a delivery-policy change never changes a V2 key or provenance: the same event can never be delivered twice by a policy tweak", () => {
    const records = parseShadowEventLog(allTfLog("AAAUSDT"), { lineageId: lineageOf("AAAUSDT"), marketType: "USDM_PERPETUAL", symbol: "AAAUSDT", chartInterval: "15m" });
    const wide = selectNativeDeliveriesV2(records, T.delivery).filter((s) => s.kind === "DELIVER");
    const narrow = selectNativeDeliveriesV2(records, { ...T.delivery, dashboardSourceTimeframes: dashboardTimeframes("1D", "1W") }).filter((s) => s.kind === "DELIVER");
    const asKeys = (sel: typeof wide) => sel.map((s) => (s.kind === "DELIVER" ? [s.decision.deliveryKey, s.decision.provenanceSha256] : null));
    expect(asKeys(narrow)).toEqual(asKeys(wide).slice(0, 2));
  });

  it("V1 behaviour is unchanged: one Alert per bar over the realistic log, with V1 keys", () => {
    const records = realisticLog();
    const v1 = selectNativeDeliveries(records).filter((s) => s.kind === "DELIVER");
    expect(v1.map((s) => (s.kind === "DELIVER" ? s.decision.provenance.policyVersion : ""))).toEqual(["NATIVE_DELIVERY_V1", "NATIVE_DELIVERY_V1"]);
    expect(v1.map((s) => (s.kind === "DELIVER" ? s.decision.winner.sourceTf : ""))).toEqual(["1D", "1W"]);
  });
});

describe("the V2 dashboard Alert", () => {
  it("is the canonical native Alert, plus profile and run metadata; it claims no execution and no TradingView equivalence", async () => {
    const r = await runOnceDry({ AAAUSDT: allTfLog("AAAUSDT") });
    const decision = r.decisions.find((d) => d.decision.winner.sourceTf === "1M")!.decision;
    const draft = buildNativeAlertDraftV2(decision, { profile: profileSummaryOf(T), runId: RUN_ID });
    expect(draft).toMatchObject({
      source: "NATIVE", exchange: "BINANCE", assetType: "CRYPTO", symbol: "AAAUSDT", timeframe: "15m", indicatorName: NATIVE_INDICATOR_NAME,
      eventType: "LEVEL_TOUCHED", signal: decision.winner.signal, price: decision.winner.levelPrice, levelColor: decision.winner.levelColor,
      sourceTimeframe: "1M", touchDirection: decision.winner.touchDirection, triggeredAt: new Date(decision.winner.exchangeEventTimeMs),
    });
    const payload = draft.rawPayload as Record<string, Record<string, unknown>>;
    expect(payload.actionable).toBe(false);
    expect(payload.delivery).toMatchObject({ policyVersion: "NATIVE_DELIVERY_V2", deliveryKey: decision.deliveryKey, sourceTimeframe: "1M", lineageId: lineageOf("AAAUSDT"), shadowEventId: decision.winner.eventId, tradingViewEquivalenceClaimed: false });
    expect(payload.profile).toMatchObject({
      profileId: "TEDDY_AGGRESSIVE_V1", profileLabel: "Teddy Aggressive", runId: RUN_ID, engineFingerprint: ENGINE,
      dashboardSourceTimeframes: ["1D", "1W", "1M"], futureExecutionSourceTimeframes: ["1D", "1W"], nativeExecutionEnabled: false,
    });
    expect(JSON.stringify(draft)).not.toMatch(/Account ?[AB]\b|accountIdentifier|executionProfile/);
  });
});

describe("the file cursor store", () => {
  it("round-trips durably per profile/engine/market/interval; a corrupt file fails its lane instead of reading as 'no cursor'", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "emitter-cursors-"));
    dirs.push(root);
    const dir = emitterCursorDir(root, T.profileId, ENGINE, "USDM_PERPETUAL", "15m");
    expect(dir).toBe(path.join(root, "native-emitter", "cursors", "TEDDY_AGGRESSIVE_V1", ENGINE.slice(0, 24), "USDM_PERPETUAL", "15m"));
    const store = new FileEmitterCursorStore(dir);
    expect(store.load("AAAUSDT")).toBeNull();
    const ledger = new FakeLedger();
    const real = { load: (s: string) => store.load(s), save: (c: EmitterCursor) => store.save(c), saved: new Map(), saves: 0, failSaves: 0 } as unknown as FakeCursors;
    const a = emitterFor({ logs: { AAAUSDT: allTfLog("AAAUSDT") }, mode: "COMMIT_DASHBOARD_ALERTS", ledger, cursors: real, activateAtEof: true });
    await runMultiSymbolEmitter(a.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    expect(store.load("AAAUSDT")?.consumedChars).toBe(allTfLog("AAAUSDT").length);
    writeFileSync(path.join(dir, "AAAUSDT.json"), "{torn");
    const b = emitterFor({ logs: { AAAUSDT: allTfLog("AAAUSDT") }, cursors: real, baseline: "PRODUCTION_CURSOR" });
    await runMultiSymbolEmitter(b.emitter, { follow: false, pollMs: 1, sleep: async () => undefined, shouldStop: () => false });
    expect(b.emitter.status().cursors.lanes[0].failure).toMatch(/^CURSOR_MISMATCH/);
    expect(readFileSync(path.join(dir, "AAAUSDT.json"), "utf8")).toBe("{torn");
  });
});

describe("multi-emitter CLI arguments", () => {
  const base = ["--profile", "teddy-aggressive", "--run-id", RUN_ID, "--expect-engine-fingerprint", ENGINE];
  it("defaults to a DRY RUN from production cursors; persistent delivery and activation are explicit and separate", () => {
    expect(parseMultiEmitterCliArgs(base)).toMatchObject({ mode: "DRY_RUN", activateAtEof: false, baseline: "PRODUCTION_CURSOR", follow: false });
    expect(parseMultiEmitterCliArgs([...base, "--commit-dashboard-alerts", "--activate-at-eof"])).toMatchObject({ mode: "COMMIT_DASHBOARD_ALERTS", activateAtEof: true });
    expect(parseMultiEmitterCliArgs([...base, "--dry-run-from-start"]).baseline).toBe("DRY_RUN_FROM_START");
  });
  it.each([
    [["--activate-at-eof"], /only applies with --commit/],
    [["--commit-dashboard-alerts", "--dry-run-from-start"], /never replays history/],
    [["--account", "A"], /unexpected argument/],
    [["--poll-ms", "500"], /only applies with --follow/],
    [["--queue-capacity", "5"], /--queue-capacity/],
  ])("refuses %j", (extra, message) => {
    expect(() => parseMultiEmitterCliArgs([...base, ...extra])).toThrow(message);
  });
  it("refuses a malformed run id or fingerprint, and a missing pin", () => {
    expect(() => parseMultiEmitterCliArgs(["--profile", "teddy-aggressive", "--run-id", "latest", "--expect-engine-fingerprint", ENGINE])).toThrow(MultiEmitterCliUsageError);
    expect(() => parseMultiEmitterCliArgs(["--profile", "teddy-aggressive", "--run-id", RUN_ID, "--expect-engine-fingerprint", "abc"])).toThrow(MultiEmitterCliUsageError);
    expect(() => parseMultiEmitterCliArgs(["--profile", "teddy-aggressive", "--run-id", RUN_ID])).toThrow(/--expect-engine-fingerprint is required/);
  });
});

describe("static: the dry run can never reach the database", () => {
  const SRC = path.resolve(__dirname, "../src/modules/native-alerts");
  const code = (file: string) => readFileSync(path.join(SRC, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("the multi-emitter CLI has no static Prisma import; the client is loaded only inside the COMMIT branch", () => {
    const cli = code("run-native-multi-emitter.ts");
    expect(cli).not.toMatch(/^import[^;]*@prisma\/client/m);
    const branch = cli.indexOf("if (commit) {");
    expect(branch).toBeGreaterThan(0);
    expect(cli.indexOf('await import("@prisma/client")')).toBeGreaterThan(branch);
    expect(cli.indexOf("new PrismaClient()")).toBeGreaterThan(branch);
    // The dry run is handed no cursor writer and no ledger.
    expect(cli).toContain("cursorWriter: commit ? cursorStore : null,");
    expect(cli).toMatch(/let ledger: NativeDeliveryLedgerV2 \| null = null;/);
    expect(cli.match(/ledger = prismaLedger;/g)?.length).toBe(1);
    expect(cli.indexOf("ledger = prismaLedger;")).toBeGreaterThan(branch);
  });
  it.each(["multi-symbol-emitter.ts", "native-delivery-policy-v2.ts", "multi-emitter-cli-args.ts", "native-emitter-state-files.ts"])("%s has no database, account or execution reference", (file) => {
    expect(code(file)).not.toMatch(/prisma|\$transaction|Account ?[AB]\b|accountIdentifier|executionProfile|createExecution|tradeExecution|extreme-rr|selected-plan|binance-execution/i);
  });
});
