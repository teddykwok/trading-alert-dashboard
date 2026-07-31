/**
 * Per-filter-context scroll restoration state for the dashboard, kept in
 * sessionStorage (temporary UI state — never the database, never filters).
 *
 * Keys are derived from the CANONICAL filter query produced by useFilters'
 * serialization, so each filtered view remembers its own position and state
 * can never leak between filter contexts. The clean default dashboard gets
 * its own deterministic key.
 *
 * Everything here is best-effort: storage may be disabled, full, or contain
 * junk — every failure path degrades to "no saved state", never a crash.
 */

const KEY_PREFIX = "dashboard-scroll:";

/** Saved positions older than this are ignored and pruned. */
const STALE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Sanity bounds: values outside these are corrupt or absurd — restoring them
// would mean megapixel scroll jumps or endless "load older" loops.
const MAX_SCROLL_Y = 1_000_000;
const MAX_LOADED_COUNT = 2_000;

export interface DashboardScrollState {
  /** window.scrollY at the moment the dashboard was left. */
  scrollY: number;
  /** How many alerts were loaded (raw list length, i.e. pagination depth). */
  loadedCount: number;
  savedAt: number;
}

function storageKey(canonicalSearch: string): string {
  return KEY_PREFIX + (canonicalSearch || "default");
}

function isValidState(value: unknown): value is DashboardScrollState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.scrollY === "number" &&
    Number.isFinite(state.scrollY) &&
    state.scrollY >= 0 &&
    state.scrollY <= MAX_SCROLL_Y &&
    typeof state.loadedCount === "number" &&
    Number.isInteger(state.loadedCount) &&
    state.loadedCount > 0 &&
    state.loadedCount <= MAX_LOADED_COUNT &&
    typeof state.savedAt === "number" &&
    Number.isFinite(state.savedAt) &&
    Date.now() - state.savedAt <= STALE_TTL_MS
  );
}

/** Drops expired/corrupt entries so the prefix can never grow unbounded. */
function pruneStaleEntries(): void {
  const doomed: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key?.startsWith(KEY_PREFIX)) continue;
    try {
      if (!isValidState(JSON.parse(sessionStorage.getItem(key) ?? ""))) doomed.push(key);
    } catch {
      doomed.push(key);
    }
  }
  for (const key of doomed) sessionStorage.removeItem(key);
}

export function saveDashboardScrollState(
  canonicalSearch: string,
  state: Omit<DashboardScrollState, "savedAt">
): void {
  try {
    pruneStaleEntries();
    sessionStorage.setItem(
      storageKey(canonicalSearch),
      JSON.stringify({ ...state, savedAt: Date.now() })
    );
  } catch {
    // Quota exceeded or storage disabled — restoration just won't happen.
  }
}

export function loadDashboardScrollState(canonicalSearch: string): DashboardScrollState | null {
  try {
    const raw = sessionStorage.getItem(storageKey(canonicalSearch));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidState(parsed)) {
      sessionStorage.removeItem(storageKey(canonicalSearch));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
