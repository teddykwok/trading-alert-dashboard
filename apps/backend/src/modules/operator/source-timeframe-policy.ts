import {
  SOURCE_TIMEFRAMES,
  normalizeSourceTimeframe,
  type SourceTimeframe,
} from "@trading-alert-dashboard/shared";

/**
 * Validation for the operator-selected SOURCE timeframe policy.
 *
 * Everything here is PURE: it takes whatever the browser sent and returns a
 * verdict. No Prisma, no environment, no clock — which is what lets every rule
 * below be tested without a database or a running runtime.
 *
 * Three rules shape it:
 *
 *   1. There is exactly ONE canonical vocabulary, `SOURCE_TIMEFRAMES`, and one
 *      normalizer — the same `normalizeSourceTimeframe` the webhook note parser
 *      uses. A timeframe the operator enables is therefore spelled the way an
 *      inbound alert will spell it, and neither side can drift.
 *   2. An empty selection is a REFUSAL, never a wildcard. This is the opposite
 *      of the symbol allowlist, where `[]` means "no extra restriction" — a
 *      known footgun that is deliberately not reproduced here. Admission asks
 *      whether the list CONTAINS the signal's timeframe, so `[]` admits
 *      nothing, and saving it would silently disarm the system rather than
 *      opening it.
 *   3. An unrecognised value is rejected outright rather than dropped. Silently
 *      ignoring "1H" would save a policy the operator did not ask for.
 */

/** A selection is at most the six canonical values; anything larger is noise. */
export const SOURCE_TIMEFRAME_MAX_ENTRIES = 64;

export const SOURCE_TIMEFRAME_REJECTIONS = ["INVALID_SYNTAX", "UNKNOWN_TIMEFRAME"] as const;
export type SourceTimeframeRejection = (typeof SOURCE_TIMEFRAME_REJECTIONS)[number];

export interface SourceTimeframeRejectedEntry {
  /** The operator's own value, so they can find it in what they sent. */
  input: string;
  reasonCode: SourceTimeframeRejection;
  detail: string;
}

export interface SourceTimeframeValidation {
  /** True only when at least one timeframe survived and nothing was rejected. */
  ok: boolean;
  counts: { input: number; valid: number; duplicates: number; rejected: number };
  /** The timeframes that would be saved, in canonical order. */
  accepted: SourceTimeframe[];
  rejected: SourceTimeframeRejectedEntry[];
  /** Set when `ok` is false and nothing may be saved. */
  refusal: string | null;
}

/** Canonical order, so a saved policy always reads shortest-to-longest. */
function inCanonicalOrder(selected: ReadonlySet<SourceTimeframe>): SourceTimeframe[] {
  return SOURCE_TIMEFRAMES.filter((timeframe) => selected.has(timeframe));
}

/**
 * The complete verdict for a submitted selection.
 *
 * Deliberately strict: one unknown entry refuses the whole submission rather
 * than saving the recognisable remainder. A partial save would be a policy
 * nobody chose, and the operator cannot see what was dropped from a checkbox
 * list that already looks correct in their browser.
 */
export function validateSourceTimeframeSelection(raw: unknown): SourceTimeframeValidation {
  const rejected: SourceTimeframeRejectedEntry[] = [];

  if (!Array.isArray(raw)) {
    return {
      ok: false,
      counts: { input: 0, valid: 0, duplicates: 0, rejected: 1 },
      accepted: [],
      rejected: [
        {
          input: "",
          reasonCode: "INVALID_SYNTAX",
          detail: "The selection must be sent as an array of timeframe strings.",
        },
      ],
      refusal: "The selection must be sent as an array of timeframe strings. Nothing was saved.",
    };
  }

  if (raw.length > SOURCE_TIMEFRAME_MAX_ENTRIES) {
    return {
      ok: false,
      counts: { input: raw.length, valid: 0, duplicates: 0, rejected: 1 },
      accepted: [],
      rejected: [
        {
          input: "",
          reasonCode: "INVALID_SYNTAX",
          detail: `The selection has ${raw.length} entries; at most ${SOURCE_TIMEFRAME_MAX_ENTRIES} are accepted.`,
        },
      ],
      refusal: `The selection has ${raw.length} entries; at most ${SOURCE_TIMEFRAME_MAX_ENTRIES} are accepted. Nothing was saved.`,
    };
  }

  const selected = new Set<SourceTimeframe>();
  let duplicates = 0;

  for (const entry of raw) {
    if (typeof entry !== "string") {
      rejected.push({
        input: String(entry),
        reasonCode: "INVALID_SYNTAX",
        detail: "Every entry must be a string.",
      });
      continue;
    }
    const timeframe = normalizeSourceTimeframe(entry);
    if (timeframe === null) {
      rejected.push({
        input: entry,
        reasonCode: "UNKNOWN_TIMEFRAME",
        detail: `"${entry}" is not a supported source timeframe (expected one of ${SOURCE_TIMEFRAMES.join(", ")}).`,
      });
      continue;
    }
    if (selected.has(timeframe)) {
      // Canonicalized, not refused: two spellings of the same timeframe are
      // one choice, and a checkbox list cannot express anything else.
      duplicates += 1;
      continue;
    }
    selected.add(timeframe);
  }

  const accepted = inCanonicalOrder(selected);
  const counts = { input: raw.length, valid: accepted.length, duplicates, rejected: rejected.length };

  if (rejected.length > 0) {
    return {
      ok: false,
      counts,
      accepted,
      rejected,
      refusal: `${rejected.length} entr${rejected.length === 1 ? "y" : "ies"} were not recognised. Nothing was saved.`,
    };
  }

  if (accepted.length === 0) {
    return {
      ok: false,
      counts,
      accepted,
      rejected,
      refusal:
        "At least one source timeframe must be enabled. An empty selection would admit NO signal at all, so nothing was saved.",
    };
  }

  return { ok: true, counts, accepted, rejected, refusal: null };
}

/**
 * The durable value's own verdict, used when READING rather than writing.
 *
 * A stored list that no longer normalizes — old data, a hand-edited row, a
 * value written before this feature existed — must never be presented as
 * "everything is fine", and must never be widened into "all timeframes". This
 * reports exactly what is enforceable, so status and readiness can say so.
 */
export function describeStoredSelection(stored: readonly string[] | null | undefined): {
  enforceable: SourceTimeframe[];
  unrecognized: string[];
  valid: boolean;
} {
  const selected = new Set<SourceTimeframe>();
  const unrecognized: string[] = [];
  for (const entry of stored ?? []) {
    const timeframe = normalizeSourceTimeframe(entry);
    if (timeframe === null) unrecognized.push(String(entry));
    else selected.add(timeframe);
  }
  const enforceable = inCanonicalOrder(selected);
  return { enforceable, unrecognized, valid: enforceable.length > 0 && unrecognized.length === 0 };
}
