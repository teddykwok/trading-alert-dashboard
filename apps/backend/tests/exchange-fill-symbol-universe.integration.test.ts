import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * The authoritative execution-symbol universe, against a REAL Postgres.
 *
 * Every claim here is about which durable rows count and which are refused, so
 * none of it can be proven against a mock: the profile boundary, the absence of
 * a status or date filter, and the refusal of a symbol that was written without
 * going through the canonical path are all properties of stored data.
 */

const TAG = "symbol-universe";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { executionSymbolsForProfile, ExecutionSymbolLineageError } = await import(
  "../src/modules/execution/exchange-fill-symbol-universe"
);

const maybe = () => (available ? it : it.skip);
let sequence = 0;

async function profile(alias: string) {
  const row = await prisma!.executionProfile.create({
    data: {
      name: `${TAG} ${alias}`,
      accountIdentifier: `${TAG}-${alias}`,
      environment: "TESTNET",
      isEnabled: false,
    },
  });
  return row.id;
}

/**
 * One durable execution.
 *
 * `symbol` and `status` are written directly so a test can persist a value the
 * canonical write path would never produce -- which is the only way to prove
 * the validation refuses it.
 */
async function execution(
  executionProfileId: string,
  symbol: string,
  overrides: Record<string, unknown> = {}
) {
  sequence += 1;
  return prisma!.tradeExecution.create({
    data: {
      executionProfileId,
      symbol,
      direction: "LONG",
      positionSide: "LONG",
      selectedLookback: 200,
      plannedEntryPrice: "1.06",
      calculatedStopLoss: "1.01",
      executableStopLoss: "1.01",
      takeProfit: "1.09",
      riskBudgetUsd: "3",
      quantityRaw: "68.8",
      plannedQuantity: "68.8",
      quantityStepSize: "0.1",
      actualPlannedLoss: "3",
      unusedRiskBudget: "0",
      positionNotional: "72.9",
      targetIsolatedMargin: "7.3",
      maximumIsolatedMargin: "10",
      selectedLeverage: 10,
      estimatedInitialMargin: "7.3",
      liquidationBufferRatio: "0.5",
      decisionReasonCode: `${TAG}-${sequence}`,
      ...overrides,
    },
  });
}

beforeAll(async () => {
  if (!prisma || !available) return;
});

afterAll(async () => {
  if (!prisma) return;
  if (available) {
    const profiles = (
      await prisma.executionProfile.findMany({
        where: { accountIdentifier: { startsWith: TAG } },
        select: { id: true },
      })
    ).map((row) => row.id);
    const executions = (
      await prisma.tradeExecution.findMany({
        where: { executionProfileId: { in: profiles } },
        select: { id: true },
      })
    ).map((row) => row.id);
    await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: executions } } });
    await prisma.tradeExecution.deleteMany({ where: { id: { in: executions } } });
    await prisma.alert.deleteMany({ where: { indicatorName: { startsWith: TAG } } });
    await prisma.executionProfile.deleteMany({ where: { id: { in: profiles } } });
  }
  await prisma.$disconnect();
});

