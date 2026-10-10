import {
  EXTREME_RR_STATUSES,
  NATIVE_EXECUTION_INTEGRITY_STATUSES,
  NATIVE_INTEGRITY_FAIL_CLOSED,
  NATIVE_PLAN_DIRECTIONS,
  NATIVE_PLAN_PAGE_DEFAULT_SIZE,
  NATIVE_PLAN_PAGE_SIZES,
  NATIVE_PLAN_SEARCH_MAX_LENGTH,
  NATIVE_PLAN_SEARCH_PATTERN,
  SOURCE_TIMEFRAMES,
  type ExtremeRRPlanStatus,
  type NativePlanDirection,
  type NativePlanIntegrityFilter,
  type NativePlanPageSize,
  type SourceTimeframe,
} from "@trading-alert-dashboard/shared";

/**
 * What the Trading Control Native plan table asks the server for. Pure.
 *
 * Every filter value comes from the shared vocabulary the server validates
 * against, so the table can never offer a value the API would refuse, and the
 * request is always a PAGE query (it always names its page size): the original
 * unpaged list stays exactly as it was for every other caller.
 */

export interface NativePlanFilters {
  /** Raw search box text. Debounced and checked before it becomes `q`. */
  readonly search: string;
  readonly sourceTimeframe: SourceTimeframe | "";
  readonly direction: NativePlanDirection | "";
  readonly planStatus: ExtremeRRPlanStatus | "";
  readonly integrity: NativePlanIntegrityFilter | "";
}

export const EMPTY_NATIVE_PLAN_FILTERS: NativePlanFilters = Object.freeze({
  search: "",
  sourceTimeframe: "",
  direction: "",
  planStatus: "",
  integrity: "",
});

/** How long the search box waits after the last keystroke before it asks the server. */
export const NATIVE_PLAN_SEARCH_DEBOUNCE_MS = 300;

export type NativePlanSearchCheck = { readonly ok: true; readonly q: string | null } | { readonly ok: false; readonly message: string };

/** Empty is "no search"; anything the server would refuse is reported here and never sent. */
export function checkNativePlanSearch(raw: string): NativePlanSearchCheck {
  const q = raw.trim();
  if (q === "") return { ok: true, q: null };
  if (q.length > NATIVE_PLAN_SEARCH_MAX_LENGTH) return { ok: false, message: `Search is limited to ${NATIVE_PLAN_SEARCH_MAX_LENGTH} characters.` };
  if (!NATIVE_PLAN_SEARCH_PATTERN.test(q)) return { ok: false, message: "Search accepts letters and digits only (a symbol or an alert id)." };
  return { ok: true, q };
}

export interface NativePlanRequest {
  readonly pageSize: NativePlanPageSize;
  readonly cursor: string | null;
  readonly q: string | null;
  readonly sourceTimeframe: SourceTimeframe | "";
  readonly direction: NativePlanDirection | "";
  readonly planStatus: ExtremeRRPlanStatus | "";
  readonly integrity: NativePlanIntegrityFilter | "";
}

/**
 * The query string for one page. Deterministic key order, so the same request
 * always produces the same string: it doubles as the request's identity, and an
 * identical string never triggers a second fetch.
 */
export function nativePlanQueryString(request: NativePlanRequest): string {
  const params = new URLSearchParams();
  params.set("pageSize", String(request.pageSize));
  if (request.cursor !== null) params.set("cursor", request.cursor);
  if (request.q !== null) params.set("q", request.q);
  if (request.sourceTimeframe !== "") params.set("sourceTimeframe", request.sourceTimeframe);
  if (request.direction !== "") params.set("direction", request.direction);
  if (request.planStatus !== "") params.set("planStatus", request.planStatus);
  if (request.integrity !== "") params.set("integrity", request.integrity);
  return `?${params.toString()}`;
}

/** Search excluded: a search is visible in its own box and cleared with the rest. */
export function activeNativePlanFilterCount(filters: NativePlanFilters): number {
  return [filters.sourceTimeframe, filters.direction, filters.planStatus, filters.integrity].filter((value) => value !== "").length;
}

export function hasActiveNativePlanQuery(filters: NativePlanFilters): boolean {
  return filters.search.trim() !== "" || activeNativePlanFilterCount(filters) > 0;
}

export function isNativePlanPageSize(value: number): value is NativePlanPageSize {
  return (NATIVE_PLAN_PAGE_SIZES as readonly number[]).includes(value);
}

