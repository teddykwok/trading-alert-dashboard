import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NativeEngineState, NativeKline } from "@trading-alert-dashboard/shared";

import { GovernedPublicTransport, type GovernorMetrics } from "../../src/modules/native-scanner/candidate-rank-runner";
import { canonicalJson } from "../../src/modules/native-scanner/canonical-json";
import { KlineCacheStore } from "../../src/modules/native-scanner/kline-cache";
import { BinanceServerClock, REQUEST_POLICY_LIMITS, type PublicHttpResponse, type PublicHttpTransport } from "../../src/modules/native-scanner/kline-fetcher";
import type { LineageConfig } from "../../src/modules/native-scanner/live-shadow-cli-args";
import { LiveShadowSupervisor, NATIVE_RECOVERY_POLICY_VERSION, type StartupRecoverySummary } from "../../src/modules/native-scanner/live-shadow-supervisor";
import { FAST_RECOVERY_DEFAULTS, LEGACY_RECOVERY_DEFAULTS } from "../../src/modules/native-scanner/live-shadow-supervisor-cli-args";
import { publicRequestWeight } from "../../src/modules/native-scanner/public-request-weight";
import { acquireLiveShadowLock } from "../../src/modules/native-scanner/scanner-lock";
import { lineageConfigOf, profileSummaryOf, type ScannerProfile } from "../../src/modules/native-scanner/scanner-profile";
import { makeRunId } from "../../src/modules/native-scanner/supervisor-run-manifest";
import { supervisorLiveDirFor, supervisorSelectionOf } from "../../src/modules/native-scanner/supervisor-run-plan";
import { parseExchangeInfoContracts, selectUsdtPerpetualUniverse } from "../../src/modules/native-scanner/usdm-universe";

/**
 * A deterministic, offline restart of the live-shadow supervisor, run through
 * EITHER recovery policy against the SAME trusted state and the SAME market:
 *
 *   LEGACY — the original serial governor (1 in flight, 1 s spacing, no
 *            weight budget), a serverTime request per fetch, full-size pages,
 *            2 symbol workers;
 *   FAST   — FAST_RECOVERY_V1 as the CLI wires it (shared Binance clock,
 *            range-sized pages, 2 in flight, 300 weight/min, IP pause at
 *            1200, 4 symbol workers).
 *
 * The fake Binance answers from in-memory 15m bars (only bars that have
 * CLOSED by the fake clock), records every request with its start time, and
 * can fail, gate or tamper with chosen requests. Nothing touches the network
 * or any machine-local scanner directory: every run gets temp directories.
 */

export const M15 = 15 * 60_000;
export type RecoveryMode = "LEGACY" | "FAST";

export interface RecordedRequest {
  readonly url: string;
  readonly atMs: number;
  readonly weight: number;
}

export interface MarketScript {
  /** Bars Binance knows for a symbol (closed-ness is applied by the fake clock). */
  readonly bars: (symbol: string) => readonly NativeKline[];
  /** exchangeInfo onboardDate for a symbol. */
  readonly onboardDateMs: (symbol: string) => number;
  /** Answer this request instead (status/body), or null to serve it normally. Called with the 0-based request index. */
  readonly respond?: (url: URL, index: number) => { status: number; body: unknown; headers?: Record<string, string> } | null;
  /** Rewrite a klines page before it is sent (duplicate rows, out-of-order rows, ...). */
  readonly tamperPage?: (symbol: string, rows: NativeKline[]) => NativeKline[];
  /** Hold every klines request of a symbol until released. */
  readonly gate?: (symbol: string) => Promise<void> | null;
  /** Extra response headers on normally served responses (e.g. X-MBX-USED-WEIGHT-1M). */
  readonly headers?: (url: URL, index: number) => Record<string, string>;
  /** Event-loop turns each response takes (real asynchrony, no clock change), so requests can overlap in flight. */
  readonly latencyTurns?: number;
}

