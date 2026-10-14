/**
 * THE NATIVE RISK CONTRACTS. UNRESOLVED, in code, for both accounts.
 *
 * How much ONE Native trade may plan to lose is an operator decision that has
 * not been made. Until it is, Native execution has no approved risk, and the
 * Native risk gate (native-risk-gate.ts) refuses every Native candidate with
 * NATIVE_RISK_UNRESOLVED before any private exchange request.
 *
 * This file deliberately holds no amount: no dollar value, no percentage, no
 * default and no fallback. And nothing outside it can resolve a contract:
 *
 *  - no environment variable, environment file (generic, account-a.env,
 *    account-b.env), execution profile, safety-policy row, risk template,
 *    request, UI control or operator command is read here, or anywhere a
 *    contract is looked up;
 *  - the Native planner windows (Account A 100 candles, Account B 300 candles)
 *    are LOOKBACK candle counts. They are never money and are not consulted;
 *  - the risk template every plan is sized with today (referenceCapital x
 *    riskPercent, configured for TradingView) is NOT a Native risk contract. A
 *    Native plan still carries that frozen snapshot as its sizing input; this
 *    contract is the separate, explicit Native approval the snapshot must be
 *    checked against.
 *
 * Resolving a contract is a reviewed code change to THIS table. It is a
 * financial choice for the operator, not something any code path infers.
 *
 * TradingView execution never reads it and is unaffected by it.
 */

export type NativeRiskAccount = "A" | "B";

export type NativeRiskContract =
  | { readonly state: "UNRESOLVED"; readonly account: NativeRiskAccount; readonly reason: string }
  | {
      readonly state: "RESOLVED";
      readonly account: NativeRiskAccount;
      /** The most ONE Native trade may plan to lose, in USDT, as an exact decimal string. */
      readonly maxRiskPerTradeUsd: string;
    };

export const NATIVE_RISK_CONTRACTS: Readonly<Record<NativeRiskAccount, NativeRiskContract>> = Object.freeze({
  A: Object.freeze({ state: "UNRESOLVED", account: "A", reason: "No Native risk amount has been approved for Account A." }),
  B: Object.freeze({ state: "UNRESOLVED", account: "B", reason: "No Native risk amount has been approved for Account B." }),
});
