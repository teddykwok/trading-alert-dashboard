import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { connectTestDatabase } from "./helpers/test-database";

/**
 * The exchange fill ledger, against a REAL Postgres.
 *
 * Every claim here is about what the DATABASE guarantees — uniqueness, replay
 * safety, exact decimal storage — so none of it can be proven against a mock.
 * Nothing imports a Binance client or a mutation client; no exchange request is
 * made anywhere in this file or in the code under test.
 */

const TAG = "fill-ledger-synthetic";
const SYMBOL = "LEDGERUSDT";

const { prisma: testDatabase, available } = await connectTestDatabase();
const prisma: PrismaClient | null = testDatabase;

const { normalizeUserTrades } = await import("../src/modules/binance/binance.normalize");

const {
  ExchangeFillLedgerService,
  FillLedgerConflictError,
  FillLedgerAttributionConflictError,
  FillLedgerRaceUnresolvedError,
} = await import(
  "../src/modules/execution/exchange-fill-ledger.service"
);

const maybe = () => (available ? it : it.skip);

type LedgerService = InstanceType<typeof ExchangeFillLedgerService>;
let ledger: LedgerService;
let accountA = "";
let accountB = "";
let mainnetProfile = "";
let sequence = 0;

/** One userTrades row, shaped exactly as the normalizer produces it. */
function trade(overrides: Record<string, unknown> = {}) {
  return {
    tradeId: "1001",
    orderId: "77001",
    symbol: SYMBOL,
    side: "SELL",
    positionSide: "LONG" as const,
    quantity: "68.8",
    price: "1.0925",
    quoteQuantity: "75.1640",
    realizedPnl: "2.24936",
    commission: "0.03006560",
    commissionAsset: "USDT",
    maker: false,
    timeMs: 1_757_000_000_000,
    ...overrides,
  };
}

const fillsFor = async (executionProfileId: string) =>
  prisma!.exchangeFillLedger.findMany({ where: { executionProfileId }, orderBy: { exchangeTradeId: "asc" } });

/** A profile with a durable account+environment identity. */
async function profile(alias: string, environment: "TESTNET" | "MAINNET" = "TESTNET") {
  const row = await prisma!.executionProfile.create({
    data: { name: `${TAG} ${alias}`, accountIdentifier: `${TAG}-${alias}`, environment, isEnabled: false },
  });
  return row.id;
}

/** An owned execution with one order carrying the given exchange identity. */
async function ownedOrder(options: { exchangeOrderId?: string; actualOrderId?: string; role?: string }) {
  sequence += 1;
  const execution = await prisma!.tradeExecution.create({
    data: {
      executionProfileId: accountA,
      symbol: SYMBOL,
      direction: "LONG",
      positionSide: "LONG",
      selectedLookback: 200,
      plannedEntryPrice: "1.06", calculatedStopLoss: "1.01", executableStopLoss: "1.01",
      takeProfit: "1.09", riskBudgetUsd: "3", quantityRaw: "68.8", plannedQuantity: "68.8",
      quantityStepSize: "0.1", actualPlannedLoss: "3", unusedRiskBudget: "0",
      positionNotional: "72.9", targetIsolatedMargin: "7.3", maximumIsolatedMargin: "10",
      selectedLeverage: 10, estimatedInitialMargin: "7.3", liquidationBufferRatio: "0.5",
      decisionReasonCode: "SYNTHETIC",
    },
  });
  const order = await prisma!.binanceOrder.create({
    data: {
      tradeExecutionId: execution.id,
      role: (options.role ?? "TAKE_PROFIT") as "TAKE_PROFIT",
      generation: 1,
      clientOrderId: `${TAG}-${sequence}`,
      side: "SELL",
      positionSide: "LONG",
      orderType: "LIMIT",
      originalQuantity: "68.8",
      status: "NEW",
      exchangeOrderId: options.exchangeOrderId ?? null,
      actualOrderId: options.actualOrderId ?? null,
    },
  });
  return { execution, order };
}

beforeAll(async () => {
  if (!prisma || !available) return;
  ledger = new ExchangeFillLedgerService(prisma);
  accountA = await profile("account-a");
  accountB = await profile("account-b");
  mainnetProfile = await profile("account-a-mainnet", "MAINNET");
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
    await prisma.exchangeFillLedger.deleteMany({ where: { executionProfileId: { in: profiles } } });
    const executions = (
      await prisma.tradeExecution.findMany({
        where: { executionProfileId: { in: profiles } },
        select: { id: true },
      })
    ).map((row) => row.id);
    await prisma.binanceOrder.deleteMany({ where: { tradeExecutionId: { in: executions } } });
    await prisma.executionEvent.deleteMany({ where: { tradeExecutionId: { in: executions } } });
    await prisma.tradeExecution.deleteMany({ where: { id: { in: executions } } });
    await prisma.executionProfile.deleteMany({ where: { id: { in: profiles } } });
  }
  await prisma.$disconnect();
});

describe("a fill is recorded once, whatever happens afterwards", () => {
  maybe()("B. one fill becomes one row, with the facts as delivered", async () => {
    const id = await profile("insert-one");

    const report = await ledger.ingestUserTrades(id, [trade()]);

    expect(report.inserted).toBe(1);
    expect(report.duplicates).toBe(0);
    expect(report.skipped).toBe(0);
    const [row] = await fillsFor(id);
    expect(row.symbol).toBe(SYMBOL);
    expect(row.exchangeTradeId).toBe("1001");
    expect(row.exchangeOrderId).toBe("77001");
    expect(row.side).toBe("SELL");
    expect(row.positionSide).toBe("LONG");
    expect(row.quantity.toString()).toBe("68.8");
    expect(row.price.toString()).toBe("1.0925");
    expect(row.tradeTime.getTime()).toBe(1_757_000_000_000);
    expect(row.maker).toBe(false);
  });

  maybe()("C/O. replaying the identical fill writes nothing and changes nothing", async () => {
    const id = await profile("replay");
    await ledger.ingestUserTrades(id, [trade()]);
    const [first] = await fillsFor(id);

    // The restart: the same window is read again, three more times.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const report = await ledger.ingestUserTrades(id, [trade()]);
      expect(report.inserted).toBe(0);
      expect(report.duplicates).toBe(1);
    }

    const rows = await fillsFor(id);
    expect(rows).toHaveLength(1);
    // Not rewritten either: the original row is untouched, ingestedAt included.
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].ingestedAt.getTime()).toBe(first.ingestedAt.getTime());
  });

  maybe()("D. overlapping windows re-deliver known trades without duplicating", async () => {
    const id = await profile("overlap");
    await ledger.ingestUserTrades(id, [
      trade({ tradeId: "1", orderId: "9" }),
      trade({ tradeId: "2", orderId: "9" }),
    ]);

    // The next poll starts earlier than the last one ended, as a time-windowed
    // read always can.
    const report = await ledger.ingestUserTrades(id, [
      trade({ tradeId: "2", orderId: "9" }),
      trade({ tradeId: "3", orderId: "9" }),
    ]);

    expect(report.inserted).toBe(1);
    expect(report.duplicates).toBe(1);
    expect((await fillsFor(id)).map((row) => row.exchangeTradeId)).toEqual(["1", "2", "3"]);
  });

  maybe()("E. the same identity with different economics is refused, not absorbed", async () => {
    const id = await profile("conflict");
    await ledger.ingestUserTrades(id, [trade()]);

    // Same account, same symbol, same trade id — different money.
    await expect(
      ledger.ingestUserTrades(id, [trade({ realizedPnl: "999", commission: "0.5" })])
    ).rejects.toBeInstanceOf(FillLedgerConflictError);

    // And the original is intact: nothing was overwritten on the way to the error.
    const rows = await fillsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].realizedPnl!.toString()).toBe("2.24936");
    expect(rows[0].commission!.toString()).toBe("0.0300656");
  });

  maybe()("a conflict names the fields that disagree", async () => {
    const id = await profile("conflict-detail");
    await ledger.ingestUserTrades(id, [trade()]);

    await expect(
      ledger.ingestUserTrades(id, [trade({ quantity: "10", price: "2" })])
    ).rejects.toThrow(/quantity.*price|price.*quantity/);
  });

  maybe()("the same decimal written differently is NOT a conflict", async () => {
    // "1.50" and "1.5" are one number. Treating a formatting difference as a
    // contradiction would make ordinary replays fail loudly for no reason.
    const id = await profile("decimal-equal");
    await ledger.ingestUserTrades(id, [trade({ quantity: "68.80", price: "1.09250" })]);

    const report = await ledger.ingestUserTrades(id, [trade({ quantity: "68.8", price: "1.0925" })]);

    expect(report.duplicates).toBe(1);
    expect(await fillsFor(id)).toHaveLength(1);
  });

  maybe()("F/9. three fills of one order are three rows, and stay three", async () => {
    const id = await profile("partials");
    const partials = [
      trade({ tradeId: "5001", orderId: "88", quantity: "20", price: "1.09" }),
      trade({ tradeId: "5002", orderId: "88", quantity: "20", price: "1.0925" }),
      trade({ tradeId: "5003", orderId: "88", quantity: "28.8", price: "1.095" }),
    ];

    expect((await ledger.ingestUserTrades(id, partials)).inserted).toBe(3);
    const rows = await fillsFor(id);
    expect(rows).toHaveLength(3);
    // Not collapsed: each keeps its own price and quantity.
    expect(rows.map((row) => row.price.toString())).toEqual(["1.09", "1.0925", "1.095"]);

    const replay = await ledger.ingestUserTrades(id, partials);
    expect(replay.inserted).toBe(0);
    expect(replay.duplicates).toBe(3);
    expect(await fillsFor(id)).toHaveLength(3);
  });
});

