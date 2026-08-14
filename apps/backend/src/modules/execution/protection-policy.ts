/**
 * The ONE definition of role-specific protection policy.
 *
 * A stop and a take profit do NOT trigger on the same price feed: a stop uses
 * MARK_PRICE so a thin-book wick cannot fire it, while a take profit uses the
 * traded CONTRACT_PRICE. That rule used to live inline in the protection
 * service AND, by omission, nowhere at all in the Phase 20 demo verifier —
 * which submitted MARK_PRICE for both. Since `workingType` is a field the
 * production identity comparator judges, the demo run was therefore never
 * exercising the real TAKE_PROFIT identity.
 *
 * This module has NO imports on purpose. It is safe for `config/env` to depend
 * on (so the schema defaults and this file cannot drift apart) and safe for the
 * testnet verifier to depend on (which must never import `config/env`).
 */

export const PROTECTION_WORKING_TYPES = ["MARK_PRICE", "CONTRACT_PRICE"] as const;
export type ProtectionWorkingTypeName = (typeof PROTECTION_WORKING_TYPES)[number];

export type ProtectionRoleName = "STOP_LOSS" | "TAKE_PROFIT";

/** Declared once here and referenced by the env schema — never re-typed. */
export const DEFAULT_STOP_WORKING_TYPE: ProtectionWorkingTypeName = "MARK_PRICE";
export const DEFAULT_TAKE_PROFIT_WORKING_TYPE: ProtectionWorkingTypeName = "CONTRACT_PRICE";
export const DEFAULT_PROTECTION_PRICE_PROTECT = false;

export interface ProtectionPolicy {
  readonly stopWorkingType: ProtectionWorkingTypeName;
  readonly takeProfitWorkingType: ProtectionWorkingTypeName;
  readonly priceProtect: boolean;
}

/**
 * The role → workingType rule. Every caller — production submission,
 * production intent persistence and the demo verifier — resolves through this
 * one function, so none of them can disagree about what a role should send.
 */
export function protectionWorkingType(role: ProtectionRoleName, policy: ProtectionPolicy): ProtectionWorkingTypeName {
  return role === "STOP_LOSS" ? policy.stopWorkingType : policy.takeProfitWorkingType;
}

function parseWorkingType(
  raw: string | undefined,
  fallback: ProtectionWorkingTypeName,
  name: string
): ProtectionWorkingTypeName {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim();
  if (!(PROTECTION_WORKING_TYPES as readonly string[]).includes(value)) {
    // Mirrors the env schema: an explicit but invalid value is a
    // misconfiguration, never something to silently default away.
    throw new Error(`${name} must be one of ${PROTECTION_WORKING_TYPES.join(", ")} (got "${value}").`);
  }
  return value as ProtectionWorkingTypeName;
}

/**
 * Reads the policy out of a raw environment record, applying exactly the same
 * names, defaults and strictness as the env schema.
 *
 * Takes the record as an argument rather than reading `process.env` itself, so
 * it stays pure and so the verifier can resolve production policy without
 * importing the production `env` module.
 */
export function resolveProtectionPolicy(raw: {
  EXECUTION_SL_WORKING_TYPE?: string;
  EXECUTION_TP_WORKING_TYPE?: string;
  EXECUTION_PROTECTION_PRICE_PROTECT?: string;
}): ProtectionPolicy {
  const priceProtectRaw = raw.EXECUTION_PROTECTION_PRICE_PROTECT?.trim();
  if (priceProtectRaw !== undefined && priceProtectRaw !== "" && priceProtectRaw !== "true" && priceProtectRaw !== "false") {
    throw new Error(`EXECUTION_PROTECTION_PRICE_PROTECT must be "true" or "false" (got "${priceProtectRaw}").`);
  }

  return {
    stopWorkingType: parseWorkingType(raw.EXECUTION_SL_WORKING_TYPE, DEFAULT_STOP_WORKING_TYPE, "EXECUTION_SL_WORKING_TYPE"),
    takeProfitWorkingType: parseWorkingType(
      raw.EXECUTION_TP_WORKING_TYPE,
      DEFAULT_TAKE_PROFIT_WORKING_TYPE,
      "EXECUTION_TP_WORKING_TYPE"
    ),
    priceProtect:
      priceProtectRaw === undefined || priceProtectRaw === ""
        ? DEFAULT_PROTECTION_PRICE_PROTECT
        : priceProtectRaw === "true",
  };
}
