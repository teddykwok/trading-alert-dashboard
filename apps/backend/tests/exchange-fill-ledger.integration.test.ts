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
  FillLedgerInsertRaceError,
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
            // The batch PRE-READ is what decides known from new, so that is
            // what has to be blinded now.
            if (innerProperty !== "findMany") return Reflect.get(inner, innerProperty, innerReceiver);
            return async (...args: unknown[]) => {
              if (!blinded) {
                blinded = true;
                return [];
              }
              return (Reflect.get(inner, innerProperty, innerReceiver) as CallableFunction).apply(inner, args);
            };
          },
        });
      },
    }) as PrismaClient;
    return new ExchangeFillLedgerService(client);
  }

  maybe()("A. an identical fill losing the insert race fails the WHOLE call", async () => {
    // Doctrine change, deliberate. Recovering per row used to mean catching the
    // violation and re-reading the winner -- which a caller inside a
    // transaction cannot do, because the violation has already aborted it and
    // the re-read would fail with 25P02. So the call claims nothing instead.
    const id = await profile("race-identical");
    await ledger.ingestUserTrades(id, [trade({ tradeId: "9001", orderId: "R1" })]);
    const [winner] = await fillsFor(id);

    const raced = await blindedService()
      .ingestUserTrades(id, [trade({ tradeId: "9001", orderId: "R1" })])
      .then(() => null)
      .catch((thrown) => thrown);

    expect(raced).toBeInstanceOf(FillLedgerInsertRaceError);
    expect(raced.reasonCode).toBe("FILL_LEDGER_INSERT_RACE");
    // Retryable: this is contention, not contradiction.
    expect(raced.retryable).toBe(true);

    // Nothing was written and the winner is untouched.
    const rows = await fillsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(winner.id);
    expect(rows[0].ingestedAt.getTime()).toBe(winner.ingestedAt.getTime());
  });

  maybe()("A2. and the REPLAY converges on a duplicate", async () => {
    // The other half of the doctrine: the retry's pre-read sees the winner and
    // takes the ordinary path, where the economics ARE compared. Each replay
    // finds strictly more rows already durable, so this terminates.
    const id = await profile("race-identical-replay");
    const fill = [trade({ tradeId: "9101", orderId: "R11" })];
    await ledger.ingestUserTrades(id, fill);
    const [winner] = await fillsFor(id);

    await expect(blindedService().ingestUserTrades(id, fill)).rejects.toBeInstanceOf(
      FillLedgerInsertRaceError
    );

    const replay = await ledger.ingestUserTrades(id, fill);

    expect(replay.inserted).toBe(0);
    expect(replay.duplicates).toBe(1);
    const rows = await fillsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(winner.id);
  });

  maybe()("B. a CONFLICTING fill losing the race is never absorbed", async () => {
    // The guarantee is unchanged: contradictory economics arriving a
    // millisecond late are never reported as success. Only WHERE it surfaces
    // moved -- the losing call refuses to claim anything, and the replay does
    // the comparison it could not do inside an aborted transaction.
    const id = await profile("race-conflict");
    await ledger.ingestUserTrades(id, [
      trade({ tradeId: "9002", orderId: "R2", quantity: "1", price: "100", realizedPnl: "1" }),
    ]);
    const [winner] = await fillsFor(id);
    const contradiction = [
      trade({ tradeId: "9002", orderId: "R2", quantity: "1", price: "101", realizedPnl: "2" }),
    ];

    await expect(blindedService().ingestUserTrades(id, contradiction)).rejects.toBeInstanceOf(
      FillLedgerInsertRaceError
    );

    // Nothing absorbed, nothing overwritten.
    let rows = await fillsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].price.toString()).toBe("100");

    // And the replay names it for what it is.
    await expect(ledger.ingestUserTrades(id, contradiction)).rejects.toBeInstanceOf(
      FillLedgerConflictError
    );

    rows = await fillsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(winner.id);
    expect(rows[0].price.toString()).toBe("100");
    expect(rows[0].realizedPnl!.toString()).toBe("1");
  });

  maybe()("genuinely parallel identical ingestion still leaves exactly one row", async () => {
    // Real concurrency, non-deterministic by nature. Whichever interleaving
    // occurs: one insert, one row, and any loser fails RETRYABLY rather than
    // claiming something it did not write.
    const id = await profile("race-parallel");
    const fill = [trade({ tradeId: "9003", orderId: "R3" })];

    const results = await Promise.allSettled([
      ledger.ingestUserTrades(id, fill),
      ledger.ingestUserTrades(id, fill),
      ledger.ingestUserTrades(id, fill),
    ]);

    const inserted = results.reduce(
      (total, result) => total + (result.status === "fulfilled" ? result.value.inserted : 0),
      0
    );
    expect(inserted).toBe(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(FillLedgerInsertRaceError);
      }
    }
    expect(await fillsFor(id)).toHaveLength(1);

    // A replay after the dust settles reports the truth for every caller.
    const replay = await ledger.ingestUserTrades(id, fill);
    expect(replay.inserted).toBe(0);
    expect(replay.duplicates).toBe(1);
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
            // The batch pre-read is the moment the row is seen unowned.
            if (innerProperty !== "findMany") return original;
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

// ---------------------------------------------------------------------------
// O. raw exchange row -> normalizer -> ledger, for the side that was never sent
// ---------------------------------------------------------------------------

describe("O. an unreadable positionSide never reaches the ledger as a fill", () => {
  /** One documented row, with only its position side made unreadable. */
  const rawWith = (positionSide: unknown) => ({
    id: 990001,
    orderId: 25851813,
    symbol: SYMBOL,
    side: "SELL",
    positionSide,
    qty: "0.002",
    price: "7819.01",
    quoteQty: "15.63802",
    realizedPnl: "-0.91539999",
    commission: "-0.07819010",
    commissionAsset: "USDT",
    maker: false,
    time: 1_757_000_000_000,
  });

  maybe()("a garbage side normalizes to null and the ledger refuses the row", async () => {
    // The defect this closes end to end: "garbage" used to become "BOTH",
    // which is a value ExecutionPositionSide accepts, so the fill was INSERTED
    // carrying a side the exchange never reported.
    const id = await profile("unreadable-side");
    const [normalized] = normalizeUserTrades([rawWith("garbage")]);

    expect(normalized.positionSide).toBeNull();

    const report = await ledger.ingestUserTrades(id, [normalized]);

    expect(report.skipped).toBe(1);
    expect(report.inserted).toBe(0);
    expect(report.skippedReasons).toEqual([`trade 990001: missing positionSide`]);
    // The load-bearing half: no durable row at all.
    expect(await fillsFor(id)).toEqual([]);
  });

  maybe()("a wrong-typed side is refused the same way", async () => {
    const id = await profile("wrong-typed-side");
    const [normalized] = normalizeUserTrades([rawWith({ side: "LONG" })]);

    expect(normalized.positionSide).toBeNull();
    expect((await ledger.ingestUserTrades(id, [normalized])).inserted).toBe(0);
    expect(await fillsFor(id)).toEqual([]);
  });

  maybe()("a GENUINE BOTH is still a real fill and is recorded", async () => {
    // Proof the fix narrows which values are recognised, not which fills are
    // accepted. ONE-WAY mode reports BOTH and that row must survive.
    const id = await profile("genuine-both");
    const [normalized] = normalizeUserTrades([rawWith("BOTH")]);

    expect(normalized.positionSide).toBe("BOTH");

    const report = await ledger.ingestUserTrades(id, [normalized]);

    expect(report.inserted).toBe(1);
    expect(report.skipped).toBe(0);
    const [row] = await fillsFor(id);
    expect(row.positionSide).toBe("BOTH");
    expect(row.exchangeTradeId).toBe("990001");
  });

  maybe()("LONG and SHORT are unaffected", async () => {
    const id = await profile("known-sides");
    const rows = normalizeUserTrades([
      { ...rawWith("LONG"), id: 990002 },
      { ...rawWith("SHORT"), id: 990003 },
    ]);

    expect(rows.map((row) => row.positionSide)).toEqual(["LONG", "SHORT"]);
    expect((await ledger.ingestUserTrades(id, rows)).inserted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// M/N. a fabricated exchange identity never reaches the ledger
// ---------------------------------------------------------------------------

describe("M/N. exchange identities are validated before the ledger sees them", () => {
  /** One documented row; only its identities are varied. */
  const rawIds = (id: unknown, orderId: unknown) => ({
    id,
    orderId,
    symbol: SYMBOL,
    side: "SELL",
    positionSide: "SHORT",
    qty: "0.002",
    price: "7819.01",
    quoteQty: "15.63802",
    realizedPnl: "-0.91539999",
    commission: "-0.07819010",
    commissionAsset: "USDT",
    maker: false,
    time: 1_757_000_000_000,
  });

  maybe()("M. an object trade id normalizes to null and the fill is refused", async () => {
    // `String({})` is "[object Object]" -- a perfectly storable string that
    // would have become the unique key of a real economic row.
    const id = await profile("object-trade-id");
    const [normalized] = normalizeUserTrades([rawIds({}, 77001)]);

    expect(normalized.tradeId).toBeNull();

    const report = await ledger.ingestUserTrades(id, [normalized]);

    expect(report.skipped).toBe(1);
    expect(report.inserted).toBe(0);
    expect(report.skippedReasons).toEqual(["missing tradeId"]);
    expect(await fillsFor(id)).toEqual([]);
  });

  maybe()("M. an array, a boolean and an imprecise number are refused the same way", async () => {
    const id = await profile("unusable-trade-ids");
    const rows = normalizeUserTrades([
      rawIds([], 1), rawIds([7], 1), rawIds(true, 1), rawIds(9007199254740993, 1), rawIds("garbage", 1),
    ]);

    expect(rows.map((row) => row.tradeId)).toEqual([null, null, null, null, null]);

    const report = await ledger.ingestUserTrades(id, rows);

    expect(report.skipped).toBe(5);
    expect(report.inserted).toBe(0);
    expect(await fillsFor(id)).toEqual([]);
  });

  maybe()("N. an unusable ORDER id does not make a real fill unrepresentable", async () => {
    // The existing ledger doctrine: orderId is not required. A fill nobody can
    // attribute is still a fill, and it stays recorded as UNATTRIBUTED.
    const id = await profile("object-order-id");
    const [normalized] = normalizeUserTrades([rawIds(990101, {})]);

    expect(normalized.tradeId).toBe("990101");
    expect(normalized.orderId).toBeNull();

    const report = await ledger.ingestUserTrades(id, [normalized]);

    expect(report.inserted).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.unattributed).toBe(1);

    const [row] = await fillsFor(id);
    expect(row.exchangeTradeId).toBe("990101");
    // The load-bearing half: no fabricated order identity is stored.
    expect(row.exchangeOrderId).toBeNull();
    expect(row.attribution).toBe("UNATTRIBUTED");
    expect(row.binanceOrderId).toBeNull();
    // And the economics survived intact.
    expect(row.quantity.toFixed(3)).toBe("0.002");
    expect(row.price.toFixed(2)).toBe("7819.01");
  });

  maybe()("a 19-digit trade id is stored with every digit intact", async () => {
    const id = await profile("huge-trade-id");
    const huge = "9007199254740993";
    const [normalized] = normalizeUserTrades([rawIds(huge, "25851813")]);

    expect(normalized.tradeId).toBe(huge);

    expect((await ledger.ingestUserTrades(id, [normalized])).inserted).toBe(1);
    const [row] = await fillsFor(id);
    expect(row.exchangeTradeId).toBe(huge);
    expect(row.exchangeOrderId).toBe("25851813");
  });
});

// ===========================================================================
// The batched, transaction-aware ingestion path
// ===========================================================================
//
// One exchange page must be able to land in the SAME transaction as the durable
// record that says the page was seen, and it must survive a page that repeats
// or contradicts itself without either fabricating a winner or livelocking.

/** A second symbol, so batch scoping can be proven rather than assumed. */
const SECOND_SYMBOL = "LEDGERBTCUSDT";

/** An owned execution + order on ANY profile and symbol. */
async function orderOn(
  executionProfileId: string,
  symbol: string,
  ids: { exchangeOrderId?: string; actualOrderId?: string }
) {
  sequence += 1;
  const execution = await prisma!.tradeExecution.create({
    data: {
      executionProfileId, symbol, direction: "LONG", positionSide: "LONG",
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
      clientOrderId: `${TAG}-batch-${sequence}`, side: "SELL", positionSide: "LONG",
      orderType: "LIMIT", originalQuantity: "68.8", status: "NEW",
      exchangeOrderId: ids.exchangeOrderId ?? null,
      actualOrderId: ids.actualOrderId ?? null,
    },
  });
  return { execution, order };
}

/** One durable fill by its natural identity. */
const rowFor = async (executionProfileId: string, exchangeTradeId: string) =>
  prisma!.exchangeFillLedger.findFirstOrThrow({ where: { executionProfileId, exchangeTradeId } });

// ---------------------------------------------------------------------------
// The caller owns the transaction
// ---------------------------------------------------------------------------

describe("ingestion can be a statement in the caller's transaction", () => {
  maybe()("commits with the caller", async () => {
    const id = await profile("tx-commit");

    const report = await prisma!.$transaction((tx) =>
      ledger.ingestUserTradesInTransaction(tx, id, [trade({ tradeId: "TX-1" })])
    );

    expect(report.inserted).toBe(1);
    expect(await fillsFor(id)).toHaveLength(1);
  });

  maybe()("rolls back with the caller, leaving no fill behind", async () => {
    // The property the whole refactor exists for. If the work the caller does
    // AFTER ingestion fails, the page must not stay recorded on its own -- an
    // interval marked processed with none of its fills is a silent hole.
    const id = await profile("tx-rollback");

    await expect(
      prisma!.$transaction(async (tx) => {
        await ledger.ingestUserTradesInTransaction(tx, id, [
          trade({ tradeId: "TX-2" }),
          trade({ tradeId: "TX-3" }),
        ]);
        throw new Error("the caller's own work failed after ingestion");
      })
    ).rejects.toThrow(/the caller's own work failed/);

    expect(await fillsFor(id)).toEqual([]);
  });

  maybe()("an enrichment inside the transaction rolls back too", async () => {
    const id = await profile("tx-rollback-enrich");
    const fill = trade({ tradeId: "TX-4", orderId: "TX-ORD" });
    await ledger.ingestUserTrades(id, [fill]);
    await orderOn(id, SYMBOL, { exchangeOrderId: "TX-ORD" });
    expect((await rowFor(id, "TX-4")).attribution).toBe("UNATTRIBUTED");

    await expect(
      prisma!.$transaction(async (tx) => {
        const report = await ledger.ingestUserTradesInTransaction(tx, id, [fill]);
        expect(report.attributionEnriched).toBe(1);
        throw new Error("rolled back after enriching");
      })
    ).rejects.toThrow(/rolled back after enriching/);

    // The owner was learned and then un-learned, exactly as the caller decided.
    expect((await rowFor(id, "TX-4")).attribution).toBe("UNATTRIBUTED");
  });

  maybe()("the pooled path is unchanged and commits on its own", async () => {
    const id = await profile("tx-pooled");

    const report = await ledger.ingestUserTrades(id, [trade({ tradeId: "TX-5" })]);

    expect(report.inserted).toBe(1);
    expect(await fillsFor(id)).toHaveLength(1);
  });

  maybe()("a conflict inside the transaction leaves the caller's other work rolled back", async () => {
    const id = await profile("tx-conflict");
    await ledger.ingestUserTrades(id, [trade({ tradeId: "TX-6", price: "100" })]);

    await expect(
      prisma!.$transaction(async (tx) => {
        await tx.exchangeFillLedger.create({
          data: {
            executionProfileId: id, symbol: SYMBOL, exchangeTradeId: "TX-7",
            side: "SELL", positionSide: "LONG", quantity: "1", price: "5",
            tradeTime: new Date(1_757_000_000_000),
          },
        });
        return ledger.ingestUserTradesInTransaction(tx, id, [trade({ tradeId: "TX-6", price: "101" })]);
      })
    ).rejects.toBeInstanceOf(FillLedgerConflictError);

    // Neither the caller's row nor anything else survived.
    const rows = await fillsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].exchangeTradeId).toBe("TX-6");
    expect(rows[0].price.toString()).toBe("100");
  });
});

// ---------------------------------------------------------------------------
// One page that contradicts or repeats itself
// ---------------------------------------------------------------------------

describe("same-page natural identities are canonicalized before any insert", () => {
  maybe()("the same fill twice in one page is one row and one duplicate", async () => {
    // The livelock this closes: two rows with one natural key in a single
    // insert hit the unique constraint with NO concurrent writer, and every
    // replay reproduces the identical page, so the work would burn its whole
    // attempt budget and be abandoned.
    const id = await profile("same-page-identical");

    const report = await ledger.ingestUserTrades(id, [
      trade({ tradeId: "SP-1", orderId: "SP-A" }),
      trade({ tradeId: "SP-1", orderId: "SP-A" }),
    ]);

    expect(report.inserted).toBe(1);
    expect(report.duplicates).toBe(1);
    expect(report.skipped).toBe(0);
    expect(await fillsFor(id)).toHaveLength(1);
  });

  maybe()("three occurrences are one row and two duplicates", async () => {
    const id = await profile("same-page-three");

    const report = await ledger.ingestUserTrades(id, [
      trade({ tradeId: "SP-2" }),
      trade({ tradeId: "SP-2" }),
      trade({ tradeId: "SP-2" }),
    ]);

    expect(report.inserted).toBe(1);
    expect(report.duplicates).toBe(2);
    expect(report.inserted + report.duplicates + report.skipped).toBe(3);
    expect(await fillsFor(id)).toHaveLength(1);
  });

  maybe()("contradictory occurrences of one identity are a conflict, before anything is written", async () => {
    const id = await profile("same-page-conflict");

    await expect(
      ledger.ingestUserTrades(id, [
        trade({ tradeId: "SP-3", price: "100" }),
        trade({ tradeId: "SP-4" }),
        trade({ tradeId: "SP-3", price: "101" }),
      ])
    ).rejects.toBeInstanceOf(FillLedgerConflictError);

    // Not even the unrelated, perfectly good fill in the same page.
    expect(await fillsFor(id)).toEqual([]);
  });

  maybe()("a same-page conflict names the fields that disagree", async () => {
    const id = await profile("same-page-conflict-fields");

    const thrown = await ledger
      .ingestUserTrades(id, [
        trade({ tradeId: "SP-5", price: "100", realizedPnl: "1" }),
        trade({ tradeId: "SP-5", price: "101", realizedPnl: "2" }),
      ])
      .then(() => null)
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(FillLedgerConflictError);
    expect(thrown.reasonCode).toBe("FILL_LEDGER_IDENTITY_CONFLICT");
    expect(thrown.differing).toEqual(expect.arrayContaining(["price", "realizedPnl"]));
  });

  maybe()("the same decimal written differently is not a same-page conflict", async () => {
    const id = await profile("same-page-decimal");

    const report = await ledger.ingestUserTrades(id, [
      trade({ tradeId: "SP-6", quantity: "68.8", price: "1.0925" }),
      trade({ tradeId: "SP-6", quantity: "68.80", price: "1.09250" }),
    ]);

    expect(report.inserted).toBe(1);
    expect(report.duplicates).toBe(1);
  });

  maybe()("an unrepresentable occurrence is skipped, never grouped", async () => {
    // A row with no trade id has no identity to group BY, so it is classified
    // first and takes no part in canonicalization. Conservation still holds.
    const id = await profile("same-page-skip");

    const report = await ledger.ingestUserTrades(id, [
      trade({ tradeId: "SP-7" }),
      trade({ tradeId: null }),
      trade({ tradeId: "SP-7" }),
      trade({ tradeId: "SP-8", quantity: null }),
    ]);

    expect(report.inserted).toBe(1);
    expect(report.duplicates).toBe(1);
    expect(report.skipped).toBe(2);
    expect(report.inserted + report.duplicates + report.skipped).toBe(4);
    expect(await fillsFor(id)).toHaveLength(1);
  });

  maybe()("the same trade id on DIFFERENT symbols is not a same-page duplicate", async () => {
    // Identity is (account, symbol, trade id). Grouping on the trade id alone
    // would collapse two genuinely different fills into one.
    const id = await profile("same-page-symbols");

    const report = await ledger.ingestUserTrades(id, [
      trade({ tradeId: "SP-9", symbol: SYMBOL }),
      trade({ tradeId: "SP-9", symbol: SECOND_SYMBOL }),
    ]);

    expect(report.inserted).toBe(2);
    expect(report.duplicates).toBe(0);
    const rows = await fillsFor(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.symbol).sort()).toEqual([SECOND_SYMBOL, SYMBOL].sort());
  });
});

// ---------------------------------------------------------------------------
// One page, many symbols
// ---------------------------------------------------------------------------

describe("mixed-symbol batches keep every boundary", () => {
  maybe()("one call may carry several symbols, as it always could", async () => {
    const id = await profile("mixed-symbols");

    const report = await ledger.ingestUserTrades(id, [
      trade({ tradeId: "MS-1", symbol: SYMBOL }),
      trade({ tradeId: "MS-2", symbol: SECOND_SYMBOL }),
      trade({ tradeId: "MS-3", symbol: SYMBOL }),
    ]);

    expect(report.inserted).toBe(3);
    expect(await fillsFor(id)).toHaveLength(3);
  });

  maybe()("the pre-read never matches a trade id across symbols", async () => {
    // A global `exchangeTradeId IN (...)` would find the first symbol's row and
    // route a genuinely NEW fill into the replay path -- where its economics
    // would be compared against an unrelated trade and reported as a conflict.
    const id = await profile("mixed-symbol-preread");
    await ledger.ingestUserTrades(id, [
      trade({ tradeId: "MS-4", symbol: SYMBOL, price: "100", quantity: "1" }),
    ]);

    const report = await ledger.ingestUserTrades(id, [
      trade({ tradeId: "MS-4", symbol: SECOND_SYMBOL, price: "7", quantity: "3" }),
    ]);

    expect(report.inserted).toBe(1);
    expect(report.duplicates).toBe(0);
    const rows = await fillsFor(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => `${row.symbol}:${row.price.toString()}`).sort()).toEqual(
      [`${SYMBOL}:100`, `${SECOND_SYMBOL}:7`].sort()
    );
  });

  maybe()("a replay of a mixed page is a duplicate on every symbol", async () => {
    const id = await profile("mixed-symbol-replay");
    const page = [
      trade({ tradeId: "MS-5", symbol: SYMBOL }),
      trade({ tradeId: "MS-5", symbol: SECOND_SYMBOL }),
    ];
    await ledger.ingestUserTrades(id, page);

    const replay = await ledger.ingestUserTrades(id, page);

    expect(replay.inserted).toBe(0);
    expect(replay.duplicates).toBe(2);
    expect(await fillsFor(id)).toHaveLength(2);
  });

  maybe()("every durable pre-read is scoped by account AND symbol, never a global id list", async () => {
    // Structural, because the requirement is structural. Behaviourally the
    // composite lookup key already carries the row's own symbol, so a global
    // `exchangeTradeId IN (...)` would still produce the right answer -- while
    // reading another symbol's rows to do it, and leaving the correctness of
    // the whole pre-read resting on one downstream map key instead of on the
    // query. The scope is asserted here so it cannot be dropped silently.
    const id = await profile("preread-scope");
    const seen: Array<Record<string, unknown>> = [];
    const client = new Proxy(prisma as object, {
      get(target, property, receiver) {
        if (property !== "exchangeFillLedger") return Reflect.get(target, property, receiver);
        const real = Reflect.get(target, property, receiver) as Record<string, unknown>;
        return new Proxy(real, {
          get(inner, innerProperty, innerReceiver) {
            const original = Reflect.get(inner, innerProperty, innerReceiver) as CallableFunction;
            if (innerProperty !== "findMany") return original;
            return async (...args: unknown[]) => {
              seen.push(((args[0] ?? {}) as { where?: Record<string, unknown> }).where ?? {});
              return original.apply(inner, args);
            };
          },
        });
      },
    }) as PrismaClient;

    await new ExchangeFillLedgerService(client).ingestUserTrades(id, [
      trade({ tradeId: "PS-1", symbol: SYMBOL }),
      trade({ tradeId: "PS-2", symbol: SYMBOL }),
      trade({ tradeId: "PS-3", symbol: SECOND_SYMBOL }),
    ]);

    // One query per symbol, each naming its own account and symbol.
    expect(seen).toHaveLength(2);
    const bySymbol = new Map(seen.map((where) => [where.symbol as string, where]));
    expect([...bySymbol.keys()].sort()).toEqual([SECOND_SYMBOL, SYMBOL].sort());

    for (const [symbol, where] of bySymbol) {
      expect(where.executionProfileId).toBe(id);
      expect(typeof where.symbol).toBe("string");
      const ids = (where.exchangeTradeId as { in: string[] }).in;
      // And the id list belongs to THAT symbol only.
      expect(ids.sort()).toEqual(symbol === SYMBOL ? ["PS-1", "PS-2"] : ["PS-3"]);
    }
  });

  maybe()("attribution still refuses to cross a symbol, in a batch", async () => {
    const id = await profile("mixed-symbol-attribution");
    const owner = await orderOn(id, SYMBOL, { exchangeOrderId: "MS-ORD" });

    const report = await ledger.ingestUserTrades(id, [
      trade({ tradeId: "MS-6", symbol: SYMBOL, orderId: "MS-ORD" }),
      trade({ tradeId: "MS-7", symbol: SECOND_SYMBOL, orderId: "MS-ORD" }),
    ]);

    expect(report.inserted).toBe(2);
    expect(report.unattributed).toBe(1);
    const rows = await fillsFor(id);
    const owned = rows.find((row) => row.exchangeTradeId === "MS-6")!;
    const other = rows.find((row) => row.exchangeTradeId === "MS-7")!;
    // The owner's execution is on SYMBOL, so only that fill may claim it.
    expect(owned.attribution).toBe("OWNED_ORDER");
    expect(owned.binanceOrderId).toBe(owner.order.id);
    expect(other.attribution).toBe("UNATTRIBUTED");
    expect(other.binanceOrderId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Attribution is resolved once for the batch
// ---------------------------------------------------------------------------

describe("batched attribution keeps the single-fill semantics exactly", () => {
  /** Counts how many times the owned-order lookup is issued. */
  function countingService() {
    let lookups = 0;
    const client = new Proxy(prisma as object, {
      get(target, property, receiver) {
        if (property !== "binanceOrder") return Reflect.get(target, property, receiver);
        const real = Reflect.get(target, property, receiver) as Record<string, unknown>;
        return new Proxy(real, {
          get(inner, innerProperty, innerReceiver) {
            const original = Reflect.get(inner, innerProperty, innerReceiver) as CallableFunction;
            if (innerProperty !== "findMany") return original;
            return async (...args: unknown[]) => {
              lookups += 1;
              return original.apply(inner, args);
            };
          },
        });
      },
    }) as PrismaClient;
    return { service: new ExchangeFillLedgerService(client), lookups: () => lookups };
  }

  maybe()("a page of many fills issues ONE lookup per symbol, not one per fill", async () => {
    // A replayed window of a thousand known trades used to issue a thousand
    // lookups. Inside a caller's transaction that is a thousand round trips
    // holding it open.
    const id = await profile("batch-attribution-count");
    const { service, lookups } = countingService();
    const page = Array.from({ length: 25 }, (_, index) =>
      trade({ tradeId: `BA-${index}`, orderId: `BA-ORD-${index}`, symbol: SYMBOL })
    );

    const report = await service.ingestUserTrades(id, page);

    expect(report.inserted).toBe(25);
    expect(lookups()).toBe(1);
  });

  maybe()("two symbols in one page are two lookups, one per boundary", async () => {
    const id = await profile("batch-attribution-symbols");
    const { service, lookups } = countingService();

    await service.ingestUserTrades(id, [
      trade({ tradeId: "BA-S1", orderId: "BA-S", symbol: SYMBOL }),
      trade({ tradeId: "BA-S2", orderId: "BA-S", symbol: SECOND_SYMBOL }),
    ]);

    expect(lookups()).toBe(2);
  });

  maybe()("fills with no order id issue no lookup at all", async () => {
    const id = await profile("batch-attribution-none");
    const { service, lookups } = countingService();

    const report = await service.ingestUserTrades(id, [
      trade({ tradeId: "BA-N1", orderId: null }),
      trade({ tradeId: "BA-N2", orderId: "   " }),
    ]);

    expect(report.inserted).toBe(2);
    expect(report.unattributed).toBe(2);
    expect(lookups()).toBe(0);
  });

  maybe()("ambiguity is decided PER ORDER ID inside one batch", async () => {
    // The property a naive batch lookup destroys: sharing one query across ids
    // and asking "did we get more than one row?" would make an unambiguous
    // fill ambiguous just because a different id in the same page was.
    const id = await profile("batch-ambiguity");
    await orderOn(id, SYMBOL, { exchangeOrderId: "BA-DUP" });
    await orderOn(id, SYMBOL, { exchangeOrderId: "BA-DUP" });
    const clean = await orderOn(id, SYMBOL, { exchangeOrderId: "BA-CLEAN" });

    const report = await ledger.ingestUserTrades(id, [
      trade({ tradeId: "BA-A1", orderId: "BA-DUP" }),
      trade({ tradeId: "BA-A2", orderId: "BA-CLEAN" }),
      trade({ tradeId: "BA-A3", orderId: "BA-NOBODY" }),
    ]);

    expect(report.inserted).toBe(3);
    expect(report.ambiguous).toBe(1);
    expect(report.unattributed).toBe(1);

    expect((await rowFor(id, "BA-A1")).attribution).toBe("AMBIGUOUS");
    const owned = await rowFor(id, "BA-A2");
    expect(owned.attribution).toBe("OWNED_ORDER");
    expect(owned.binanceOrderId).toBe(clean.order.id);
    expect((await rowFor(id, "BA-A3")).attribution).toBe("UNATTRIBUTED");
  });

  maybe()("one row carrying the id in BOTH columns is one candidate, not two", async () => {
    // Rows are counted, not matched columns -- exactly as the single-id lookup
    // counted them. Otherwise a triggered conditional order whose two identity
    // columns agree would make its own fill look ambiguous.
    const id = await profile("batch-both-columns");
    const owner = await orderOn(id, SYMBOL, { exchangeOrderId: "BA-BOTH", actualOrderId: "BA-BOTH" });

    const report = await ledger.ingestUserTrades(id, [trade({ tradeId: "BA-B1", orderId: "BA-BOTH" })]);

    expect(report.ambiguous).toBe(0);
    const row = await rowFor(id, "BA-B1");
    expect(row.attribution).toBe("OWNED_ORDER");
    expect(row.binanceOrderId).toBe(owner.order.id);
  });

  maybe()("a triggered conditional order still resolves through actualOrderId in a batch", async () => {
    const id = await profile("batch-actual-order-id");
    const owner = await orderOn(id, SYMBOL, { actualOrderId: "BA-TRIGGERED" });

    await ledger.ingestUserTrades(id, [
      trade({ tradeId: "BA-T1", orderId: "BA-TRIGGERED" }),
      trade({ tradeId: "BA-T2", orderId: "BA-UNKNOWN" }),
    ]);

    const row = await rowFor(id, "BA-T1");
    expect(row.attribution).toBe("OWNED_ORDER");
    expect(row.binanceOrderId).toBe(owner.order.id);
    expect(row.tradeExecutionId).toBe(owner.execution.id);
    expect((await rowFor(id, "BA-T2")).attribution).toBe("UNATTRIBUTED");
  });

  maybe()("a batch enriches known rows and inserts new ones in one pass", async () => {
    const id = await profile("batch-mixed-pass");
    const known = trade({ tradeId: "BM-1", orderId: "BM-ORD" });
    await ledger.ingestUserTrades(id, [known]);
    const owner = await orderOn(id, SYMBOL, { exchangeOrderId: "BM-ORD" });

    const report = await ledger.ingestUserTrades(id, [known, trade({ tradeId: "BM-2", orderId: null })]);

    expect(report.inserted).toBe(1);
    expect(report.duplicates).toBe(1);
    expect(report.attributionEnriched).toBe(1);
    expect(report.attributionEnriched).toBeLessThanOrEqual(report.duplicates);
    expect((await rowFor(id, "BM-1")).binanceOrderId).toBe(owner.order.id);
    expect((await rowFor(id, "BM-2")).attribution).toBe("UNATTRIBUTED");
  });
});

// ---------------------------------------------------------------------------
// What the report is allowed to say
// ---------------------------------------------------------------------------

describe("batch accounting conserves every input", () => {
  maybe()("inserted + duplicates + skipped totals the input, across every path", async () => {
    const id = await profile("conservation");
    await ledger.ingestUserTrades(id, [trade({ tradeId: "CN-KNOWN" })]);

    const page = [
      trade({ tradeId: "CN-KNOWN" }),                    // durable duplicate
      trade({ tradeId: "CN-NEW-1" }),                    // insert
      trade({ tradeId: "CN-NEW-1" }),                    // same-page duplicate
      trade({ tradeId: "CN-NEW-2", symbol: SECOND_SYMBOL }), // insert, other symbol
      trade({ tradeId: null }),                          // skip
      trade({ tradeId: "CN-BAD", price: null }),         // skip
    ];

    const report = await ledger.ingestUserTrades(id, page);

    expect(report.inserted).toBe(2);
    expect(report.duplicates).toBe(2);
    expect(report.skipped).toBe(2);
    expect(report.inserted + report.duplicates + report.skipped).toBe(page.length);
    expect(report.skippedReasons).toHaveLength(2);
    expect(report.attributionEnriched).toBeLessThanOrEqual(report.duplicates);
    expect(await fillsFor(id)).toHaveLength(3);
  });

  maybe()("an empty page is a valid call that writes nothing", async () => {
    const id = await profile("conservation-empty");

    const report = await ledger.ingestUserTrades(id, []);

    expect(report).toMatchObject({ inserted: 0, duplicates: 0, skipped: 0 });
    expect(await fillsFor(id)).toEqual([]);
  });

  maybe()("a page of nothing but unusable rows writes nothing and skips everything", async () => {
    const id = await profile("conservation-all-skipped");

    const report = await ledger.ingestUserTrades(id, [trade({ tradeId: null }), trade({ tradeId: null })]);

    expect(report.skipped).toBe(2);
    expect(report.inserted + report.duplicates + report.skipped).toBe(2);
    expect(await fillsFor(id)).toEqual([]);
  });

  maybe()("enrichment stays a SUBSET of duplicates, never a peer", async () => {
    const id = await profile("conservation-enriched");
    const fills = [trade({ tradeId: "CN-E1", orderId: "CN-E" }), trade({ tradeId: "CN-E2", orderId: null })];
    await ledger.ingestUserTrades(id, fills);
    await orderOn(id, SYMBOL, { exchangeOrderId: "CN-E" });

    const report = await ledger.ingestUserTrades(id, fills);

    expect(report.inserted).toBe(0);
    expect(report.duplicates).toBe(2);
    expect(report.attributionEnriched).toBe(1);
    expect(report.inserted + report.duplicates + report.skipped).toBe(2);
  });
});

describe("a contradiction anywhere in a page stops the whole page", () => {
  maybe()("a conflict on the LAST trade leaves the earlier ones unwritten", async () => {
    // Economics are compared for the whole batch before any write, so a page
    // is applied entirely or not at all -- the earlier rows are no longer
    // already committed by the time the contradiction is reached.
    const id = await profile("batch-conflict-last");
    await ledger.ingestUserTrades(id, [trade({ tradeId: "BC-KNOWN", price: "100" })]);
    expect(await fillsFor(id)).toHaveLength(1);

    await expect(
      ledger.ingestUserTrades(id, [
        trade({ tradeId: "BC-NEW-1" }),
        trade({ tradeId: "BC-NEW-2" }),
        trade({ tradeId: "BC-KNOWN", price: "101" }),
      ])
    ).rejects.toBeInstanceOf(FillLedgerConflictError);

    const rows = await fillsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].exchangeTradeId).toBe("BC-KNOWN");
    expect(rows[0].price.toString()).toBe("100");
  });

  maybe()("a conflict blocks enrichment in the same page", async () => {
    // Conflict-first is unconditional: an owner becoming resolvable is never a
    // way past a contradiction, even for a DIFFERENT fill in the batch.
    const id = await profile("batch-conflict-blocks-enrichment");
    await ledger.ingestUserTrades(id, [
      trade({ tradeId: "BE-1", orderId: "BE-ORD" }),
      trade({ tradeId: "BE-2", price: "100" }),
    ]);
    await orderOn(id, SYMBOL, { exchangeOrderId: "BE-ORD" });

    await expect(
      ledger.ingestUserTrades(id, [
        trade({ tradeId: "BE-1", orderId: "BE-ORD" }),
        trade({ tradeId: "BE-2", price: "101" }),
      ])
    ).rejects.toBeInstanceOf(FillLedgerConflictError);

    expect((await rowFor(id, "BE-1")).attribution).toBe("UNATTRIBUTED");
    expect((await rowFor(id, "BE-2")).price.toString()).toBe("100");
  });
});
