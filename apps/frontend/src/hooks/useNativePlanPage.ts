import { useCallback, useEffect, useMemo, useState } from "react";
import type { NativePlanPageDto, NativePlanPageSize } from "@trading-alert-dashboard/shared";
import {
  DEFAULT_NATIVE_PLAN_PAGE_SIZE,
  EMPTY_NATIVE_PLAN_FILTERS,
  FIRST_NATIVE_PLAN_PAGE,
  NATIVE_PLAN_SEARCH_DEBOUNCE_MS,
  checkNativePlanSearch,
  currentNativePlanCursor,
  nativePlanPageNumber,
  nativePlanQueryString,
  nextNativePlanPage,
  previousNativePlanPage,
  type NativePlanFilters,
  type NativePlanPagePosition,
} from "../features/plans/nativePlanQuery";
import { NO_EXPANDED_ROWS, expandedKeysIn, toggleExpandedRow, type ExpandedRows } from "../utils/expandedRows";
import { IDLE_LOADER_STATE, LatestOnlyLoader, createDebouncer, type CancellableFetcher, type LoaderState } from "../utils/latestRequest";

/**
 * State for Trading Control's Native plan table: search, filters, page size,
 * page position, expanded rows and the read-only page request.
 *
 * Thin glue over pure modules. The request's identity is its query string, so
 * the load effect depends on one string and re-runs only when the request
 * really changes; LatestOnlyLoader lets only the newest response publish and
 * aborts superseded ones; the search box waits NATIVE_PLAN_SEARCH_DEBOUNCE_MS
 * after the last keystroke. Any query change returns to the newest page.
 *
 * `fetchPage` must be a stable (module-level) function.
 */

export type NativePlanFilterKey = Exclude<keyof NativePlanFilters, "search">;

export interface NativePlanPageView {
  readonly filters: NativePlanFilters;
  readonly pageSize: NativePlanPageSize;
  readonly pageNumber: number;
  /** The identity of the request the controls describe. */
  readonly requestKey: string;
  readonly state: LoaderState<NativePlanPageDto>;
  /** The newest response that arrived; it may answer an older request while a newer one loads. */
  readonly latest: NativePlanPageDto | null;
  /** The response only when it answers the current request. */
  readonly current: NativePlanPageDto | null;
  readonly expanded: ReadonlySet<string>;
  setSearch(text: string): void;
  setFilter<K extends NativePlanFilterKey>(key: K, value: NativePlanFilters[K]): void;
  clearFilters(): void;
  setPageSize(size: NativePlanPageSize): void;
  nextPage(): void;
  previousPage(): void;
  toggleRow(key: string): void;
  reload(): void;
}

export function useNativePlanPage(fetchPage: CancellableFetcher<NativePlanPageDto>): NativePlanPageView {
  const [filters, setFilters] = useState<NativePlanFilters>(EMPTY_NATIVE_PLAN_FILTERS);
  const [committedSearch, setCommittedSearch] = useState("");
  const [pageSize, setPageSizeState] = useState<NativePlanPageSize>(DEFAULT_NATIVE_PLAN_PAGE_SIZE);
  const [position, setPosition] = useState<NativePlanPagePosition>(FIRST_NATIVE_PLAN_PAGE);
  const [state, setState] = useState<LoaderState<NativePlanPageDto>>(IDLE_LOADER_STATE);
  const [expandedRows, setExpandedRows] = useState<ExpandedRows>(NO_EXPANDED_ROWS);

  // One loader and one debouncer for the component's lifetime.
  const [loader] = useState(() => new LatestOnlyLoader(fetchPage, setState));
  const [debouncer] = useState(() =>
    createDebouncer<string>(NATIVE_PLAN_SEARCH_DEBOUNCE_MS, (text) => {
      setCommittedSearch(text);
      setPosition(FIRST_NATIVE_PLAN_PAGE);
    })
  );
  useEffect(
    () => () => {
      loader.dispose();
      debouncer.cancel();
    },
    [loader, debouncer]
  );

  const search = checkNativePlanSearch(committedSearch);
  const searchValid = search.ok;
  const requestKey = nativePlanQueryString({
    pageSize,
    cursor: currentNativePlanCursor(position),
    q: search.ok ? search.q : null,
    sourceTimeframe: filters.sourceTimeframe,
    direction: filters.direction,
    planStatus: filters.planStatus,
    integrity: filters.integrity,
  });

  useEffect(() => {
    if (searchValid) loader.load(requestKey);
  }, [loader, requestKey, searchValid]);

  const latest = state.data;
  const current = state.dataKey === requestKey ? state.data : null;
  const dataKey = state.dataKey ?? "";
  const expanded = useMemo(
    () => expandedKeysIn(expandedRows, dataKey, (latest?.items ?? []).map((item) => item.alertId)),
    [expandedRows, dataKey, latest]
  );
  const nextCursor = current?.pagination.nextCursor ?? null;

  const setSearch = useCallback(
    (text: string) => {
      setFilters((previous) => ({ ...previous, search: text }));
      debouncer.push(text);
    },
    [debouncer]
  );
  const setFilter = useCallback(<K extends NativePlanFilterKey>(key: K, value: NativePlanFilters[K]) => {
    setFilters((previous) => ({ ...previous, [key]: value }));
    setPosition(FIRST_NATIVE_PLAN_PAGE);
  }, []);
  const clearFilters = useCallback(() => {
    debouncer.cancel();
    setFilters(EMPTY_NATIVE_PLAN_FILTERS);
    setCommittedSearch("");
    setPosition(FIRST_NATIVE_PLAN_PAGE);
  }, [debouncer]);
  const setPageSize = useCallback((size: NativePlanPageSize) => {
    setPageSizeState(size);
    setPosition(FIRST_NATIVE_PLAN_PAGE);
  }, []);
  const nextPage = useCallback(() => setPosition((previous) => nextNativePlanPage(previous, nextCursor)), [nextCursor]);
  const previousPage = useCallback(() => setPosition((previous) => previousNativePlanPage(previous)), []);
  const toggleRow = useCallback((key: string) => setExpandedRows((previous) => toggleExpandedRow(previous, dataKey, key)), [dataKey]);
  const reload = useCallback(() => {
    if (searchValid) loader.load(requestKey, true);
  }, [loader, requestKey, searchValid]);

  return {
    filters,
    pageSize,
    pageNumber: nativePlanPageNumber(position),
    requestKey,
    state,
    latest,
    current,
    expanded,
    setSearch,
    setFilter,
    clearFilters,
    setPageSize,
    nextPage,
    previousPage,
    toggleRow,
    reload,
  };
}
