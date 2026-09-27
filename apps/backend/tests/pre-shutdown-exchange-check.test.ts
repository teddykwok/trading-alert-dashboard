import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BINANCE_READ_ONLY_ENDPOINTS,
  FORBIDDEN_METHODS,
  READ_ONLY_METHOD,
} from "../src/modules/binance/binance.endpoints";
import { BinanceReadOnlyClient } from "../src/modules/binance/binance.client";
import { BinanceReadOnlyService } from "../src/modules/binance/binance-read-only.service";
import {
  collectPreShutdownCounts,
  evaluatePreShutdownExchange,
  renderPreShutdownReport,
  type PreShutdownReads,
} from "../src/modules/binance/pre-shutdown-exchange-check";

/**
 * The pre-shutdown exchange check must be able to say "the book is empty" and
 * mean it, ACCOUNT-WIDE.
 *
 * Two failure directions matter, unequally. Reporting exposure that is not
 * there blocks a legitimate shutdown, which is annoying. Reporting emptiness
 * that is not there lets an operator stop the process that protects an open
 * position — so every case that could produce a false PASS is exercised here:
 * a non-zero count, a read that failed, and the narrowing that an earlier
 * draft of this tool had built in.
 */

const BACKEND_ROOT = process.cwd().endsWith(path.join("apps", "backend"))
  ? process.cwd()
  : path.join(process.cwd(), "apps", "backend");

const codeOf = (relative: string): string => readFileSync(path.join(BACKEND_ROOT, relative), "utf8");
const CLI = codeOf("src/modules/binance/run-pre-shutdown-exchange-check.ts");
const MODULE = codeOf("src/modules/binance/pre-shutdown-exchange-check.ts");

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Synthetic throughout: no real symbol, order or account appears here. */
const position = (symbol: string) => ({ symbol, positionSide: "BOTH", positionAmt: "1" }) as never;
const order = (symbol: string) => ({ symbol, orderId: "synthetic-order-id" }) as never;
const algo = (symbol: string) => ({ symbol, algoId: "synthetic-algo-id" }) as never;

function reads(over: Partial<PreShutdownReads> = {}): PreShutdownReads {
  return {
    getPositionRisk: (async () => []) as PreShutdownReads["getPositionRisk"],
    getOpenOrders: (async () => []) as PreShutdownReads["getOpenOrders"],
    getOpenAlgoOrdersAccountWide: (async () => []) as PreShutdownReads["getOpenAlgoOrdersAccountWide"],
    ...over,
  };
}

const boom = () => {
  throw new Error("unreadable");
};

// ===========================================================================
// 1-3, 10. The account-wide endpoint itself
// ===========================================================================

