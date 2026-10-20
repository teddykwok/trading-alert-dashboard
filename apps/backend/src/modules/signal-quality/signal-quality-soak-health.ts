import type { SignalQualitySoakHealthDto } from "@trading-alert-dashboard/shared";

import { deriveNativeScannerStatus } from "../signal-sources/signal-sources.service";

/**
 * Soak health, derived from the status files the monitoring processes ALREADY
 * write: the scanner supervisor's status.json and the multi-emitter's
 * status-commit.json. Pure: the caller reads the text; this only judges it.
 * Nothing here starts, stops or changes any process.
 *
 * The universe is dynamic: nothing is compared with a fixed symbol count. The
 * exchange-derived candidate count comes from the supervisor's own last
 * universe refresh, and every count the supervisor reports is shown as is.
 */

/** An emitter status older than this cannot prove the emitter is still running (it writes every 30 s by default). */
export const EMITTER_STATUS_FRESHNESS_MS = 5 * 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

function parse(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function deriveScannerHealth(statusText: string | null, nowMs: number): SignalQualitySoakHealthDto["scanner"] {
  const base = deriveNativeScannerStatus(statusText, nowMs);
  const parsed = parse(statusText);
  const totals = isRecord(parsed?.totals) ? parsed.totals : {};
  const universe = isRecord(parsed?.universe) ? parsed.universe : null;
  const capacity = universe && isRecord(universe.capacity) ? universe.capacity : null;
  let lastMarketDataMs: number | null = null;
  if (Array.isArray(parsed?.symbols)) {
    for (const symbol of parsed.symbols as unknown[]) {
      const at = isRecord(symbol) && typeof symbol.lastValidMessageAt === "string" ? Date.parse(symbol.lastValidMessageAt) : Number.NaN;
      if (Number.isFinite(at) && at <= nowMs + 60_000 && (lastMarketDataMs === null || at > lastMarketDataMs)) lastMarketDataMs = at;
    }
  }
  return {
    state: base.state,
    reason: base.reason,
    runId: base.runId,
    startedAt: str(parsed?.startedAt),
    writtenAt: base.writtenAt,
    ageSeconds: base.ageSeconds,
    universe: {
      exchangeCandidates: universe ? num(universe.exchangeCandidates) : null,
      generation: universe ? num(universe.generation) : null,
      stale: universe ? bool(universe.stale) : null,
      selected: num(totals.selected),
      liveEligible: num(totals.liveEligible),
      quarantined: num(totals.quarantined),
      recovering: num(totals.recovering),
      awaitingStream: num(totals.awaitingStream),
      failed: num(totals.failed),
      capacityExceeded: capacity ? bool(capacity.exceeded) : null,
    },
    lastMarketDataAt: lastMarketDataMs === null ? null : new Date(lastMarketDataMs).toISOString(),
    reconnects: num(totals.reconnects),
    backpressureEvents: num(totals.backpressureEvents),
  };
}

export function deriveEmitterHealth(statusText: string | null, nowMs: number): SignalQualitySoakHealthDto["emitter"] {
  const empty = { mode: null, writtenAt: null, ageSeconds: null, created: null, queueDepth: null, maxQueueDepth: null, ledgerDuplicates: null, symbolsTracked: null, symbolsHealthy: null, symbolsFailed: null };
  const parsed = parse(statusText);
  if (statusText === null) return { ...empty, state: "UNKNOWN", reason: "no emitter COMMIT status file for the scanner's current run" };
  if (parsed === null || typeof parsed.schema !== "string") return { ...empty, state: "UNKNOWN", reason: "the emitter status file is not readable" };
  const writtenAtMs = typeof parsed.writtenAt === "string" ? Date.parse(parsed.writtenAt) : Number.NaN;
  if (!Number.isFinite(writtenAtMs) || writtenAtMs > nowMs + 60_000) return { ...empty, state: "UNKNOWN", reason: "the emitter status has no trustworthy timestamp" };
  const ageMs = nowMs - writtenAtMs;
  const fresh = ageMs <= EMITTER_STATUS_FRESHNESS_MS;
  return {
    state: fresh ? "RUNNING" : "STALE",
    reason: fresh ? "the emitter wrote its status within the freshness window" : "the emitter last wrote its status too long ago to prove it is running",
    mode: str(parsed.mode),
    writtenAt: new Date(writtenAtMs).toISOString(),
    ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
    created: num(parsed.created),
    queueDepth: num(parsed.queueDepth),
    maxQueueDepth: num(parsed.maxQueueDepth),
    ledgerDuplicates: num(parsed.ledgerDuplicates),
    symbolsTracked: num(parsed.symbolsTracked),
    symbolsHealthy: num(parsed.symbolsHealthy),
    symbolsFailed: num(parsed.symbolsFailed),
  };
}
