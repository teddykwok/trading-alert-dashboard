import { describe, expect, it } from "vitest";
import {
  ALLOWED_ENTRY_ORDER_TYPE,
  ALLOWED_ENTRY_TIME_IN_FORCE,
  BINANCE_MUTATION_ENDPOINTS,
  FORBIDDEN_ENTRY_PARAMS,
  allowedMutationPairs,
  isAllowedMutation,
} from "../src/modules/binance/binance-execution.endpoints";
import {
  BinanceLiveEntryDisabledError,
  BinanceMutationViolationError,
  BinanceUsdMExecutionClient,
  type MutationTransport,
} from "../src/modules/binance/binance-execution.client";
import { BinanceReadOnlyClient, buildCanonicalQuery, signQuery } from "../src/modules/binance/binance.client";
import { BINANCE_READ_ONLY_ENDPOINTS, FORBIDDEN_METHODS } from "../src/modules/binance/binance.endpoints";
import { classifyMutationOutcome } from "../src/modules/execution/entry-lifecycle";
import { buildClientOrderId } from "../src/modules/execution/execution-safety";

/**
 * Phase 6 mutation-client tests.
 *
 * Every test injects a deterministic fake transport — no test in this file can
 * reach Binance. Credentials are obviously synthetic.
 */

const FAKE_KEY = "synthetic-api-key-000000000000";
const FAKE_SECRET = "synthetic-api-secret-0000000000";
const BASE_URL = "https://testnet.binancefuture.example";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function recorder(responder: (call: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const transport: MutationTransport = async (url, init) => {
    const captured: Captured = {
      url,
      method: String(init.method),
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(captured);
    return responder(captured);
  };
  return { calls, transport };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A read-only client whose clock sync is stubbed to a fixed offset. */
function readOnlyStub(offsetMs = 1234): BinanceReadOnlyClient {
  const client = new BinanceReadOnlyClient({
    baseUrl: BASE_URL,
    apiKey: FAKE_KEY,
    apiSecret: FAKE_SECRET,
    enabled: true,
  });
  Object.defineProperty(client, "clockOffsetMs", { get: () => offsetMs, configurable: true });
  // Never let a test perform a real /fapi/v1/time call.
  (client as unknown as { syncTime: () => Promise<unknown> }).syncTime = async () => ({
    serverTimeMs: 0,
    offsetMs,
    roundTripMs: 0,
    syncedAt: Date.now(),
  });
  return client;
}

function client(options: {
  transport: MutationTransport;
  liveEntryEnabled?: boolean;
  protectionReady?: boolean;
  offsetMs?: number;
}): BinanceUsdMExecutionClient {
  return new BinanceUsdMExecutionClient({
    readOnlyClient: readOnlyStub(options.offsetMs),
    baseUrl: BASE_URL,
    apiKey: FAKE_KEY,
    apiSecret: FAKE_SECRET,
    recvWindowMs: 5000,
    liveEntryEnabled: options.liveEntryEnabled ?? true,
    protectionReady: options.protectionReady ?? true,
    transport: options.transport,
  });
}


/**
 * Binds a client to its OWN service-issued live-entry authorization, so tests
 * exercise the real authorization path instead of a fabricated token.
 */
function authed(instance: BinanceUsdMExecutionClient) {
  const authorization = instance.authorizeLiveEntry();
  return {
    setIsolatedMarginType: (symbol: string) => instance.setIsolatedMarginType(authorization, symbol),
    setInitialLeverage: (symbol: string, leverage: number) =>
      instance.setInitialLeverage(authorization, symbol, leverage),
    submitLimitEntry: (input: Parameters<BinanceUsdMExecutionClient["submitLimitEntry"]>[1]) =>
      instance.submitLimitEntry(authorization, input),
  };
}

/** A cancellation context for a synthetic execution's own ENTRY reservation. */
function cancellationContext(instance: BinanceUsdMExecutionClient, executionId = SYNTHETIC_EXECUTION_ID) {
  return instance.authorizeEntryCancellation({
    executionId,
    symbol: "SYNTHUSDT",
    clientOrderId: buildClientOrderId(executionId, "ENTRY", 1),
    role: "ENTRY",
    generation: 1,
    reason: "TTL_DUE",
  });
}

const SYNTHETIC_EXECUTION_ID = "synthetic-execution-000001";

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

// ---------------------------------------------------------------------------

describe("mutation endpoint allowlist", () => {
  it("contains exactly the approved (method, path) pairs", () => {
    // Four from Phase 6 (entry) plus three risk-reducing pairs from Phase 7.
    expect(allowedMutationPairs()).toEqual([
      "DELETE /fapi/v1/algoOrder",
      "DELETE /fapi/v1/order",
      "POST /fapi/v1/algoOrder",
      "POST /fapi/v1/leverage",
      "POST /fapi/v1/marginType",
      "POST /fapi/v1/order",
      "POST /fapi/v1/positionMargin",
    ]);
  });

  it("rejects an arbitrary POST path", () => {
    for (const path of [
      "/fapi/v1/positionSide/dual",
      "/fapi/v1/multiAssetsMargin",
      "/fapi/v1/batchOrders",
      "/fapi/v1/allOpenOrders",
      "/fapi/v1/countdownCancelAll",
      "/sapi/v1/futures/transfer",
      "/fapi/v1/listenKey",
    ]) {
      expect(isAllowedMutation("POST", path)).toBe(false);
    }
  });

  it("rejects an arbitrary DELETE path", () => {
    for (const path of ["/fapi/v1/allOpenOrders", "/fapi/v1/batchOrders", "/fapi/v1/listenKey"]) {
      expect(isAllowedMutation("DELETE", path)).toBe(false);
    }
  });

  it("rejects PUT and PATCH on the approved paths (no order modification)", () => {
    for (const method of ["PUT", "PATCH"]) {
      expect(isAllowedMutation(method, "/fapi/v1/order")).toBe(false);
    }
  });

  it("requires the exact method, not just the path", () => {
    expect(isAllowedMutation("DELETE", "/fapi/v1/leverage")).toBe(false);
    expect(isAllowedMutation("POST", "/fapi/v1/order")).toBe(true);
  });

  it("allowlists only LIMIT/GTC for entries", () => {
    expect(ALLOWED_ENTRY_ORDER_TYPE).toBe("LIMIT");
    expect(ALLOWED_ENTRY_TIME_IN_FORCE).toBe("GTC");
  });

  it("names every parameter that must never appear on an entry", () => {
    for (const forbidden of ["reduceOnly", "closePosition", "stopPrice", "priceMatch", "goodTillDate"]) {
      expect(FORBIDDEN_ENTRY_PARAMS).toContain(forbidden);
    }
  });

  it("exposes no endpoint for the prohibited operations", () => {
    const paths = Object.values(BINANCE_MUTATION_ENDPOINTS).map((endpoint) => endpoint.path);
    for (const forbidden of [
      "/fapi/v1/positionSide/dual",
      "/fapi/v1/multiAssetsMargin",
      "/fapi/v1/batchOrders",
      "/fapi/v1/allOpenOrders",
      "/sapi/v1/futures/transfer",
    ]) {
      expect(paths).not.toContain(forbidden);
    }
  });
});

describe("Phase 2 stays GET-only", () => {
  it("still forbids every mutating verb", () => {
    expect([...FORBIDDEN_METHODS]).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
  });

  it("exposes /fapi/v1/order as a GET query endpoint only", () => {
    expect(BINANCE_READ_ONLY_ENDPOINTS.order.path).toBe("/fapi/v1/order");
    // The read-only endpoint table carries no method field: the client
    // hardcodes GET, so this path cannot be mutated from there.
    expect("method" in BINANCE_READ_ONLY_ENDPOINTS.order).toBe(false);
  });

  it("has no read-only client method that could place or cancel an order", () => {
    const methods = Object.getOwnPropertyNames(BinanceReadOnlyClient.prototype);
    for (const forbidden of ["placeOrder", "submitOrder", "cancelOrder", "setLeverage", "setMarginType"]) {
      expect(methods).not.toContain(forbidden);
    }
  });
});

describe("live gates — exposure-increasing operations", () => {
  it("refuses to issue an authorization when live entry is disabled", () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const execution = client({ transport, liveEntryEnabled: false });

    expect(() => execution.authorizeLiveEntry()).toThrow(BinanceLiveEntryDisabledError);
    expect(calls).toHaveLength(0);
    expect(execution.mutationsDispatched).toBe(0);
  });

  it("refuses to issue an authorization when protection is not ready", () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const execution = client({ transport, liveEntryEnabled: true, protectionReady: false });

    expect(() => execution.authorizeLiveEntry()).toThrow(BinanceLiveEntryDisabledError);
    expect(calls).toHaveLength(0);
  });

  it("reports which gate is closed", () => {
    const { transport } = recorder(() => jsonResponse({}));
    expect(client({ transport, liveEntryEnabled: false }).blockedReason).toBe("LIVE_ENTRY_DISABLED");
    expect(client({ transport, protectionReady: false }).blockedReason).toBe("PROTECTION_NOT_READY");
    expect(client({ transport }).blockedReason).toBeNull();
  });

  it("rejects a forged authorization on every exposure-increasing method", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const execution = client({ transport, liveEntryEnabled: false, protectionReady: false });
    // There is no `bypassSafety` boolean, and a hand-made object cannot carry
    // the module-private brand.
    const forged = { bypassSafety: true } as never;

    await expect(execution.setIsolatedMarginType(forged, "SYNTHUSDT")).rejects.toBeInstanceOf(
      BinanceMutationViolationError
    );
    await expect(execution.setInitialLeverage(forged, "SYNTHUSDT", 10)).rejects.toBeInstanceOf(
      BinanceMutationViolationError
    );
    await expect(
      execution.submitLimitEntry(forged, {
        symbol: "SYNTHUSDT",
        side: "BUY",
        positionSide: "LONG",
        quantity: "0.375",
        price: "100",
        newClientOrderId: "tad-en-1-abcdef012345",
      })
    ).rejects.toBeInstanceOf(BinanceMutationViolationError);
    expect(calls).toHaveLength(0);
  });

  it("re-checks the gates at call time, not only when the token was minted", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const open = client({ transport });
    const authorization = open.authorizeLiveEntry();

    // Same token, a client whose gates are closed: still refused.
    const closed = client({ transport, liveEntryEnabled: false });
    await expect(closed.setIsolatedMarginType(authorization, "SYNTHUSDT")).rejects.toBeInstanceOf(
      BinanceLiveEntryDisabledError
    );
    expect(calls).toHaveLength(0);
  });
});

