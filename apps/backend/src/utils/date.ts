/**
 * Parses an ISO-8601 timestamp, or returns null. NEVER substitutes a default.
 *
 * Two traps this closes, both of which turn an unusable value into a usable
 * one rather than into a refusal:
 *
 *   1. `new Date("abc")` is an Invalid Date, which a caller that falls back to
 *      "now" will happily replace with the current time — making a timestamp
 *      nobody sent look maximally fresh.
 *   2. `new Date("2026-02-30T00:00:00Z")` is NOT invalid. V8 rolls the
 *      impossible day forward and returns 2026-03-02, so a NaN check alone
 *      accepts a date the calendar does not have. The calendar components are
 *      therefore compared back against what the string actually claimed.
 *
 * The time portion is optional so a date-only value still parses; what is not
 * optional is that the result means what the sender wrote.
 */
export function parseIsoDateStrict(value: string | undefined | null): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    return null;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Parses an incoming date-ish value (usually an ISO string from TradingView)
 * into a Date, falling back to "now" if it is missing or unparseable.
 *
 * DO NOT use this for any timestamp a safety decision reads. Falling back to
 * "now" makes an absent or malformed value look like it just happened, which
 * is the opposite of failing closed — alert freshness used this and a
 * malformed `triggeredAt` therefore read as a brand-new signal. Use
 * `parseIsoDateStrict` and refuse the input instead.
 */
export function parseOrNowDate(value: string | undefined): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function toIsoString(date: Date): string {
  return date.toISOString();
}
