import { Prisma } from "@prisma/client";

/**
 * The ONE definition of whether a STANDARD take profit clears the exchange's
 * minimum notional.
 *
 * ## Why this is its own module
 *
 * Two layers must agree on this rule and neither may depend on the other:
 *
 *   - Phase 5 admission refuses, BEFORE any exposure exists, a plan whose first
 *     take profit could never be placed;
 *   - the Phase 7 protection lifecycle refuses, after a fill, to reserve a
 *     tranche the exchange would reject.
 *
 * Sharing it by having the pure safety engine import the protection lifecycle
 * would point the decision engine at a lifecycle module for a single formula,
 * which is the wrong direction for that dependency however pure the target
 * happens to be today. Duplicating the comparison is worse: two independently
 * written copies drifting by one boundary case is exactly how FLOCKUSDT filled
 * with a verified stop and a target it could never place — 121 x 0.03691 =
 * 4.46611 against a floor of 5 — and then held the global recovery barrier open
 * against every later admission.
 *
 * So the rule lives here, in a module whose whole responsibility is this one
 * placement constraint, and both layers depend on IT rather than on each other.
 *
 * ## Purity
 *
 * `@prisma/client` is imported for `Prisma.Decimal` — the arbitrary-precision
 * TYPE — and nothing else. No clock, no environment, no I/O, no logging and no
 * Prisma client access. Given identical inputs it always returns the same
 * answer, which is what lets both callers be tested without a database.
 */

const D = Prisma.Decimal;

export interface StandardTakeProfitNotionalInput {
  /** The quantity that would actually be submitted. */
  quantity: string;
  /** The FROZEN plan take-profit price. Never a live or re-derived price. */
  price: string;
  /**
   * The symbol's authoritative minimum notional, exactly as the exchange
   * reported it. Null/blank means the symbol reported none — NOT that the
   * minimum is zero, and never a hardcoded default.
   */
  minNotional: string | null | undefined;
}

/**
 * True when `quantity x price` is at or above the floor.
 *
 * The boundary is INCLUSIVE: a notional exactly equal to the floor is
 * placeable, because that is what the exchange itself accepts. Arithmetic is
 * exact decimal — binary floating point makes 0.1 * 3 slightly greater than
 * 0.3, which would clear a 0.3 floor by accident.
 *
 * An absent floor answers "placeable" rather than inventing a minimum. Callers
 * decide what an UNREADABLE read means; neither treats "we could not look" as
 * permission, and both refuse an incomplete symbol read before reaching here.
 */
export function standardTakeProfitMeetsMinNotional(input: StandardTakeProfitNotionalInput): boolean {
  const floorRaw = input.minNotional;
  if (floorRaw === null || floorRaw === undefined || floorRaw.trim() === "") return true;
  return new D(input.quantity).times(input.price).greaterThanOrEqualTo(new D(floorRaw));
}
