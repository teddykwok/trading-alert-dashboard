import { Prisma } from "@prisma/client";

import type { NativeAccountSlot } from "./native-account-a-canary";
import { NATIVE_RISK_CONTRACTS, type NativeRiskAccount, type NativeRiskContract } from "./native-risk-contract";

/**
 * THE NATIVE RISK GATE: a Native trade may proceed only when an explicit
 * Native risk contract for THIS account admits the risk the trade was sized
 * with. Today both contracts are UNRESOLVED (native-risk-contract.ts), so it
 * refuses every Native candidate.
 *
 * It is a CAP, not a sizing rule. The trade's risk budget still comes from the
 * plan's own frozen risk-template snapshot, exactly as for TradingView, and
 * nothing here resizes, rounds or replaces it. The gate only answers whether
 * that budget is within what the operator approved for Native execution, and
 * refuses when it is not, or when nothing was approved.
 *
 * Pure: no database, no file, no network, no clock and no environment. The
 * contract is read from the code-fixed table at the call site's request,
 * keyed by the account this process proved it is; no caller passes a
 * contract in, so no caller can hand the gate a RESOLVED one.
 *
 * Where it is asked (always after the hard switch, which still wins while it
 * is false): the adoption-time decision, the executor before the margin
 * planner's signed reads, and the entry lifecycle before revalidation, before
 * configuration and immediately before every exposure-increasing call.
 */

export const NATIVE_RISK_REFUSAL_CODES = ["NATIVE_RISK_UNRESOLVED", "NATIVE_RISK_BUDGET_INVALID", "NATIVE_RISK_EXCEEDS_CONTRACT"] as const;
export type NativeRiskRefusalCode = (typeof NATIVE_RISK_REFUSAL_CODES)[number];

export type NativeRiskReadiness =
  | { readonly ready: true; readonly account: NativeRiskAccount; readonly riskBudgetUsd: string; readonly maxRiskPerTradeUsd: string }
  | { readonly ready: false; readonly reasonCode: NativeRiskRefusalCode; readonly message: string };

/** Exact positive decimals only: digits, at most one point, no sign, exponent, padding or zero. */
const EXACT_DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

function exactPositiveDecimal(value: unknown): InstanceType<typeof Prisma.Decimal> | null {
  if (typeof value !== "string" || !EXACT_DECIMAL.test(value)) return null;
  const parsed = new Prisma.Decimal(value);
  return parsed.isFinite() && parsed.greaterThan(0) ? parsed : null;
}

function refuse(reasonCode: NativeRiskRefusalCode, message: string): NativeRiskReadiness {
  return { ready: false, reasonCode, message };
}

/**
 * The judgment, for a contract already in hand. Production code reaches it
 * only through `judgeNativeRiskReadiness`, which supplies the code-fixed
 * contract; tests may hand it a synthetic one.
 */
export function evaluateNativeRiskContract(
  contract: NativeRiskContract | null,
  account: NativeRiskAccount | null,
  riskBudgetUsd: unknown
): NativeRiskReadiness {
  if (contract === null || account === null) {
    return refuse("NATIVE_RISK_UNRESOLVED", "This process is not proven to be Account A or Account B, so no Native risk contract applies.");
  }
  if (contract.account !== account) {
    return refuse("NATIVE_RISK_UNRESOLVED", `The Native risk contract offered belongs to account ${String(contract.account)}, not ${account}.`);
  }
  if (contract.state !== "RESOLVED") {
    const reason = contract.state === "UNRESOLVED" ? contract.reason : `Unknown contract state ${JSON.stringify((contract as { state?: unknown }).state ?? null)}.`;
    return refuse("NATIVE_RISK_UNRESOLVED", `Native risk for Account ${account} is UNRESOLVED: ${reason} No exchange request was made.`);
  }
  const cap = exactPositiveDecimal(contract.maxRiskPerTradeUsd);
  if (cap === null) {
    return refuse("NATIVE_RISK_UNRESOLVED", `Account ${account}'s Native risk contract carries no exact positive USDT amount, so it resolves nothing.`);
  }
  const budget = exactPositiveDecimal(riskBudgetUsd);
  if (budget === null) {
    return refuse("NATIVE_RISK_BUDGET_INVALID", "The trade's risk budget is not an exact positive USDT decimal; nothing can be compared against the contract.");
  }
  if (budget.greaterThan(cap)) {
    return refuse(
      "NATIVE_RISK_EXCEEDS_CONTRACT",
      `The trade is sized to risk ${String(riskBudgetUsd)} USDT, above the ${contract.maxRiskPerTradeUsd} USDT Account ${account} approved for one Native trade.`
    );
  }
  return { ready: true, account, riskBudgetUsd: String(riskBudgetUsd), maxRiskPerTradeUsd: contract.maxRiskPerTradeUsd };
}

/** The account a process slot names. Generic and unproven processes have none. */
function riskAccountOf(slot: NativeAccountSlot): NativeRiskAccount | null {
  if (slot === "ACCOUNT_A") return "A";
  if (slot === "ACCOUNT_B") return "B";
  return null;
}

/**
 * The gate every production call site asks: the code-fixed contract for the
 * account this process is, judged against the risk budget the trade would use.
 */
export function judgeNativeRiskReadiness(accountSlot: NativeAccountSlot, riskBudgetUsd: unknown): NativeRiskReadiness {
  const account = riskAccountOf(accountSlot);
  return evaluateNativeRiskContract(account === null ? null : NATIVE_RISK_CONTRACTS[account], account, riskBudgetUsd);
}