describe("risk-reducing recovery cancellation", () => {
  it("stays available when live entry is disabled", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ orderId: 991, status: "CANCELED" }));
    const execution = client({ transport, liveEntryEnabled: false, protectionReady: false });

    // Gating this would trap a resting order: disabling live entry must stop
    // new exposure, not prevent reducing exposure that already exists.
    await execution.cancelReservedEntryOrder(cancellationContext(execution));

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(new URL(calls[0].url).pathname).toBe("/fapi/v1/order");
  });

  it("takes the symbol and client order id from the context, never the call site", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ orderId: 991, status: "CANCELED" }));
    const execution = client({ transport, liveEntryEnabled: false });
    await execution.cancelReservedEntryOrder(cancellationContext(execution));

    const params = paramsOf(calls[0].url);
    expect(params.get("symbol")).toBe("SYNTHUSDT");
    expect(params.get("origClientOrderId")).toBe(buildClientOrderId(SYNTHETIC_EXECUTION_ID, "ENTRY", 1));
  });

  it("refuses a context for a client order id that is not this execution's ENTRY reservation", () => {
    const { transport } = recorder(() => jsonResponse({}));
    const execution = client({ transport });

    expect(() =>
      execution.authorizeEntryCancellation({
        executionId: SYNTHETIC_EXECUTION_ID,
        symbol: "SYNTHUSDT",
        clientOrderId: "tad-en-1-ffffffffffff", // someone else's id
        role: "ENTRY",
        generation: 1,
        reason: "TTL_DUE",
      })
    ).toThrow(BinanceMutationViolationError);
  });

  it("refuses a context for another execution's order", () => {
    const { transport } = recorder(() => jsonResponse({}));
    const execution = client({ transport });

    expect(() =>
      execution.authorizeEntryCancellation({
        executionId: "synthetic-execution-000002",
        symbol: "SYNTHUSDT",
        // The id belongs to execution 000001, not 000002.
        clientOrderId: buildClientOrderId(SYNTHETIC_EXECUTION_ID, "ENTRY", 1),
        role: "ENTRY",
        generation: 1,
        reason: "TTL_DUE",
      })
    ).toThrow(BinanceMutationViolationError);
  });

  it("refuses a non-ENTRY role and a non-1 generation", () => {
    const { transport } = recorder(() => jsonResponse({}));
    const execution = client({ transport });
    const base = {
      executionId: SYNTHETIC_EXECUTION_ID,
      symbol: "SYNTHUSDT",
      clientOrderId: buildClientOrderId(SYNTHETIC_EXECUTION_ID, "ENTRY", 1),
      reason: "TTL_DUE" as const,
    };

    expect(() => execution.authorizeEntryCancellation({ ...base, role: "STOP_LOSS", generation: 1 })).toThrow(
      BinanceMutationViolationError
    );
    expect(() => execution.authorizeEntryCancellation({ ...base, role: "TAKE_PROFIT", generation: 1 })).toThrow(
      BinanceMutationViolationError
    );
    expect(() => execution.authorizeEntryCancellation({ ...base, role: "ENTRY", generation: 2 })).toThrow(
      BinanceMutationViolationError
    );
  });

  it("requires an explicit recovery reason", () => {
    const { transport } = recorder(() => jsonResponse({}));
    const execution = client({ transport });

    expect(() =>
      execution.authorizeEntryCancellation({
        executionId: SYNTHETIC_EXECUTION_ID,
        symbol: "SYNTHUSDT",
        clientOrderId: buildClientOrderId(SYNTHETIC_EXECUTION_ID, "ENTRY", 1),
        role: "ENTRY",
        generation: 1,
        reason: "BECAUSE_I_SAID_SO" as never,
      })
    ).toThrow(BinanceMutationViolationError);
  });

  it("rejects a forged cancellation context", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const execution = client({ transport });

    await expect(
      execution.cancelReservedEntryOrder({
        symbol: "SYNTHUSDT",
        clientOrderId: "tad-en-1-abcdef012345",
        executionId: SYNTHETIC_EXECUTION_ID,
        reason: "TTL_DUE",
      } as never)
    ).rejects.toBeInstanceOf(BinanceMutationViolationError);
    expect(calls).toHaveLength(0);
  });
});