export interface RunResult {
  readonly supervisor: LiveShadowSupervisor;
  readonly requests: RecordedRequest[];
  readonly logs: string[];
  readonly metrics: GovernorMetrics;
  readonly recovery: StartupRecoverySummary;
  readonly maxInFlight: number;
  readonly startError: unknown;
  readonly nowMs: number;
  /** Moves the fake clock (and so the market) forward. */
  readonly advance: (ms: number) => void;
}

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A deterministic, choppy 15m series with daily ranges well beyond 7%, so levels form, arm, retest and cool down. */
export function syntheticBars(seed: number, startMs: number, count: number, basePrice = 100): NativeKline[] {
  let state = seed >>> 0 || 1;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const bars: NativeKline[] = [];
  let center = basePrice;
  let amplitude = 0.05;
  let phase = 0;
  let previousClose = basePrice;
  for (let i = 0; i < count; i += 1) {
    if (i % 96 === 0) {
      center *= 1 + (rand() - 0.5) * 0.06;
      amplitude = 0.04 + rand() * 0.03;
      phase = rand() * Math.PI * 2;
    }
    const t = (i % 96) / 96;
    const close = +(center * (1 + amplitude * Math.sin(2 * Math.PI * t + phase))).toFixed(6);
    const open = previousClose;
    const high = +(Math.max(open, close) * (1 + 0.001 + rand() * 0.002)).toFixed(6);
    const low = +(Math.min(open, close) * (1 - 0.001 - rand() * 0.002)).toFixed(6);
    const openTimeMs = startMs + i * M15;
    bars.push({ openTimeMs, closeTimeMs: openTimeMs + M15 - 1, open, high, low, close });
    previousClose = close;
  }
  return bars;
}