describe("a race on the unique key cannot smuggle a conflict through", () => {
  /**
   * A service whose FIRST look for an existing fill answers "not there",
   * against a database where it IS there.
   *
   * That is precisely the losing side of a race: both callers read nothing,
   * one inserts, the other reaches the constraint. It is reproduced this way
   * rather than by two genuinely parallel calls because the interleaving that
   * matters must happen on EVERY run — a timing-dependent test that usually
   * takes the ordinary path would pass while the P2002 branch stayed unproven.
   * Everything else is real: the same service, the same database, the same
   * unique constraint doing the rejecting.
   */
  function blindedService() {
    let blinded = false;
    const client = new Proxy(prisma as object, {
      get(target, property, receiver) {
        if (property !== "exchangeFillLedger") return Reflect.get(target, property, receiver);
        const real = Reflect.get(target, property, receiver) as Record<string, unknown>;
        return new Proxy(real, {
          get(inner, innerProperty, innerReceiver) {
            if (innerProperty !== "findUnique") return Reflect.get(inner, innerProperty, innerReceiver);
            return async (...args: unknown[]) => {
              if (!blinded) {
                blinded = true;
                return null;
              }
              return (Reflect.get(inner, innerProperty, innerReceiver) as CallableFunction).apply(inner, args);
            };
          },
        });
      },
    }) as PrismaClient;
    return new ExchangeFillLedgerService(client);
  }

  maybe()("A. an identical fill losing the race is a duplicate, and stays one row", async () => {
    const id = await profile("race-identical");
    // The winner.
    await ledger.ingestUserTrades(id, [trade({ tradeId: "9001", orderId: "R1" })]);
    const [winner] = await fillsFor(id);

    // The loser: reads nothing, tries to insert, is rejected by the constraint.
    const report = await blindedService().ingestUserTrades(id, [trade({ tradeId: "9001", orderId: "R1" })]);

    expect(report.inserted).toBe(0);
    expect(report.duplicates).toBe(1);
    const rows = await fillsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(winner.id);
    expect(rows[0].ingestedAt.getTime()).toBe(winner.ingestedAt.getTime());
  });

  maybe()("B. a CONFLICTING fill losing the race is surfaced, never absorbed", async () => {
    // The whole point. Before the re-read, a unique violation was taken as
    // proof of a duplicate, so contradictory economics arriving a millisecond
    // late reported success and were silently dropped.
    const id = await profile("race-conflict");
    await ledger.ingestUserTrades(id, [
      trade({ tradeId: "9002", orderId: "R2", quantity: "1", price: "100", realizedPnl: "1" }),
    ]);
    const [winner] = await fillsFor(id);

    await expect(
      blindedService().ingestUserTrades(id, [
        trade({ tradeId: "9002", orderId: "R2", quantity: "1", price: "101", realizedPnl: "2" }),
      ])
    ).rejects.toBeInstanceOf(FillLedgerConflictError);

    // Exactly one row, and the winner is untouched.
    const rows = await fillsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(winner.id);
    expect(rows[0].price.toString()).toBe("100");
    expect(rows[0].realizedPnl!.toString()).toBe("1");
  });

  maybe()("genuinely parallel identical ingestion still leaves exactly one row", async () => {
    // Real concurrency, non-deterministic by nature: whichever interleaving
    // occurs, the outcome must be the same one row.
    const id = await profile("race-parallel");
    const fill = [trade({ tradeId: "9003", orderId: "R3" })];

    const results = await Promise.allSettled([
      ledger.ingestUserTrades(id, fill),
      ledger.ingestUserTrades(id, fill),
      ledger.ingestUserTrades(id, fill),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const inserted = results.reduce(
      (total, result) => total + (result.status === "fulfilled" ? result.value.inserted : 0),
      0
    );
    expect(inserted).toBe(1);
    expect(await fillsFor(id)).toHaveLength(1);
  });
});

describe("a fill belongs to one account", () => {
  maybe()("J. two accounts may hold the same trade id without colliding", async () => {
    // A Binance trade id is unique per account, not globally. The day a second
    // account exists, this is what stops its history overwriting the first.
    const sameTrade = trade({ tradeId: "424242", orderId: "313" });

    expect((await ledger.ingestUserTrades(accountA, [sameTrade])).inserted).toBe(1);
    expect((await ledger.ingestUserTrades(accountB, [sameTrade])).inserted).toBe(1);

    expect(await fillsFor(accountA)).toHaveLength(1);
    expect(await fillsFor(accountB)).toHaveLength(1);
    // And a replay on either side still changes nothing.
    expect((await ledger.ingestUserTrades(accountB, [sameTrade])).duplicates).toBe(1);
    expect(await fillsFor(accountB)).toHaveLength(1);
  });

  maybe()("K. TESTNET and MAINNET are different accounts and never merge", async () => {
    const sameTrade = trade({ tradeId: "515151", orderId: "414" });

    expect((await ledger.ingestUserTrades(accountA, [sameTrade])).inserted).toBe(1);
    expect((await ledger.ingestUserTrades(mainnetProfile, [sameTrade])).inserted).toBe(1);

    const mainnet = await fillsFor(mainnetProfile);
    expect(mainnet).toHaveLength(1);
    const environment = await prisma!.executionProfile.findUniqueOrThrow({
      where: { id: mainnet[0].executionProfileId },
    });
    expect(environment.environment).toBe("MAINNET");
  });

  maybe()("every fill carries its account, including an unattributed one", async () => {
    const id = await profile("account-required");
    await ledger.ingestUserTrades(id, [trade({ tradeId: "600", orderId: "no-such-order" })]);

    const [row] = await fillsFor(id);
    expect(row.executionProfileId).toBe(id);
    expect(row.attribution).toBe("UNATTRIBUTED");
    expect(row.tradeExecutionId).toBeNull();
  });
});

describe("attribution is by order identity, or not at all", () => {
  maybe()("G. an ordinary order id maps to the owned order and its execution", async () => {
    const { execution, order } = await ownedOrder({ exchangeOrderId: "ORD-STD-1", role: "ENTRY" });

    // Ingested for the SAME account the order belongs to, which is the only
    // way a fill can be attributed at all.
    await ledger.ingestUserTrades(accountA, [trade({ tradeId: "700", orderId: "ORD-STD-1", side: "BUY" })]);

    const row = (await fillsFor(accountA)).find((entry) => entry.exchangeTradeId === "700")!;
    expect(row.attribution).toBe("OWNED_ORDER");
    expect(row.binanceOrderId).toBe(order.id);
    expect(row.tradeExecutionId).toBe(execution.id);
  });

  maybe()("H. a triggered conditional order maps through actualOrderId", async () => {
    // A conditional order carries no exchange order id until it fires; the
    // order it CREATES is what a fill references.
    const { execution, order } = await ownedOrder({ actualOrderId: "ORD-ALGO-9", role: "STOP_LOSS" });

    await ledger.ingestUserTrades(accountA, [trade({ tradeId: "701", orderId: "ORD-ALGO-9" })]);

    const row = (await fillsFor(accountA)).find((entry) => entry.exchangeTradeId === "701")!;
    expect(row.attribution).toBe("OWNED_ORDER");
    expect(row.binanceOrderId).toBe(order.id);
    expect(row.tradeExecutionId).toBe(execution.id);
  });

  maybe()("I. a fill we do not own is recorded, and never attributed to anything", async () => {
    // Another client, a manual trade, a liquidation. It is real and it belongs
    // to the account, but it explains nothing about our executions.
    await ownedOrder({ exchangeOrderId: "ORD-MINE" });

    await ledger.ingestUserTrades(accountA, [trade({ tradeId: "702", orderId: "ORD-SOMEONE-ELSE" })]);

    const row = (await fillsFor(accountA)).find((entry) => entry.exchangeTradeId === "702")!;
    expect(row.attribution).toBe("UNATTRIBUTED");
    expect(row.binanceOrderId).toBeNull();
    expect(row.tradeExecutionId).toBeNull();
    // Same symbol and the same second as an order we DO own is not evidence.
    expect(row.symbol).toBe(SYMBOL);
  });

  maybe()("a fill with no order id at all is never guessed into an execution", async () => {
    const id = await profile("attr-null");
    await ledger.ingestUserTrades(id, [trade({ tradeId: "703", orderId: null })]);

    const [row] = await fillsFor(id);
    expect(row.attribution).toBe("UNATTRIBUTED");
    expect(row.tradeExecutionId).toBeNull();
  });

  maybe()("two owned rows claiming one exchange id is AMBIGUOUS, not first-wins", async () => {
    // Neither exchangeOrderId nor actualOrderId is unique on BinanceOrder, so
    // this is representable. Picking one would silently move a trade's
    // economics onto the wrong execution.
    await ownedOrder({ exchangeOrderId: "ORD-DUP" });
    await ownedOrder({ actualOrderId: "ORD-DUP" });

    const report = await ledger.ingestUserTrades(accountA, [trade({ tradeId: "704", orderId: "ORD-DUP" })]);

    expect(report.ambiguous).toBe(1);
    const row = (await fillsFor(accountA)).find((entry) => entry.exchangeTradeId === "704")!;
    expect(row.attribution).toBe("AMBIGUOUS");
    expect(row.binanceOrderId).toBeNull();
    expect(row.tradeExecutionId).toBeNull();
  });
});

describe("attribution never crosses an account boundary", () => {
  /** An owned order under a NAMED profile, carrying a chosen exchange id. */
  async function ownedOrderIn(
    executionProfileId: string,
    options: { exchangeOrderId?: string; actualOrderId?: string; role?: string }
  ) {
    sequence += 1;
    const execution = await prisma!.tradeExecution.create({
      data: {
        executionProfileId,
        symbol: SYMBOL,
        direction: "LONG",
        positionSide: "LONG",
        selectedLookback: 200,
        plannedEntryPrice: "1.06", calculatedStopLoss: "1.01", executableStopLoss: "1.01",
        takeProfit: "1.09", riskBudgetUsd: "3", quantityRaw: "68.8", plannedQuantity: "68.8",
        quantityStepSize: "0.1", actualPlannedLoss: "3", unusedRiskBudget: "0",
        positionNotional: "72.9", targetIsolatedMargin: "7.3", maximumIsolatedMargin: "10",
        selectedLeverage: 10, estimatedInitialMargin: "7.3", liquidationBufferRatio: "0.5",
        decisionReasonCode: "SYNTHETIC",
      },
    });
    const order = await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id,
        role: (options.role ?? "TAKE_PROFIT") as "TAKE_PROFIT",
        generation: 1,
        clientOrderId: `${TAG}-x-${sequence}`,
        side: "SELL",
        positionSide: "LONG",
        orderType: "LIMIT",
        originalQuantity: "68.8",
        status: "NEW",
        exchangeOrderId: options.exchangeOrderId ?? null,
        actualOrderId: options.actualOrderId ?? null,
      },
    });
    return { execution, order };
  }

  maybe()("A. the same ordinary order id in two accounts resolves to the right one", async () => {
    // An exchange order id is unique within an account, not across them. Two
    // accounts will eventually both hold order 999, and they are unrelated.
    const shared = "SHARED-ORD-999";
    const mine = await ownedOrderIn(accountA, { exchangeOrderId: shared, role: "ENTRY" });
    const theirs = await ownedOrderIn(accountB, { exchangeOrderId: shared, role: "ENTRY" });

    await ledger.ingestUserTrades(accountA, [
      trade({ tradeId: "A-999", orderId: shared, side: "BUY" }),
    ]);

    const row = (await fillsFor(accountA)).find((entry) => entry.exchangeTradeId === "A-999")!;
    // Unambiguous: the other account's identical id is not a competing match.
    expect(row.attribution).toBe("OWNED_ORDER");
    expect(row.binanceOrderId).toBe(mine.order.id);
    expect(row.tradeExecutionId).toBe(mine.execution.id);
    expect(row.binanceOrderId).not.toBe(theirs.order.id);
    expect(row.tradeExecutionId).not.toBe(theirs.execution.id);
  });

  maybe()("B. the same triggered-conditional id in two accounts resolves to the right one", async () => {
    const shared = "SHARED-ALGO-999";
    const mine = await ownedOrderIn(accountA, { actualOrderId: shared, role: "STOP_LOSS" });
    const theirs = await ownedOrderIn(accountB, { actualOrderId: shared, role: "STOP_LOSS" });

    await ledger.ingestUserTrades(accountA, [trade({ tradeId: "A-ALGO-999", orderId: shared })]);

    const row = (await fillsFor(accountA)).find((entry) => entry.exchangeTradeId === "A-ALGO-999")!;
    expect(row.attribution).toBe("OWNED_ORDER");
    expect(row.binanceOrderId).toBe(mine.order.id);
    expect(row.tradeExecutionId).toBe(mine.execution.id);
    expect(row.binanceOrderId).not.toBe(theirs.order.id);
  });

  maybe()("C. two matching rows INSIDE one account are still AMBIGUOUS", async () => {
    // The account boundary narrows the search; it does not make a genuine
    // within-account collision safe to resolve.
    const shared = "INTERNAL-DUP-1";
    await ownedOrderIn(accountA, { exchangeOrderId: shared });
    await ownedOrderIn(accountA, { actualOrderId: shared });

    const report = await ledger.ingestUserTrades(accountA, [
      trade({ tradeId: "A-DUP", orderId: shared }),
    ]);

    expect(report.ambiguous).toBe(1);
    const row = (await fillsFor(accountA)).find((entry) => entry.exchangeTradeId === "A-DUP")!;
    expect(row.attribution).toBe("AMBIGUOUS");
    expect(row.binanceOrderId).toBeNull();
    expect(row.tradeExecutionId).toBeNull();
  });

  maybe()("D. an id owned only by Account B leaves Account A's fill UNATTRIBUTED", async () => {
    // The failure this scoping exists to prevent: without it, Account B's
    // order would have claimed a fill from an account it has no relation to.
    const onlyTheirs = "ONLY-B-777";
    const theirs = await ownedOrderIn(accountB, { exchangeOrderId: onlyTheirs });

    await ledger.ingestUserTrades(accountA, [trade({ tradeId: "A-777", orderId: onlyTheirs })]);

    const row = (await fillsFor(accountA)).find((entry) => entry.exchangeTradeId === "A-777")!;
    expect(row.attribution).toBe("UNATTRIBUTED");
    expect(row.binanceOrderId).toBeNull();
    expect(row.tradeExecutionId).toBeNull();
    // And Account B's execution is untouched by a fill that was never its own.
    expect(
      await prisma!.exchangeFillLedger.count({ where: { tradeExecutionId: theirs.execution.id } })
    ).toBe(0);
  });

  maybe()("D2. an id owned only by another account is not AMBIGUOUS either", async () => {
    // Two OTHER accounts reusing one id must not make our fill look ambiguous:
    // neither row is a candidate at all.
    const elsewhere = "ELSEWHERE-888";
    await ownedOrderIn(accountB, { exchangeOrderId: elsewhere });
    await ownedOrderIn(mainnetProfile, { exchangeOrderId: elsewhere });

    const report = await ledger.ingestUserTrades(accountA, [
      trade({ tradeId: "A-888", orderId: elsewhere }),
    ]);

    expect(report.ambiguous).toBe(0);
    expect(report.unattributed).toBe(1);
    const row = (await fillsFor(accountA)).find((entry) => entry.exchangeTradeId === "A-888")!;
    expect(row.attribution).toBe("UNATTRIBUTED");
  });
});

