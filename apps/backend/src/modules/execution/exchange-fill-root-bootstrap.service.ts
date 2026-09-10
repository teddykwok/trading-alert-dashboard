import type { PrismaClient } from "@prisma/client";

import {
  bindConfiguredExecutionProfileEnvironment,
  type BinanceProfileBindingFailure,
  type BinanceProfileBindingResult,
} from "./binance-profile-binding";
import { canonicalUtcDayRoots } from "./exchange-fill-day-roots";
import {
  ExchangeFillIngestWindowService,
  type FillIngestWindowBounds,
} from "./exchange-fill-ingest-window.service";
import {
  classifyCanonicalRoot,
  readParentlessRootsOverlappingRange,
  type ParentlessRootWindow,
} from "./exchange-fill-root-overlap";
import { executionSymbolsForProfile } from "./exchange-fill-symbol-universe";

/**
 * Composes the approved Phase 6 primitives into the one act that makes
 * historical fill work exist: every completed UTC day of the horizon, for every
 * symbol this account has actually executed, present exactly once as a root.
 *
 * ## The barrier is the design
 *
 * Preflight runs over the WHOLE workset before the first row is written. A
 * structural collision found on the last day of the last symbol refuses the
 * entire invocation, including the hundreds of roots before it that were
 * perfectly creatable. Creating those first and refusing afterwards would leave
 * an operator holding a half-built horizon whose missing half is exactly the
 * part that needs a human -- and the next invocation would rediscover the same
 * conflict having made the picture harder to read.
 *
 * ## What is NOT atomic, deliberately
 *
 * The creation phase is not one transaction. A sixty-day horizon across a
 * hundred symbols is six thousand rows, and holding that open would make an
 * ordinary infrastructure blip roll back work that was entirely correct. A
 * crash mid-creation is safe BECAUSE the roots are canonical: whatever was
 * committed is seen by the next invocation's preflight as compatible, and only
 * the remainder is seeded. Partial progress is resumable progress.
 *
 * The zero-write guarantee is therefore precise, and is claimed for exactly one
 * thing: a structural collision KNOWN AT PREFLIGHT. It is not a claim that
 * every possible failure leaves nothing behind.
 */

/** One desired root that cannot be created, and the roots standing in its way. */
export interface StructuralRootConflict {
  readonly symbol: string;
  readonly desired: FillIngestWindowBounds;
  readonly overlaps: readonly ParentlessRootWindow[];
}

/**
 * A desired canonical root collides with parentless roots that are not it.
 *
 * Carries every conflict found, in workset order, rather than the first: an
 * operator deciding what to do needs the shape of the damage, and a second
 * invocation to discover conflict two is a worse way to learn it.
 */
export class FillRootStructuralOverlapError extends Error {
  readonly reasonCode = "FILL_ROOT_STRUCTURAL_OVERLAP";
  constructor(
    readonly executionProfileId: string,
    readonly conflicts: readonly StructuralRootConflict[]
  ) {
    super(
      `Refusing to bootstrap fill roots for execution profile ${executionProfileId}: ` +
        `${conflicts.length} desired canonical root(s) overlap existing parentless roots. ` +
        `Structural root overlap is never repaired automatically.`
    );
    this.name = "FillRootStructuralOverlapError";
  }
}

/**
 * A creation lost the exact natural-identity race, and the winner is not there.
 *
 * The only honest response. The row this invocation was told already existed
 * cannot be read back, so neither "created" nor "already compatible" is true,
 * and reporting success would put a coverage claim behind a root that is not
 * durable.
 */
export class FillRootRaceUnresolvedError extends Error {
  readonly reasonCode = "FILL_ROOT_RACE_UNRESOLVED";
  constructor(
    readonly executionProfileId: string,
    readonly symbol: string,
    readonly desired: FillIngestWindowBounds
  ) {
    super(
      `Fill root ${symbol} [${desired.startTimeMs}, ${desired.endTimeMs}] for execution profile ` +
        `${executionProfileId} was reported as already present, but a fresh read found no such root. ` +
        `Refusing to report coverage that is not durable.`
    );
    this.name = "FillRootRaceUnresolvedError";
  }
}

/** A counting bug in this file, surfaced rather than returned. */
export class FillRootBootstrapInvariantError extends Error {
  readonly reasonCode = "FILL_ROOT_BOOTSTRAP_INVARIANT";
  constructor(detail: string) {
    super(`Fill root bootstrap invariant violated: ${detail}`);
    this.name = "FillRootBootstrapInvariantError";
  }
}

