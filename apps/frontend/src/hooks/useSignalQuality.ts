import { useCallback, useEffect, useState } from "react";
import type { SignalQualityPageDto, SignalQualitySoakHealthDto, SignalQualitySort, SignalQualitySummaryDto } from "@trading-alert-dashboard/shared";
import {
  DEFAULT_SIGNAL_QUALITY_PAGE_SIZE,
  DEFAULT_SOAK_WINDOW,
  EMPTY_SIGNAL_QUALITY_FILTERS,
  nextOffset,
  pageQueryString,
  previousOffset,
  requestProblem,
  summaryQueryString,
  type SignalQualityFilters,
  type SignalQualityPageSize,
  type SoakWindowInput,
} from "../features/signal-quality/signalQualityQuery";
import { IDLE_LOADER_STATE, LatestOnlyLoader, createDebouncer, type CancellableFetcher, type LoaderState } from "../utils/latestRequest";

/**
 * State for the signal-quality observatory: soak window, filters, sort, page,
 * the one expanded row, and three read-only requests (summary, page, soak
 * health). Thin glue over pure modules. Each request's identity is its query
 * string, so effects re-run only when a request really changes; only the
 * newest response publishes. Auto-refresh is ONE forced reload per interval
 * (never per render), and it is the operator's to switch off.
 */

export const AUTO_REFRESH_MS = 60_000;
export const SYMBOL_DEBOUNCE_MS = 350;

export interface SignalQualityFetchers {
  readonly summary: CancellableFetcher<SignalQualitySummaryDto>;
  readonly page: CancellableFetcher<SignalQualityPageDto>;
  readonly soakHealth: CancellableFetcher<SignalQualitySoakHealthDto>;
}

export interface SignalQualityView {
  readonly window: SoakWindowInput;
  readonly filters: SignalQualityFilters;
  readonly sort: SignalQualitySort;
  readonly pageSize: SignalQualityPageSize;
  readonly offset: number;
  readonly problem: string | null;
  readonly summaryKey: string;
  readonly pageKey: string;
  readonly summary: LoaderState<SignalQualitySummaryDto>;
  readonly page: LoaderState<SignalQualityPageDto>;
  readonly soakHealth: LoaderState<SignalQualitySoakHealthDto>;
  readonly expanded: string | null;
  readonly autoRefresh: boolean;
  setWindow(window: SoakWindowInput): void;
  setFilter<K extends keyof SignalQualityFilters>(key: K, value: SignalQualityFilters[K]): void;
  clearFilters(): void;
  setSort(sort: SignalQualitySort): void;
  setPageSize(size: SignalQualityPageSize): void;
  nextPage(): void;
  previousPage(): void;
  toggleRow(alertId: string): void;
  setAutoRefresh(on: boolean): void;
  reload(): void;
}

export function useSignalQuality(fetchers: SignalQualityFetchers): SignalQualityView {
  const [window, setWindowState] = useState<SoakWindowInput>(DEFAULT_SOAK_WINDOW);
  const [filters, setFilters] = useState<SignalQualityFilters>(EMPTY_SIGNAL_QUALITY_FILTERS);
  const [committedSymbol, setCommittedSymbol] = useState("");
  const [sort, setSortState] = useState<SignalQualitySort>("TRIGGERED_DESC");
  const [pageSize, setPageSizeState] = useState<SignalQualityPageSize>(DEFAULT_SIGNAL_QUALITY_PAGE_SIZE);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [summary, setSummary] = useState<LoaderState<SignalQualitySummaryDto>>(IDLE_LOADER_STATE);
  const [page, setPage] = useState<LoaderState<SignalQualityPageDto>>(IDLE_LOADER_STATE);
  const [soakHealth, setSoakHealth] = useState<LoaderState<SignalQualitySoakHealthDto>>(IDLE_LOADER_STATE);

  const [summaryLoader] = useState(() => new LatestOnlyLoader(fetchers.summary, setSummary));
  const [pageLoader] = useState(() => new LatestOnlyLoader(fetchers.page, setPage));
  const [healthLoader] = useState(() => new LatestOnlyLoader(fetchers.soakHealth, setSoakHealth));
  const [debouncer] = useState(() =>
    createDebouncer<string>(SYMBOL_DEBOUNCE_MS, (text) => {
      setCommittedSymbol(text);
      setOffset(0);
    })
  );
  useEffect(
    () => () => {
      summaryLoader.dispose();
      pageLoader.dispose();
      healthLoader.dispose();
      debouncer.cancel();
    },
    [summaryLoader, pageLoader, healthLoader, debouncer]
  );

  const effective = { ...filters, symbol: committedSymbol };
  const problem = requestProblem({ window, filters: effective });
  const summaryKey = summaryQueryString({ window, filters: effective });
  const pageKey = pageQueryString({ window, filters: effective, sort, offset, pageSize });

  useEffect(() => {
    if (problem === null) summaryLoader.load(summaryKey);
  }, [summaryLoader, summaryKey, problem]);
  useEffect(() => {
    if (problem === null) pageLoader.load(pageKey);
  }, [pageLoader, pageKey, problem]);
  useEffect(() => {
    healthLoader.load("soak-health");
  }, [healthLoader]);

  const reload = useCallback(() => {
    if (problem === null) {
      summaryLoader.load(summaryKey, true);
      pageLoader.load(pageKey, true);
    }
    healthLoader.load("soak-health", true);
  }, [summaryLoader, pageLoader, healthLoader, summaryKey, pageKey, problem]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const handle = setInterval(reload, AUTO_REFRESH_MS);
    return () => clearInterval(handle);
  }, [autoRefresh, reload]);

  const total = page.data?.pagination.total ?? 0;
  return {
    window,
    filters,
    sort,
    pageSize,
    offset,
    problem,
    summaryKey,
    pageKey,
    summary,
    page,
    soakHealth,
    expanded,
    autoRefresh,
    setWindow: (next) => {
      setWindowState(next);
      setOffset(0);
    },
    setFilter: (key, value) => {
      setFilters((previous) => ({ ...previous, [key]: value }));
      if (key === "symbol") debouncer.push(value as string);
      else setOffset(0);
    },
    clearFilters: () => {
      debouncer.cancel();
      setFilters(EMPTY_SIGNAL_QUALITY_FILTERS);
      setCommittedSymbol("");
      setOffset(0);
    },
    setSort: (next) => {
      setSortState(next);
      setOffset(0);
    },
    setPageSize: (size) => {
      setPageSizeState(size);
      setOffset(0);
    },
    nextPage: () => setOffset((current) => nextOffset(current, pageSize, total)),
    previousPage: () => setOffset((current) => previousOffset(current, pageSize)),
    toggleRow: (alertId) => setExpanded((current) => (current === alertId ? null : alertId)),
    setAutoRefresh,
    reload,
  };
}