describe("signing and canonicalization", () => {
  it("signs exactly the transmitted canonical query", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ code: 200, msg: "success" }));
    await authed(client({ transport })).setIsolatedMarginType("synthusdt");

    const url = new URL(calls[0].url);
    const query = url.search.slice(1);
    const [payload, signaturePart] = query.split("&signature=");
    expect(signQuery(payload, FAKE_SECRET)).toBe(signaturePart);
  });

  it("sorts parameters alphabetically", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    await authed(client({ transport })).submitLimitEntry({
      symbol: "SYNTHUSDT",
      side: "BUY",
      positionSide: "LONG",
      quantity: "0.375",
      price: "100",
      newClientOrderId: "tad-en-1-abcdef012345",
    });

    const keys = [...new URL(calls[0].url).searchParams.keys()].filter((key) => key !== "signature");
    expect([...keys].sort()).toEqual(keys);
  });

  it("uses the Phase 2 clock offset for the timestamp", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const before = Date.now();
    await authed(client({ transport, offsetMs: 5000 })).setIsolatedMarginType("SYNTHUSDT");
    const after = Date.now();

    const timestamp = Number(paramsOf(calls[0].url).get("timestamp"));
    expect(timestamp).toBeGreaterThanOrEqual(before + 5000);
    expect(timestamp).toBeLessThanOrEqual(after + 5000);
  });

  it("applies recvWindow", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    await authed(client({ transport })).setIsolatedMarginType("SYNTHUSDT");
    expect(paramsOf(calls[0].url).get("recvWindow")).toBe("5000");
  });

  it("sends the API key in the header, never in the query", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    await authed(client({ transport })).setIsolatedMarginType("SYNTHUSDT");

    expect(calls[0].headers["X-MBX-APIKEY"]).toBe(FAKE_KEY);
    expect(calls[0].url).not.toContain(FAKE_KEY);
    expect(calls[0].url).not.toContain(FAKE_SECRET);
  });

  it("matches the Phase 2 canonicalizer exactly", () => {
    expect(buildCanonicalQuery({ b: "2", a: "1", skip: undefined })).toBe("a=1&b=2");
  });
});

