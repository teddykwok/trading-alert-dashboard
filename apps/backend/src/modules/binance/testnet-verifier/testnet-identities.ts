import { randomBytes } from "node:crypto";
import {
  BINANCE_CLIENT_ORDER_ID_PATTERN,
  buildClientOrderId,
} from "../../execution/execution-safety";

/**
 * Deterministic identities for one verifier run.
 *
 * OWNERSHIP IS PROVEN BY DERIVATION, NOT BY PREFIX. Every mutating identity is
 * `buildClientOrderId(syntheticExecutionId, role, generation)` where the
 * synthetic execution id is derived from a single persisted `runId`. A resumed
 * run reloads that runId and recomputes byte-identical ids; anything the
 * verifier did not derive this way is, by definition, not its to touch.
 *
 * Prefix scanning is deliberately never used to establish ownership — a shared
 * prefix is one collision away from cancelling somebody else's order.
 */

/** Bumped whenever the persisted state shape or identity derivation changes. */
export const TESTNET_VERIFIER_VERSION = "20B.1";

/**
 * Namespace for the synthetic execution id. Production execution ids are
 * cuids, so a `tadverify-` prefixed id can never be one — the two id spaces
 * cannot intersect even before the SHA-256 digest is taken.
 */
const SYNTHETIC_EXECUTION_PREFIX = "tadverify";

export type VerifierRole = "ENTRY" | "STOP_LOSS" | "TAKE_PROFIT" | "EMERGENCY_CLOSE";

export interface VerifierIdentities {
  readonly runId: string;
  /** Hash input only. Never written to any database. */
  readonly syntheticExecutionId: string;
  readonly entryClientOrderId: string;
  readonly stopClientAlgoId: string;
  readonly takeProfitClientAlgoId: string;
  readonly emergencyClientOrderId: string;
  /** For the read-only capability probe; never submitted. */
  readonly probeClientAlgoId: string;
}

/** 12 lowercase hex characters. Short enough to keep every derived id ≤ 36. */
export function generateRunId(random: () => Buffer = () => randomBytes(6)): string {
  return random().toString("hex").slice(0, 12);
}

export function isValidRunId(runId: string): boolean {
  return /^[0-9a-f]{12}$/.test(runId);
}

/**
 * An id that CANNOT correspond to any real order, for the signed capability
 * probe. It is clearly verifier-owned, satisfies Binance's clientAlgoId
 * syntax, stays under the 36-character limit, and is stable for the run so a
 * repeated probe asks about the same absent identity.
 *
 * It deliberately does NOT use the production `tad-` shape: nothing is ever
 * submitted under it, so it should not look like a submittable identity.
 */
export function buildProbeClientAlgoId(runId: string): string {
  const id = `tadverify-probe-${runId}`;
  if (!BINANCE_CLIENT_ORDER_ID_PATTERN.test(id)) {
    throw new Error("Probe clientAlgoId does not satisfy the Binance format.");
  }
  return id;
}

/**
 * Derives every identity for a run. Pure and total: the same runId always
 * yields the same set, which is what makes crash recovery safe.
 */
export function deriveIdentities(runId: string): VerifierIdentities {
  if (!isValidRunId(runId)) {
    throw new Error(`Invalid verifier runId "${runId}": expected 12 lowercase hex characters.`);
  }

  const syntheticExecutionId = `${SYNTHETIC_EXECUTION_PREFIX}-${runId}`;

  return {
    runId,
    syntheticExecutionId,
    // The SAME production builder the real lifecycle uses, so the ids the
    // exchange sees have exactly the production shape.
    entryClientOrderId: buildClientOrderId(syntheticExecutionId, "ENTRY", 1),
    stopClientAlgoId: buildClientOrderId(syntheticExecutionId, "STOP_LOSS", 1),
    takeProfitClientAlgoId: buildClientOrderId(syntheticExecutionId, "TAKE_PROFIT", 1),
    emergencyClientOrderId: buildClientOrderId(syntheticExecutionId, "EMERGENCY_CLOSE", 1),
    probeClientAlgoId: buildProbeClientAlgoId(runId),
  };
}

/**
 * True only for an identity this run derived. The cleanup paths consult this
 * before every cancel and every close — it is the last line of defence against
 * touching state the verifier does not own.
 */
export function ownsIdentity(identities: VerifierIdentities, candidate: string): boolean {
  return (
    candidate === identities.entryClientOrderId ||
    candidate === identities.stopClientAlgoId ||
    candidate === identities.takeProfitClientAlgoId ||
    candidate === identities.emergencyClientOrderId
  );
}
