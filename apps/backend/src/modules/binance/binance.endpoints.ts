/**
 * The COMPLETE set of Binance USDⓈ-M endpoints this connector may ever call.
 *
 * Phase 2 is strictly read-only, so every entry here is a documented GET
 * endpoint. There is deliberately no table of write endpoints anywhere in the
 * codebase: order placement, leverage changes, margin-type changes and
 * position-mode changes simply have no representation, so they cannot be
 * called even by mistake.
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
  // Position margin change history, used only to reconcile an ambiguous ADD.
  positionMarginHistory: { path: "/fapi/v1/positionMargin/history", signed: true, weight: 1 },
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
