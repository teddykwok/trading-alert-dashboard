import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BINANCE_TESTNET_ORIGIN } from "../src/modules/binance/testnet-verifier/testnet-config";
import {
  createTestnetMutationClients,
  createTestnetProbeClients,
} from "../src/modules/binance/testnet-verifier/testnet-clients";
import { deriveIdentities } from "../src/modules/binance/testnet-verifier/testnet-identities";
import { protectionWorkingType, resolveProtectionPolicy } from "../src/modules/execution/protection-policy";
import { MemoryStateStore } from "../src/modules/binance/testnet-verifier/testnet-state";
import { formatRunReport } from "../src/modules/binance/testnet-verifier/testnet-report";
import {
  runProbe,
  runVerification,
  type VerifierDeps,
  type VerifierOptions,
} from "../src/modules/binance/testnet-verifier/testnet-verifier";

/**
 * Phase 20B end-to-end flow, against a FAKE exchange.
 *
 * `fetch` is stubbed globally, so no test here can reach any network. The
 * clients under test are the REAL ones built by `createTestnetClients`, which
 * means these tests exercise the genuine production request builders,
 * authorization factories, allowlists and forbidden-parameter checks — the
 * whole point of the verifier.
 */

const SYMBOL = "BTCUSDT";
const RUN_ID = "0123456789ab";
const IDS = deriveIdentities(RUN_ID);

interface Recorded {
  method: string;
  path: string;
  params: Record<string, string>;
}

/** Everything the verifier can ask the exchange, with scriptable behaviour. */
class FakeExchange {
  readonly calls: Recorded[] = [];

  positionMode = "HEDGE";
  markPrice = "50000.0";
  longPositionAmt = "0";
  shortPositionAmt = "0";

  algoOrders = new Map<string, Record<string, unknown>>();
  standardOrders = new Map<string, Record<string, unknown>>();

  /** Simulates the demo host not serving the Algo route at all. */
  algoRouteMissing = false;
  /** Simulates -1104 when the undocumented `symbol` parameter is present. */
  rejectSymbolOnAlgoQuery = false;
  rejectSymbolOnAlgoCancel = false;
  /** One-shot failures, keyed by "METHOD path". */
  failOnce = new Map<string, { status: number; code: number; msg: string }>();
  /** Entry fills automatically on submission. */
  entryFills = true;
  /** Pre-existing foreign orders seen by the baseline reads. */
  foreignStandardOpenOrders = 0;
  foreignAlgoOpenOrders = 0;
  /** Baseline reads that cannot be completed at all. */
  openOrdersUnreadable = false;
  openAlgoOrdersUnreadable = false;
  /** A 200 response whose BODY is unreadable (set to the body to send). */
  openAlgoOrdersMalformed: unknown = null;
  /** Algo queries for these exact ids answer 5xx (state UNKNOWN, not absent). */
  unreadableAlgoIds = new Set<string>();
  /** Position reads that cannot be completed at all. */
  positionUnreadable = false;
  /** Makes the algo readback report closePosition=true (a real contradiction). */
  closePositionOnAlgoReadback = false;
  /** Substitutes a contradictory workingType for ONE role on readback. */
  corruptAlgoWorkingType: { orderType: string; workingType: string } | null = null;
  /** Substitutes a contradictory triggerPrice into the algo readback. */
  corruptAlgoTriggerPrice: string | null = null;
  /** Position read fails only AFTER the emergency close. */
  positionUnreadableAfterClose = false;
  private closed = false;

  get mutations(): Recorded[] {
    return this.calls.filter((call) => call.method === "POST" || call.method === "DELETE");
  }

