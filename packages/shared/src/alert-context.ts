/**
 * Structured "level context" metadata carried inside the free-text `note`
 * field of Pine webhook payloads, e.g.:
 *
 *   eventType=LEVEL_TOUCHED | levelColor=RED | sourceTf=12M | touchDirection=FROM_BELOW | levelPrice=0.123 | chartTf=1h
 *
 * `sourceTf` is the timeframe the red/green level ORIGINATED on (1D…12M).
 * It is deliberately distinct from `Alert.timeframe`, which is the CHART
 * timeframe the alert fired on (e.g. "30m", "1h") — never conflate the two.
 */

export const ALERT_EVENT_TYPES = ["LEVEL_CREATED", "LEVEL_TOUCHED"] as const;
export type AlertEventType = (typeof ALERT_EVENT_TYPES)[number];

export const LEVEL_COLORS = ["GREEN", "RED"] as const;
export type LevelColor = (typeof LEVEL_COLORS)[number];

export const SOURCE_TIMEFRAMES = ["1D", "1W", "1M", "3M", "6M", "12M"] as const;
export type SourceTimeframe = (typeof SOURCE_TIMEFRAMES)[number];

export const TOUCH_DIRECTIONS = ["FROM_ABOVE", "FROM_BELOW", "UNKNOWN"] as const;
export type TouchDirection = (typeof TOUCH_DIRECTIONS)[number];

/** Everything the note can tell us; each field is null when absent/invalid. */
export interface ParsedAlertNote {
  eventType: AlertEventType | null;
  levelColor: LevelColor | null;
  sourceTimeframe: SourceTimeframe | null;
  touchDirection: TouchDirection | null;
  levelPrice: number | null;
  chartTimeframe: string | null;
}

/**
 * Level context as exposed on API alert objects. Same shape as the parsed
 * note, but `chartTimeframe` is sourced from `Alert.timeframe` (the stored
 * chart timeframe), not from the note.
 */
export type AlertContext = ParsedAlertNote;

const EMPTY_PARSED_NOTE: ParsedAlertNote = {
  eventType: null,
  levelColor: null,
  sourceTimeframe: null,
  touchDirection: null,
  levelPrice: null,
  chartTimeframe: null,
};

function matchAllowed<T extends string>(allowed: readonly T[], value: string): T | null {
  const upper = value.toUpperCase();
  return (allowed as readonly string[]).includes(upper) ? (upper as T) : null;
}

/**
 * Parses the structured `key=value | key=value` note format.
 *
 * Guarantees:
 * - never throws, whatever the input (legacy free-text notes, null, "")
 * - tolerates any key order and extra whitespace around `|` / `=`
 * - ignores unknown keys (e.g. the Pine script also emits `alertTiming=…`)
 * - unsupported values for known keys become null — nothing is guessed
 */
export function parseAlertNote(note: string | null | undefined): ParsedAlertNote {
  if (typeof note !== "string" || note.trim() === "") return { ...EMPTY_PARSED_NOTE };

  const result: ParsedAlertNote = { ...EMPTY_PARSED_NOTE };

  for (const segment of note.split("|")) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;

    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (value === "") continue;

    switch (key) {
      case "eventType":
        result.eventType = matchAllowed(ALERT_EVENT_TYPES, value);
        break;
      case "levelColor":
        result.levelColor = matchAllowed(LEVEL_COLORS, value);
        break;
      case "sourceTf":
        result.sourceTimeframe = matchAllowed(SOURCE_TIMEFRAMES, value);
        break;
      case "touchDirection":
        result.touchDirection = matchAllowed(TOUCH_DIRECTIONS, value);
        break;
      case "levelPrice": {
        const parsed = Number(value);
        result.levelPrice = Number.isFinite(parsed) ? parsed : null;
        break;
      }
      case "chartTf":
        result.chartTimeframe = value;
        break;
      default:
        // Unknown key — ignore.
        break;
    }
  }

  return result;
}

/** True when the context carries actual level metadata (not just chart tf). */
export function hasLevelMetadata(context: ParsedAlertNote | null | undefined): boolean {
  if (!context) return false;
  return (
    context.eventType !== null ||
    context.levelColor !== null ||
    context.sourceTimeframe !== null ||
    context.touchDirection !== null ||
    context.levelPrice !== null
  );
}

/**
 * The ONE place a free-form string becomes a canonical source timeframe.
 *
 * Deliberately the same rule the note parser already applies — uppercase, then
 * exact membership of SOURCE_TIMEFRAMES — so an operator policy and an inbound
 * alert can never disagree about what "1w" means. Anything else is null:
 * nothing is guessed, and a bare "W" or "D" is NOT silently promoted to "1W"
 * or "1D", because a timeframe nobody recognised must not become one that
 * admits a trade.
 */
export function normalizeSourceTimeframe(value: unknown): SourceTimeframe | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return matchAllowed(SOURCE_TIMEFRAMES, trimmed);
}

/** 3M/6M/12M levels get a neutral "higher timeframe" emphasis in the UI. */
export const HIGHER_SOURCE_TIMEFRAMES: readonly SourceTimeframe[] = ["3M", "6M", "12M"];

export function isHigherSourceTimeframe(tf: string | null | undefined): boolean {
  return tf != null && (HIGHER_SOURCE_TIMEFRAMES as readonly string[]).includes(tf);
}
