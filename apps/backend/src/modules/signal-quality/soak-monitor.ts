import path from "node:path";

import { assessSoakContinuity, type SoakContinuity, type SoakPlan, type SoakSnapshotFacts } from "./soak-continuity";

/**
 * THE 24-HOUR SOAK MONITOR: periodic, READ-ONLY heartbeat snapshots of the
 * already-running monitoring stack, so nobody has to click every hour.
 *
 * Each tick makes HTTP GETs to the generic backend (health, signal sources,
 * Native planner status, soak health, signal-quality summary for the soak
 * window) and writes the answers to a snapshot file in an operator-chosen
 * directory OUTSIDE the repository, plus a continuity report. That is all it
 * does: it opens no database, reads no environment secret, holds no
 * credential, calls no exchange, starts and stops nothing, and the backend
 * routes it reads are GET-only. If the machine sleeps or the monitor dies, the
 * gap is visible in the next report as SOAK_INTERRUPTED.
 */

export interface SoakMonitorArgs {
  readonly baseUrl: string;
  readonly soakStartMs: number;
  readonly soakHours: number;
  readonly everyMinutes: number;
  readonly outDir: string;
  readonly once: boolean;
}

export class SoakMonitorUsageError extends Error {}

export const SOAK_MONITOR_USAGE = [
  "Usage (READ ONLY — no execution authority, no private Binance, no database):",
  "  signal-quality:soak-monitor --out <dir outside the repository> [--soak-start <ISO …Z>] [--soak-hours 24] [--every-minutes 15]",
  "    [--base-url http://127.0.0.1:4000] [--once]",
].join("\n");

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

export function parseSoakMonitorArgs(argv: readonly string[], nowMs: number): SoakMonitorArgs {
  const usage = (message: string): never => {
    throw new SoakMonitorUsageError(`${message}\n${SOAK_MONITOR_USAGE}`);
  };
  const values = new Map<string, string>();
  let once = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--once") {
      once = true;
      continue;
    }
    if (!["--out", "--soak-start", "--soak-hours", "--every-minutes", "--base-url"].includes(token)) usage(`unexpected argument: ${token}`);
    if (values.has(token)) usage(`${token} given twice`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usage(`${token} needs a value`);
    values.set(token, value);
    i += 1;
  }
  const out = values.get("--out") ?? usage("--out is required");
  const integer = (name: string, min: number, max: number, fallback: number) => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) usage(`${name} must be an integer ${min}..${max}`);
    return Number(raw);
  };
  const startRaw = values.get("--soak-start");
  let soakStartMs = nowMs;
  if (startRaw !== undefined) {
    if (!ISO.test(startRaw) || !Number.isFinite(Date.parse(startRaw))) usage("--soak-start must be an ISO-8601 UTC instant (…Z)");
    soakStartMs = Date.parse(startRaw);
  }
  const baseRaw = values.get("--base-url") ?? "http://127.0.0.1:4000";
  let base: URL;
  try {
    base = new URL(baseRaw);
  } catch {
    return usage("--base-url is not a URL");
  }
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") {
    usage("--base-url must be a plain http(s) origin without credentials");
  }
  return {
    baseUrl: base.origin,
    soakStartMs,
    soakHours: integer("--soak-hours", 1, 72, 24),
    everyMinutes: integer("--every-minutes", 1, 120, 15),
    outDir: path.resolve(out),
    once,
  };
}

export interface FetchedJson {
  readonly ok: boolean;
  readonly status: number | null;
  readonly body: unknown;
  readonly error: string | null;
}

export type JsonGetter = (url: string) => Promise<FetchedJson>;

export interface SoakSnapshot {
  readonly schema: "native-signal-quality.soak-snapshot.v1";
  readonly notice: readonly string[];
  readonly takenAt: string;
  readonly soakStart: string;
  readonly expectedSoakEnd: string;
  readonly health: FetchedJson;
  readonly signalSources: FetchedJson;
  readonly nativePlanner: FetchedJson;
  readonly soakHealth: FetchedJson;
  readonly summary: FetchedJson;
}

