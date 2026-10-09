import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fileSystemNativeScannerEvidence, type NativeExecutionProvenance } from "../src/modules/native-integrity/native-execution-integrity";
import { GovernedPublicTransport } from "../src/modules/native-scanner/candidate-rank-runner";
import { TargetNotReachedError, type StartupRecoverySummary } from "../src/modules/native-scanner/live-shadow-supervisor";
import { USED_WEIGHT_HEADER, parseUsedWeightHeader } from "../src/modules/native-scanner/public-request-weight";
import { TEDDY_7_ALL_ACTIVE_V1, dashboardTimeframes, engineTimeframes, futureExecutionTimeframes, profileSummaryOf, type ScannerProfile } from "../src/modules/native-scanner/scanner-profile";
import {
  STARTUP_RECOVERY_RECORD_FILE,
  STARTUP_RECOVERY_RECORD_SCHEMA,
  sanitizeFailureMessage,
  startRecordingFailure,
  startupRecoveryRecordOf,
  writeStartupRecoveryRecordOnce,
} from "../src/modules/native-scanner/startup-recovery-record";
import { forbidRealNetwork, manualClock } from "./helpers/native-scanner-fakes";
import { M15, cloneState, durableSnapshot, startRun, symbolFacts, syntheticBars, tempDir, type MarketScript } from "./helpers/native-recovery-harness";

/**
 * Start-up recovery OBSERVABILITY (follow-up to FAST_RECOVERY_V1): completedAt,
 * the start-up's peak X-MBX-USED-WEIGHT-1M, the governor's lifetime metrics in
 * status totals, and one durable startup-recovery.json for a FAILED start-up.
 * All of it is observation only: offline, temp directories, fake Binance.
 */

const N = TEDDY_7_ALL_ACTIVE_V1;
const D = (d: number, h = 0, m = 0, s = 0) => Date.UTC(2025, 0, d, h, m, s);
const FIX: ScannerProfile = {
  ...N,
  engine: { ...N.engine, historyStart: "2025-01-06T00:00:00Z", switchover: "2025-01-10T12:00:00Z", engineSourceTimeframes: engineTimeframes("1D") },
  delivery: { ...N.delivery, dashboardSourceTimeframes: dashboardTimeframes("1D") },
  execution: { ...N.execution, futureExecutionSourceTimeframes: futureExecutionTimeframes("1D") },
} as ScannerProfile;
const T0 = D(12, 0, 0, 30);
const T1 = T0 + 96 * M15;
const BARS = syntheticBars(7, D(6), (T0 - D(6)) / M15 + 400);
const SYMBOLS = ["AAAUSDT", "BBBUSDT", "龙虾USDT"];
const market = (over: Partial<MarketScript> = {}): MarketScript => ({ bars: () => BARS, onboardDateMs: () => D(5), ...over });

let BASE: { root: string; cacheDir: string };
// Any real network use (a Binance call) fails the suite.
const restoreNetwork = forbidRealNetwork();
afterAll(() => restoreNetwork());
beforeAll(async () => {
  BASE = { root: tempDir("obs-base-root-"), cacheDir: tempDir("obs-base-cache-") };
  const first = await startRun({ mode: "LEGACY", profile: FIX, symbols: SYMBOLS, market: market(), ...BASE, nowMs: T0 });
  first.supervisor.stop();
}, 120_000);

const restart = async (over: Partial<MarketScript> = {}, mode: "FAST" | "LEGACY" = "FAST", overrides?: Parameters<typeof startRun>[0]["overrides"], symbols: string[] = SYMBOLS) => {
  const dirs = cloneState(BASE);
  const run = await startRun({ mode, profile: FIX, symbols, market: market(over), ...dirs, nowMs: T1, overrides });
  run.supervisor.stop();
  return { run, dirs };
};

// ===========================================================================
// completedAt and the start-up's peak used weight
// ===========================================================================

