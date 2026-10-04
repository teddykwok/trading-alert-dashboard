import { NATIVE_PLAN_ACCOUNTS, parseNativeAccountPlanPolicy, type NativeAccountPlanPolicy, type NativePlanAccount } from "@trading-alert-dashboard/shared";

/**
 * Per-account DEFAULT Native plan lookback — a read-only policy overlay.
 *
 * Each account's preference is its own configured value
 * (NATIVE_PLAN_DEFAULT_LOOKBACK_A / _B on the generic process). Absent or empty
 * is UNSET and stays UNSET: nothing is guessed. Anything other than exactly
 * 50 / 100 / 200 / 300 is INVALID and resolves no lookback.
 *
 * It never writes and never reads the plan's global `selectedLookback`: two
 * accounts may resolve different windows for the same alert without anything
 * being flipped back and forth. It creates no adoption and grants nothing —
 * Native execution stays hard-disabled.
 */

export type NativeAccountPlanPolicySource = Partial<Record<NativePlanAccount, string | undefined>>;

export function resolveNativeAccountPlanPolicies(source: NativeAccountPlanPolicySource): NativeAccountPlanPolicy[] {
  return NATIVE_PLAN_ACCOUNTS.map((account) => parseNativeAccountPlanPolicy(account, source[account]));
}

/** The generic process's configured preferences. */
export async function configuredNativeAccountPlanPolicies(): Promise<NativeAccountPlanPolicy[]> {
  const { env } = await import("../../config/env");
  return resolveNativeAccountPlanPolicies({ A: env.NATIVE_PLAN_DEFAULT_LOOKBACK_A, B: env.NATIVE_PLAN_DEFAULT_LOOKBACK_B });
}
