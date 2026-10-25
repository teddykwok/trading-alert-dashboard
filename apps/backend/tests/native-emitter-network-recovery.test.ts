import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { scannerRunManifest } from "../src/modules/always-on/always-on-paths";
import { MultiSymbolNativeEmitter, RunBindingError, bindPinnedRun, type CheckpointIdentity, type EmitterCursor, type MultiEmitterEvent } from "../src/modules/native-alerts/multi-symbol-emitter";
import type { NativeDeliveryLedgerV2, NativeDeliveryResult } from "../src/modules/native-alerts/native-alert-ledger";
import type { NativeDeliveryContextV2, NativeDeliveryDecisionV2 } from "../src/modules/native-alerts/native-delivery-policy-v2";
import { FileEmitterCursorStore } from "../src/modules/native-alerts/native-emitter-state-files";
import { LiveCheckpointStore } from "../src/modules/native-scanner/live-shadow-checkpoint";
import { profileSummaryOf } from "../src/modules/native-scanner/scanner-profile";
import { parseRunManifest } from "../src/modules/native-scanner/supervisor-run-manifest";
import { supervisorLiveDirFor } from "../src/modules/native-scanner/supervisor-run-plan";
import { SimulatedMonitoringMachine } from "./helpers/simulated-monitoring-machine";
import { M15, productionTimeline } from "./helpers/simulated-scanner";

/**
 * THE REAL EMITTER ACROSS A NETWORK OUTAGE AND A SCANNER RECOVERY. While the
 * real Always-On supervisor runs real scanner processes over the simulated
 * network, a real MultiSymbolNativeEmitter (COMMIT, follow) shadows each
 * emitter the supervisor starts: bound to that run's real manifest, reading
 * the real shadow logs, writing real cursor files, delivering into an
 * in-memory ledger with the real ledger's idempotency. It is stopped when the
 * supervisor stops its emitter and started, pinned to the fresh run, when the
 * supervisor re-pins. No database, no real network.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

let machines: SimulatedMonitoringMachine[] = [];
afterEach(async () => {
  for (const sm of machines) {
    sm.net.restore();
    if (!sm.supervisorStopped) await sm.shutdown();
    for (const p of sm.processes) p.scanner.stop();
    sm.net.dispose();
  }
  machines = [];
});

/** In-memory delivery ledger with the real ledger's idempotency: one row per delivery key, a repeat is ALREADY_DELIVERED. */
class AuditLedger implements NativeDeliveryLedgerV2 {
  readonly rows = new Map<string, { decision: NativeDeliveryDecisionV2; runId: string; atMs: number }>();
  readonly repeats: string[] = [];
  constructor(private readonly clock: () => number, private readonly runOf: () => string) {}
  async lookupV2(decision: NativeDeliveryDecisionV2) {
    return this.rows.has(decision.deliveryKey) ? ({ state: "DELIVERED", alertId: "a" } as const) : ({ state: "NOT_DELIVERED" } as const);
  }
  async deliverV2(decision: NativeDeliveryDecisionV2, _context: NativeDeliveryContextV2): Promise<NativeDeliveryResult> {
    if (this.rows.has(decision.deliveryKey)) {
      this.repeats.push(decision.deliveryKey);
      return { outcome: "ALREADY_DELIVERED", deliveryKey: decision.deliveryKey, alertId: "a" };
    }
    this.rows.set(decision.deliveryKey, { decision, runId: this.runOf(), atMs: this.clock() });
    return { outcome: "CREATED", deliveryKey: decision.deliveryKey, alertId: `alert-${this.rows.size}` };
  }
}

/** The real cursor files, with every save audited: per lane, consumedChars never goes back and activation never moves. */
class AuditedCursors extends FileEmitterCursorStore {
  readonly saves: EmitterCursor[] = [];
  readonly regressions: string[] = [];
  override save(cursor: EmitterCursor): void {
    const previous = [...this.saves].reverse().find((c) => c.symbol === cursor.symbol && c.lineageId === cursor.lineageId);
    if (previous !== undefined && cursor.consumedChars < previous.consumedChars) this.regressions.push(`${cursor.symbol}: ${previous.consumedChars} -> ${cursor.consumedChars}`);
    if (previous !== undefined && cursor.activationChars !== previous.activationChars) this.regressions.push(`${cursor.symbol}: activation moved ${previous.activationChars} -> ${cursor.activationChars}`);
    this.saves.push(cursor);
    super.save(cursor);
  }
}