describe("attribution never crosses a symbol boundary", () => {
  // A USD-M order id is self-incrementing PER SYMBOL, so the same number is
  // handed out independently on BTCUSDT and ETHUSDT within one account. An id
  // alone identifies nothing.
  const BTC = "LEDGERBTCUSDT";
  const ETH = "LEDGERETHUSDT";

  /** An owned order on a NAMED symbol under a named profile. */
  async function ownedOrderOn(
    executionProfileId: string,
    symbol: string,
    options: { exchangeOrderId?: string; actualOrderId?: string; role?: string }
  ) {
    sequence += 1;
    const execution = await prisma!.tradeExecution.create({
      data: {
        executionProfileId,
        symbol,
        direction: "LONG",
        positionSide: "LONG",
        selectedLookback: 200,
        plannedEntryPrice: "1.06", calculatedStopLoss: "1.01", executableStopLoss: "1.01",
        takeProfit: "1.09", riskBudgetUsd: "3", quantityRaw: "68.8", plannedQuantity: "68.8",
        quantityStepSize: "0.1", actualPlannedLoss: "3", unusedRiskBudget: "0",
        positionNotional: "72.9", targetIsolatedMargin: "7.3", maximumIsolatedMargin: "10",
        selectedLeverage: 10, estimatedInitialMargin: "7.3", liquidationBufferRatio: "0.5",
        decisionReasonCode: "SYNTHETIC",
      },
    });
    const order = await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id,
        role: (options.role ?? "TAKE_PROFIT") as "TAKE_PROFIT",
        generation: 1,
        clientOrderId: `${TAG}-sym-${sequence}`,
        side: "SELL",
        positionSide: "LONG",
        orderType: "LIMIT",
        originalQuantity: "68.8",
        status: "NEW",
        exchangeOrderId: options.exchangeOrderId ?? null,
        actualOrderId: options.actualOrderId ?? null,
      },
    });
    return { execution, order };
  }

  const fillOn = async (executionProfileId: string, symbol: string, tradeId: string) =>
    prisma!.exchangeFillLedger.findFirstOrThrow({
      where: { executionProfileId, symbol, exchangeTradeId: tradeId },
    });

  maybe()("4. a BTC order and an ETH order sharing an id do not compete", async () => {
    const shared = "SAME-123";
    const btc = await ownedOrderOn(accountA, BTC, { exchangeOrderId: shared, role: "ENTRY" });
    const eth = await ownedOrderOn(accountA, ETH, { exchangeOrderId: shared, role: "ENTRY" });

    const report = await ledger.ingestUserTrades(accountA, [
      trade({ tradeId: "SYM-1", orderId: shared, symbol: BTC, side: "BUY" }),
    ]);

    const row = await fillOn(accountA, BTC, "SYM-1");
    expect(row.attribution).toBe("OWNED_ORDER");
    expect(row.binanceOrderId).toBe(btc.order.id);
    expect(row.tradeExecutionId).toBe(btc.execution.id);
    // The ETH row reusing the number is not a competing match, so this is not
    // ambiguous — it is simply a different order.
    expect(report.ambiguous).toBe(0);
    expect(row.binanceOrderId).not.toBe(eth.order.id);
    expect(row.tradeExecutionId).not.toBe(eth.execution.id);
  });

  maybe()("5. the same holds for a triggered conditional order id", async () => {
    const shared = "SAME-ALGO-123";
    const btc = await ownedOrderOn(accountA, BTC, { actualOrderId: shared, role: "STOP_LOSS" });
    const eth = await ownedOrderOn(accountA, ETH, { actualOrderId: shared, role: "STOP_LOSS" });

    const report = await ledger.ingestUserTrades(accountA, [
      trade({ tradeId: "SYM-2", orderId: shared, symbol: BTC }),
    ]);

    const row = await fillOn(accountA, BTC, "SYM-2");
    expect(row.attribution).toBe("OWNED_ORDER");
    expect(row.binanceOrderId).toBe(btc.order.id);
    expect(row.tradeExecutionId).toBe(btc.execution.id);
    expect(report.ambiguous).toBe(0);
    expect(row.binanceOrderId).not.toBe(eth.order.id);
  });

  maybe()("6. an id owned only on ANOTHER symbol leaves the fill unattributed", async () => {
    const elsewhere = "OTHER-SYM-777";
    const eth = await ownedOrderOn(accountA, ETH, { exchangeOrderId: elsewhere });

    await ledger.ingestUserTrades(accountA, [
      trade({ tradeId: "SYM-3", orderId: elsewhere, symbol: BTC }),
    ]);

    const row = await fillOn(accountA, BTC, "SYM-3");
    expect(row.attribution).toBe("UNATTRIBUTED");
    expect(row.binanceOrderId).toBeNull();
    expect(row.tradeExecutionId).toBeNull();
    // And the ETH execution never acquires a fill that was never its own.
    expect(
      await prisma!.exchangeFillLedger.count({ where: { tradeExecutionId: eth.execution.id } })
    ).toBe(0);
  });

  maybe()("6b. the same control for a triggered conditional id", async () => {
    const elsewhere = "OTHER-SYM-ALGO-777";
    await ownedOrderOn(accountA, ETH, { actualOrderId: elsewhere, role: "STOP_LOSS" });

    await ledger.ingestUserTrades(accountA, [
      trade({ tradeId: "SYM-4", orderId: elsewhere, symbol: BTC }),
    ]);

    expect((await fillOn(accountA, BTC, "SYM-4")).attribution).toBe("UNATTRIBUTED");
  });

  maybe()("7. a genuine collision on the SAME symbol is still AMBIGUOUS", async () => {
    // Narrowing by symbol must not hide a real collision inside the correct
    // account and symbol.
    const shared = "SAME-SYMBOL-DUP";
    await ownedOrderOn(accountA, BTC, { exchangeOrderId: shared });
    await ownedOrderOn(accountA, BTC, { actualOrderId: shared });

    const report = await ledger.ingestUserTrades(accountA, [
      trade({ tradeId: "SYM-5", orderId: shared, symbol: BTC }),
    ]);

    expect(report.ambiguous).toBe(1);
    const row = await fillOn(accountA, BTC, "SYM-5");
    expect(row.attribution).toBe("AMBIGUOUS");
    expect(row.binanceOrderId).toBeNull();
    expect(row.tradeExecutionId).toBeNull();
  });

  maybe()("8. account and symbol are BOTH required, not either", async () => {
    // The right order exists only under the other account on this symbol, and
    // only under this account on the other symbol. Neither is a match.
    const shared = "NEEDS-BOTH-1";
    await ownedOrderOn(accountB, BTC, { exchangeOrderId: shared });
    await ownedOrderOn(accountA, ETH, { exchangeOrderId: shared });

    const report = await ledger.ingestUserTrades(accountA, [
      trade({ tradeId: "SYM-6", orderId: shared, symbol: BTC }),
    ]);

    expect(report.unattributed).toBe(1);
    expect(report.ambiguous).toBe(0);
    expect((await fillOn(accountA, BTC, "SYM-6")).attribution).toBe("UNATTRIBUTED");
  });
});

