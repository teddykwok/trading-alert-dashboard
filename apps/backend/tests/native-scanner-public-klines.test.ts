import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  KLINES_PATH,
  SERVER_TIME_PATH,
  ScannerDataError,
  assertPublicFuturesBaseUrl,
  assertScannerSymbol,
  buildPublicFuturesUrl,
  intervalMsOf,
  parseFuturesKlineRow,
  parseFuturesKlinesPayload,
  parseRetryAfterMs,
  parseServerTimePayload,
} from "../src/modules/native-scanner/binance-public-futures";
import {
  CONSERVATIVE_REQUEST_POLICY,
  assertRequestPolicy,
  fetchClosedFuturesKlines,
  type ClosedKlineRangeRequest,
  type PublicRequestPolicy,
} from "../src/modules/native-scanner/kline-fetcher";
import {
  FIFTEEN_MINUTES_MS as I,
  T_2025_01_01,
  fakeBinance,
  forbidRealNetwork,
  manualClock,
  plainKlines,
  toBinanceRow,
  type ScriptedResponse,
} from "./helpers/native-scanner-fakes";

/**
 * Slice 2A — the scanner's public Binance Futures data layer.
 * Every response here is fake; the real network is forbidden for this file.
 */

let restoreNetwork: () => void;
beforeAll(() => {
  restoreNetwork = forbidRealNetwork();
});
afterAll(() => restoreNetwork());

const BASE = "https://fapi.binance.com";
const codeOf = async (thunk: () => unknown): Promise<string | null> => {
  try {
    await thunk();
    return null;
  } catch (error) {
    return error instanceof ScannerDataError ? error.code : `unexpected: ${String(error)}`;
  }
};
const syncCodeOf = (thunk: () => unknown): string | null => {
  try {
    thunk();
    return null;
  } catch (error) {
    return error instanceof ScannerDataError ? error.code : `unexpected: ${String(error)}`;
  }
};

const ROW = [T_2025_01_01, "100.10", "101.50", "99.25", "100.75", "12.5", T_2025_01_01 + I - 1, "1250.0", 42, "6.0", "600.0", "0"];

// ===========================================================================
// 1-6. Strict row parsing
// ===========================================================================