const NOTICE = ["MONITORING ONLY", "NO EXECUTION AUTHORITY", "NO PRIVATE BINANCE", "NO DATABASE WRITES"];

/** Every URL the monitor ever requests: GETs of read-only backend routes. */
export function soakMonitorUrls(args: Pick<SoakMonitorArgs, "baseUrl" | "soakStartMs" | "soakHours">): Record<"health" | "signalSources" | "nativePlanner" | "soakHealth" | "summary", string> {
  const end = args.soakStartMs + args.soakHours * 3_600_000;
  const window = `soakStart=${encodeURIComponent(new Date(args.soakStartMs).toISOString())}&soakEnd=${encodeURIComponent(new Date(end).toISOString())}`;
  return {
    health: `${args.baseUrl}/health`,
    signalSources: `${args.baseUrl}/api/signal-sources/status`,
    nativePlanner: `${args.baseUrl}/api/native-planner/status`,
    soakHealth: `${args.baseUrl}/api/signal-quality/soak-health`,
    summary: `${args.baseUrl}/api/signal-quality/summary?${window}`,
  };
}

export async function takeSoakSnapshot(args: SoakMonitorArgs, get: JsonGetter, nowMs: number): Promise<SoakSnapshot> {
  const urls = soakMonitorUrls(args);
  const [health, signalSources, nativePlanner, soakHealth, summary] = await Promise.all([get(urls.health), get(urls.signalSources), get(urls.nativePlanner), get(urls.soakHealth), get(urls.summary)]);
  return {
    schema: "native-signal-quality.soak-snapshot.v1",
    notice: NOTICE,
    takenAt: new Date(nowMs).toISOString(),
    soakStart: new Date(args.soakStartMs).toISOString(),
    expectedSoakEnd: new Date(args.soakStartMs + args.soakHours * 3_600_000).toISOString(),
    health,
    signalSources,
    nativePlanner,
    soakHealth,
    summary,
  };
}

const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** The continuity facts one snapshot proves. */
export function snapshotFacts(snapshot: SoakSnapshot): SoakSnapshotFacts {
  const soak = record(snapshot.soakHealth.body);
  const scanner = record(soak?.scanner);
  const emitter = record(soak?.emitter);
  return {
    takenAtMs: Date.parse(snapshot.takenAt),
    backendReachable: snapshot.health.ok && snapshot.soakHealth.ok,
    scannerState: typeof scanner?.state === "string" ? scanner.state : null,
    scannerRunId: typeof scanner?.runId === "string" ? scanner.runId : null,
    emitterState: typeof emitter?.state === "string" ? emitter.state : null,
  };
}

export function soakPlanOf(args: SoakMonitorArgs): SoakPlan {
  return { soakStartMs: args.soakStartMs, expectedSoakEndMs: args.soakStartMs + args.soakHours * 3_600_000, intervalMs: args.everyMinutes * 60_000 };
}

export interface SoakReport {
  readonly schema: "native-signal-quality.soak-report.v1";
  readonly notice: readonly string[];
  readonly generatedAt: string;
  readonly continuity: SoakContinuity;
  /** The newest snapshot's signal-quality summary for the soak window (as the backend computed it). */
  readonly latestSummary: unknown;
  readonly latestSoakHealth: unknown;
}

export function soakReportOf(args: SoakMonitorArgs, snapshots: readonly SoakSnapshot[], nowMs: number): SoakReport {
  const latest = [...snapshots].sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt)).at(-1) ?? null;
  return {
    schema: "native-signal-quality.soak-report.v1",
    notice: NOTICE,
    generatedAt: new Date(nowMs).toISOString(),
    continuity: assessSoakContinuity(soakPlanOf(args), snapshots.map(snapshotFacts), nowMs),
    latestSummary: latest?.summary.body ?? null,
    latestSoakHealth: latest?.soakHealth.body ?? null,
  };
}
