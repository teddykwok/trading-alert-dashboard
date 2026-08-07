/**
 * Phase 10 — the COMPLETE set of Binance USDⓈ-M endpoints available to OPERATOR
 * MAINTENANCE. Exactly two entries, and nothing else has a representation here.
 *
 * Deliberately a separate table from the Phase 6/7 execution allowlist
 * (binance-execution.endpoints.ts). The three surfaces stay distinguishable:
 *
 *   Phase 6  execution        marginType, leverage, new order, cancel order
 *   Phase 7  risk-reducing    algo protection, cancel protection, add margin
 *   Phase 10 maintenance      position mode (HEDGE only), test order
 *
 * A path appearing here does NOT mean any caller may use it. Authorization is
 * operation-specific: each method below demands a module-private branded
 * context that can only be minted after its own preflight succeeds.
 *
 * Still structurally impossible everywhere in this repository: multi-assets
 * mode changes (/fapi/v1/multiAssetsMargin POST), batch orders, order
 * modification, cancel-all, countdown cancel, every transfer endpoint, every
 * withdrawal endpoint and every API-key-management endpoint.
 */

export interface BinanceAccountSetupEndpointDefinition {
  readonly path: string;
  readonly method: "POST";
  readonly signed: true;
  /** Documented IP weight, so the rate-limit budget stays visible. */
  readonly weight: number;
}

export const BINANCE_ACCOUNT_SETUP_ENDPOINTS = {
  /**
   * Change Position Mode. Account-wide for USDⓈ-M futures — it is NOT
   * per-symbol, which is why the preflight has to inspect the whole account.
   * Documented parameter: dualSidePosition ("true" | "false").
   */
  setPositionMode: { path: "/fapi/v1/positionSide/dual", method: "POST", signed: true, weight: 1 },
  /**
   * Test New Order. Binance validates the request and returns without ever
   * touching the order book: no order is created, nothing can fill. Distinct
   * path from POST /fapi/v1/order, which is NOT reachable from this module.
   */
  testOrder: { path: "/fapi/v1/order/test", method: "POST", signed: true, weight: 0 },
} as const satisfies Record<string, BinanceAccountSetupEndpointDefinition>;

export type BinanceAccountSetupEndpointName = keyof typeof BINANCE_ACCOUNT_SETUP_ENDPOINTS;

/**
 * The ONLY position mode this repository can request. One-way has no
 * representation anywhere: there is no constant for it, no parameter path that
 * produces it, and no method that accepts a mode argument.
 */
export const ALLOWED_POSITION_MODE_PARAM = "true" as const;

/** Phase 10 test orders are LIMIT/GTC only — no MARKET, no conditional type. */
export const ALLOWED_TEST_ORDER_TYPE = "LIMIT" as const;
export const ALLOWED_TEST_ORDER_TIME_IN_FORCE = "GTC" as const;

/**
 * Prefix for the deterministic test-order client id. Clearly distinct from the
 * live `tad-en-*` / `tad-sl-*` / `tad-tp-*` / `tad-ec-*` execution namespace,
 * so a Phase 10 validation request can never be mistaken for — or collide
 * with — a real reserved entry.
 */
export const TEST_ORDER_CLIENT_ID_PREFIX = "tadtest" as const;

/** Parameters that must never appear on a Phase 10 test order. */
export const FORBIDDEN_TEST_ORDER_PARAMS = [
  "reduceOnly",
  "closePosition",
  "stopPrice",
  "activationPrice",
  "callbackRate",
  "priceMatch",
  "goodTillDate",
  "workingType",
  "priceProtect",
  "selfTradePreventionMode",
] as const;

/** Exact (method, path) pairs. A path alone is never sufficient. */
const ALLOWED_PAIRS: ReadonlySet<string> = new Set(
  Object.values(BINANCE_ACCOUNT_SETUP_ENDPOINTS).map((endpoint) => `${endpoint.method} ${endpoint.path}`)
);

export function isAllowedAccountSetupMutation(method: string, path: string): boolean {
  return ALLOWED_PAIRS.has(`${method} ${path}`);
}

export function allowedAccountSetupPairs(): string[] {
  return [...ALLOWED_PAIRS].sort();
}
