import { Prisma } from "@prisma/client";
import type {
  ExchangeFillLedger,
  ExecutionOrderSide,
  ExecutionPositionSide,
  PrismaClient,
} from "@prisma/client";
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
  /**
   * Already recorded and still economically identical, but its owning order
   * has since become resolvable, so its attribution — and ONLY its
   * attribution — was filled in.
   */
  | "ENRICHED"
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
  /**
   * Replays that gained an owner they did not previously have.
   *
   * A SUBSET of `duplicates`, not a peer of it: the economic fill really was
   * already recorded, so it is still counted there and
   * `inserted + duplicates + skipped` still totals the trades handed in. This
   * says how many of those replays were more than a no-op.
   */
  attributionEnriched: number;
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
 * A stored fill already has an owner, and a replay resolved a DIFFERENT one.
 *
 * Attribution may become KNOWN later; it may not silently change hands. Two
 * owned orders claiming one fill means our local identities are wrong, and
 * quietly moving the fill would relocate that trade's economics onto another
 * execution — the exact failure the ambiguity rule exists to prevent, arriving
 * one replay late instead of at insert.
 */
export class FillLedgerAttributionConflictError extends Error {
  readonly reasonCode = "FILL_LEDGER_ATTRIBUTION_CONFLICT";

  constructor(
    readonly executionProfileId: string,
    readonly symbol: string,
    readonly exchangeTradeId: string,
    readonly storedBinanceOrderId: string | null,
    readonly resolvedBinanceOrderId: string | null
  ) {
    super(
      `Fill ${symbol}#${exchangeTradeId} is already attributed to order ` +
        `${storedBinanceOrderId ?? "(none)"}, but this replay resolved ` +
        `${resolvedBinanceOrderId ?? "(none)"}; ownership was left as it was.`
    );
    this.name = "FillLedgerAttributionConflictError";
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
    readonly exchangeTradeId: string,
    readonly detail = "collided with an existing row that could not then be read back"
  ) {
    super(
      `Fill ${symbol}#${exchangeTradeId} ${detail}; nothing was written and ` +
        `nothing is claimed about it.`
    );
    this.name = "FillLedgerRaceUnresolvedError";
  }
}

/**
 * The immutable economic content of one fill.
 *
 * Named once and shared by everything that compares or writes it, so the
 * conflict check and the insert can never come to describe different sets.
 */
interface FillFacts {
  exchangeOrderId: string | null;
  side: ExecutionOrderSide;
  positionSide: ExecutionPositionSide;
  quantity: Prisma.Decimal;
  price: Prisma.Decimal;
  quoteQuantity: Prisma.Decimal | null;
  realizedPnl: Prisma.Decimal | null;
  commission: Prisma.Decimal | null;
  commissionAsset: string | null;
  maker: boolean | null;
}

