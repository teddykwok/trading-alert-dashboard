import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BINANCE_READ_ONLY_ENDPOINTS,
  FORBIDDEN_METHODS,
  allowedReadOnlyPaths,
  isAllowedReadOnlyPath,
} from "../src/modules/binance/binance.endpoints";
import { assertReadOnlyRequest, BinanceReadOnlyClient } from "../src/modules/binance/binance.client";
import { BinanceReadOnlyService } from "../src/modules/binance/binance-read-only.service";
import { normalizeMarkPrice, normalizeOpenAlgoOrders } from "../src/modules/binance/binance.normalize";

/**
 * GET /fapi/v1/premiumIndex — the mark-price read added for Phase 20B.
 *
 * This is the ONLY way to read a mark price before a position exists;
 * positionRisk carries markPrice too, but only for an already-open position.
 * Public and unsigned, so it adds no credential surface.
 *
 * `fetch` is stubbed in every test — nothing here reaches a network.
 */

const BASE_URL = "https://demo-fapi.binance.example";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function client(): BinanceReadOnlyClient {
  return new BinanceReadOnlyClient({
    baseUrl: BASE_URL,
    apiKey: "synthetic-key-000000000000",
    apiSecret: "synthetic-secret-000000000",
    enabled: true,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("open algo orders endpoint contract", () => {
  it("is registered at the exact documented path, signed and GET-only", () => {
    expect(BINANCE_READ_ONLY_ENDPOINTS.openAlgoOrders.path).toBe("/fapi/v1/openAlgoOrders");
    expect(BINANCE_READ_ONLY_ENDPOINTS.openAlgoOrders.signed).toBe(true);
    expect(BINANCE_READ_ONLY_ENDPOINTS.openAlgoOrders.weight).toBe(1);
    expect(isAllowedReadOnlyPath("/fapi/v1/openAlgoOrders")).toBe(true);
    for (const method of FORBIDDEN_METHODS) {
      expect(() => assertReadOnlyRequest("/fapi/v1/openAlgoOrders", method), method).toThrow(/read-only/);
    }
  });

  it("issues a signed GET narrowed to the requested symbol", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (new URL(url).pathname === "/fapi/v1/time") return json({ serverTime: Date.now() });
      return json([{ symbol: "BTCUSDT", clientAlgoId: "tad-sl-1-abc", algoStatus: "NEW" }]);
    });

    const orders = await new BinanceReadOnlyService(client()).getOpenAlgoOrders(" btcusdt ");

    expect(orders).toHaveLength(1);
    expect(orders[0].clientAlgoId).toBe("tad-sl-1-abc");
    const last = new URL(calls[calls.length - 1]);
    expect(last.pathname).toBe("/fapi/v1/openAlgoOrders");
    expect(last.searchParams.get("symbol")).toBe("BTCUSDT");
    expect(last.searchParams.get("signature")).not.toBeNull();
  });

  it("propagates a transport failure so a caller can tell 'none' from 'unreadable'", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (new URL(url).pathname === "/fapi/v1/time") return json({ serverTime: Date.now() });
      return json({ code: -1001, msg: "Internal error." }, 503);
    });
    await expect(new BinanceReadOnlyService(client()).getOpenAlgoOrders("BTCUSDT")).rejects.toThrow();
  });

  it("requires an explicit symbol and never issues the weight-40 all-symbols form", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return json({ serverTime: Date.now() });
    });

    for (const bad of ["", "   "]) {
      await expect(new BinanceReadOnlyService(client()).getOpenAlgoOrders(bad)).rejects.toThrow(
        /requires an explicit symbol/
      );
    }
    // Not even a time sync was needed: it refused before dispatching.
    expect(calls.some((url) => url.includes("openAlgoOrders"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed normalization: a count of 0 is PROOF, so it must be earned
// ---------------------------------------------------------------------------

describe("open algo orders fail closed", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    algoId: 501,
    clientAlgoId: "tad-sl-1-abc",
    symbol: "BTCUSDT",
    algoStatus: "NEW",
    ...over,
  });

  it("accepts a genuine empty book as a readable zero", () => {
    expect(normalizeOpenAlgoOrders([], "BTCUSDT")).toEqual([]);
  });

  it("accepts one and many valid rows", () => {
    expect(normalizeOpenAlgoOrders([row()], "BTCUSDT")).toHaveLength(1);
    expect(
      normalizeOpenAlgoOrders([row(), row({ clientAlgoId: "tad-tp-1-def", algoId: 502 })], "BTCUSDT")
    ).toHaveLength(2);
    // Case-insensitive on the requested symbol.
    expect(normalizeOpenAlgoOrders([row()], "btcusdt")).toHaveLength(1);
  });

  it("rejects any payload that is not an array", () => {
    for (const payload of [null, undefined, {}, { code: -1001 }, "[]", 0, 5, true]) {
      expect(normalizeOpenAlgoOrders(payload, "BTCUSDT"), JSON.stringify(payload) ?? "undefined").toBeNull();
    }
  });

  it("INVALIDATES the whole response when any row is unreadable", () => {
    // The critical property: one bad row must not silently shrink the count.
    for (const bad of [null, 5, "order", [], undefined]) {
      expect(normalizeOpenAlgoOrders([row(), bad], "BTCUSDT"), String(bad)).toBeNull();
    }
  });

  it("rejects a row with a missing or blank symbol", () => {
    expect(normalizeOpenAlgoOrders([row({ symbol: undefined })], "BTCUSDT")).toBeNull();
    expect(normalizeOpenAlgoOrders([row({ symbol: "" })], "BTCUSDT")).toBeNull();
    expect(normalizeOpenAlgoOrders([row({ symbol: 123 })], "BTCUSDT")).toBeNull();
  });

  it("rejects a row for a DIFFERENT symbol than the one requested", () => {
    expect(normalizeOpenAlgoOrders([row({ symbol: "ETHUSDT" })], "BTCUSDT")).toBeNull();
    // Even alongside valid rows.
    expect(normalizeOpenAlgoOrders([row(), row({ symbol: "ETHUSDT" })], "BTCUSDT")).toBeNull();
  });

  it("rejects a row carrying no usable identity at all", () => {
    expect(normalizeOpenAlgoOrders([row({ algoId: undefined, clientAlgoId: undefined })], "BTCUSDT")).toBeNull();
    expect(normalizeOpenAlgoOrders([row({ algoId: null, clientAlgoId: "" })], "BTCUSDT")).toBeNull();
    // Either identity alone is sufficient to count the order.
    expect(normalizeOpenAlgoOrders([row({ clientAlgoId: undefined })], "BTCUSDT")).toHaveLength(1);
    expect(normalizeOpenAlgoOrders([row({ algoId: undefined })], "BTCUSDT")).toHaveLength(1);
  });

  it("refuses to normalize without a requested symbol", () => {
    expect(normalizeOpenAlgoOrders([], "")).toBeNull();
    expect(normalizeOpenAlgoOrders([row()], "  ")).toBeNull();
  });

  it("throws MALFORMED_RESPONSE from the service when normalization fails", async () => {
    for (const payload of [{ code: -1001 }, [{ symbol: "ETHUSDT", algoId: 1 }], [null]]) {
      vi.stubGlobal("fetch", async (url: string) => {
        if (new URL(url).pathname === "/fapi/v1/time") return json({ serverTime: Date.now() });
        return json(payload);
      });
      await expect(
        new BinanceReadOnlyService(client()).getOpenAlgoOrders("BTCUSDT"),
        JSON.stringify(payload)
      ).rejects.toMatchObject({ kind: "MALFORMED_RESPONSE" });
    }
  });

  it("still returns a readable zero through the service", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (new URL(url).pathname === "/fapi/v1/time") return json({ serverTime: Date.now() });
      return json([]);
    });
    await expect(new BinanceReadOnlyService(client()).getOpenAlgoOrders("BTCUSDT")).resolves.toEqual([]);
  });
});

