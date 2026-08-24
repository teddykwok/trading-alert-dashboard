import { readFileSync } from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BinanceReadOnlyClient,
  assertReadOnlyRequest,
  buildCanonicalQuery,
  signQuery,
} from "../src/modules/binance/binance.client";
import {
  BINANCE_READ_ONLY_ENDPOINTS,
  FORBIDDEN_METHODS,
  allowedReadOnlyPaths,
  isAllowedReadOnlyPath,
} from "../src/modules/binance/binance.endpoints";
import { BinanceError, BinanceReadOnlyViolationError } from "../src/modules/binance/binance.errors";
import {
  BinanceReadOnlyService,
  ONE_WAY_MODE_WARNING,
} from "../src/modules/binance/binance-read-only.service";
import {
  decimalString,
  expandExponentialNotation,
  isNonZeroPosition,
  normalizeLeverageBrackets,
  normalizePositionMode,
  normalizePositions,
  normalizeSymbolFilters,
} from "../src/modules/binance/binance.normalize";

const API_KEY = "test-api-key-000000";
const API_SECRET = "test-api-secret-1111";
const BASE_URL = "https://fapi.binance.com";
const SERVER_TIME = 1_800_000_000_000;

const originalFetch = global.fetch;

function client(overrides = {}) {
  return new BinanceReadOnlyClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    recvWindowMs: 5000,
    enabled: true,
    ...overrides,
  });
}