describe("the account-wide conditional-order read", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function capturingClient(body: unknown) {
    const urls: string[] = [];
    global.fetch = (async (url: string) => {
      const target = String(url);
      // A signed request syncs the clock first; that exchange is not the
      // subject of these assertions, so it is answered and not recorded.
      const isTime = target.includes("/fapi/v1/time");
      if (!isTime) urls.push(target);
      const payload = isTime ? { serverTime: 1_800_000_000_000 } : body;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }) as unknown as typeof global.fetch;
    const client = new BinanceReadOnlyClient({
      baseUrl: "https://synthetic.invalid",
      apiKey: "synthetic-key",
      apiSecret: "synthetic-secret",
      recvWindowMs: 5000,
      enabled: true,
    });
    return { service: new BinanceReadOnlyService(client), urls };
  }

  it("1. requests GET /fapi/v1/openAlgoOrders with NO symbol", async () => {
    const { service, urls } = capturingClient([]);
    await service.getOpenAlgoOrdersAccountWide();
    expect(urls).toHaveLength(1);
    const url = urls[0];
    expect(url).toContain("/fapi/v1/openAlgoOrders");
    // The whole point: no narrowing of any kind reaches the wire.
    expect(`symbol in query: ${/[?&]symbol=/.test(url)}`).toBe("symbol in query: false");
    // Still signed, so it is a USER_DATA read for the bound account.
    expect(url).toContain("signature=");
  });

  it("1. takes no symbol argument at all, so it cannot be narrowed", () => {
    expect(BinanceReadOnlyService.prototype.getOpenAlgoOrdersAccountWide).toHaveLength(0);
    const service = codeOf("src/modules/binance/binance-read-only.service.ts");
    expect(service).toContain("async getOpenAlgoOrdersAccountWide(): Promise<BinanceAlgoOrderDto[]> {");
    expect(service).toContain('this.client.request<unknown>("openAlgoOrdersAccountWide", {})');
  });

  it("2. the account-wide descriptor declares weight 40", () => {
    const endpoint = BINANCE_READ_ONLY_ENDPOINTS.openAlgoOrdersAccountWide;
    expect(endpoint.weight).toBe(40);
    expect(endpoint.signed).toBe(true);
    expect(endpoint.path).toBe("/fapi/v1/openAlgoOrders");
  });

  it("3. the symbol-scoped descriptor still declares weight 1", () => {
    const endpoint = BINANCE_READ_ONLY_ENDPOINTS.openAlgoOrders;
    expect(endpoint.weight).toBe(1);
    expect(endpoint.signed).toBe(true);
    expect(endpoint.path).toBe("/fapi/v1/openAlgoOrders");
    // Two names for one path, so each request states its own honest cost.
    expect(BINANCE_READ_ONLY_ENDPOINTS.openAlgoOrdersAccountWide.weight).not.toBe(endpoint.weight);
  });

  it("refuses an unreadable account-wide reply rather than reporting zero", async () => {
    const { service } = capturingClient({ not: "an array" });
    await expect(service.getOpenAlgoOrdersAccountWide()).rejects.toThrow();
  });

  it("accepts rows spanning symbols, which is the account-wide shape", async () => {
    const { service } = capturingClient([
      { symbol: "AAAUSDT", algoId: "1" },
      { symbol: "BBBUSDT", algoId: "2" },
    ]);
    expect(await service.getOpenAlgoOrdersAccountWide()).toHaveLength(2);
  });

  it("10. every endpoint this connector can reach is a GET on the allowlist", () => {
    expect(READ_ONLY_METHOD).toBe("GET");
    expect([...FORBIDDEN_METHODS]).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
    for (const [name, endpoint] of Object.entries(BINANCE_READ_ONLY_ENDPOINTS)) {
      expect(`${name} path: ${endpoint.path.startsWith("/fapi/")}`).toBe(`${name} path: true`);
    }
    // assertReadOnlyRequest is untouched and still guards every dispatch.
    const client = codeOf("src/modules/binance/binance.client.ts");
    expect(client).toContain("assertReadOnlyRequest(endpoint.path, READ_ONLY_METHOD);");
    expect(client).toContain("if (method !== READ_ONLY_METHOD) {");
  });
});

// ===========================================================================
// 4-5. The CLI's shape
// ===========================================================================

