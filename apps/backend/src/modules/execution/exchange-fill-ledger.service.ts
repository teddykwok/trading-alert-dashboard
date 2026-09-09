import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { BinanceUserTradeDto } from "../binance/binance.types";

/**
 * Ingestion for the exchange fill ledger.
 *
 * Records fills. It does not total them, does not touch an execution's
 * accounting columns, and does not decide when to run — reconciliation and a
 * future backfill both call it with trades they already hold, so nothing here
 * issues an exchange request or schedules one.
 *
 * The whole design rests on one property: calling this twice with the same
 * trades must leave the same rows. That is enforced by a unique constraint on
 * (executionProfileId, symbol, exchangeTradeId) rather than by a caller
 * remembering to check, because the callers that matter are precisely the ones
 * running after a restart with an overlapping time window.
 */

/** What happened to one trade. */
export type FillIngestOutcome =
  /** Newly recorded. */
  | "INSERTED"
  /** Already recorded, identical in every economic fact. Nothing was written. */
  | "DUPLICATE"
  /** Unusable: an identity or a fact the ledger requires was missing. */
  | "SKIPPED_INCOMPLETE";

export interface FillIngestReport {
  inserted: number;
  duplicates: number;
  skipped: number;
  /** Fills whose exchange order matched no owned order. Not an error. */
  unattributed: number;
  /** Fills whose exchange order matched more than one owned row. */
  ambiguous: number;
  /** Why each skipped trade was unusable, for the caller to surface. */
  skippedReasons: string[];
}

/**
 * A fill whose stored facts contradict an identical exchange identity.
 *
 * The exchange's trade id means ONE immutable fill. Two different economic
 * readings under the same id is not a duplicate to be absorbed and not a
 * correction to be applied — it means one of the two is wrong, and silently
 * keeping either would put an unexplained number into the accounting
 * substrate. It is raised rather than swallowed, and nothing is overwritten.
 */
export class FillLedgerConflictError extends Error {
  readonly reasonCode = "FILL_LEDGER_IDENTITY_CONFLICT";

  constructor(
    readonly executionProfileId: string,
    readonly symbol: string,
    readonly exchangeTradeId: string,
    readonly differing: string[]
  ) {
    super(
      `Fill ${symbol}#${exchangeTradeId} was already recorded with different ` +
        `facts (${differing.join(", ")}); the ledger is append-only and nothing was overwritten.`
    );
    this.name = "FillLedgerConflictError";
  }
}

/**
 * The unique constraint rejected an insert, and the row it collided with then
 * could not be read back.
 *
 * That should not be reachable: the constraint fired, so the row existed. It is
 * raised rather than absorbed because the alternative is reporting a fill as
 * safely recorded when we never confirmed what was recorded — which is exactly
 * the silent-success the ledger exists to make impossible.
 */
export class FillLedgerRaceUnresolvedError extends Error {
  readonly reasonCode = "FILL_LEDGER_RACE_UNRESOLVED";

  constructor(
    readonly executionProfileId: string,
    readonly symbol: string,
    readonly exchangeTradeId: string
  ) {
    super(
      `Fill ${symbol}#${exchangeTradeId} collided with an existing row that could ` +
        `not then be read back; nothing was written and nothing is claimed about it.`
    );
    this.name = "FillLedgerRaceUnresolvedError";
  }
}

/** Exact decimal, or null when the exchange reported nothing. */
function decimal(value: string | null): Prisma.Decimal | null {
  if (value === null) return null;
  try {
    return new Prisma.Decimal(value);
  } catch {
    return null;
  }
}

/** Two stored decimals compare by VALUE: "1.50" and "1.5" are one number. */
function sameDecimal(stored: Prisma.Decimal | null, incoming: Prisma.Decimal | null): boolean {
  if (stored === null || incoming === null) return stored === incoming;
  return stored.equals(incoming);
}

