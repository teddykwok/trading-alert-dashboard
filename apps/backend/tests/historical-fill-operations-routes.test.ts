import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * The authenticated read-only historical-fill operations endpoint.
 *
 * Only the operator routes are registered on a bare Fastify instance, so these
 * exercise the real HTTP boundary -- the real guard, the real error handler,
 * the real serializer -- without Redis, sockets or static files.
 *
 * The snapshot reader is supplied through the route module's OWN factory
 * option, the same seam `tradingControlFactory` already uses. That keeps the
 * production dependency structure untouched while letting a test count exactly
 * how many times the reader was asked anything.
 *
 * Nothing here contacts Binance or writes a row.
 */

const URL = "/api/operator/historical-fills/operations";
const TOKEN = "phase8-operations-token-0123456789abcdef";

const ORIGINAL_TOKEN = process.env.OPERATOR_API_TOKEN;

/**
 * Connected at module load, deliberately.
 *
 * `tests/setup.ts` repoints `DATABASE_URL` at the test database, so a helper
 * re-imported after `vi.resetModules()` would compare the test URL against
 * itself and refuse. Resolving once, here, keeps the guard meaningful.
 */
const { prisma: testDatabase, available } = await connectTestDatabase();

const CAPTURED_AT = new Date("2026-08-12T09:15:00.000Z");

const READY_SNAPSHOT = {
  outcome: "READY" as const,
  capturedAt: CAPTURED_AT,
  executionProfileId: "profile-123",
  windows: {
    total: 9,
    roots: 7,
    children: 2,
    distinctSymbolCount: 3,
    byStatus: {
      PENDING: 3,
      COMPLETE: 2,
      SPLIT: 2,
      INCOMPLETE_SKIPPED_ROWS: 1,
      SATURATED_SINGLE_MILLISECOND: 0,
      ABANDONED: 1,
    },
  },
  pending: {
    total: 3,
    claimableNow: 1,
    activeLease: 1,
    staleLease: 0,
    inBackoff: 1,
    attemptExhausted: 0,
    oldestPendingCreatedAt: new Date("2026-08-11T00:00:00.000Z"),
    oldestClaimableCreatedAt: new Date("2026-08-11T06:30:00.000Z"),
    nextBackoffEligibleAt: null,
  },
  ledger: { totalFills: 12, unattributedFills: 4 },
};

const UNAVAILABLE_SNAPSHOT = {
  outcome: "PROFILE_UNAVAILABLE" as const,
  capturedAt: CAPTURED_AT,
  reasonCode: "PROFILE_POLICY_MISSING" as const,
};

/**
 * Builds the app with a scripted reader, counting every call and every
 * argument it was handed.
 */
