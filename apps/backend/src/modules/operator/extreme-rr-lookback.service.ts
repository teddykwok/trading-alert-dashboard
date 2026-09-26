import type { PrismaClient } from "@prisma/client";
import {
  EXTREME_RR_LOOKBACKS,
  isExtremeRRLookback,
  type ExtremeRRLookback,
} from "@trading-alert-dashboard/shared";

import { CANARY_PREPARE_LOCK_NAMESPACE } from "../execution/canary-authorization.service";
import { TOTAL_ACTIVE_STATUSES } from "../execution/capacity-status";
import { isNaturalWindowAvailable } from "../execution/natural-authorization";
import { profileLockKey } from "../execution/profile-lock";
import { env } from "../../config/env";

/**
 * Operator management of the durable Extreme RR lookback policy.
 *
 * ## What this value is, and what it is NOT
 *
 * It is the INITIAL `selectedLookback` for a NEW plan — nothing else. Every
 * supported lookback is still calculated and frozen on every plan from one
 * candle dataset, and the per-alert planner can still switch between them
 * afterwards. So this policy:
 *
 *   - never reaches a plan that already exists (their `selectedLookback` is
 *     persisted per row and the regeneration upsert does not write it);
 *   - never reaches an execution (`TradeExecution.selectedLookback` and the
 *     frozen candidate snapshot are written once, at creation);
 *   - is never consulted by protection or reconciliation.
 *
 * Guarded on the SAME durable facts as the symbol allowlist and the source
 * timeframe filter, through the same advisory-lock namespace, because it is the
 * same class of change: which numbers a future trade will be built from.
 */

/**
 * Everything this control can refuse with.
 *
 * Phase 11F trimmed it. The SAFE_OFF / active-execution / manual-intervention
 * / authorization codes described a WRITE that no longer exists: the window is
 * global deployment configuration now, so every save is refused outright.
 * Keeping codes nothing can return would be a vocabulary that lies about what
 * the endpoint does.
 */
export const RR_LOOKBACK_BLOCKERS = [
  "VALIDATION_REFUSED",
  "DEPLOYMENT_OWNED",
] as const;

export type RrLookbackBlocker = (typeof RR_LOOKBACK_BLOCKERS)[number];

export interface RrLookbackReadResult {
  /** Exactly what the durable column holds, unmodified. */
  stored: number;
  /** The value planning will actually use; null when the stored one is invalid. */
  effective: ExtremeRRLookback | null;
  /** False when the stored value is not one of the supported lookbacks. */
  valid: boolean;
  /** The full vocabulary, so the panel need not hardcode it. */
  supported: number[];
}

export interface RrLookbackSaveResult {
  ok: boolean;
  outcome: "SAVED" | "BLOCKED";
  blockers: string[];
  message: string;
  /** Present on success; the durable policy as it now stands. */
  extremeRrLookbackCandles: number | null;
}

function refusal(blockers: RrLookbackBlocker[], message: string): RrLookbackSaveResult {
  return { ok: false, outcome: "BLOCKED", blockers, message, extremeRrLookbackCandles: null };
}

/**
 * Judges a stored value without repairing it.
 *
 * A row that does not name a supported lookback is INVALID configuration, and
 * saying so is the whole job. Coercing it to 300 here would be the one failure
 * this control exists to prevent: silently planning a trade against a window
 * nobody selected.
 */
export function describeStoredLookback(stored: unknown): RrLookbackReadResult {
  const valid = isExtremeRRLookback(stored);
  return {
    stored: typeof stored === "number" ? stored : Number.NaN,
    effective: valid ? stored : null,
    valid,
    supported: [...EXTREME_RR_LOOKBACKS],
  };
}

/**
 * Phase 11F -- the lookback this reports is GLOBAL deployment configuration.
 *
 * It used to live on the configured ExecutionProfile's safety policy, and
 * this service both read and wrote it. That was wrong once 11E made a plan
 * GLOBAL: one ExtremeRRPlan is generated per alert and adopted independently
 * by every account, so an input owned by one account shaped a plan another
 * account would also trade.
 *
 * The read now reports what actually governs generation. The write refuses,
 * because a control that succeeded while changing a value nothing reads is
 * worse than no control at all -- it would report success and do nothing.
 */
/** The configuration key that actually governs plan generation. */
export const GLOBAL_LOOKBACK_CONFIG_KEY = "EXTREME_RR_LOOKBACK_CANDLES";

export class ExtremeRrLookbackService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The window in force. Read-only, so it stays available while ARMED — the
   * operator must be able to SEE what governs new planning.
   *
   * Phase 11F: read from GLOBAL configuration, the same value the generic
   * plan-generation path reads. No profile, no database.
   */
  async read(): Promise<RrLookbackReadResult> {
    return describeStoredLookback(env.EXTREME_RR_LOOKBACK_CANDLES);
  }

  /**
   * Phase 11F: the lookback is no longer operator-writable, and this says so.
   *
   * It moved to deployment configuration because the plan it shapes is global
   * and the value used to belong to one account's profile. Writing that column
   * would now change nothing any generator reads, so this refuses rather than
   * reporting a success that has no effect. The refusal shape is unchanged, so
   * the existing operator panel renders the reason it already knows how to
   * render.
   *
   * An unsupported value is still rejected FIRST: an operator who typed a
   * number outside the vocabulary should be told that, not told about
   * deployment ownership.
   */
  async save(raw: unknown): Promise<RrLookbackSaveResult> {
    if (!isExtremeRRLookback(raw)) {
      return refusal(
        ["VALIDATION_REFUSED"],
        `An Extreme RR lookback must be one of ${EXTREME_RR_LOOKBACKS.join(", ")}.`
      );
    }
    return refusal(
      ["DEPLOYMENT_OWNED"],
      "The Extreme RR lookback is GLOBAL deployment configuration " +
        `(${GLOBAL_LOOKBACK_CONFIG_KEY}) and is no longer editable here. One plan is ` +
        "generated per alert and adopted independently by every account, so the " +
        "window that shapes it cannot belong to one account's profile. Change it " +
        "in the deployment configuration and restart the generic runtimes."
    );
  }

}