describe("the CLI's structure", () => {
  it("bootstraps the account BEFORE Prisma or anything that loads env", () => {
    const source = withoutComments(CLI);
    const first = /(?:^|\n)\s*import\s+(?:[\s\S]*?from\s*)??["']([^"']+)["']/.exec(source);
    expect(first?.[1]).toBe("../../config/bootstrap-account");
    expect(source.indexOf('"../../config/bootstrap-account"')).toBeLessThan(
      source.indexOf('from "@prisma/client"')
    );
    expect(source.indexOf('"../../config/bootstrap-account"')).toBeLessThan(
      source.indexOf('from "../../config/env"')
    );
  });

  it("binds the account BEFORE constructing any exchange client", () => {
    const source = withoutComments(CLI);
    const bind = source.indexOf("bindConfiguredExchangeRuntime(prisma)");
    expect(bind).toBeGreaterThan(-1);
    expect(source.indexOf("new BinanceReadOnlyClient(")).toBeGreaterThan(bind);
    expect(source.indexOf("new BinanceReadOnlyService(")).toBeGreaterThan(bind);
    expect(source).toContain("exchangeClientOptionsOf(bound.runtime)");
  });

  it("a binding failure constructs nothing and makes no request", () => {
    const source = withoutComments(CLI);
    const refusal = source.indexOf("if (!bound.ok) {");
    const client = source.indexOf("new BinanceReadOnlyClient(");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(client);
    const branch = source.slice(refusal, client);
    expect(branch).toContain("process.exitCode = 1;");
    expect(branch).toContain("return;");
    expect(CLI).toContain("No exchange client was constructed and no request was made.");
  });

  it("requires BINANCE_READ_ONLY_ENABLED before anything else", () => {
    const source = withoutComments(CLI);
    expect(source.indexOf("if (!env.BINANCE_READ_ONLY_ENABLED)")).toBeLessThan(
      source.indexOf("new PrismaClient()")
    );
  });

  it("4. uses the ACCOUNT-WIDE algo read, never a per-symbol sweep", () => {
    const source = withoutComments(CLI + MODULE);
    expect(source).toContain("getOpenAlgoOrdersAccountWide");
    // The narrowing machinery is gone, not merely unused.
    for (const removed of ["algoSweepSymbols", "algoSymbolsScanned", "getOpenAlgoOrders(symbol"]) {
      expect(`${removed}:${source.includes(removed)}`).toBe(`${removed}:false`);
    }
  });

  it("5. needs no profile projection and no allowedSymbols to be complete", () => {
    const source = withoutComments(CLI);
    for (const removed of ["profileProjectionOf", "allowedSymbols", "safetyPolicy", "findUnique"]) {
      expect(`${removed}:${source.includes(removed)}`).toBe(`${removed}:false`);
    }
    // Prisma is still constructed, but only because the BINDER needs it.
    expect(source).toContain("new PrismaClient()");
    expect(source).toContain("bindConfiguredExchangeRuntime(prisma)");
  });

  it("writes nothing to the database and cannot mutate the exchange", () => {
    const source = withoutComments(CLI + MODULE);
    for (const forbidden of [
      "update(", "updateMany(", "create(", "createMany(", "delete(", "upsert(",
      "BinanceUsdMExecutionClient", "authorizeLiveEntry", "cancel", "closePosition",
      "setLeverage", "setMarginType",
    ]) {
      expect(`${forbidden}:${source.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

// ===========================================================================
// 6-8. The verdict
// ===========================================================================

describe("the verdict", () => {
  it("8. PASSES only when all three account-wide counts are known and zero", async () => {
    const counts = await collectPreShutdownCounts(reads());
    expect(counts).toEqual({
      nonZeroPositions: { known: true, count: 0 },
      standardOpenOrders: { known: true, count: 0 },
      openAlgoOrders: { known: true, count: 0 },
    });
    expect(evaluatePreShutdownExchange(counts)).toEqual({ pass: true });
  });

  it("BLOCKS on a non-zero position", async () => {
    const counts = await collectPreShutdownCounts(
      reads({ getPositionRisk: (async () => [position("AAAUSDT")]) as PreShutdownReads["getPositionRisk"] })
    );
    const verdict = evaluatePreShutdownExchange(counts);
    expect(verdict.pass).toBe(false);
    expect(verdict.pass === false && verdict.reasons.join(" ")).toContain("non-zero positions: 1");
  });

  it("BLOCKS on a standard open order", async () => {
    const counts = await collectPreShutdownCounts(
      reads({ getOpenOrders: (async () => [order("AAAUSDT")]) as PreShutdownReads["getOpenOrders"] })
    );
    const verdict = evaluatePreShutdownExchange(counts);
    expect(verdict.pass).toBe(false);
    expect(verdict.pass === false && verdict.reasons.join(" ")).toContain("standard open orders: 1");
  });

  it("6. BLOCKS on an open conditional order anywhere in the account", async () => {
    const counts = await collectPreShutdownCounts(
      reads({
        getOpenAlgoOrdersAccountWide: (async () => [
          algo("AAAUSDT"),
          algo("ZZZUSDT"),
        ]) as PreShutdownReads["getOpenAlgoOrdersAccountWide"],
      })
    );
    expect(counts.openAlgoOrders).toEqual({ known: true, count: 2 });
    const verdict = evaluatePreShutdownExchange(counts);
    expect(verdict.pass).toBe(false);
    expect(verdict.pass === false && verdict.reasons.join(" ")).toContain("conditional (algo) orders: 2");
  });

  it("7. BLOCKS when the account-wide conditional read fails", async () => {
    const counts = await collectPreShutdownCounts(
      reads({ getOpenAlgoOrdersAccountWide: boom as unknown as PreShutdownReads["getOpenAlgoOrdersAccountWide"] })
    );
    expect(counts.openAlgoOrders).toEqual({ known: false });
    const verdict = evaluatePreShutdownExchange(counts);
    expect(verdict.pass).toBe(false);
    expect(verdict.pass === false && verdict.reasons.join(" ")).toContain("not assumed to be zero");
  });

  it("BLOCKS when positions cannot be read", async () => {
    const counts = await collectPreShutdownCounts(
      reads({ getPositionRisk: boom as unknown as PreShutdownReads["getPositionRisk"] })
    );
    expect(counts.nonZeroPositions).toEqual({ known: false });
    expect(evaluatePreShutdownExchange(counts).pass).toBe(false);
  });

  it("BLOCKS when standard open orders cannot be read", async () => {
    const counts = await collectPreShutdownCounts(
      reads({ getOpenOrders: boom as unknown as PreShutdownReads["getOpenOrders"] })
    );
    expect(counts.standardOpenOrders).toEqual({ known: false });
    expect(evaluatePreShutdownExchange(counts).pass).toBe(false);
  });

  it("reports every blocking reason at once, not just the first", async () => {
    const counts = await collectPreShutdownCounts(
      reads({
        getPositionRisk: (async () => [position("AAAUSDT")]) as PreShutdownReads["getPositionRisk"],
        getOpenOrders: boom as unknown as PreShutdownReads["getOpenOrders"],
        getOpenAlgoOrdersAccountWide: (async () => [algo("AAAUSDT")]) as PreShutdownReads["getOpenAlgoOrdersAccountWide"],
      })
    );
    const verdict = evaluatePreShutdownExchange(counts);
    expect(verdict.pass === false && verdict.reasons).toHaveLength(3);
  });
});

// ===========================================================================
// 9. What the report may contain
// ===========================================================================

describe("the report", () => {
  it("9. carries counts only — no balance, symbol, order id, quantity or account", async () => {
    const counts = await collectPreShutdownCounts(
      reads({
        getPositionRisk: (async () => [position("SECRETSYMBOLUSDT")]) as PreShutdownReads["getPositionRisk"],
        getOpenOrders: (async () => [order("SECRETSYMBOLUSDT")]) as PreShutdownReads["getOpenOrders"],
        getOpenAlgoOrdersAccountWide: (async () => [algo("SECRETSYMBOLUSDT")]) as PreShutdownReads["getOpenAlgoOrdersAccountWide"],
      })
    );
    const report = renderPreShutdownReport(counts, evaluatePreShutdownExchange(counts)).join("\n");
    for (const leak of ["SECRETSYMBOLUSDT", "synthetic-order-id", "synthetic-algo-id"]) {
      expect(`${leak} in report:${report.includes(leak)}`).toBe(`${leak} in report:false`);
    }
    for (const field of ["balance", "positionAmt", "orderId", "algoId", "accountIdentifier", "apiKey"]) {
      expect(`${field} in report:${report.includes(field)}`).toBe(`${field} in report:false`);
    }
  });

  it("prints the agreed shape", async () => {
    const counts = await collectPreShutdownCounts(reads());
    const report = renderPreShutdownReport(counts, evaluatePreShutdownExchange(counts)).join("\n");
    expect(report).toContain("PRE-SHUTDOWN EXCHANGE CHECK");
    expect(report).toContain("binding             = accepted");
    expect(report).toContain("nonZeroPositions    = 0");
    expect(report).toContain("standardOpenOrders  = 0");
    expect(report).toContain("openAlgoOrders      = 0");
    expect(report).toContain("exchangeMutation    = none");
    expect(report).toContain("PASS — exchange reports no positions or open orders for this account.");
    // The scope line is gone with the sweep it described.
    expect(`algoSymbolsScanned:${report.includes("algoSymbolsScanned")}`).toBe("algoSymbolsScanned:false");
  });

  it("renders UNKNOWN rather than a number it does not have", async () => {
    const counts = await collectPreShutdownCounts(
      reads({ getOpenAlgoOrdersAccountWide: boom as unknown as PreShutdownReads["getOpenAlgoOrdersAccountWide"] })
    );
    const report = renderPreShutdownReport(counts, evaluatePreShutdownExchange(counts)).join("\n");
    expect(report).toContain("openAlgoOrders      = UNKNOWN");
    expect(report).toContain("BLOCKED");
  });

  it("never prints a raw response, and exits non-zero on any failure", () => {
    const source = withoutComments(CLI);
    expect(`JSON.stringify in the CLI:${source.includes("JSON.stringify")}`).toBe(
      "JSON.stringify in the CLI:false"
    );
    expect(CLI).toContain('error instanceof Error ? error.name : "unknown"');
    expect(CLI).toContain("Treat this as BLOCKED");
    expect(source).toContain("if (!verdict.pass) process.exitCode = 1;");
  });
});