/**
 * What one bootstrap invocation did.
 *
 * `PROFILE_UNAVAILABLE` mirrors the one-window executor exactly, including
 * carrying the binder's own reason code rather than a flattened string: an
 * operator who sees PROFILE_POLICY_MISSING must not be told the same thing as
 * one whose connector is crossed.
 */
export type FillRootBootstrapResult =
  | { outcome: "PROFILE_UNAVAILABLE"; reasonCode: BinanceProfileBindingFailure }
  | {
      outcome: "BOOTSTRAPPED";
      executionProfileId: string;
      horizonDays: number;
      symbolCount: number;
      dayCount: number;
      expectedRootCount: number;
      /** Exact roots already present AT PREFLIGHT. Never written to. */
      alreadyCompatibleCount: number;
      /** This invocation inserted the row. */
      createdCount: number;
      /** Preflight said missing, the insert lost, a fresh read proved a winner. */
      raceReconciledCount: number;
    };

export interface FillRootBootstrapDependencies {
  prisma: PrismaClient;
  work: ExchangeFillIngestWindowService;
  /**
   * How the configured profile is bound to the configured connector. Injectable
   * only so tests can drive a binding failure; the default is the real binder,
   * which takes no profile id precisely so a caller cannot name one.
   */
  bindProfile?: (prisma: PrismaClient) => Promise<BinanceProfileBindingResult>;
}

/** One expected root, and what preflight decided about it. */
interface PreflightEntry {
  readonly symbol: string;
  readonly bounds: FillIngestWindowBounds;
  readonly compatibleWindowId: string | null;
}

export class ExchangeFillRootBootstrap {
  private readonly bindProfile: (prisma: PrismaClient) => Promise<BinanceProfileBindingResult>;

  constructor(private readonly deps: FillRootBootstrapDependencies) {
    this.bindProfile = deps.bindProfile ?? bindConfiguredExecutionProfileEnvironment;
  }

  /**
   * Ensures every completed UTC day of the horizon exists as a root, for every
   * executed symbol.
   *
   * `now` and `horizonDays` are arguments, not configuration: this slice owns
   * composition and nothing else, so there is no env var to read and no clock
   * to consult. Both are handed straight to the pure Slice 1 generator, whose
   * refusals are its own and are not softened here.
   *
   * There is deliberately no `executionProfileId` parameter. The account is
   * whatever the process is configured and bound to, so no caller can point a
   * bootstrap at an account it was not authorized to touch.
   */
  async bootstrapHistoricalRoots(options: {
    now: Date;
    horizonDays: number;
  }): Promise<FillRootBootstrapResult> {
    const binding = await this.bindProfile(this.deps.prisma);
    if (!binding.ok) {
      // The binder's exact reason, unflattened, and not one row written.
      return { outcome: "PROFILE_UNAVAILABLE", reasonCode: binding.reasonCode };
    }
    const executionProfileId = binding.context.executionProfileId;

    // Pure, and first: an invalid horizon is refused before the database is
    // asked anything at all. Slice 1 owns every bound of this decision --
    // completed days only, 1..60, no clamp.
    const days = canonicalUtcDayRoots(options.now, options.horizonDays);

    // Authoritative and unfiltered by doctrine. A lineage error is a structural
    // durable-data fault and propagates as itself.
    const symbols = await executionSymbolsForProfile(this.deps.prisma, executionProfileId);

    const empty = {
      outcome: "BOOTSTRAPPED",
      executionProfileId,
      horizonDays: options.horizonDays,
      symbolCount: symbols.length,
      dayCount: days.length,
      expectedRootCount: 0,
      alreadyCompatibleCount: 0,
      createdCount: 0,
      raceReconciledCount: 0,
    } as const;

    // An account that has never executed anything has no fills to ingest. That
    // is success with nothing to do, not an error.
    if (symbols.length === 0) return empty;

    const preflight = await this.preflight(executionProfileId, symbols, days);

    let alreadyCompatibleCount = 0;
    let createdCount = 0;
    let raceReconciledCount = 0;

    for (const entry of preflight) {
      if (entry.compatibleWindowId !== null) {
        // Present, exact, and left ENTIRELY alone -- no write helper is called
        // on it at all, whatever its status, lease or attempt history says.
        alreadyCompatibleCount += 1;
        continue;
      }

      const seeded = await this.deps.work.seedWindow(this.deps.prisma, {
        executionProfileId,
        symbol: entry.symbol,
        ...entry.bounds,
      });

      if (seeded.created) {
        createdCount += 1;
        continue;
      }

      // The row was missing at preflight and present at insert: somebody else
      // wrote this exact natural identity in between. Nothing is assumed about
      // what they wrote.
      await this.reconcileLostRace(executionProfileId, entry.symbol, entry.bounds);
      raceReconciledCount += 1;
    }

    const expectedRootCount = preflight.length;
    if (alreadyCompatibleCount + createdCount + raceReconciledCount !== expectedRootCount) {
      throw new FillRootBootstrapInvariantError(
        `expected ${expectedRootCount} roots but accounted for ` +
          `${alreadyCompatibleCount + createdCount + raceReconciledCount}`
      );
    }

    return {
      outcome: "BOOTSTRAPPED",
      executionProfileId,
      horizonDays: options.horizonDays,
      symbolCount: symbols.length,
      dayCount: days.length,
      expectedRootCount,
      alreadyCompatibleCount,
      createdCount,
      raceReconciledCount,
    };
  }