// ---------------------------------------------------------------------------
// Attribution can be learned later; economics cannot
// ---------------------------------------------------------------------------
//
// A fill can legitimately be read before the order that produced it has had its
// exchange identity recorded locally — an ambiguous submission is reconciled
// after the fact. Attribution was previously computed only on insert, so such a
// fill stayed unowned permanently. Learning WHOSE a fill is later is not the
// same as changing WHAT it was.

describe("attribution enrichment on replay", () => {
  async function orderIn(
    executionProfileId: string,
    symbol: string,
    options: { exchangeOrderId?: string; actualOrderId?: string; role?: string }
  ) {
    sequence += 1;
    const execution = await prisma!.tradeExecution.create({
      data: {
        executionProfileId,
        symbol,
        direction: "LONG",
        positionSide: "LONG",
        selectedLookback: 200,
        plannedEntryPrice: "1.06", calculatedStopLoss: "1.01", executableStopLoss: "1.01",
        takeProfit: "1.09", riskBudgetUsd: "3", quantityRaw: "68.8", plannedQuantity: "68.8",
        quantityStepSize: "0.1", actualPlannedLoss: "3", unusedRiskBudget: "0",
        positionNotional: "72.9", targetIsolatedMargin: "7.3", maximumIsolatedMargin: "10",
        selectedLeverage: 10, estimatedInitialMargin: "7.3", liquidationBufferRatio: "0.5",
        decisionReasonCode: "SYNTHETIC",
      },
    });
    const order = await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id,
        role: (options.role ?? "TAKE_PROFIT") as "TAKE_PROFIT",
        generation: 1,
        clientOrderId: `${TAG}-enr-${sequence}`,
        side: "SELL",
        positionSide: "LONG",
        orderType: "LIMIT",
        originalQuantity: "68.8",
        status: "NEW",
        exchangeOrderId: options.exchangeOrderId ?? null,
        actualOrderId: options.actualOrderId ?? null,
      },
    });
    return { execution, order };
  }

  const fillRow = async (executionProfileId: string, symbol: string, exchangeTradeId: string) =>
    prisma!.exchangeFillLedger.findFirstOrThrow({
      where: { executionProfileId, symbol, exchangeTradeId },
    });

  const countFor = async (executionProfileId: string, exchangeTradeId: string) =>
    prisma!.exchangeFillLedger.count({ where: { executionProfileId, exchangeTradeId } });

  maybe()("A/C/D/E. an ordinary order recorded later claims its fill, and nothing else moves", async () => {
    const id = await profile("enrich-standard");
    const fill = trade({ tradeId: "E-1", orderId: "LATE-ORD-1", symbol: SYMBOL });

    // 1. The fill arrives first. Nothing owns it yet.
    await ledger.ingestUserTrades(id, [fill]);
    const before = await fillRow(id, SYMBOL, "E-1");
    expect(before.attribution).toBe("UNATTRIBUTED");
    expect(before.binanceOrderId).toBeNull();

    // 2. Reconciliation later captures the order's exchange identity.
    const owner = await orderIn(id, SYMBOL, { exchangeOrderId: "LATE-ORD-1", role: "ENTRY" });

    // 3. The very same fill is replayed.
    const report = await ledger.ingestUserTrades(id, [fill]);

    expect(report.attributionEnriched).toBe(1);
    // Still a duplicate economic fill: enrichment is counted as well, not instead.
    expect(report.duplicates).toBe(1);
    expect(report.inserted).toBe(0);

    const after = await fillRow(id, SYMBOL, "E-1");
    expect(after.attribution).toBe("OWNED_ORDER");
    expect(after.binanceOrderId).toBe(owner.order.id);
    expect(after.tradeExecutionId).toBe(owner.execution.id);

    // C/D: the same row, not a replacement.
    expect(after.id).toBe(before.id);
    expect(after.ingestedAt.getTime()).toBe(before.ingestedAt.getTime());
    expect(await countFor(id, "E-1")).toBe(1);

    // E: every economic fact exactly as it was.
    expect(after.exchangeOrderId).toBe(before.exchangeOrderId);
    expect(after.side).toBe(before.side);
    expect(after.positionSide).toBe(before.positionSide);
    expect(after.quantity.toFixed()).toBe(before.quantity.toFixed());
    expect(after.price.toFixed()).toBe(before.price.toFixed());
    expect(after.quoteQuantity!.toFixed()).toBe(before.quoteQuantity!.toFixed());
    expect(after.realizedPnl!.toFixed()).toBe(before.realizedPnl!.toFixed());
    expect(after.commission!.toFixed()).toBe(before.commission!.toFixed());
    expect(after.commissionAsset).toBe(before.commissionAsset);
    expect(after.maker).toBe(before.maker);
    expect(after.tradeTime.getTime()).toBe(before.tradeTime.getTime());
    expect(after.symbol).toBe(before.symbol);
    expect(after.exchangeTradeId).toBe(before.exchangeTradeId);
    expect(after.executionProfileId).toBe(before.executionProfileId);
  });

  maybe()("B. a triggered conditional order recorded later claims its fill too", async () => {
    // The realistic case: a conditional order has no exchange order id until it
    // fires, so the fill can easily be seen before the id it references exists.
    const id = await profile("enrich-algo");
    const fill = trade({ tradeId: "E-2", orderId: "LATE-ALGO-1", symbol: SYMBOL });

    await ledger.ingestUserTrades(id, [fill]);
    expect((await fillRow(id, SYMBOL, "E-2")).attribution).toBe("UNATTRIBUTED");

    const owner = await orderIn(id, SYMBOL, { actualOrderId: "LATE-ALGO-1", role: "STOP_LOSS" });

    const report = await ledger.ingestUserTrades(id, [fill]);

    expect(report.attributionEnriched).toBe(1);
    const after = await fillRow(id, SYMBOL, "E-2");
    expect(after.attribution).toBe("OWNED_ORDER");
    expect(after.binanceOrderId).toBe(owner.order.id);
    expect(after.tradeExecutionId).toBe(owner.execution.id);
  });

  maybe()("F. replaying with still no owner changes nothing at all", async () => {
    const id = await profile("enrich-none");
    const fill = trade({ tradeId: "E-3", orderId: "NEVER-OWNED", symbol: SYMBOL });

    await ledger.ingestUserTrades(id, [fill]);
    const before = await fillRow(id, SYMBOL, "E-3");

    const report = await ledger.ingestUserTrades(id, [fill]);

    expect(report.attributionEnriched).toBe(0);
    expect(report.duplicates).toBe(1);
    const after = await fillRow(id, SYMBOL, "E-3");
    expect(after.attribution).toBe("UNATTRIBUTED");
    expect(after.binanceOrderId).toBeNull();
    expect(after.id).toBe(before.id);
    expect(await countFor(id, "E-3")).toBe(1);
  });

  maybe()("G. two late candidates are not guessed between", async () => {
    // Guessing one late is no better than guessing one early. The row keeps
    // saying it has no owner, and the caller is told why.
    const id = await profile("enrich-ambiguous");
    const fill = trade({ tradeId: "E-4", orderId: "LATE-DUP", symbol: SYMBOL });

    await ledger.ingestUserTrades(id, [fill]);
    await orderIn(id, SYMBOL, { exchangeOrderId: "LATE-DUP" });
    await orderIn(id, SYMBOL, { actualOrderId: "LATE-DUP" });

    const report = await ledger.ingestUserTrades(id, [fill]);

    expect(report.attributionEnriched).toBe(0);
    expect(report.ambiguous).toBe(1);
    const after = await fillRow(id, SYMBOL, "E-4");
    // Deliberately NOT transitioned to AMBIGUOUS: this fills in an absent
    // owner, it does not run a state machine over attribution.
    expect(after.attribution).toBe("UNATTRIBUTED");
    expect(after.binanceOrderId).toBeNull();
  });

  maybe()("H. an economic conflict blocks enrichment, even when an owner now exists", async () => {
    // Priority matters: enrichment must never become a way past the conflict
    // check. Contradictory economics are a conflict whether or not ownership
    // could now be settled.
    const id = await profile("enrich-conflict");
    await ledger.ingestUserTrades(id, [
      trade({ tradeId: "E-5", orderId: "CONFLICT-ORD", symbol: SYMBOL, price: "100" }),
    ]);
    await orderIn(id, SYMBOL, { exchangeOrderId: "CONFLICT-ORD" });

    await expect(
      ledger.ingestUserTrades(id, [
        trade({ tradeId: "E-5", orderId: "CONFLICT-ORD", symbol: SYMBOL, price: "101" }),
      ])
    ).rejects.toBeInstanceOf(FillLedgerConflictError);

    const after = await fillRow(id, SYMBOL, "E-5");
    expect(after.price.toFixed()).toBe("100");
    // No attribution mutation happened on the way to the error.
    expect(after.attribution).toBe("UNATTRIBUTED");
    expect(after.binanceOrderId).toBeNull();
  });

  maybe()("I. an owner already recorded never moves, even with a competitor present", async () => {
    const id = await profile("enrich-sticky");
    const fill = trade({ tradeId: "E-6", orderId: "STICKY-ORD", symbol: SYMBOL });
    const first = await orderIn(id, SYMBOL, { exchangeOrderId: "STICKY-ORD" });

    await ledger.ingestUserTrades(id, [fill]);
    const owned = await fillRow(id, SYMBOL, "E-6");
    expect(owned.attribution).toBe("OWNED_ORDER");
    expect(owned.binanceOrderId).toBe(first.order.id);

    // A competing local row appears afterwards, which would make a fresh
    // lookup ambiguous. The stored answer is not re-litigated.
    await orderIn(id, SYMBOL, { actualOrderId: "STICKY-ORD" });

    const report = await ledger.ingestUserTrades(id, [fill]);

    expect(report.attributionEnriched).toBe(0);
    // Not re-resolved at all, so not reported as ambiguous either.
    expect(report.ambiguous).toBe(0);
    const after = await fillRow(id, SYMBOL, "E-6");
    expect(after.attribution).toBe("OWNED_ORDER");
    expect(after.binanceOrderId).toBe(first.order.id);
    expect(after.tradeExecutionId).toBe(first.execution.id);
  });

  maybe()("J. a late order in ANOTHER account cannot claim this fill", async () => {
    const id = await profile("enrich-cross-account");
    const fill = trade({ tradeId: "E-7", orderId: "CROSS-ACCT", symbol: SYMBOL });

    await ledger.ingestUserTrades(id, [fill]);
    // The order appears — but under a different account.
    const theirs = await orderIn(accountB, SYMBOL, { exchangeOrderId: "CROSS-ACCT" });

    const report = await ledger.ingestUserTrades(id, [fill]);

    expect(report.attributionEnriched).toBe(0);
    const after = await fillRow(id, SYMBOL, "E-7");
    expect(after.attribution).toBe("UNATTRIBUTED");
    expect(after.tradeExecutionId).toBeNull();
    expect(
      await prisma!.exchangeFillLedger.count({ where: { tradeExecutionId: theirs.execution.id } })
    ).toBe(0);
  });

  maybe()("K. a late order on ANOTHER symbol cannot claim this fill", async () => {
    const id = await profile("enrich-cross-symbol");
    const fill = trade({ tradeId: "E-8", orderId: "CROSS-SYM", symbol: SYMBOL });

    await ledger.ingestUserTrades(id, [fill]);
    await orderIn(id, "LEDGERALTUSDT", { exchangeOrderId: "CROSS-SYM" });

    const report = await ledger.ingestUserTrades(id, [fill]);

    expect(report.attributionEnriched).toBe(0);
    expect((await fillRow(id, SYMBOL, "E-8")).attribution).toBe("UNATTRIBUTED");
  });

  maybe()("J/K. only the correct account AND symbol may enrich, among decoys", async () => {
    const id = await profile("enrich-decoys");
    const fill = trade({ tradeId: "E-9", orderId: "DECOY-1", symbol: SYMBOL });
    await ledger.ingestUserTrades(id, [fill]);

    // Wrong account, right symbol. Right account, wrong symbol. Then the
    // genuine one.
    await orderIn(accountB, SYMBOL, { exchangeOrderId: "DECOY-1" });
    await orderIn(id, "LEDGERALTUSDT", { exchangeOrderId: "DECOY-1" });
    const correct = await orderIn(id, SYMBOL, { exchangeOrderId: "DECOY-1" });

    const report = await ledger.ingestUserTrades(id, [fill]);

    expect(report.attributionEnriched).toBe(1);
    // Exactly one candidate survived the boundary, so this is not ambiguous.
    expect(report.ambiguous).toBe(0);
    const after = await fillRow(id, SYMBOL, "E-9");
    expect(after.binanceOrderId).toBe(correct.order.id);
    expect(after.tradeExecutionId).toBe(correct.execution.id);
  });
});

