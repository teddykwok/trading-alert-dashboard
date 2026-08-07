import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_READINESS_CODES,
  CONNECTION_READINESS_STATES,
  evaluateConnectionReadiness,
  evaluateReadiness,
  evaluateTestOrderOutcome,
  validateTestOrderAgainstFilters,
} from "../src/modules/binance/binance-account-connection";
import {
  BinanceAccountSetupClient,
  BinanceAccountSetupDisabledError,
  BinanceAccountSetupViolationError,
  buildTestOrderClientId,
} from "../src/modules/binance/binance-account-setup.client";
import {
  BINANCE_ACCOUNT_SETUP_ENDPOINTS,
  allowedAccountSetupPairs,
} from "../src/modules/binance/binance-account-setup.endpoints";
import { BinanceAccountConnectionService } from "../src/modules/binance/binance-account-connection.service";
import type { BinanceSymbolFiltersDto } from "../src/modules/binance/binance.types";

/**
 * Phase 10 tests. Everything runs against a FAKE transport and a FAKE read-only
 * service: no test here can reach Binance, and no real account is touched.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface DispatchRecord {
  url: string;
  method: string;
  path: string;
  params: URLSearchParams;
}

class FakeTransport {
  readonly dispatches: DispatchRecord[] = [];
  /** Scripted outcome per call index; the last entry repeats. */
  script: Array<"OK" | "TIMEOUT" | "SERVER" | "REJECT"> = ["OK"];

  readonly send = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    this.dispatches.push({
      url,
      method: String(init.method),
      path: parsed.pathname,
      params: parsed.searchParams,
    });

    const mode = this.script[Math.min(this.dispatches.length - 1, this.script.length - 1)];
    if (mode === "TIMEOUT") {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    if (mode === "SERVER") {
      return new Response(JSON.stringify({ code: -1001, msg: "Internal error" }), { status: 503 });
    }
    if (mode === "REJECT") {
      return new Response(JSON.stringify({ code: -1111, msg: "Precision is over the maximum" }), { status: 400 });
    }
    return new Response(JSON.stringify({ code: 200, msg: "success" }), { status: 200 });
  };
}

/** A read-only client stub that never performs I/O beyond syncTime. */
const fakeReadOnlyClient = {
  syncTime: async () => ({ serverTimeMs: 1_700_000_000_000, offsetMs: 0, roundTripMs: 1 }),
  clockOffsetMs: 0,
} as never;

function buildClient(overrides: Partial<ConstructorParameters<typeof BinanceAccountSetupClient>[0]> = {}) {
  const transport = new FakeTransport();
  const client = new BinanceAccountSetupClient({
    readOnlyClient: fakeReadOnlyClient,
    baseUrl: "https://fapi.example.test",
    apiKey: "SYNTHETIC_KEY",
    apiSecret: "SYNTHETIC_SECRET",
    recvWindowMs: 5000,
    accountSetupMutationsEnabled: true,
    testOrderEnabled: true,
    transport: transport.send,
    ...overrides,
  });
  return { client, transport };
}

const FILTERS: BinanceSymbolFiltersDto = {
  symbol: "BTCUSDT",
  status: "TRADING",
  contractType: "PERPETUAL",
  tickSize: "0.10",
  minPrice: "100",
  maxPrice: "1000000",
  stepSize: "0.001",
  minQty: "0.001",
  maxQty: "1000",
  marketStepSize: "0.001",
  marketMinQty: "0.001",
  marketMaxQty: "100",
  minNotional: "100",
};

/** A scriptable stand-in for the Phase 2 read-only service. */
function fakeReadOnlyService(options: {
  positionMode?: string | null;
  assetMode?: string | null;
  positions?: number;
  orders?: number[];
  filters?: BinanceSymbolFiltersDto;
  failInspect?: boolean;
  failSummary?: boolean;
}) {
  const orderCounts = options.orders ?? [0, 0, 0, 0];
  let orderCall = 0;
  return {
    checkConnection: async () => ({
      ok: true,
      host: "fapi.example.test",
      serverTimeMs: 1,
      serverTimeIso: "1970-01-01T00:00:00.000Z",
      clockOffsetMs: 3,
      roundTripMs: 10,
    }),
    getAccountSummary: async () => {
      if (options.failSummary) throw new Error("summary unavailable");
      return {
        positionMode: options.positionMode ?? "HEDGE",
        assetMode: options.assetMode ?? "SINGLE_ASSET",
      };
    },
    getPositionRisk: async () => Array.from({ length: options.positions ?? 0 }, (_, i) => ({ symbol: `S${i}` })),
    getOpenOrders: async () => {
      const count = orderCounts[Math.min(orderCall, orderCounts.length - 1)];
      orderCall += 1;
      return Array.from({ length: count }, (_, i) => ({ symbol: `S${i}` }));
    },
    inspectSymbol: async () => {
      if (options.failInspect) throw new Error("symbol unavailable");
      return { filters: options.filters ?? FILTERS, brackets: [{ initialLeverage: 20 }] };
    },
  } as never;
}

