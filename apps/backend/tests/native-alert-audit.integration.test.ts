import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotNativeEngineForNextBar, type NativeKline } from "@trading-alert-dashboard/shared";
import type { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";
import { doji, repeat, type Ohlc } from "./helpers/native-signal-fixtures";
import { FIFTEEN_MINUTES_MS as M15, fifteenMinute } from "./helpers/native-scanner-fakes";

/**
 * native-alerts:audit against the TEST database, on a genuine scanner run.
 *
 * The fixture reproduces the real 1000000BOBUSDT timeline (2026-10-02) in
 * miniature, with the real LiveShadowSession:
 *   bar L0  GREEN 121 is TRIGGER_READY and is touched — but the scanner is not
 *           running yet, so L0 is committed at start-up replay: never live;
 *   bar L1  readiness is established mid-bar: QUARANTINED_CURRENT_BAR;
 *           GREEN 121 is now in COOLDOWN (touched at L0);
 *   bar L2  GREEN 120 is TRIGGER_READY and is touched live: delivered.
 * The ranker, evaluating L0, ranked GREEN 121 first — correctly.
 */

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient = testDatabase;
const maybe = () => (available ? it : it.skip);

const { auditNativeAlert, levelTimeline, withReadOnlyTransaction } = await import("../src/modules/native-audit/native-alert-audit");
const { parseLineageConfig } = await import("../src/modules/native-scanner/live-shadow-cli-args");
const { prepareLiveShadowState, LiveShadowSession } = await import("../src/modules/native-scanner/live-shadow-session");
const { LiveCheckpointStore } = await import("../src/modules/native-scanner/live-shadow-checkpoint");
const { LiveShadowEventStore } = await import("../src/modules/native-scanner/live-shadow-store");
const { evaluateSymbol, rankCandidates } = await import("../src/modules/native-scanner/candidate-ranker");
const { parseShadowEventLog } = await import("../src/modules/native-alerts/shadow-log-reader");
const { NativeAlertEmitter } = await import("../src/modules/native-alerts/native-alert-emitter");
const { PrismaNativeDeliveryLedger } = await import("../src/modules/native-alerts/native-alert-ledger");

const D = (d: number, h = 0, m = 0) => Date.UTC(2025, 0, d, h, m);
const L0 = D(11);
const L1 = L0 + M15;
const L2 = L1 + M15;
const ARGS: Record<string, string> = {
  "--interval": "15m",
  "--history-start": "2025-01-06T00:00:00Z",
  "--switchover": "2025-01-10T12:00:00Z",
  "--min-move-percent": "7",
  "--touch-tolerance-percent": "1",
  "--cooldown-bars": "10",
  "--min-bars-after-creation": "5",
  "--min-bars-after-arming": "4",
  "--source-timeframes": "1D",
  "--max-levels": "500",
  "--timing": "Immediate",
  "--partial-period-policy": "SWITCHOVER_TRUNCATED_CLOSED_BARS",
};
const LINEAGE = parseLineageConfig((name) => ARGS[name]);

function bars(): NativeKline[] {
  const rows: Ohlc[] = [];
  rows.push(...repeat(doji(100), 96));
  rows.push([100, 120, 99, 99], ...repeat(doji(99), 95)); // Jan 7: GREEN 120 (band 118.8..121.2)
  rows.push(...repeat(doji(99), 96));
  rows.push([99, 121, 98.5, 99], ...repeat(doji(99), 94), [99, 99, 98.9, 98.9]); // Jan 9: GREEN 121 (band 119.79..122.21)
  rows.push([98.9, 123, 98.9, 123], ...repeat(doji(123), 95)); // Jan 10: both armed
  rows.push([123, 123, 121.5, 122.5]); // L0: 121.5 enters 121's band only
  rows.push([122.5, 122.6, 122.3, 122.4]); // L1: no touch
  rows.push([122.4, 122.4, 121.0, 121.3]); // L2: 121.0 enters 120's band
  rows.push(...repeat(doji(121.3), 4));
  return fifteenMinute(D(6), rows);
}
const SYMBOL = "TESTUSDT";
const REQUEST = { symbol: SYMBOL, marketType: "USDM_PERPETUAL" as const, ...LINEAGE, partialPeriodPolicy: "SWITCHOVER_TRUNCATED_CLOSED_BARS" as const, expectedLineageId: null };

const dirs: string[] = [];
interface Run {
  dir: string;
  lineageId: string;
  text: string;
  alertId: string;
  symbol: string;
}

/** The scanner starts during L1 (L0 replayed at start-up), then sees L1 and L2 live; the emitter delivers. */
async function scannerAndEmitter(symbol: string): Promise<Run> {
  const all = bars().map((b) => b);
  const dir = mkdtempSync(path.join(tmpdir(), "native-audit-"));
  dirs.push(dir);
  const checkpoints = new LiveCheckpointStore(dir);
  const plan = prepareLiveShadowState(all, { ...REQUEST, symbol }, L1, null);
  checkpoints.save(plan.checkpointBody, "2025-01-11T00:16:00.000Z");
  const events = new LiveShadowEventStore(dir);
  let now = L1 + 60_000;
  const session = new LiveShadowSession({ plan, checkpoints, events, nowMs: () => now, nowIso: () => new Date(now).toISOString(), persistClosedBar: () => undefined });
  const update = (openTimeMs: number, [o, h, l, c]: Ohlc, closed: boolean, eventTimeMs: number) => {
    now = eventTimeMs;
    return { symbol, interval: "15m" as const, eventTimeMs, openTimeMs, closeTimeMs: openTimeMs + M15 - 1, open: o, high: h, low: l, close: c, closed };
  };
  const first = update(L1, [122.5, 122.6, 122.3, 122.4], false, L1 + 60_000);
  session.markStreamReady(first);
  session.onUpdate(first);
  session.onUpdate(update(L1, [122.5, 122.6, 122.3, 122.4], true, L2 + 1));
  session.onUpdate(update(L2, [122.4, 122.4, 122.4, 122.4], false, L2 + 1_000));
  session.onUpdate(update(L2, [122.4, 122.4, 121.0, 121.3], false, L2 + 90_000));
  session.onUpdate(update(L2, [122.4, 122.4, 121.0, 121.3], true, L2 + M15));
  const text = readFileSync(events.file, "utf8");
  const identity = { lineageId: plan.lineageId, marketType: "USDM_PERPETUAL" as const, symbol, chartInterval: "15m" as const };
  const emitter = new NativeAlertEmitter({ mode: "COMMIT_DASHBOARD_ALERTS", ledger: new PrismaNativeDeliveryLedger(prisma), report: () => undefined });
  await emitter.process(parseShadowEventLog(text, identity));
  const alert = await prisma.alert.findFirstOrThrow({ where: { symbol, source: "NATIVE" } });
  return { dir, lineageId: plan.lineageId, text, alertId: alert.id, symbol };
}

let seq = 0;
const nextSymbol = () => `NAUD${++seq}${Date.now() % 100000}USDT`;
const inputsFor = (run: Run, over: Partial<Parameters<typeof auditNativeAlert>[1]> = {}) => ({
  alertId: run.alertId,
  lineage: LINEAGE,
  readShadowLog: () => run.text,
  readCheckpointLineage: () => run.lineageId,
  loadKlines: () => bars(),
  ...over,
});

async function cleanup() {
  if (!available) return;
  await prisma.extremeRRPlan.deleteMany({ where: { alert: { symbol: { startsWith: "NAUD" } } } });
  await prisma.nativeAlertDelivery.deleteMany({ where: { symbol: { startsWith: "NAUD" } } });
  await prisma.alert.deleteMany({ where: { symbol: { startsWith: "NAUD" } } });
}
beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe("the forensic audit on a genuine scanner run", () => {
  maybe()("PASSes every section and finds zero plans, executions or execution artifacts", async () => {
    const run = await scannerAndEmitter(nextSymbol());
    const report = await auditNativeAlert(prisma, inputsFor(run));
    expect({ mapping: report.alertMapping, ledger: report.ledger, shadow: report.shadowEvent, provenance: report.provenance, readiness: report.engineReadiness }).toEqual({
      mapping: { verdict: "PASS", findings: [] },
      ledger: { verdict: "PASS", findings: [] },
      shadow: { verdict: "PASS", findings: [] },
      provenance: { verdict: "PASS", findings: [] },
      readiness: { verdict: "PASS", findings: [] },
    });
    expect(report.dbSafety).toMatchObject({ verdict: "PASS", planCount: 0, tradeExecutionCount: 0, executionArtifactCount: 0 });
    expect(report.dbSafety.artifacts.filter((a) => a.count > 0)).toEqual([{ table: "NativeAlertDelivery", via: "alertId", count: 1, class: "EXPECTED_LEDGER" }]);
    expect(report.dbSafety.artifacts.some((a) => a.table === "TradeExecution")).toBe(true);
    expect(report.proofLimits.proven.join("\n")).toMatch(/band entry: persisted OHLC-so-far low 121/);
    expect(report.proofLimits.proven.join("\n")).toMatch(/reconstructImmediateCandidates reproduces the observation/);
    expect(report.proofLimits.notProven.join("\n")).toMatch(/TradingView/);
    expect(report.overall).toBe("PASS");
  });

  maybe()("1W-vs-1D regression: the ranker's first pick was touched before readiness; the delivered level is the next one", async () => {
    const run = await scannerAndEmitter(nextSymbol());
    // What the ranker saw while L0 was forming: GREEN 121 first, TRIGGER_READY.
    const atL0 = prepareLiveShadowState(bars(), REQUEST, L0, null).state;
    const rows = evaluateSymbol({ symbol: SYMBOL, displaySymbol: `${SYMBOL}.P`, lineageId: run.lineageId, snapshot: snapshotNativeEngineForNextBar(atL0), config: atL0.config }, { price: 122.4, observedAtMs: L0 + 420_000, source: "test" }, ["1D"]);
    const ranked = rankCandidates(rows, { deliverySourceTfs: ["1D"], includeNotReady: false, top: 5, maxPerSymbol: 5 });
    expect(ranked.map((r) => [r.levelPrice, r.triggerReadiness])).toEqual([
      [121, "TRIGGER_READY"],
      [120, "TRIGGER_READY"],
    ]);
    // The timeline from durable evidence and the canonical engine.
    const identity = { lineageId: run.lineageId, marketType: "USDM_PERPETUAL" as const, symbol: run.symbol, chartInterval: "15m" as const };
    const { rows: timeline } = levelTimeline(bars(), LINEAGE, run.symbol, L0, L2, [{ sourceTf: "1D", color: "GREEN", price: 121 }, { sourceTf: "1D", color: "GREEN", price: 120 }], parseShadowEventLog(run.text, identity));
    const at = (ms: number, price: number) => timeline.find((r) => r.barOpenTime === new Date(ms).toISOString() && r.level.endsWith(` ${price}`))!;
    expect(at(L0, 121)).toMatchObject({ readiness: "TRIGGER_READY", inBand: true, immediateCandidate: true, committedCandidate: true });
    expect(at(L0, 121).scannerBar).toMatch(/^BEFORE_SCANNER_READINESS/);
    expect(at(L0, 120)).toMatchObject({ readiness: "TRIGGER_READY", inBand: false, immediateCandidate: false });
    expect(at(L1, 121)).toMatchObject({ readiness: "COOLDOWN", scannerBar: "QUARANTINED_CURRENT_BAR" });
    expect(at(L2, 121)).toMatchObject({ readiness: "COOLDOWN", immediateCandidate: false, scannerBar: "SHADOW_LIVE_ONLY" });
    expect(at(L2, 120)).toMatchObject({ readiness: "TRIGGER_READY", inBand: true, immediateCandidate: true, committedCandidate: true, scannerBar: "SHADOW_LIVE_ONLY" });
    // And what was actually delivered: GREEN 120 at L2, nothing for 121.
    const alert = await prisma.alert.findUniqueOrThrow({ where: { id: run.alertId } });
    expect([alert.price, alert.sourceTimeframe, alert.levelColor, alert.signal]).toEqual([120, "1D", "GREEN", "LONG"]);
    expect(run.text).not.toContain(`"levelPrice":121`);
  });
});

describe("the audit fails closed", () => {
  maybe()("a ledger row that names another winning event", async () => {
    const run = await scannerAndEmitter(nextSymbol());
    await prisma.nativeAlertDelivery.updateMany({ where: { alertId: run.alertId }, data: { winningShadowEventId: "0".repeat(64) } });
    const report = await auditNativeAlert(prisma, inputsFor(run));
    expect(report.shadowEvent.verdict).toBe("FAIL");
    expect(report.overall).toBe("FAIL");
  });

  maybe()("a shadow log without the winning event, or with a different event, or refused by the parser", async () => {
    const run = await scannerAndEmitter(nextSymbol());
    const commitsOnly = run.text.split("\n").filter((l) => !l.includes("LIVE_IMMEDIATE_OBSERVATION")).join("\n");
    expect((await auditNativeAlert(prisma, inputsFor(run, { readShadowLog: () => commitsOnly }))).shadowEvent.verdict).toBe("FAIL");
    expect((await auditNativeAlert(prisma, inputsFor(run, { readShadowLog: () => `${run.text}{torn` }))).shadowEvent.verdict).toBe("FAIL");
    expect((await auditNativeAlert(prisma, inputsFor(run, { readShadowLog: () => null }))).overall).toBe("FAIL");
    expect((await auditNativeAlert(prisma, inputsFor(run, { readCheckpointLineage: () => "9".repeat(64) }))).shadowEvent.verdict).toBe("FAIL");
  });

  maybe()("a provenance hash that does not recompute", async () => {
    const run = await scannerAndEmitter(nextSymbol());
    await prisma.nativeAlertDelivery.updateMany({ where: { alertId: run.alertId }, data: { provenanceSha256: "f".repeat(64) } });
    const report = await auditNativeAlert(prisma, inputsFor(run));
    expect(report.provenance.verdict).toBe("FAIL");
    expect(report.overall).toBe("FAIL");
  });

  maybe()("an Alert row that differs from the canonical mapping", async () => {
    const run = await scannerAndEmitter(nextSymbol());
    await prisma.alert.update({ where: { id: run.alertId }, data: { price: 121 } });
    const report = await auditNativeAlert(prisma, inputsFor(run));
    expect(report.alertMapping.verdict).toBe("FAIL");
    expect(report.alertMapping.findings.join(" ")).toMatch(/price/);
  });

  maybe()("a different lineage config, or no local klines: the state cannot be rebuilt, so readiness FAILs", async () => {
    const run = await scannerAndEmitter(nextSymbol());
    const otherConfig = parseLineageConfig((name) => (name === "--cooldown-bars" ? "9" : ARGS[name]));
    expect((await auditNativeAlert(prisma, inputsFor(run, { lineage: otherConfig }))).engineReadiness.findings.join(" ")).toMatch(/rebuilt lineage/);
    expect((await auditNativeAlert(prisma, inputsFor(run, { loadKlines: () => null }))).engineReadiness.verdict).toBe("FAIL");
  });

  maybe()("any plan row reachable from the NATIVE alert is reported and FAILs the audit", async () => {
    const run = await scannerAndEmitter(nextSymbol());
    // Forced in directly — the planner fence makes this unreachable in production.
    await prisma.extremeRRPlan.create({ data: { alertId: run.alertId, status: "PENDING", direction: "LONG", entryPrice: "120", cutoffAt: new Date(L2), timeframe: "15m", selectedLookback: 300 } });
    const report = await auditNativeAlert(prisma, inputsFor(run));
    expect(report.dbSafety).toMatchObject({ verdict: "FAIL", planCount: 1 });
    expect(report.overall).toBe("FAIL");
  });

  maybe()("an unknown alert, and a non-NATIVE alert, are FAIL — never safe", async () => {
    const unknown = await auditNativeAlert(prisma, { ...inputsFor({ dir: "", lineageId: "", text: "", alertId: "doesnotexist000000000000", symbol: "" }) });
    expect(unknown.overall).toBe("FAIL");
    const tv = await prisma.alert.create({ data: { symbol: nextSymbol(), assetType: "CRYPTO", timeframe: "15m", price: 1, signal: "LONG", rawPayload: {}, triggeredAt: new Date() } });
    const report = await auditNativeAlert(prisma, { ...inputsFor({ dir: "", lineageId: "", text: "", alertId: tv.id, symbol: tv.symbol }) });
    expect(report.alertMapping.findings.join(" ")).toMatch(/not NATIVE/);
    expect(report.overall).toBe("FAIL");
  });

  maybe()("the audit's transaction is READ ONLY: the database refuses a write inside it", async () => {
    await expect(
      withReadOnlyTransaction(prisma, (tx) => tx.alert.create({ data: { symbol: nextSymbol(), assetType: "CRYPTO", timeframe: "15m", price: 1, signal: "LONG", rawPayload: {}, triggeredAt: new Date() } }))
    ).rejects.toThrow(/read-only transaction/);
  });

  maybe()("a database error during the safety scan is an error, never a PASS", async () => {
    const run = await scannerAndEmitter(nextSymbol());
    const broken = new Proxy(prisma, {
      get(target, prop) {
        if (prop === "$transaction") {
          return (fn: (tx: unknown) => Promise<unknown>) =>
            target.$transaction((tx) =>
              fn(new Proxy(tx, { get: (t, p) => (p === "$queryRawUnsafe" ? async () => Promise.reject(new Error("connection lost")) : Reflect.get(t, p)) }))
            );
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PrismaClient;
    await expect(auditNativeAlert(broken, inputsFor(run))).rejects.toThrow(/connection lost/);
  });
});

// ---------------------------------------------------------------------------
// Static: the audit module can only read
// ---------------------------------------------------------------------------

const AUDIT_DIR = path.resolve(__dirname, "../src/modules/native-audit");
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("native-audit is read-only by construction", () => {
  it("contains exactly the audit core and its CLI, and no write, queue, network or signing", () => {
    const files = readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".ts")).sort();
    expect(files).toEqual(["native-alert-audit.ts", "run-native-alert-audit.ts"]);
    for (const file of files) {
      const body = code(readFileSync(path.join(AUDIT_DIR, file), "utf8"));
      for (const pattern of [
        /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
        /\$executeRaw(?!Unsafe\("SET TRANSACTION READ ONLY"\))/,
        /bullmq|redis|enqueue|notify|socket/i,
        /fetch\s*\(|WebSocket|fapi|binance-execution|binance\.client|createHmac|signature|BINANCE_API/i,
      ]) {
        expect({ file, hit: body.match(pattern)?.[0] ?? null }).toEqual({ file, hit: null });
      }
      // Every $executeRawUnsafe is exactly the READ ONLY statement.
      for (const m of body.matchAll(/\$executeRawUnsafe\(([^)]*)\)/g)) expect(m[1]).toBe('"SET TRANSACTION READ ONLY"');
    }
    expect(code(readFileSync(path.join(AUDIT_DIR, "run-native-alert-audit.ts"), "utf8"))).toMatch(/^\s*import "\.\.\/\.\.\/config\/bootstrap-generic";/m);
  });
});
