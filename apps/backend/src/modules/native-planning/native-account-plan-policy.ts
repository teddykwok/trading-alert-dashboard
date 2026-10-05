import { NATIVE_PLAN_ACCOUNTS, parseNativeAccountPlanPolicy, type NativeAccountPlanPolicy, type NativePlanAccount } from "@trading-alert-dashboard/shared";

/**
 * Per-account DEFAULT Native plan lookback — a read-only policy overlay.
 *
 * Each account resolves its own window: the user-approved built-in default
 * (Account A 100, Account B 300 -- NATIVE_PLAN_BUILTIN_DEFAULTS) unless the
 * generic process sets an explicit override (NATIVE_PLAN_DEFAULT_LOOKBACK_A /
 * _B). A valid override (exactly 50 / 100 / 200 / 300) wins; any other explicit
 * value is INVALID and resolves no lookback -- it never falls back to the
 * built-in default, so a mistyped override fails visibly.
 *
 * It never writes and never reads the plan's global `selectedLookback`: two
 * accounts may resolve different windows for the same alert without anything
 * being flipped back and forth. It creates no adoption and grants nothing —
 * Native execution stays hard-disabled.
 */

/** The optional explicit overrides, raw. */
export type NativeAccountPlanOverrides = Partial<Record<NativePlanAccount, string | undefined>>;

export function resolveNativeAccountPlanPolicies(source: NativeAccountPlanOverrides): NativeAccountPlanPolicy[] {
  return NATIVE_PLAN_ACCOUNTS.map((account) => parseNativeAccountPlanPolicy(account, source[account]));
}

/** The generic process's configured preferences. */
export async function configuredNativeAccountPlanPolicies(): Promise<NativeAccountPlanPolicy[]> {
  const { env } = await import("../../config/env");
  return resolveNativeAccountPlanPolicies({ A: env.NATIVE_PLAN_DEFAULT_LOOKBACK_A, B: env.NATIVE_PLAN_DEFAULT_LOOKBACK_B });
}