// ---------------------------------------------------------------------------
// Endpoint allowlist
// ---------------------------------------------------------------------------

describe("Phase 10 endpoint allowlist", () => {
  it("contains exactly the two documented maintenance endpoints", () => {
    expect(allowedAccountSetupPairs()).toEqual([
      "POST /fapi/v1/order/test",
      "POST /fapi/v1/positionSide/dual",
    ]);
  });

  it("declares no DELETE and no non-POST verb", () => {
    const methods = Object.values(BINANCE_ACCOUNT_SETUP_ENDPOINTS).map((endpoint) => endpoint.method);
    expect([...new Set(methods)]).toEqual(["POST"]);
  });

  it("keeps the real order endpoint out of the maintenance surface", () => {
    const paths = Object.values(BINANCE_ACCOUNT_SETUP_ENDPOINTS).map((endpoint) => endpoint.path);
    expect(paths).not.toContain("/fapi/v1/order");
    expect(paths).toContain("/fapi/v1/order/test");
  });
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe("Phase 10 gates", () => {
  it("dispatches nothing when the account-setup gate is closed", async () => {
    const { client, transport } = buildClient({ accountSetupMutationsEnabled: false });
    expect(() =>
      client.authorizeHedgeMode({ observedPositionMode: "ONE_WAY", nonZeroPositionCount: 0, openOrderCount: 0 })
    ).toThrow(BinanceAccountSetupDisabledError);
    expect(transport.dispatches).toHaveLength(0);
    expect(client.mutationsDispatched).toBe(0);
  });

  it("dispatches nothing when the test-order gate is closed", async () => {
    const { client, transport } = buildClient({ testOrderEnabled: false });
    expect(() =>
      client.authorizeTestOrder({
        symbol: "BTCUSDT",
        side: "BUY",
        positionSide: "LONG",
        quantity: "0.01",
        price: "50000",
      })
    ).toThrow(BinanceAccountSetupDisabledError);
    expect(transport.dispatches).toHaveLength(0);
  });

  it("re-checks the gate at dispatch time, not only when the context was minted", async () => {
    const { client } = buildClient();
    const authorization = client.authorizeHedgeMode({
      observedPositionMode: "ONE_WAY",
      nonZeroPositionCount: 0,
      openOrderCount: 0,
    });

    // A second client with the gate closed must refuse the same context.
    const { client: closed, transport } = buildClient({ accountSetupMutationsEnabled: false });
    await expect(closed.setHedgeMode(authorization)).rejects.toThrow(BinanceAccountSetupDisabledError);
    expect(transport.dispatches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hedge-mode client
// ---------------------------------------------------------------------------

describe("hedge-mode client", () => {
  it("refuses authorization unless the account is provably empty and ONE_WAY", () => {
    const { client, transport } = buildClient();
    for (const input of [
      { observedPositionMode: "HEDGE", nonZeroPositionCount: 0, openOrderCount: 0 },
      { observedPositionMode: null, nonZeroPositionCount: 0, openOrderCount: 0 },
      { observedPositionMode: "ONE_WAY", nonZeroPositionCount: 1, openOrderCount: 0 },
      { observedPositionMode: "ONE_WAY", nonZeroPositionCount: 0, openOrderCount: 1 },
    ]) {
      expect(() => client.authorizeHedgeMode(input as never), JSON.stringify(input)).toThrow(
        BinanceAccountSetupViolationError
      );
    }
    expect(transport.dispatches).toHaveLength(0);
  });

  it("sends exactly one POST with dualSidePosition=true", async () => {
    const { client, transport } = buildClient();
    await client.setHedgeMode(
      client.authorizeHedgeMode({ observedPositionMode: "ONE_WAY", nonZeroPositionCount: 0, openOrderCount: 0 })
    );

    expect(transport.dispatches).toHaveLength(1);
    expect(transport.dispatches[0].method).toBe("POST");
    expect(transport.dispatches[0].path).toBe("/fapi/v1/positionSide/dual");
    expect(transport.dispatches[0].params.get("dualSidePosition")).toBe("true");
  });

  it("has no code path that can request ONE_WAY", () => {
    const client = buildClient().client as unknown as Record<string, unknown>;
    // No method takes a mode argument, and no "false" constant exists.
    expect(typeof client.setHedgeMode).toBe("function");
    expect((client.setHedgeMode as (...args: unknown[]) => unknown).length).toBe(1);
    expect(Object.keys(client)).not.toContain("setOneWayMode");
    expect(Object.getPrototypeOf(client)).not.toHaveProperty("setOneWayMode");
    expect(Object.getPrototypeOf(client)).not.toHaveProperty("setPositionMode");
  });

  it("rejects a forged authorization object", async () => {
    const { client, transport } = buildClient();
    await expect(
      client.setHedgeMode({ observedPositionMode: "ONE_WAY", nonZeroPositionCount: 0, openOrderCount: 0 } as never)
    ).rejects.toThrow(BinanceAccountSetupViolationError);
    expect(transport.dispatches).toHaveLength(0);
  });

  it("signs the request and never exposes the secret in the query", async () => {
    const { client, transport } = buildClient();
    await client.setHedgeMode(
      client.authorizeHedgeMode({ observedPositionMode: "ONE_WAY", nonZeroPositionCount: 0, openOrderCount: 0 })
    );
    const { url, params } = transport.dispatches[0];
    expect(params.get("signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(params.get("timestamp")).toBeTruthy();
    expect(url).not.toContain("SYNTHETIC_SECRET");
  });
});

// ---------------------------------------------------------------------------
// Test-order client
// ---------------------------------------------------------------------------

describe("test-order client", () => {
  const authorize = (client: BinanceAccountSetupClient, positionSide: "LONG" | "SHORT") =>
    client.authorizeTestOrder({
      symbol: "btcusdt",
      side: positionSide === "LONG" ? "BUY" : "SELL",
      positionSide,
      quantity: "0.002",
      price: "50000",
    });

  it("posts only to /fapi/v1/order/test, never to /fapi/v1/order", async () => {
    const { client, transport } = buildClient();
    await client.submitUsdMFuturesTestOrder(authorize(client, "LONG"));
    expect(transport.dispatches).toHaveLength(1);
    expect(transport.dispatches[0].path).toBe("/fapi/v1/order/test");
    expect(transport.dispatches.map((d) => d.path)).not.toContain("/fapi/v1/order");
  });

  it("sends LIMIT + GTC and the hedge-mode position side", async () => {
    const { client, transport } = buildClient();
    await client.submitUsdMFuturesTestOrder(authorize(client, "LONG"));
    const params = transport.dispatches[0].params;
    expect(params.get("type")).toBe("LIMIT");
    expect(params.get("timeInForce")).toBe("GTC");
    expect(params.get("side")).toBe("BUY");
    expect(params.get("positionSide")).toBe("LONG");
    expect(params.get("symbol")).toBe("BTCUSDT");
    expect(params.get("quantity")).toBe("0.002");
    expect(params.get("price")).toBe("50000");
  });

  it("maps SHORT to SELL/SHORT", async () => {
    const { client, transport } = buildClient();
    await client.submitUsdMFuturesTestOrder(authorize(client, "SHORT"));
    expect(transport.dispatches[0].params.get("side")).toBe("SELL");
    expect(transport.dispatches[0].params.get("positionSide")).toBe("SHORT");
  });

  it("refuses a side that contradicts the position side", () => {
    const { client } = buildClient();
    expect(() =>
      client.authorizeTestOrder({
        symbol: "BTCUSDT",
        side: "SELL",
        positionSide: "LONG",
        quantity: "1",
        price: "1",
      })
    ).toThrow(BinanceAccountSetupViolationError);
  });

  it("sends no MARKET, protection, reduceOnly or closePosition parameter", async () => {
    const { client, transport } = buildClient();
    await client.submitUsdMFuturesTestOrder(authorize(client, "LONG"));
    const params = transport.dispatches[0].params;
    for (const forbidden of [
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
    ]) {
      expect(`${forbidden}:${params.has(forbidden)}`).toBe(`${forbidden}:false`);
    }
    expect(params.get("type")).not.toBe("MARKET");
  });

  it("uses a deterministic test-only client id namespace", async () => {
    const { client, transport } = buildClient();
    await client.submitUsdMFuturesTestOrder(authorize(client, "LONG"));
    const id = transport.dispatches[0].params.get("newClientOrderId")!;

    expect(id).toMatch(/^tadtest-[0-9a-f]{16}$/);
    // Distinct from every live execution namespace.
    expect(id.startsWith("tad-en-")).toBe(false);
    expect(id.startsWith("tad-sl-")).toBe(false);
    expect(id.startsWith("tad-tp-")).toBe(false);
    expect(id.startsWith("tad-ec-")).toBe(false);
    expect(id.length).toBeLessThanOrEqual(36);
    // Stable for the same request.
    expect(buildTestOrderClientId("BTCUSDT", "LONG", "0.002", "50000")).toBe(id);
  });

  it("rejects a non-decimal quantity or price before dispatch", () => {
    const { client, transport } = buildClient();
    for (const bad of [
      { quantity: "0", price: "50000" },
      { quantity: "1e5", price: "50000" },
      { quantity: "-1", price: "50000" },
      { quantity: "0.002", price: "0" },
    ]) {
      expect(() =>
        client.authorizeTestOrder({ symbol: "BTCUSDT", side: "BUY", positionSide: "LONG", ...bad })
      ).toThrow(BinanceAccountSetupViolationError);
    }
    expect(transport.dispatches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Local filter validation
// ---------------------------------------------------------------------------

describe("local filter validation", () => {
  const validate = (overrides: Partial<{ price: string; quantity: string; filters: BinanceSymbolFiltersDto }>) =>
    validateTestOrderAgainstFilters({
      filters: overrides.filters ?? FILTERS,
      price: overrides.price ?? "50000",
      quantity: overrides.quantity ?? "0.002",
    });

  it("accepts a request that satisfies every filter", () => {
    expect(validate({}).valid).toBe(true);
  });

  it("rejects a price off the tick grid without rounding it", () => {
    const result = validate({ price: "50000.05" });
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("PRICE_TICK_SIZE_MISMATCH");
    // The message names the tick size; nothing was snapped for the operator.
    expect(result.messages.join(" ")).toContain("0.10");
  });

  it("rejects a quantity off the step grid", () => {
    const result = validate({ quantity: "0.0025" });
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("QUANTITY_STEP_SIZE_MISMATCH");
  });

  it("rejects a notional below the symbol minimum", () => {
    const result = validate({ quantity: "0.001", price: "1000" });
    expect(result.violations).toContain("MIN_NOTIONAL_NOT_MET");
  });

  it("rejects a non-TRADING symbol", () => {
    const result = validate({ filters: { ...FILTERS, status: "BREAK" } });
    expect(result.violations).toContain("SYMBOL_NOT_TRADING");
  });

  it("rejects a known non-perpetual contract", () => {
    const result = validate({ filters: { ...FILTERS, contractType: "CURRENT_QUARTER" } });
    expect(result.violations).toContain("SYMBOL_NOT_PERPETUAL");
  });

  it("tolerates an unknown contract type rather than inventing a failure", () => {
    expect(validate({ filters: { ...FILTERS, contractType: null } }).valid).toBe(true);
  });

  it("rejects prices and quantities outside the documented range", () => {
    expect(validate({ price: "10" }).violations).toContain("PRICE_OUT_OF_RANGE");
    expect(validate({ quantity: "10000" }).violations).toContain("QUANTITY_OUT_OF_RANGE");
  });

  it("uses exact decimal arithmetic rather than floats", () => {
    // 0.1 + 0.2 style drift would make this fail a naive implementation.
    const filters = { ...FILTERS, tickSize: "0.1", minNotional: "0", minPrice: "0", stepSize: "0.1", minQty: "0.1" };
    expect(validateTestOrderAgainstFilters({ filters, price: "0.3", quantity: "0.3" }).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Readiness evaluation
// ---------------------------------------------------------------------------

describe("readiness evaluation", () => {
  const healthy = {
    serverTimeReachable: true,
    signedRequestWorks: true,
    futuresAccountReachable: true,
    positionMode: "HEDGE",
    assetMode: "SINGLE_ASSET",
    nonZeroPositionCount: 0,
    openOrderCount: 0,
    authenticationFailed: false,
    clockSyncFailed: false,
  };

  it("reports CONNECTED and ACCOUNT_SETUP_SAFE for an empty hedge account", () => {
    const result = evaluateReadiness(healthy);
    expect(result.codes).toContain("CONNECTED");
    expect(result.codes).toContain("ACCOUNT_SETUP_SAFE");
    expect(result.accountSetupSafe).toBe(true);
  });

  it("flags a ONE_WAY account without changing anything", () => {
    const result = evaluateReadiness({ ...healthy, positionMode: "ONE_WAY" });
    expect(result.codes).toContain("POSITION_MODE_MISMATCH");
    // Still safe to SET hedge mode, because the account is empty.
    expect(result.accountSetupSafe).toBe(true);
  });

  it("flags MULTI_ASSET", () => {
    expect(evaluateReadiness({ ...healthy, assetMode: "MULTI_ASSET" }).codes).toContain("ASSET_MODE_MISMATCH");
  });

  it("blocks setup when any position or order exists", () => {
    const withPosition = evaluateReadiness({ ...healthy, nonZeroPositionCount: 1 });
    expect(withPosition.codes).toContain("OPEN_POSITIONS_PRESENT");
    expect(withPosition.accountSetupSafe).toBe(false);

    const withOrder = evaluateReadiness({ ...healthy, openOrderCount: 3 });
    expect(withOrder.codes).toContain("OPEN_ORDERS_PRESENT");
    expect(withOrder.accountSetupSafe).toBe(false);
  });

  it("never treats an unknown count as zero", () => {
    const unknown = evaluateReadiness({ ...healthy, nonZeroPositionCount: null });
    expect(unknown.accountSetupSafe).toBe(false);
    expect(unknown.codes).toContain("ACCOUNT_SETUP_BLOCKED");
  });

  it("reports authentication and clock failures distinctly", () => {
    expect(evaluateReadiness({ ...healthy, authenticationFailed: true }).codes).toContain("AUTHENTICATION_FAILED");
    expect(evaluateReadiness({ ...healthy, clockSyncFailed: true }).codes).toContain("CLOCK_SYNC_FAILED");
    expect(evaluateReadiness({ ...healthy, futuresAccountReachable: false }).codes).toContain(
      "FUTURES_ACCOUNT_UNAVAILABLE"
    );
  });

  it("uses only documented readiness codes", () => {
    for (const code of evaluateReadiness(healthy).codes) {
      expect(ACCOUNT_READINESS_CODES).toContain(code);
    }
  });

  it("never advances past TEST_ORDER_VALIDATED", () => {
    const codes = evaluateReadiness(healthy).codes;
    expect(evaluateConnectionReadiness({ codes, positionMode: "HEDGE", assetMode: "SINGLE_ASSET", testOrderEnabled: false, testOrderValidated: false })).toBe(
      "TRADING_PERMISSION_UNVERIFIED"
    );
    expect(evaluateConnectionReadiness({ codes, positionMode: "HEDGE", assetMode: "SINGLE_ASSET", testOrderEnabled: true, testOrderValidated: false })).toBe(
      "TEST_ORDER_READY"
    );
    const validated = evaluateConnectionReadiness({ codes, positionMode: "HEDGE", assetMode: "SINGLE_ASSET", testOrderEnabled: true, testOrderValidated: true });
    expect(validated).toBe("TEST_ORDER_VALIDATED");
    // A validated test order is NOT live-trading authority.
    expect(validated).not.toBe("LIVE_CANARY_NOT_ENABLED");
    expect(CONNECTION_READINESS_STATES).toContain("LIVE_CANARY_NOT_ENABLED");
  });

  it("reports ACCOUNT_MODE_BLOCKED for the wrong modes", () => {
    const codes = evaluateReadiness({ ...healthy, positionMode: "ONE_WAY" }).codes;
    expect(evaluateConnectionReadiness({ codes, positionMode: "ONE_WAY", assetMode: "SINGLE_ASSET", testOrderEnabled: true, testOrderValidated: false })).toBe(
      "ACCOUNT_MODE_BLOCKED"
    );
  });

  it("reports NOT_CONNECTED when the signed read failed", () => {
    const codes = evaluateReadiness({ ...healthy, signedRequestWorks: false }).codes;
    expect(evaluateConnectionReadiness({ codes, positionMode: "HEDGE", assetMode: "SINGLE_ASSET", testOrderEnabled: true, testOrderValidated: false })).toBe(
      "NOT_CONNECTED"
    );
  });
});

// ---------------------------------------------------------------------------
// Test-order invariant
// ---------------------------------------------------------------------------

describe("real-open-order invariant", () => {
  it("validates when the count is unchanged", () => {
    expect(evaluateTestOrderOutcome({ openOrderCountBefore: 2, openOrderCountAfter: 2, accepted: true, resultUnknown: false })).toEqual({
      outcome: "TEST_ORDER_VALIDATED",
      realOpenOrdersChanged: false,
    });
  });

  it("escalates to CRITICAL when the count changed, whatever the endpoint said", () => {
    for (const accepted of [true, false]) {
      expect(
        evaluateTestOrderOutcome({ openOrderCountBefore: 0, openOrderCountAfter: 1, accepted, resultUnknown: false })
      ).toEqual({ outcome: "CRITICAL_TEST_INVARIANT_VIOLATION", realOpenOrdersChanged: true });
    }
  });

  it("reports an unknown result safely", () => {
    expect(evaluateTestOrderOutcome({ openOrderCountBefore: 1, openOrderCountAfter: 1, accepted: false, resultUnknown: true }).outcome).toBe(
      "TEST_ORDER_RESULT_UNKNOWN"
    );
  });

  it("reports a rejection as failure", () => {
    expect(evaluateTestOrderOutcome({ openOrderCountBefore: 0, openOrderCountAfter: 0, accepted: false, resultUnknown: false }).outcome).toBe(
      "TEST_ORDER_FAILED"
    );
  });
});

// ---------------------------------------------------------------------------
// Service orchestration
// ---------------------------------------------------------------------------

describe("hedge-mode orchestration", () => {
  function buildService(
    readOptions: Parameters<typeof fakeReadOnlyService>[0],
    clientOverrides: Partial<ConstructorParameters<typeof BinanceAccountSetupClient>[0]> = {}
  ) {
    const { client, transport } = buildClient(clientOverrides);
    const service = new BinanceAccountConnectionService({
      readOnly: fakeReadOnlyService(readOptions),
      setupClient: client,
      liveEntryEnabled: false,
      protectionReady: false,
      accountSetupMutationsEnabled: clientOverrides.accountSetupMutationsEnabled ?? true,
      testOrderEnabled: clientOverrides.testOrderEnabled ?? true,
    });
    return { service, transport };
  }

  it("sends nothing when the account is already HEDGE", async () => {
    const { service, transport } = buildService({ positionMode: "HEDGE" });
    const result = await service.ensureHedgeMode();
    expect(result.outcome).toBe("ALREADY_HEDGE");
    expect(transport.dispatches).toHaveLength(0);
  });

  it("sends nothing when the gate is closed, even on an empty ONE_WAY account", async () => {
    const { service, transport } = buildService(
      { positionMode: "ONE_WAY" },
      { accountSetupMutationsEnabled: false }
    );
    const result = await service.ensureHedgeMode();
    expect(result.outcome).toBe("MUTATIONS_DISABLED");
    expect(transport.dispatches).toHaveLength(0);
  });

  it("blocks on any non-zero position anywhere in the account", async () => {
    const { service, transport } = buildService({ positionMode: "ONE_WAY", positions: 1 });
    const result = await service.ensureHedgeMode();
    expect(result.outcome).toBe("ACCOUNT_SETUP_BLOCKED");
    expect(result.message).toMatch(/position/i);
    expect(transport.dispatches).toHaveLength(0);
  });

  it("blocks on an open order for an unrelated symbol", async () => {
    const { service, transport } = buildService({ positionMode: "ONE_WAY", orders: [1, 1, 1, 1] });
    const result = await service.ensureHedgeMode();
    expect(result.outcome).toBe("ACCOUNT_SETUP_BLOCKED");
    expect(transport.dispatches).toHaveLength(0);
  });

  it("blocks when the account-wide state cannot be read", async () => {
    const { service, transport } = buildService({ positionMode: "ONE_WAY", failSummary: false, orders: [] });
    // Force the open-order read to throw by replacing it.
    const broken = new BinanceAccountConnectionService({
      readOnly: {
        ...(fakeReadOnlyService({ positionMode: "ONE_WAY" }) as object),
        getOpenOrders: async () => {
          throw new Error("unavailable");
        },
      } as never,
      setupClient: buildClient().client,
      accountSetupMutationsEnabled: true,
    });
    const result = await broken.ensureHedgeMode();
    expect(result.outcome).toBe("ACCOUNT_SETUP_BLOCKED");
    expect(transport.dispatches).toHaveLength(0);
    void service;
  });

  it("sends exactly one POST for an empty ONE_WAY account and verifies the result", async () => {
    // orders: preflight, TOCTOU re-check -> 0; then position mode reads HEDGE.
    const { client, transport } = buildClient();
    let modeCall = 0;
    const service = new BinanceAccountConnectionService({
      readOnly: {
        ...(fakeReadOnlyService({}) as object),
        getAccountSummary: async () => {
          modeCall += 1;
          // ONE_WAY before the POST, HEDGE afterwards.
          return { positionMode: modeCall <= 1 ? "ONE_WAY" : "HEDGE", assetMode: "SINGLE_ASSET" };
        },
      } as never,
      setupClient: client,
      accountSetupMutationsEnabled: true,
    });

    const result = await service.ensureHedgeMode();
    expect(transport.dispatches).toHaveLength(1);
    expect(transport.dispatches[0].path).toBe("/fapi/v1/positionSide/dual");
    expect(result.outcome).toBe("HEDGE_MODE_SET");
    expect(result.positionModeAfter).toBe("HEDGE");
    expect(result.mutationsDispatched).toBe(1);
  });

  it("fails when the POST succeeded but a fresh read still says ONE_WAY", async () => {
    const { client, transport } = buildClient();
    const service = new BinanceAccountConnectionService({
      readOnly: fakeReadOnlyService({ positionMode: "ONE_WAY" }),
      setupClient: client,
      accountSetupMutationsEnabled: true,
    });

    const result = await service.ensureHedgeMode();
    expect(transport.dispatches).toHaveLength(1);
    expect(result.outcome).toBe("HEDGE_MODE_NOT_VERIFIED");
  });

  it("treats a timeout followed by an observed HEDGE as success", async () => {
    const { client, transport } = buildClient();
    transport.script = ["TIMEOUT"];
    let modeCall = 0;
    const service = new BinanceAccountConnectionService({
      readOnly: {
        ...(fakeReadOnlyService({}) as object),
        getAccountSummary: async () => {
          modeCall += 1;
          return { positionMode: modeCall <= 1 ? "ONE_WAY" : "HEDGE", assetMode: "SINGLE_ASSET" };
        },
      } as never,
      setupClient: client,
      accountSetupMutationsEnabled: true,
    });

    const result = await service.ensureHedgeMode();
    expect(result.outcome).toBe("HEDGE_MODE_SET");
    // Exactly one attempt — an ambiguous result is never blind-retried.
    expect(transport.dispatches).toHaveLength(1);
  });

  it("treats a timeout followed by an observed ONE_WAY as unresolved, with no retry", async () => {
    const { client, transport } = buildClient();
    transport.script = ["TIMEOUT"];
    const service = new BinanceAccountConnectionService({
      readOnly: fakeReadOnlyService({ positionMode: "ONE_WAY" }),
      setupClient: client,
      accountSetupMutationsEnabled: true,
    });

    const result = await service.ensureHedgeMode();
    expect(result.outcome).toBe("HEDGE_MODE_NOT_VERIFIED");
    expect(transport.dispatches).toHaveLength(1);
  });

  it("sends nothing when a position appears between preflight and the POST", async () => {
    const { client, transport } = buildClient();
    let positionCall = 0;
    const service = new BinanceAccountConnectionService({
      readOnly: {
        ...(fakeReadOnlyService({ positionMode: "ONE_WAY" }) as object),
        getPositionRisk: async () => {
          positionCall += 1;
          // Empty at preflight, occupied at the TOCTOU re-check.
          return positionCall <= 1 ? [] : [{ symbol: "ETHUSDT" }];
        },
      } as never,
      setupClient: client,
      accountSetupMutationsEnabled: true,
    });

    const result = await service.ensureHedgeMode();
    expect(result.outcome).toBe("ACCOUNT_STATE_CHANGED");
    expect(transport.dispatches).toHaveLength(0);
  });

  it("sends nothing when an order appears between preflight and the POST", async () => {
    const { client, transport } = buildClient();
    const service = new BinanceAccountConnectionService({
      // preflight sees 0 orders, the re-check sees 1.
      readOnly: fakeReadOnlyService({ positionMode: "ONE_WAY", orders: [0, 1, 1, 1] }),
      setupClient: client,
      accountSetupMutationsEnabled: true,
    });

    const result = await service.ensureHedgeMode();
    expect(result.outcome).toBe("ACCOUNT_STATE_CHANGED");
    expect(transport.dispatches).toHaveLength(0);
  });

  it("reports an unreadable position mode without sending anything", async () => {
    const { client, transport } = buildClient();
    const service = new BinanceAccountConnectionService({
      readOnly: fakeReadOnlyService({ failSummary: true }),
      setupClient: client,
      accountSetupMutationsEnabled: true,
    });
    const result = await service.ensureHedgeMode();
    expect(result.outcome).toBe("POSITION_MODE_UNKNOWN");
    expect(transport.dispatches).toHaveLength(0);
  });
});

describe("test-order orchestration", () => {
  function buildService(
    readOptions: Parameters<typeof fakeReadOnlyService>[0],
    clientOverrides: Partial<ConstructorParameters<typeof BinanceAccountSetupClient>[0]> = {}
  ) {
    const { client, transport } = buildClient(clientOverrides);
    const service = new BinanceAccountConnectionService({
      readOnly: fakeReadOnlyService(readOptions),
      setupClient: client,
      testOrderEnabled: clientOverrides.testOrderEnabled ?? true,
    });
    return { service, transport };
  }

  const request = { symbol: "BTCUSDT", positionSide: "LONG" as const, quantity: "0.002", price: "50000" };

  it("validates and confirms the open-order count did not move", async () => {
    const { service, transport } = buildService({ orders: [1, 1] });
    const result = await service.validateTestOrder(request);

    expect(result.outcome).toBe("TEST_ORDER_VALIDATED");
    expect(result.realOpenOrdersChanged).toBe(false);
    expect(result.openOrderCountBefore).toBe(1);
    expect(result.openOrderCountAfter).toBe(1);
    expect(transport.dispatches).toHaveLength(1);
    expect(transport.dispatches[0].path).toBe("/fapi/v1/order/test");
  });

  it("escalates when the real open-order count changes across the call", async () => {
    const { service } = buildService({ orders: [0, 1] });
    const result = await service.validateTestOrder(request);
    expect(result.outcome).toBe("CRITICAL_TEST_INVARIANT_VIOLATION");
    expect(result.realOpenOrdersChanged).toBe(true);
    // Nothing was cancelled: the service has no cancellation capability at all.
    expect(result.message).toMatch(/nothing was cancelled/i);
  });

  it("sends nothing when the gate is closed", async () => {
    const { service, transport } = buildService({}, { testOrderEnabled: false });
    const result = await service.validateTestOrder(request);
    expect(result.outcome).toBe("TEST_ORDER_FAILED");
    expect(transport.dispatches).toHaveLength(0);
  });

  it("requires HEDGE mode", async () => {
    const { service, transport } = buildService({ positionMode: "ONE_WAY" });
    const result = await service.validateTestOrder(request);
    expect(result.outcome).toBe("TEST_ORDER_FAILED");
    expect(result.message).toMatch(/HEDGE/);
    expect(transport.dispatches).toHaveLength(0);
  });

  it("requires SINGLE_ASSET mode", async () => {
    const { service, transport } = buildService({ assetMode: "MULTI_ASSET" });
    const result = await service.validateTestOrder(request);
    expect(result.outcome).toBe("TEST_ORDER_FAILED");
    expect(result.message).toMatch(/SINGLE_ASSET/);
    expect(transport.dispatches).toHaveLength(0);
  });

  it("rejects a filter violation locally without any network call", async () => {
    const { service, transport } = buildService({});
    const result = await service.validateTestOrder({ ...request, price: "50000.05" });
    expect(result.outcome).toBe("TEST_ORDER_FAILED");
    expect(result.validationViolations).toContain("PRICE_TICK_SIZE_MISMATCH");
    expect(transport.dispatches).toHaveLength(0);
  });

  it("retries an ambiguous result within a bounded budget and never touches the real order endpoint", async () => {
    const { service, transport } = buildService({ orders: [0, 0] });
    transport.script = ["TIMEOUT"];

    const result = await service.validateTestOrder(request);
    expect(result.outcome).toBe("TEST_ORDER_RESULT_UNKNOWN");
    // Bounded: two attempts, not an unbounded loop.
    expect(transport.dispatches).toHaveLength(2);
    for (const dispatch of transport.dispatches) {
      expect(dispatch.path).toBe("/fapi/v1/order/test");
    }
    expect(transport.dispatches.map((d) => d.path)).not.toContain("/fapi/v1/order");
  });

  it("does not retry a definitive rejection", async () => {
    const { service, transport } = buildService({ orders: [0, 0] });
    transport.script = ["REJECT"];

    const result = await service.validateTestOrder(request);
    expect(result.outcome).toBe("TEST_ORDER_FAILED");
    expect(transport.dispatches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Health check output
// ---------------------------------------------------------------------------

describe("account health output", () => {
  it("reports sanitized counts and no account detail", async () => {
    const service = new BinanceAccountConnectionService({
      readOnly: fakeReadOnlyService({ positions: 2, orders: [3, 3, 3, 3] }),
      setupClient: buildClient().client,
      liveEntryEnabled: false,
      protectionReady: false,
      accountSetupMutationsEnabled: false,
      testOrderEnabled: false,
    });

    const health = await service.checkAccountConnection();
    expect(health.nonZeroPositionCount).toBe(2);
    expect(health.openOrderCount).toBe(3);
    expect(health.accountSetupSafe).toBe(false);
    expect(health.liveEntryEnabled).toBe(false);
    expect(health.protectionReady).toBe(false);

    const serialized = JSON.stringify(health);
    for (const forbidden of [
      "walletBalance",
      "availableBalance",
      "positionAmt",
      "entryPrice",
      "liquidationPrice",
      "orderId",
      "accountIdentifier",
      "apiKey",
      "apiSecret",
      "signature",
      "SYNTHETIC_SECRET",
      "X-MBX-APIKEY",
    ]) {
      expect(`${forbidden}:${serialized.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // No symbol list either — counts only.
    expect(serialized).not.toContain("S0");
  });

  it("reports a ONE_WAY account without changing it", async () => {
    const { client, transport } = buildClient();
    const service = new BinanceAccountConnectionService({
      readOnly: fakeReadOnlyService({ positionMode: "ONE_WAY" }),
      setupClient: client,
    });

    const health = await service.checkAccountConnection();
    expect(health.positionMode).toBe("ONE_WAY");
    expect(health.readinessCodes).toContain("POSITION_MODE_MISMATCH");
    expect(health.warnings.join(" ")).toMatch(/NOT changed/);
    // The health check is read-only: zero mutations, always.
    expect(transport.dispatches).toHaveLength(0);
  });

  it("reports MULTI_ASSET without changing it", async () => {
    const { client, transport } = buildClient();
    const service = new BinanceAccountConnectionService({
      readOnly: fakeReadOnlyService({ assetMode: "MULTI_ASSET" }),
      setupClient: client,
    });
    const health = await service.checkAccountConnection();
    expect(health.assetMode).toBe("MULTI_ASSET");
    expect(health.readinessCodes).toContain("ASSET_MODE_MISMATCH");
    expect(transport.dispatches).toHaveLength(0);
  });

  it("warns clearly when existing exposure blocks setup", async () => {
    const service = new BinanceAccountConnectionService({
      readOnly: fakeReadOnlyService({ positions: 1 }),
      setupClient: buildClient().client,
    });
    const health = await service.checkAccountConnection();
    expect(health.warnings.join(" ")).toMatch(/decide what to do with that exposure manually/i);
    expect(health.warnings.join(" ")).not.toMatch(/cancel .* for you|automatically clean/i);
  });

  it("degrades a failed optional read into a warning", async () => {
    const service = new BinanceAccountConnectionService({
      readOnly: fakeReadOnlyService({ failInspect: true }),
      setupClient: buildClient().client,
    });
    const health = await service.checkAccountConnection();
    expect(health.symbolConfigReachable).toBe(false);
    expect(health.leverageBracketReachable).toBe(false);
    expect(health.warnings.join(" ")).toMatch(/Symbol configuration/);
  });
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe("logging safety", () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  const captured: string[] = [];

  beforeEach(async () => {
    const { logger } = await import("../src/config/logger");
    for (const level of ["debug", "info", "warn", "error"] as const) {
      spies.push(
        vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
          captured.push(JSON.stringify(args));
          return undefined;
        }) as never)
      );
    }
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
    captured.length = 0;
  });

  it("logs no key, secret, signature or signed URL", async () => {
    const { client } = buildClient();
    await client.setHedgeMode(
      client.authorizeHedgeMode({ observedPositionMode: "ONE_WAY", nonZeroPositionCount: 0, openOrderCount: 0 })
    );
    await client.submitUsdMFuturesTestOrder(
      client.authorizeTestOrder({
        symbol: "BTCUSDT",
        side: "BUY",
        positionSide: "LONG",
        quantity: "0.002",
        price: "50000",
      })
    );

    const all = captured.join(" ");
    for (const forbidden of ["SYNTHETIC_KEY", "SYNTHETIC_SECRET", "signature=", "X-MBX-APIKEY", "https://fapi"]) {
      expect(`${forbidden}:${all.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});
