import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExecutionListResponse } from "../api/executions.api";
import {
  DEFAULT_EXECUTION_PAGE_SIZE,
  EMPTY_EXECUTION_FILTERS,
  EXECUTION_SEARCH_DEBOUNCE_MS,
  checkExecutionSearch,
  executionListParams,
  executionQueryString,
  type ExecutionFilters,
  type ExecutionPageSize,
} from "../features/executions/executionListQuery";
import { NO_EXPANDED_ROWS, expandedKeysIn, toggleExpandedRow, type ExpandedRows } from "../utils/expandedRows";
import { IDLE_LOADER_STATE, LatestOnlyLoader, createDebouncer, type CancellableFetcher, type LoaderState } from "../utils/latestRequest";

/**
 * State for the Executions journal: search, filters, page, page size, expanded
 * rows and the read-only list request. The same pieces as the Native plan
 * table: one string identity per request (so the load effect cannot loop),
 * only the newest response publishes, the search box is debounced, and any
 * filter change returns to page 1. There is no polling.
 *
 * `fetchPage` must be a stable (module-level) function.
 */

export type ExecutionFilterKey = Exclude<keyof ExecutionFilters, "search">;

export interface ExecutionJournalView {
  readonly filters: ExecutionFilters;
  readonly page: number;
  readonly pageSize: ExecutionPageSize;
  readonly requestKey: string;
  readonly state: LoaderState<ExecutionListResponse>;
  readonly latest: ExecutionListResponse | null;
  readonly current: ExecutionListResponse | null;
  readonly expanded: ReadonlySet<string>;
  setSearch(text: string): void;
  setFilter<K extends ExecutionFilterKey>(key: K, value: ExecutionFilters[K]): void;
  clearFilters(): void;
  setPageSize(size: ExecutionPageSize): void;
  goToPage(page: number): void;
  toggleRow(key: string): void;
  reload(): void;
}

export function useExecutionJournal(fetchPage: CancellableFetcher<ExecutionListResponse>): ExecutionJournalView {
  const [filters, setFilters] = useState<ExecutionFilters>(EMPTY_EXECUTION_FILTERS);
  const [committedSearch, setCommittedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState<ExecutionPageSize>(DEFAULT_EXECUTION_PAGE_SIZE);
  const [state, setState] = useState<LoaderState<ExecutionListResponse>>(IDLE_LOADER_STATE);
  const [expandedRows, setExpandedRows] = useState<ExpandedRows>(NO_EXPANDED_ROWS);

  const [loader] = useState(() => new LatestOnlyLoader(fetchPage, setState));
  const [debouncer] = useState(() =>
    createDebouncer<string>(EXECUTION_SEARCH_DEBOUNCE_MS, (text) => {
      setCommittedSearch(text);
      setPage(1);
    })
  );
  useEffect(
    () => () => {
      loader.dispose();
      debouncer.cancel();
    },
    [loader, debouncer]
  );

  const search = checkExecutionSearch(committedSearch);
  const searchValid = search.ok;
  const requestKey = executionQueryString(executionListParams(filters, search.ok ? search.q : null, page, pageSize));

  useEffect(() => {
    if (searchValid) loader.load(requestKey);
  }, [loader, requestKey, searchValid]);

  const latest = state.data;
  const current = state.dataKey === requestKey ? state.data : null;
  const dataKey = state.dataKey ?? "";
  const expanded = useMemo(() => expandedKeysIn(expandedRows, dataKey, (latest?.items ?? []).map((item) => item.id)), [expandedRows, dataKey, latest]);

  const setSearch = useCallback(
    (text: string) => {
      setFilters((previous) => ({ ...previous, search: text }));
      debouncer.push(text);
    },
    [debouncer]
  );
  const setFilter = useCallback(<K extends ExecutionFilterKey>(key: K, value: ExecutionFilters[K]) => {
    setFilters((previous) => ({ ...previous, [key]: value }));
    setPage(1);
  }, []);
  const clearFilters = useCallback(() => {
    debouncer.cancel();
    setFilters(EMPTY_EXECUTION_FILTERS);
    setCommittedSearch("");
    setPage(1);
  }, [debouncer]);
  const setPageSize = useCallback((size: ExecutionPageSize) => {
    setPageSizeState(size);
    setPage(1);
  }, []);
  const goToPage = useCallback((next: number) => setPage(Math.max(1, Math.floor(next))), []);
  const toggleRow = useCallback((key: string) => setExpandedRows((previous) => toggleExpandedRow(previous, dataKey, key)), [dataKey]);
  const reload = useCallback(() => {
    if (searchValid) loader.load(requestKey, true);
  }, [loader, requestKey, searchValid]);

  return { filters, page, pageSize, requestKey, state, latest, current, expanded, setSearch, setFilter, clearFilters, setPageSize, goToPage, toggleRow, reload };
}