  /**
   * Classifies the ENTIRE workset before returning, or refuses all of it.
   *
   * One horizon-level scan per symbol, then the pure classifier per day -- not
   * one query per day, which would be sixty round trips to answer from the same
   * handful of rows. Nothing here writes, so the barrier below is a barrier in
   * fact and not merely by convention.
   *
   * Order is the two approved primitives' own: `executionSymbolsForProfile`
   * sorts its symbols and `canonicalUtcDayRoots` emits oldest to newest. No
   * third sorting authority is introduced here, and no database ordering is
   * relied on beyond the one Slice 3 already pins.
   */
  private async preflight(
    executionProfileId: string,
    symbols: readonly string[],
    days: readonly FillIngestWindowBounds[]
  ): Promise<PreflightEntry[]> {
    const entries: PreflightEntry[] = [];
    const conflicts: StructuralRootConflict[] = [];

    for (const symbol of symbols) {
      const roots = await readParentlessRootsOverlappingRange(this.deps.prisma, executionProfileId, symbol, {
        startTimeMs: days[0]!.startTimeMs,
        endTimeMs: days[days.length - 1]!.endTimeMs,
      });

      for (const bounds of days) {
        const verdict = classifyCanonicalRoot({ executionProfileId, symbol, ...bounds }, roots);

        if (verdict.kind === "STRUCTURAL_ROOT_OVERLAP") {
          // Collected, not thrown: the whole picture is worth more than the
          // first symptom, and no write can happen before this loop ends.
          conflicts.push({ symbol, desired: verdict.desired, overlaps: verdict.overlaps });
          continue;
        }

        entries.push({
          symbol,
          bounds,
          compatibleWindowId: verdict.kind === "COMPATIBLE_EXISTING_ROOT" ? verdict.windowId : null,
        });
      }
    }

    // THE BARRIER. Every symbol and every day has now been classified, and not
    // one row has been written.
    if (conflicts.length > 0) {
      throw new FillRootStructuralOverlapError(executionProfileId, conflicts);
    }

    return entries;
  }

  /**
   * Re-decides one desired root after its insert reported that it already
   * existed.
   *
   * `seedWindow` inserts with `skipDuplicates`, so the exact natural-identity
   * race does NOT surface as P2002 -- it surfaces as `created === false`, and
   * the insert's own transaction committed rather than aborting. The fresh read
   * below therefore runs on a usable client and never queries a failed
   * transaction scope.
   *
   * "Somebody else got there first" is NOT by itself proof of a correct
   * outcome, which is why this re-reads instead of counting the row and moving
   * on. Three things could be true, and only one of them is success.
   */
  private async reconcileLostRace(
    executionProfileId: string,
    symbol: string,
    bounds: FillIngestWindowBounds
  ): Promise<void> {
    const roots = await readParentlessRootsOverlappingRange(
      this.deps.prisma,
      executionProfileId,
      symbol,
      bounds
    );
    const verdict = classifyCanonicalRoot({ executionProfileId, symbol, ...bounds }, roots);

    // Exactly one root, exactly these bounds: the winner is durable and correct,
    // and it is not touched.
    if (verdict.kind === "COMPATIBLE_EXISTING_ROOT") return;

    // Whoever won wrote something this bootstrap would never have written.
    if (verdict.kind === "STRUCTURAL_ROOT_OVERLAP") {
      throw new FillRootStructuralOverlapError(executionProfileId, [
        { symbol, desired: verdict.desired, overlaps: verdict.overlaps },
      ]);
    }

    // Told it existed, then found nothing. Never reported as success.
    throw new FillRootRaceUnresolvedError(executionProfileId, symbol, bounds);
  }
}