/** The natural identity of one fill, already validated. */
interface FillKey {
  executionProfileId: string;
  symbol: string;
  exchangeTradeId: string;
  /** The exchange order this fill named, if any. */
  orderId: string | null;
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
      attributionEnriched: 0,
      skippedReasons: [],
    };

    for (const trade of trades) {
      const outcome = await this.ingestOne(executionProfileId, trade, report);
      if (outcome === "INSERTED") report.inserted += 1;
      else if (outcome === "SKIPPED_INCOMPLETE") report.skipped += 1;
      else {
        // Both DUPLICATE and ENRICHED describe an economic fill we already
        // hold; enrichment is additionally counted, never instead.
        report.duplicates += 1;
        if (outcome === "ENRICHED") report.attributionEnriched += 1;
      }
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

    const key: FillKey = {
      executionProfileId,
      symbol: trade.symbol,
      exchangeTradeId: trade.tradeId,
      orderId: trade.orderId,
    };

    const facts: FillFacts = {
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
    };
    const tradeTime = new Date(trade.timeMs);

    const existing = await this.findFill(executionProfileId, key.symbol, key.exchangeTradeId);

    if (existing) {
      return this.resolveExistingFill(existing, key, facts, report);
    }

    const attribution = await this.attribute(executionProfileId, key.symbol, key.orderId);
    if (attribution.attribution === "UNATTRIBUTED") report.unattributed += 1;
    if (attribution.attribution === "AMBIGUOUS") report.ambiguous += 1;

    try {
      await this.prisma.exchangeFillLedger.create({
        data: {
          executionProfileId,
          symbol: key.symbol,
          exchangeTradeId: key.exchangeTradeId,
          ...facts,
          tradeTime,
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

        const winner = await this.findFill(executionProfileId, key.symbol, key.exchangeTradeId);
        if (winner === null) {
          throw new FillLedgerRaceUnresolvedError(executionProfileId, key.symbol, key.exchangeTradeId);
        }
        // The same resolver the ordinary replay uses, so a fill that loses the
        // insert race is still able to contribute what it knows about ownership.
        return this.resolveExistingFill(winner, key, facts, report);
      }
      throw error;
    }

    return "INSERTED";
  }

  /**
   * What to do about a fill we already hold.
   *
   * The economic comparison comes FIRST and is unconditional: contradictory
   * facts under one exchange identity are a conflict whether or not ownership
   * could now be resolved, and enrichment must never become a way to slip past
   * it.
   *
   * Only then, and only for a row that has no owner yet, is ownership
   * reconsidered. That is the asymmetry this whole feature rests on: what a
   * fill WAS is fixed the moment the exchange reports it, but WHOSE it is, is
   * something we can learn later. A fill can legitimately be read before its
   * owning order's exchange identity has been recorded locally — an ambiguous
   * submission is reconciled after the fact — and without this the row would
   * stay unowned forever, because attribution was only ever computed on insert.
   */
  private async resolveExistingFill(
    existing: ExchangeFillLedger,
    key: FillKey,
    facts: FillFacts,
    report: FillIngestReport
  ): Promise<FillIngestOutcome> {
    const { executionProfileId, symbol, exchangeTradeId } = key;
    const differing = this.differences(existing, facts);
    if (differing.length > 0) {
      throw new FillLedgerConflictError(executionProfileId, symbol, exchangeTradeId, differing);
    }

    /**
     * ALREADY OWNED IS STICKY, in every direction.
     *
     * Not re-resolved, not re-checked, not moved. A later lookup that finds
     * nothing, finds something else, or has become ambiguous describes our
     * LOCAL state, which can be wrong or mid-repair; it is not new information
     * about which order the exchange filled. The one case where a later lookup
     * genuinely contradicts a stored owner is caught below, where a
     * concurrent enrichment could otherwise overwrite a winner.
     *
     * AMBIGUOUS is left alone too. Deciding whether an ambiguous row should
     * ever be re-resolved is a separate question from filling in an absent
     * owner, and answering it here would smuggle a state machine into a
     * one-way enrichment.
     */
    if (existing.attribution !== "UNATTRIBUTED") return "DUPLICATE";

    const resolved = await this.attribute(executionProfileId, symbol, key.orderId);
    if (resolved.attribution !== "OWNED_ORDER" || resolved.binanceOrderId === null) {
      // Nothing to learn: still no owner, or now several. Several is reported
      // so the caller can see it, but the stored row stays UNATTRIBUTED —
      // guessing one late is no better than guessing one early.
      if (resolved.attribution === "AMBIGUOUS") report.ambiguous += 1;
      return "DUPLICATE";
    }

    /**
     * Compare-and-set, so two callers who both resolved an owner cannot both
     * write one. The WHERE carries the full prior state, which means the
     * update applies only to a row still genuinely unowned — a read followed
     * by a blind write would let the loser overwrite the winner with an
     * equally-plausible answer.
     *
     * Nothing economic appears in `data`. That is the enforcement, not a
     * convention: this is the only statement in the service that updates a
     * ledger row, and it can reach exactly three columns.
     */
    const applied = await this.prisma.exchangeFillLedger.updateMany({
      where: {
        id: existing.id,
        attribution: "UNATTRIBUTED",
        binanceOrderId: null,
        tradeExecutionId: null,
      },
      data: {
        attribution: "OWNED_ORDER",
        binanceOrderId: resolved.binanceOrderId,
        tradeExecutionId: resolved.tradeExecutionId,
      },
    });

    if (applied.count === 1) return "ENRICHED";

    /**
     * We lost. One authoritative re-read decides what actually happened; no
     * retry, because the answer cannot change again in our favour.
     */
    const after = await this.findFill(executionProfileId, symbol, exchangeTradeId);
    if (after === null) {
      throw new FillLedgerRaceUnresolvedError(
        executionProfileId,
        symbol,
        exchangeTradeId,
        "disappeared while its attribution was being settled"
      );
    }
    if (after.attribution === "OWNED_ORDER") {
      // The winner reached the same conclusion we did: nothing left to do.
      if (after.binanceOrderId === resolved.binanceOrderId) return "DUPLICATE";
      throw new FillLedgerAttributionConflictError(
        executionProfileId,
        symbol,
        exchangeTradeId,
        after.binanceOrderId,
        resolved.binanceOrderId
      );
    }
    // Not owned, yet the conditional update matched nothing. The row is in a
    // state this code cannot account for, so it says so rather than reporting
    // an enrichment that never happened.
    throw new FillLedgerRaceUnresolvedError(
      executionProfileId,
      symbol,
      exchangeTradeId,
      `could not be attributed and is not owned (attribution ${after.attribution})`
    );
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
  private differences(stored: FillFacts, incoming: FillFacts): string[] {
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