describe("mark price endpoint contract", () => {
  it("is registered at the exact documented path", () => {
    expect(BINANCE_READ_ONLY_ENDPOINTS.premiumIndex.path).toBe("/fapi/v1/premiumIndex");
    expect(BINANCE_READ_ONLY_ENDPOINTS.premiumIndex.weight).toBe(1);
    expect(allowedReadOnlyPaths()).toContain("/fapi/v1/premiumIndex");
    expect(isAllowedReadOnlyPath("/fapi/v1/premiumIndex")).toBe(true);
  });

  it("is unsigned — it adds no credential surface", () => {
    expect(BINANCE_READ_ONLY_ENDPOINTS.premiumIndex.signed).toBe(false);
  });

  it("is reachable by GET only", () => {
    expect(() => assertReadOnlyRequest("/fapi/v1/premiumIndex", "GET")).not.toThrow();
    for (const method of FORBIDDEN_METHODS) {
      expect(() => assertReadOnlyRequest("/fapi/v1/premiumIndex", method), method).toThrow(/read-only/);
    }
  });

  it("issues a GET carrying the requested symbol and no credentials", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), headers: (init.headers ?? {}) as Record<string, string> });
      return json({ symbol: "BTCUSDT", markPrice: "50000.12345678" });
    });

    const result = await new BinanceReadOnlyService(client()).getMarkPrice(" btcusdt ");

    expect(result).toEqual({ symbol: "BTCUSDT", markPrice: "50000.12345678" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/fapi/v1/premiumIndex");
    expect(url.searchParams.get("symbol")).toBe("BTCUSDT");
    // Unsigned: no signature, no timestamp, no API-key header.
    expect(url.searchParams.get("signature")).toBeNull();
    expect(url.searchParams.get("timestamp")).toBeNull();
    expect(calls[0].headers["X-MBX-APIKEY"]).toBeUndefined();
  });

  it("accepts the array shape Binance returns without a symbol filter", () => {
    const payload = [
      { symbol: "ETHUSDT", markPrice: "3000.00" },
      { symbol: "BTCUSDT", markPrice: "50000.00" },
    ];
    expect(normalizeMarkPrice(payload, "BTCUSDT")).toEqual({ symbol: "BTCUSDT", markPrice: "50000.00" });
  });

  it("preserves the exact decimal string byte-for-byte", () => {
    expect(normalizeMarkPrice({ symbol: "BTCUSDT", markPrice: "0.00003505" }, "BTCUSDT")?.markPrice).toBe("0.00003505");
    expect(normalizeMarkPrice({ symbol: "BTCUSDT", markPrice: "50000.10000000" }, "BTCUSDT")?.markPrice).toBe(
      "50000.10000000"
    );
  });
});

