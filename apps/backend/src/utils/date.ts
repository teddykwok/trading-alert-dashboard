/**
 * Parses an incoming date-ish value (usually an ISO string from TradingView)
 * into a Date, falling back to "now" if it is missing or unparseable.
 */
export function parseOrNowDate(value: string | undefined): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function toIsoString(date: Date): string {
  return date.toISOString();
}
