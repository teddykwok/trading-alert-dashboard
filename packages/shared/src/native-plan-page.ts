import type { SourceTimeframe } from "./alert-context";
import {
  NATIVE_EXECUTION_INTEGRITY_STATUSES,
  type ExtremeRRPlanStatus,
  type NativeExecutionIntegrityStatus,
  type NativePlanListDto,
} from "./extreme-rr";

/**
 * The PAGED, filterable read of Native plans behind Trading Control's table.
 *
 * READ ONLY. A page query generates, selects, adopts and executes nothing, and
 * every item still says PLANNING ONLY / EXECUTION DISABLED. It is the same
 * GET /api/extreme-rr/native-plans: a request carrying ANY key below is a page
 * query; a request carrying none of them (optionally the original `limit`) is
 * the original list, byte for byte as before.
 *
 * Order is newest trigger first: triggeredAt DESC, then alertId DESC. Both are
 * immutable, so a page boundary never moves while new alerts arrive.
 */

export const NATIVE_PLAN_PAGE_QUERY_KEYS = ["pageSize", "cursor", "q", "sourceTimeframe", "direction", "planStatus", "integrity"] as const;
export type NativePlanPageQueryKey = (typeof NATIVE_PLAN_PAGE_QUERY_KEYS)[number];

/** The page sizes the table offers. The server accepts any size 1..NATIVE_PLAN_PAGE_MAX_SIZE. */
export const NATIVE_PLAN_PAGE_SIZES = [50, 100, 200] as const;
export type NativePlanPageSize = (typeof NATIVE_PLAN_PAGE_SIZES)[number];
export const NATIVE_PLAN_PAGE_DEFAULT_SIZE: NativePlanPageSize = 50;
export const NATIVE_PLAN_PAGE_MAX_SIZE = 200;

/**
 * At most this many plans are evaluated for integrity by ONE filtered request —
 * the same bound as the largest page, so no request of any kind judges more
 * than 200 plans. Integrity is rebuilt from scanner files on every read (each
 * judgement re-reads its lane's whole event log) and is never stored, so it
 * cannot be filtered or counted in the database; a filtered request scans
 * newest first and says how far it got, and its next cursor resumes the scan.
 */
export const NATIVE_PLAN_INTEGRITY_SCAN_LIMIT = 200;

export const NATIVE_PLAN_SEARCH_MAX_LENGTH = 40;
/** Letters and digits in any script (Unicode symbols included) and nothing that could act as a pattern. */
export const NATIVE_PLAN_SEARCH_PATTERN = /^[\p{L}\p{N}]+$/u;

export const NATIVE_PLAN_DIRECTIONS = ["LONG", "SHORT"] as const;
export type NativePlanDirection = (typeof NATIVE_PLAN_DIRECTIONS)[number];

/** Every status other than ELIGIBLE and PENDING_BAR_CLOSE: each one blocks a future executor. */
export const NATIVE_INTEGRITY_FAIL_CLOSED = "FAIL_CLOSED" as const;
export const NATIVE_PLAN_INTEGRITY_FILTERS = [...NATIVE_EXECUTION_INTEGRITY_STATUSES, NATIVE_INTEGRITY_FAIL_CLOSED] as const;
export type NativePlanIntegrityFilter = (typeof NATIVE_PLAN_INTEGRITY_FILTERS)[number];

/**
 *  HEALTHY      ELIGIBLE (data integrity only: it still grants nothing);
 *  PENDING      PENDING_BAR_CLOSE, the normal temporary state of a forming bar;
 *  FAIL_CLOSED  every INELIGIBLE_*, UNREADABLE, and any value this code does not know.
 */
export type NativeIntegrityClass = "HEALTHY" | "PENDING" | "FAIL_CLOSED";

export function nativeIntegrityClassOf(status: string | null | undefined): NativeIntegrityClass {
  if (status === "ELIGIBLE") return "HEALTHY";
  if (status === "PENDING_BAR_CLOSE") return "PENDING";
  return "FAIL_CLOSED";
}

export function nativeIntegrityMatches(filter: NativePlanIntegrityFilter, status: NativeExecutionIntegrityStatus): boolean {
  return filter === NATIVE_INTEGRITY_FAIL_CLOSED ? nativeIntegrityClassOf(status) === "FAIL_CLOSED" : status === filter;
}

export interface NativePlanPageQuery {
  pageSize?: number;
  /** Opaque; only ever a `nextCursor` this API returned. */
  cursor?: string;
  /** A symbol fragment (case-insensitive) or an exact alert id. */
  q?: string;
  sourceTimeframe?: SourceTimeframe;
  direction?: NativePlanDirection;
  planStatus?: ExtremeRRPlanStatus;
  integrity?: NativePlanIntegrityFilter;
}

/** Plan-status counts over one server-side scope. Every status key is present (0 when none). */
export interface NativePlanStatusCounts {
  total: number;
  byPlanStatus: Record<ExtremeRRPlanStatus, number>;
}

export interface NativePlanPageSummary {
  /** Every Native plan in the database: no search or filter applied. */
  allNativePlans: NativePlanStatusCounts;
  /**
   * Every plan matching the search, source timeframe, direction and plan
   * status. NOT the integrity filter: integrity is evaluated per page from
   * scanner files, never counted in the database.
   */
  matchingFilters: NativePlanStatusCounts;
}

export interface NativePlanIntegrityScan {
  /** Plans this request evaluated for integrity. */
  scanned: number;
  limit: number;
  /** True when nothing older matches the database filters: the scan reached the end. */
  exhausted: boolean;
}

export interface NativePlanPagination {
  order: "TRIGGERED_AT_DESC";
  pageSize: number;
  /** The cursor this page was read from (null: the newest page). */
  cursor: string | null;
  /** Pass back as `cursor` for the next, older page. Null when nothing older matches. */
  nextCursor: string | null;
  hasMore: boolean;
  /** Plans matching every filter, or null with the integrity filter (not countable in the database). */
  totalMatching: number | null;
  /** Only with the integrity filter. */
  integrityScan: NativePlanIntegrityScan | null;
}

export interface NativePlanPageDto extends NativePlanListDto {
  pagination: NativePlanPagination;
  summary: NativePlanPageSummary;
}
