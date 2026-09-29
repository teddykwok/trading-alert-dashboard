import type { PrismaClient } from "@prisma/client";

import { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import { BinanceReadOnlyClient } from "../binance/binance.client";
import {
  collectPreShutdownCounts,
  evaluatePreShutdownExchange,
  type CountResult,
  type PreShutdownCounts,
  type PreShutdownReads,
} from "../binance/pre-shutdown-exchange-check";
import {
  bindConfiguredExchangeRuntime,
  exchangeClientOptionsOf,
} from "../execution/exchange-runtime-binding";

/**
 * Exchange flatness, as a readiness answer the operator UI can ask for.
 *
 * ## Why this exists separately from the CLI check
 *
 * Moving an account from SAFE to LIVE-READY restarts its execution worker --
 * the process that protects and reconciles open exposure. The CLI already
 * proves the exchange is flat before an intentional shutdown, but it proves it
 * for the account whose env file the SHELL happened to name, and it prints to
 * a terminal. A transition driven from the operator surface needs the same
 * proof, for the account that is actually being moved, in a form a precondition
 * evaluator can consume.
 *
 * So this reuses the check rather than restating it: the same three account-wide
 * reads, the same UNKNOWN-is-not-zero rule, the same verdict function. The only
 * thing added is a wire shape.
 *
 * ## Account scoping is structural, not a parameter
 *
 * There is no account argument. Each account's control plane runs with its own
 * `DOTENV_CONFIG_PATH` and answers on its own loopback port with its own
 * operator token, and the binding this uses resolves THAT process's account.
 * Asking Account A's control plane can only ever return Account A's exchange
 * state, and no argument exists that would make it answer for Account B.
 *
 * ## What it must never return
 *
 * Counts and a verdict. No symbol, no order id, no quantity, no balance, no
 * account identifier, no credential, no endpoint. A readiness panel needs to
 * know whether the book is empty; describing what is in it puts positions into
 * a browser tab, a screenshot and a support paste.
 *
 * ## Read-only, structurally
 *
 * The only client this module builds is the READ-ONLY one, and it builds it
 * from the 11D bound runtime -- the single binding that establishes the
 * profile and the credentials together, so a flatness verdict can never
 * describe one account's book while another account's profile was resolved.
 *
 * `readExchangeFlatness` itself is handed three GETs and nothing else. There
 * is no client in scope there to place, cancel, close or configure anything
 * with, and adding one would mean changing its signature.
 *
 * The binding lives HERE rather than in the Trading Control service on
 * purpose: that service resolves execution profiles directly, and a module
 * that does both could establish the two halves independently. This one
 * resolves nothing.
 */

/** A count on the wire: the number, or the admission that we do not have it. */
export interface FlatnessCountDto {
  readonly known: boolean;
  /** The count when known; null when it could not be read. NEVER zero for unknown. */
  readonly count: number | null;
}

export interface ExchangeFlatnessDto {
  /**
   * Whether every signed read in this check succeeded.
   *
   * All three reads are signed, so one failure means the account was only
   * partially readable -- which is not a readable account. It is reported
   * separately from the counts so a panel can distinguish "the exchange says
   * there is exposure" from "we could not ask".
   */
  readonly signedRequestWorks: boolean;
  readonly nonZeroPositions: FlatnessCountDto;
  readonly standardOpenOrders: FlatnessCountDto;
  readonly openAlgoOrders: FlatnessCountDto;
  /** True only when all three are KNOWN and all three are zero. */
  readonly flat: boolean;
  /** Category-level reasons. Never a symbol, an id or a quantity. */
  readonly reasons: readonly string[];
  readonly generatedAt: string;
}

const onWire = (result: CountResult): FlatnessCountDto =>
  result.known ? { known: true, count: result.count } : { known: false, count: null };

/**
 * Turns the three counts into the wire body. Pure.
 *
 * Constructed field by field rather than spread, for the same reason the
 * historical-fill serializer is: a field the counts grow later cannot reach a
 * browser until someone adds it here deliberately.
 */
export function describeExchangeFlatness(counts: PreShutdownCounts, generatedAt: string): ExchangeFlatnessDto {
  const verdict = evaluatePreShutdownExchange(counts);
  return {
    signedRequestWorks:
      counts.nonZeroPositions.known && counts.standardOpenOrders.known && counts.openAlgoOrders.known,
    nonZeroPositions: onWire(counts.nonZeroPositions),
    standardOpenOrders: onWire(counts.standardOpenOrders),
    openAlgoOrders: onWire(counts.openAlgoOrders),
    flat: verdict.pass,
    reasons: verdict.pass ? [] : verdict.reasons,
    generatedAt,
  };
}

/** Everything the reader needs, injected so a test needs no Binance client. */
export interface ExchangeFlatnessDeps {
  /**
   * Resolves the read surface for THIS process's account, or explains why it
   * could not. A binding failure is not an empty book.
   */
  readonly openReads: () => Promise<
    { readonly ok: true; readonly reads: PreShutdownReads } | { readonly ok: false; readonly reasonCode: string }
  >;
  readonly now: () => Date;
}

/** The three unreadable counts a failed binding produces. */
const NOTHING_READ: PreShutdownCounts = {
  nonZeroPositions: { known: false },
  standardOpenOrders: { known: false },
  openAlgoOrders: { known: false },
};

/**
 * Reads exchange flatness for the account this process is bound to.
 *
 * A binding failure reports three UNKNOWNs and a blocking verdict rather than
 * throwing: the caller asked whether the account is provably flat, and "we
 * could not establish which account this is" is a complete, blocking answer to
 * that question. The reason code names the binding failure, never the account.
 */
export async function readExchangeFlatness(deps: ExchangeFlatnessDeps): Promise<ExchangeFlatnessDto> {
  const opened = await deps.openReads();
  if (!opened.ok) {
    const blocked = describeExchangeFlatness(NOTHING_READ, deps.now().toISOString());
    return {
      ...blocked,
      reasons: [`the exchange could not be reached for this account (${opened.reasonCode}).`, ...blocked.reasons],
    };
  }
  const counts = await collectPreShutdownCounts(opened.reads);
  return describeExchangeFlatness(counts, deps.now().toISOString());
}

/**
 * Binds this process's account and hands back the three GETs. Nothing else.
 *
 * ONE binding, so the profile and the credentials come from the same place.
 * The client it builds is read-only; no trading or account-setup client is
 * constructed here and none is reachable from what this returns, so the
 * flatness route has no path to an exchange mutation even if a later caller
 * misuses it.
 */
export function boundReadsFor(prisma: PrismaClient): ExchangeFlatnessDeps["openReads"] {
  return async () => {
    const bound = await bindConfiguredExchangeRuntime(prisma);
    if (!bound.ok) return { ok: false, reasonCode: bound.reasonCode };

    const service = new BinanceReadOnlyService(
      new BinanceReadOnlyClient(exchangeClientOptionsOf(bound.runtime))
    );
    // Account-wide, all three. No symbol is passed anywhere: the completeness
    // of this proof must not depend on a symbol list being complete.
    return {
      ok: true,
      reads: {
        getPositionRisk: () => service.getPositionRisk(),
        getOpenOrders: () => service.getOpenOrders(),
        getOpenAlgoOrdersAccountWide: () => service.getOpenAlgoOrdersAccountWide(),
      },
    };
  };
}