async function buildAppWith(answer: () => unknown) {
  process.env.OPERATOR_API_TOKEN = TOKEN;
  vi.resetModules();
  const { operatorRoutes } = await import("../src/routes/operator.routes");
  const { AppError } = await import("../src/utils/errors");

  const calls: Array<unknown[]> = [];
  const app = Fastify();
  app.decorate("prisma", {} as PrismaClient);
  await app.register(operatorRoutes, {
    historicalFillSnapshotFactory: () => ({
      capture: async (...args: unknown[]) => {
        calls.push(args);
        const result = answer();
        if (result instanceof Error) throw result;
        return result as never;
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
  return { app, calls };
}

const get = (app: FastifyInstance, authorization?: string, url: string = URL) =>
  app.inject({
    method: "GET",
    url,
    headers: authorization === undefined ? {} : { authorization },
  });

const authorized = (app: FastifyInstance, url?: string) => get(app, `Bearer ${TOKEN}`, url);

afterEach(() => {
  vi.resetModules();
});

afterAll(async () => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.OPERATOR_API_TOKEN;
  else process.env.OPERATOR_API_TOKEN = ORIGINAL_TOKEN;
  vi.resetModules();
  await testDatabase.$disconnect();
});

describe("the guard runs before anything is read", () => {
  it("A+C. rejects an unauthenticated request without asking the reader", async () => {
    const { app, calls } = await buildAppWith(() => READY_SNAPSHOT);

    const response = await get(app);

    // Status only, matching this project's own auth suite: the refusal body is
    // deliberately uniform so a caller cannot tell one failure mode from
    // another, and pinning its wording here would invite that to change.
    expect(response.statusCode).toBe(401);
    // The whole point: no historical-fill state was read for a caller who
    // never proved they may see it.
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("B. answers every refusal shape identically", async () => {
    const { app, calls } = await buildAppWith(() => READY_SNAPSHOT);

    const refusals = await Promise.all([
      get(app),
      get(app, "Bearer wrong-token-0123456789abcdefghijklmn"),
      get(app, `Basic ${TOKEN}`),
      get(app, TOKEN),
    ]);

    // One answer, four causes. Any difference between them is reconnaissance
    // against the one credential that can reach operator state.
    const distinct = new Set(refusals.map((r) => `${r.statusCode}:${r.body}`));
    expect(distinct.size).toBe(1);
    expect(calls).toHaveLength(0);
    await app.close();
  });

  for (const [label, header] of [
    ["a wrong token", "Bearer wrong-token-0123456789abcdefghijklmn"],
    ["the wrong scheme", `Basic ${TOKEN}`],
    ["a bare token with no scheme", TOKEN],
    ["an empty bearer", "Bearer "],
  ] as const) {
    it(`B+C. rejects ${label} without asking the reader`, async () => {
      const { app, calls } = await buildAppWith(() => READY_SNAPSHOT);

      const response = await get(app, header);

      expect(response.statusCode).toBe(401);
      expect(calls).toHaveLength(0);
      await app.close();
    });
  }

  it("F. asks the reader exactly once for an authorized request", async () => {
    const { app, calls } = await buildAppWith(() => READY_SNAPSHOT);

    const response = await authorized(app);

    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    await app.close();
  });
});

describe("the caller controls nothing", () => {
  it("G+H. never passes a profile or a clock to the reader", async () => {
    const { app, calls } = await buildAppWith(() => READY_SNAPSHOT);

    // Every shape a caller might try to smuggle in.
    const response = await authorized(
      app,
      `${URL}?executionProfileId=someone-else&now=1999-01-01T00:00:00.000Z&capturedAt=x&timestamp=1`
    );

    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    // `capture()` was invoked with NO arguments at all, so there is nothing for
    // a query parameter to have influenced.
    expect(calls[0]).toEqual([]);
    // The answer is the server's own profile, not the one asked for.
    expect(response.json().executionProfileId).toBe("profile-123");
    await app.close();
  });

  it("G+H. a request with those parameters is byte-identical to one without", async () => {
    const { app } = await buildAppWith(() => READY_SNAPSHOT);

    const plain = await authorized(app);
    const doctored = await authorized(app, `${URL}?executionProfileId=other&now=2000-01-01`);

    expect(doctored.statusCode).toBe(plain.statusCode);
    expect(doctored.body).toBe(plain.body);
    await app.close();
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    it(`exposes no ${method} on the operations path`, async () => {
      const { app, calls } = await buildAppWith(() => READY_SNAPSHOT);

      const response = await app.inject({
        method,
        url: URL,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(404);
      expect(calls).toHaveLength(0);
      await app.close();
    });
  }
});

describe("the wire contract", () => {
  it("D+I+J+K+L. serializes READY exactly, dates as ISO and counts as numbers", async () => {
    const { app } = await buildAppWith(() => READY_SNAPSHOT);

    const response = await authorized(app);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      outcome: "READY",
      capturedAt: "2026-08-12T09:15:00.000Z",
      executionProfileId: "profile-123",
      windows: {
        total: 9,
        roots: 7,
        children: 2,
        distinctSymbolCount: 3,
        byStatus: {
          PENDING: 3,
          COMPLETE: 2,
          SPLIT: 2,
          INCOMPLETE_SKIPPED_ROWS: 1,
          SATURATED_SINGLE_MILLISECOND: 0,
          ABANDONED: 1,
        },
      },
      pending: {
        total: 3,
        claimableNow: 1,
        activeLease: 1,
        staleLease: 0,
        inBackoff: 1,
        attemptExhausted: 0,
        oldestPendingCreatedAt: "2026-08-11T00:00:00.000Z",
        oldestClaimableCreatedAt: "2026-08-11T06:30:00.000Z",
        nextBackoffEligibleAt: null, // J. a null instant stays null
      },
      ledger: { totalFills: 12, unattributedFills: 4 },
      // Additive only: every factual field above is untouched. This
      // long-standing fixture carries ABANDONED 1 and INCOMPLETE_SKIPPED_ROWS
      // 1, so the honest answer for it is NEEDS_ATTENTION.
      interpretation: {
        state: "NEEDS_ATTENTION",
        issues: [
          { code: "ABANDONED_WINDOWS_PRESENT", count: 1 },
          { code: "INCOMPLETE_SKIPPED_ROWS_PRESENT", count: 1 },
        ],
      },
    });

    // K. Counts are numbers on the wire, never stringified.
    const body = response.json();
    for (const value of Object.values(body.windows.byStatus)) expect(typeof value).toBe("number");
    expect(typeof body.windows.total).toBe("number");
    expect(typeof body.ledger.totalFills).toBe("number");
    // I. Dates are ISO-8601 strings, not Date implementation details.
    expect(typeof body.capturedAt).toBe("string");
    expect(new Date(body.capturedAt).toISOString()).toBe(body.capturedAt);
    await app.close();
  });

  it("E+M. serializes PROFILE_UNAVAILABLE as 200 and leaks no READY field", async () => {
    const { app } = await buildAppWith(() => UNAVAILABLE_SNAPSHOT);

    const response = await authorized(app);

    // 200, not 401 or 503: authentication succeeded and the server is working.
    // "no profile is configured" is a true operational fact the panel renders.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      outcome: "PROFILE_UNAVAILABLE",
      capturedAt: "2026-08-12T09:15:00.000Z",
      reasonCode: "PROFILE_POLICY_MISSING",
      // C. A workset that could not be evaluated is UNAVAILABLE, never a
      // condition -- and the binder's reason is still carried beside it.
      interpretation: { state: "UNAVAILABLE", issues: [] },
    });
    expect(Object.keys(response.json()).sort()).toEqual([
      "capturedAt",
      "interpretation",
      "outcome",
      "reasonCode",
    ]);
    await app.close();
  });

  for (const reasonCode of [
    "PROFILE_NOT_CONFIGURED",
    "PROFILE_NOT_FOUND",
    "PROFILE_AMBIGUOUS",
    "PROFILE_POLICY_MISSING",
    "PROFILE_ENVIRONMENT_MISMATCH",
  ] as const) {
    it(`E. carries ${reasonCode} through unflattened`, async () => {
      const { app } = await buildAppWith(() => ({ ...UNAVAILABLE_SNAPSHOT, reasonCode }));

      const response = await authorized(app);

      expect(response.statusCode).toBe(200);
      expect(response.json().reasonCode).toBe(reasonCode);
      await app.close();
    });
  }

  it("L. drops anything the snapshot grows that the contract does not name", async () => {
    // The body is CONSTRUCTED, not forwarded, so a future property -- or a
    // careless one -- cannot reach an operator's browser by accident.
    const { app } = await buildAppWith(() => ({
      ...READY_SNAPSHOT,
      apiKey: "BINANCE-KEY",
      secret: "super-secret",
      debugInternal: { connectionString: "postgres://user:pw@host/db" },
      windows: { ...READY_SNAPSHOT.windows, internalNote: "leak" },
      pending: { ...READY_SNAPSHOT.pending, claimOwners: ["worker-a"] },
      ledger: { ...READY_SNAPSHOT.ledger, realizedPnl: "123.45", quantity: "68.8" },
    }));

    const response = await authorized(app);
    const raw = response.body;

    expect(response.statusCode).toBe(200);
    for (const forbidden of [
      "apiKey",
      "BINANCE-KEY",
      "secret",
      "debugInternal",
      "connectionString",
      "internalNote",
      "claimOwners",
      "realizedPnl",
      "quantity",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    expect(Object.keys(response.json()).sort()).toEqual([
      "capturedAt",
      "executionProfileId",
      "interpretation",
      "ledger",
      "outcome",
      "pending",
      "windows",
    ]);
    expect(Object.keys(response.json().ledger).sort()).toEqual([
      "totalFills",
      "unattributedFills",
    ]);
    await app.close();
  });

  it("T. marks the response no-store", async () => {
    const { app } = await buildAppWith(() => READY_SNAPSHOT);

    const response = await authorized(app);

    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("N. lets an unexpected reader failure reach the error handler", async () => {
    const { app } = await buildAppWith(() => new Error("connection terminated unexpectedly"));

    const response = await authorized(app);

    // Never dressed up as READY-with-zeros or PROFILE_UNAVAILABLE.
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("READY");
    expect(response.body).not.toContain("PROFILE_UNAVAILABLE");
    await app.close();
  });

  it("R. registers the path exactly once, and neighbours stay 404", async () => {
    const { app } = await buildAppWith(() => READY_SNAPSHOT);

    const routes = app.printRoutes({ commonPrefix: false });
    const occurrences = routes.split("\n").filter((line) => line.includes("operations")).length;
    expect(occurrences).toBe(1);

    const neighbour = await authorized(app, "/api/operator/historical-fills/nonexistent");
    expect(neighbour.statusCode).toBe(404);
    await app.close();
  });
});

/**
 * O+P+Q+S. The real route, the real service, a real Postgres.
 *
 * The scripted tests above prove the HTTP boundary; this one proves the wiring
 * actually reaches the read model and answers about durable rows. Only the
 * profile binding is injected -- the configured binder reads process
 * configuration, and pointing it at a test-owned profile is the same seam the
 * bootstrap and executor suites use.
 */
describe("the route reaches the real read model", () => {
  const TAG = "fill-ops-api";
  const SYMBOL = "OPSAPIUSDT";
  const DAY_MS = 86_400_000;

  it("serves durable state for the configured profile only, writing nothing", async () => {
    const prisma = testDatabase;
    if (!available) throw new Error("the test database must be reachable for this proof");

    const { operatorRoutes } = await import("../src/routes/operator.routes");
    const { HistoricalFillOperationalSnapshotService } = await import(
      "../src/modules/execution/historical-fill-operational-snapshot.service"
    );

    const mine = await prisma.executionProfile.create({
      data: {
        name: `${TAG} mine`, accountIdentifier: `${TAG}-mine`,
        environment: "TESTNET", isEnabled: false, safetyPolicy: { create: {} },
      },
    });
    const theirs = await prisma.executionProfile.create({
      data: {
        name: `${TAG} theirs`, accountIdentifier: `${TAG}-theirs`,
        environment: "TESTNET", isEnabled: false, safetyPolicy: { create: {} },
      },
    });
    const base = 70_000 * DAY_MS;
    await prisma.exchangeFillIngestWindow.createMany({
      data: [
        { executionProfileId: mine.id, symbol: SYMBOL, startTimeMs: BigInt(base), endTimeMs: BigInt(base + DAY_MS - 1) },
        { executionProfileId: mine.id, symbol: SYMBOL, startTimeMs: BigInt(base + DAY_MS), endTimeMs: BigInt(base + 2 * DAY_MS - 1), status: "COMPLETE" },
        // Another account's row must never appear in this answer.
        { executionProfileId: theirs.id, symbol: SYMBOL, startTimeMs: BigInt(base), endTimeMs: BigInt(base + DAY_MS - 1) },
      ],
    });

    process.env.OPERATOR_API_TOKEN = TOKEN;
    const app = Fastify();
    app.decorate("prisma", prisma);
    await app.register(operatorRoutes, {
      historicalFillSnapshotFactory: (client) =>
        new HistoricalFillOperationalSnapshotService({
          prisma: client,
          bindProfile: async () => ({
            ok: true as const,
            context: { executionProfileId: mine.id, environment: "TESTNET" } as never,
          }),
        }),
    });
    await app.ready();

    const before = await prisma.exchangeFillIngestWindow.findMany({
      where: { executionProfileId: { in: [mine.id, theirs.id] } },
      orderBy: [{ executionProfileId: "asc" }, { startTimeMs: "asc" }],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const response = await authorized(app);

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // P. The configured profile, and only its rows.
      expect(body.outcome).toBe("READY");
      expect(body.executionProfileId).toBe(mine.id);
      expect(body.windows.total).toBe(2);
      expect(body.windows.byStatus.PENDING).toBe(1);
      expect(body.windows.byStatus.COMPLETE).toBe(1);
      expect(body.windows.roots).toBe(2);
      expect(body.windows.children).toBe(0);
      expect(body.windows.distinctSymbolCount).toBe(1);
      expect(body.pending.total).toBe(1);
      expect(body.pending.claimableNow).toBe(1);
      expect(body.ledger).toEqual({ totalFills: 0, unattributedFills: 0 });
      // The server's own clock, not a caller's.
      expect(typeof body.capturedAt).toBe("string");
      // Q. No exchange was contacted.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }

    // S. Serving the snapshot changed nothing.
    expect(
      await prisma.exchangeFillIngestWindow.findMany({
        where: { executionProfileId: { in: [mine.id, theirs.id] } },
        orderBy: [{ executionProfileId: "asc" }, { startTimeMs: "asc" }],
      })
    ).toEqual(before);

    await app.close();
    await prisma.exchangeFillIngestWindow.deleteMany({
      where: { executionProfileId: { in: [mine.id, theirs.id] } },
    });
    await prisma.executionSafetyPolicy.deleteMany({
      where: { executionProfileId: { in: [mine.id, theirs.id] } },
    });
    await prisma.executionProfile.deleteMany({ where: { id: { in: [mine.id, theirs.id] } } });
  });
});

/**
 * The operational interpretation, on the wire.
 *
 * The classifier itself is proven exhaustively in its own pure suite; these
 * assert the ROUTE carries its answer faithfully and adds nothing else.
 */
describe("the interpretation field", () => {
  /** The fixture with every trigger cleared, for the untroubled cases. */
  const UNTROUBLED = {
    ...READY_SNAPSHOT,
    windows: {
      ...READY_SNAPSHOT.windows,
      byStatus: { ...READY_SNAPSHOT.windows.byStatus, ABANDONED: 0, INCOMPLETE_SKIPPED_ROWS: 0 },
    },
  };

  const withCounts = (overrides: {
    pending?: Record<string, number>;
    windows?: Record<string, number>;
    ledger?: Record<string, number>;
  }) => ({
    ...UNTROUBLED,
    windows: {
      ...UNTROUBLED.windows,
      byStatus: { ...UNTROUBLED.windows.byStatus, ...overrides.windows },
    },
    pending: { ...UNTROUBLED.pending, ...overrides.pending },
    ledger: { ...UNTROUBLED.ledger, ...overrides.ledger },
  });

  it("A. serializes NORMAL when nothing needs a human", async () => {
    const { app } = await buildAppWith(() => UNTROUBLED);

    const response = await authorized(app);

    expect(response.json().interpretation).toEqual({ state: "NORMAL", issues: [] });
    await app.close();
  });

  it("B+D. serializes NEEDS_ATTENTION with every condition, in order", async () => {
    const { app } = await buildAppWith(() =>
      withCounts({
        pending: { staleLease: 2, attemptExhausted: 1 },
        windows: { ABANDONED: 3, INCOMPLETE_SKIPPED_ROWS: 4, SATURATED_SINGLE_MILLISECOND: 5 },
      })
    );

    const response = await authorized(app);

    expect(response.json().interpretation).toEqual({
      state: "NEEDS_ATTENTION",
      issues: [
        { code: "STALE_LEASES_PRESENT", count: 2 },
        { code: "ATTEMPT_EXHAUSTED_PRESENT", count: 1 },
        { code: "ABANDONED_WINDOWS_PRESENT", count: 3 },
        { code: "INCOMPLETE_SKIPPED_ROWS_PRESENT", count: 4 },
        { code: "SATURATED_SINGLE_MILLISECOND_PRESENT", count: 5 },
      ],
    });
    await app.close();
  });

  it("an unattributed fill alone is not a condition on the wire either", async () => {
    const { app } = await buildAppWith(() => ({
      ...UNTROUBLED,
      ledger: { totalFills: 40, unattributedFills: 40 },
    }));

    const response = await authorized(app);

    expect(response.json().interpretation).toEqual({ state: "NORMAL", issues: [] });
    // ...and the fact itself is still reported.
    expect(response.json().ledger.unattributedFills).toBe(40);
    await app.close();
  });

  it("E+F. allowlists the interpretation, dropping anything else on it", async () => {
    const { app } = await buildAppWith(() => ({
      ...withCounts({ pending: { staleLease: 1 } }),
      interpretation: { state: "CRITICAL", debugRule: "leak", issues: [{ code: "X", secret: "s" }] },
    }));

    const response = await authorized(app);
    const raw = response.body;

    // The route recomputes from the snapshot rather than forwarding whatever
    // arrived, so a foreign interpretation cannot ride through.
    expect(response.json().interpretation).toEqual({
      state: "NEEDS_ATTENTION",
      issues: [{ code: "STALE_LEASES_PRESENT", count: 1 }],
    });
    for (const forbidden of ["CRITICAL", "debugRule", "leak", "secret"]) {
      expect(raw).not.toContain(forbidden);
    }
    // Each issue carries exactly a code and a count.
    for (const issue of response.json().interpretation.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "count"]);
    }
    await app.close();
  });

  it("G+H+I. adds no read, no caller control and no weakening of the guard", async () => {
    const { app, calls } = await buildAppWith(() => withCounts({ pending: { staleLease: 1 } }));

    // Unauthenticated still reads nothing at all.
    expect((await get(app)).statusCode).toBe(401);
    expect(calls).toHaveLength(0);

    // Authorized: still exactly ONE capture, still with no arguments, even
    // though an interpretation is now produced.
    const response = await authorized(
      app,
      `${URL}?executionProfileId=other&now=1999-01-01T00:00:00.000Z`
    );
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([]);
    expect(response.json().interpretation.state).toBe("NEEDS_ATTENTION");
    await app.close();
  });
});
