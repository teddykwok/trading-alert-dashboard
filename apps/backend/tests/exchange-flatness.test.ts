import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  countsFromWire,
  type PreShutdownCounts,
  type PreShutdownReads,
} from "../src/modules/binance/pre-shutdown-exchange-check";
import {
  describeExchangeFlatness,
  readExchangeFlatness,
  type ExchangeFlatnessDto,
} from "../src/modules/operator/exchange-flatness";
import { env } from "../src/config/env";
import { operatorRoutes } from "../src/routes/operator.routes";
import { AppError } from "../src/utils/errors";

/**
 * Exchange flatness: the readiness answer a runtime transition depends on.
 *
 * Restarting an account's execution worker removes the thing that protects and
 * reconciles open exposure, so a transition has to prove the exchange holds
 * nothing first. These cases fix what that proof is allowed to say.
 *
 * Nothing here constructs a Binance client, opens a socket or touches a
 * database. The read surface is supplied directly, which is also the point:
 * three GETs is the entire capability this code is given.
 */

const AT = new Date("2026-09-28T10:00:00.000Z");
const STAMP = AT.toISOString();

const counts = (
  positions: PreShutdownCounts["nonZeroPositions"],
  orders: PreShutdownCounts["standardOpenOrders"],
  algo: PreShutdownCounts["openAlgoOrders"]
): PreShutdownCounts => ({
  nonZeroPositions: positions,
  standardOpenOrders: orders,
  openAlgoOrders: algo,
});

const FLAT = counts({ known: true, count: 0 }, { known: true, count: 0 }, { known: true, count: 0 });

const reading = (from: PreShutdownCounts, calls: string[]): PreShutdownReads => {
  const rows = (result: PreShutdownCounts["nonZeroPositions"], label: string) => async () => {
    calls.push(label);
    if (!result.known) throw new Error("the endpoint refused");
    // Deliberately RICH rows, carrying everything a real response would.
    return Array.from({ length: result.count }, (_, index) => ({
      symbol: "BTCUSDT",
      orderId: 918_273_645 + index,
      positionAmt: "0.017",
      entryPrice: "64123.50",
      clientOrderId: "teddy-canary-7f3a",
    }));
  };
  return {
    getPositionRisk: rows(from.nonZeroPositions, "positions") as PreShutdownReads["getPositionRisk"],
    getOpenOrders: rows(from.standardOpenOrders, "orders") as PreShutdownReads["getOpenOrders"],
    getOpenAlgoOrdersAccountWide: rows(
      from.openAlgoOrders,
      "algo"
    ) as PreShutdownReads["getOpenAlgoOrdersAccountWide"],
  };
};

const read = async (from: PreShutdownCounts, calls: string[] = []): Promise<ExchangeFlatnessDto> =>
  readExchangeFlatness({
    openReads: async () => ({ ok: true, reads: reading(from, calls) }),
    now: () => AT,
  });

describe("a flat account", () => {
  it("is flat only when all three are known and all three are zero", async () => {
    const result = await read(FLAT);

    expect(result.flat).toBe(true);
    expect(result.signedRequestWorks).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.nonZeroPositions).toEqual({ known: true, count: 0 });
    expect(result.standardOpenOrders).toEqual({ known: true, count: 0 });
    expect(result.openAlgoOrders).toEqual({ known: true, count: 0 });
    expect(result.generatedAt).toBe(STAMP);
  });

  it("asks all three account-wide, exactly once each", async () => {
    const calls: string[] = [];
    await read(FLAT, calls);
    expect(calls).toEqual(["positions", "orders", "algo"]);
  });
});

