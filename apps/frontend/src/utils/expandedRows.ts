/**
 * Which table rows are expanded, scoped to the query and page they were opened
 * on. Pure.
 *
 * A new search, filter, page size or page starts fully collapsed; a refresh of
 * the same page keeps what was open (for rows still present). Keys are the
 * rows' stable ids, never array positions, so an expansion can never jump to a
 * different row when the data changes.
 */

export interface ExpandedRows {
  readonly scope: string | null;
  readonly keys: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set<string>();

export const NO_EXPANDED_ROWS: ExpandedRows = Object.freeze({ scope: null, keys: NONE });

/** The keys open in `scope` that are also on screen. */
export function expandedKeysIn(state: ExpandedRows, scope: string, visibleKeys: readonly string[]): ReadonlySet<string> {
  if (state.scope !== scope || state.keys.size === 0) return NONE;
  return new Set(visibleKeys.filter((key) => state.keys.has(key)));
}

export function toggleExpandedRow(state: ExpandedRows, scope: string, key: string): ExpandedRows {
  const keys = new Set(state.scope === scope ? state.keys : NONE);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return { scope, keys };
}