describe("a race on attribution cannot move an owner", () => {
  /**
   * A service whose enrichment compare-and-set always reports "matched
   * nothing", as it would for a caller that lost the race.
   *
   * The database is real and so is everything else; only the loser's view of
   * its own update is forced, because whether a genuine parallel run takes the
   * losing branch is a coin toss and the branch has to be proven on every run.
   */
  function losingService(whileUpdating: () => Promise<void> = async () => {}) {
    const client = new Proxy(prisma as object, {
      get(target, property, receiver) {
        if (property !== "exchangeFillLedger") return Reflect.get(target, property, receiver);
        const real = Reflect.get(target, property, receiver) as Record<string, unknown>;
        return new Proxy(real, {
          get(inner, innerProperty, innerReceiver) {
            if (innerProperty !== "updateMany") return Reflect.get(inner, innerProperty, innerReceiver);
            return async () => {
              // The rival commits DURING our update, which is the only window
              // in which our compare-and-set can match nothing: the row was
              // genuinely unowned when we read it.
              await whileUpdating();
              return { count: 0 };
            };
          },
        });
      },
    }) as PrismaClient;
    return new ExchangeFillLedgerService(client);
  }

  /** What a rival caller would have written, applied directly. */
  const claimedBy = async (rowId: string, order: { id: string; tradeExecutionId: string }) => {
    await prisma!.exchangeFillLedger.update({
      where: { id: rowId },
      data: {
        attribution: "OWNED_ORDER",
        binanceOrderId: order.id,
        tradeExecutionId: order.tradeExecutionId,
      },
    });
  };

  const rowOf = async (executionProfileId: string, exchangeTradeId: string) =>
    prisma!.exchangeFillLedger.findFirstOrThrow({ where: { executionProfileId, exchangeTradeId } });

  async function orderFor(executionProfileId: string, exchangeOrderId: string) {
    sequence += 1;
    const execution = await prisma!.tradeExecution.create({
      data: {
        executionProfileId, symbol: SYMBOL, direction: "LONG", positionSide: "LONG",
        selectedLookback: 200, plannedEntryPrice: "1.06", calculatedStopLoss: "1.01",
        executableStopLoss: "1.01", takeProfit: "1.09", riskBudgetUsd: "3", quantityRaw: "68.8",
        plannedQuantity: "68.8", quantityStepSize: "0.1", actualPlannedLoss: "3",
        unusedRiskBudget: "0", positionNotional: "72.9", targetIsolatedMargin: "7.3",
        maximumIsolatedMargin: "10", selectedLeverage: 10, estimatedInitialMargin: "7.3",
        liquidationBufferRatio: "0.5", decisionReasonCode: "SYNTHETIC",
      },
    });
    const order = await prisma!.binanceOrder.create({
      data: {
        tradeExecutionId: execution.id, role: "TAKE_PROFIT", generation: 1,
        clientOrderId: `${TAG}-race-${sequence}`, side: "SELL", positionSide: "LONG",
        orderType: "LIMIT", originalQuantity: "68.8", status: "NEW", exchangeOrderId,
      },
    });
    return { execution, order };
  }

  maybe()("L. two callers enriching to the SAME owner is idempotent", async () => {
    const id = await profile("race-enrich-same");
    const fill = trade({ tradeId: "R-1", orderId: "RACE-SAME", symbol: SYMBOL });
    await ledger.ingestUserTrades(id, [fill]);
    const owner = await orderFor(id, "RACE-SAME");
    const before = await rowOf(id, "R-1");

    const results = await Promise.allSettled([
      ledger.ingestUserTrades(id, [fill]),
      ledger.ingestUserTrades(id, [fill]),
      ledger.ingestUserTrades(id, [fill]),
    ]);

    // Nobody fails, and nobody is told a false conflict.
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const after = await rowOf(id, "R-1");
    expect(after.id).toBe(before.id);
    expect(after.attribution).toBe("OWNED_ORDER");
    expect(after.binanceOrderId).toBe(owner.order.id);
    expect(after.price.toFixed()).toBe(before.price.toFixed());
    expect(
      await prisma!.exchangeFillLedger.count({ where: { executionProfileId: id, exchangeTradeId: "R-1" } })
    ).toBe(1);
  });

  maybe()("L2. a loser that resolved the SAME owner accepts the winner's answer", async () => {
    // Deterministically the losing branch, with the row genuinely unowned when
    // it is read — which is the only way the branch is reachable, because an
    // already-owned row is settled by stickiness long before the update.
    const id = await profile("race-enrich-loser-same");
    const fill = trade({ tradeId: "R-2", orderId: "RACE-LOSER", symbol: SYMBOL });
    await ledger.ingestUserTrades(id, [fill]);
    const owner = await orderFor(id, "RACE-LOSER");
    const row = await rowOf(id, "R-2");
    expect(row.attribution).toBe("UNATTRIBUTED");

    // A rival commits the SAME owner while we update: our compare-and-set
    // matches nothing, and the re-read shows our own conclusion already made.
    const report = await losingService(async () => {
      await claimedBy(row.id, { id: owner.order.id, tradeExecutionId: owner.execution.id });
    }).ingestUserTrades(id, [fill]);

    expect(report.duplicates).toBe(1);
    // No enrichment claimed: this caller did not perform one.
    expect(report.attributionEnriched).toBe(0);
    const after = await rowOf(id, "R-2");
    expect(after.attribution).toBe("OWNED_ORDER");
    expect(after.binanceOrderId).toBe(owner.order.id);
  });

  maybe()("M. a loser that resolved a DIFFERENT owner cannot overwrite the winner", async () => {
    // The row is unowned when we read it and we resolve one candidate; a rival
    // commits a different one mid-update.
    const id = await profile("race-enrich-loser-diff");
    const fill = trade({ tradeId: "R-3", orderId: "RACE-DIFF", symbol: SYMBOL });
    await ledger.ingestUserTrades(id, [fill]);
    const resolvedByUs = await orderFor(id, "RACE-DIFF");
    const rival = await orderFor(id, "RACE-DIFF-RIVAL");
    const row = await rowOf(id, "R-3");
    expect(row.attribution).toBe("UNATTRIBUTED");

    // We resolve our own candidate; the rival commits a DIFFERENT one while we
    // update. Ownership must not change hands.
    await expect(
      losingService(async () => {
        await claimedBy(row.id, { id: rival.order.id, tradeExecutionId: rival.execution.id });
      }).ingestUserTrades(id, [fill])
    ).rejects.toBeInstanceOf(FillLedgerAttributionConflictError);

    // The rival's answer stands; ours was refused, not applied.
    const after = await rowOf(id, "R-3");
    expect(after.attribution).toBe("OWNED_ORDER");
    expect(after.binanceOrderId).toBe(rival.order.id);
    expect(after.binanceOrderId).not.toBe(resolvedByUs.order.id);
    expect(after.price.toFixed()).toBe(row.price.toFixed());
    expect(after.id).toBe(row.id);
  });

  maybe()("the compare-and-set itself refuses a row claimed since it was read", async () => {
    // The real guard, not a simulated one. `updateMany` here is the actual
    // Prisma call: a rival commits between our read and our write, and the
    // WHERE clause carrying the full prior state is the only thing that stops
    // us overwriting them. Without it this update matches by id and silently
    // moves the fill to our candidate.
    const id = await profile("race-enrich-cas");
    const fill = trade({ tradeId: "R-5", orderId: "CAS-ORD", symbol: SYMBOL });
    await ledger.ingestUserTrades(id, [fill]);
    const ours = await orderFor(id, "CAS-ORD");
    const rival = await orderFor(id, "CAS-RIVAL");
    const row = await rowOf(id, "R-5");
    expect(row.attribution).toBe("UNATTRIBUTED");

    // Hands back the genuinely unowned row, then lets the rival commit — so
    // the service proceeds to a real update against a row that has changed.
    let claimed = false;
    const client = new Proxy(prisma as object, {
      get(target, property, receiver) {
        if (property !== "exchangeFillLedger") return Reflect.get(target, property, receiver);
        const real = Reflect.get(target, property, receiver) as Record<string, unknown>;
        return new Proxy(real, {
          get(inner, innerProperty, innerReceiver) {
            const original = Reflect.get(inner, innerProperty, innerReceiver) as CallableFunction;
            if (innerProperty !== "findUnique") return original;
            return async (...args: unknown[]) => {
              const found = await original.apply(inner, args);
              if (!claimed) {
                claimed = true;
                await claimedBy(row.id, { id: rival.order.id, tradeExecutionId: rival.execution.id });
              }
              return found;
            };
          },
        });
      },
    }) as PrismaClient;

    await expect(
      new ExchangeFillLedgerService(client).ingestUserTrades(id, [fill])
    ).rejects.toBeInstanceOf(FillLedgerAttributionConflictError);

    const after = await rowOf(id, "R-5");
    expect(after.attribution).toBe("OWNED_ORDER");
    expect(after.binanceOrderId).toBe(rival.order.id);
    expect(after.binanceOrderId).not.toBe(ours.order.id);
  });

  maybe()("a compare-and-set that matches nothing while still unowned fails explicitly", async () => {
    // Not reachable in ordinary operation, so it must say so rather than
    // reporting an enrichment that never happened.
    const id = await profile("race-enrich-impossible");
    const fill = trade({ tradeId: "R-4", orderId: "RACE-IMPOSSIBLE", symbol: SYMBOL });
    await ledger.ingestUserTrades(id, [fill]);
    await orderFor(id, "RACE-IMPOSSIBLE");

    await expect(losingService().ingestUserTrades(id, [fill])).rejects.toBeInstanceOf(
      FillLedgerRaceUnresolvedError
    );

    expect((await rowOf(id, "R-4")).attribution).toBe("UNATTRIBUTED");
  });
});

