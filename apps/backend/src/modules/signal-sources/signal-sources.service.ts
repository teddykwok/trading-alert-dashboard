import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

import { scannerRootDir } from "../native-scanner/scanner-paths";

/**
 * SIGNAL SOURCES — read-only observability of the two independent alert sources.
 *
 * TradingView: there is no persistent connection to TradingView and no
 * heartbeat from it. The only truthful statements are that this process serves
 * the webhook route (it registered it at startup, and refuses to start without
 * a webhook secret) and when an actual TradingView alert was last received.
 * "No recent alert" is NOT unhealthy — TradingView simply sends nothing until a
 * condition fires.
 *
 * Native scanner: the supervisor already writes an observational status file.
 * This reads it, never writes it, and never infers RUNNING from a file's mere
 * existence: RUNNING requires runState RUNNING AND a write within the freshness
 * window; anything else is STOPPED, STALE or UNKNOWN.
 *
 * No database write, no new state system, no account, no execution path.
 */

/** A RUNNING status older than this cannot be proven current. The supervisor writes every 60 s by default. */
export const NATIVE_STATUS_FRESHNESS_MS = 5 * 60_000;

export type NativeScannerState = "RUNNING" | "STOPPED" | "STALE" | "UNKNOWN";

export interface NativeScannerStatusDto {
  readonly state: NativeScannerState;
  readonly reason: string;
  readonly profileId: string | null;
  readonly profileLabel: string | null;
  readonly runId: string | null;
  readonly engineFingerprintPrefix: string | null;
  readonly targetEligible: number | null;
  readonly acceptedEligible: number | null;
  readonly selected: number | null;
  readonly liveEligible: number | null;
  readonly failed: number | null;
  readonly writtenAt: string | null;
  readonly ageSeconds: number | null;
  readonly freshnessWindowSeconds: number;
}

export interface TradingViewSourceDto {
  /** This process serves POST /api/webhooks/tradingview with a configured secret. Never "connected": there is no connection. */
  readonly webhook: "READY";
  readonly webhookRoute: "/api/webhooks/tradingview";
  /** The last ACTUAL TradingView alert received (createdAt), or null when none exists. */
  readonly lastReceivedAt: string | null;
  readonly lastReceivedSymbol: string | null;
}

export interface SignalSourcesStatusDto {
  readonly generatedAt: string;
  readonly tradingView: TradingViewSourceDto;
  readonly native: NativeScannerStatusDto & { readonly lastDeliveredAt: string | null; readonly lastDeliveredSymbol: string | null };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function empty(state: NativeScannerState, reason: string): NativeScannerStatusDto {
  return {
    state,
    reason,
    profileId: null,
    profileLabel: null,
    runId: null,
    engineFingerprintPrefix: null,
    targetEligible: null,
    acceptedEligible: null,
    selected: null,
    liveEligible: null,
    failed: null,
    writtenAt: null,
    ageSeconds: null,
    freshnessWindowSeconds: NATIVE_STATUS_FRESHNESS_MS / 1000,
  };
}

/**
 * The scanner's state from its status file text (null = no file). Pure.
 * Fail-closed in the honest direction: unknown shapes are UNKNOWN, old files
 * are STALE, and only a fresh, explicitly RUNNING status reads as RUNNING.
 */
export function deriveNativeScannerStatus(text: string | null, nowMs: number, freshnessMs: number = NATIVE_STATUS_FRESHNESS_MS): NativeScannerStatusDto {
  if (text === null) return empty("UNKNOWN", "no supervisor status file found");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty("UNKNOWN", "the supervisor status file is not readable");
  }
  if (!isRecord(parsed) || typeof parsed.schema !== "string" || !parsed.schema.startsWith("teddy.native-scanner.live-shadow-supervisor-status.")) {
    return empty("UNKNOWN", "the supervisor status file has an unknown shape");
  }
  const writtenAtMs = typeof parsed.writtenAt === "string" ? Date.parse(parsed.writtenAt) : Number.NaN;
  if (Number.isNaN(writtenAtMs) || writtenAtMs > nowMs + 60_000) return empty("UNKNOWN", "the supervisor status has no trustworthy timestamp");
  const ageMs = nowMs - writtenAtMs;
  const totals = isRecord(parsed.totals) ? parsed.totals : {};
  const selection = isRecord(parsed.selection) ? parsed.selection : {};
  const profile = isRecord(parsed.profile) ? parsed.profile : null;
  const engine = str(parsed.engineFingerprint) ?? (profile ? str(profile.engineFingerprint) : null);
  const runState = parsed.runState;

  let state: NativeScannerState;
  let reason: string;
  if (runState === "STOPPED") {
    state = "STOPPED";
    reason = "the last supervisor run reported that it stopped";
  } else if (runState === "RUNNING" && ageMs <= freshnessMs) {
    state = "RUNNING";
    reason = "the supervisor reported RUNNING within the freshness window";
  } else if (runState === "RUNNING") {
    state = "STALE";
    reason = "the supervisor last reported RUNNING too long ago to prove it is still running";
  } else {
    // A status from before run states existed: its state cannot be proven either way.
    state = ageMs <= freshnessMs ? "UNKNOWN" : "STALE";
    reason = "the supervisor status does not record a run state";
  }

  return {
    state,
    reason,
    profileId: profile ? str(profile.profileId) : null,
    profileLabel: profile ? str(profile.profileLabel) : null,
    runId: str(parsed.runId),
    engineFingerprintPrefix: engine ? engine.slice(0, 12) : null,
    targetEligible: num(selection.targetEligible),
    acceptedEligible: num(selection.acceptedEligible),
    selected: num(totals.selected),
    liveEligible: num(totals.liveEligible),
    failed: num(totals.failed),
    writtenAt: new Date(writtenAtMs).toISOString(),
    ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
    freshnessWindowSeconds: freshnessMs / 1000,
  };
}

export interface SignalSourcesDeps {
  readonly prisma: Pick<PrismaClient, "alert">;
  /** The supervisor's latest status text, or null. Injected in tests. */
  readonly readNativeStatus?: () => string | null;
  readonly now?: () => Date;
}

/** The supervisor's latest observational status file, from the local scanner directory. Read-only. */
export function readLocalNativeStatus(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const file = path.join(scannerRootDir(env), "live-shadow-supervisor", "status.json");
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    // No scanner directory configured on this machine: unknown, not an error.
    return null;
  }
}

export async function readSignalSourcesStatus(deps: SignalSourcesDeps): Promise<SignalSourcesStatusDto> {
  const now = (deps.now ?? (() => new Date()))();
  const [lastTradingView, lastNative] = await Promise.all([
    deps.prisma.alert.findFirst({ where: { source: "TRADINGVIEW" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true, symbol: true } }),
    deps.prisma.alert.findFirst({ where: { source: "NATIVE" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true, symbol: true } }),
  ]);
  const native = deriveNativeScannerStatus((deps.readNativeStatus ?? readLocalNativeStatus)(), now.getTime());
  return {
    generatedAt: now.toISOString(),
    tradingView: {
      webhook: "READY",
      webhookRoute: "/api/webhooks/tradingview",
      lastReceivedAt: lastTradingView ? lastTradingView.createdAt.toISOString() : null,
      lastReceivedSymbol: lastTradingView?.symbol ?? null,
    },
    native: {
      ...native,
      lastDeliveredAt: lastNative ? lastNative.createdAt.toISOString() : null,
      lastDeliveredSymbol: lastNative?.symbol ?? null,
    },
  };
}
