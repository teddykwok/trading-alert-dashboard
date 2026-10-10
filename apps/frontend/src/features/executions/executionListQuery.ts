import { buildExecutionListQuery, type ExecutionListParams, type ExecutionListResponse } from "../../api/executions.api";

/**
 * What the Executions journal asks the server for. Pure.
 *
 * The journal is offset-paged by the server (its existing convention) and
 * ordered most recently updated first. Every filter value is one the server
 * validates; the request's query string is built in a fixed key order, so it
 * doubles as the request's identity and an identical request is never sent
 * twice.
 */

export interface ExecutionFilters {
  /** Raw search box text: debounced and checked before it becomes `q`. */
  readonly search: string;
  readonly executionProfileId: string;
  readonly source: "" | "TRADINGVIEW" | "NATIVE";
  readonly direction: "" | "LONG" | "SHORT";
  readonly status: string;
  readonly protectionState: string;
  readonly environment: "" | "MAINNET" | "TESTNET";
  readonly lifecycle: "" | "active" | "closed";
  /** yyyy-mm-dd (a UTC day), or "". */
  readonly createdFrom: string;
  readonly createdTo: string;
  readonly requiresManualIntervention: boolean;
}

export const EMPTY_EXECUTION_FILTERS: ExecutionFilters = Object.freeze({
  search: "",
  executionProfileId: "",
  source: "",
  direction: "",
  status: "",
  protectionState: "",
  environment: "",
  lifecycle: "",
  createdFrom: "",
  createdTo: "",
  requiresManualIntervention: false,
});

export const EXECUTION_PAGE_SIZES = [25, 50, 100] as const;
export type ExecutionPageSize = (typeof EXECUTION_PAGE_SIZES)[number];
export const DEFAULT_EXECUTION_PAGE_SIZE: ExecutionPageSize = 25;
export const EXECUTION_SEARCH_DEBOUNCE_MS = 300;
export const EXECUTION_SEARCH_MAX_LENGTH = 64;
const SEARCH_PATTERN = /^[\p{L}\p{N}]+$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isExecutionPageSize(value: number): value is ExecutionPageSize {
  return (EXECUTION_PAGE_SIZES as readonly number[]).includes(value);
}

export type ExecutionSearchCheck = { readonly ok: true; readonly q: string | null } | { readonly ok: false; readonly message: string };

export function checkExecutionSearch(raw: string): ExecutionSearchCheck {
  const q = raw.trim();
  if (q === "") return { ok: true, q: null };
  if (q.length > EXECUTION_SEARCH_MAX_LENGTH) return { ok: false, message: `Search is limited to ${EXECUTION_SEARCH_MAX_LENGTH} characters.` };
  if (!SEARCH_PATTERN.test(q)) return { ok: false, message: "Search accepts letters and digits only (a symbol, an execution id or an alert id)." };
  return { ok: true, q };
}

/** The UTC day's first and last millisecond; anything that is not a yyyy-mm-dd day is ignored. */
export function utcDayStart(day: string): string | undefined {
  return DAY.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00.000Z`)) ? `${day}T00:00:00.000Z` : undefined;
}
export function utcDayEnd(day: string): string | undefined {
  return DAY.test(day) && !Number.isNaN(Date.parse(`${day}T23:59:59.999Z`)) ? `${day}T23:59:59.999Z` : undefined;
}

/** The request for one page; `q` is the committed, checked search. Fixed key order. */
export function executionListParams(filters: ExecutionFilters, q: string | null, page: number, pageSize: ExecutionPageSize): ExecutionListParams {
  return {
    q: q ?? undefined,
    executionProfileId: filters.executionProfileId || undefined,
    source: filters.source || undefined,
    direction: filters.direction || undefined,
    status: filters.status ? [filters.status] : undefined,
    protectionState: filters.protectionState ? [filters.protectionState] : undefined,
    environment: filters.environment || undefined,
    lifecycle: filters.lifecycle || undefined,
    createdFrom: utcDayStart(filters.createdFrom),
    createdTo: utcDayEnd(filters.createdTo),
    requiresManualIntervention: filters.requiresManualIntervention || undefined,
    page,
    pageSize,
  };
}

export function executionQueryString(params: ExecutionListParams): string {
  return buildExecutionListQuery(params);
}

export function hasActiveExecutionFilters(filters: ExecutionFilters): boolean {
  return (Object.keys(EMPTY_EXECUTION_FILTERS) as (keyof ExecutionFilters)[]).some((key) =>
    key === "search" ? filters.search.trim() !== "" : filters[key] !== EMPTY_EXECUTION_FILTERS[key]
  );
}

/** One truthful line under the table. */
export function executionPageCaption(data: Pick<ExecutionListResponse, "page" | "pageSize" | "total">, shown: number): string {
  if (data.total === 0 || shown === 0) return `Page ${data.page} · 0 of ${data.total} execution(s)`;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const from = (data.page - 1) * data.pageSize + 1;
  return `Page ${data.page} of ${pages} · ${from}–${from + shown - 1} of ${data.total} execution(s)`;
}

/** Whether the backend serving this response knows the search, source and account filters. */
export function supportsJournalSearch(data: ExecutionListResponse | null): boolean {
  return data === null || Array.isArray(data.profiles);
}