function response(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => init.headers?.[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Queues fetch responses in order; records every call. */
function mockFetchSequence(...responses: unknown[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** Every signed call is preceded by a /fapi/v1/time sync. */
function timeResponse() {
  return response({ serverTime: SERVER_TIME });
}

function lastUrl(fn: ReturnType<typeof vi.fn>): string {
  return String(fn.mock.calls[fn.mock.calls.length - 1][0]);
}

function callInit(fn: ReturnType<typeof vi.fn>, index: number) {
  return fn.mock.calls[index][1] as RequestInit;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Signing and time
// ---------------------------------------------------------------------------

describe("signing and canonical query", () => {
  it("produces a deterministic HMAC-SHA256 signature for a fixed fixture", () => {
    // Fixture chosen so the expectation is independent of this implementation.
    const query = "recvWindow=5000&symbol=BTCUSDT&timestamp=1700000000000";
    const expected = createHmac("sha256", API_SECRET).update(query).digest("hex");

    expect(signQuery(query, API_SECRET)).toBe(expected);
    expect(signQuery(query, API_SECRET)).toMatch(/^[a-f0-9]{64}$/);
    // Stable across runs.
    expect(signQuery(query, API_SECRET)).toBe(signQuery(query, API_SECRET));
  });

  it("orders query keys canonically regardless of input order", () => {
    const a = buildCanonicalQuery({ symbol: "BTCUSDT", recvWindow: 5000, timestamp: 1 });
    const b = buildCanonicalQuery({ timestamp: 1, symbol: "BTCUSDT", recvWindow: 5000 });
    expect(a).toBe(b);
    expect(a).toBe("recvWindow=5000&symbol=BTCUSDT&timestamp=1");
  });

  it("omits undefined and empty values and URL-encodes the rest", () => {
    expect(buildCanonicalQuery({ a: undefined, b: "", c: "a b&c" })).toBe("c=a%20b%26c");
  });

  it("signs exactly the transmitted query string, with signature last", async () => {
    const fetchMock = mockFetchSequence(timeResponse(), response([]));
    await client().request("openOrders", { symbol: "BTCUSDT" });

    const url = new URL(lastUrl(fetchMock));
    const raw = url.search.slice(1);
    const [payload, signaturePart] = raw.split("&signature=");

    expect(signaturePart).toBeDefined();
    expect(raw.endsWith(`&signature=${signaturePart}`)).toBe(true);
    expect(signaturePart).toBe(createHmac("sha256", API_SECRET).update(payload).digest("hex"));
  });

  it("sends the API key header on signed calls and omits it on public ones", async () => {
    const fetchMock = mockFetchSequence(timeResponse(), response([]));
    await client().request("openOrders");
    expect((callInit(fetchMock, 1).headers as Record<string, string>)["X-MBX-APIKEY"]).toBe(API_KEY);
    // The time sync (public) carries no credentials.
    expect(callInit(fetchMock, 0).headers).toEqual({});
  });

  it("defaults recvWindow to 5000 and includes a server-offset timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000_000_000));
    // Server is 30s ahead of our clock.
    const fetchMock = mockFetchSequence(response({ serverTime: 1_000_000_030_000 }), response([]));

    await client().request("openOrders");

    const params = new URL(lastUrl(fetchMock)).searchParams;
    expect(params.get("recvWindow")).toBe("5000");
    expect(Number(params.get("timestamp"))).toBe(1_000_000_030_000);
  });

  it("honours a custom recvWindow", async () => {
    const fetchMock = mockFetchSequence(timeResponse(), response([]));
    await client({ recvWindowMs: 20_000 }).request("openOrders");
    expect(new URL(lastUrl(fetchMock)).searchParams.get("recvWindow")).toBe("20000");
  });

  it("measures the clock offset and exposes it", async () => {
    mockFetchSequence(timeResponse());
    const c = client();
    const sync = await c.syncTime();

    expect(sync.serverTimeMs).toBe(SERVER_TIME);
    expect(typeof sync.offsetMs).toBe("number");
    expect(sync.roundTripMs).toBeGreaterThanOrEqual(0);
    expect(c.clockOffsetMs).toBe(sync.offsetMs);
  });

  it("fails clearly when the time response is malformed", async () => {
    mockFetchSequence(response({ nope: true }));
    await expect(client().syncTime()).rejects.toMatchObject({ kind: "MALFORMED_RESPONSE" });
  });

  it("re-syncs once and retries when Binance reports -1021 (timestamp outside recvWindow)", async () => {
    const fetchMock = mockFetchSequence(
      timeResponse(),
      response({ code: -1021, msg: "Timestamp for this request is outside of the recvWindow." }, { status: 400 }),
      timeResponse(),
      response([{ symbol: "BTCUSDT" }])
    );

    await client().request("openOrders");
    // time, failed call, re-sync, successful retry
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

describe("secret hygiene", () => {
  it("never puts credentials or signatures into thrown error messages", async () => {
    mockFetchSequence(
      timeResponse(),
      response({ code: -2015, msg: "Invalid API-key, IP, or permissions for action." }, { status: 401 })
    );

    const error = await client()
      .request("balance")
      .catch((e: BinanceError) => e);

    const serialized = `${(error as BinanceError).message} ${JSON.stringify(error)}`;
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(API_SECRET);
    expect(serialized).not.toMatch(/signature=[a-f0-9]{64}/);
  });

  it("redacts secrets and signatures that reach sanitizeBinanceText", async () => {
    const { registerBinanceRedactions, sanitizeBinanceText } = await import(
      "../src/modules/binance/binance.errors"
    );
    registerBinanceRedactions([API_KEY, API_SECRET]);

    const dirty = `boom ${API_SECRET} signature=${"a".repeat(64)} X-MBX-APIKEY: ${API_KEY}`;
    const clean = sanitizeBinanceText(dirty);

    expect(clean).not.toContain(API_SECRET);
    expect(clean).not.toContain(API_KEY);
    expect(clean).not.toContain("a".repeat(64));
    expect(clean).toContain("***REDACTED***");
  });

  it("never logs the signed URL", async () => {
    const { logger } = await import("../src/config/logger");
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => logger);
    mockFetchSequence(timeResponse(), response([]));

    await client().request("openOrders");

    for (const call of debugSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(API_SECRET);
      expect(serialized).not.toContain(API_KEY);
      expect(serialized).not.toContain("signature=");
    }
  });
});

// ---------------------------------------------------------------------------
// Safety: read-only transport boundary
// ---------------------------------------------------------------------------

describe("read-only safety boundary", () => {
  it("rejects every mutating HTTP method before any network dispatch", () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    for (const method of FORBIDDEN_METHODS) {
      expect(() => assertReadOnlyRequest("/fapi/v1/order", method)).toThrow(BinanceReadOnlyViolationError);
      expect(() => assertReadOnlyRequest("/fapi/v3/balance", method)).toThrow(/read-only/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects paths outside the allowlist even with GET", () => {
    // /fapi/v1/order is allowlisted for GET (Query Order) from Phase 6 on; the
    // write paths below still have no representation here at all.
    for (const path of ["/fapi/v1/leverage", "/fapi/v1/marginType", "/fapi/v1/batchOrders", "/fapi/v1/positionMargin"]) {
      expect(() => assertReadOnlyRequest(path, "GET")).toThrow(BinanceReadOnlyViolationError);
    }
    expect(() => assertReadOnlyRequest("/fapi/v3/balance", "GET")).not.toThrow();
  });

  it("only ever dispatches GET requests", async () => {
    const fetchMock = mockFetchSequence(timeResponse(), response([]), response({}), response([]));
    const c = client();
    await c.request("openOrders");
    await c.request("exchangeInfo");
    await c.request("positionRisk");

    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).method).toBe("GET");
    }
  });

  it("allowlists only documented read-only endpoints", () => {
    expect(allowedReadOnlyPaths()).toEqual([
      "/fapi/v1/accountConfig",
      "/fapi/v1/algoOrder",
      // Historical order and fill readers. Signed GETs, added so a stuck entry
      // can PROVE it never reached the exchange instead of being retried
      // forever — the allowlist stays provably read-only.
      "/fapi/v1/allOrders",
      "/fapi/v1/exchangeInfo",
      "/fapi/v1/leverageBracket",
      "/fapi/v1/multiAssetsMargin",
      "/fapi/v1/openAlgoOrders",
      "/fapi/v1/openOrders",
      "/fapi/v1/order",
      "/fapi/v1/ping",
      "/fapi/v1/positionMargin/history",
      "/fapi/v1/positionSide/dual",
      // Mark price. Public and unsigned; the only way to read a mark price
      // before a position exists.
      "/fapi/v1/premiumIndex",
      "/fapi/v1/symbolConfig",
      "/fapi/v1/time",
      "/fapi/v1/userTrades",
      "/fapi/v3/account",
      "/fapi/v3/balance",
      "/fapi/v3/positionRisk",
    ]);
    expect(isAllowedReadOnlyPath("/fapi/v1/leverage")).toBe(false);
    expect(isAllowedReadOnlyPath("/fapi/v1/marginType")).toBe(false);
  });

  it("exposes no trading or account-mutating method anywhere in the module", () => {
    const forbiddenMethods = [
      "placeOrder",
      "cancelOrder",
      "changeLeverage",
      "changeMarginType",
      "changePositionMode",
      "newOrder",
      "setLeverage",
    ];

    const instances: object[] = [client(), new BinanceReadOnlyService(client())];
    for (const instance of instances) {
      const names = new Set([
        ...Object.getOwnPropertyNames(instance),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(instance)),
      ]);
      for (const method of forbiddenMethods) expect(names.has(method)).toBe(false);
    }

    // And the source itself must not contain mutating verbs or write paths.
    const dir = path.join(process.cwd(), "src", "modules", "binance");
    const sources = [
      "binance.client.ts",
      "binance.endpoints.ts",
      "binance-read-only.service.ts",
      "binance.normalize.ts",
      "run-read-only-check.ts",
    ].map((file) => readFileSync(path.join(dir, file), "utf8"));

    for (const source of sources) {
      // Strip comments so documentation of the ban doesn't trip the check.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
      for (const method of forbiddenMethods) expect(code).not.toContain(method);
      // No WRITE path has any representation in this module. /fapi/v1/order is
      // present as a GET query endpoint; the line below proves no non-GET verb
      // can be attached to it here.
      // Quoted forms: "/fapi/v1/leverage" must not match the legitimate
      // "/fapi/v1/leverageBracket" read endpoint.
      for (const writePath of ['"/fapi/v1/leverage"', '"/fapi/v1/marginType"', '"/fapi/v1/batchOrders"']) {
        expect(code).not.toContain(writePath);
      }
      expect(code).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)["']/);
    }
  });

  it("performs no database write (prisma is never imported by the module)", () => {
    const dir = path.join(process.cwd(), "src", "modules", "binance");
    for (const file of ["binance.client.ts", "binance-read-only.service.ts", "binance.normalize.ts"]) {
      const source = readFileSync(path.join(dir, file), "utf8");
      expect(source).not.toContain("prisma");
      expect(source).not.toContain("@prisma/client");
    }
  });

  it("is not wired into the alert pipeline", () => {
    const dir = path.join(process.cwd(), "src", "modules", "binance");
    for (const file of ["binance.client.ts", "binance-read-only.service.ts"]) {
      const source = readFileSync(path.join(dir, file), "utf8");
      for (const forbidden of ["alerts.service", "webhook", "extreme-rr", "jobs/queue", "notification.service"]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Configuration gating
// ---------------------------------------------------------------------------

describe("configuration gating", () => {
  it("refuses to call anything while disabled, without needing credentials", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const disabled = new BinanceReadOnlyClient({ enabled: false, apiKey: "", apiSecret: "" });

    await expect(disabled.request("ping")).rejects.toMatchObject({ kind: "DISABLED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires both key and secret for signed calls when enabled", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    for (const creds of [
      { apiKey: "", apiSecret: API_SECRET },
      { apiKey: API_KEY, apiSecret: "" },
    ]) {
      const c = new BinanceReadOnlyClient({ enabled: true, baseUrl: BASE_URL, ...creds });
      await expect(c.request("balance")).rejects.toMatchObject({ kind: "MISSING_CREDENTIALS" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("env schema keeps credentials optional while disabled and required when enabled", async () => {
    const { z } = await import("zod");
    // Mirrors the rule in config/env.ts.
    const schema = z
      .object({
        BINANCE_READ_ONLY_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
        BINANCE_API_KEY: z.string().optional().default(""),
        BINANCE_API_SECRET: z.string().optional().default(""),
        BINANCE_RECV_WINDOW_MS: z.coerce.number().int().positive().max(60_000).default(5000),
      })
      .superRefine((value, ctx) => {
        if (value.BINANCE_READ_ONLY_ENABLED) {
          if (!value.BINANCE_API_KEY) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "key required" });
          if (!value.BINANCE_API_SECRET) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "secret required" });
        }
      });

    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ BINANCE_READ_ONLY_ENABLED: "true" }).success).toBe(false);
    expect(
      schema.safeParse({ BINANCE_READ_ONLY_ENABLED: "true", BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" }).success
    ).toBe(true);
    // Malformed recvWindow values are rejected.
    for (const bad of ["abc", "0", "-1", "60001", "1.5"]) {
      expect(schema.safeParse({ BINANCE_RECV_WINDOW_MS: bad }).success).toBe(false);
    }
    expect(schema.parse({ BINANCE_RECV_WINDOW_MS: "5000" }).BINANCE_RECV_WINDOW_MS).toBe(5000);
  });

  it("example env files carry placeholders only — never real credentials", () => {
    for (const file of [
      path.join(process.cwd(), ".env.example"),
      path.join(process.cwd(), "..", "..", ".env.example"),
    ]) {
      const content = readFileSync(file, "utf8");
      expect(content).toContain("BINANCE_READ_ONLY_ENABLED=false");
      expect(content).toMatch(/^BINANCE_API_KEY=\s*$/m);
      expect(content).toMatch(/^BINANCE_API_SECRET=\s*$/m);
      expect(content).toContain("BINANCE_RECV_WINDOW_MS=5000");
    }
  });
});

// ---------------------------------------------------------------------------
// Public data normalization
// ---------------------------------------------------------------------------

const EXCHANGE_INFO = {
  timezone: "UTC",
  symbols: [
    {
      symbol: "BTCUSDT",
      status: "TRADING",
      contractType: "PERPETUAL",
      orderTypes: ["LIMIT", "MARKET", "STOP", "TAKE_PROFIT"],
      timeInForce: ["GTC", "IOC", "FOK", "GTX"],
      someBrandNewFieldBinanceAdded: { nested: true },
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.10", minPrice: "556.80", maxPrice: "4529764" },
        { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "1000" },
        { filterType: "MARKET_LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "120" },
        { filterType: "MIN_NOTIONAL", notional: "100" },
      ],
    },
    { symbol: "HALTEDUSDT", status: "BREAK", contractType: "PERPETUAL", filters: [] },
  ],
};

describe("public data normalization", () => {
  it("keeps tick and step sizes as exact decimal strings", () => {
    const filters = normalizeSymbolFilters(EXCHANGE_INFO.symbols[0]);

    expect(filters.tickSize).toBe("0.10"); // trailing zero preserved
    expect(filters.stepSize).toBe("0.001");
    expect(filters.marketStepSize).toBe("0.001");
    expect(filters.minQty).toBe("0.001");
    expect(filters.maxQty).toBe("1000");
    expect(filters.minNotional).toBe("100");
    expect(filters.status).toBe("TRADING");
    expect(filters.contractType).toBe("PERPETUAL");
    expect(filters.orderTypes).toContain("LIMIT");
    expect(filters.timeInForce).toContain("GTC");
    // Unknown upstream fields are ignored, not leaked.
    expect(filters).not.toHaveProperty("someBrandNewFieldBinanceAdded");
  });

  it("reports a non-TRADING symbol truthfully without inventing values", () => {
    const filters = normalizeSymbolFilters(EXCHANGE_INFO.symbols[1]);
    expect(filters.status).toBe("BREAK");
    expect(filters.tickSize).toBeNull();
    expect(filters.stepSize).toBeNull();
  });

  it("rejects an unsupported symbol", async () => {
    mockFetchSequence(response(EXCHANGE_INFO));
    const service = new BinanceReadOnlyService(client());
    await expect(service.inspectSymbol("NOSUCHUSDT")).rejects.toMatchObject({ kind: "UNSUPPORTED_SYMBOL" });
  });

  it("normalizes leverage brackets and derives the maximum initial leverage", async () => {
    const brackets = normalizeLeverageBrackets(
      [
        {
          symbol: "BTCUSDT",
          notionalCoef: 1.5,
          brackets: [
            { bracket: 1, initialLeverage: 125, notionalCap: 50000, notionalFloor: 0, maintMarginRatio: 0.004, cum: 0 },
            { bracket: 2, initialLeverage: 100, notionalCap: 250000, notionalFloor: 50000, maintMarginRatio: 0.005, cum: 50 },
          ],
        },
      ],
      "BTCUSDT"
    );

    expect(brackets).toHaveLength(2);
    expect(brackets[0]).toMatchObject({
      bracket: 1,
      initialLeverage: 125,
      notionalCap: "50000",
      maintMarginRatio: "0.004",
      cum: "0",
    });
    expect(typeof brackets[0].maintMarginRatio).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Private read-only data
// ---------------------------------------------------------------------------

const BALANCES = [
  { accountAlias: "x", asset: "USDT", balance: "1234.56789012", availableBalance: "1000.00000000", crossUnPnl: "-1.5" },
  { accountAlias: "x", asset: "BNB", balance: "0.5", availableBalance: "0.5", crossUnPnl: "0" },
];

const POSITIONS = [
  {
    symbol: "BTCUSDT",
    positionSide: "LONG",
    positionAmt: "0.010",
    entryPrice: "64000.5",
    markPrice: "64100.0",
    liquidationPrice: "0.00000042",
    unRealizedProfit: "1.00",
    notional: "641.0",
    isolatedMargin: "12.34",
    isolatedWallet: "12.00",
    brandNewField: 1,
  },
  {
    symbol: "BTCUSDT",
    positionSide: "SHORT",
    positionAmt: "-0.020",
    entryPrice: "64500.0",
    markPrice: "64100.0",
    liquidationPrice: "70000.1",
    unRealizedProfit: "8.00",
    notional: "-1282.0",
    isolatedMargin: "20.00",
    isolatedWallet: "20.00",
  },
  { symbol: "ETHUSDT", positionSide: "LONG", positionAmt: "0.000", entryPrice: "0.0" },
];

const SYMBOL_CONFIG = [
  { symbol: "BTCUSDT", marginType: "ISOLATED", isAutoAddMargin: "false", leverage: 20, maxNotionalValue: "25000" },
];

function summaryFetch(overrides: { positionMode?: unknown; openOrders?: unknown } = {}) {
  return mockFetchSequence(
    response({}), // ping
    timeResponse(), // syncTime
    response(BALANCES), // balance
    response(overrides.positionMode ?? { dualSidePosition: true }), // positionMode
    response(POSITIONS), // positionRisk
    response(overrides.openOrders ?? []), // openOrders
    response({ multiAssetsMargin: false }), // multiAssetsMode
    response(SYMBOL_CONFIG) // symbolConfig enrichment
  );
}

describe("private read-only data", () => {
  it("normalizes the USDT balance without floating-point conversion", async () => {
    summaryFetch();
    const summary = await new BinanceReadOnlyService(client()).getAccountSummary();

    expect(summary.usdtWalletBalance).toBe("1234.56789012");
    expect(summary.usdtAvailableBalance).toBe("1000.00000000");
  });

  it("detects Hedge Mode from the account setting", async () => {
    summaryFetch();
    const summary = await new BinanceReadOnlyService(client()).getAccountSummary();

    expect(summary.positionMode).toBe("HEDGE");
    expect(summary.warnings).not.toContain(ONE_WAY_MODE_WARNING);
  });

  it("warns (without changing anything) when the account is in ONE_WAY mode", async () => {
    const fetchMock = summaryFetch({ positionMode: { dualSidePosition: false } });
    const summary = await new BinanceReadOnlyService(client()).getAccountSummary();

    expect(summary.positionMode).toBe("ONE_WAY");
    expect(summary.warnings).toContain("WARNING: Expected HEDGE mode, actual mode is ONE_WAY.");
    for (const [, init] of fetchMock.mock.calls) expect((init as RequestInit).method).toBe("GET");
  });

  it("keeps LONG and SHORT positions on the same symbol separate", async () => {
    summaryFetch();
    const summary = await new BinanceReadOnlyService(client()).getAccountSummary();

    const btc = summary.positions.filter((p) => p.symbol === "BTCUSDT");
    expect(btc).toHaveLength(2);
    expect(btc.map((p) => p.positionSide).sort()).toEqual(["LONG", "SHORT"]);
    expect(btc.find((p) => p.positionSide === "LONG")?.positionAmt).toBe("0.010");
    expect(btc.find((p) => p.positionSide === "SHORT")?.positionAmt).toBe("-0.020");
  });

  it("excludes zero-amount positions from the count", async () => {
    summaryFetch();
    const summary = await new BinanceReadOnlyService(client()).getAccountSummary();

    expect(summary.nonZeroPositionCount).toBe(2);
    expect(summary.positions.some((p) => p.symbol === "ETHUSDT")).toBe(false);
    expect(isNonZeroPosition({ positionAmt: "0.000" } as never)).toBe(false);
    expect(isNonZeroPosition({ positionAmt: "-0.020" } as never)).toBe(true);
  });

  it("preserves the liquidation price as an exact decimal string", async () => {
    summaryFetch();
    const summary = await new BinanceReadOnlyService(client()).getAccountSummary();

    const long = summary.positions.find((p) => p.positionSide === "LONG");
    expect(long?.liquidationPrice).toBe("0.00000042");
    expect(typeof long?.liquidationPrice).toBe("string");
    expect(long?.isolatedWallet).toBe("12.00");
    expect(long?.isolatedMargin).toBe("12.34");
  });

  it("enriches margin type and leverage from symbolConfig when positionRisk omits them", async () => {
    summaryFetch();
    const summary = await new BinanceReadOnlyService(client()).getAccountSummary();

    const long = summary.positions.find((p) => p.positionSide === "LONG");
    expect(long?.marginType).toBe("ISOLATED");
    expect(long?.leverage).toBe("20");
  });

  it("counts open orders", async () => {
    summaryFetch({
      openOrders: [
        { orderId: 1, symbol: "BTCUSDT", side: "BUY", positionSide: "LONG", type: "LIMIT", price: "60000", origQty: "0.01" },
        { orderId: 2, symbol: "ETHUSDT", side: "SELL", positionSide: "SHORT", type: "LIMIT", price: "4000", origQty: "0.1" },
      ],
    });
    const summary = await new BinanceReadOnlyService(client()).getAccountSummary();
    expect(summary.openOrderCount).toBe(2);
  });

  it("handles a completely empty account", async () => {
    mockFetchSequence(
      response({}),
      timeResponse(),
      response([]),
      response({ dualSidePosition: true }),
      response([]),
      response([]),
      response({ multiAssetsMargin: false })
    );

    const summary = await new BinanceReadOnlyService(client()).getAccountSummary();
    expect(summary.nonZeroPositionCount).toBe(0);
    expect(summary.openOrderCount).toBe(0);
    expect(summary.positions).toEqual([]);
    expect(summary.usdtWalletBalance).toBeNull();
    expect(summary.warnings.some((w) => w.includes("USDT"))).toBe(true);
  });

  it("tolerates unknown extra fields in every payload", async () => {
    summaryFetch();
    const summary = await new BinanceReadOnlyService(client()).getAccountSummary();
    expect(summary.positions[0]).not.toHaveProperty("brandNewField");
    expect(Object.keys(summary.positions[0]).sort()).toEqual([
      "entryPrice",
      "isolatedMargin",
      "isolatedWallet",
      "leverage",
      "liquidationPrice",
      "markPrice",
      "marginType",
      "notional",
      "positionAmt",
      "positionSide",
      "symbol",
      "unrealizedProfit",
    ].sort());
  });

  it("normalizes position mode payloads defensively", () => {
    expect(normalizePositionMode({ dualSidePosition: true })).toBe("HEDGE");
    expect(normalizePositionMode({ dualSidePosition: "false" })).toBe("ONE_WAY");
    expect(normalizePositionMode({})).toBeNull();
    expect(normalizePositions(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Decimal preservation (regression)
// ---------------------------------------------------------------------------

/**
 * SYNTHETIC positions in the exact SHAPE of a /fapi/v3/positionRisk response:
 * every numeric field is a JSON string, so all of them must survive
 * byte-for-byte and must never be "cleaned up" by float conversion.
 *
 * No real account data is used. The values are chosen to cover the tricky
 * cases rather than to describe any portfolio:
 *  - TESTAUSDT: long binary-expansion average entry (0.1 + 0.2 in IEEE-754),
 *    the shape Binance produces when it serializes a computed average;
 *  - TESTBUSDT: SHORT with a negative amount and a second long expansion;
 *  - MOCKUSDT:  trailing-zero price "0.10" and a fractional amount;
 *  - ZEROUSDT:  zero amount, which must be filtered out.
 */
const SYNTHETIC_POSITION_RISK = [
  {
    symbol: "TESTAUSDT",
    positionSide: "LONG",
    positionAmt: "500",
    entryPrice: "0.30000000000000004",
    breakEvenPrice: "0.300075",
    markPrice: "0.31000000",
    unRealizedProfit: "5.00000000",
    liquidationPrice: "0.20500000",
    isolatedMargin: "10.10000000",
    notional: "155.00000000",
    marginAsset: "USDT",
    isolatedWallet: "10.00000000",
    initialMargin: "10.00000000",
    maintMargin: "0.77500000",
    adl: 2,
    updateTime: 1700000000000,
  },
  {
    symbol: "TESTBUSDT",
    positionSide: "SHORT",
    positionAmt: "-25",
    entryPrice: "2.6749999999999998",
    markPrice: "2.50000000",
    liquidationPrice: "3.10000000",
    isolatedMargin: "0",
    isolatedWallet: "0",
    notional: "-62.50000000",
  },
  {
    symbol: "MOCKUSDT",
    positionSide: "LONG",
    positionAmt: "12.5",
    entryPrice: "0.10",
    markPrice: "0.10500000",
    liquidationPrice: "0.08000000",
    isolatedMargin: "1.00000000",
    isolatedWallet: "1.00000000",
    notional: "1.31250000",
  },
  {
    symbol: "ZEROUSDT",
    positionSide: "LONG",
    positionAmt: "0.000",
    entryPrice: "0.0",
    markPrice: "0.00000000",
    liquidationPrice: "0",
    isolatedMargin: "0",
    isolatedWallet: "0",
    notional: "0",
  },
] as const;

/** Synthetic per-symbol config: covers ISOLATED and CROSS, leverage as a JSON number. */
const SYNTHETIC_SYMBOL_CONFIG = [
  { symbol: "TESTAUSDT", marginType: "ISOLATED", isAutoAddMargin: false, leverage: 3, maxNotionalValue: "250000" },
  { symbol: "TESTBUSDT", marginType: "CROSS", isAutoAddMargin: false, leverage: 25, maxNotionalValue: "100000" },
];

describe("decimal preservation", () => {
  it("passes every string value through byte-for-byte", () => {
    const positions = normalizePositions(SYNTHETIC_POSITION_RISK);

    for (const raw of SYNTHETIC_POSITION_RISK) {
      if (raw.symbol === "ZEROUSDT") continue; // filtered out downstream
      const dto = positions.find((p) => p.symbol === raw.symbol && p.positionSide === raw.positionSide)!;
      expect(dto.positionAmt).toBe(raw.positionAmt);
      expect(dto.entryPrice).toBe(raw.entryPrice);
      expect(dto.markPrice).toBe(raw.markPrice);
      expect(dto.liquidationPrice).toBe(raw.liquidationPrice);
      expect(dto.isolatedMargin).toBe(raw.isolatedMargin);
      expect(dto.isolatedWallet).toBe(raw.isolatedWallet);
      expect(dto.notional).toBe(raw.notional);
    }
  });

  it("keeps long binary-expansion entry averages exactly (never rounded or re-rendered)", () => {
    const positions = normalizePositions(SYNTHETIC_POSITION_RISK);

    // Binance serializes a computed average entry as a full double expansion.
    // Shortening it here would misreport the real average entry price.
    expect(positions.find((p) => p.symbol === "TESTAUSDT")!.entryPrice).toBe("0.30000000000000004");
    expect(positions.find((p) => p.symbol === "TESTBUSDT")!.entryPrice).toBe("2.6749999999999998");
  });

  it("preserves trailing zeros, integers and negatives", () => {
    expect(decimalString("0.10")).toBe("0.10");
    expect(decimalString("0.10500000")).toBe("0.10500000");
    expect(decimalString("-25")).toBe("-25");
    expect(decimalString("500")).toBe("500");
    expect(decimalString("0")).toBe("0");
    expect(decimalString("0.30000000000000004")).toBe("0.30000000000000004");
  });

  it("is an exact identity for any decimal-shaped string (no reformatting)", () => {
    const samples = [
      "0.00000001", "1e-7", "0.10", "10.00", "000123.4500", "-0.5",
      "123456789.123456789012345", "0.30000000000000004", "2.6749999999999998",
    ];
    for (const sample of samples) expect(decimalString(sample)).toBe(sample);
  });

  it("never applies float conversion helpers to decimal fields", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src", "modules", "binance", "binance.normalize.ts"),
      "utf8"
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

    // No float parsing anywhere in the module.
    expect(code).not.toContain("parseFloat(");
    expect(code).not.toContain("Number.parseFloat(");
    // Number()/parseInt are confined to integer metadata, never decimals:
    // decimalString itself must contain no conversion call at all.
    const decimalFn = code.slice(code.indexOf("export function decimalString"));
    const body = decimalFn.slice(0, decimalFn.indexOf("\n}"));
    expect(body).not.toContain("parseInt(");
    expect(body).not.toMatch(/[^.\w]Number\(/);
  });

  it("handles an unexpected JSON number defensively, without exponent notation", () => {
    // JSON.parse already lost the literal here — we only guarantee that no
    // further float math happens and that the text is a usable decimal.
    expect(decimalString(3)).toBe("3");
    expect(decimalString(0.03842)).toBe("0.03842");
    // String(1.2e-7) would leak "1.2e-7"; expanded textually instead.
    expect(decimalString(1.2e-7)).toBe("0.00000012");
    expect(decimalString(-1.5e-8)).toBe("-0.000000015");
    expect(expandExponentialNotation("1.5e+21")).toBe("1500000000000000000000");
    expect(expandExponentialNotation("0.5")).toBe("0.5"); // untouched
    expect(decimalString(Number.NaN)).toBeNull();
  });

  it("survives the full summary pipeline without altering a single digit", async () => {
    mockFetchSequence(
      response({}),
      timeResponse(),
      response([{ asset: "USDT", balance: "1000.12345678", availableBalance: "750.00000000" }]),
      response({ dualSidePosition: true }),
      response(SYNTHETIC_POSITION_RISK),
      response([]),
      response({ multiAssetsMargin: false }),
      response(SYNTHETIC_SYMBOL_CONFIG)
    );

    const summary = await new BinanceReadOnlyService(client()).getAccountSummary();

    expect(summary.usdtWalletBalance).toBe("1000.12345678");
    expect(summary.usdtAvailableBalance).toBe("750.00000000");
    // ZEROUSDT is filtered out; the other three survive.
    expect(summary.nonZeroPositionCount).toBe(3);

    const testA = summary.positions.find((p) => p.symbol === "TESTAUSDT")!;
    expect(testA.entryPrice).toBe("0.30000000000000004");
    expect(testA.positionAmt).toBe("500");
    expect(testA.isolatedWallet).toBe("10.00000000");
    expect(testA.markPrice).toBe("0.31000000");
    // leverage arrives from symbolConfig as a JSON number (integer -> exact).
    expect(testA.leverage).toBe("3");
    expect(testA.marginType).toBe("ISOLATED");

    // SHORT side, negative amount, and CROSS margin from symbolConfig.
    const testB = summary.positions.find((p) => p.symbol === "TESTBUSDT")!;
    expect(testB.positionSide).toBe("SHORT");
    expect(testB.positionAmt).toBe("-25");
    expect(testB.entryPrice).toBe("2.6749999999999998");
    expect(testB.liquidationPrice).toBe("3.10000000");
    expect(testB.leverage).toBe("25");
    expect(testB.marginType).toBe("CROSS");

    // Trailing-zero price and fractional amount survive untouched.
    const mock = summary.positions.find((p) => p.symbol === "MOCKUSDT")!;
    expect(mock.entryPrice).toBe("0.10");
    expect(mock.positionAmt).toBe("12.5");
  });

  it("contains no live-account data in this suite's fixtures", () => {
    const source = readFileSync(path.join(process.cwd(), "tests", "binance-read-only.test.ts"), "utf8");
    // Symbols used in position/account fixtures are synthetic placeholders.
    for (const symbol of ["TESTAUSDT", "TESTBUSDT", "MOCKUSDT", "ZEROUSDT"]) {
      expect(source).toContain(symbol);
    }
    // No captured-live-payload fixture remains (matched as a declaration so
    // this assertion does not trip over its own text).
    expect(source).not.toMatch(/const\s+LIVE_[A-Z_]+\s*=/);
    expect(source).not.toMatch(/captured from (a|the) real/i);
  });
});

// ---------------------------------------------------------------------------
// Reliability
// ---------------------------------------------------------------------------

describe("reliability", () => {
  it("respects Retry-After on 429 and eventually succeeds", async () => {
    const sleeps: number[] = [];
    vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === "number" && ms > 0) sleeps.push(ms);
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as never);

    const fetchMock = mockFetchSequence(
      timeResponse(),
      response({ code: -1003, msg: "Too many requests" }, { status: 429, headers: { "retry-after": "2" } }),
      response([{ symbol: "BTCUSDT" }])
    );

    await client().request("openOrders");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toContain(2000); // Retry-After: 2s honoured
  });

  it("retries 5xx with bounded attempts then gives up", async () => {
    vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as never);

    const fetchMock = mockFetchSequence(
      timeResponse(),
      response({ code: -1001, msg: "Internal error" }, { status: 503 }),
      response({ code: -1001, msg: "Internal error" }, { status: 503 }),
      response({ code: -1001, msg: "Internal error" }, { status: 503 })
    );

    await expect(client().request("openOrders")).rejects.toMatchObject({ kind: "SERVER" });
    // time sync + exactly MAX_ATTEMPTS (3) request attempts — bounded.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries a network failure but not forever", async () => {
    vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as never);

    const fn = vi.fn();
    fn.mockResolvedValueOnce(timeResponse());
    fn.mockRejectedValue(new Error("socket hang up"));
    global.fetch = fn as unknown as typeof fetch;

    await expect(client().request("openOrders")).rejects.toMatchObject({ kind: "NETWORK" });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("classifies an abort as a timeout", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fn = vi.fn();
    fn.mockResolvedValueOnce(timeResponse());
    fn.mockRejectedValue(abort);
    global.fetch = fn as unknown as typeof fetch;

    vi.spyOn(global, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as never);

    await expect(client().request("openOrders")).rejects.toMatchObject({ kind: "TIMEOUT" });
  });

  it("does NOT retry authentication, permission or validation failures", async () => {
    const cases: Array<[number, number, string]> = [
      [401, -2015, "Invalid API-key, IP, or permissions for action."],
      [400, -1022, "Signature for this request is not valid."],
      [400, -1121, "Invalid symbol."],
      [403, 0, "WAF limit violated"],
    ];

    for (const [status, code, msg] of cases) {
      const fetchMock = mockFetchSequence(timeResponse(), response({ code, msg }, { status }));
      await expect(client().request("balance")).rejects.toBeInstanceOf(BinanceError);
      // Exactly one attempt after the time sync — no retry storm.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("classifies IP restriction and rate-limit bans distinctly", async () => {
    mockFetchSequence(
      timeResponse(),
      response({ code: -2015, msg: "Invalid API-key, IP, or permissions for action, request ip: 1.2.3.4" }, { status: 401 })
    );
    await expect(client().request("balance")).rejects.toMatchObject({ kind: "IP_RESTRICTED" });

    vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as never);
    mockFetchSequence(
      timeResponse(),
      response({ msg: "banned" }, { status: 418 }),
      response({ msg: "banned" }, { status: 418 }),
      response({ msg: "banned" }, { status: 418 })
    );
    await expect(client().request("balance")).rejects.toMatchObject({ kind: "IP_BANNED" });
  });

  it("surfaces a malformed JSON body as MALFORMED_RESPONSE", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    }) as unknown as typeof fetch;

    await expect(client().request("exchangeInfo")).rejects.toMatchObject({ kind: "MALFORMED_RESPONSE" });
  });
});

// ---------------------------------------------------------------------------
// Endpoint definitions
// ---------------------------------------------------------------------------

describe("endpoint definitions", () => {
  it("uses the current documented v3 account endpoints", () => {
    expect(BINANCE_READ_ONLY_ENDPOINTS.balance.path).toBe("/fapi/v3/balance");
    expect(BINANCE_READ_ONLY_ENDPOINTS.account.path).toBe("/fapi/v3/account");
    expect(BINANCE_READ_ONLY_ENDPOINTS.positionRisk.path).toBe("/fapi/v3/positionRisk");
    expect(BINANCE_READ_ONLY_ENDPOINTS.positionMode.path).toBe("/fapi/v1/positionSide/dual");
  });

  it("marks public endpoints unsigned and account endpoints signed", () => {
    expect(BINANCE_READ_ONLY_ENDPOINTS.ping.signed).toBe(false);
    expect(BINANCE_READ_ONLY_ENDPOINTS.serverTime.signed).toBe(false);
    expect(BINANCE_READ_ONLY_ENDPOINTS.exchangeInfo.signed).toBe(false);
    for (const name of ["balance", "account", "positionRisk", "positionMode", "openOrders", "leverageBracket"] as const) {
      expect(BINANCE_READ_ONLY_ENDPOINTS[name].signed).toBe(true);
    }
  });
});