describe("kline row parsing", () => {
  // 1.
  it("parses a Binance Futures row into a closed kline with plain numbers", () => {
    expect(parseFuturesKlineRow(ROW, I)).toEqual({
      openTimeMs: T_2025_01_01,
      closeTimeMs: T_2025_01_01 + I - 1,
      open: 100.1,
      high: 101.5,
      low: 99.25,
      close: 100.75,
    });
  });

  // 2.
  it.each([
    ["not an array", { 0: 1 }],
    ["11 fields", ROW.slice(0, 11)],
    ["13 fields", [...ROW, "extra"]],
    ["string openTime", [String(ROW[0]), ...ROW.slice(1)]],
    ["fractional closeTime", [...ROW.slice(0, 6), (ROW[6] as number) + 0.5, ...ROW.slice(7)]],
    ["numeric price", [ROW[0], 100.1, ...ROW.slice(2)]],
    ["empty price", [ROW[0], "", ...ROW.slice(2)]],
    ["padded price", [ROW[0], " 100.1", ...ROW.slice(2)]],
    ["exponent price", [ROW[0], "1e2", ...ROW.slice(2)]],
    ["negative price", [ROW[0], "-100.1", ...ROW.slice(2)]],
    ["zero price", [ROW[0], "0", "101.5", "0", ...ROW.slice(4)]],
  ])("rejects a malformed row: %s", (_label, row) => {
    expect(syncCodeOf(() => parseFuturesKlineRow(row, I))).toBe("MALFORMED_ROW");
  });

  // 3.
  it.each(["NaN", "Infinity", "-Infinity", "0x10"])("rejects the non-finite or non-decimal price %s", (value) => {
    expect(syncCodeOf(() => parseFuturesKlineRow([ROW[0], value, ...ROW.slice(2)], I))).toBe("MALFORMED_ROW");
  });

  // 4.
  it.each([
    ["high below low", ["100.0", "98.0", "99.0", "98.5"]],
    ["high below close", ["100.0", "100.5", "99.0", "101.0"]],
    ["high below open", ["102.0", "101.5", "99.0", "100.0"]],
    ["low above open", ["99.0", "101.5", "99.5", "100.0"]],
    ["low above close", ["100.0", "101.5", "99.5", "99.0"]],
  ])("rejects impossible geometry: %s", (_label, [open, high, low, close]) => {
    expect(syncCodeOf(() => parseFuturesKlineRow([ROW[0], open, high, low, close, ...ROW.slice(5)], I))).toBe("MALFORMED_ROW");
  });

  // 5.
  it.each([
    ["closeTime == openTime", T_2025_01_01],
    ["closeTime before openTime", T_2025_01_01 - 1],
    ["closeTime of a different interval", T_2025_01_01 + 2 * I - 1],
  ])("rejects %s", (_label, closeTime) => {
    expect(syncCodeOf(() => parseFuturesKlineRow([...ROW.slice(0, 6), closeTime, ...ROW.slice(7)], I))).toBe("MALFORMED_ROW");
  });

  it("rejects times beyond the safe-integer range even when aligned and self-consistent", () => {
    // 900000 * 2^34 is exactly representable and interval-aligned, but above 2^53:
    // only the integer check can refuse it.
    const open = I * 2 ** 34;
    expect(Number.isSafeInteger(open)).toBe(false);
    expect(syncCodeOf(() => parseFuturesKlineRow([open, ...ROW.slice(1, 6), open + I - 1, ...ROW.slice(7)], I))).toBe(
      "MALFORMED_ROW"
    );
  });

  it("rejects an openTime that is not aligned to the interval", () => {
    const shifted = [T_2025_01_01 + 60_000, ...ROW.slice(1, 6), T_2025_01_01 + 60_000 + I - 1, ...ROW.slice(7)];
    expect(syncCodeOf(() => parseFuturesKlineRow(shifted, I))).toBe("MALFORMED_ROW");
  });

  // 6.
  it("converts decimal strings to the same doubles every time, trailing zeros included", () => {
    const row = [ROW[0], "0.44610000", "0.44700000", "0.44500000", "0.44650000", ...ROW.slice(5)];
    const kline = parseFuturesKlineRow(row, I);
    expect([kline.open, kline.high, kline.low, kline.close]).toEqual([0.4461, 0.447, 0.445, 0.4465]);
    expect(kline.open).toBe(Number("0.4461"));
    expect(parseFuturesKlineRow(toBinanceRow(kline), I)).toEqual(kline);
  });

  it("refuses a payload that is not an array, and a server time that is not an integer", () => {
    expect(syncCodeOf(() => parseFuturesKlinesPayload({ code: -1121 }, I))).toBe("MALFORMED_RESPONSE");
    expect(syncCodeOf(() => parseServerTimePayload({ serverTime: "123" }))).toBe("MALFORMED_RESPONSE");
    expect(parseServerTimePayload({ serverTime: 1_800_000_000_000 })).toBe(1_800_000_000_000);
  });
});

// ===========================================================================
// 18-19. Only public market-data endpoints, with no credentials
// ===========================================================================

