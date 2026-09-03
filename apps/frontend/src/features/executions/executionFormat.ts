import { isNegativeDecimalString, subtractDecimalStrings } from "@trading-alert-dashboard/shared";

/**
 * Phase 8 — value formatting for the execution journal.
 *
 * Pure, so the null-versus-zero and net-PnL rules can be tested directly.
 *
 * Two rules drive everything here:
 *  - null means UNKNOWN and must stay visually distinct from zero;
 *  - a shortened display must never imply precision the value does not have,
 *    so the exact string always remains available for a tooltip/label.
 */

/** What an unknown value renders as. Zero renders as "0", never as this. */
export const UNKNOWN_DISPLAY = "—";

export interface DisplayValue {
  /** What is shown in the cell. */
  text: string;
  /** The full exact value for a title/aria-label, or null when unknown. */
  exact: string | null;
  known: boolean;
}

/**
 * A decimal string for display. Zero is a real, known value and is rendered
 * as "0" — only null becomes the unknown marker.
 */
export function displayDecimal(value: string | null | undefined, maxFractionDigits = 8): DisplayValue {
  if (value === null || value === undefined || value === "") {
    return { text: UNKNOWN_DISPLAY, exact: null, known: false };
  }

  const exact = String(value);
  const [whole, fraction] = exact.split(".");
  if (fraction === undefined || fraction.length <= maxFractionDigits) {
    return { text: exact, exact, known: true };
  }

  // Truncate rather than round: a rounded tail would imply a value the
  // exchange never reported. The full value stays in `exact`.
  return { text: `${whole}.${fraction.slice(0, maxFractionDigits)}…`, exact, known: true };
}

/**
 * A ratio rendered as a percentage.
 *
 * The backend reports slippage as a FRACTION of the planned reward distance,
 * so 0.432 is 43.2%. Multiplying here is presentation, not arithmetic the
 * backend owns — and the untouched fraction stays in `exact`, so the exact
 * value is always one hover away and a rounding artefact can never be mistaken
 * for the real number.
 *
 * A value that will not parse is unknown, never zero.
 */
export function displayPercentFromRatio(
  value: string | null | undefined,
  fractionDigits = 1
): DisplayValue {
  if (value === null || value === undefined || value === "") {
    return { text: UNKNOWN_DISPLAY, exact: null, known: false };
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return { text: UNKNOWN_DISPLAY, exact: null, known: false };
  }
  return {
    text: `${(numeric * 100).toFixed(fractionDigits)}%`,
    exact: String(value),
    known: true,
  };
}

export function displayInteger(value: number | null | undefined): DisplayValue {
  if (value === null || value === undefined) return { text: UNKNOWN_DISPLAY, exact: null, known: false };
  return { text: String(value), exact: String(value), known: true };
}

export function displayText(value: string | null | undefined): DisplayValue {
  if (value === null || value === undefined || value === "") {
    return { text: UNKNOWN_DISPLAY, exact: null, known: false };
  }
  return { text: value, exact: value, known: true };
}

/** ISO-8601 in, locale string out. Null stays unknown. */
export function displayTimestamp(value: string | null | undefined): DisplayValue {
  if (!value) return { text: UNKNOWN_DISPLAY, exact: null, known: false };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { text: value, exact: value, known: true };
  return { text: parsed.toLocaleString(), exact: value, known: true };
}

/**
 * Signed difference between a planned and an actual decimal, or null when
 * either side is unknown. Never computed from a missing value — a
 * "slippage of 100" against a null fill would be pure fiction.
 *
 * Uses the shared arbitrary-precision helper rather than JS floats, so a
 * displayed difference is exact rather than 0.01999999999999602.
 */
export function decimalDifference(planned: string | null, actual: string | null): string | null {
  return subtractDecimalStrings(planned, actual);
}

/** True when the value is negative (styling only). Exact, never float-parsed. */
export function isNegative(value: string | null): boolean {
  return isNegativeDecimalString(value);
}

export interface AggregatePnlDisplay {
  text: string;
  /** Explicit caveat when some closed executions have unknown PnL. */
  caveat: string | null;
  complete: boolean;
}

/**
 * Aggregate realized PnL with an explicit completeness statement. The sum only
 * ever covers KNOWN values, so when any closed execution has unknown PnL the
 * figure is labelled partial rather than presented as net profit.
 */
export function displayAggregatePnl(input: {
  knownRealizedPnl: string;
  closedWithKnownPnl: number;
  closedWithUnknownPnl: number;
}): AggregatePnlDisplay {
  const complete = input.closedWithUnknownPnl === 0;
  if (input.closedWithKnownPnl === 0 && !complete) {
    return {
      text: UNKNOWN_DISPLAY,
      caveat: `No realized PnL is known for ${input.closedWithUnknownPnl} closed execution(s).`,
      complete: false,
    };
  }
  return {
    text: input.knownRealizedPnl,
    caveat: complete
      ? null
      : `Partial: excludes ${input.closedWithUnknownPnl} closed execution(s) with unknown PnL.`,
    complete,
  };
}

/**
 * Net PnL for display. The backend already returns null unless every
 * component is known; this mirrors that rule so a partial net result can
 * never be assembled client-side either.
 */
export function displayNetPnl(input: {
  realizedPnl: string | null;
  tradingFeesUsd: string | null;
  fundingPnlUsd: string | null;
  netPnlUsd: string | null;
}): DisplayValue & { missingComponents: string[] } {
  const missing: string[] = [];
  if (input.realizedPnl === null) missing.push("realized PnL");
  if (input.tradingFeesUsd === null) missing.push("trading fees");
  if (input.fundingPnlUsd === null) missing.push("funding PnL");

  if (missing.length > 0 || input.netPnlUsd === null) {
    return { text: UNKNOWN_DISPLAY, exact: null, known: false, missingComponents: missing };
  }
  return { ...displayDecimal(input.netPnlUsd), missingComponents: [] };
}

/** Shortens a long id for display while keeping the full value copyable. */
export function shortenId(id: string | null, head = 10, tail = 6): DisplayValue {
  if (!id) return { text: UNKNOWN_DISPLAY, exact: null, known: false };
  if (id.length <= head + tail + 1) return { text: id, exact: id, known: true };
  return { text: `${id.slice(0, head)}…${id.slice(-tail)}`, exact: id, known: true };
}