describe("the numbers survive exactly", () => {
  maybe()("L. high-precision decimals round-trip character for character", async () => {
    const id = await profile("precision");
    await ledger.ingestUserTrades(id, [
      trade({
        tradeId: "800",
        quantity: "0.000000000000000001",
        price: "123456.789012345678",
        quoteQuantity: "0.000000000001",
        commission: "0.000000012345",
      }),
    ]);

    const [row] = await fillsFor(id);
    // toFixed, not toString: Decimal renders a very small number in
    // exponential form, which is a formatting choice. What matters is that
    // every digit survived the round trip, so the expansion is what is
    // compared.
    expect(row.quantity.toFixed()).toBe("0.000000000000000001");
    expect(row.price.toFixed()).toBe("123456.789012345678");
    expect(row.quoteQuantity!.toFixed()).toBe("0.000000000001");
    expect(row.commission!.toFixed()).toBe("0.000000012345");
  });

  maybe()("M. a losing fill keeps its sign", async () => {
    const id = await profile("negative");
    await ledger.ingestUserTrades(id, [trade({ tradeId: "801", realizedPnl: "-0.91539999" })]);

    const [row] = await fillsFor(id);
    expect(row.realizedPnl!.toString()).toBe("-0.91539999");
    expect(row.realizedPnl!.isNegative()).toBe(true);
  });

  maybe()("N. a BNB commission is kept as BNB, never converted", async () => {
    const id = await profile("bnb");
    await ledger.ingestUserTrades(id, [
      trade({ tradeId: "802", commission: "0.0012", commissionAsset: "BNB" }),
    ]);

    const [row] = await fillsFor(id);
    expect(row.commission!.toString()).toBe("0.0012");
    expect(row.commissionAsset).toBe("BNB");
  });

  maybe()("an absent commission or realized result stays UNKNOWN, not zero", async () => {
    const id = await profile("absent");
    await ledger.ingestUserTrades(id, [
      trade({ tradeId: "803", commission: null, commissionAsset: null, realizedPnl: null, quoteQuantity: null }),
    ]);

    const [row] = await fillsFor(id);
    expect(row.commission).toBeNull();
    expect(row.commissionAsset).toBeNull();
    expect(row.realizedPnl).toBeNull();
    expect(row.quoteQuantity).toBeNull();
  });

  maybe()("a trade missing an identity or a fact it needs is skipped, never defaulted", async () => {
    const id = await profile("incomplete");

    const report = await ledger.ingestUserTrades(id, [
      trade({ tradeId: null }),
      trade({ tradeId: "900", symbol: null }),
      trade({ tradeId: "901", quantity: null }),
      trade({ tradeId: "902", price: null }),
      trade({ tradeId: "903", side: "SIDEWAYS" }),
      trade({ tradeId: "904", timeMs: null }),
    ]);

    expect(report.skipped).toBe(6);
    expect(report.inserted).toBe(0);
    expect(report.skippedReasons).toHaveLength(6);
    expect(await fillsFor(id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The contract the ledger reads from
// ---------------------------------------------------------------------------

describe("A/P. the normalized user trade", () => {
  /** One row exactly as Binance documents GET /fapi/v1/userTrades. */
  const raw = {
    buyer: false,
    commission: "-0.07819010",
    commissionAsset: "USDT",
    id: 698759,
    maker: false,
    orderId: 25851813,
    price: "7819.01",
    qty: "0.002",
    quoteQty: "15.63802",
    realizedPnl: "-0.91539999",
    side: "SELL",
    positionSide: "SHORT",
    symbol: "BTCUSDT",
    time: 1569514978020,
  };

  it("carries every accounting fact the exchange sent, byte-exact", () => {
    const [row] = normalizeUserTrades([raw]);

    expect(row.tradeId).toBe("698759");
    expect(row.orderId).toBe("25851813");
    expect(row.symbol).toBe("BTCUSDT");
    expect(row.side).toBe("SELL");
    expect(row.positionSide).toBe("SHORT");
    expect(row.quantity).toBe("0.002");
    expect(row.price).toBe("7819.01");
    expect(row.quoteQuantity).toBe("15.63802");
    // Both legitimately negative, and neither rounded on the way through.
    expect(row.realizedPnl).toBe("-0.91539999");
    expect(row.commission).toBe("-0.07819010");
    expect(row.commissionAsset).toBe("USDT");
    expect(row.maker).toBe(false);
    expect(row.timeMs).toBe(1569514978020);
  });

  it("an absent accounting field is UNKNOWN, never zero", () => {
    // A missing commission is not a free trade and a missing realized result is
    // not a break-even one. Both have to stay distinguishable from a real 0.
    const [row] = normalizeUserTrades([
      { id: 1, orderId: 2, symbol: "X", side: "BUY", positionSide: "LONG", qty: "1", price: "2", time: 3 },
    ]);

    expect(row.quoteQuantity).toBeNull();
    expect(row.realizedPnl).toBeNull();
    expect(row.commission).toBeNull();
    expect(row.commissionAsset).toBeNull();
    expect(row.maker).toBeNull();
  });

  it("a real zero stays a zero", () => {
    const [row] = normalizeUserTrades([{ ...raw, realizedPnl: "0", commission: "0" }]);

    expect(row.realizedPnl).toBe("0");
    expect(row.commission).toBe("0");
  });

  it("P. the fields the entry-recovery absence proof reads are unchanged", () => {
    // Its question is only "did anything trade?", and it must keep answering
    // exactly as before: this widening is additive.
    const [row] = normalizeUserTrades([raw]);

    expect(row.tradeId).toBe("698759");
    expect(row.orderId).toBe("25851813");
    expect(row.quantity).toBe("0.002");
    expect(row.price).toBe("7819.01");
    expect(row.timeMs).toBe(1569514978020);
    expect(normalizeUserTrades("not-a-list")).toEqual([]);
  });
});