export const DEFAULT_NATIVE_PLAN_PAGE_SIZE: NativePlanPageSize = NATIVE_PLAN_PAGE_DEFAULT_SIZE;

// ---------------------------------------------------------------------------
// Filter options: the shared vocabulary only, labelled for people
// ---------------------------------------------------------------------------

export interface FilterOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export const SOURCE_TIMEFRAME_OPTIONS: readonly FilterOption<SourceTimeframe>[] = SOURCE_TIMEFRAMES.map((value) => ({ value, label: value }));

export const DIRECTION_OPTIONS: readonly FilterOption<NativePlanDirection>[] = NATIVE_PLAN_DIRECTIONS.map((value) => ({ value, label: value }));

const PLAN_STATUS_OPTION_LABEL: Readonly<Record<ExtremeRRPlanStatus, string>> = Object.freeze({
  PENDING: "PLANNING (pending)",
  READY: "READY",
  INVALID: "INVALID",
  ERROR: "ERROR",
});

export const PLAN_STATUS_OPTIONS: readonly FilterOption<ExtremeRRPlanStatus>[] = EXTREME_RR_STATUSES.map((value) => ({ value, label: PLAN_STATUS_OPTION_LABEL[value] }));

const INTEGRITY_OPTION_LABEL: Readonly<Record<NativePlanIntegrityFilter, string>> = Object.freeze({
  PENDING_BAR_CLOSE: "PENDING BAR CLOSE",
  ELIGIBLE: "ELIGIBLE",
  INELIGIBLE_REQUARANTINED: "BLOCKED — RE-QUARANTINED",
  INELIGIBLE_GAP: "BLOCKED — GAP",
  INELIGIBLE_DUPLICATE: "BLOCKED — DUPLICATE",
  INELIGIBLE_CHECKPOINT_MISMATCH: "BLOCKED — CHECKPOINT MISMATCH",
  INELIGIBLE_STALE_GENERATION: "BLOCKED — STALE GENERATION",
  UNREADABLE: "UNREADABLE",
  FAIL_CLOSED: "Any fail-closed (blocked or unreadable)",
});

/** The fail-closed group first after the two normal states, then every exact status. */
export const INTEGRITY_OPTIONS: readonly FilterOption<NativePlanIntegrityFilter>[] = [
  { value: "ELIGIBLE", label: INTEGRITY_OPTION_LABEL.ELIGIBLE },
  { value: "PENDING_BAR_CLOSE", label: INTEGRITY_OPTION_LABEL.PENDING_BAR_CLOSE },
  { value: NATIVE_INTEGRITY_FAIL_CLOSED, label: INTEGRITY_OPTION_LABEL.FAIL_CLOSED },
  ...NATIVE_EXECUTION_INTEGRITY_STATUSES.filter((status) => status !== "ELIGIBLE" && status !== "PENDING_BAR_CLOSE").map((value) => ({
    value,
    label: INTEGRITY_OPTION_LABEL[value],
  })),
];

// ---------------------------------------------------------------------------
// Page position: a stack of cursors (newest page first)
// ---------------------------------------------------------------------------

/**
 * `cursors[i]` is the cursor page i + 1 was read from (null for the newest
 * page). Moving forward pushes the server's `nextCursor`; moving back pops.
 * Keyset pages never shift while new alerts arrive, so going back returns
 * exactly the page that was shown.
 */
export interface NativePlanPagePosition {
  readonly cursors: readonly (string | null)[];
}

export const FIRST_NATIVE_PLAN_PAGE: NativePlanPagePosition = Object.freeze({ cursors: Object.freeze([null]) });

export function currentNativePlanCursor(position: NativePlanPagePosition): string | null {
  return position.cursors[position.cursors.length - 1] ?? null;
}

export function nativePlanPageNumber(position: NativePlanPagePosition): number {
  return position.cursors.length;
}

/** Forward only with a cursor the server returned; otherwise the position is unchanged. */
export function nextNativePlanPage(position: NativePlanPagePosition, nextCursor: string | null): NativePlanPagePosition {
  if (nextCursor === null) return position;
  return { cursors: [...position.cursors, nextCursor] };
}

export function previousNativePlanPage(position: NativePlanPagePosition): NativePlanPagePosition {
  if (position.cursors.length <= 1) return FIRST_NATIVE_PLAN_PAGE;
  return { cursors: position.cursors.slice(0, -1) };
}