export class ExchangeFillLedgerService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Records every usable fill for ONE account.
   *
   * The profile is an argument rather than something inferred from the trades,
   * because a fill carries no account identity of its own — asking the caller
   * to name the account it read from is what keeps two accounts' histories
   * apart.
   */
  async ingestUserTrades(
    executionProfileId: string,
    trades: readonly BinanceUserTradeDto[]
  ): Promise<FillIngestReport> {
    const report: FillIngestReport = {
      inserted: 0,
      duplicates: 0,
      skipped: 0,
      unattributed: 0,
      ambiguous: 0,
      skippedReasons: [],
    };

    for (const trade of trades) {
      const outcome = await this.ingestOne(executionProfileId, trade, report);
      if (outcome === "INSERTED") report.inserted += 1;
      else if (outcome === "DUPLICATE") report.duplicates += 1;
      else report.skipped += 1;
    }

    return report;
  }

  private async ingestOne(
    executionProfileId: string,
    trade: BinanceUserTradeDto,
    report: FillIngestReport
  ): Promise<FillIngestOutcome> {
    const skip = (reason: string): FillIngestOutcome => {
      report.skippedReasons.push(reason);
      return "SKIPPED_INCOMPLETE";
    };

    /**
     * Everything below is required to make the row MEAN anything, so a missing
     * one is refused rather than defaulted. A fill with no trade id has no
     * identity and could be written twice; one with no quantity or price is
     * not a fill anybody can account for; one with an unreadable side cannot
     * be told from its opposite.
     */
    if (trade.tradeId === null) return skip("missing tradeId");
    if (trade.symbol === null) return skip(`trade ${trade.tradeId}: missing symbol`);
    if (trade.timeMs === null) return skip(`trade ${trade.tradeId}: missing trade time`);
    const side = trade.side?.trim().toUpperCase();
    if (side !== "BUY" && side !== "SELL") return skip(`trade ${trade.tradeId}: unreadable side`);
    const positionSide = trade.positionSide;
    if (positionSide === null) return skip(`trade ${trade.tradeId}: missing positionSide`);
    const quantity = decimal(trade.quantity);
    const price = decimal(trade.price);
    if (quantity === null) return skip(`trade ${trade.tradeId}: missing quantity`);
    if (price === null) return skip(`trade ${trade.tradeId}: missing price`);

    const facts = {
      exchangeOrderId: trade.orderId,
      side,
      positionSide,
      quantity,
      price,
      quoteQuantity: decimal(trade.quoteQuantity),
      // Never coerced: a null realized result means the exchange said nothing,
      // and a null commission is not a free trade.
      realizedPnl: decimal(trade.realizedPnl),
      commission: decimal(trade.commission),
      commissionAsset: trade.commissionAsset,
      maker: trade.maker,
      tradeTime: new Date(trade.timeMs),
    } as const;

    const existing = await this.findFill(executionProfileId, trade.symbol, trade.tradeId);

    if (existing) {
      const differing = this.differences(existing, facts);
      if (differing.length > 0) {
        throw new FillLedgerConflictError(executionProfileId, trade.symbol, trade.tradeId, differing);
      }
      // Same fill, same facts. Nothing to write — this is the replay path.
      return "DUPLICATE";
    }

    const attribution = await this.attribute(executionProfileId, trade.symbol, trade.orderId);
    if (attribution.attribution === "UNATTRIBUTED") report.unattributed += 1;
    if (attribution.attribution === "AMBIGUOUS") report.ambiguous += 1;

    try {
      await this.prisma.exchangeFillLedger.create({
        data: {
          executionProfileId,
          symbol: trade.symbol,
          exchangeTradeId: trade.tradeId,
          ...facts,
          ...attribution,
        },
      });
    } catch (error) {
      /**
       * Another writer inserted this identity between our read and our write.
       * The constraint did its job — but "a row now exists" is NOT the same
       * claim as "the row that exists says what we were about to write".
       *
       * Treating the violation itself as proof of a duplicate would make the
       * conflict check defeatable by timing: two readers who both saw nothing
       * would have one insert its facts and the other silently report success
       * on facts that were never stored. So the winner is read back and
       * compared against exactly the same immutable fact set the ordinary
       * duplicate path uses, and disagreement raises the same conflict.
       *
       * One authoritative re-read, no retry loop: the row cannot disappear
       * again, because this ledger never deletes.
       */
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        if (attribution.attribution === "UNATTRIBUTED") report.unattributed -= 1;
        if (attribution.attribution === "AMBIGUOUS") report.ambiguous -= 1;

        const winner = await this.findFill(executionProfileId, trade.symbol, trade.tradeId);
        if (winner === null) {
          throw new FillLedgerRaceUnresolvedError(executionProfileId, trade.symbol, trade.tradeId);
        }
        const differing = this.differences(winner, facts);
        if (differing.length > 0) {
          throw new FillLedgerConflictError(executionProfileId, trade.symbol, trade.tradeId, differing);
        }
        return "DUPLICATE";
      }
      throw error;
    }

    return "INSERTED";
  }

  /** One fill by its natural identity, or null. */
  private async findFill(executionProfileId: string, symbol: string, exchangeTradeId: string) {
    return this.prisma.exchangeFillLedger.findUnique({
      where: {
        executionProfileId_symbol_exchangeTradeId: { executionProfileId, symbol, exchangeTradeId },
      },
    });
  }

  /**
   * Which owned order produced this fill, by EXCHANGE ORDER IDENTITY only.
   *
   * Two local columns can carry it, for the two ways an order reaches the
   * book: `exchangeOrderId` is what an ordinary order is assigned, and
   * `actualOrderId` is the order a conditional one creates when it triggers.
   * Both are searched, so an entry fill, a standard take-profit fill and a
   * fired STOP all resolve through the same rule.
   *
   * SCOPED TO THE ACCOUNT AND THE SYMBOL. A USD-M order id is self-incrementing
   * PER SYMBOL, so it identifies an order only alongside both: the same number
   * is handed out independently on BTCUSDT and on ETHUSDT, and independently
   * again in another account. The full exchange identity of an order is
   * therefore (account, symbol, order id) — the same shape as the ledger's own
   * unique key, for the same underlying reason.
   *
   * Dropping either half breaks it in two directions. Without the account, one
   * account's order claims another's fill. Without the symbol, a BTCUSDT order
   * claims an ETHUSDT fill — and an unrelated ETHUSDT row reusing the number
   * makes a perfectly unambiguous BTCUSDT fill look AMBIGUOUS. Both are
   * boundaries of the identity, not heuristics applied after a match.
   *
   * Neither id column is unique even inside one account and symbol, so more
   * than one owned row CAN still match. That remains ambiguous rather than
   * resolved to whichever came first: a wrong attribution is worse than none,
   * because it silently moves one trade's economics onto another.
   *
   * TIME is still not consulted, and neither is positionSide. Those coincide
   * for genuinely unrelated trades — another client's fill on the same symbol
   * in the same second looks identical — so they identify nothing.
   */
  private async attribute(
    executionProfileId: string,
    symbol: string,
    exchangeOrderId: string | null
  ): Promise<{
    attribution: "OWNED_ORDER" | "UNATTRIBUTED" | "AMBIGUOUS";
    binanceOrderId: string | null;
    tradeExecutionId: string | null;
  }> {
    const unattributed = { attribution: "UNATTRIBUTED", binanceOrderId: null, tradeExecutionId: null } as const;
    if (exchangeOrderId === null || exchangeOrderId.trim() === "") return unattributed;

    const matches = await this.prisma.binanceOrder.findMany({
      where: {
        // The account AND symbol boundary, through the only relation that
        // carries either. A BinanceOrder holds no symbol of its own; the
        // execution it belongs to does.
        tradeExecution: { executionProfileId, symbol },
        // Both identities: an ordinary order carries `exchangeOrderId`, and a
        // conditional one carries `actualOrderId` for the order it created
        // when it triggered. The boundary above applies to both, because it
        // constrains the candidate rows rather than either id column.
        OR: [{ exchangeOrderId }, { actualOrderId: exchangeOrderId }],
      },
      select: { id: true, tradeExecutionId: true },
      // Two is enough to tell "exactly one" from "more than one" without
      // reading a table's worth of rows to answer a yes/no question.
      take: 2,
    });

    if (matches.length === 0) return unattributed;
    if (matches.length > 1) {
      return { attribution: "AMBIGUOUS", binanceOrderId: null, tradeExecutionId: null };
    }
    return {
      attribution: "OWNED_ORDER",
      binanceOrderId: matches[0].id,
      tradeExecutionId: matches[0].tradeExecutionId,
    };
  }

  /** Which immutable facts a re-read disagrees with. Empty means identical. */
  private differences(
    stored: {
      exchangeOrderId: string | null;
      side: string;
      positionSide: string;
      quantity: Prisma.Decimal;
      price: Prisma.Decimal;
      quoteQuantity: Prisma.Decimal | null;
      realizedPnl: Prisma.Decimal | null;
      commission: Prisma.Decimal | null;
      commissionAsset: string | null;
    },
    incoming: {
      exchangeOrderId: string | null;
      side: string;
      positionSide: string;
      quantity: Prisma.Decimal;
      price: Prisma.Decimal;
      quoteQuantity: Prisma.Decimal | null;
      realizedPnl: Prisma.Decimal | null;
      commission: Prisma.Decimal | null;
      commissionAsset: string | null;
    }
  ): string[] {
    const differing: string[] = [];
    // `maker` is excluded on purpose: it describes how the fill matched, not
    // what it was worth, and it is the one field Binance may omit on a
    // historical re-read. Nothing accounting depends on it.
    if (stored.exchangeOrderId !== incoming.exchangeOrderId) differing.push("exchangeOrderId");
    if (stored.side !== incoming.side) differing.push("side");
    if (stored.positionSide !== incoming.positionSide) differing.push("positionSide");
    if (!sameDecimal(stored.quantity, incoming.quantity)) differing.push("quantity");
    if (!sameDecimal(stored.price, incoming.price)) differing.push("price");
    if (!sameDecimal(stored.quoteQuantity, incoming.quoteQuantity)) differing.push("quoteQuantity");
    if (!sameDecimal(stored.realizedPnl, incoming.realizedPnl)) differing.push("realizedPnl");
    if (!sameDecimal(stored.commission, incoming.commission)) differing.push("commission");
    if (stored.commissionAsset !== incoming.commissionAsset) differing.push("commissionAsset");
    return differing;
  }
}