function contractRow(symbol: string, onboardDateMs: number) {
  return { symbol, baseAsset: symbol.replace(/USDT$/, ""), quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", onboardDate: onboardDateMs, underlyingType: "COIN" };
}

const toRow = (k: NativeKline) => [k.openTimeMs, String(k.open), String(k.high), String(k.low), String(k.close), "1", k.closeTimeMs, "1", 1, "1", "1", "0"];

/**
 * One supervisor start (a "run") at `nowMs` over `root` and `cacheDir`.
 * The run is left started; call `supervisor.stop()` to release its locks.
 */
export async function startRun(input: {
  readonly mode: RecoveryMode;
  readonly profile: ScannerProfile;
  readonly symbols: readonly string[];
  readonly market: MarketScript;
  readonly root: string;
  readonly cacheDir: string;
  readonly nowMs: number;
  /** Overrides for the mode's defaults (tests of the policy itself). */
  readonly overrides?: { maxInFlight?: number; maxWeightPerMinute?: number; restConcurrency?: number; minSpacingMs?: number; usedWeightHighWater?: number };
  /** Called after start() returns or throws, before results are read. */
  readonly onStarted?: (supervisor: LiveShadowSupervisor) => void;
  readonly beforeStart?: (supervisor: LiveShadowSupervisor) => void;
  /** Requests sent through the run's governor BEFORE start-up (as the CLI's first exchangeInfo is). */
  readonly preStart?: (send: (url: string) => Promise<unknown>) => Promise<void>;
}): Promise<RunResult> {
  const { mode, profile, market } = input;
  let now = input.nowMs;
  const requests: RecordedRequest[] = [];
  const logs: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const respond = (status: number, body: unknown, headers: Record<string, string> = {}): PublicHttpResponse => ({
    status,
    header: (name) => headers[Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase()) ?? ""] ?? null,
    text: async () => JSON.stringify(body),
  });
  const transport: PublicHttpTransport = async (url) => {
    const index = requests.length;
    requests.push({ url, atMs: now, weight: publicRequestWeight(url) });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const u = new URL(url);
      const symbol = u.searchParams.get("symbol");
      if (symbol !== null && u.pathname === "/fapi/v1/klines") {
        const gate = market.gate?.(symbol) ?? null;
        if (gate !== null) await gate;
      }
      await Promise.resolve();
      for (let turn = 0; turn < (market.latencyTurns ?? 0); turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      const scripted = market.respond?.(u, index) ?? null;
      if (scripted !== null) return respond(scripted.status, scripted.body, scripted.headers);
      const extra = market.headers?.(u, index) ?? {};
      if (u.pathname === "/fapi/v1/time") return respond(200, { serverTime: now }, extra);
      if (u.pathname === "/fapi/v1/klines") {
        const start = Number(u.searchParams.get("startTime"));
        const end = Number(u.searchParams.get("endTime"));
        const limit = Number(u.searchParams.get("limit"));
        let rows = market.bars(symbol as string).filter((b) => b.openTimeMs >= start && b.openTimeMs <= end && b.closeTimeMs < now).slice(0, limit);
        if (market.tamperPage) rows = market.tamperPage(symbol as string, rows);
        return respond(200, rows.map(toRow), extra);
      }
      return respond(404, {}, extra);
    } finally {
      inFlight -= 1;
    }
  };
  const sleep = async (ms: number) => {
    now += ms;
  };
  const fast = mode === "FAST";
  const o = input.overrides ?? {};
  const governor = new GovernedPublicTransport(transport, {
    maxTotalRequests: 20_000,
    minSpacingMs: o.minSpacingMs ?? (fast ? FAST_RECOVERY_DEFAULTS.minSpacingMs : LEGACY_RECOVERY_DEFAULTS.minSpacingMs),
    nowMs: () => now,
    sleep,
    maxInFlight: o.maxInFlight ?? (fast ? FAST_RECOVERY_DEFAULTS.maxInFlight : LEGACY_RECOVERY_DEFAULTS.maxInFlight),
    weightBudget: fast
      ? { maxWeightPerMinute: o.maxWeightPerMinute ?? FAST_RECOVERY_DEFAULTS.maxWeightPerMinute, usedWeightHighWater: o.usedWeightHighWater ?? FAST_RECOVERY_DEFAULTS.usedWeightHighWater }
      : null,
  });
  const spacing = o.minSpacingMs ?? (fast ? FAST_RECOVERY_DEFAULTS.minSpacingMs : LEGACY_RECOVERY_DEFAULTS.minSpacingMs);
  const fetchDeps = {
    transport: governor.transport,
    baseUrl: "https://fapi.binance.com",
    policy: { maxRequests: REQUEST_POLICY_LIMITS.maxRequestsCeiling, minSpacingMs: spacing, maxTransientRetries: 2, transientBackoffMs: Math.max(2_000, spacing) },
    nowMs: () => now,
    sleep,
  };
  const universe = () =>
    selectUsdtPerpetualUniverse(parseExchangeInfoContracts({ symbols: input.symbols.map((s) => contractRow(s, market.onboardDateMs(s))) }), "EXCHANGE_INFO_UNICODE_V1");
  const summary = profileSummaryOf(profile);
  const lineage: LineageConfig = lineageConfigOf(profile.engine);
  const selection = supervisorSelectionOf(universe(), { mode: "UNIVERSE", include: [], exclude: [], maxSymbols: null });
  const supervisor = new LiveShadowSupervisor(
    {
      lineage,
      selection,
      universeActive: selection.candidates.length,
      symbolsPerConnection: 50,
      maxConnections: 16,
      restConcurrency: o.restConcurrency ?? (fast ? FAST_RECOVERY_DEFAULTS.restConcurrency : LEGACY_RECOVERY_DEFAULTS.restConcurrency),
      queueCapacity: 10_000,
      maxProcessingLagMs: 600_000,
      staleSymbolMs: 1_800_000,
      maxRecoveryAttempts: 3,
      liveDirFor: supervisorLiveDirFor(input.root, summary, "15m"),
      runId: makeRunId(now, "fa57c0de"),
      profile: summary,
      dynamicUniverse: { refreshIntervalMs: 300_000 },
    },
    {
      openStream: (_url, handlers) => {
        handlers.onOpen();
        return { close: () => undefined };
      },
      governor,
      fetchDeps,
      cache: new KlineCacheStore(input.cacheDir),
      acquireLock: (dir) => acquireLiveShadowLock(dir, { pid: 4242, owner: "test", startedAt: "t", isProcessAlive: () => false }),
      nowMs: () => now,
      nowIso: () => new Date(now).toISOString(),
      schedule: () => undefined,
      log: (line) => logs.push(line),
      fetchUniverse: async () => universe(),
      recordMembership: () => undefined,
      recoveryFetch: fast
        ? { version: NATIVE_RECOVERY_POLICY_VERSION, serverClock: new BinanceServerClock(fetchDeps, FAST_RECOVERY_DEFAULTS.serverClockMaxAgeMs), sizePagesToRange: true }
        : null,
    }
  );
  input.beforeStart?.(supervisor);
  if (input.preStart) await input.preStart((url) => governor.transport(url, { headers: {} }));
  let startError: unknown = null;
  try {
    await supervisor.start();
  } catch (error) {
    startError = error;
  }
  input.onStarted?.(supervisor);
  return {
    supervisor,
    requests,
    logs,
    metrics: governor.metrics,
    recovery: supervisor.status().recovery as StartupRecoverySummary,
    maxInFlight,
    startError,
    nowMs: now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Every durable file under the given roots, by relative path; JSON `writtenAt` provenance stripped (it is never part of any hash). */
export function durableSnapshot(roots: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (label: string, base: string, dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(label, base, full);
        continue;
      }
      if (entry.endsWith(".lock") || entry.endsWith(".tmp")) continue;
      const rel = `${label}/${path.relative(base, full).split(path.sep).join("/")}`;
      let text = readFileSync(full, "utf8");
      if (entry.endsWith(".json")) {
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          delete parsed.writtenAt;
          text = canonicalJson(parsed);
        } catch {
          // not JSON: compared as bytes
        }
      }
      out[rel] = text;
    }
  };
  for (const [label, dir] of Object.entries(roots)) walk(label, dir, dir);
  return out;
}

