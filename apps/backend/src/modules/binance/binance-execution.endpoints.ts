/**
 * The COMPLETE set of Binance USDⓈ-M MUTATION endpoints this repository may
 * ever call — Phase 6, LIMIT entry lifecycle only.
 *
 * Nothing outside this table is reachable from the EXECUTION client, so the
 * following are structurally impossible here rather than merely discouraged:
 * position-mode changes, multi-assets-mode changes
 * (/fapi/v1/multiAssetsMargin), batch orders (/fapi/v1/batchOrders), order
 * modification (/fapi/v1/order PUT), cancel-all (/fapi/v1/allOpenOrders),
 * countdown cancel, test orders, and every transfer endpoint.
 *
 * Position mode and test orders ARE representable elsewhere in the repository —
 * Phase 10 owns them in binance-account-setup.endpoints.ts, a separate table
 * with its own operator gates and its own authorization contexts. They are
 * deliberately not reachable from an execution code path.
 *
 * Protection orders (STOP_MARKET / TAKE_PROFIT_MARKET) and MARKET entries are
 * Phase 7+ concerns: they would use POST /fapi/v1/order, which IS listed here,
 * so the order TYPE is separately allowlisted by the client itself.
 */

export interface BinanceMutationEndpointDefinition {
  readonly path: string;
  readonly method: "POST" | "DELETE";
  /** Every mutation endpoint is signed USER_DATA / TRADE. */
  readonly signed: true;
  /** Documented IP weight, so the rate-limit budget stays visible. */
  readonly weight: number;
}

export const BINANCE_MUTATION_ENDPOINTS = {
  setMarginType: { path: "/fapi/v1/marginType", method: "POST", signed: true, weight: 1 },
  setLeverage: { path: "/fapi/v1/leverage", method: "POST", signed: true, weight: 1 },
  newOrder: { path: "/fapi/v1/order", method: "POST", signed: true, weight: 0 },
  cancelOrder: { path: "/fapi/v1/order", method: "DELETE", signed: true, weight: 1 },
  // --- Phase 7 ---
  // Conditional (Algo) protection. Current USDⓈ-M protection uses the Algo
  // Order API, not a legacy standard-order workflow.
  newAlgoOrder: { path: "/fapi/v1/algoOrder", method: "POST", signed: true, weight: 1 },
  cancelAlgoOrder: { path: "/fapi/v1/algoOrder", method: "DELETE", signed: true, weight: 1 },
  // ADD isolated margin only (type=1). Removal has no representation.
  addPositionMargin: { path: "/fapi/v1/positionMargin", method: "POST", signed: true, weight: 1 },
} as const satisfies Record<string, BinanceMutationEndpointDefinition>;

/** The only conditional order types Phase 7 may submit. */
export const ALLOWED_PROTECTION_ORDER_TYPES = ["STOP_MARKET", "TAKE_PROFIT_MARKET"] as const;
export type ProtectionOrderType = (typeof ALLOWED_PROTECTION_ORDER_TYPES)[number];

/** The only algoType Phase 7 may submit. */
export const ALLOWED_ALGO_TYPE = "CONDITIONAL" as const;

/** The only isolated-margin adjustment type: 1 = ADD. 2 (REMOVE) is refused. */
export const MARGIN_ADD_TYPE = 1 as const;

/** Parameters that must never appear on a Phase 7 protection order. */
export const FORBIDDEN_PROTECTION_PARAMS = [
  "reduceOnly",
  // The Algo Order endpoint's trigger field is `triggerPrice`. `stopPrice`
  // belongs to the legacy standard-order endpoint and is refused here, so a
  // regression back to it fails structurally rather than at the exchange.
  "stopPrice",
  "price",
  "priceMatch",
  "activationPrice",
  "callbackRate",
  "goodTillDate",
  "timeInForce",
] as const;

export type BinanceMutationEndpointName = keyof typeof BINANCE_MUTATION_ENDPOINTS;

/** Exact (method, path) pairs. A path alone is never sufficient. */
const ALLOWED_PAIRS: ReadonlySet<string> = new Set(
  Object.values(BINANCE_MUTATION_ENDPOINTS).map((endpoint) => `${endpoint.method} ${endpoint.path}`)
);

/**
 * The ONLY order type Phase 6 may submit. A protection or MARKET order would
 * travel the same POST /fapi/v1/order path, so the type is gated separately.
 */
export const ALLOWED_ENTRY_ORDER_TYPE = "LIMIT" as const;
export const ALLOWED_ENTRY_TIME_IN_FORCE = "GTC" as const;

/** Parameters that must never appear on a Phase 6 entry request. */
export const FORBIDDEN_ENTRY_PARAMS = [
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

export function isAllowedMutation(method: string, path: string): boolean {
  return ALLOWED_PAIRS.has(`${method} ${path}`);
}

export function allowedMutationPairs(): string[] {
  return [...ALLOWED_PAIRS].sort();
}