describe("an account that is NOT provably flat", () => {
  it("reports exposure as a category and a number, never a symbol", async () => {
    const result = await read(
      counts({ known: true, count: 2 }, { known: true, count: 0 }, { known: true, count: 1 })
    );

    expect(result.flat).toBe(false);
    expect(result.nonZeroPositions).toEqual({ known: true, count: 2 });
    expect(result.openAlgoOrders).toEqual({ known: true, count: 1 });
    expect(result.reasons).toEqual([
      "non-zero positions: 2 outstanding.",
      "open conditional (algo) orders: 1 outstanding.",
    ]);
  });

  it("an UNREADABLE count is null and blocking, never zero", async () => {
    const result = await read(
      counts({ known: true, count: 0 }, { known: false }, { known: true, count: 0 })
    );

    expect(result.standardOpenOrders).toEqual({ known: false, count: null });
    expect(result.flat).toBe(false);
    // A partially readable account is not a readable account.
    expect(result.signedRequestWorks).toBe(false);
    expect(result.reasons.join(" ")).toContain("could not be read");
    expect(result.reasons.join(" ")).toContain("not assumed to be zero");
  });

  it("all three unreadable is a complete, blocking answer rather than a throw", async () => {
    const result = await read(counts({ known: false }, { known: false }, { known: false }));

    expect(result.flat).toBe(false);
    expect(result.signedRequestWorks).toBe(false);
    expect(result.reasons).toHaveLength(3);
  });

  it("an account that could not be bound reports UNKNOWN, not flat", async () => {
    const result = await readExchangeFlatness({
      openReads: async () => ({ ok: false, reasonCode: "EXCHANGE_CREDENTIALS_MISSING" }),
      now: () => AT,
    });

    expect(result.flat).toBe(false);
    expect(result.signedRequestWorks).toBe(false);
    expect(result.nonZeroPositions).toEqual({ known: false, count: null });
    expect(result.reasons[0]).toContain("EXCHANGE_CREDENTIALS_MISSING");
  });
});

describe("what the answer is allowed to contain", () => {
  const FIELDS = [
    "flat",
    "generatedAt",
    "nonZeroPositions",
    "openAlgoOrders",
    "reasons",
    "signedRequestWorks",
    "standardOpenOrders",
  ];

  it("exactly these fields, and no others", async () => {
    const result = await read(
      counts({ known: true, count: 3 }, { known: false }, { known: true, count: 2 })
    );
    expect(Object.keys(result).sort()).toEqual(FIELDS);
    for (const key of ["nonZeroPositions", "standardOpenOrders", "openAlgoOrders"] as const) {
      expect(Object.keys(result[key]).sort()).toEqual(["count", "known"]);
    }
  });

  it("carries no symbol, order id, price, quantity or client id", async () => {
    // The scripted rows above are full of all five. None may survive counting.
    const serialized = JSON.stringify(
      await read(counts({ known: true, count: 4 }, { known: true, count: 4 }, { known: true, count: 4 }))
    );

    expect(serialized).not.toContain("BTCUSDT");
    expect(serialized).not.toContain("918273645");
    expect(serialized).not.toContain("0.017");
    expect(serialized).not.toContain("64123.50");
    expect(serialized).not.toContain("teddy-canary");
    expect(serialized).not.toMatch(/TOKEN|SECRET|APIKEY|API_KEY|PASSWORD|ACCOUNT_[AB]/i);
  });

  it("is a pure function of the counts and the clock", () => {
    const once = describeExchangeFlatness(FLAT, STAMP);
    const twice = describeExchangeFlatness(FLAT, STAMP);
    expect(once).toEqual(twice);
  });
});