describe("error sanitization", () => {
  it("never leaks the secret or signature in an error message", async () => {
    const { transport } = recorder(() => jsonResponse({ code: -1022, msg: "Signature for this request is not valid." }, 401));
    const error = await authed(client({ transport })).setIsolatedMarginType("SYNTHUSDT")
      .catch((caught: Error) => caught);

    const text = String((error as Error).message);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toMatch(/signature=[A-Fa-f0-9]{16,}/);
  });

  it("never leaks the signed URL when the transport itself throws", async () => {
    const signedUrlLeak = `connect ECONNREFUSED ${BASE_URL}/fapi/v1/order?signature=deadbeefdeadbeef`;
    const transport: MutationTransport = async () => {
      throw new Error(signedUrlLeak);
    };
    const leaky = client({ transport });
    const error = await leaky
      .cancelReservedEntryOrder(cancellationContext(leaky))
      .catch((caught: Error) => caught);

    expect(String((error as Error).message)).toContain("signature=***REDACTED***");
  });
});

describe("failure classification through the client", () => {
  const failWith = async (status: number, body: unknown) => {
    const { transport } = recorder(() => jsonResponse(body, status));
    return authed(client({ transport })).setIsolatedMarginType("SYNTHUSDT")
      .catch((error: { kind: string; httpStatus: number | null; binanceCode: number | null }) => error);
  };

  it("classifies a timeout as an unknown result", async () => {
    const transport: MutationTransport = async () => {
      const abort = new Error("aborted");
      abort.name = "AbortError";
      throw abort;
    };
    const error = await authed(client({ transport })).setIsolatedMarginType("SYNTHUSDT")
      .catch((caught: { kind: string }) => caught);

    expect(error.kind).toBe("TIMEOUT");
    expect(classifyMutationOutcome({ kind: error.kind })).toBe("RESULT_UNKNOWN");
  });

  it("does not turn a 5xx into a confirmed failure", async () => {
    const error = await failWith(503, { code: -1001, msg: "Internal error" });
    expect(classifyMutationOutcome({ kind: error.kind, httpStatus: 503, binanceCode: -1001 })).toBe("RESULT_UNKNOWN");
  });

  it("classifies 429 and 418 as retryable, not as rejections", async () => {
    const rateLimited = await failWith(429, { code: -1003, msg: "Too many requests" });
    expect(classifyMutationOutcome({ kind: rateLimited.kind })).toBe("QUERY_RETRYABLE");

    const banned = await failWith(418, { msg: "IP banned" });
    expect(classifyMutationOutcome({ kind: banned.kind })).toBe("QUERY_RETRYABLE");
  });

  it("never blind-retries a mutation", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ code: -1001, msg: "Internal error" }, 500));
    await authed(client({ transport })).setIsolatedMarginType("SYNTHUSDT")
      .catch(() => undefined);

    // Exactly one dispatch: an ambiguous mutation is reconciled, never repeated.
    expect(calls).toHaveLength(1);
  });
});