describe("StartupRecoverySummary: completedAt and peakReportedUsedWeight", () => {
  it("completedAt is the moment the successful recovery walk completed (not a status write or the stop)", async () => {
    const { run } = await restart();
    const recovery = run.supervisor.status().recovery as StartupRecoverySummary;
    expect(recovery.completedAt).toBe(new Date(T1 + recovery.elapsedMs).toISOString());
    expect(run.logs.some((l) => l.startsWith("STARTUP_RECOVERY") && l.includes(`completed ${recovery.completedAt}`))).toBe(true);
  });

  it("a start-up that does not complete has completedAt null (and says so)", async () => {
    let hit = false;
    const { run } = await restart({ respond: (u) => (u.pathname === "/fapi/v1/klines" && !hit ? ((hit = true), { status: 429, body: {} }) : null) });
    expect(run.startError).toBeInstanceOf(TargetNotReachedError);
    expect((run.supervisor.status().recovery as StartupRecoverySummary).completedAt).toBeNull();
    expect(run.logs.some((l) => l.startsWith("STARTUP_RECOVERY") && l.endsWith("DID NOT COMPLETE"))).toBe(true);
  });

  it("peakReportedUsedWeight is the highest valid header seen DURING the start-up; malformed values are ignored", async () => {
    const values = ["37", "abc", " 512 ", "", "1e4", "-3", "12.5", "230"];
    const { run } = await restart({ headers: (_u, i) => ({ [USED_WEIGHT_HEADER]: values[i % values.length] }) });
    expect(run.recovery.peakReportedUsedWeight).toBe(512);
    expect(run.supervisor.status().totals.restPeakReportedUsedWeight).toBe(512);
  });

  it("the summary's peak covers the start-up only: a higher report from a request made before start-up stays out of it (the lifetime total keeps it)", async () => {
    const dirs = cloneState(BASE);
    const run = await startRun({
      mode: "FAST",
      profile: FIX,
      symbols: SYMBOLS,
      market: market({ headers: (u) => ({ [USED_WEIGHT_HEADER]: u.pathname === "/fapi/v1/exchangeInfo" ? "900" : "100" }) }),
      ...dirs,
      nowMs: T1,
      preStart: async (send) => void (await send("https://fapi.binance.com/fapi/v1/exchangeInfo")),
    });
    run.supervisor.stop();
    expect(run.recovery.peakReportedUsedWeight).toBe(100);
    expect(run.supervisor.status().totals.restPeakReportedUsedWeight).toBe(900);
    expect(run.recovery.restRequests).toBe(run.requests.length - 1); // the pre-start request is not a start-up request
  });

  it("no header at all stays UNKNOWN (null), never 0", async () => {
    const { run } = await restart();
    expect(run.recovery.peakReportedUsedWeight).toBeNull();
    expect(run.supervisor.status().totals.restPeakReportedUsedWeight).toBeNull();
    expect(run.logs.some((l) => l.includes("peak used weight unknown"))).toBe(true);
  });

  it("the start-up interval excludes what Binance reported before it began (the lifetime peak keeps it)", async () => {
    const clock = manualClock();
    let next = "900";
    const g = new GovernedPublicTransport(async () => ({ status: 200, header: (h: string) => (h.toLowerCase() === USED_WEIGHT_HEADER.toLowerCase() ? next : null), text: async () => "{}" }), {
      maxTotalRequests: 100,
      minSpacingMs: 250,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });
    const url = "https://fapi.binance.com/fapi/v1/time";
    await g.transport(url, { headers: {} });
    const tracker = g.trackReportedUsedWeight();
    expect(tracker.peak()).toBeNull();
    next = "100";
    await g.transport(url, { headers: {} });
    next = "300";
    await g.transport(url, { headers: {} });
    tracker.stop();
    next = "700";
    await g.transport(url, { headers: {} });
    expect(tracker.peak()).toBe(300);
    expect(g.metrics.peakReportedUsedWeight).toBe(900);
  });

  it("the observation parse is strict; the pause DECISION keeps its own (unchanged) parse", async () => {
    expect(["0", "7", " 1200 ", "999999999"].map(parseUsedWeightHeader)).toEqual([0, 7, 1200, 999_999_999]);
    expect([null, "", " ", "abc", "1e4", "-3", "12.5", "0x10", "1,200", "1000000000"].map(parseUsedWeightHeader)).toEqual(Array(10).fill(null));
    // "1e4" is not a valid observation, yet the pause decision (Number(header) >= high water) is exactly as before.
    const clock = manualClock(Date.UTC(2026, 0, 1, 0, 0, 10));
    const g = new GovernedPublicTransport(async () => ({ status: 200, header: () => "1e4", text: async () => "{}" }), {
      maxTotalRequests: 100,
      minSpacingMs: 250,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
      weightBudget: { maxWeightPerMinute: 300, usedWeightHighWater: 1200 },
    });
    await g.transport("https://fapi.binance.com/fapi/v1/time", { headers: {} });
    expect(g.metrics).toMatchObject({ usedWeightPauses: 1, peakReportedUsedWeight: null });
  });
});

