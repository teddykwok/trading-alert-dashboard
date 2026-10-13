/**
 * THE NATIVE EXECUTION SWITCH. False, in code.
 *
 * A Native (scanner-produced) alert may be planned, shown and judged, and the
 * Account A canary path is built end to end, but nothing may turn a Native
 * alert into an exchange request while this is false. It is a compile-time
 * constant on purpose:
 *
 *  - no environment variable, profile, policy row, request, UI control or
 *    operator command can change it. Flipping it is a reviewed code change;
 *  - every Native fence reads it HERE, at its own call site: the adoption-time
 *    decision, the executor before its first signed request, and the entry
 *    lifecycle immediately before every exposure-increasing exchange call.
 *    No caller passes it in, so no caller can hand a fence `true`.
 *
 * TradingView execution never reads it and is unaffected by it.
 */
export const NATIVE_EXECUTION_ENABLED = false as const;
