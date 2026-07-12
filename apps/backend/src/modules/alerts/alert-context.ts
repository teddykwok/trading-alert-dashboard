import type { Alert } from "@prisma/client";
import {
  parseAlertNote,
  hasLevelMetadata,
  SOURCE_TIMEFRAMES,
  type AlertContext,
  type SourceTimeframe,
} from "@trading-alert-dashboard/shared";

/**
 * Extracts the original webhook note from the stored raw payload. The note
 * was never persisted as its own column — it lives (unchanged) inside
 * rawPayload, which is also where legacy alerts keep their only copy of the
 * level metadata.
 */
export function noteFromRawPayload(rawPayload: unknown): string | null {
  if (rawPayload !== null && typeof rawPayload === "object" && "note" in rawPayload) {
    const note = (rawPayload as { note?: unknown }).note;
    if (typeof note === "string") return note;
  }
  return null;
}

function validSourceTimeframe(value: string | null): SourceTimeframe | null {
  return value !== null && (SOURCE_TIMEFRAMES as readonly string[]).includes(value)
    ? (value as SourceTimeframe)
    : null;
}

/**
 * Builds the `alertContext` object exposed on API/socket alert payloads.
 *
 * - Structured columns win when present (alerts ingested after the columns
 *   were added); otherwise falls back to parsing the note in rawPayload, so
 *   old alerts still surface their metadata without any data migration.
 * - `levelPrice` is never stored — always read from the note.
 * - `chartTimeframe` always comes from Alert.timeframe (the chart timeframe),
 *   never from the note's chartTf, and never from sourceTimeframe.
 * - Returns null when the alert carries no level metadata at all, so alerts
 *   from other indicators/free-text notes keep a clean `alertContext: null`.
 */
export function buildAlertContext(
  alert: Pick<
    Alert,
    "eventType" | "levelColor" | "sourceTimeframe" | "touchDirection" | "timeframe" | "rawPayload"
  >
): AlertContext | null {
  const parsed = parseAlertNote(noteFromRawPayload(alert.rawPayload));

  const context: AlertContext = {
    eventType: alert.eventType ?? parsed.eventType,
    levelColor: alert.levelColor ?? parsed.levelColor,
    sourceTimeframe: validSourceTimeframe(alert.sourceTimeframe) ?? parsed.sourceTimeframe,
    touchDirection: alert.touchDirection ?? parsed.touchDirection,
    levelPrice: parsed.levelPrice,
    chartTimeframe: alert.timeframe ?? parsed.chartTimeframe,
  };

  return hasLevelMetadata(context) ? context : null;
}

/** Attaches `alertContext` to an alert row for API responses / socket events. */
export function withAlertContext<T extends Parameters<typeof buildAlertContext>[0]>(
  alert: T
): T & { alertContext: AlertContext | null } {
  return { ...alert, alertContext: buildAlertContext(alert) };
}
