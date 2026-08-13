import { describe, expect, it } from "vitest";
import {
  ALLOWED_ALGO_TYPE,
  ALLOWED_PROTECTION_ORDER_TYPES,
  BINANCE_MUTATION_ENDPOINTS,
  FORBIDDEN_PROTECTION_PARAMS,
  MARGIN_ADD_TYPE,
  allowedMutationPairs,
  isAllowedMutation,
} from "../src/modules/binance/binance-execution.endpoints";
import {
  BinanceMutationViolationError,
  BinanceUsdMExecutionClient,
  type MutationTransport,
} from "../src/modules/binance/binance-execution.client";
import { BinanceReadOnlyClient, signQuery } from "../src/modules/binance/binance.client";
import { buildClientOrderId } from "../src/modules/execution/execution-safety";
import { classifyMutationOutcome } from "../src/modules/execution/entry-lifecycle";
import * as binanceEndpoints from "../src/modules/binance/binance-execution.endpoints";

/**
 * Phase 7 Algo / margin / emergency mutation-client tests.
 *
 * Every test injects a deterministic fake transport — no test here can reach
 * Binance. Credentials are obviously synthetic.
 */

const FAKE_KEY = "synthetic-api-key-000000000000";
const FAKE_SECRET = "synthetic-api-secret-0000000000";
const BASE_URL = "https://testnet.binancefuture.example";
const EXECUTION_ID = "synthetic-execution-p7-0001";
const SYMBOL = "SYNTHUSDT";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function recorder(responder: () => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const transport: MutationTransport = async (url, init) => {
    calls.push({ url, method: String(init.method), headers: (init.headers ?? {}) as Record<string, string> });
    return responder();
  };
  return { calls, transport };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function readOnlyStub(): BinanceReadOnlyClient {
  const client = new BinanceReadOnlyClient({
    baseUrl: BASE_URL,
    apiKey: FAKE_KEY,
    apiSecret: FAKE_SECRET,
    enabled: true,
  });
  Object.defineProperty(client, "clockOffsetMs", { get: () => 1234, configurable: true });
  (client as unknown as { syncTime: () => Promise<unknown> }).syncTime = async () => ({
    serverTimeMs: 0,
    offsetMs: 1234,
    roundTripMs: 0,
    syncedAt: Date.now(),
  });
  return client;
}

/**
 * Phase 7 mutations are risk-reducing, so the gates are irrelevant to them.
 * Tests default the gates CLOSED to prove exactly that.
 */
function client(options: {
  transport: MutationTransport;
  liveEntryEnabled?: boolean;
  protectionReady?: boolean;
}): BinanceUsdMExecutionClient {
  return new BinanceUsdMExecutionClient({
    readOnlyClient: readOnlyStub(),
    baseUrl: BASE_URL,
    apiKey: FAKE_KEY,
    apiSecret: FAKE_SECRET,
    recvWindowMs: 5000,
    liveEntryEnabled: options.liveEntryEnabled ?? false,
    protectionReady: options.protectionReady ?? false,
    transport: options.transport,
  });
}

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

function stopContext(instance: BinanceUsdMExecutionClient, generation = 1) {
  return instance.authorizeProtectionSubmission({
    executionId: EXECUTION_ID,
    symbol: SYMBOL,
    role: "STOP_LOSS",
    generation,
    clientAlgoId: buildClientOrderId(EXECUTION_ID, "STOP_LOSS", generation),
    side: "SELL",
    positionSide: "LONG",
    quantity: "0.100",
    triggerPrice: "96",
    workingType: "MARK_PRICE",
    priceProtect: false,
  });
}

// ---------------------------------------------------------------------------

describe("Phase 7 mutation allowlist", () => {
  it("contains exactly the seven approved (method, path) pairs", () => {
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

  it("still rejects every prohibited path", () => {
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
      expect(isAllowedMutation("DELETE", path)).toBe(false);
    }
  });

  it("allows only STOP_MARKET and TAKE_PROFIT_MARKET protection types", () => {
    expect([...ALLOWED_PROTECTION_ORDER_TYPES]).toEqual(["STOP_MARKET", "TAKE_PROFIT_MARKET"]);
    expect(ALLOWED_ALGO_TYPE).toBe("CONDITIONAL");
  });

  it("hardcodes margin type 1 (ADD) with no representation for removal", () => {
    expect(MARGIN_ADD_TYPE).toBe(1);
    const source = Object.values(BINANCE_MUTATION_ENDPOINTS).map((endpoint) => endpoint.path);
    expect(source).toContain("/fapi/v1/positionMargin");
  });

  it("names the parameters that may never appear on protection", () => {
    for (const forbidden of ["reduceOnly", "price", "priceMatch", "activationPrice", "callbackRate"]) {
      expect(FORBIDDEN_PROTECTION_PARAMS).toContain(forbidden);
    }
  });
});

describe("protection submission", () => {
  it("sends a CONDITIONAL STOP_MARKET with the exact frozen values", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ algoId: 55, clientAlgoId: "x", algoStatus: "NEW" }));
    const instance = client({ transport });
    await instance.submitProtectionOrder(stopContext(instance));

    const params = paramsOf(calls[0].url);
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe("/fapi/v1/algoOrder");
    expect(params.get("algoType")).toBe("CONDITIONAL");
    expect(params.get("type")).toBe("STOP_MARKET");
    expect(params.get("side")).toBe("SELL");
    expect(params.get("positionSide")).toBe("LONG");
    expect(params.get("quantity")).toBe("0.100");
    // POST /fapi/v1/algoOrder takes triggerPrice; stopPrice is the LEGACY
    // standard-order field and must never appear here again.
    expect(params.get("triggerPrice")).toBe("96");
    expect(params.has("stopPrice")).toBe(false);
    expect(params.get("priceProtect")).toBe("false");
    expect(params.get("closePosition")).toBe("false");
    expect(params.get("symbol")).toBe(SYMBOL);
    expect(params.has("reduceOnly")).toBe(false);
    expect(params.get("workingType")).toBe("MARK_PRICE");
    expect(params.get("newOrderRespType")).toBe("ACK");
    expect(params.get("clientAlgoId")).toBe(buildClientOrderId(EXECUTION_ID, "STOP_LOSS", 1));
  });

  it("sends TAKE_PROFIT_MARKET for the take-profit role", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    await instance.submitProtectionOrder(
      instance.authorizeProtectionSubmission({
        executionId: EXECUTION_ID,
        symbol: SYMBOL,
        role: "TAKE_PROFIT",
        generation: 1,
        clientAlgoId: buildClientOrderId(EXECUTION_ID, "TAKE_PROFIT", 1),
        side: "SELL",
        positionSide: "LONG",
        quantity: "0.100",
        triggerPrice: "108",
        workingType: "CONTRACT_PRICE",
        priceProtect: false,
      })
    );
    const tp = paramsOf(calls[0].url);
    expect(tp.get("algoType")).toBe("CONDITIONAL");
    expect(tp.get("type")).toBe("TAKE_PROFIT_MARKET");
    expect(tp.get("side")).toBe("SELL");
    expect(tp.get("positionSide")).toBe("LONG");
    expect(tp.get("quantity")).toBe("0.100");
    // The same trigger contract as STOP_MARKET.
    expect(tp.get("triggerPrice")).toBe("108");
    expect(tp.has("stopPrice")).toBe(false);
    expect(tp.get("workingType")).toBe("CONTRACT_PRICE");
    expect(tp.get("priceProtect")).toBe("false");
    expect(tp.get("closePosition")).toBe("false");
    expect(tp.get("newOrderRespType")).toBe("ACK");
    expect(tp.get("clientAlgoId")).toBe(buildClientOrderId(EXECUTION_ID, "TAKE_PROFIT", 1));
    expect(tp.has("reduceOnly")).toBe(false);
  });

  it("refuses structurally if a regression ever puts stopPrice back on the algo request", () => {
    const { FORBIDDEN_PROTECTION_PARAMS } = binanceEndpoints;
    // The guard is the endpoints allowlist, so the failure happens before any
    // request is built rather than at the exchange.
    expect(FORBIDDEN_PROTECTION_PARAMS).toContain("stopPrice");
    expect(FORBIDDEN_PROTECTION_PARAMS).toContain("reduceOnly");
  });

  it("maps SHORT protection to BUY on positionSide SHORT", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    await instance.submitProtectionOrder(
      instance.authorizeProtectionSubmission({
        executionId: EXECUTION_ID,
        symbol: SYMBOL,
        role: "STOP_LOSS",
        generation: 1,
        clientAlgoId: buildClientOrderId(EXECUTION_ID, "STOP_LOSS", 1),
        side: "BUY",
        positionSide: "SHORT",
        quantity: "0.100",
        triggerPrice: "104",
        workingType: "MARK_PRICE",
        priceProtect: false,
      })
    );
    expect(paramsOf(calls[0].url).get("side")).toBe("BUY");
    expect(paramsOf(calls[0].url).get("positionSide")).toBe("SHORT");
  });

  it("never sends reduceOnly, price or trailing parameters", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    await instance.submitProtectionOrder(stopContext(instance));

    const params = paramsOf(calls[0].url);
    for (const forbidden of FORBIDDEN_PROTECTION_PARAMS) {
      expect(params.has(forbidden)).toBe(false);
    }
  });

  it("never sends closePosition=true", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    await instance.submitProtectionOrder(stopContext(instance));
    expect(paramsOf(calls[0].url).get("closePosition")).toBe("false");
  });

  it("refuses a side that would increase exposure", () => {
    const { transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    expect(() =>
      instance.authorizeProtectionSubmission({
        executionId: EXECUTION_ID,
        symbol: SYMBOL,
        role: "STOP_LOSS",
        generation: 1,
        clientAlgoId: buildClientOrderId(EXECUTION_ID, "STOP_LOSS", 1),
        side: "BUY", // opening side for a LONG
        positionSide: "LONG",
        quantity: "0.1",
        triggerPrice: "96",
        workingType: "MARK_PRICE",
        priceProtect: false,
      })
    ).toThrow(BinanceMutationViolationError);
  });

  it("refuses a client algo id that is not this execution's tranche", () => {
    const { transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    expect(() =>
      instance.authorizeProtectionSubmission({
        executionId: EXECUTION_ID,
        symbol: SYMBOL,
        role: "STOP_LOSS",
        generation: 1,
        clientAlgoId: "tad-sl-1-ffffffffffff",
        side: "SELL",
        positionSide: "LONG",
        quantity: "0.1",
        triggerPrice: "96",
        workingType: "MARK_PRICE",
        priceProtect: false,
      })
    ).toThrow(BinanceMutationViolationError);
  });

  it("refuses a non-positive quantity or trigger", () => {
    const { transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    for (const bad of [{ quantity: "0" }, { triggerPrice: "0" }]) {
      expect(() =>
        instance.authorizeProtectionSubmission({
          executionId: EXECUTION_ID,
          symbol: SYMBOL,
          role: "STOP_LOSS",
          generation: 1,
          clientAlgoId: buildClientOrderId(EXECUTION_ID, "STOP_LOSS", 1),
          side: "SELL",
          positionSide: "LONG",
          quantity: "0.1",
          triggerPrice: "96",
          workingType: "MARK_PRICE",
          priceProtect: false,
          ...bad,
        })
      ).toThrow(BinanceMutationViolationError);
    }
  });

  it("rejects a forged protection context", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    await expect(instance.submitProtectionOrder({ symbol: SYMBOL } as never)).rejects.toBeInstanceOf(
      BinanceMutationViolationError
    );
    expect(calls).toHaveLength(0);
  });
});

