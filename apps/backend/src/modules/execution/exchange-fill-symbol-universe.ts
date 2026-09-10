import type { Prisma } from "@prisma/client";

import { ValidationError } from "../../utils/errors";
import { normalizeTradingSymbol } from "../../utils/symbol";

/**
 * The symbols a bounded ingestion sweep is allowed to seed coverage for.
 *
 * ## Why TradeExecution, and only TradeExecution
 *
 * The universe has to mean "symbols where Teddy has durable execution
 * relevance", not "symbols Teddy has ever seen an alert for". `TradeExecution`
 * is the only model that carries both halves of that: it is written exclusively
 * from a READY plan, and it is scoped by `executionProfileId`, so one account's
 * history can never leak into another's.
 *
 * It is also the only candidate that survives. Retention deletes `Alert` rows,
 * and `ExtremeRRPlan` cascades away with them -- but `TradeExecution.alertId` is
 * SET NULL, and `symbol` is denormalized onto the execution precisely so the row
 * stays self-contained afterwards. Nothing in the codebase deletes a
 * `TradeExecution`. The fill ledger and the ingest-window table are circular
 * candidates: they are what this seeding populates.
 *
 * ## Why every execution counts
 *
 * No status filter. An execution whose LOCAL state says FAILED or SKIPPED after
 * an ambiguous submission is exactly the case where a fill may exist that we do
 * not know about -- which is the class of defect historical recovery exists to
 * find. Filtering by status would make the sweep blind to precisely what it is
 * for, and the cost of not filtering is bounded: a symbol with no fills yields
 * windows that return empty pages and are truthfully complete.
 *
 * No date filter either. The recovery horizon bounds which DAYS are swept, not
 * which symbols are relevant; an execution created months ago can hold a
 * position whose fills land inside the horizon.
 */

/**
 * A persisted execution symbol that is not in canonical form.
 *
 * Raised rather than skipped, and raised for the WHOLE call rather than per
 * row. A malformed durable symbol means something wrote execution lineage
 * without going through the canonical path, and seeding coverage for the other
 * symbols while quietly omitting this one would leave a hole that looks exactly
 * like a symbol nobody ever traded. The caller is expected to refuse to seed
 * anything until it is explained.
 */
export class ExecutionSymbolLineageError extends Error {
  readonly reasonCode = "EXECUTION_SYMBOL_LINEAGE_INVALID";

  constructor(
    readonly executionProfileId: string,
    /** Every offending value, so one pass names them all rather than the first. */
    readonly invalidSymbols: readonly string[]
  ) {
    super(
      `Execution profile ${executionProfileId} holds ${invalidSymbols.length} ` +
        `non-canonical execution symbol(s): ${invalidSymbols.map((value) => JSON.stringify(value)).join(", ")}. ` +
        `Durable execution identity is never repaired here.`
    );
    this.name = "ExecutionSymbolLineageError";
  }
}

/**
 * Is this persisted value ALREADY what the write path would have produced?
 *
 * Validation, never repair. `normalizeTradingSymbol` is the same helper the
 * webhook path uses to produce a canonical symbol in the first place, so
 * running it here and comparing is asking "would canonicalizing change this?".
 * If it would, the stored value is not canonical and the canonical form is
 * discarded -- it exists only to answer the question. Replacing the durable
 * value with it would invent an identity the writer never stored.
 *
 * A value the helper REFUSES outright is not canonical either -- but only its
 * own refusal counts as that verdict. All four of its throw sites construct a
 * `ValidationError`, so anything else coming out of it is a bug or an
 * infrastructure failure, and reporting that as a conclusion about durable data
 * would be the same class of lie this module exists to prevent: it would blame
 * the account's history for a fault in the code reading it.
 *
 * Narrowing on the thrown type rather than pre-screening with
 * `getSymbolInputError`: that predicate returns null for "BINANCE:" and ".P",
 * which `normalizeTradingSymbol` still rejects, so a pre-screen would let a
 * genuinely malformed persisted symbol escape as an unhandled ValidationError
 * instead of the structural-data error the caller is waiting for.
 */
function isCanonicalPersistedSymbol(raw: string): boolean {
  try {
    return normalizeTradingSymbol(raw).normalizedSymbol === raw;
  } catch (error) {
    if (error instanceof ValidationError) return false;
    throw error;
  }
}

/**
 * Every distinct symbol this profile has durable execution lineage for, sorted.
 *
 * Ascending lexical order is an engineering decision, not a product one: an
 * unspecified database row order would make bootstrap reports, tests and
 * operator evidence differ between runs for no reason.
 *
 * An empty array is a legitimate answer -- the profile has traded nothing, so
 * there is nothing to seed. That is exactly why a malformed symbol throws
 * instead of returning a short list: the two must never be confusable.
 *
 * Database failures are NOT caught. An outage must stay distinguishable from a
 * semantic conclusion about the data.
 */
export async function executionSymbolsForProfile(
  client: Prisma.TransactionClient,
  executionProfileId: string
): Promise<string[]> {
  const rows = await client.tradeExecution.findMany({
    // The only predicate. No status filter and no date filter, by doctrine.
    where: { executionProfileId },
    select: { symbol: true },
    distinct: ["symbol"],
  });

  // Every offending value is collected before throwing, so one run tells an
  // operator the whole story instead of one row at a time.
  const invalidSymbols = rows.map((row) => row.symbol).filter((symbol) => !isCanonicalPersistedSymbol(symbol));
  if (invalidSymbols.length > 0) {
    throw new ExecutionSymbolLineageError(executionProfileId, [...new Set(invalidSymbols)].sort());
  }

  // `distinct` is honoured above; the Set is the defensive half, so uniqueness
  // holds even if that clause were ever dropped or emulated differently.
  // Exact-string only: "BTCUSDT" and "btcusdt" are one valid symbol and one
  // structural error, and the error path above has already refused the pair.
  return [...new Set(rows.map((row) => row.symbol))].sort();
}
