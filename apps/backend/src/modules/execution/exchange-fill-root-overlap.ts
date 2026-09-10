import type { Prisma } from "@prisma/client";

import {
  assertBounds,
  toMs,
  FillIngestWindowRefusedError,
  type FillIngestWindowBounds,
} from "./exchange-fill-ingest-window.service";

/**
 * Whether one desired canonical UTC-day root can be created, already exists, or
 * is structurally blocked.
 *
 * The natural key `(executionProfileId, symbol, startTimeMs, endTimeMs)` is NOT
 * sufficient protection on its own. A desired root
 *
 *   2026-08-11T00:00:00.000Z .. 2026-08-11T23:59:59.999Z
 *
 * and an already-present parentless root
 *
 *   2026-08-10T12:00:00.000Z .. 2026-08-11T12:00:00.000Z
 *
 * are DIFFERENT natural keys, so the unique constraint happily admits both --
 * and the account then holds two independent split trees claiming exhaustion
 * over the same twelve hours. Nothing downstream can tell which tree's COMPLETE
 * is the truth. So the question asked here is about INTERVALS, not keys.
 *
 * Scanning parentless roots alone is sufficient. Every descendant is produced
 * only by bisecting its parent, so every descendant is contained in its root;
 * an interval that overlaps no root cannot overlap any descendant. There is
 * deliberately no descendant traversal, no recursive CTE and no orphan audit
 * here.
 *
 * This module NEVER writes. It refuses to pick a winner, trim, merge, delete or
 * repair anything: a structural overlap is a human question, and the only safe
 * automatic answer is to stop.
 */

/** One parentless root, in the exact integer milliseconds the planner speaks. */
export interface ParentlessRootWindow extends FillIngestWindowBounds {
  windowId: string;
}

/**
 * The verdict on ONE desired canonical root.
 *
 * `COMPATIBLE_EXISTING_ROOT` means the row is already exactly right and must be
 * left COMPLETELY untouched -- whatever its status, attempts, lease, backoff or
 * error metadata say. A day that was abandoned or split is still that day; the
 * bootstrap does not get to reopen it by re-seeding.
 *
 * `STRUCTURAL_ROOT_OVERLAP` carries everything an operator needs to see the
 * collision without re-querying: the account, the symbol, the interval that was
 * wanted, and every parentless root that stands in its way.
 */
export type CanonicalRootCompatibility =
  | { readonly kind: "MISSING" }
  | { readonly kind: "COMPATIBLE_EXISTING_ROOT"; readonly windowId: string }
  | {
      readonly kind: "STRUCTURAL_ROOT_OVERLAP";
      readonly executionProfileId: string;
      readonly symbol: string;
      readonly desired: FillIngestWindowBounds;
      readonly overlaps: readonly ParentlessRootWindow[];
    };

/**
 * Bounds for a SCAN, which is not a window.
 *
 * A horizon is legitimately sixty days wide, and `assertBounds` refuses
 * anything past the seven-day userTrades span -- correctly, because that cap is
 * a limit on what may be ASKED OF AN EXCHANGE, and no request is ever made for
 * a scan range. Every other rule is still the window rule: each endpoint is put
 * through `assertBounds` as a zero-span interval, so a safe-integer or
 * before-the-epoch bound is refused by the SAME validator, and this can never
 * quietly drift into a weaker second one.
 */
function assertScanRange(range: FillIngestWindowBounds): void {
  assertBounds(range.startTimeMs, range.startTimeMs);
  assertBounds(range.endTimeMs, range.endTimeMs);
  if (range.endTimeMs < range.startTimeMs) {
    throw new FillIngestWindowRefusedError(
      "the interval ends before it starts",
      range.startTimeMs,
      range.endTimeMs
    );
  }
}

/**
 * Every parentless root of one account+symbol that touches `range`, ONCE.
 *
 * A horizon is classified against a single scan, not one query per day: sixty
 * days is sixty round trips otherwise, and the answer to all sixty is contained
 * in the same handful of rows.
 *
 * The three IDENTITY halves of the overlap predicate are enforced here and only
 * here -- account, symbol, and parentless -- while the two TIME halves are
 * enforced only in `classifyCanonicalRoot`. Each rule therefore has exactly one
 * enforcement point, which is what makes each of them independently falsifiable
 * by a test.
 *
 * No status filter, by doctrine. A COMPLETE, SPLIT or ABANDONED root occupies
 * its interval exactly as much as a PENDING one does; a terminal status is a
 * statement about work, not a release of the time it covers.
 *
 * Infrastructure failures propagate untouched. There is no catch here, because
 * a database that cannot answer has not said "no overlap" -- and a caller that
 * read a refusal as an all-clear would create the second root itself.
 */