describe("risk-reducing operations survive closed gates", () => {
  it("submits protection while both live gates are false", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ algoId: 1 }));
    const instance = client({ transport, liveEntryEnabled: false, protectionReady: false });
    await instance.submitProtectionOrder(stopContext(instance));
    expect(calls).toHaveLength(1);
  });

  it("cancels protection while both gates are false", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ algoStatus: "CANCELED" }));
    const instance = client({ transport });
    await instance.cancelProtectionOrder(
      instance.authorizeProtectionCancellation({
        executionId: EXECUTION_ID,
        symbol: SYMBOL,
        role: "STOP_LOSS",
        generation: 1,
        clientAlgoId: buildClientOrderId(EXECUTION_ID, "STOP_LOSS", 1),
      })
    );
    expect(calls[0].method).toBe("DELETE");
    expect(new URL(calls[0].url).pathname).toBe("/fapi/v1/algoOrder");
  });

  it("adds margin while both gates are false", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ code: 200, msg: "Successfully modify position margin." }));
    const instance = client({ transport });
    await instance.addIsolatedMargin(
      instance.authorizeMarginAddition({ symbol: SYMBOL, positionSide: "LONG", amount: "1.25" })
    );
    expect(calls).toHaveLength(1);
  });

  it("emergency-closes while both gates are false", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ orderId: 7, status: "NEW" }));
    const instance = client({ transport });
    await instance.submitEmergencyMarketClose(
      instance.authorizeEmergencyClose({
        executionId: EXECUTION_ID,
        symbol: SYMBOL,
        side: "SELL",
        positionSide: "LONG",
        quantity: "0.25",
        clientOrderId: buildClientOrderId(EXECUTION_ID, "EMERGENCY_CLOSE", 1),
      })
    );
    expect(calls).toHaveLength(1);
  });
});

