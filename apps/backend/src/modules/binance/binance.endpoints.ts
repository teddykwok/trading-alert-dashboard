/**
 * The COMPLETE set of Binance USDⓈ-M endpoints this connector may ever call.
 *
 * Phase 2 is strictly read-only, so every entry here is a documented GET
 * endpoint. This connector has no write capability of any kind: order
 * placement, leverage changes, margin-type changes and position-mode changes
 * have no representation here, so they cannot be called from it even by
 * mistake.
 *
 * Writes live in two separate, narrowly scoped modules with their own
 * allowlists and authorization contexts — binance-execution.endpoints.ts
 * (Phase 6/7 trading) and binance-account-setup.endpoints.ts (Phase 10
 * operator maintenance). Keeping them apart is what lets this file stay
 * provably GET-only.
 *
 * Paths follow the current official documentation (v3 account/balance/
 * positionRisk supersede the v1/v2 variants; symbolConfig and accountConfig
 * are the current way to read per-symbol and account-level configuration).
 */

export const READ_ONLY_METHOD = "GET" as const;

export interface BinanceEndpointDefinition {
  readonly path: string;
  /** Signed endpoints get timestamp + recvWindow + HMAC signature. */
  readonly signed: boolean;
  /** Documented IP weight, logged so rate-limit budget stays visible. */
  readonly weight: number;
}

export const BINANCE_READ_ONLY_ENDPOINTS = {
  // --- Public market data ---
  ping: { path: "/fapi/v1/ping", signed: false, weight: 1 },
  serverTime: { path: "/fapi/v1/time", signed: false, weight: 1 },
  exchangeInfo: { path: "/fapi/v1/exchangeInfo", signed: false, weight: 1 },
  // Mark price / funding rate. Public and unsigned, weight 1 with a symbol.
  // The ONLY way to read a mark price before a position exists — positionRisk
  // carries markPrice too, but only for a position that is already open.
  premiumIndex: { path: "/fapi/v1/premiumIndex", signed: false, weight: 1 },

  // --- Signed USER_DATA (read-only) ---
  balance: { path: "/fapi/v3/balance", signed: true, weight: 5 },
  account: { path: "/fapi/v3/account", signed: true, weight: 5 },
  positionRisk: { path: "/fapi/v3/positionRisk", signed: true, weight: 5 },
  positionMode: { path: "/fapi/v1/positionSide/dual", signed: true, weight: 30 },
  multiAssetsMode: { path: "/fapi/v1/multiAssetsMargin", signed: true, weight: 30 },
  accountConfig: { path: "/fapi/v1/accountConfig", signed: true, weight: 5 },
  symbolConfig: { path: "/fapi/v1/symbolConfig", signed: true, weight: 5 },
  openOrders: { path: "/fapi/v1/openOrders", signed: true, weight: 40 },
  // Query Order. GET only — the Phase 6 mutation client owns POST/DELETE on
  // this path and lives in a separate module; this connector still cannot
  // issue anything but GET.
  order: { path: "/fapi/v1/order", signed: true, weight: 1 },
  leverageBracket: { path: "/fapi/v1/leverageBracket", signed: true, weight: 1 },
  // Query Algo Order (Phase 7 protection). GET only — the mutation client
  // owns POST/DELETE on this path from a separate module.
  algoOrder: { path: "/fapi/v1/algoOrder", signed: true, weight: 1 },
  // Current open Algo (conditional) orders, for ONE symbol. Read-only: it is
  // how a baseline proves the conditional book is empty WITHOUT ever reaching
  // for a cancel-all endpoint.
  openAlgoOrders: { path: "/fapi/v1/openAlgoOrders", signed: true, weight: 1 },
  // The SAME path with no symbol, which Binance charges at 40 rather than 1.
  //
  // A separate descriptor rather than a dynamic weight, because the weight is
  // a property of the REQUEST and this table is how the connector states what
  // each request costs. Routing an all-symbols read through the entry above
  // would spend 40 while the budget line said 1 -- the rate-limit equivalent
  // of a silent overdraft. Two names, two honest numbers, one path.
  //
  // It exists because a per-symbol sweep cannot prove the conditional book is
  // EMPTY: it can only prove it empty for the symbols it thought to ask about.
  openAlgoOrdersAccountWide: {
    path: "/fapi/v1/openAlgoOrders",
    signed: true,
    weight: 40,
  },
  // Position margin change history, used only to reconcile an ambiguous ADD.
  positionMarginHistory: { path: "/fapi/v1/positionMargin/history", signed: true, weight: 1 },
  // --- Historical evidence, used ONLY to prove absence -------------------
  // A point-in-time Query Order answers about an id Binance still retains.
  // Proving an entry NEVER existed additionally needs the symbol's order and
  // trade history: without them, 'not found now' cannot be distinguished
  // from 'existed and aged out'. Both are GET, both signed, both read-only.
  allOrders: { path: "/fapi/v1/allOrders", signed: true, weight: 5 },
  userTrades: { path: "/fapi/v1/userTrades", signed: true, weight: 5 },
} as const satisfies Record<string, BinanceEndpointDefinition>;

export type BinanceEndpointName = keyof typeof BINANCE_READ_ONLY_ENDPOINTS;

const ALLOWED_PATHS: ReadonlySet<string> = new Set(
  Object.values(BINANCE_READ_ONLY_ENDPOINTS).map((endpoint) => endpoint.path)
);

/** Every HTTP verb that could mutate exchange state. */
export const FORBIDDEN_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

export function isAllowedReadOnlyPath(path: string): boolean {
  return ALLOWED_PATHS.has(path);
}

export function allowedReadOnlyPaths(): string[] {
  return [...ALLOWED_PATHS].sort();
}