export async function readParentlessRootsOverlappingRange(
  client: Prisma.TransactionClient,
  executionProfileId: string,
  symbol: string,
  range: FillIngestWindowBounds
): Promise<ParentlessRootWindow[]> {
  assertScanRange(range);

  const rows = await client.exchangeFillIngestWindow.findMany({
    where: {
      executionProfileId,
      symbol,
      // NULL means root. A descendant is contained in its own root, so
      // including one here could only report the same collision twice.
      parentId: null,
      // Inclusive on both sides. `lte`/`gte`, never `lt`/`gt`: bounds are
      // inclusive milliseconds, so a root ending at exactly the desired start
      // shares that millisecond and IS an overlap.
      startTimeMs: { lte: BigInt(range.endTimeMs) },
      endTimeMs: { gte: BigInt(range.startTimeMs) },
    },
    select: { id: true, startTimeMs: true, endTimeMs: true },
    // Total and deterministic: `id` breaks the tie that identical bounds would
    // leave, so an operator comparing two reports compares the same list.
    orderBy: [{ startTimeMs: "asc" }, { endTimeMs: "asc" }, { id: "asc" }],
  });

  // BigInt stops at this boundary. Everything downstream -- reports, API
  // payloads, JSON.stringify -- works in the same safe integers the planner
  // does, and `toMs` refuses a stored bound that cannot be one.
  return rows.map((row) => ({
    windowId: row.id,
    startTimeMs: toMs(row.startTimeMs),
    endTimeMs: toMs(row.endTimeMs),
  }));
}

/**
 * PURE. Classifies one desired canonical root against roots already read.
 *
 * `parentlessRoots` is the whole horizon scan; the interval test below narrows
 * it to this one day. Input order is preserved rather than re-sorted -- the
 * reader's `orderBy` is the single ordering authority, and a second sort here
 * would only hide its loss.
 *
 * The doctrine is deliberately unforgiving:
 *
 *   0 overlaps                -> MISSING
 *   1 overlap, bounds EXACT   -> COMPATIBLE_EXISTING_ROOT
 *   anything else             -> STRUCTURAL_ROOT_OVERLAP
 *
 * "Anything else" includes the case that looks most harmless: an exactly-equal
 * root that ALSO has a crossing neighbour. The exact row is not a permission
 * slip -- the neighbour still claims the same hours, and seeding on top of it
 * would extend a broken structure rather than notice it.
 *
 * Refuses invalid desired bounds through the SAME validator the write path
 * uses, so an interval this module calls MISSING is always an interval
 * `seedWindow` would actually accept.
 */
export function classifyCanonicalRoot(
  desired: { executionProfileId: string; symbol: string } & FillIngestWindowBounds,
  parentlessRoots: readonly ParentlessRootWindow[]
): CanonicalRootCompatibility {
  assertBounds(desired.startTimeMs, desired.endTimeMs);

  const overlaps = parentlessRoots.filter(
    (root) => root.startTimeMs <= desired.endTimeMs && root.endTimeMs >= desired.startTimeMs
  );

  if (overlaps.length === 0) return { kind: "MISSING" };

  if (overlaps.length === 1) {
    const only = overlaps[0]!;
    if (only.startTimeMs === desired.startTimeMs && only.endTimeMs === desired.endTimeMs) {
      // Already exactly this day. The row is returned by id and NOTHING about
      // it is reported as needing repair.
      return { kind: "COMPATIBLE_EXISTING_ROOT", windowId: only.windowId };
    }
  }

  return {
    kind: "STRUCTURAL_ROOT_OVERLAP",
    executionProfileId: desired.executionProfileId,
    symbol: desired.symbol,
    desired: { startTimeMs: desired.startTimeMs, endTimeMs: desired.endTimeMs },
    overlaps,
  };
}