  handler = async (rawUrl: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(rawUrl);
    const method = String(init?.method ?? "GET");
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      if (key !== "signature" && key !== "timestamp" && key !== "recvWindow") params[key] = value;
    });
    this.calls.push({ method, path: url.pathname, params });

    const key = `${method} ${url.pathname}`;
    const scripted = this.failOnce.get(key);
    if (scripted) {
      this.failOnce.delete(key);
      return json({ code: scripted.code, msg: scripted.msg }, scripted.status);
    }

    return this.route(method, url.pathname, params);
  };

  private route(method: string, path: string, params: Record<string, string>): Response {
    switch (`${method} ${path}`) {
      case "GET /fapi/v1/ping":
        return json({});
      case "GET /fapi/v1/time":
        return json({ serverTime: Date.now() });
      case "GET /fapi/v3/balance":
        return json([{ asset: "USDT", balance: "1000", availableBalance: "1000" }]);
      case "GET /fapi/v1/positionSide/dual":
        return json({ dualSidePosition: this.positionMode === "HEDGE" });
      case "GET /fapi/v1/openOrders":
        // Only the SYMBOL-scoped baseline read is made unreadable; the
        // account-wide read inside getAccountSummary keeps working, so the
        // test isolates the baseline failure from the credentials check.
        if (this.openOrdersUnreadable && params.symbol !== undefined) {
          return json({ code: -1001, msg: "Internal error." }, 503);
        }
        return json(
          Array.from({ length: this.foreignStandardOpenOrders }, (_, index) => ({
            symbol: SYMBOL,
            clientOrderId: `foreign-standard-${index}`,
            status: "NEW",
          }))
        );
      case "GET /fapi/v1/openAlgoOrders":
        if (this.openAlgoOrdersUnreadable) return json({ code: -1001, msg: "Internal error." }, 503);
        // A 200 carrying a body the normalizer cannot fully read. This is the
        // dangerous case: it looks like success.
        if (this.openAlgoOrdersMalformed) return json(this.openAlgoOrdersMalformed, 200);
        return json(
          Array.from({ length: this.foreignAlgoOpenOrders }, (_, index) => ({
            symbol: SYMBOL,
            algoId: 900 + index,
            clientAlgoId: `foreign-algo-${index}`,
            algoStatus: "NEW",
          }))
        );
      case "GET /fapi/v1/premiumIndex":
        return json({ symbol: params.symbol, markPrice: this.markPrice, indexPrice: this.markPrice });
      case "GET /fapi/v3/positionRisk":
        if (this.positionUnreadable || (this.closed && this.positionUnreadableAfterClose)) {
          return json({ code: -1001, msg: "Internal error." }, 503);
        }
        return json([
          { symbol: SYMBOL, positionSide: "LONG", positionAmt: this.longPositionAmt, markPrice: this.markPrice, entryPrice: this.markPrice },
          { symbol: SYMBOL, positionSide: "SHORT", positionAmt: this.shortPositionAmt, markPrice: this.markPrice, entryPrice: this.markPrice },
        ]);
      case "GET /fapi/v1/exchangeInfo":
        return json({
          symbols: [
            {
              symbol: SYMBOL,
              status: "TRADING",
              contractType: "PERPETUAL",
              orderTypes: ["LIMIT", "MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"],
              timeInForce: ["GTC"],
              filters: [
                { filterType: "PRICE_FILTER", tickSize: "0.10", minPrice: "1", maxPrice: "1000000" },
                { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "100" },
                { filterType: "MIN_NOTIONAL", notional: "100" },
              ],
            },
          ],
        });
      case "GET /fapi/v1/leverageBracket":
        return json([{ symbol: SYMBOL, brackets: [{ bracket: 1, initialLeverage: 50, notionalCap: "10000", notionalFloor: "0", maintMarginRatio: "0.01", cum: "0" }] }]);
      case "GET /fapi/v1/symbolConfig":
        return json([{ symbol: SYMBOL, marginType: "ISOLATED", leverage: 10 }]);

      case "POST /fapi/v1/order":
        return this.newStandardOrder(params);
      case "GET /fapi/v1/order": {
        const order = this.standardOrders.get(params.origClientOrderId ?? "");
        return order ? json(order) : json({ code: -2013, msg: "Order does not exist." }, 400);
      }
      case "DELETE /fapi/v1/order": {
        const id = params.origClientOrderId ?? "";
        const order = this.standardOrders.get(id);
        if (!order) return json({ code: -2011, msg: "Unknown order sent." }, 400);
        this.standardOrders.set(id, { ...order, status: "CANCELED" });
        return json({ ...order, status: "CANCELED" });
      }

      case "POST /fapi/v1/algoOrder":
        return this.newAlgoOrder(params);
      case "GET /fapi/v1/algoOrder":
        return this.queryAlgoOrder(params);
      case "DELETE /fapi/v1/algoOrder":
        return this.cancelAlgoOrder(params);

      default:
        return json({ code: -1121, msg: "Invalid symbol." }, 400);
    }
  }

  private newStandardOrder(params: Record<string, string>): Response {
    const id = params.newClientOrderId;
    const quantity = params.quantity;
    if (params.type === "MARKET") {
      // Emergency close: reduces the LONG position.
      this.longPositionAmt = "0";
      this.closed = true;
      this.standardOrders.set(id, { clientOrderId: id, symbol: SYMBOL, status: "FILLED", executedQty: quantity, origQty: quantity });
      return json({ orderId: 900, clientOrderId: id, symbol: SYMBOL, status: "NEW" });
    }
    const status = this.entryFills ? "FILLED" : "NEW";
    if (this.entryFills) this.longPositionAmt = quantity;
    this.standardOrders.set(id, {
      clientOrderId: id,
      symbol: SYMBOL,
      status,
      executedQty: this.entryFills ? quantity : "0",
      origQty: quantity,
      avgPrice: params.price,
    });
    return json({ orderId: 100, clientOrderId: id, symbol: SYMBOL, status: "NEW" });
  }

  private newAlgoOrder(params: Record<string, string>): Response {
    if (this.algoRouteMissing) return json({ code: -1121, msg: "Invalid symbol." }, 400);
    const id = params.clientAlgoId;
    this.algoOrders.set(id, {
      algoId: 500 + this.algoOrders.size,
      clientAlgoId: id,
      symbol: params.symbol,
      algoStatus: "NEW",
      algoType: params.algoType,
      side: params.side,
      positionSide: params.positionSide,
      type: params.type,
      quantity: params.quantity,
      triggerPrice: this.corruptAlgoTriggerPrice ?? params.triggerPrice,
      workingType:
        this.corruptAlgoWorkingType && this.corruptAlgoWorkingType.orderType === params.type
          ? this.corruptAlgoWorkingType.workingType
          : params.workingType,
      priceProtect: params.priceProtect === "true",
      closePosition: this.closePositionOnAlgoReadback ? true : params.closePosition === "true",
      // Binance sets reduceOnly ITSELF on a hedge-mode closing conditional
      // order and reports it back as true, even though we never send it.
      // Proven against mainnet order tad-sl-1-ed8fa3f5d4f2. Modelling this
      // faithfully is what makes the demo verifier able to catch the
      // Canary #2 class of identity defect.
      reduceOnly: true,
    });
    return json({ algoId: 500, clientAlgoId: id, symbol: params.symbol, algoStatus: "NEW" });
  }

  private queryAlgoOrder(params: Record<string, string>): Response {
    if (this.algoRouteMissing) return json({ code: -1121, msg: "Invalid symbol." }, 400);
    if (this.unreadableAlgoIds.has(params.clientAlgoId ?? "")) {
      return json({ code: -1001, msg: "Internal error." }, 503);
    }
    // The undocumented `symbol` parameter, if the fake is set to reject it.
    if (this.rejectSymbolOnAlgoQuery && params.symbol !== undefined) {
      return json({ code: -1104, msg: "Not all sent parameters were read." }, 400);
    }
    const order = this.algoOrders.get(params.clientAlgoId ?? "");
    return order ? json(order) : json({ code: -2013, msg: "Order does not exist." }, 400);
  }

  private cancelAlgoOrder(params: Record<string, string>): Response {
    if (this.rejectSymbolOnAlgoCancel && params.symbol !== undefined) {
      return json({ code: -1104, msg: "Not all sent parameters were read." }, 400);
    }
    const id = params.clientAlgoId ?? "";
    const order = this.algoOrders.get(id);
    if (!order) return json({ code: -2013, msg: "Order does not exist." }, 400);
    this.algoOrders.set(id, { ...order, algoStatus: "CANCELLED" });
    return json({ algoId: order.algoId, clientAlgoId: id, code: 200, msg: "success" });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let exchange: FakeExchange;
let state: MemoryStateStore;

function buildDeps(store: MemoryStateStore = state): VerifierDeps {
  const clients = createTestnetMutationClients({
    baseUrl: BINANCE_TESTNET_ORIGIN,
    apiKey: "demo-key-00000000000000000",
    apiSecret: "demo-secret-000000000000000",
  });
  return {
    readOnly: clients.readOnly,
    mutations: clients.mutations,
    documented: clients.documented,
    state: store,
    identities: IDS,
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    sleep: async () => undefined,
    log: () => undefined,
  };
}

const OPTIONS: VerifierOptions = {
  mode: "MUTATE",
  symbol: SYMBOL,
  triggerOffsetBps: 1000,
  entryCrossBps: 20,
  fillPollAttempts: 3,
  fillPollIntervalMs: 0,
  // The real production policy: STOP on MARK_PRICE, TAKE_PROFIT on
  // CONTRACT_PRICE. Resolved through the shared production resolver so the
  // demo path cannot quietly diverge from mainnet.
  protectionPolicy: resolveProtectionPolicy({}),
};

beforeEach(() => {
  exchange = new FakeExchange();
  state = new MemoryStateStore();
  vi.stubGlobal("fetch", exchange.handler);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const algoPosts = () => exchange.calls.filter((c) => c.method === "POST" && c.path === "/fapi/v1/algoOrder");
const algoDeletes = () => exchange.calls.filter((c) => c.method === "DELETE" && c.path === "/fapi/v1/algoOrder");

// ---------------------------------------------------------------------------
// MODE A — probe only
// ---------------------------------------------------------------------------

describe("probe-only mode", () => {
  it("proves capability and performs ZERO mutations", async () => {
    const probe = await runProbe({ ...OPTIONS, mode: "PROBE_ONLY" }, buildDeps());

    expect(probe.TESTNET_HOST_VERIFIED).toBe(true);
    expect(probe.TESTNET_CREDENTIALS_WORK).toBe(true);
    expect(probe.HEDGE_MODE).toBe(true);
    expect(probe.BASELINE_POSITION_FLAT).toBe(true);
    expect(probe.MARK_PRICE_AVAILABLE).toBe(true);
    expect(probe.EXCHANGE_FILTERS_AVAILABLE).toBe(true);
    expect(probe.ALGO_QUERY_ENDPOINT_SUPPORTED).toBe(true);
    // The whole point of mode A.
    expect(exchange.mutations).toEqual([]);
  });

  it("reads mark price from the public premiumIndex endpoint", async () => {
    await runProbe({ ...OPTIONS, mode: "PROBE_ONLY" }, buildDeps());
    const call = exchange.calls.find((c) => c.path === "/fapi/v1/premiumIndex");
    expect(call?.method).toBe("GET");
    expect(call?.params.symbol).toBe(SYMBOL);
  });

  it("probes with an impossible identity that is never submitted", async () => {
    await runProbe({ ...OPTIONS, mode: "PROBE_ONLY" }, buildDeps());
    const probeQuery = exchange.calls.find(
      (c) => c.path === "/fapi/v1/algoOrder" && c.params.clientAlgoId === IDS.probeClientAlgoId
    );
    expect(probeQuery?.method).toBe("GET");
    // The documented form carries NO symbol.
    expect(probeQuery?.params.symbol).toBeUndefined();
    expect(exchange.algoOrders.size).toBe(0);
  });

  it("reports NOT supported when the Algo route is missing", async () => {
    exchange.algoRouteMissing = true;
    const probe = await runProbe({ ...OPTIONS, mode: "PROBE_ONLY" }, buildDeps());
    expect(probe.ALGO_QUERY_ENDPOINT_SUPPORTED).toBe(false);
    expect(exchange.mutations).toEqual([]);
  });

  it("records the production and documented query forms SEPARATELY", async () => {
    // The demo host serves the route but refuses the undocumented `symbol`.
    exchange.rejectSymbolOnAlgoQuery = true;
    const probe = await runProbe({ ...OPTIONS, mode: "PROBE_ONLY" }, buildDeps());

    expect(probe.DOCUMENTED_QUERY_FORM_ACCEPTED).toBe(true);
    expect(probe.ALGO_QUERY_ENDPOINT_SUPPORTED).toBe(true);
    // Endpoint support is NOT inferred from the production form working.
    expect(probe.PRODUCTION_QUERY_FORM_ACCEPTED).toBe(false);
    expect(probe.detail).toContain("symbol");
  });

  it("records both forms as working when the extra parameter is tolerated", async () => {
    const probe = await runProbe({ ...OPTIONS, mode: "PROBE_ONLY" }, buildDeps());
    expect(probe.DOCUMENTED_QUERY_FORM_ACCEPTED).toBe(true);
    expect(probe.PRODUCTION_QUERY_FORM_ACCEPTED).toBe(true);
  });

  it("does not treat a HEDGE-mode failure as an endpoint failure", async () => {
    exchange.positionMode = "ONE_WAY";
    const probe = await runProbe({ ...OPTIONS, mode: "PROBE_ONLY" }, buildDeps());
    expect(probe.HEDGE_MODE).toBe(false);
    expect(probe.ALGO_QUERY_ENDPOINT_SUPPORTED).toBe(true);
  });

  it("constructs NO mutation-capable client at all", () => {
    const probeClients = createTestnetProbeClients({
      baseUrl: BINANCE_TESTNET_ORIGIN,
      apiKey: "k",
      apiSecret: "s",
    });
    // The capability does not exist in the returned object...
    expect("mutations" in probeClients).toBe(false);
    // ...and the factory never even names the execution client.
    const source = readFileSync(
      path.join(process.cwd(), "src/modules/binance/testnet-verifier/testnet-clients.ts"),
      "utf8"
    );
    const body = source.slice(
      source.indexOf("export function createTestnetProbeClients"),
      source.indexOf("function assertDemoOrigin")
    );
    expect(body).not.toContain("BinanceUsdMExecutionClient");
    expect(body).not.toContain("liveEntryEnabled");
  });

  it("runs the probe with a deps object that has no mutation port", async () => {
    const probeClients = createTestnetProbeClients({
      baseUrl: BINANCE_TESTNET_ORIGIN,
      apiKey: "k",
      apiSecret: "s",
    });
    // ProbeDeps carries readOnly + documented only — there is nothing to call.
    const probe = await runProbe({ ...OPTIONS, mode: "PROBE_ONLY" }, {
      readOnly: probeClients.readOnly,
      documented: probeClients.documented,
      identities: IDS,
      log: () => undefined,
    });
    expect(probe.ALGO_QUERY_ENDPOINT_SUPPORTED).toBe(true);
    expect(exchange.mutations).toEqual([]);
  });

  it("reports open-order counts without ever cleaning them", async () => {
    exchange.foreignStandardOpenOrders = 2;
    exchange.foreignAlgoOpenOrders = 3;

    const probe = await runProbe({ ...OPTIONS, mode: "PROBE_ONLY" }, buildDeps());

    expect(probe.BASELINE_STANDARD_OPEN_ORDERS).toBe(2);
    expect(probe.BASELINE_ALGO_OPEN_ORDERS).toBe(3);
    expect(probe.BASELINE_CLEAN).toBe(false);
    // Reported, never touched.
    expect(exchange.mutations).toEqual([]);
  });

  it("reports an unreadable order count as UNREADABLE, never as zero", async () => {
    exchange.openAlgoOrdersUnreadable = true;
    const probe = await runProbe({ ...OPTIONS, mode: "PROBE_ONLY" }, buildDeps());
    expect(probe.BASELINE_ALGO_OPEN_ORDERS).toBeNull();
    expect(probe.BASELINE_CLEAN).toBe(false);
  });

  it("treats a MALFORMED 200 algo-order body as UNREADABLE, never as zero", async () => {
    // Each of these arrives as HTTP 200 and would previously have normalized
    // to [] — i.e. would have PROVEN an empty conditional book.
    for (const body of [
      { code: -1001, msg: "Internal error." },
      [{ clientAlgoId: "orphan-no-symbol", algoStatus: "NEW" }],
      [{ symbol: "ETHUSDT", algoId: 1, algoStatus: "NEW" }],
      [null],
      "not-an-array",
    ]) {
      exchange = new FakeExchange();
      vi.stubGlobal("fetch", exchange.handler);
      exchange.openAlgoOrdersMalformed = body;

      const probe = await runProbe({ ...OPTIONS, mode: "PROBE_ONLY" }, buildDeps());

      expect(probe.BASELINE_ALGO_OPEN_ORDERS, JSON.stringify(body)).toBeNull();
      expect(probe.BASELINE_CLEAN, JSON.stringify(body)).toBe(false);
      expect(probe.detail).toMatch(/algo open orders UNREADABLE/);
    }
  });

  it("reports an unreadable position as UNAVAILABLE, never as flat", async () => {
    exchange.positionUnreadable = true;
    const probe = await runProbe({ ...OPTIONS, mode: "PROBE_ONLY" }, buildDeps());
    expect(probe.baseline.longPosition).toBe("UNAVAILABLE");
    expect(probe.BASELINE_POSITION_FLAT).toBeNull();
    expect(probe.BASELINE_CLEAN).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MODE B — gates re-evaluated in-process
// ---------------------------------------------------------------------------

describe("mutation mode gates", () => {
  it("exits NOT_SUPPORTED with zero mutation when the Algo probe fails", async () => {
    exchange.algoRouteMissing = true;
    const report = await runVerification(OPTIONS, buildDeps());
    expect(report.verdict).toBe("NOT_SUPPORTED");
    expect(exchange.mutations).toEqual([]);
    expect(state.read()).toBeNull();
  });

  it("refuses to mutate when the account is not in HEDGE mode", async () => {
    exchange.positionMode = "ONE_WAY";
    const report = await runVerification(OPTIONS, buildDeps());
    expect(report.verdict).toBe("FAIL_SAFE");
    expect(report.failures.join(" ")).toMatch(/HEDGE/);
    expect(exchange.mutations).toEqual([]);
  });

  it("refuses to mutate on a dirty position baseline with no state file", async () => {
    exchange.longPositionAmt = "0.500";
    const report = await runVerification(OPTIONS, buildDeps());
    expect(report.verdict).toBe("FAIL_SAFE");
    expect(report.failures.join(" ")).toMatch(/baseline is not clean/i);
    expect(exchange.mutations).toEqual([]);
  });

  it("refuses a fresh run when standard open orders are non-zero", async () => {
    exchange.foreignStandardOpenOrders = 1;
    const report = await runVerification(OPTIONS, buildDeps());
    expect(report.verdict).toBe("FAIL_SAFE");
    expect(report.failures.join(" ")).toMatch(/1 standard open order/);
    expect(exchange.mutations).toEqual([]);
  });

  it("refuses a fresh run when algo open orders are non-zero", async () => {
    exchange.foreignAlgoOpenOrders = 2;
    const report = await runVerification(OPTIONS, buildDeps());
    expect(report.verdict).toBe("FAIL_SAFE");
    expect(report.failures.join(" ")).toMatch(/2 algo open order/);
    expect(exchange.mutations).toEqual([]);
  });

  it("refuses a fresh run when a MALFORMED 200 body hides the algo book", async () => {
    // The exact hazard: HTTP 200, so nothing throws, but the body cannot be
    // read. A count of 0 here would have unlocked a real mutation run.
    exchange.openAlgoOrdersMalformed = [{ clientAlgoId: "orphan", algoStatus: "NEW" }];

    const report = await runVerification(OPTIONS, buildDeps());

    expect(report.verdict).toBe("FAIL_SAFE");
    expect(report.probe.BASELINE_ALGO_OPEN_ORDERS).toBeNull();
    expect(report.failures.join(" ")).toMatch(/algo open orders UNREADABLE/);
    // Zero POST, zero DELETE.
    expect(exchange.mutations).toEqual([]);
  });

  it("refuses a fresh run when either order family is UNREADABLE", async () => {
    for (const toggle of ["openOrdersUnreadable", "openAlgoOrdersUnreadable"] as const) {
      exchange = new FakeExchange();
      vi.stubGlobal("fetch", exchange.handler);
      exchange[toggle] = true;

      const report = await runVerification(OPTIONS, buildDeps(new MemoryStateStore()));
      expect(report.verdict, toggle).toBe("FAIL_SAFE");
      expect(report.failures.join(" ")).toMatch(/UNREADABLE/);
      expect(exchange.mutations, toggle).toEqual([]);
    }
  });

  it("requires BOTH order families to be proven zero before a fresh run", async () => {
    // Positions flat and standard book empty, but the algo book is not.
    exchange.foreignAlgoOpenOrders = 1;
    expect((await runVerification(OPTIONS, buildDeps())).verdict).toBe("FAIL_SAFE");

    exchange = new FakeExchange();
    vi.stubGlobal("fetch", exchange.handler);
    const clean = await runVerification(OPTIONS, buildDeps(new MemoryStateStore()));
    expect(clean.probe.BASELINE_CLEAN).toBe(true);
    expect(clean.verdict).toBe("PASS");
  });

  it("refuses to mutate when a state file exists but cannot be parsed", async () => {
    state.unreadable = true;
    const report = await runVerification(OPTIONS, buildDeps());
    expect(report.verdict).toBe("MANUAL_TESTNET_CLEANUP_REQUIRED");
    expect(exchange.mutations).toEqual([]);
  });

  it("never trusts a stored probe result — every gate is re-run in-process", async () => {
    // A state file from a previous good run does not bypass the Algo probe.
    state.write({
      verifierVersion: "20B.1",
      runId: RUN_ID,
      origin: BINANCE_TESTNET_ORIGIN,
      symbol: SYMBOL,
      direction: "LONG",
      entryClientOrderId: IDS.entryClientOrderId,
      stopClientAlgoId: IDS.stopClientAlgoId,
      takeProfitClientAlgoId: IDS.takeProfitClientAlgoId,
      emergencyClientOrderId: IDS.emergencyClientOrderId,
      phase: "STOP_CONFIRMED",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    });
    exchange.algoRouteMissing = true;

    const report = await runVerification(OPTIONS, buildDeps());
    expect(report.verdict).toBe("NOT_SUPPORTED");
    expect(exchange.mutations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MODE B — the protection contract
// ---------------------------------------------------------------------------

describe("mutation flow", () => {
  it("completes the full contract and passes", async () => {
    const report = await runVerification(OPTIONS, buildDeps());
    expect(report.verdict).toBe("PASS");
    expect(report.failures).toEqual([]);
    expect(report.cleanup?.positionFlat).toBe(true);
    expect(report.cleanup?.stopResolved).toBe(true);
    expect(report.cleanup?.takeProfitResolved).toBe(true);
    // A clean run leaves no state behind.
    expect(state.read()).toBeNull();
  });

  it("submits a marketable LIMIT entry, never a MARKET entry", async () => {
    await runVerification(OPTIONS, buildDeps());
    const entry = exchange.calls.find(
      (c) => c.method === "POST" && c.path === "/fapi/v1/order" && c.params.newClientOrderId === IDS.entryClientOrderId
    );
    expect(entry?.params.type).toBe("LIMIT");
    expect(entry?.params.timeInForce).toBe("GTC");
    expect(entry?.params.positionSide).toBe("LONG");
    // 100 minNotional / 50000 mark = 0.002 on a 0.001 step grid.
    expect(entry?.params.quantity).toBe("0.002");
    // 50000 + 20bps = 50100, on the 0.10 tick grid.
    expect(entry?.params.price).toBe("50100.0");
  });

  // -------------------------------------------------------------------------
  // MAINNET CANARY #2 — the demo verifier must now catch this class of defect.
  // -------------------------------------------------------------------------

  it("MAINNET CANARY #2: passes end-to-end when Binance reports reduceOnly=true", async () => {
    // The fake exchange already echoes the mainnet shape (reduceOnly=true on
    // every algo readback), so a PASS here is a PASS against reality.
    const report = await runVerification(OPTIONS, buildDeps());

    expect(report.verdict).toBe("PASS");
    for (const observation of [report.stop, report.takeProfit]) {
      expect(observation?.reduceOnly).toBe(true);
      expect(observation?.closePosition).toBe(false);
      expect(observation?.confirmedActive).toBe(true);
      expect(observation?.confirmationReason).toMatch(/production identity comparator accepted/);
    }
  });

  it("MAINNET CANARY #2 (negative): fails when Binance reports closePosition=true", async () => {
    exchange.closePositionOnAlgoReadback = true;

    const report = await runVerification(OPTIONS, buildDeps());

    expect(report.verdict).not.toBe("PASS");
    expect(report.stop?.confirmedActive).toBe(false);
    expect(report.stop?.confirmationReason).toMatch(/production identity comparator rejected: closePosition/);
    // STOP-before-TP still holds: an unconfirmed stop never reaches the TP.
    expect(report.failures.join(" ")).toMatch(/take profit was deliberately not submitted/i);
  });

  it("fails whenever the production comparator rejects the readback", async () => {
    // A substituted trigger price is a genuine contradiction and must fail —
    // proving the verifier is bound to the production rules, not to a copy.
    exchange.corruptAlgoTriggerPrice = "99999.9";

    const report = await runVerification(OPTIONS, buildDeps());

    expect(report.verdict).not.toBe("PASS");
    expect(report.stop?.confirmedActive).toBe(false);
    expect(report.stop?.confirmationReason).toMatch(/triggerPrice/);
  });

  // -------------------------------------------------------------------------
  // Production working-type parity.
  //
  // Production sends a STOP on EXECUTION_SL_WORKING_TYPE and a
  // TAKE_PROFIT on EXECUTION_TP_WORKING_TYPE (CONTRACT_PRICE). The verifier
  // used to send MARK_PRICE for both, so the demo run never exercised the real
  // TAKE_PROFIT identity — and `workingType` is a field the production
  // comparator judges.
  // -------------------------------------------------------------------------

  it("A/B. submits each role with the PRODUCTION working type for that role", async () => {
    await runVerification(OPTIONS, buildDeps());

    const posts = algoPosts();
    const stop = posts.find((call) => call.params.type === "STOP_MARKET");
    const takeProfit = posts.find((call) => call.params.type === "TAKE_PROFIT_MARKET");

    expect(stop?.params.workingType).toBe(protectionWorkingType("STOP_LOSS", OPTIONS.protectionPolicy));
    expect(takeProfit?.params.workingType).toBe(protectionWorkingType("TAKE_PROFIT", OPTIONS.protectionPolicy));
    // With the shipped configuration, concretely:
    expect(stop?.params.workingType).toBe("CONTRACT_PRICE");
    expect(takeProfit?.params.workingType).toBe("CONTRACT_PRICE");
    // Both roles now resolve to CONTRACT_PRICE by policy. What must hold is
    // that each is resolved through the SHARED resolver above — the old bug was
    // the verifier hard-coding a value rather than asking the policy.
  });

  it("C. hands the same per-role working type to the production comparator", async () => {
    const report = await runVerification(OPTIONS, buildDeps());

    expect(report.verdict).toBe("PASS");
    // The comparator accepted, and what it compared is what was submitted.
    expect(report.stop?.workingType).toBe("CONTRACT_PRICE");
    expect(report.takeProfit?.workingType).toBe("CONTRACT_PRICE");
    expect(report.stop?.identityMismatches).toEqual([]);
    expect(report.takeProfit?.identityMismatches).toEqual([]);

    const submittedTp = algoPosts().find((call) => call.params.type === "TAKE_PROFIT_MARKET");
    expect(report.takeProfit?.workingType).toBe(submittedTp?.params.workingType);
  });

  it("D. fails with a workingType mismatch when the TP readback disagrees", async () => {
    // Binance echoes MARK_PRICE for the take profit while production expects
    // CONTRACT_PRICE. This must be caught, and only by the production rules.
    exchange.corruptAlgoWorkingType = { orderType: "TAKE_PROFIT_MARKET", workingType: "MARK_PRICE" };

    const report = await runVerification(OPTIONS, buildDeps());

    expect(report.verdict).not.toBe("PASS");
    expect(report.takeProfit?.confirmedActive).toBe(false);
    expect(report.takeProfit?.identityMismatches).toContain("workingType");
    expect(report.takeProfit?.confirmationReason).toMatch(/production identity comparator rejected: workingType/);
    // The STOP is unaffected — its own working type still matches.
    expect(report.stop?.identityMismatches).toEqual([]);
  });

  it("submits STOP_MARKET BEFORE TAKE_PROFIT_MARKET", async () => {
    await runVerification(OPTIONS, buildDeps());
    const posts = algoPosts();
    expect(posts).toHaveLength(2);
    expect(posts[0].params.type).toBe("STOP_MARKET");
    expect(posts[0].params.clientAlgoId).toBe(IDS.stopClientAlgoId);
    expect(posts[1].params.type).toBe("TAKE_PROFIT_MARKET");
    expect(posts[1].params.clientAlgoId).toBe(IDS.takeProfitClientAlgoId);
  });

  it("sends the exact documented Algo contract, with triggerPrice and no stopPrice", async () => {
    await runVerification(OPTIONS, buildDeps());
    const stop = algoPosts()[0].params;

    expect(stop.algoType).toBe("CONDITIONAL");
    expect(stop.symbol).toBe(SYMBOL);
    expect(stop.side).toBe("SELL");
    expect(stop.positionSide).toBe("LONG");
    expect(stop.type).toBe("STOP_MARKET");
    expect(stop.workingType).toBe("CONTRACT_PRICE");
    expect(stop.priceProtect).toBe("false");
    expect(stop.closePosition).toBe("false");
    expect(stop.newOrderRespType).toBe("ACK");
    // 50000 - 1000bps = 45000 on the 0.10 tick grid.
    expect(stop.triggerPrice).toBe("45000.0");
    // The legacy field that stranded the first real canary must never appear.
    expect(stop.stopPrice).toBeUndefined();
    expect(stop.reduceOnly).toBeUndefined();
  });

  it("protects the ACTUAL filled quantity, not the requested quantity", async () => {
    const deps = buildDeps();
    // The exchange fills only part of the request.
    const original = exchange.handler;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const response = await original(url, init);
      if (new URL(url).pathname === "/fapi/v1/order" && init?.method === "POST") {
        exchange.longPositionAmt = "0.001";
        const id = new URL(url).searchParams.get("newClientOrderId") as string;
        exchange.standardOrders.set(id, { clientOrderId: id, symbol: SYMBOL, status: "FILLED", executedQty: "0.001", origQty: "0.002" });
      }
      return response;
    });

    await runVerification(OPTIONS, deps);
    for (const post of algoPosts()) expect(post.params.quantity).toBe("0.001");
  });

  it("resolves an ambiguous STOP submission by querying the SAME id, never resubmitting", async () => {
    // The POST times out at the transport level after the order was created.
    const original = exchange.handler;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/algoOrder" && init?.method === "POST" && exchange.algoOrders.size === 0) {
        await original(url, init); // the exchange DID create it
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return original(url, init);
    });

    const report = await runVerification(OPTIONS, buildDeps());

    // Exactly ONE POST for the stop identity — no blind retry, no new id.
    const stopPosts = algoPosts().filter((c) => c.params.clientAlgoId === IDS.stopClientAlgoId);
    expect(stopPosts).toHaveLength(1);
    // And it was reconciled by asking about that same id.
    expect(
      exchange.calls.some((c) => c.method === "GET" && c.path === "/fapi/v1/algoOrder" && c.params.clientAlgoId === IDS.stopClientAlgoId)
    ).toBe(true);
    expect(report.stop?.clientId).toBe(IDS.stopClientAlgoId);
    // The take profit still followed, because the stop was CONFIRMED present.
    expect(algoPosts().some((c) => c.params.type === "TAKE_PROFIT_MARKET")).toBe(true);
  });

  it("NEVER submits the take profit when the stop cannot be confirmed", async () => {
    // Definitive rejection of the stop, and it does not exist afterwards.
    exchange.failOnce.set("POST /fapi/v1/algoOrder", { status: 400, code: -1102, msg: "Mandatory parameter missing." });

    const report = await runVerification(OPTIONS, buildDeps());

    expect(algoPosts().some((c) => c.params.type === "TAKE_PROFIT_MARKET")).toBe(false);
    expect(report.takeProfit).toBeNull();
    expect(report.failures.join(" ")).toMatch(/take profit was deliberately not submitted/i);
    expect(report.verdict).not.toBe("PASS");
  });

  it("generates no replacement identity anywhere in the run", async () => {
    await runVerification(OPTIONS, buildDeps());
    const submitted = new Set(algoPosts().map((c) => c.params.clientAlgoId));
    expect([...submitted].sort()).toEqual([IDS.stopClientAlgoId, IDS.takeProfitClientAlgoId].sort());
  });
});

// ---------------------------------------------------------------------------
// Cancellation, rescue and cleanup
// ---------------------------------------------------------------------------

describe("cancellation and cleanup", () => {
  it("cancels through the production form when it is accepted", async () => {
    const report = await runVerification(OPTIONS, buildDeps());
    expect(report.cancel?.rescueUsed).toBe(false);
    expect(report.cancel?.stop?.productionFormResult).toBe("ACCEPTED");
    // Production cancels carry `symbol`; the rescue form does not.
    expect(algoDeletes().every((c) => c.params.symbol === SYMBOL)).toBe(true);
  });

  it("uses the documented rescue ONLY after a definitive parameter rejection", async () => {
    exchange.rejectSymbolOnAlgoCancel = true;

    const report = await runVerification(OPTIONS, buildDeps());

    expect(report.cancel?.rescueUsed).toBe(true);
    expect(report.cancel?.stop?.productionFormResult).toMatch(/^PRODUCTION_FORM_REJECTED/);
    // The rescue DELETE carries clientAlgoId and no symbol.
    const rescue = algoDeletes().filter((c) => c.params.symbol === undefined);
    expect(rescue.length).toBeGreaterThan(0);
    expect(rescue[0].params.clientAlgoId).toBe(IDS.stopClientAlgoId);
  });

  it("never uses the rescue after an AMBIGUOUS cancel — it queries the same id first", async () => {
    // A 5xx is ambiguous, not a parameter-contract rejection.
    exchange.failOnce.set("DELETE /fapi/v1/algoOrder", { status: 503, code: -1001, msg: "Internal error." });

    const report = await runVerification(OPTIONS, buildDeps());

    expect(report.cancel?.rescueUsed).toBe(false);
    expect(report.cancel?.stop?.productionFormResult).toBe("AMBIGUOUS");

    // After the failed DELETE the next call for that id must be a GET.
    const index = exchange.calls.findIndex((c) => c.method === "DELETE" && c.path === "/fapi/v1/algoOrder");
    const following = exchange.calls
      .slice(index + 1)
      .find((c) => c.path === "/fapi/v1/algoOrder" && c.params.clientAlgoId === IDS.stopClientAlgoId);
    expect(following?.method).toBe("GET");
  });

  // -------------------------------------------------------------------------
  // An accepted DELETE is an acknowledgement, not a terminal state.
  // -------------------------------------------------------------------------

  it("reconciles the SAME id after an accepted DELETE instead of trusting it", async () => {
    const report = await runVerification(OPTIONS, buildDeps());

    expect(report.cancel?.stop?.accepted).toBe(true);
    expect(report.cancel?.stop?.queryAttempts).toBeGreaterThanOrEqual(1);
    // The DELETE is followed by a GET for the same identity.
    const deleteIndex = exchange.calls.findIndex(
      (c) => c.method === "DELETE" && c.params.clientAlgoId === IDS.stopClientAlgoId
    );
    const followingQuery = exchange.calls
      .slice(deleteIndex + 1)
      .findIndex((c) => c.method === "GET" && c.params.clientAlgoId === IDS.stopClientAlgoId);
    expect(followingQuery).toBeGreaterThanOrEqual(0);
  });

  it("accepted DELETE then CANCELLED status -> resolved", async () => {
    const report = await runVerification(OPTIONS, buildDeps());
    expect(report.cancel?.stop?.finalStatus).toBe("CANCELLED");
    expect(report.cancel?.stop?.finalOutcome).toBe("IDENTITY_FOUND_STATUS_TERMINAL");
    expect(report.cancel?.stop?.resolved).toBe(true);
    expect(report.cleanup?.stopResolved).toBe(true);
  });

  it("accepted DELETE then -2013 -> resolved as absent", async () => {
    const original = exchange.handler;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const response = await original(url, init);
      // The row disappears entirely once cancelled.
      if (new URL(url).pathname === "/fapi/v1/algoOrder" && init?.method === "DELETE") {
        exchange.algoOrders.delete(new URL(url).searchParams.get("clientAlgoId") as string);
      }
      return response;
    });

    const report = await runVerification(OPTIONS, buildDeps());

    expect(report.cancel?.stop?.finalOutcome).toBe("ABSENT_CONFIRMED");
    expect(report.cancel?.stop?.resolved).toBe(true);
    expect(report.verdict).toBe("PASS");
  });

  it("accepted DELETE but still NEW -> queries again and NEVER sends a second DELETE", async () => {
    const original = exchange.handler;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      // The DELETE succeeds but the order stubbornly stays NEW.
      if (parsed.pathname === "/fapi/v1/algoOrder" && init?.method === "DELETE") {
        const id = parsed.searchParams.get("clientAlgoId") as string;
        const order = exchange.algoOrders.get(id);
        exchange.calls.push({ method: "DELETE", path: parsed.pathname, params: { clientAlgoId: id } });
        return new Response(JSON.stringify({ algoId: 1, clientAlgoId: id, code: 200, msg: "success" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
        void order;
      }
      return original(url, init);
    });

    const report = await runVerification({ ...OPTIONS, fillPollAttempts: 3 }, buildDeps());

    const stopDeletes = exchange.calls.filter(
      (c) => c.method === "DELETE" && c.params.clientAlgoId === IDS.stopClientAlgoId
    );
    // Exactly ONE DELETE, however many times the query said NEW.
    expect(stopDeletes).toHaveLength(1);
    expect(report.cancel?.stop?.queryAttempts).toBeGreaterThan(1);
    expect(report.cancel?.stop?.resolved).toBe(false);
    expect(report.verdict).toBe("MANUAL_TESTNET_CLEANUP_REQUIRED");
    expect(report.stateRetained).toBe(true);
  });

  it(
    "accepted DELETE then repeated UNKNOWN -> state retained, no second DELETE",
    async () => {
      exchange.unreadableAlgoIds.add(IDS.stopClientAlgoId);

      // A single attempt: each unreadable query costs the read-only client's
      // full internal retry budget (~1.5s of backoff), so a high poll count
      // multiplies real wall-clock time on a genuinely unreachable identity.
      const report = await runVerification({ ...OPTIONS, fillPollAttempts: 1 }, buildDeps());

      const stopDeletes = exchange.calls.filter(
        (c) => c.method === "DELETE" && c.params.clientAlgoId === IDS.stopClientAlgoId
      );
      expect(stopDeletes.length).toBeLessThanOrEqual(1);
      expect(report.cleanup?.stopResolved).toBe(false);
      expect(report.stateRetained).toBe(true);
      expect(state.read()).not.toBeNull();
    },
    30_000
  );

  it("never calls any cancel-all endpoint", async () => {
    await runVerification(OPTIONS, buildDeps());
    for (const call of exchange.calls) {
      expect(call.path).not.toBe("/fapi/v1/algoOpenOrders");
      expect(call.path).not.toBe("/fapi/v1/allOpenOrders");
      expect(call.path).not.toBe("/fapi/v1/batchOrders");
    }
  });

  it("touches only identities this run derived", async () => {
    await runVerification(OPTIONS, buildDeps());
    const owned = new Set([
      IDS.entryClientOrderId,
      IDS.stopClientAlgoId,
      IDS.takeProfitClientAlgoId,
      IDS.emergencyClientOrderId,
      IDS.probeClientAlgoId,
    ]);
    for (const call of exchange.mutations) {
      const identity = call.params.clientAlgoId ?? call.params.newClientOrderId ?? call.params.origClientOrderId;
      expect(owned.has(identity as string), `${call.method} ${call.path} ${identity}`).toBe(true);
    }
  });

  it("closes ONLY the position it created, using the emergency-close builder", async () => {
    await runVerification(OPTIONS, buildDeps());
    const close = exchange.calls.find(
      (c) => c.method === "POST" && c.path === "/fapi/v1/order" && c.params.type === "MARKET"
    );
    expect(close?.params.newClientOrderId).toBe(IDS.emergencyClientOrderId);
    expect(close?.params.side).toBe("SELL");
    expect(close?.params.positionSide).toBe("LONG");
    expect(close?.params.quantity).toBe("0.002");
  });

  it("refuses to close exposure that does not match what it created", async () => {
    const original = exchange.handler;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const response = await original(url, init);
      // Somebody else adds exposure after the verifier's own fill.
      if (new URL(url).pathname === "/fapi/v1/algoOrder" && init?.method === "DELETE") {
        exchange.longPositionAmt = "9.999";
      }
      return response;
    });

    const report = await runVerification(OPTIONS, buildDeps());

    expect(report.cleanup?.positionFlat).toBe(false);
    expect(report.verdict).toBe("MANUAL_TESTNET_CLEANUP_REQUIRED");
    // No MARKET close was attempted against the foreign exposure.
    expect(exchange.calls.some((c) => c.method === "POST" && c.params.type === "MARKET")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A failed read is never proof of flatness
// ---------------------------------------------------------------------------

describe("position UNKNOWN is never FLAT", () => {
  it("refuses to close or claim flat when the position cannot be read before cleanup", async () => {
    // Fill first, then make every later position read fail.
    const original = exchange.handler;
    let filled = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/order" && init?.method === "POST") filled = true;
      if (filled && parsed.pathname === "/fapi/v3/positionRisk") exchange.positionUnreadable = true;
      return original(url, init);
    });

    const report = await runVerification(OPTIONS, buildDeps());

    expect(report.verdict).toBe("MANUAL_TESTNET_CLEANUP_REQUIRED");
    expect(report.cleanup?.positionFlat ?? false).toBe(false);
    // No MARKET close was attempted against an unreadable position.
    expect(exchange.calls.some((c) => c.method === "POST" && c.params.type === "MARKET")).toBe(false);
    // State is retained so the run can be resumed.
    expect(report.stateRetained).toBe(true);
    expect(state.read()).not.toBeNull();
  });

  it("does not claim flat when the position cannot be re-read AFTER the close", async () => {
    exchange.positionUnreadableAfterClose = true;

    const report = await runVerification(OPTIONS, buildDeps());

    // The close was issued...
    expect(exchange.calls.some((c) => c.method === "POST" && c.params.type === "MARKET")).toBe(true);
    // ...but the verification read failed, so flatness is NOT claimed.
    expect(report.cleanup?.positionFlat).toBe(false);
    expect(report.verdict).toBe("MANUAL_TESTNET_CLEANUP_REQUIRED");
    expect(report.stateRetained).toBe(true);
  });

  it("treats a successful read of no position row as genuinely flat", async () => {
    const report = await runVerification(OPTIONS, buildDeps());
    expect(report.cleanup?.positionFlat).toBe(true);
    expect(report.verdict).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// State-file lifecycle
// ---------------------------------------------------------------------------

describe("state file lifecycle", () => {
  it("clears the state file when cleanup is PROVEN complete, even on FAIL_SAFE", async () => {
    // The TP submission is definitively rejected, so the run fails — but the
    // stop is cancelled, the entry resolves and the position is closed.
    exchange.failOnce.set("POST /fapi/v1/algoOrder", { status: 400, code: -1102, msg: "Mandatory parameter missing." });

    const report = await runVerification(OPTIONS, buildDeps());

    expect(report.verdict).toBe("FAIL_SAFE");
    expect(report.cleanup?.proven).toBe(true);
    expect(report.stateRetained).toBe(false);
    // Nothing left to resume.
    expect(state.read()).toBeNull();
  });

  it("retains the state file whenever anything is uncertain", async () => {
    exchange.positionUnreadableAfterClose = true;
    const report = await runVerification(OPTIONS, buildDeps());
    expect(report.verdict).toBe("MANUAL_TESTNET_CLEANUP_REQUIRED");
    expect(report.stateRetained).toBe(true);
    expect(state.read()).not.toBeNull();
  });
});

describe("crash recovery", () => {
  it("persists identities BEFORE the first mutation", async () => {
    const store = new MemoryStateStore();
    const written: string[] = [];
    const originalWrite = store.write.bind(store);
    store.write = (value) => {
      written.push(`state:${value.phase}`);
      originalWrite(value);
    };
    const original = exchange.handler;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = String(init?.method ?? "GET");
      if (method === "POST" || method === "DELETE") written.push(`mutation:${new URL(url).pathname}`);
      return original(url, init);
    });

    await runVerification(OPTIONS, buildDeps(store));

    expect(written[0]).toBe("state:PLANNED");
    expect(written.findIndex((entry) => entry.startsWith("mutation:"))).toBeGreaterThan(0);
  });

  it("resumes the SAME identities rather than minting new ones", async () => {
    const store = new MemoryStateStore({
      verifierVersion: "20B.1",
      runId: RUN_ID,
      origin: BINANCE_TESTNET_ORIGIN,
      symbol: SYMBOL,
      direction: "LONG",
      entryClientOrderId: IDS.entryClientOrderId,
      stopClientAlgoId: IDS.stopClientAlgoId,
      takeProfitClientAlgoId: IDS.takeProfitClientAlgoId,
      emergencyClientOrderId: IDS.emergencyClientOrderId,
      phase: "ENTRY_SUBMITTED",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    });
    // A dirty baseline is acceptable ON RESUME, because it may be ours.
    exchange.longPositionAmt = "0.002";
    exchange.standardOrders.set(IDS.entryClientOrderId, {
      clientOrderId: IDS.entryClientOrderId,
      symbol: SYMBOL,
      status: "FILLED",
      executedQty: "0.002",
      origQty: "0.002",
    });

    await runVerification(OPTIONS, buildDeps(store));

    for (const post of algoPosts()) {
      expect([IDS.stopClientAlgoId, IDS.takeProfitClientAlgoId]).toContain(post.params.clientAlgoId);
    }
    // createdAt is preserved across the resume.
    expect(store.read()?.createdAt ?? "2026-08-13T00:00:00.000Z").toBe("2026-08-13T00:00:00.000Z");
  });

  // -------------------------------------------------------------------------
  // TRUE resume: a loaded state never re-runs the new-run submission sequence.
  // -------------------------------------------------------------------------

  const storedAt = (phase: string, symbol = SYMBOL) =>
    new MemoryStateStore({
      verifierVersion: "20B.1",
      runId: RUN_ID,
      origin: BINANCE_TESTNET_ORIGIN,
      symbol,
      direction: "LONG",
      entryClientOrderId: IDS.entryClientOrderId,
      stopClientAlgoId: IDS.stopClientAlgoId,
      takeProfitClientAlgoId: IDS.takeProfitClientAlgoId,
      emergencyClientOrderId: IDS.emergencyClientOrderId,
      phase: phase as never,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    });

  /** Puts the exchange in the state a crash at `phase` would have left. */
  function existingEntryFilled(): void {
    exchange.longPositionAmt = "0.002";
    exchange.standardOrders.set(IDS.entryClientOrderId, {
      clientOrderId: IDS.entryClientOrderId,
      symbol: SYMBOL,
      status: "FILLED",
      executedQty: "0.002",
      origQty: "0.002",
    });
  }

  it("NEVER restarts a loaded run from PLANNED — no second entry POST", async () => {
    existingEntryFilled();
    const report = await runVerification(OPTIONS, buildDeps(storedAt("ENTRY_SUBMITTED")));

    expect(report.resumedFromPhase).toBe("ENTRY_SUBMITTED");
    // The entry already existed, so no entry POST may be issued.
    const entryPosts = exchange.calls.filter(
      (c) => c.method === "POST" && c.path === "/fapi/v1/order" && c.params.newClientOrderId === IDS.entryClientOrderId
    );
    expect(entryPosts).toHaveLength(0);
  });

  it("ENTRY_SUBMITTED resume QUERIES the entry id before issuing any mutation", async () => {
    existingEntryFilled();
    await runVerification(OPTIONS, buildDeps(storedAt("ENTRY_SUBMITTED")));

    const firstMutation = exchange.calls.findIndex((c) => c.method === "POST" || c.method === "DELETE");
    const entryQuery = exchange.calls.findIndex(
      (c) => c.method === "GET" && c.path === "/fapi/v1/order" && c.params.origClientOrderId === IDS.entryClientOrderId
    );
    expect(entryQuery).toBeGreaterThanOrEqual(0);
    expect(entryQuery).toBeLessThan(firstMutation);
  });

  it("STOP_SUBMITTED resume queries the SAME stop id first and never resubmits it", async () => {
    existingEntryFilled();
    // The crash happened after the STOP was created.
    exchange.algoOrders.set(IDS.stopClientAlgoId, {
      algoId: 501,
      clientAlgoId: IDS.stopClientAlgoId,
      symbol: SYMBOL,
      algoStatus: "NEW",
      orderType: "STOP_MARKET",
      positionSide: "LONG",
      side: "SELL",
      quantity: "0.002",
      triggerPrice: "45000.0",
      workingType: "MARK_PRICE",
      priceProtect: false,
      closePosition: false,
      // Binance sets this itself on hedge-mode closing conditionals.
      reduceOnly: true,
    });

    await runVerification(OPTIONS, buildDeps(storedAt("STOP_SUBMITTED")));

    const stopPosts = algoPosts().filter((c) => c.params.clientAlgoId === IDS.stopClientAlgoId);
    expect(stopPosts).toHaveLength(0);

    const firstMutation = exchange.calls.findIndex((c) => c.method === "POST" || c.method === "DELETE");
    const stopQuery = exchange.calls.findIndex(
      (c) => c.method === "GET" && c.path === "/fapi/v1/algoOrder" && c.params.clientAlgoId === IDS.stopClientAlgoId
    );
    expect(stopQuery).toBeGreaterThanOrEqual(0);
    expect(stopQuery).toBeLessThan(firstMutation);
    // The TP is still permitted from STOP_SUBMITTED, and it is the only POST.
    expect(algoPosts().every((c) => c.params.clientAlgoId === IDS.takeProfitClientAlgoId)).toBe(true);
  });

  it("TP_SUBMITTED resume queries the SAME take-profit id and submits nothing", async () => {
    existingEntryFilled();
    for (const [id, type] of [
      [IDS.stopClientAlgoId, "STOP_MARKET"],
      [IDS.takeProfitClientAlgoId, "TAKE_PROFIT_MARKET"],
    ] as const) {
      exchange.algoOrders.set(id, {
        algoId: 502,
        clientAlgoId: id,
        symbol: SYMBOL,
        algoStatus: "NEW",
        orderType: type,
        positionSide: "LONG",
        side: "SELL",
        quantity: "0.002",
        triggerPrice: type === "STOP_MARKET" ? "45000.0" : "55000.0",
        workingType: "MARK_PRICE",
        priceProtect: false,
        closePosition: false,
        // Binance sets this itself on hedge-mode closing conditionals.
        reduceOnly: true,
      });
    }

    await runVerification(OPTIONS, buildDeps(storedAt("TP_SUBMITTED")));

    // Zero algo POSTs of any kind.
    expect(algoPosts()).toHaveLength(0);
    const firstMutation = exchange.calls.findIndex((c) => c.method === "POST" || c.method === "DELETE");
    const tpQuery = exchange.calls.findIndex(
      (c) => c.method === "GET" && c.path === "/fapi/v1/algoOrder" && c.params.clientAlgoId === IDS.takeProfitClientAlgoId
    );
    expect(tpQuery).toBeGreaterThanOrEqual(0);
    expect(tpQuery).toBeLessThan(firstMutation);
  });

  it("refuses to mutate when an owned identity cannot be resolved on resume", async () => {
    existingEntryFilled();
    // The stop id specifically answers 5xx: its state is UNKNOWN, not absent.
    // The probe identity still resolves, so the endpoint is proven supported.
    exchange.unreadableAlgoIds.add(IDS.stopClientAlgoId);

    const report = await runVerification(OPTIONS, buildDeps(storedAt("STOP_SUBMITTED")));

    expect(report.verdict).toBe("MANUAL_TESTNET_CLEANUP_REQUIRED");
    expect(report.failures.join(" ")).toMatch(/could not be resolved on resume/);
    expect(exchange.mutations).toEqual([]);
  });

  it("does not require a clean baseline on resume — owned orders may be its own", async () => {
    existingEntryFilled();
    exchange.algoOrders.set(IDS.stopClientAlgoId, {
      algoId: 501,
      clientAlgoId: IDS.stopClientAlgoId,
      symbol: SYMBOL,
      algoStatus: "NEW",
      orderType: "STOP_MARKET",
      positionSide: "LONG",
      side: "SELL",
      quantity: "0.002",
      triggerPrice: "45000.0",
      // Our OWN previously submitted stop, so it carries the production policy
      // working type — a MARK_PRICE stop would no longer be ours.
      workingType: "CONTRACT_PRICE",
      priceProtect: false,
      closePosition: false,
      // Binance sets this itself on hedge-mode closing conditionals.
      reduceOnly: true,
    });
    // The baseline sees its own live order and its own position.
    exchange.foreignAlgoOpenOrders = 1;

    const report = await runVerification(OPTIONS, buildDeps(storedAt("STOP_SUBMITTED")));

    expect(report.probe.BASELINE_CLEAN).toBe(false);
    // A resume proceeds anyway, because ownership is proven by identity.
    expect(report.verdict).not.toBe("FAIL_SAFE");
    expect(report.resumedFromPhase).toBe("STOP_SUBMITTED");
  });

  // -------------------------------------------------------------------------
  // The real d7c85e10ef8a fixture: retained state, exchange already clean.
  // -------------------------------------------------------------------------

  describe("retained state over an already-clean exchange", () => {
    /** Exactly the reported end state of the first real demo run. */
    function realDemoEndState(): MemoryStateStore {
      // Entry FILLED, both protections cancelled, position flat.
      exchange.longPositionAmt = "0";
      exchange.standardOrders.set(IDS.entryClientOrderId, {
        clientOrderId: IDS.entryClientOrderId,
        symbol: SYMBOL,
        status: "FILLED",
        executedQty: "0.0008",
        origQty: "0.0008",
      });
      for (const id of [IDS.stopClientAlgoId, IDS.takeProfitClientAlgoId]) {
        exchange.algoOrders.set(id, {
          algoId: 700,
          clientAlgoId: id,
          symbol: SYMBOL,
          algoStatus: "CANCELLED",
          orderType: id === IDS.stopClientAlgoId ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
          positionSide: "LONG",
          quantity: "0.0008",
        });
      }
      return storedAt("CLOSING");
    }

    it("reconciles, clears the state file and performs ZERO mutations", async () => {
      const store = realDemoEndState();

      const report = await runVerification(OPTIONS, buildDeps(store));

      expect(report.verdict).toBe("RECOVERY_COMPLETE");
      expect(report.resumedFromPhase).toBe("CLOSING");
      // The whole point: nothing was sent.
      expect(exchange.mutations).toEqual([]);
      // And there is nothing left to resume.
      expect(report.stateRetained).toBe(false);
      expect(store.read()).toBeNull();
      expect(report.cleanup?.proven).toBe(true);
    });

    it("does not submit an entry, a STOP, a TP or an emergency close", async () => {
      await runVerification(OPTIONS, buildDeps(realDemoEndState()));

      expect(exchange.calls.filter((c) => c.method === "POST")).toEqual([]);
      expect(exchange.calls.filter((c) => c.method === "DELETE")).toEqual([]);
      expect(algoPosts()).toEqual([]);
    });

    it("keeps using the SAME runId and never mints a new one", async () => {
      const report = await runVerification(OPTIONS, buildDeps(realDemoEndState()));
      expect(report.runId).toBe(RUN_ID);
      expect(report.stop?.clientId).toBe(IDS.stopClientAlgoId);
      expect(report.takeProfit?.clientId).toBe(IDS.takeProfitClientAlgoId);
    });

    it("resolves identities that are ABSENT rather than terminal", async () => {
      const store = realDemoEndState();
      // Binance dropped the cancelled rows entirely: both answer -2013.
      exchange.algoOrders.clear();

      const report = await runVerification(OPTIONS, buildDeps(store));

      expect(report.verdict).toBe("RECOVERY_COMPLETE");
      expect(report.stop?.outcome).toBe("ABSENT_CONFIRMED");
      expect(exchange.mutations).toEqual([]);
    });

    it("refuses recovery when one identity is UNREADABLE, retaining state", async () => {
      const store = realDemoEndState();
      exchange.unreadableAlgoIds.add(IDS.stopClientAlgoId);

      const report = await runVerification(OPTIONS, buildDeps(store));

      expect(report.verdict).toBe("MANUAL_TESTNET_CLEANUP_REQUIRED");
      expect(report.stateRetained).toBe(true);
      expect(store.read()).not.toBeNull();
      expect(exchange.mutations).toEqual([]);
    });

    it("does NOT report RECOVERY_COMPLETE while its own position is still open", async () => {
      const store = realDemoEndState();
      exchange.longPositionAmt = "0.0008";

      const report = await runVerification(OPTIONS, buildDeps(store));

      // Not a no-op recovery: there is real exposure left to unwind.
      expect(report.verdict).not.toBe("RECOVERY_COMPLETE");
      // It closes ONLY its own exposure, using its own emergency identity, and
      // submits no new entry or protection.
      const close = exchange.calls.find((c) => c.method === "POST" && c.params.type === "MARKET");
      expect(close?.params.newClientOrderId).toBe(IDS.emergencyClientOrderId);
      expect(close?.params.quantity).toBe("0.0008");
      expect(algoPosts()).toEqual([]);
      expect(
        exchange.calls.filter((c) => c.method === "POST" && c.params.type === "LIMIT")
      ).toEqual([]);
    });
  });

  it("refuses when stored state does not match the derived identities", async () => {
    const store = new MemoryStateStore({
      verifierVersion: "20B.1",
      runId: RUN_ID,
      origin: BINANCE_TESTNET_ORIGIN,
      symbol: "ETHUSDT", // a different symbol
      direction: "LONG",
      entryClientOrderId: IDS.entryClientOrderId,
      stopClientAlgoId: IDS.stopClientAlgoId,
      takeProfitClientAlgoId: IDS.takeProfitClientAlgoId,
      emergencyClientOrderId: IDS.emergencyClientOrderId,
      phase: "PLANNED",
      createdAt: "",
      updatedAt: "",
    });

    const report = await runVerification(OPTIONS, buildDeps(store));
    expect(report.verdict).toBe("MANUAL_TESTNET_CLEANUP_REQUIRED");
    expect(exchange.mutations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Report sanitization
// ---------------------------------------------------------------------------

describe("sanitized report", () => {
  it("contains no credential, signature or signed-URL material", async () => {
    const report = await runVerification(OPTIONS, buildDeps());
    const text = formatRunReport(report).join("\n");

    for (const forbidden of ["demo-key-", "demo-secret-", "signature=", "X-MBX-APIKEY", "recvWindow", "timestamp="]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(text).toContain("FINAL: PASS");
    expect(text).toContain(IDS.stopClientAlgoId);
  });

  it("refuses to print a line that looks like signed request material", async () => {
    // Take a real, complete report and poison one free-form field with
    // something shaped like a signed URL.
    const real = await runVerification(OPTIONS, buildDeps());
    const poisoned = {
      ...real,
      probe: { ...real.probe, detail: "GET /fapi/v1/algoOrder?clientAlgoId=x&signature=deadbeef" },
    };
    expect(() => formatRunReport(poisoned)).toThrow(/signed request material/);

    // And the guard covers the other credential-shaped patterns too.
    expect(() =>
      formatRunReport({ ...real, failures: ["header X-MBX-APIKEY: abc"] })
    ).toThrow(/signed request material/);
  });
});