describe("protection cancellation narrowing", () => {
  it("refuses an arbitrary client algo id", () => {
    const { transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    expect(() =>
      instance.authorizeProtectionCancellation({
        executionId: EXECUTION_ID,
        symbol: SYMBOL,
        role: "STOP_LOSS",
        generation: 1,
        clientAlgoId: "someone-elses-algo-id",
      })
    ).toThrow(BinanceMutationViolationError);
  });

  it("refuses a non-protection role", () => {
    const { transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    expect(() =>
      instance.authorizeProtectionCancellation({
        executionId: EXECUTION_ID,
        symbol: SYMBOL,
        role: "ENTRY" as never,
        generation: 1,
        clientAlgoId: buildClientOrderId(EXECUTION_ID, "ENTRY", 1),
      })
    ).toThrow(BinanceMutationViolationError);
  });

  it("takes the symbol and id from the context, never the call site", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    await instance.cancelProtectionOrder(
      instance.authorizeProtectionCancellation({
        executionId: EXECUTION_ID,
        symbol: SYMBOL,
        role: "TAKE_PROFIT",
        generation: 2,
        clientAlgoId: buildClientOrderId(EXECUTION_ID, "TAKE_PROFIT", 2),
      })
    );
    const params = paramsOf(calls[0].url);
    expect(params.get("symbol")).toBe(SYMBOL);
    expect(params.get("clientAlgoId")).toBe(buildClientOrderId(EXECUTION_ID, "TAKE_PROFIT", 2));
  });
});

describe("margin addition", () => {
  it("always sends type=1 with the correct position side", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ code: 200 }));
    const instance = client({ transport });
    await instance.addIsolatedMargin(
      instance.authorizeMarginAddition({ symbol: SYMBOL, positionSide: "SHORT", amount: "2.5" })
    );

    const params = paramsOf(calls[0].url);
    expect(params.get("type")).toBe("1");
    expect(params.get("positionSide")).toBe("SHORT");
    expect(params.get("amount")).toBe("2.5");
    expect(new URL(calls[0].url).pathname).toBe("/fapi/v1/positionMargin");
  });

  it("offers no way to request type=2 (removal)", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    // The context carries no type field at all, so removal is inexpressible.
    const context = instance.authorizeMarginAddition({ symbol: SYMBOL, positionSide: "LONG", amount: "1" });
    expect("type" in (context as Record<string, unknown>)).toBe(false);
    await instance.addIsolatedMargin(context);
    expect(paramsOf(calls[0].url).get("type")).toBe("1");
  });

  it("refuses a non-positive amount", () => {
    const { transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    for (const amount of ["0", "-1", "abc"]) {
      expect(() => instance.authorizeMarginAddition({ symbol: SYMBOL, positionSide: "LONG", amount })).toThrow(
        BinanceMutationViolationError
      );
    }
  });

  it("rejects a forged margin context", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    await expect(instance.addIsolatedMargin({ symbol: SYMBOL, amount: "1" } as never)).rejects.toBeInstanceOf(
      BinanceMutationViolationError
    );
    expect(calls).toHaveLength(0);
  });
});