// ===========================================================================
// status().totals: the governor's lifetime metrics
// ===========================================================================

describe("status().totals exposes the governor's lifetime request metrics (observation only)", () => {
  it("weight, weight waits, used-weight pauses and the peak match the governor; the request total is unchanged", async () => {
    const mirrors = (run: Awaited<ReturnType<typeof restart>>["run"]) => {
      const t = run.supervisor.status().totals;
      expect(t).toMatchObject({
        restRequests: run.metrics.requestsMade,
        restWeight: run.metrics.weightUsed,
        restWeightWaits: run.metrics.weightWaits,
        restUsedWeightPauses: run.metrics.usedWeightPauses,
        restPeakReportedUsedWeight: run.metrics.peakReportedUsedWeight,
      });
      expect(t.restRequests).toBe(run.requests.length);
      expect(t.restWeight).toBe(run.requests.reduce((w, r) => w + r.weight, 0));
      return t;
    };
    // Two new symbols bootstrap (heavier pages), so a 10/min budget really binds: weight waits.
    const waits = mirrors((await restart({}, "FAST", { maxWeightPerMinute: 10 }, [...SYMBOLS, "CCCUSDT", "DDDUSDT"])).run);
    expect(waits.restWeightWaits).toBeGreaterThan(0);
    expect(waits.restPeakReportedUsedWeight).toBeNull();
    // Binance reporting the shared IP at 1500: pauses and the peak.
    const pauses = mirrors((await restart({ headers: (u) => ({ [USED_WEIGHT_HEADER]: u.pathname === "/fapi/v1/klines" ? "1500" : "40" }) })).run);
    expect(pauses.restUsedWeightPauses).toBeGreaterThan(0);
    expect(pauses.restPeakReportedUsedWeight).toBe(1500);
  });

  it("observability never changes recovery: FAST with headers, waits and pauses ends byte-identical to LEGACY", async () => {
    const noisy = await restart({ headers: (u, i) => ({ [USED_WEIGHT_HEADER]: i % 3 === 0 ? "1500" : "abc" }) }, "FAST", { maxWeightPerMinute: 10 });
    const legacy = await restart({}, "LEGACY");
    expect(symbolFacts(noisy.run)).toEqual(symbolFacts(legacy.run));
    expect(durableSnapshot({ root: noisy.dirs.root, cache: noisy.dirs.cacheDir })).toEqual(durableSnapshot({ root: legacy.dirs.root, cache: legacy.dirs.cacheDir }));
  });
});

// ===========================================================================
// startup-recovery.json for a FAILED start-up
// ===========================================================================

