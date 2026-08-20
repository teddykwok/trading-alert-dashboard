import { createHash } from "node:crypto";

/**
 * The per-profile PostgreSQL advisory-lock key, in its own module.
 *
 * It lived on `safety-admission.service.ts` and is still re-exported from
 * there, so every existing import keeps working. It moved because Phase 12.3
 * made admission read the authorization table: `safety-admission.service` now
 * imports the natural claim from `canary-authorization.service`, which already
 * imported this key back from `safety-admission.service`. That is an import
 * cycle, and the honest fix is to give the shared leaf its own home rather than
 * rely on the two modules happening to resolve in the right order.
 *
 * Nothing about the key itself changed, so every lock taken before and after
 * this move hashes to the same number.
 */

/** Stable 32-bit key derived from the profile id for pg_advisory_xact_lock. */
export function profileLockKey(executionProfileId: string): number {
  const digest = createHash("sha256").update(executionProfileId).digest();
  // Signed 32-bit: Postgres advisory lock keys are int4.
  return digest.readInt32BE(0);
}
