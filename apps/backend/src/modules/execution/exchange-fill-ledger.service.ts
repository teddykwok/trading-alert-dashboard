import { Prisma } from "@prisma/client";
import type {
  ExchangeFillLedger,
  ExecutionOrderSide,
  FillAttribution,
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

/**
 * A batch that lost the insert race.
 *
 * The unique constraint did its job, but a constraint violation inside a
 * PostgreSQL transaction ABORTS that transaction: every later statement fails
 * with 25P02, so the winning row cannot be read back and compared here. The
 * old per-row recovery -- catch the violation, re-read the winner, compare --
 * is therefore unavailable to a caller that owns a transaction, and pretending
 * otherwise would turn a correct race handler into a guaranteed failure.
 *
 * So the whole call fails and claims nothing about any row in it. Retryable,
 * and convergent: the replay's pre-read sees the winner and takes the ordinary
 * duplicate path, where the economics ARE compared, and each replay finds
 * strictly more rows already durable.
 */
export class FillLedgerInsertRaceError extends Error {
  readonly reasonCode = "FILL_LEDGER_INSERT_RACE";
  /** A later attempt can succeed; this is contention, not contradiction. */
  readonly retryable = true;

  constructor(
    readonly executionProfileId: string,
    readonly attemptedRowCount: number
  ) {
    super(
      `Inserting ${attemptedRowCount} fill(s) collided with a concurrent writer; ` +
        `nothing was written by this call and nothing is claimed about it.`
    );
    this.name = "FillLedgerInsertRaceError";
  }
}

/** Which owned order a fill resolved to, if any. */
interface ResolvedAttribution {
  attribution: FillAttribution;
  binanceOrderId: string | null;
  tradeExecutionId: string | null;
}

const UNATTRIBUTED: ResolvedAttribution = {
  attribution: "UNATTRIBUTED",
  binanceOrderId: null,
  tradeExecutionId: null,
};

/**
 * One incoming fill that is representable, plus how many IDENTICAL further
 * occurrences of the same identity arrived in the same batch.
 */
interface PreparedFill {
  key: FillKey;
  facts: FillFacts;
  tradeTime: Date;
  extraOccurrences: number;
}

/**
 * A composite map key. NUL-separated because it can appear in neither a symbol
 * nor a digits-only exchange id, so "AB" + "C" can never collide with
 * "A" + "BC".
 */
const compositeKey = (left: string, right: string): string => `${left}\u0000${right}`;

/**
 * Everything a fill needs to MEAN something, or why it does not.
 *
 * Pure, and deliberately the first thing that happens: a row with no identity
 * cannot be grouped, cannot be looked up and must never be defaulted into one.
 * Returns the skip reason as a string, or the prepared fill.
 */
function prepareFill(
  executionProfileId: string,
  trade: BinanceUserTradeDto
): PreparedFill | string {
  if (trade.tradeId === null) return "missing tradeId";
  if (trade.symbol === null) return `trade ${trade.tradeId}: missing symbol`;
  if (trade.timeMs === null) return `trade ${trade.tradeId}: missing trade time`;
  const side = trade.side?.trim().toUpperCase();
  if (side !== "BUY" && side !== "SELL") return `trade ${trade.tradeId}: unreadable side`;
  const positionSide = trade.positionSide;
  if (positionSide === null) return `trade ${trade.tradeId}: missing positionSide`;
  const quantity = decimal(trade.quantity);
  const price = decimal(trade.price);
  if (quantity === null) return `trade ${trade.tradeId}: missing quantity`;
  if (price === null) return `trade ${trade.tradeId}: missing price`;

  return {
    key: {
      executionProfileId,
      symbol: trade.symbol,
      exchangeTradeId: trade.tradeId,
      orderId: trade.orderId,
    },
    facts: {
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
    },
    tradeTime: new Date(trade.timeMs),
    extraOccurrences: 0,
  };
}

/** The batch's answer for one fill's order id, or UNATTRIBUTED. */
function attributionFor(
  resolved: ReadonlyMap<string, ResolvedAttribution>,
  fill: PreparedFill
): ResolvedAttribution {
  const orderId = fill.key.orderId;
  if (orderId === null || orderId.trim() === "") return UNATTRIBUTED;
  return resolved.get(compositeKey(fill.key.symbol, orderId)) ?? UNATTRIBUTED;
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
    return this.ingest(this.prisma, executionProfileId, trades);
  }

  /**
   * The same ingestion, as statements in a transaction the CALLER owns.
   *
   * This exists so one exchange page and the durable record that says the page
   * was seen can commit together. Without it, a crash between the two leaves
   * either an interval marked as processed with none of its fills recorded, or
   * fills recorded that no interval accounts for -- and the first of those is
   * a silent hole in the accounting substrate.
   *
   * A SEPARATE NAMED METHOD rather than an optional client argument, on
   * purpose. A defaulted parameter would let a caller inside `$transaction`
   * forget it and write through the pooled client instead: those writes would
   * commit, look correct, and survive the rollback they were supposed to be
   * part of. Here the transaction has to be named to be used.
   *
   * NO NESTED TRANSACTION is opened, and nothing is committed here. The caller
   * decides, which is the whole point.
   */
  async ingestUserTradesInTransaction(
    tx: Prisma.TransactionClient,
    executionProfileId: string,
    trades: readonly BinanceUserTradeDto[]
  ): Promise<FillIngestReport> {
    return this.ingest(tx, executionProfileId, trades);
  }

  /**
   * One batch, in seven ordered phases.
   *
   * The order is the contract, not an implementation detail:
   *
   *  1. unrepresentable inputs are classified BEFORE anything is grouped, so a
   *     row with no identity is never defaulted into one;
   *  2. same-batch identities are canonicalized BEFORE any query, so a page
   *     that contains one trade twice cannot reach the unique constraint and
   *     fail forever;
   *  3. the durable pre-read is scoped by account AND symbol, because an
   *     exchange trade id means nothing without both;
   *  4. economics are compared for the WHOLE batch BEFORE any write, so a
   *     contradiction anywhere in the page stops the page rather than landing
   *     after some of it was already applied;
   *  5. attribution is resolved once for the batch, never once per row;
   *  6. new rows are inserted;
   *  7. and only then is a known row's absent owner filled in.
   *
   * 6 before 7 because an insert creates economic facts and an enrichment only
   * annotates existing ones: outside a transaction, a failure between them
   * leaves the facts recorded and an annotation a replay will redo, which is
   * the recoverable direction. Inside a transaction the caller's rollback
   * makes the question moot.
   */
  private async ingest(
    client: Prisma.TransactionClient,
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

    // --- 1. Nothing unrepresentable reaches the database -------------------
    const usable: PreparedFill[] = [];
    for (const trade of trades) {
      const prepared = prepareFill(executionProfileId, trade);
      if (typeof prepared === "string") {
        report.skipped += 1;
        report.skippedReasons.push(prepared);
        continue;
      }
      usable.push(prepared);
    }

    /**
     * --- 2. One identity, one representative ------------------------------
     *
     * A page that carries the same trade id twice would otherwise put two rows
     * with the same natural key into one insert, hit the unique constraint,
     * and fail identically on every replay until the work was abandoned -- with
     * no concurrent writer anywhere. So the batch is made consistent with
     * itself first, using the SAME comparison the durable replay path uses:
     * identical occurrences collapse to one and count as duplicates, and
     * contradictory ones are a conflict before a single row is written.
     */
    const groups = new Map<string, PreparedFill>();
    for (const fill of usable) {
      const identity = compositeKey(fill.key.symbol, fill.key.exchangeTradeId);
      const first = groups.get(identity);
      if (first === undefined) {
        groups.set(identity, fill);
        continue;
      }
      const differing = this.differences(first.facts, fill.facts);
      if (differing.length > 0) {
        throw new FillLedgerConflictError(
          executionProfileId,
          fill.key.symbol,
          fill.key.exchangeTradeId,
          differing
        );
      }
      first.extraOccurrences += 1;
    }
    for (const group of groups.values()) report.duplicates += group.extraOccurrences;

    if (groups.size === 0) return report;

    // --- 3. Pre-read, scoped by account AND symbol -------------------------
    const bySymbol = new Map<string, PreparedFill[]>();
    for (const group of groups.values()) {
      const forSymbol = bySymbol.get(group.key.symbol);
      if (forSymbol === undefined) bySymbol.set(group.key.symbol, [group]);
      else forSymbol.push(group);
    }

    const durable = new Map<string, ExchangeFillLedger>();
    for (const [symbol, fills] of bySymbol) {
      // Scoped per symbol rather than one global id list: a trade id is unique
      // per account only, and Account A's BTCUSDT 1001 and its ETHUSDT 1001
      // are different fills. A global `exchangeTradeId IN (...)` would match
      // across symbols and route a genuinely new fill into the replay path.
      const rows = await client.exchangeFillLedger.findMany({
        where: {
          executionProfileId,
          symbol,
          exchangeTradeId: { in: fills.map((fill) => fill.key.exchangeTradeId) },
        },
      });
      for (const row of rows) durable.set(compositeKey(row.symbol, row.exchangeTradeId), row);
    }

    /**
     * --- 4. Economics first, for the whole batch --------------------------
     *
     * Unconditional and before any write, so enrichment can never become a way
     * to slip past a contradiction. Batch-wide rather than per row: a conflict
     * on the last trade of a page now stops the page instead of surfacing after
     * the first ninety-nine were already applied.
     */
    const known: Array<{ fill: PreparedFill; row: ExchangeFillLedger }> = [];
    const newcomers: PreparedFill[] = [];
    for (const group of groups.values()) {
      const row = durable.get(compositeKey(group.key.symbol, group.key.exchangeTradeId));
      if (row === undefined) {
        newcomers.push(group);
        continue;
      }
      const differing = this.differences(row, group.facts);
      if (differing.length > 0) {
        throw new FillLedgerConflictError(
          executionProfileId,
          group.key.symbol,
          group.key.exchangeTradeId,
          differing
        );
      }
      known.push({ fill: group, row });
    }

    // --- 5. Attribution, resolved once for the batch -----------------------
    const attributions = await this.attributeMany(client, executionProfileId, [
      ...newcomers,
      ...known.filter((entry) => entry.row.attribution === "UNATTRIBUTED").map((entry) => entry.fill),
    ]);

    // --- 6. The genuinely new rows -----------------------------------------
    if (newcomers.length > 0) {
      try {
        await client.exchangeFillLedger.createMany({
          /**
           * NO `skipDuplicates`. It would swallow exactly the case this ledger
           * exists to catch: a constraint violation is NOT proof that the row
           * already there says what we were about to write. Silently skipping
           * would report success on facts that were never stored.
           */
          data: newcomers.map((fill) => ({
            executionProfileId,
            symbol: fill.key.symbol,
            exchangeTradeId: fill.key.exchangeTradeId,
            ...fill.facts,
            tradeTime: fill.tradeTime,
            ...attributionFor(attributions, fill),
          })),
        });
      } catch (error) {
        /**
         * NOTHING IS QUERIED AFTER THIS. Inside a transaction the violation has
         * already aborted it, so a re-read would fail with 25P02 rather than
         * answer. The whole call fails; the replay compares facts properly.
         */
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new FillLedgerInsertRaceError(executionProfileId, newcomers.length);
        }
        throw error;
      }

      report.inserted += newcomers.length;
      for (const fill of newcomers) {
        const resolved = attributionFor(attributions, fill);
        if (resolved.attribution === "UNATTRIBUTED") report.unattributed += 1;
        if (resolved.attribution === "AMBIGUOUS") report.ambiguous += 1;
      }
    }

    // --- 7. What we already hold, and whose it turns out to be -------------
    for (const entry of known) {
      // Both DUPLICATE and ENRICHED describe an economic fill we already hold;
      // enrichment is additionally counted, never instead.
      report.duplicates += 1;
      const outcome = await this.enrichExisting(client, entry.row, entry.fill, attributions, report);
      if (outcome === "ENRICHED") report.attributionEnriched += 1;
    }

    return report;
  }

  /**
   * Fills in the owner of a fill we already hold, when it has none.
   *
   * The economic comparison has ALREADY happened, for the whole batch, in
   * phase 4. This function therefore only ever runs against a row whose facts
   * agree with what arrived -- which is the asymmetry the feature rests on:
   * what a fill WAS is fixed the moment the exchange reports it, but WHOSE it
   * is, is something we can learn later.
   */
  private async enrichExisting(
    client: Prisma.TransactionClient,
    existing: ExchangeFillLedger,
    fill: PreparedFill,
    attributions: ReadonlyMap<string, ResolvedAttribution>,
    report: FillIngestReport
  ): Promise<"DUPLICATE" | "ENRICHED"> {
    const { executionProfileId, symbol, exchangeTradeId } = fill.key;

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

    const resolved = attributionFor(attributions, fill);
    if (resolved.attribution !== "OWNED_ORDER" || resolved.binanceOrderId === null) {
      // Nothing to learn: still no owner, or now several. Several is reported
      // so the caller can see it, but the stored row stays UNATTRIBUTED --
      // guessing one late is no better than guessing one early.
      if (resolved.attribution === "AMBIGUOUS") report.ambiguous += 1;
      return "DUPLICATE";
    }

    /**
     * Compare-and-set, so two callers who both resolved an owner cannot both
     * write one. The WHERE carries the full prior state, which means the
     * update applies only to a row still genuinely unowned -- a read followed
     * by a blind write would let the loser overwrite the winner with an
     * equally-plausible answer.
     *
     * Nothing economic appears in `data`. That is the enforcement, not a
     * convention: this is the only statement in the service that updates a
     * ledger row, and it can reach exactly three columns.
     */
    const applied = await client.exchangeFillLedger.updateMany({
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
     * retry, because the answer cannot change again in our favour. A matched
     * count of zero is not an ERROR, so a surrounding transaction is still
     * usable and this read can be trusted to answer.
     */
    const after = await this.findFill(client, executionProfileId, symbol, exchangeTradeId);
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
  private async findFill(
    client: Prisma.TransactionClient,
    executionProfileId: string,
    symbol: string,
    exchangeTradeId: string
  ) {
    return client.exchangeFillLedger.findUnique({
      where: {
        executionProfileId_symbol_exchangeTradeId: { executionProfileId, symbol, exchangeTradeId },
      },
    });
  }

  /**
   * Which owned order produced each fill, by EXCHANGE ORDER IDENTITY only.
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
   * therefore (account, symbol, order id) -- the same shape as the ledger's own
   * unique key, for the same underlying reason.
   *
   * Dropping either half breaks it in two directions. Without the account, one
   * account's order claims another's fill. Without the symbol, a BTCUSDT order
   * claims an ETHUSDT fill -- and an unrelated ETHUSDT row reusing the number
   * makes a perfectly unambiguous BTCUSDT fill look AMBIGUOUS. Both are
   * boundaries of the identity, not heuristics applied after a match.
   *
   * Neither id column is unique even inside one account and symbol, so more
   * than one owned row CAN still match. That remains ambiguous rather than
   * resolved to whichever came first: a wrong attribution is worse than none,
   * because it silently moves one trade's economics onto another.
   *
   * TIME is still not consulted, and neither is positionSide. Those coincide
   * for genuinely unrelated trades -- another client's fill on the same symbol
   * in the same second looks identical -- so they identify nothing.
   *
   * BATCHED, one query per SYMBOL rather than one per fill. A replayed window
   * of a thousand known trades used to issue a thousand lookups, which inside a
   * caller's transaction is a thousand round trips holding it open. Ambiguity
   * is still counted PER ORDER ID and per matching ROW: a single owned row that
   * happens to carry the id in both columns is one candidate, exactly as the
   * old single-id `take: 2` counted it.
   */
  private async attributeMany(
    client: Prisma.TransactionClient,
    executionProfileId: string,
    fills: readonly PreparedFill[]
  ): Promise<Map<string, ResolvedAttribution>> {
    const resolved = new Map<string, ResolvedAttribution>();

    const wantedBySymbol = new Map<string, Set<string>>();
    for (const fill of fills) {
      const orderId = fill.key.orderId;
      if (orderId === null || orderId.trim() === "") continue;
      const forSymbol = wantedBySymbol.get(fill.key.symbol);
      if (forSymbol === undefined) wantedBySymbol.set(fill.key.symbol, new Set([orderId]));
      else forSymbol.add(orderId);
    }

    for (const [symbol, orderIds] of wantedBySymbol) {
      const ids = [...orderIds];
      const candidates = await client.binanceOrder.findMany({
        where: {
          // The account AND symbol boundary, through the only relation that
          // carries either. A BinanceOrder holds no symbol of its own; the
          // execution it belongs to does.
          tradeExecution: { executionProfileId, symbol },
          OR: [{ exchangeOrderId: { in: ids } }, { actualOrderId: { in: ids } }],
        },
        select: { id: true, tradeExecutionId: true, exchangeOrderId: true, actualOrderId: true },
      });

      // Which owned ROWS each exchange id matched. Keyed by row id, so a row
      // carrying the same id in both columns cannot count as two candidates
      // and make an unambiguous fill look ambiguous.
      const matches = new Map<string, Map<string, string>>();
      for (const candidate of candidates) {
        for (const carried of [candidate.exchangeOrderId, candidate.actualOrderId]) {
          if (carried === null || !orderIds.has(carried)) continue;
          const forId = matches.get(carried) ?? new Map<string, string>();
          forId.set(candidate.id, candidate.tradeExecutionId);
          matches.set(carried, forId);
        }
      }

      for (const orderId of ids) {
        const forId = matches.get(orderId);
        const key = compositeKey(symbol, orderId);
        if (forId === undefined || forId.size === 0) {
          resolved.set(key, UNATTRIBUTED);
          continue;
        }
        if (forId.size > 1) {
          resolved.set(key, { attribution: "AMBIGUOUS", binanceOrderId: null, tradeExecutionId: null });
          continue;
        }
        const [binanceOrderId, tradeExecutionId] = [...forId][0];
        resolved.set(key, { attribution: "OWNED_ORDER", binanceOrderId, tradeExecutionId });
      }
    }

    return resolved;
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
