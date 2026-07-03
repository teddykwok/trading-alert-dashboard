import { useMemo, useState } from "react";
import type { AlertListQuery } from "../types/api";

const EMPTY_FILTERS: AlertListQuery = {};

export function useFilters() {
  const [filters, setFilters] = useState<AlertListQuery>(EMPTY_FILTERS);

  function setFilter<K extends keyof AlertListQuery>(key: K, value: AlertListQuery[K]) {
    setFilters((prev) => ({ ...prev, [key]: value || undefined }));
  }

  function reset() {
    setFilters(EMPTY_FILTERS);
  }

  const hasActiveFilters = useMemo(() => Object.values(filters).some((value) => value !== undefined), [filters]);

  return { filters, setFilter, reset, hasActiveFilters };
}
