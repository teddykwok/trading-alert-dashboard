import { useMemo, useState } from "react";
import type { SignalType } from "../types/alert";
import type { AlertListQuery } from "../types/api";

/**
 * The signals a trader can act on directly. WATCH (context/ambiguous) and
 * EXIT stay fully supported — they are just not shown by default because
 * WATCH alerts tend to clutter the feed.
 */
export const ACTIONABLE_SIGNALS: SignalType[] = ["LONG", "SHORT"];

/**
 * Default dashboard view: actionable signals only. "Clear filters" returns to
 * this default (not to an unfiltered view), matching what a fresh page load
 * shows.
 */
const DEFAULT_FILTERS: AlertListQuery = { signals: [...ACTIONABLE_SIGNALS] };

// JSON.stringify drops undefined-valued keys, and setFilter always spreads
// the previous object (so pre-existing keys keep their position), which makes
// string comparison a reliable "differs from the default view" check here.
const DEFAULT_FILTERS_JSON = JSON.stringify(DEFAULT_FILTERS);

export function useFilters() {
  const [filters, setFilters] = useState<AlertListQuery>(DEFAULT_FILTERS);

  function setFilter<K extends keyof AlertListQuery>(key: K, value: AlertListQuery[K]) {
    setFilters((prev) => ({ ...prev, [key]: value || undefined }));
  }

  function reset() {
    setFilters(DEFAULT_FILTERS);
  }

  const hasActiveFilters = useMemo(
    () => JSON.stringify(filters) !== DEFAULT_FILTERS_JSON,
    [filters]
  );

  return { filters, setFilter, reset, hasActiveFilters };
}