describe("mark price fails closed", () => {
  it("rejects a payload about a different symbol", () => {
    expect(normalizeMarkPrice({ symbol: "ETHUSDT", markPrice: "3000" }, "BTCUSDT")).toBeNull();
    expect(normalizeMarkPrice([], "BTCUSDT")).toBeNull();
  });

  it("rejects a missing, zero, negative or non-numeric mark price", () => {
    for (const markPrice of [undefined, null, "", "0", "0.00", "-1", "abc", "1e5", {}]) {
      expect(normalizeMarkPrice({ symbol: "BTCUSDT", markPrice }, "BTCUSDT"), String(markPrice)).toBeNull();
    }
  });

  it("throws rather than returning a value a trigger price could be derived from", async () => {
    vi.stubGlobal("fetch", async () => json({ symbol: "BTCUSDT", markPrice: "0" }));
    await expect(new BinanceReadOnlyService(client()).getMarkPrice("BTCUSDT")).rejects.toThrow(/no usable mark price/);
  });

  it("throws on a payload that is not about the requested symbol", async () => {
    vi.stubGlobal("fetch", async () => json({ symbol: "ETHUSDT", markPrice: "3000" }));
    await expect(new BinanceReadOnlyService(client()).getMarkPrice("BTCUSDT")).rejects.toThrow(/no usable mark price/);
  });
});