describe("public endpoint guard", () => {
  // 18.
  it("builds only the allowlisted public paths, with parameters in a fixed order", () => {
    expect(buildPublicFuturesUrl(BASE, SERVER_TIME_PATH)).toBe("https://fapi.binance.com/fapi/v1/time");
    expect(
      buildPublicFuturesUrl(BASE, KLINES_PATH, { limit: 1000, endTime: 2, startTime: 1, interval: "15m", symbol: "BTCUSDT" })
    ).toBe("https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&startTime=1&endTime=2&limit=1000");
  });

  it.each([
    "/fapi/v1/order",
    "/fapi/v1/openOrders",
    "/fapi/v2/account",
    "/fapi/v3/account",
    "/fapi/v2/balance",
    "/fapi/v3/positionRisk",
    "/fapi/v1/positionSide/dual",
    "/fapi/v1/leverage",
    "/fapi/v1/marginType",
    "/fapi/v1/userTrades",
    "/fapi/v1/listenKey",
    "/fapi/v1/algoOrder",
    "/fapi/v1/klines/../order",
    "/api/v3/klines",
  ])("can never build %s", (pathName) => {
    expect(syncCodeOf(() => buildPublicFuturesUrl(BASE, pathName))).toBe("FORBIDDEN_ENDPOINT");
  });

  // 19.
  it.each(["signature", "timestamp", "recvWindow", "apiKey", "X-MBX-APIKEY", "listenKey"])(
    "can never add the parameter %s",
    (key) => {
      expect(syncCodeOf(() => buildPublicFuturesUrl(BASE, KLINES_PATH, { symbol: "BTCUSDT", [key]: "x" }))).toBe(
        "FORBIDDEN_PARAMETER"
      );
      expect(syncCodeOf(() => buildPublicFuturesUrl(BASE, SERVER_TIME_PATH, { [key]: "x" }))).toBe("FORBIDDEN_PARAMETER");
    }
  );

  it.each([
    "http://fapi.binance.com",
    "https://api.binance.com",
    "https://testnet.binancefuture.com",
    "https://fapi.binance.com.example.com",
    "https://user:pass@fapi.binance.com",
    "https://fapi.binance.com/fapi",
    "https://fapi.binance.com?x=1",
    "https://fapi.binance.com:8443",
    "not a url",
  ])("refuses the base URL %s", (base) => {
    expect(syncCodeOf(() => assertPublicFuturesBaseUrl(base))).toBe("UNTRUSTED_BASE_URL");
  });

  it("accepts the configured mainnet origin", () => {
    expect(assertPublicFuturesBaseUrl("https://fapi.binance.com/")).toBe("https://fapi.binance.com");
  });

  it("sends only Accept: application/json, and no credential-like parameter, across a whole run", async () => {
    const clock = manualClock();
    const data = plainKlines(T_2025_01_01, 2500);
    const binance = fakeBinance({ klines: data, serverTimeMs: T_2025_01_01 + 3000 * I, clock });
    await fetchClosedFuturesKlines(deps(binance.transport, clock), range(2500));
    expect(binance.calls.length).toBeGreaterThan(1);
    for (const call of binance.calls) {
      expect(call.headers).toEqual({ Accept: "application/json" });
      const url = new URL(call.url);
      expect(url.origin).toBe(BASE);
      expect([SERVER_TIME_PATH, KLINES_PATH]).toContain(url.pathname);
      for (const key of url.searchParams.keys()) expect(["symbol", "interval", "startTime", "endTime", "limit"]).toContain(key);
    }
  });
});

// ===========================================================================
// 7-12. Pagination
// ===========================================================================

function deps(transport: Parameters<typeof fetchClosedFuturesKlines>[0]["transport"], clock: ReturnType<typeof manualClock>, policy: Partial<PublicRequestPolicy> = {}) {
  return {
    transport,
    baseUrl: BASE,
    policy: { ...CONSERVATIVE_REQUEST_POLICY, ...policy },
    nowMs: clock.nowMs,
    sleep: clock.sleep,
  };
}

function range(bars: number, extra: Partial<ClosedKlineRangeRequest> = {}): ClosedKlineRangeRequest {
  return {
    symbol: "BTCUSDT",
    interval: "15m",
    startMs: T_2025_01_01,
    endMs: T_2025_01_01 + bars * I,
    maxBars: 10_000,
    pageLimit: 1000,
    settleMs: 5_000,
    ...extra,
  };
}