describe("the execution-symbol universe", () => {
  maybe()("a profile that has traded nothing is an empty universe, not an error", async () => {
    // Legitimately empty, and exactly why a malformed symbol must throw rather
    // than return a short list: the two answers must never look the same.
    const id = await profile("empty");

    await expect(executionSymbolsForProfile(prisma!, id)).resolves.toEqual([]);
  });

  maybe()("one execution yields one symbol", async () => {
    const id = await profile("single");
    await execution(id, "BTCUSDT");

    await expect(executionSymbolsForProfile(prisma!, id)).resolves.toEqual(["BTCUSDT"]);
  });

  maybe()("many executions of the same symbol collapse to one entry", async () => {
    const id = await profile("duplicates");
    for (let index = 0; index < 5; index += 1) await execution(id, "BTCUSDT");

    await expect(executionSymbolsForProfile(prisma!, id)).resolves.toEqual(["BTCUSDT"]);
  });

  maybe()("symbols come back in deterministic ascending order", async () => {
    // Not the database's row order. Bootstrap reports, tests and operator
    // evidence must not differ between runs for no reason.
    const id = await profile("ordering");
    for (const symbol of ["ETHUSDT", "ADAUSDT", "BTCUSDT", "1000PEPEUSDT", "SOLUSDT"]) {
      await execution(id, symbol);
    }

    const symbols = await executionSymbolsForProfile(prisma!, id);

    expect(symbols).toEqual(["1000PEPEUSDT", "ADAUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    expect(symbols).toEqual([...symbols].sort());
  });
});

describe("the universe is bounded by the profile and nothing else", () => {
  maybe()("another profile's executions are excluded", async () => {
    // Profile isolation is load-bearing: TESTNET and MAINNET are separate
    // profiles, and one account's history must never seed another's coverage.
    const mine = await profile("scope-mine");
    const theirs = await profile("scope-theirs");
    await execution(mine, "BTCUSDT");
    await execution(theirs, "ETHUSDT");

    await expect(executionSymbolsForProfile(prisma!, mine)).resolves.toEqual(["BTCUSDT"]);
    await expect(executionSymbolsForProfile(prisma!, theirs)).resolves.toEqual(["ETHUSDT"]);
  });

  maybe()("no status filter: every execution state contributes its symbol", async () => {
    // An execution whose LOCAL state says FAILED or SKIPPED after an ambiguous
    // submission is exactly the case a historical sweep must stay able to
    // check. Filtering these away would blind it to what it exists for.
    const id = await profile("statuses");
    const byStatus: Array<[string, string]> = [
      ["PLAN_READY", "AAAUSDT"],
      ["ENTRY_SUBMITTING", "BBBUSDT"],
      ["PARTIALLY_FILLED", "CCCUSDT"],
      ["PROTECTED", "DDDUSDT"],
      ["ENTRY_EXPIRED", "EEEUSDT"],
      ["CANCELED", "FFFUSDT"],
      ["SKIPPED", "GGGUSDT"],
      ["FAILED", "HHHUSDT"],
      ["MANUAL_INTERVENTION", "IIIUSDT"],
      ["CLOSED_TP", "JJJUSDT"],
      ["CLOSED_SL", "KKKUSDT"],
      ["CLOSED_EXTERNAL", "LLLUSDT"],
    ];
    for (const [status, symbol] of byStatus) {
      await execution(id, symbol, { status });
    }

    const symbols = await executionSymbolsForProfile(prisma!, id);

    expect(symbols).toHaveLength(byStatus.length);
    expect(symbols).toEqual(byStatus.map(([, symbol]) => symbol).sort());
  });

  maybe()("no date filter: an ancient execution still contributes its symbol", async () => {
    // The recovery horizon bounds which DAYS are swept, not which symbols are
    // relevant -- and an old execution can hold a position whose fills land
    // inside the horizon.
    const id = await profile("dates");
    const twoYearsAgo = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);
    await execution(id, "OLDUSDT", { createdAt: twoYearsAgo, updatedAt: twoYearsAgo });
    await execution(id, "NEWUSDT");

    await expect(executionSymbolsForProfile(prisma!, id)).resolves.toEqual(["NEWUSDT", "OLDUSDT"]);
  });

  maybe()("a symbol Teddy only ever received an ALERT for never appears", async () => {
    // The anti-goal. The watchlist is hundreds of symbols; the universe must be
    // execution lineage, not alert noise.
    const id = await profile("alerts-only");
    await prisma!.alert.create({
      data: {
        symbol: "ALERTONLYUSDT",
        assetType: "CRYPTO",
        exchange: "BINANCE",
        timeframe: "15m",
        price: 1,
        signal: "LONG",
        indicatorName: `${TAG}-alert-only`,
        rawPayload: {},
        triggeredAt: new Date(),
      },
    });
    await execution(id, "BTCUSDT");

    const symbols = await executionSymbolsForProfile(prisma!, id);

    expect(symbols).toEqual(["BTCUSDT"]);
    expect(symbols).not.toContain("ALERTONLYUSDT");
  });
});

describe("a non-canonical persisted symbol is refused, never repaired", () => {
  const NON_CANONICAL: Array<[string, string]> = [
    ["lowercase", "btcusdt"],
    ["mixed case", "BtcUsdt"],
    ["leading whitespace", " BTCUSDT"],
    ["trailing whitespace", "BTCUSDT "],
    ["surrounded by whitespace", " BTCUSDT "],
    ["exchange prefix", "BINANCE:BTCUSDT"],
    ["lowercase exchange prefix", "binance:btcusdt"],
    ["perpetual suffix", "BTCUSDT.P"],
    ["prefix and suffix", "BINANCE:BTCUSDT.P"],
    ["internal whitespace", "BTC USDT"],
    ["a pasted list", "BTCUSDT,ETHUSDT"],
    ["empty", ""],
    ["whitespace only", "   "],
  ];

  maybe().each(NON_CANONICAL)("%s is refused", async (_label, stored) => {
    const id = await profile(`invalid-${(sequence += 1)}`);
    await execution(id, stored);

    const thrown = await executionSymbolsForProfile(prisma!, id)
      .then(() => null)
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(ExecutionSymbolLineageError);
    expect(thrown.reasonCode).toBe("EXECUTION_SYMBOL_LINEAGE_INVALID");
    expect(thrown.invalidSymbols).toEqual([stored]);
    expect(thrown.executionProfileId).toBe(id);
  });

  maybe()("the canonical form is used only to compare, never to answer", async () => {
    // The stored value is what the error reports. Returning "BTCUSDT" for a row
    // that says "btcusdt" would invent an identity the writer never stored.
    const id = await profile("never-repaired");
    await execution(id, "btcusdt");

    const thrown = await executionSymbolsForProfile(prisma!, id)
      .then(() => null)
      .catch((error) => error);

    expect(thrown.invalidSymbols).toEqual(["btcusdt"]);
    expect(thrown.invalidSymbols).not.toContain("BTCUSDT");
    // And the durable row is untouched.
    const rows = await prisma!.tradeExecution.findMany({
      where: { executionProfileId: id },
      select: { symbol: true },
    });
    expect(rows.map((row) => row.symbol)).toEqual(["btcusdt"]);
  });

  maybe()("one bad row refuses the WHOLE call: no partial symbol array", async () => {
    // Seeding the good symbols while quietly omitting the bad one would leave a
    // hole indistinguishable from a symbol nobody ever traded.
    const id = await profile("mixed-valid-invalid");
    await execution(id, "BTCUSDT");
    await execution(id, "ETHUSDT");
    await execution(id, "solusdt");

    const thrown = await executionSymbolsForProfile(prisma!, id)
      .then((symbols) => symbols)
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(ExecutionSymbolLineageError);
    expect(Array.isArray(thrown)).toBe(false);
    expect(thrown.invalidSymbols).toEqual(["solusdt"]);
  });

  maybe()("every offending value is named, not just the first", async () => {
    const id = await profile("many-invalid");
    for (const stored of ["btcusdt", "ETHUSDT.P", "BINANCE:SOLUSDT", "ADAUSDT"]) {
      await execution(id, stored);
    }

    const thrown = await executionSymbolsForProfile(prisma!, id)
      .then(() => null)
      .catch((error) => error);

    expect(thrown.invalidSymbols).toEqual(["BINANCE:SOLUSDT", "ETHUSDT.P", "btcusdt"]);
    expect(thrown.message).toContain("3 non-canonical");
  });

  maybe()("BINANCE: and .P with no ticker are refused as structural data, not as raw throws", () => {
    // These two are why the catch narrows on the thrown TYPE rather than
    // pre-screening with getSymbolInputError: that predicate returns null for
    // both, yet normalizeTradingSymbol still rejects them. A pre-screen would
    // let a genuinely malformed persisted symbol escape as an unhandled
    // ValidationError instead of the structural-data error the caller expects.
    return (async () => {
      for (const stored of ["BINANCE:", ".P", "BINANCE:.P"]) {
        const id = await profile(`prefix-only-${(sequence += 1)}`);
        await execution(id, stored);

        const thrown = await executionSymbolsForProfile(prisma!, id)
          .then(() => null)
          .catch((error) => error);

        expect(thrown).toBeInstanceOf(ExecutionSymbolLineageError);
        expect(thrown.reasonCode).toBe("EXECUTION_SYMBOL_LINEAGE_INVALID");
        expect(thrown.invalidSymbols).toEqual([stored]);
      }
    })();
  });

  maybe()("an UNEXPECTED failure inside canonicalization propagates unchanged", () => {
    // The taxonomy boundary. `normalizeTradingSymbol` refuses malformed input
    // with ValidationError; anything else out of it is a bug or an
    // infrastructure fault, and calling that a verdict about durable data would
    // blame the account's history for a fault in the code reading it.
    //
    // Driven by handing the function a row whose `symbol` is not a string --
    // reached through the same client Proxy this file already uses for the
    // database-failure case, so no module is mocked and the production call
    // path is unchanged.
    return (async () => {
      const id = await profile("unexpected-canonicalizer-failure");

      const rowShapeAnomaly = new Proxy(prisma as object, {
        get(target, property, receiver) {
          if (property !== "tradeExecution") return Reflect.get(target, property, receiver);
          return {
            // `42..trim` is not a function, so canonicalization raises a
            // TypeError rather than a ValidationError.
            findMany: async () => [{ symbol: 42 as unknown as string }],
          };
        },
      }) as PrismaClient;

      const thrown = await executionSymbolsForProfile(rowShapeAnomaly, id)
        .then((symbols) => symbols)
        .catch((error) => error);

      expect(thrown).toBeInstanceOf(TypeError);
      expect(thrown).not.toBeInstanceOf(ExecutionSymbolLineageError);
      // Not silently absorbed into a successful, shorter universe either.
      expect(Array.isArray(thrown)).toBe(false);
    })();
  });

  maybe()("a ValidationError is the ONLY thing treated as non-canonical", () => {
    // Both halves in one place: the expected refusal becomes the domain error,
    // and a foreign exception from the same call site does not.
    return (async () => {
      const valid = await profile("taxonomy-valid");
      await execution(valid, "btcusdt");
      await expect(executionSymbolsForProfile(prisma!, valid)).rejects.toBeInstanceOf(
        ExecutionSymbolLineageError
      );

      const foreign = new Proxy(prisma as object, {
        get(target, property, receiver) {
          if (property !== "tradeExecution") return Reflect.get(target, property, receiver);
          return { findMany: async () => [{ symbol: null as unknown as string }] };
        },
      }) as PrismaClient;

      const thrown = await executionSymbolsForProfile(foreign, valid)
        .then(() => null)
        .catch((error) => error);

      expect(thrown).toBeInstanceOf(TypeError);
      expect(thrown).not.toBeInstanceOf(ExecutionSymbolLineageError);
    })();
  });

  maybe()("a canonical symbol with digits is accepted", async () => {
    const id = await profile("digits");
    await execution(id, "1000PEPEUSDT");

    await expect(executionSymbolsForProfile(prisma!, id)).resolves.toEqual(["1000PEPEUSDT"]);
  });
});

describe("infrastructure failure stays distinguishable from a data conclusion", () => {
  maybe()("a query failure propagates rather than becoming an empty universe", async () => {
    // Converting an outage into [] would report "nothing to seed" for an
    // account that has traded for months.
    const id = await profile("db-failure");
    await execution(id, "BTCUSDT");

    const failing = new Proxy(prisma as object, {
      get(target, property, receiver) {
        if (property !== "tradeExecution") return Reflect.get(target, property, receiver);
        return {
          findMany: async () => {
            throw new Error("connection terminated unexpectedly");
          },
        };
      },
    }) as PrismaClient;

    const thrown = await executionSymbolsForProfile(failing, id)
      .then((symbols) => symbols)
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ExecutionSymbolLineageError);
    expect(Array.isArray(thrown)).toBe(false);
    expect(String(thrown.message)).toContain("connection terminated");
  });
});