describe("entry request parameters", () => {
  async function submit(direction: "LONG" | "SHORT") {
    const { calls, transport } = recorder(() =>
      jsonResponse({ orderId: 991, clientOrderId: "tad-en-1-abcdef012345", symbol: "SYNTHUSDT", status: "NEW" })
    );
    const acknowledged = await authed(client({ transport })).submitLimitEntry({
      symbol: "SYNTHUSDT",
      side: direction === "LONG" ? "BUY" : "SELL",
      positionSide: direction,
      quantity: "0.375",
      price: "100.50",
      newClientOrderId: "tad-en-1-abcdef012345",
    });
    return { params: paramsOf(calls[0].url), method: calls[0].method, url: calls[0].url, acknowledged };
  }

  it("maps LONG to BUY + LONG", async () => {
    const { params } = await submit("LONG");
    expect(params.get("side")).toBe("BUY");
    expect(params.get("positionSide")).toBe("LONG");
  });

  it("maps SHORT to SELL + SHORT", async () => {
    const { params } = await submit("SHORT");
    expect(params.get("side")).toBe("SELL");
    expect(params.get("positionSide")).toBe("SHORT");
  });

  it("submits LIMIT + GTC only", async () => {
    const { params } = await submit("LONG");
    expect(params.get("type")).toBe("LIMIT");
    expect(params.get("timeInForce")).toBe("GTC");
  });

  it("sends the exact frozen price and quantity strings", async () => {
    const { params } = await submit("LONG");
    expect(params.get("price")).toBe("100.50");
    expect(params.get("quantity")).toBe("0.375");
  });

  it("sends the deterministic client order id and asks for ACK", async () => {
    const { params } = await submit("LONG");
    expect(params.get("newClientOrderId")).toBe("tad-en-1-abcdef012345");
    expect(params.get("newOrderRespType")).toBe("ACK");
  });

  it("sends no protection, reduce-only or close-position parameters", async () => {
    const { params } = await submit("LONG");
    for (const forbidden of FORBIDDEN_ENTRY_PARAMS) {
      expect(params.has(forbidden)).toBe(false);
    }
  });

  it("uses POST on the approved order path", async () => {
    const { method, url } = await submit("LONG");
    expect(method).toBe("POST");
    expect(new URL(url).pathname).toBe("/fapi/v1/order");
  });

  it("carries exactly the expected parameter set", async () => {
    const { params } = await submit("LONG");
    const keys = [...params.keys()].sort();
    expect(keys).toEqual([
      "newClientOrderId",
      "newOrderRespType",
      "positionSide",
      "price",
      "quantity",
      "recvWindow",
      "side",
      "signature",
      "symbol",
      "timeInForce",
      "timestamp",
      "type",
    ]);
  });
});