describe("the real emitter across an outage and a scanner recovery", () => {
  it("follows run A, is stopped before the scanner is replaced, resumes on run B from its cursors (never reset), skips the outage's replayed bars, stays inside its queue, and delivers every key exactly once", async () => {
    // The registered production engine: the real emitter binds only runs of a registered profile.
    const sm = new SimulatedMonitoringMachine(tmp("emit-net-root-"), tmp("emit-net-cache-"), { timeline: productionTimeline(), symbols: ["AAAUSDT", "BBBUSDT", "龙虾USDT"], symbolsPerConnection: 2 });
    const SYMBOLS = sm.symbols;
    const PROFILE = sm.timeline.profile;
    machines.push(sm);
    const cursorDir = tmp("emit-net-cursors-");
    const cursors = new AuditedCursors(cursorDir);
    const liveDir = supervisorLiveDirFor(sm.root, profileSummaryOf(PROFILE), "15m");
    const logOf = (symbol: string) => {
      const file = path.join(liveDir(symbol), "events.jsonl");
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    };
    const checkpointOf = (symbol: string): CheckpointIdentity | null => new LiveCheckpointStore(liveDir(symbol)).load()?.body ?? null;
    let currentRun = "";
    const ledger = new AuditLedger(() => sm.m.now, () => currentRun);
    const events: MultiEmitterEvent[] = [];
    const depths: number[] = [];

    const bind = (runId: string) => {
      const manifestText = sm.m.files.get(scannerRunManifest(sm.m.paths, runId));
      if (manifestText === undefined) throw new Error(`no manifest for ${runId}`);
      return bindPinnedRun({ manifest: parseRunManifest(manifestText), expect: { profileId: PROFILE.profileId, runId, engineFingerprint: sm.engineFingerprint }, checkpointOf });
    };
    const emitterFor = (runId: string, activateAtEof: boolean) =>
      new MultiSymbolNativeEmitter({
        mode: "COMMIT_DASHBOARD_ALERTS",
        run: bind(runId),
        readLog: logOf,
        cursors,
        cursorWriter: cursors,
        ledger,
        baseline: "PRODUCTION_CURSOR",
        activateAtEof,
        queueCapacity: 10_000,
        pendingTailPolls: 3,
        nowIso: () => new Date(sm.m.now).toISOString(),
        report: (event) => events.push(event),
        progress: () => undefined,
      });

    // The real emitter shadows the supervisor's emitter children: one per pinned run, for as long as it is alive.
    const real = new Map<string, MultiSymbolNativeEmitter>();
    const followed: string[] = [];
    const shadow = async () => {
      const pinned = sm.m.live("emitter").map((e) => e.pinnedRunId as string);
      for (const [runId, emitter] of real) {
        if (!pinned.includes(runId)) {
          emitter.stop(); // the cooperative stop: processed cursors are persisted
          real.delete(runId);
        }
      }
      for (const runId of pinned) {
        if (real.has(runId)) continue;
        currentRun = runId;
        const emitter = emitterFor(runId, followed.length === 0); // first activation only: at current EOF
        await emitter.initialize();
        await emitter.drain();
        real.set(runId, emitter);
        followed.push(runId);
      }
      for (const emitter of real.values()) {
        await emitter.poll();
        depths.push(emitter.status().maxQueueDepth);
      }
    };
    const run = async (ms: number) => {
      const end = sm.m.now + ms;
      while (sm.m.now < end) {
        await sm.runFor(30_000);
        await shadow();
      }
    };

    await sm.start();
    expect(await sm.runUntil(() => sm.supervisor.status().state === "RUNNING", 40 * 60_000)).toBe(true);
    // Run A delivers live alerts first, so a re-delivery after the restart would be visible.
    for (let i = 0; i < 6 * 120 && ledger.rows.size === 0; i += 1) await run(30_000);
    expect(ledger.rows.size).toBeGreaterThan(0);
    await run(Math.floor(sm.m.now / M15) * M15 + 2 * M15 - sm.m.now - 5 * 60_000);
    const [runA] = followed;
    expect(runA).toBe(sm.liveScanner()?.runId);
    const beforeOutage = new Map(SYMBOLS.map((s) => [s, cursors.load(s)?.consumedChars ?? -1]));
    const deliveredBefore = ledger.rows.size;
    const keysOfA = new Set(ledger.rows.keys());

    // The sustained outage across a bar close: run A's symbols fail, Always-On recovers through a fresh run B.
    const cutAt = sm.m.now;
    let restoredAt = 0;
    await sm.net.withOutage({ rest: "REFUSED", openStreams: "DROP", newStreams: "REFUSED", maxDurationMs: 30 * 60_000, label: "sustained" }, async () => {
      await run(25 * 60_000);
      restoredAt = sm.m.now;
    });
    const recovered = await (async () => {
      for (let i = 0; i < 60 && followed.length < 2; i += 1) await run(30_000);
      return followed.length === 2;
    })();
    expect(recovered).toBe(true);
    await run(2 * M15);
    const runB = followed[1];
    // After the recovery the pipeline delivers again: run B's own live alerts reach the ledger.
    for (let i = 0; i < 8 * 120 && ![...ledger.rows.values()].some((r) => r.runId === runB); i += 1) await run(30_000);
    expect([...ledger.rows.values()].some((r) => r.runId === runB)).toBe(true);
    expect(runB).not.toBe(runA);
    expect(runB).toBe(sm.liveScanner()?.runId);

    // Never pinned to a superseded run: a binding that expects run B refuses run A's manifest, and vice versa.
    const manifestA = parseRunManifest(sm.m.files.get(scannerRunManifest(sm.m.paths, runA)) as string);
    expect(() => bindPinnedRun({ manifest: manifestA, expect: { profileId: PROFILE.profileId, runId: runB, engineFingerprint: sm.engineFingerprint }, checkpointOf })).toThrow(RunBindingError);

    // Cursors: never reset, never back, never beyond the log; each lane ends exactly at its log's end.
    expect(cursors.regressions).toEqual([]);
    for (const symbol of SYMBOLS) {
      const cursor = cursors.load(symbol) as EmitterCursor;
      const log = logOf(symbol) as string;
      expect(cursor.consumedChars).toBeGreaterThanOrEqual(beforeOutage.get(symbol) as number);
      expect(cursor.consumedChars).toBeLessThanOrEqual(log.length);
      expect(cursor.activatedByRunId).toBe(runA);
    }
    const final = real.get(runB)?.status();
    expect(final?.symbolsFailed).toBe(0);
    expect(final?.symbolsHealthy).toBe(SYMBOLS.length);
    expect(final?.queueDepth).toBe(0);
    // Bounded catch-up: the queue never held more than its capacity.
    expect(Math.max(...depths)).toBeLessThanOrEqual(10_000);
    // The outage's missed bars were replayed by run B's FAST_RECOVERY start-up — read, and never delivered.
    expect(final?.skipCounts.replayOrNonActionable).toBeGreaterThan(0);
    expect(final?.skipCounts.alreadyProcessedBeforeRestart).toBeGreaterThan(0);
    // No delivery can stem from the outage: no stream delivered anything then, so no live observation exists for it.
    for (const [, row] of ledger.rows) {
      const winner = row.decision.winner;
      expect(winner.classification).toBe("SHADOW_LIVE_ONLY");
      for (const instant of [winner.firstObservedAtMs, winner.exchangeEventTimeMs]) {
        expect(typeof instant).toBe("number");
        expect(instant < cutAt || instant >= restoredAt).toBe(true);
      }
    }
    // Run B delivered only new keys, and only after it was pinned.
    for (const [key, row] of ledger.rows) if (!keysOfA.has(key)) expect(row.runId).toBe(runB);
    // Every delivery key exactly once across both runs: nothing re-delivered after the restart.
    expect(ledger.repeats).toEqual([]);
    expect(final?.ledgerDuplicates).toBe(0);
    expect(new Set([...ledger.rows.keys()]).size).toBe(ledger.rows.size);
    expect(sm.violations).toEqual([]);
    console.log(`emitter across outage: delivered ${deliveredBefore} on ${runA}, ${ledger.rows.size - deliveredBefore} on ${runB}; cursor saves ${cursors.saves.length}`);
  }, 900_000);
});