describe("startup-recovery.json: one durable record of a failed start-up", () => {
  const summary = (): StartupRecoverySummary => ({
    policy: "FAST_RECOVERY_V1", symbols: 3, liveReady: 1, recovered: 1, current: 0, bootstrapped: 0, notLive: 2, missingBarsReplayed: 96, restRequests: 7,
    restWeight: 9, serverClockRequests: 1, maxRequestsInFlight: 2, workerConcurrency: 4, weightWaits: 0, usedWeightPauses: 0, peakReportedUsedWeight: null, elapsedMs: 1234, completedAt: null,
  });
  const runDir = () => path.join(mkdtempSync(path.join(tmpdir(), "obs-run-")), "live-shadow-supervisor", "runs", "20261009T065309Z-bbb0c078");

  it("a real failed start-up (429 halt) is written once, with its summary, outcome and sanitized failure", async () => {
    const { run } = await restart({ respond: (u, i) => (u.pathname === "/fapi/v1/klines" && i === 1 ? { status: 429, body: {} } : null) });
    const dir = runDir();
    const record = startupRecoveryRecordOf({ runId: "20261009T065309Z-bbb0c078", recovery: run.supervisor.status().recovery, error: run.startError, writtenAt: "2026-10-09T07:00:00.000Z" });
    expect(writeStartupRecoveryRecordOnce(dir, record)).toBe("WRITTEN");
    const written = JSON.parse(readFileSync(path.join(dir, STARTUP_RECOVERY_RECORD_FILE), "utf8"));
    expect(written).toMatchObject({
      schema: STARTUP_RECOVERY_RECORD_SCHEMA,
      actionable: false,
      outcome: "STARTUP_FAILED",
      runId: "20261009T065309Z-bbb0c078",
      recovery: { policy: "FAST_RECOVERY_V1", completedAt: null, restRequests: run.recovery.restRequests },
      failure: { name: "TargetNotReachedError", message: expect.stringMatching(/^TARGET_NOT_REACHED/) },
    });
    expect(readdirSync(dir)).toEqual([STARTUP_RECOVERY_RECORD_FILE]); // no temp file left behind
  });

  it("an existing record is never overwritten (not by a second write, not by a racing one)", () => {
    const dir = runDir();
    const first = startupRecoveryRecordOf({ runId: "r", recovery: summary(), error: new Error("first"), writtenAt: "2026-10-09T07:00:00.000Z" });
    const second = startupRecoveryRecordOf({ runId: "r", recovery: summary(), error: new Error("second"), writtenAt: "2026-10-09T07:00:01.000Z" });
    expect(writeStartupRecoveryRecordOnce(dir, first)).toBe("WRITTEN");
    const bytes = readFileSync(path.join(dir, STARTUP_RECOVERY_RECORD_FILE), "utf8");
    expect(writeStartupRecoveryRecordOnce(dir, second)).toBe("ALREADY_PRESENT");
    expect(readFileSync(path.join(dir, STARTUP_RECOVERY_RECORD_FILE), "utf8")).toBe(bytes);
    // A file someone else put there first is left exactly as it was.
    const other = runDir();
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, STARTUP_RECOVERY_RECORD_FILE), "operator note");
    expect(writeStartupRecoveryRecordOnce(other, first)).toBe("ALREADY_PRESENT");
    expect(readFileSync(path.join(other, STARTUP_RECOVERY_RECORD_FILE), "utf8")).toBe("operator note");
    expect(readdirSync(dir).sort()).toEqual([STARTUP_RECOVERY_RECORD_FILE]);
  });

  it("a failure to write the record never masks the original start-up failure", async () => {
    const original = new TargetNotReachedError("TARGET_NOT_REACHED: REST_HALTED", {} as never);
    const reports: string[] = [];
    await expect(
      startRecordingFailure(
        async () => {
          throw original;
        },
        () => {
          throw new Error("EACCES: disk refused");
        },
        (line) => reports.push(line)
      )
    ).rejects.toBe(original);
    expect(reports).toEqual([`${STARTUP_RECOVERY_RECORD_FILE} not written (Error); the start-up failure follows`]);
    // Recording succeeds: still the original error; a successful start records nothing.
    let recorded = 0;
    await expect(startRecordingFailure(async () => Promise.reject(original), () => void (recorded += 1), () => undefined)).rejects.toBe(original);
    await startRecordingFailure(async () => undefined, () => void (recorded += 10), () => undefined);
    expect(recorded).toBe(1);
  });

  it("no secret, URL, header, account or environment value can enter the record", () => {
    const secret = "AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789";
    const error = Object.assign(new Error(`GET https://fapi.binance.com/fapi/v2/account?signature=${secret}&apiKey=XYZ failed for key ${secret}`), {
      code: "HTTP_ERROR",
      headers: { "X-MBX-APIKEY": secret },
      config: { apiSecret: secret, accountIdentifier: "acct-a-main" },
      env: { BINANCE_API_KEY: secret },
    });
    const dirty = Object.assign(summary(), { apiKey: secret, accountIdentifier: "acct-a-main", headers: { Authorization: secret } });
    const record = startupRecoveryRecordOf({ runId: "r", recovery: dirty, error, writtenAt: "2026-10-09T07:00:00.000Z" });
    const text = JSON.stringify(record);
    for (const forbidden of [secret, "signature", "apiKey", "XYZ", "acct-a-main", "X-MBX-APIKEY", "apiSecret", "BINANCE_API_KEY", "Authorization", "https://"]) {
      expect({ forbidden, hit: text.includes(forbidden) }).toEqual({ forbidden, hit: false });
    }
    expect(Object.keys(record).sort()).toEqual(["actionable", "failure", "notice", "outcome", "recovery", "runId", "schema", "writtenAt"]);
    expect(Object.keys(record.recovery as object).sort()).toEqual(Object.keys(summary()).sort());
    expect(record.failure).toEqual({ name: "Error", code: "HTTP_ERROR", message: "GET <url> failed for key <redacted>" });
    expect(sanitizeFailureMessage("x ".repeat(2_000))).toHaveLength(500);
    // A non-conforming error code is dropped, never copied.
    expect(startupRecoveryRecordOf({ runId: "r", recovery: null, error: Object.assign(new Error("e"), { code: `lower ${secret}` }), writtenAt: "t" }).failure.code).toBeNull();
  });

  it("no scanner, emitter or execution-integrity reader can pick the file up", () => {
    // 1. The integrity evidence reader reads the symbol's engine directory by name: the record changes nothing,
    //    even if it were (wrongly) placed beside the checkpoint itself.
    const local = mkdtempSync(path.join(tmpdir(), "obs-local-"));
    const scannerRoot = path.join(local, "trading-alert-dashboard", "scanner");
    cpSync(BASE.root, scannerRoot, { recursive: true });
    const provenance: NativeExecutionProvenance = {
      lineageId: "0".repeat(64), shadowEventId: "0".repeat(64), marketType: "USDM_PERPETUAL", symbol: "AAAUSDT", chartInterval: "15m",
      barOpenTimeMs: T0, levelKey: "1D:GOR:0", profileId: FIX.profileId, engineFingerprint: profileSummaryOf(FIX).engineFingerprint,
    };
    const read = () => JSON.stringify(fileSystemNativeScannerEvidence({ LOCALAPPDATA: local })(provenance));
    const before = read();
    expect(before).toContain("checkpoint"); // real evidence was found
    const record = JSON.stringify(startupRecoveryRecordOf({ runId: "r", recovery: summary(), error: new Error("x"), writtenAt: "t" }));
    const runDirPath = path.join(scannerRoot, "live-shadow-supervisor", "runs", "r");
    mkdirSync(runDirPath, { recursive: true });
    writeFileSync(path.join(runDirPath, STARTUP_RECOVERY_RECORD_FILE), record);
    const symbolDir = readdirSync(path.join(scannerRoot, "live-shadow-engines"), { recursive: true, withFileTypes: true })
      .find((e) => e.isFile() && e.name === "checkpoint.json" && e.parentPath.includes("AAAUSDT"))!.parentPath;
    writeFileSync(path.join(symbolDir, STARTUP_RECOVERY_RECORD_FILE), record);
    expect(read()).toBe(before);
    // 2. Every reader of a run directory opens fixed file names; none lists the directory.
    const src = (rel: string) => readFileSync(path.resolve(__dirname, "../src", rel), "utf8");
    for (const rel of ["modules/native-alerts/run-native-multi-emitter.ts", "modules/signal-sources/signal-sources.service.ts", "modules/native-integrity/native-execution-integrity.ts", "modules/native-alerts/multi-symbol-emitter.ts"]) {
      expect({ rel, lists: /readdirSync/.test(src(rel)), names: src(rel).includes(STARTUP_RECOVERY_RECORD_FILE) }).toEqual({ rel, lists: false, names: false });
    }
    expect(existsSync(path.join(runDirPath, STARTUP_RECOVERY_RECORD_FILE))).toBe(true);
  });
});