describe("emergency market close", () => {
  it("sends the exact quantity, opposite side and position side", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ orderId: 7 }));
    const instance = client({ transport });
    await instance.submitEmergencyMarketClose(
      instance.authorizeEmergencyClose({
        executionId: EXECUTION_ID,
        symbol: SYMBOL,
        side: "SELL",
        positionSide: "LONG",
        quantity: "0.250",
        clientOrderId: buildClientOrderId(EXECUTION_ID, "EMERGENCY_CLOSE", 1),
      })
    );

    const params = paramsOf(calls[0].url);
    expect(params.get("type")).toBe("MARKET");
    expect(params.get("side")).toBe("SELL");
    expect(params.get("positionSide")).toBe("LONG");
    expect(params.get("quantity")).toBe("0.250");
    expect(params.get("newOrderRespType")).toBe("ACK");
    expect(params.get("newClientOrderId")).toBe(buildClientOrderId(EXECUTION_ID, "EMERGENCY_CLOSE", 1));
  });

  it("sends no reduceOnly, closePosition, price, stopPrice or timeInForce", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    await instance.submitEmergencyMarketClose(
      instance.authorizeEmergencyClose({
        executionId: EXECUTION_ID,
        symbol: SYMBOL,
        side: "SELL",
        positionSide: "LONG",
        quantity: "0.25",
        clientOrderId: buildClientOrderId(EXECUTION_ID, "EMERGENCY_CLOSE", 1),
      })
    );
    const params = paramsOf(calls[0].url);
    for (const forbidden of ["reduceOnly", "closePosition", "price", "stopPrice", "timeInForce", "workingType"]) {
      expect(params.has(forbidden)).toBe(false);
    }
  });

  it("refuses a side that would open a position", () => {
    const { transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    expect(() =>
      instance.authorizeEmergencyClose({
        executionId: EXECUTION_ID,
        symbol: SYMBOL,
        side: "BUY",
        positionSide: "LONG",
        quantity: "0.25",
        clientOrderId: buildClientOrderId(EXECUTION_ID, "EMERGENCY_CLOSE", 1),
      })
    ).toThrow(BinanceMutationViolationError);
  });

  it("refuses a client order id from another execution", () => {
    const { transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    expect(() =>
      instance.authorizeEmergencyClose({
        executionId: "another-execution",
        symbol: SYMBOL,
        side: "SELL",
        positionSide: "LONG",
        quantity: "0.25",
        clientOrderId: buildClientOrderId(EXECUTION_ID, "EMERGENCY_CLOSE", 1),
      })
    ).toThrow(BinanceMutationViolationError);
  });

  it("rejects a forged emergency context", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    await expect(
      instance.submitEmergencyMarketClose({ symbol: SYMBOL, side: "SELL", quantity: "1" } as never)
    ).rejects.toBeInstanceOf(BinanceMutationViolationError);
    expect(calls).toHaveLength(0);
  });

  it("has no generic MARKET-order method", () => {
    const methods = Object.getOwnPropertyNames(BinanceUsdMExecutionClient.prototype);
    for (const generic of ["submitMarketOrder", "newMarketOrder", "submitOrder", "placeOrder", "request"]) {
      expect(methods).not.toContain(generic);
    }
  });
});