describe("pagination", () => {
  const data = plainKlines(T_2025_01_01, 2500);
  const serverTimeMs = T_2025_01_01 + 3000 * I;

  // 7. / 8.
  it("pages forward in openTime order, each page starting exactly after the last row it already has", async () => {
    const clock = manualClock();
    const binance = fakeBinance({ klines: data, serverTimeMs, clock });
    const result = await fetchClosedFuturesKlines(deps(binance.transport, clock), range(2500));
    expect(result.klines).toEqual(data);
    expect(result.requestsMade).toBe(4); // time + 3 pages
    const starts = binance.calls.slice(1).map((c) => Number(new URL(c.url).searchParams.get("startTime")));
    expect(starts).toEqual([T_2025_01_01, T_2025_01_01 + 1000 * I, T_2025_01_01 + 2000 * I]);
    expect(binance.maxInFlight).toBe(1);
  });

  it("a range ending exactly on a page boundary makes no extra request", async () => {
    const clock = manualClock();
    const binance = fakeBinance({ klines: data, serverTimeMs, clock });
    const result = await fetchClosedFuturesKlines(deps(binance.transport, clock), range(2000));
    expect(result.klines).toEqual(data.slice(0, 2000));
    expect(result.requestsMade).toBe(3);
  });

  // 9.
  it("absorbs a page that overlaps the previous one with IDENTICAL rows", async () => {
    const clock = manualClock();
    const binance = fakeBinance({
      klines: data,
      serverTimeMs,
      clock,
      tamperPage: (rows, { startTime }) =>
        startTime === T_2025_01_01 ? rows : [data.find((k) => k.openTimeMs === startTime - I)!, ...rows],
    });
    const result = await fetchClosedFuturesKlines(deps(binance.transport, clock), range(2500));
    expect(result.klines).toEqual(data);
  });

  // 10.
  it("refuses an overlapping row that CONTRADICTS the earlier page", async () => {
    const clock = manualClock();
    const binance = fakeBinance({
      klines: data,
      serverTimeMs,
      clock,
      tamperPage: (rows, { startTime }) => {
        if (startTime === T_2025_01_01) return rows;
        const earlier = data.find((k) => k.openTimeMs === startTime - I)!;
        return [{ ...earlier, close: earlier.close + 0.01 }, ...rows];
      },
    });
    expect(await codeOf(() => fetchClosedFuturesKlines(deps(binance.transport, clock), range(2500)))).toBe(
      "CONTRADICTORY_ROW"
    );
  });

  // 11.
  it("stops when a page does not move forward", async () => {
    const clock = manualClock();
    const binance = fakeBinance({
      klines: data,
      serverTimeMs,
      clock,
      tamperPage: () => data.slice(0, 1000), // ignores startTime: the same first page every time
    });
    expect(await codeOf(() => fetchClosedFuturesKlines(deps(binance.transport, clock), range(2500)))).toBe(
      "PAGINATION_STALLED"
    );
    expect(binance.calls.length).toBe(3);
  });

  // 12.
  it("stops at the request budget and sends nothing past it", async () => {
    const clock = manualClock();
    const binance = fakeBinance({ klines: data, serverTimeMs, clock });
    expect(
      await codeOf(() => fetchClosedFuturesKlines(deps(binance.transport, clock, { maxRequests: 2 }), range(2500)))
    ).toBe("REQUEST_BUDGET_EXHAUSTED");
    expect(binance.calls.length).toBe(2);
  });

  it("refuses a row outside the requested range", async () => {
    const clock = manualClock();
    const binance = fakeBinance({
      klines: data,
      serverTimeMs,
      clock,
      tamperPage: (rows) => [{ ...rows[0], openTimeMs: T_2025_01_01 - I, closeTimeMs: T_2025_01_01 - 1 }, ...rows],
    });
    expect(await codeOf(() => fetchClosedFuturesKlines(deps(binance.transport, clock), range(500)))).toBe("OUT_OF_RANGE_ROW");
  });

  it("returns what exists when the exchange has no more data, stopping at the first empty page", async () => {
    const clock = manualClock();
    const binance = fakeBinance({ klines: data.slice(0, 1200), serverTimeMs, clock });
    const result = await fetchClosedFuturesKlines(deps(binance.transport, clock), range(2500));
    expect(result.klines).toEqual(data.slice(0, 1200));
    expect(binance.calls.length).toBe(4); // time, 1000 rows, 200 rows, empty
  });

  it("refuses a page that is not strictly ordered by openTime", async () => {
    const clock = manualClock();
    const binance = fakeBinance({ klines: data, serverTimeMs, clock, tamperPage: (rows) => [rows[1], rows[0], ...rows.slice(2)] });
    expect(await codeOf(() => fetchClosedFuturesKlines(deps(binance.transport, clock), range(500)))).toBe("MALFORMED_RESPONSE");
  });

  it("refuses an unbounded, misaligned or oversized range before sending anything", async () => {
    const clock = manualClock();
    const binance = fakeBinance({ klines: data, serverTimeMs, clock });
    const d = deps(binance.transport, clock);
    expect(await codeOf(() => fetchClosedFuturesKlines(d, range(10, { endMs: T_2025_01_01 })))).toBe("INVALID_RANGE");
    expect(await codeOf(() => fetchClosedFuturesKlines(d, range(10, { startMs: T_2025_01_01 + 1 })))).toBe("INVALID_RANGE");
    expect(await codeOf(() => fetchClosedFuturesKlines(d, range(2500, { maxBars: 2499 })))).toBe("RANGE_TOO_LARGE");
    expect(await codeOf(() => fetchClosedFuturesKlines(d, range(10, { pageLimit: 1501 })))).toBe("INVALID_RANGE");
    expect(binance.calls).toEqual([]);
  });

  it("refuses a range whose last bar has not closed by Binance's clock, after one time request only", async () => {
    const clock = manualClock();
    // The 2500th bar closes at start + 2500*I - 1; Binance is only 1s past it, inside the 5s settle.
    const binance = fakeBinance({ klines: data, serverTimeMs: T_2025_01_01 + 2500 * I + 1000, clock });
    expect(await codeOf(() => fetchClosedFuturesKlines(deps(binance.transport, clock), range(2500)))).toBe("RANGE_NOT_CLOSED");
    expect(binance.calls.map((c) => new URL(c.url).pathname)).toEqual([SERVER_TIME_PATH]);
  });
});

