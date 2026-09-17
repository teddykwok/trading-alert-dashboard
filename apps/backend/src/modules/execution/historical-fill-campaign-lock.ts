import type { Prisma } from "@prisma/client";

import { profileLockKey } from "./profile-lock";

/**
 * The serialization point for historical-backfill campaign lifecycle changes.
 *
 * ## Why a lock when a unique index already exists
 *
 * The partial unique index makes TWO LIVE CAMPAIGNS impossible, and it does
 * that job alone: whichever writer commits second is refused by the database,
 * whatever it read beforehand. What the index cannot order is a campaign
 * lifecycle change against an ADMISSION that is spending the same campaign's
 * slots. Admission reads the campaign, decides there is a slot left, and
 * writes; a pause, an abort or an exhaustion landing between that read and
 * that write is a decision made against a campaign that no longer exists in
 * the state it was checked in.
 *
 * The lock gives every campaign transition and every admission for one profile
 * a single queue to stand in, so each of them sees a settled campaign rather
 * than one mid-transition.
 *
 * ## Why per PROFILE, not per campaign
 *
 * The thing being protected is "which campaign is live for this account", and
 * that question spans rows: creating campaign B while campaign A is being
 * aborted touches two campaigns and one profile. A per-campaign lock would let
 * those two transactions run side by side, which is precisely the interleaving
 * worth preventing. The profile is also the unit admission already locks, so
 * one profile's work stays serialized end to end while a second profile's runs
 * entirely unimpeded.
 *
 * ## Why transaction-scoped
 *
 * `pg_advisory_xact_lock` is released by COMMIT or ROLLBACK, including the
 * rollback a crashed process's connection gets when the server reaps it. A
 * session lock on a pooled connection outlives the work it was taken for and
 * comes back attached to an unrelated future query -- the classic pitfall this
 * repository avoids everywhere. Every lock here is transaction-scoped, and
 * every caller must therefore already be inside `$transaction`.
 *
 * ## LOCK ORDERING (load-bearing for the admission slice)
 *
 * A transaction that needs both the execution-profile admission lock and this
 * one must take the ADMISSION LOCK FIRST and this one second, always. Two
 * locks taken in opposite orders by two transactions is the only way this
 * subsystem can deadlock, and a fixed global order is what makes that
 * impossible rather than merely unlikely.
 */

/**
 * Namespace for campaign locks.
 *
 * Distinct from every namespace already in use -- 0x11b0, 0x5afe, 0x5afe6,
 * 0x7afe and the retention key -- because a shared namespace would make an
 * unrelated subsystem's profile lock silently exclude a campaign transition
 * that has nothing to do with it.
 */
export const HISTORICAL_FILL_CAMPAIGN_LOCK_NAMESPACE = 0xf111;

/**
 * Take the campaign lock for one profile, for the rest of this transaction.
 *
 * Blocking, not `try`: a caller that gave up on contention would report "no
 * live campaign" or "could not pause" purely because another operator was
 * mid-transaction, and campaign transitions are short, rare and operator-
 * initiated. Waiting is the honest behaviour.
 *
 * The key is `profileLockKey`, reused rather than reimplemented so that the
 * mapping from profile id to lock key has exactly one definition.
 */
export async function lockCampaignForProfile(
  tx: Prisma.TransactionClient,
  executionProfileId: string
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HISTORICAL_FILL_CAMPAIGN_LOCK_NAMESPACE}::int, ${profileLockKey(
    executionProfileId
  )}::int)`;
}
