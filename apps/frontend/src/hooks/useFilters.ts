import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ALERT_STATUSES,
  ASSET_TYPES,
  LEVEL_COLORS,
  SIGNAL_TYPES,
  SOURCE_TIMEFRAMES,
} from "@trading-alert-dashboard/shared";
import type { SignalType } from "../types/alert";
import type { AlertListQuery } from "../types/api";

/**
 * The signals a trader can act on directly. WATCH (context/ambiguous) and
 * EXIT stay fully supported — they are just not shown by default because
 * WATCH alerts tend to clutter the feed.
 */
export const ACTIONABLE_SIGNALS: SignalType[] = ["LONG", "SHORT"];

const ACTIONABLE_KEY = [...ACTIONABLE_SIGNALS].sort().join(",");

/**
 * URL sentinel for "all signals". The default (actionable) is omitted from
 * the URL entirely, so the explicit no-signal-filter choice needs its own
 * representation — otherwise it would collapse back into the default on
 * refresh. Never sent to the API (it parses to `signals: undefined`).
 */
const ALL_SIGNALS_PARAM = "ALL";

/** Every query-string key the dashboard filters own. */
const FILTER_PARAM_KEYS = [
  "status",
  "symbol",
  "signals",
  "assetType",
  "sourceTimeframe",
  "sourceTimeframes",
  "levelColor",
] as const;

function parseEnum<T extends string>(allowed: readonly T[], value: string | null): T | undefined {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** Comma-separated list; invalid entries are dropped, empty result = absent. */
function parseEnumList<T extends string>(
  allowed: readonly T[],
  value: string | null
): T[] | undefined {
  if (!value) return undefined;
  const valid = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is T => (allowed as readonly string[]).includes(entry));
  return valid.length > 0 ? valid : undefined;
}

/**
 * URL query string -> dashboard filters. The URL is the canonical filter
 * state, so refresh, back/forward, bookmarks and the alert detail page all
 * reconstruct the same view from it. Invalid values are ignored (fail-safe),
 * never crash the parse.
 *
 * A clean URL yields the default actionable view (LONG+SHORT); `signals=ALL`
 * is the explicit "no signal filter" choice. The legacy singular
 * `sourceTimeframe` param is accepted and folded into `sourceTimeframes` so
 * old bookmarks keep working.
 */
export function parseFiltersFromSearch(params: URLSearchParams): AlertListQuery {
  const filters: AlertListQuery = {};

  const signalsRaw = params.get("signals");
  if (signalsRaw !== ALL_SIGNALS_PARAM) {
    filters.signals = parseEnumList(SIGNAL_TYPES, signalsRaw) ?? [...ACTIONABLE_SIGNALS];
  }

  const status = parseEnum(ALERT_STATUSES, params.get("status"));
  if (status) filters.status = status;

  const symbol = params.get("symbol");
  if (symbol) filters.symbol = symbol;

  const assetType = parseEnum(ASSET_TYPES, params.get("assetType"));
  if (assetType) filters.assetType = assetType;

  const sourceTimeframes =
    parseEnumList(SOURCE_TIMEFRAMES, params.get("sourceTimeframes")) ??
    parseEnumList(SOURCE_TIMEFRAMES, params.get("sourceTimeframe"));
  if (sourceTimeframes) filters.sourceTimeframes = sourceTimeframes;

  const levelColor = parseEnum(LEVEL_COLORS, params.get("levelColor"));
  if (levelColor) filters.levelColor = levelColor;

  return filters;
}

/**
 * Dashboard filters -> their canonical URL params. Default values are omitted
 * so the default view stays a clean "/". `base` (when given) is copied first
 * so non-filter params survive; filter keys are always rewritten from scratch.
 */
function serializeFiltersToParams(
  filters: AlertListQuery,
  base?: URLSearchParams
): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const key of FILTER_PARAM_KEYS) params.delete(key);

  if (!filters.signals) {
    params.set("signals", ALL_SIGNALS_PARAM);
  } else if ([...filters.signals].sort().join(",") !== ACTIONABLE_KEY) {
    params.set("signals", filters.signals.join(","));
  }

  if (filters.status) params.set("status", filters.status);
  if (filters.symbol) params.set("symbol", filters.symbol);
  if (filters.assetType) params.set("assetType", filters.assetType);
  if (filters.sourceTimeframes?.length) {
    params.set("sourceTimeframes", filters.sourceTimeframes.join(","));
  }
  if (filters.levelColor) params.set("levelColor", filters.levelColor);

  return params;
}

/**
 * Dashboard filter state, backed by the URL query string instead of React
 * state: refreshing, browser back/forward, bookmarks and returning from an
 * alert detail page all restore the same filtered view.
 */
export function useFilters() {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo(() => parseFiltersFromSearch(searchParams), [searchParams]);

  const setFilter = useCallback(
    <K extends keyof AlertListQuery>(key: K, value: AlertListQuery[K]) => {
      // Empty string / empty array mean "no filter" — drop the key entirely.
      const normalized =
        value == null || value === "" || (Array.isArray(value) && value.length === 0)
          ? undefined
          : value;
      setSearchParams(
        (prev) => serializeFiltersToParams({ ...parseFiltersFromSearch(prev), [key]: normalized }, prev),
        // Symbol changes fire per keystroke; replacing keeps typing from
        // flooding the history stack. Discrete filter choices push, so
        // back/forward steps through filter states.
        { replace: key === "symbol" }
      );
    },
    [setSearchParams]
  );

  const reset = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const key of FILTER_PARAM_KEYS) next.delete(key);
      return next;
    });
  }, [setSearchParams]);

  // Canonical serialization is empty exactly when the view is the default —
  // junk-only params (all invalid values) also read as "no active filters".
  const hasActiveFilters = useMemo(
    () => serializeFiltersToParams(filters).toString() !== "",
    [filters]
  );

  return { filters, setFilter, reset, hasActiveFilters };
}