describe("margin type and leverage requests", () => {
  it("only ever asks for ISOLATED", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ code: 200, msg: "success" }));
    await authed(client({ transport })).setIsolatedMarginType("SYNTHUSDT");

    const params = paramsOf(calls[0].url);
    expect(params.get("marginType")).toBe("ISOLATED");
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe("/fapi/v1/marginType");
  });

  it("sends the exact integer leverage with no clamping", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ leverage: 17, maxNotionalValue: "1000", symbol: "SYNTHUSDT" }));
    const result = await authed(client({ transport })).setInitialLeverage("SYNTHUSDT", 17);

    expect(paramsOf(calls[0].url).get("leverage")).toBe("17");
    expect(result.leverage).toBe(17);
    expect(result.maxNotionalValue).toBe("1000");
  });

  it("refuses a non-integer or non-positive leverage before dispatch", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const execution = client({ transport });

    await expect(execution.setInitialLeverage(execution.authorizeLiveEntry(), "SYNTHUSDT", 0)).rejects.toBeInstanceOf(BinanceMutationViolationError);
    await expect(execution.setInitialLeverage(execution.authorizeLiveEntry(), "SYNTHUSDT", 2.5)).rejects.toBeInstanceOf(BinanceMutationViolationError);
    expect(calls).toHaveLength(0);
  });

  it("cancels by the same origClientOrderId with DELETE", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ orderId: 991, status: "CANCELED" }));
    const canceller = client({ transport });
    await canceller.cancelReservedEntryOrder(cancellationContext(canceller));

    expect(calls[0].method).toBe("DELETE");
    expect(new URL(calls[0].url).pathname).toBe("/fapi/v1/order");
    expect(paramsOf(calls[0].url).get("origClientOrderId")).toBe(
      buildClientOrderId(SYNTHETIC_EXECUTION_ID, "ENTRY", 1)
    );
  });
});

describe("no generic mutation surface", () => {
  it("exposes only the four typed mutation methods", () => {
    const methods = Object.getOwnPropertyNames(BinanceUsdMExecutionClient.prototype).filter(
      (name) => name !== "constructor"
    );
    // Everything else on the prototype is a getter or a private helper; the
    // point is that no generic request/mutate entry point is public.
    for (const generic of ["request", "send", "call", "post", "delete", "signedRequest"]) {
      expect(methods).not.toContain(generic);
    }
    for (const approved of [
      "setIsolatedMarginType",
      "setInitialLeverage",
      "submitLimitEntry",
      "cancelReservedEntryOrder",
      "authorizeLiveEntry",
      "authorizeEntryCancellation",
    ]) {
      expect(methods).toContain(approved);
    }
  });

  it("has no method for any prohibited operation", () => {
    const methods = Object.getOwnPropertyNames(BinanceUsdMExecutionClient.prototype);
    for (const forbidden of [
      "setPositionMode",
      "setMultiAssetsMode",
      "modifyOrder",
      "batchOrders",
      "cancelAllOpenOrders",
      "submitMarketEntry",
      "submitStopLoss",
      "submitTakeProfit",
      "emergencyClose",
      "addPositionMargin",
      "transfer",
    ]) {
      expect(methods).not.toContain(forbidden);
    }
  });
});