/** Copies a trusted starting state so two policies can recover from byte-identical inputs. */
export function cloneState(from: { root: string; cacheDir: string }): { root: string; cacheDir: string } {
  const root = tempDir("recov-root-");
  const cacheDir = tempDir("recov-cache-");
  cpSync(from.root, root, { recursive: true });
  cpSync(from.cacheDir, cacheDir, { recursive: true });
  return { root, cacheDir };
}

/** Per-symbol facts that must not depend on the recovery policy. */
export function symbolFacts(result: RunResult) {
  const workers = (result.supervisor as unknown as { workers: Map<string, { session: { committedState: NativeEngineState; hwmOpenTimeMs: number } | null }> }).workers;
  return result.supervisor
    .status()
    .symbols.map((s) => ({
      symbol: s.symbol,
      status: s.status,
      failure: s.failure,
      lineageId: s.lineageId,
      hwm: s.hwm,
      origin: s.origin,
      stateDir: s.stateDir,
      engineState: canonicalJson(workers.get(s.symbol)?.session?.committedState ?? null),
    }))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}

/** The committed engine state of one symbol after a run, or null. */
export function engineStateOf(result: RunResult, symbol: string): NativeEngineState | null {
  const workers = (result.supervisor as unknown as { workers: Map<string, { session: { committedState: NativeEngineState } | null }> }).workers;
  return workers.get(symbol)?.session?.committedState ?? null;
}

/** Sum of request weight in the heaviest rolling 60 s window. */
export function peakWeightPerMinute(requests: readonly RecordedRequest[]): number {
  let peak = 0;
  for (let i = 0; i < requests.length; i += 1) {
    let sum = 0;
    for (let j = i; j < requests.length && requests[j].atMs < requests[i].atMs + 60_000; j += 1) sum += requests[j].weight;
    peak = Math.max(peak, sum);
  }
  return peak;
}
