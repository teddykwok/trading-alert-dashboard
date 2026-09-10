import type { FillIngestWindowBounds } from "./exchange-fill-ingest-window.service";

/**
 * The canonical UTC-day root windows a bounded ingestion sweep is seeded from.
 *
 * Pure and total: it reads no clock, no database, no configuration and no
 * network. The caller supplies the instant and the horizon, so the same inputs
 * always produce the same roots and a test can put the boundary anywhere it
 * likes without touching a system clock.
 *
 * ## Why whole UTC days
 *
 * A root has to be an interval that can never grow after it is proven. A
 * calendar day that has already ended is exactly that; anything anchored to
 * "now" is not. The days also tile: consecutive roots abut to the millisecond,
 * so the leaves of their split trees partition the swept range with no gap and
 * no overlap -- the property derived completeness rests on.
 *
 * ## Why epoch arithmetic and never calendar accessors
 *
 * `getFullYear` / `getMonth` / `getDate` read the PROCESS timezone. On a host
 * running Asia/Singapore they would call 2026-09-10T20:00Z "the 11th" and hand
 * back a root for a UTC day that has not closed -- a window that could be
 * durably marked complete before the fills in it happened. Integer division of
 * the epoch has no timezone, no DST and no locale, so the answer cannot depend
 * on where the process runs.
 */

/** One whole day, in milliseconds. */
export const DAY_MS = 86_400_000;

/**
 * The narrowest horizon worth asking for: yesterday alone.
 *
 * Zero is refused rather than answered with an empty list, because an empty
 * list is also the honest answer to "this account has no symbols" and the two
 * must not be confusable at the call site.
 */
export const MIN_INGEST_HORIZON_DAYS = 1;

/**
 * The widest horizon this system will look back.
 *
 * Binance documents `/fapi/v1/userTrades` history as approximately the past
 * three months, and "approximately" is not a contract -- month lengths vary and
 * the true edge is not observable from here. The failure past that edge is the
 * dangerous kind: an expired interval returns an empty page, which is
 * indistinguishable from a genuinely quiet one, so the window would be marked
 * durably COMPLETE over history nobody can any longer read. Sixty days leaves
 * roughly a month of margin below the documented floor.
 *
 * Exported so the configuration layer can enforce the same ceiling by importing
 * it, rather than by writing a second `60` that drifts.
 */
export const MAX_INGEST_HORIZON_DAYS = 60;

/**
 * An argument that could never describe a real horizon or a real instant.
 *
 * Thrown rather than returned: by the time this is called the configuration
 * layer has already validated the horizon, so reaching it means a caller is
 * wrong about its own inputs. Returning an empty list instead would be the one
 * outcome the caller cannot tell apart from ordinary success.
 */
export class FillIngestHorizonRefusedError extends Error {
  readonly reasonCode = "FILL_INGEST_HORIZON_REFUSED";

  constructor(readonly detail: string) {
    super(`Refused to derive UTC-day roots: ${detail}`);
    this.name = "FillIngestHorizonRefusedError";
  }
}

/**
 * The canonical roots for the last `horizonDays` COMPLETE UTC days, oldest first.
 *
 * Each root is one whole UTC calendar day, inclusive on both ends:
 *
 *   startTimeMs   00:00:00.000 UTC
 *   endTimeMs     23:59:59.999 UTC   (startTimeMs + DAY_MS - 1)
 *
 * The UTC day containing `now` is NEVER returned, however far into that day
 * `now` has travelled and even at exactly midnight. A root ending in the future
 * would return a short page and be recorded as exhaustively seen over an
 * interval that has not finished happening -- a false claim that is
 * indistinguishable afterwards from a true one.
 *
 * Ordered oldest to newest deliberately. The oldest day sits nearest the
 * exchange's retention edge, so it is the work with the least time left to be
 * recoverable; chronological order puts it first instead of leaving the
 * priority to whatever order a later query happens to return.
 *
 * Bounds are safe-integer epoch milliseconds -- the same in-memory
 * representation `FillIngestWindowBounds`, the window service and the pure
 * planner already use. The database column is BigInt, but that conversion
 * belongs at the persistence boundary that already performs it, not here.
 */
export function canonicalUtcDayRoots(now: Date, horizonDays: number): FillIngestWindowBounds[] {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new FillIngestHorizonRefusedError("`now` must be a valid Date");
  }
  if (!Number.isSafeInteger(horizonDays)) {
    throw new FillIngestHorizonRefusedError(
      `horizonDays must be a safe integer, received ${String(horizonDays)}`
    );
  }
  if (horizonDays < MIN_INGEST_HORIZON_DAYS || horizonDays > MAX_INGEST_HORIZON_DAYS) {
    throw new FillIngestHorizonRefusedError(
      `horizonDays must be between ${MIN_INGEST_HORIZON_DAYS} and ${MAX_INGEST_HORIZON_DAYS}, received ${horizonDays}`
    );
  }

  const nowMs = now.getTime();
  if (nowMs < 0) {
    throw new FillIngestHorizonRefusedError("`now` must not be before the epoch");
  }

  // Integer division of the epoch. No Date component is ever read, so the
  // result is identical on every host regardless of its timezone.
  const currentDayStartMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const newestStartMs = currentDayStartMs - DAY_MS;
  const oldestStartMs = newestStartMs - (horizonDays - 1) * DAY_MS;

  if (oldestStartMs < 0) {
    throw new FillIngestHorizonRefusedError(
      `a ${horizonDays}-day horizon from ${now.toISOString()} reaches before the epoch`
    );
  }

  const roots: FillIngestWindowBounds[] = [];
  for (let startTimeMs = oldestStartMs; startTimeMs <= newestStartMs; startTimeMs += DAY_MS) {
    roots.push({ startTimeMs, endTimeMs: startTimeMs + DAY_MS - 1 });
  }
  return roots;
}