// ===========================================================================
// 13-17. Rate limits, retries and pacing
// ===========================================================================

describe("rate-limit discipline", () => {
  const data = plainKlines(T_2025_01_01, 2500);
  const serverTimeMs = T_2025_01_01 + 3000 * I;
  const run = async (script: Record<number, ScriptedResponse>, policy: Partial<PublicRequestPolicy> = {}, bars = 500) => {
    const clock = manualClock();
    const binance = fakeBinance({ klines: data, serverTimeMs, clock, script });
    let error: unknown = null;
    let result = null;
    try {
      result = await fetchClosedFuturesKlines(deps(binance.transport, clock, policy), range(bars));
    } catch (e) {
      error = e;
    }
    return { binance, clock, error: error as ScannerDataError | null, result };
  };

  // 13.
  it("418 stops the run at once, with no retry, and reports Retry-After", async () => {
    const { binance, error } = await run({ 1: { status: 418, headers: { "Retry-After": "300" } } });
    expect(error?.code).toBe("IP_BANNED");
    expect(error?.retryAfterMs).toBe(300_000);
    expect(binance.calls.length).toBe(2);
  });

  // 14.
  it("429 stops the run at once, with no retry", async () => {
    const { binance, error } = await run({ 1: { status: 429, headers: { "retry-after": "7" } } });
    expect(error?.code).toBe("RATE_LIMITED");
    expect(error?.retryAfterMs).toBe(7_000);
    expect(binance.calls.length).toBe(2);
  });

  // 15.
  it("parses Retry-After as delta-seconds or an HTTP-date, and nothing else", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(parseRetryAfterMs("120", now)).toBe(120_000);
    expect(parseRetryAfterMs(" 0 ", now)).toBe(0);
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("1.5", now)).toBeNull();
    expect(parseRetryAfterMs("-5", now)).toBeNull();
    expect(parseRetryAfterMs("soon", now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
  });

  it("a 429 without Retry-After still stops, reporting no wait it does not know", async () => {
    const { error } = await run({ 1: { status: 429 } });
    expect(error?.code).toBe("RATE_LIMITED");
    expect(error?.retryAfterMs).toBeNull();
  });

  // 16.
  it("retries transient failures a bounded number of times, with doubling backoff", async () => {
    const { binance, clock, error, result } = await run({
      1: { status: 503 },
      2: { status: 0, throws: true },
    });
    expect(error).toBeNull();
    expect(result?.klines).toHaveLength(500);
    expect(binance.calls.length).toBe(4); // time, 503, throw, success
    expect(clock.sleeps.filter((ms) => ms >= 2000)).toEqual([2000, 4000]);
  });

  // 17.
  it("never storms: a persistent 5xx gives up after 1 + maxTransientRetries attempts", async () => {
    const { binance, error } = await run({ 1: { status: 500 }, 2: { status: 502 }, 3: { status: 503 }, 4: { status: 504 } });
    expect(error?.code).toBe("HTTP_ERROR");
    expect(binance.calls.length).toBe(1 + 1 + CONSERVATIVE_REQUEST_POLICY.maxTransientRetries);
  });

  it("does not retry a 4xx or a malformed body at all", async () => {
    const bad = await run({ 1: { status: 400, body: '{"code":-1121}' } });
    expect(bad.error?.code).toBe("HTTP_ERROR");
    expect(bad.binance.calls.length).toBe(2);
    const garbled = await run({ 1: { status: 200, body: "<html>" } });
    expect(garbled.error?.code).toBe("MALFORMED_RESPONSE");
    expect(garbled.binance.calls.length).toBe(2);
  });

  it("retries count against the budget", async () => {
    const { binance, error } = await run({ 1: { status: 503 }, 2: { status: 503 } }, { maxRequests: 3 });
    expect(error?.code).toBe("REQUEST_BUDGET_EXHAUSTED");
    expect(binance.calls.length).toBe(3);
  });

  it("spaces request starts by at least minSpacingMs, one request at a time", async () => {
    const { binance } = await run({}, {}, 2500);
    const gaps = binance.calls.slice(1).map((call, i) => call.atMs - binance.calls[i].atMs);
    expect(gaps.every((gap) => gap >= CONSERVATIVE_REQUEST_POLICY.minSpacingMs)).toBe(true);
    expect(binance.maxInFlight).toBe(1);
  });

  it.each([
    ["spacing below the floor", { minSpacingMs: 100 }],
    ["a budget above the ceiling", { maxRequests: 501 }],
    ["more retries than allowed", { maxTransientRetries: 4 }],
    ["backoff shorter than spacing", { transientBackoffMs: 500 }],
    ["a zero budget", { maxRequests: 0 }],
  ])("refuses a request policy with %s", (_label, patch) => {
    expect(syncCodeOf(() => assertRequestPolicy({ ...CONSERVATIVE_REQUEST_POLICY, ...patch }))).toBe("INVALID_RANGE");
  });
});

// ===========================================================================
// 38-39. One symbol, one supported interval
// ===========================================================================

describe("symbol and interval", () => {
  // 38.
  it.each(["btcusdt", "BTCUSDT,ETHUSDT", "BINANCE:BTCUSDT.P", "BTC USDT", "", "../BTCUSDT", "BT"])(
    "rejects the symbol %j",
    (symbol) => {
      expect(syncCodeOf(() => assertScannerSymbol(symbol))).toBe("INVALID_SYMBOL");
    }
  );

  it("accepts one bare uppercase symbol", () => {
    expect(assertScannerSymbol("BTCUSDT")).toBe("BTCUSDT");
    expect(assertScannerSymbol("1000PEPEUSDT")).toBe("1000PEPEUSDT");
  });

  // 39.
  it("supports exactly the 15m chart interval", () => {
    expect(intervalMsOf("15m")).toBe(I);
    for (const interval of ["1h", "15M", "5m", "1d", "", "toString"]) {
      expect(syncCodeOf(() => intervalMsOf(interval))).toBe("UNSUPPORTED_INTERVAL");
    }
  });
});