describe("signing and failure classification", () => {
  it("signs exactly the transmitted canonical query", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    await instance.submitProtectionOrder(stopContext(instance));

    const query = new URL(calls[0].url).search.slice(1);
    const [payload, signature] = query.split("&signature=");
    expect(signQuery(payload, FAKE_SECRET)).toBe(signature);
  });

  it("applies recvWindow and the Phase 2 clock offset", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    const before = Date.now();
    await instance.submitProtectionOrder(stopContext(instance));

    const params = paramsOf(calls[0].url);
    expect(params.get("recvWindow")).toBe("5000");
    expect(Number(params.get("timestamp"))).toBeGreaterThanOrEqual(before + 1234);
  });

  it("keeps the API key in the header and out of the URL", async () => {
    const { calls, transport } = recorder(() => jsonResponse({}));
    const instance = client({ transport });
    await instance.submitProtectionOrder(stopContext(instance));

    expect(calls[0].headers["X-MBX-APIKEY"]).toBe(FAKE_KEY);
    expect(calls[0].url).not.toContain(FAKE_KEY);
    expect(calls[0].url).not.toContain(FAKE_SECRET);
  });

  it("redacts the secret and signature from errors", async () => {
    const { transport } = recorder(() => jsonResponse({ code: -1022, msg: "Signature for this request is not valid." }, 401));
    const instance = client({ transport });
    const error = await instance.submitProtectionOrder(stopContext(instance)).catch((caught: Error) => caught);

    const text = String((error as Error).message);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toContain(FAKE_KEY);
  });

  it("classifies a timeout as an unknown result", async () => {
    const transport: MutationTransport = async () => {
      const abort = new Error("aborted");
      abort.name = "AbortError";
      throw abort;
    };
    const instance = client({ transport });
    const error = await instance.submitProtectionOrder(stopContext(instance)).catch((caught: { kind: string }) => caught);
    expect(classifyMutationOutcome({ kind: error.kind })).toBe("RESULT_UNKNOWN");
  });

  it("does not turn a 5xx into a confirmed failure", async () => {
    const { transport } = recorder(() => jsonResponse({ code: -1001, msg: "Internal error" }, 503));
    const instance = client({ transport });
    const error = await instance.submitProtectionOrder(stopContext(instance)).catch((caught: { kind: string }) => caught);
    expect(classifyMutationOutcome({ kind: error.kind, httpStatus: 503 })).toBe("RESULT_UNKNOWN");
  });

  it("treats 429 and 418 as retryable and never blind-retries", async () => {
    const { calls, transport } = recorder(() => jsonResponse({ code: -1003, msg: "Too many requests" }, 429));
    const instance = client({ transport });
    const error = await instance.submitProtectionOrder(stopContext(instance)).catch((caught: { kind: string }) => caught);

    expect(classifyMutationOutcome({ kind: error.kind })).toBe("QUERY_RETRYABLE");
    expect(calls).toHaveLength(1);
  });
});