describe("the read surface is the whole capability", () => {
  it("cannot reach a cancel, a close or a setup call", async () => {
    const forbidden: string[] = [];
    const trap = (name: string) => () => {
      forbidden.push(name);
      throw new Error("unreachable");
    };
    // A surface that ALSO offers mutations. The reader is handed it and still
    // touches only the three GETs, because those are the only names it knows.
    const surface = {
      ...reading(FLAT, []),
      cancelAllOpenOrders: trap("cancelAllOpenOrders"),
      closePosition: trap("closePosition"),
      setLeverage: trap("setLeverage"),
      placeOrder: trap("placeOrder"),
    } as PreShutdownReads;

    const result = await readExchangeFlatness({
      openReads: async () => ({ ok: true, reads: surface }),
      now: () => AT,
    });

    expect(result.flat).toBe(true);
    expect(forbidden).toEqual([]);
  });

  it("takes no symbol argument anywhere, so a flat verdict cannot be narrowed", async () => {
    const args: unknown[][] = [];
    const record =
      (result: PreShutdownCounts["nonZeroPositions"]) =>
      async (...received: unknown[]) => {
        args.push(received);
        return [] as unknown[];
      };
    await readExchangeFlatness({
      openReads: async () => ({
        ok: true,
        reads: {
          getPositionRisk: record({ known: true, count: 0 }),
          getOpenOrders: record({ known: true, count: 0 }),
          getOpenAlgoOrdersAccountWide: record({ known: true, count: 0 }),
        } as unknown as PreShutdownReads,
      }),
      now: () => AT,
    });

    expect(args).toHaveLength(3);
    for (const received of args) expect(received).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The HTTP boundary
// ---------------------------------------------------------------------------

describe("the exchange-flatness route", () => {
  const URL = "/api/operator/trading-control/exchange-flatness";
  const TOKEN = "phase11-flatness-token-0123456789abcdef";
  // The guard reads the PARSED env, which is fixed at import, so setting
  // `process.env` here would arrive too late to matter.
  const configured = env as { OPERATOR_API_TOKEN?: string };
  const ORIGINAL = configured.OPERATOR_API_TOKEN;

  let app: FastifyInstance;
  let reads = 0;

  beforeAll(async () => {
    configured.OPERATOR_API_TOKEN = TOKEN;
    app = Fastify();
    app.decorate("prisma", {} as PrismaClient);
    await app.register(operatorRoutes, {
      tradingControlFactory: () => ({
        readStatus: async () => ({}),
        readReadiness: async () => ({}),
        readExchangeFlatness: async () => {
          reads += 1;
          return describeExchangeFlatness(FLAT, STAMP);
        },
      }),
    });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        return reply.code(error.statusCode).send({ error: error.name, message: error.message });
      }
      return reply.code(500).send({ error: "Internal", message: "failed" });
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (ORIGINAL === undefined) delete configured.OPERATOR_API_TOKEN;
    else configured.OPERATOR_API_TOKEN = ORIGINAL;
  });

  it("refuses an unauthenticated caller BEFORE reading the exchange", async () => {
    const before = reads;
    const response = await app.inject({ method: "GET", url: URL });
    expect(response.statusCode).toBe(401);
    // An anonymous caller must not be able to make this server sign a request
    // against a real-money account.
    expect(reads).toBe(before);
  });

  it("serves the counts to an authenticated caller", async () => {
    const response = await app.inject({
      method: "GET",
      url: URL,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(describeExchangeFlatness(FLAT, STAMP));
  });

  it("is a GET only: it has no method that could mutate", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: URL,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(`${method}:${response.statusCode}`).toBe(`${method}:404`);
    }
  });

  it("takes no account parameter: a query string cannot redirect it", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${URL}?account=ACCOUNT_B&symbol=BTCUSDT`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    // Accepted and ignored. The account is whichever control plane was asked,
    // fixed by that process's own DOTENV_CONFIG_PATH.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(describeExchangeFlatness(FLAT, STAMP));
  });
});


describe("counts that crossed a process boundary", () => {
  // The launcher asks ONE account's control plane for these over loopback, so
  // they arrive as whatever JSON that process produced -- including a version
  // of it that predates a field.
  it("a complete body round-trips", () => {
    expect(
      countsFromWire({
        nonZeroPositions: { known: true, count: 0 },
        standardOpenOrders: { known: true, count: 3 },
        openAlgoOrders: { known: true, count: 0 },
      })
    ).toEqual({
      nonZeroPositions: { known: true, count: 0 },
      standardOpenOrders: { known: true, count: 3 },
      openAlgoOrders: { known: true, count: 0 },
    });
  });

  it.each([
    ["a null body", null],
    ["an empty body", {}],
    ["a body that is not an object at all", "flat"],
  ])("%s is three UNKNOWNs, never three zeroes", (_label, body) => {
    // Every field, not just the ones a caller happens to look at first.
    expect(countsFromWire(body as Parameters<typeof countsFromWire>[0])).toEqual({
      nonZeroPositions: { known: false },
      standardOpenOrders: { known: false },
      openAlgoOrders: { known: false },
    });
  });

  it("a body from before a field existed leaves THAT field unknown", () => {
    const counts = countsFromWire({ nonZeroPositions: { known: true, count: 0 } });
    expect(counts).toEqual({
      nonZeroPositions: { known: true, count: 0 },
      standardOpenOrders: { known: false },
      openAlgoOrders: { known: false },
    });
  });

  it.each([
    ["known false with a count", { known: false, count: 0 }],
    ["known true with a null count", { known: true, count: null }],
    ["known true with a string count", { known: true, count: "0" }],
    ["known true with no count", { known: true }],
    ["a truthy non-true known", { known: 1, count: 0 }],
    ["an infinite count", { known: true, count: Number.POSITIVE_INFINITY }],
    ["a NaN count", { known: true, count: Number.NaN }],
  ])("%s stays UNKNOWN rather than becoming zero", (_label, field) => {
    const counts = countsFromWire({ nonZeroPositions: field as never });
    expect(counts.nonZeroPositions).toEqual({ known: false });
  });

  it("an UNKNOWN from the wire still blocks the verdict", async () => {
    const counts = countsFromWire({
      nonZeroPositions: { known: true, count: 0 },
      standardOpenOrders: { known: false, count: null },
      openAlgoOrders: { known: true, count: 0 },
    });
    expect(describeExchangeFlatness(counts, STAMP).flat).toBe(false);
  });
});
