import {
  SIGNAL_QUALITY_FLAG_CODES,
  SIGNAL_QUALITY_FRESHNESS_STATES,
  SIGNAL_QUALITY_HORIZON_KEYS,
  SIGNAL_QUALITY_HORIZON_STATES,
  SIGNAL_QUALITY_INTEGRITY_FILTERS,
  SIGNAL_QUALITY_MAX_ALERTS,
  SIGNAL_QUALITY_PAGE_MAX_SIZE,
  SIGNAL_QUALITY_PLAN_OUTCOMES,
  SIGNAL_QUALITY_QUERY_KEYS,
  SIGNAL_QUALITY_SCOPE_FILTERS,
  SIGNAL_QUALITY_SORTS,
  SIGNAL_QUALITY_TIMEFRAME_CLASSES,
  SOURCE_TIMEFRAMES,
} from "@trading-alert-dashboard/shared";

import { ValidationError } from "../../utils/errors";
import type { SignalQualityFilters, SignalQualityQuery } from "./signal-quality.service";

/**
 * Strict parsing of the signal-quality GET query. Every key must be one this
 * API knows and every value one it accepts; anything else is a 400, never
 * silently ignored or widened.
 */

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
/** Binance symbols, including the exchange's Unicode ones: letters and digits only. */
const SYMBOL = /^[\p{L}\p{N}]{1,40}$/u;
export const SIGNAL_QUALITY_DEFAULT_PAGE_SIZE = 50;

function one(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${key} must be given once`);
  return value;
}

function oneOf<T extends string>(query: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const value = one(query, key);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new ValidationError(`${key} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function instant(query: Record<string, unknown>, key: string): number | null {
  const value = one(query, key);
  if (value === undefined) return null;
  const ms = Date.parse(value);
  if (!ISO.test(value) || !Number.isFinite(ms)) throw new ValidationError(`${key} must be an ISO-8601 UTC instant (…Z)`);
  return ms;
}

function integer(query: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const value = one(query, key);
  if (value === undefined) return fallback;
  if (!/^\d{1,6}$/.test(value) || Number(value) < min || Number(value) > max) throw new ValidationError(`${key} must be an integer ${min}..${max}`);
  return Number(value);
}

export function parseSignalQualityQuery(raw: unknown, extraKeys: readonly string[] = []): SignalQualityQuery {
  const query = (raw ?? {}) as Record<string, unknown>;
  const allowed = new Set<string>([...SIGNAL_QUALITY_QUERY_KEYS, ...extraKeys]);
  const unknown = Object.keys(query).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ValidationError(`Unknown query parameter(s): ${unknown.join(", ")}`);

  const symbol = one(query, "symbol");
  if (symbol !== undefined && !SYMBOL.test(symbol)) throw new ValidationError("symbol must be letters and digits only");
  const filters: SignalQualityFilters = {
    symbol,
    sourceTimeframe: oneOf(query, "sourceTimeframe", SOURCE_TIMEFRAMES),
    direction: oneOf(query, "direction", ["LONG", "SHORT"] as const),
    levelColor: oneOf(query, "levelColor", ["GREEN", "RED"] as const),
    timeframeClass: oneOf(query, "timeframeClass", SIGNAL_QUALITY_TIMEFRAME_CLASSES),
    integrity: oneOf(query, "integrity", SIGNAL_QUALITY_INTEGRITY_FILTERS),
    freshness: oneOf(query, "freshness", SIGNAL_QUALITY_FRESHNESS_STATES),
    planOutcome: oneOf(query, "planOutcome", SIGNAL_QUALITY_PLAN_OUTCOMES),
    horizon: oneOf(query, "horizon", SIGNAL_QUALITY_HORIZON_KEYS),
    horizonState: oneOf(query, "horizonState", SIGNAL_QUALITY_HORIZON_STATES),
    flag: oneOf(query, "flag", SIGNAL_QUALITY_FLAG_CODES),
  };
  if (filters.horizon !== undefined && filters.horizonState === undefined) throw new ValidationError("horizon is used with horizonState");
  return {
    soakStartMs: instant(query, "soakStart"),
    soakEndMs: instant(query, "soakEnd"),
    scope: oneOf(query, "scope", SIGNAL_QUALITY_SCOPE_FILTERS) ?? "ALL",
    asOfMs: instant(query, "asOf"),
    filters,
    sort: oneOf(query, "sort", SIGNAL_QUALITY_SORTS) ?? "TRIGGERED_DESC",
    offset: integer(query, "offset", 0, SIGNAL_QUALITY_MAX_ALERTS, 0),
    pageSize: integer(query, "pageSize", 1, SIGNAL_QUALITY_PAGE_MAX_SIZE, SIGNAL_QUALITY_DEFAULT_PAGE_SIZE),
  };
}

/** asOf alone (detail and chart). */
export function parseAsOfOnly(raw: unknown): number | null {
  const query = (raw ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(query).filter((key) => key !== "asOf");
  if (unknown.length > 0) throw new ValidationError(`Unknown query parameter(s): ${unknown.join(", ")}`);
  return instant(query, "asOf");
}

export const ALERT_ID = /^[A-Za-z0-9_-]{1,64}$/;
