import type { BinanceReadOnlyService } from "./binance-read-only.service";

/**
 * The pre-shutdown exchange check, as decision logic.
 *
 * ## What it is for
 *
 * Stopping an execution worker stops the thing that protects and reconciles
 * open exposure. The launcher's shutdown guard already refuses unless both
 * accounts report SAFE OFF with nothing outstanding -- but that guard reads the
 * DATABASE. It answers "does this system believe it has work?", which is a
 * different question from "is the exchange flat?". An order or position the
 * database does not know about would pass the first question and fail the
 * second, and the worker is exactly what would have noticed.
 *
 * So this asks the exchange, and it asks in the only direction that is safe to
 * ask in: three allowlisted GETs, no cancel, no close, no setup.
 *
 * ## Three ACCOUNT-WIDE reads, and why that matters
 *
 * Every read here is account-wide, including the conditional book. An earlier
 * draft swept conditional orders per symbol, over the union of symbols holding
 * a position, symbols with a standard order, and the profile's allowed list.
 * That could only ever prove the book empty FOR THE SYMBOLS IT ASKED ABOUT --
 * an orphan on any other symbol read as absence, which is precisely the
 * failure a pre-shutdown check exists to catch. The account-wide form has no
 * such blind spot, and the proof no longer depends on the profile allowlist
 * being complete.
 *
 * ## What it reports, and what it refuses to report
 *
 * COUNTS. Not balances, not symbols, not order ids, not quantities, not the
 * account identifier. A pre-shutdown check needs to know whether the book is
 * empty; it does not need to describe what is in it, and anything it describes
 * is something that can end up in a terminal scrollback or a pasted report.
 *
 * ## Why UNKNOWN is a refusal, not a zero
 *
 * "We could not read the book" and "the book is empty" are different facts and
 * only one of them is safe to stop a worker on. Every read that throws becomes
 * UNKNOWN, and any UNKNOWN blocks.
 */

/** A count we obtained, or the fact that we could not obtain it. */
export type CountResult = { known: true; count: number } | { known: false };

export interface PreShutdownCounts {
  readonly nonZeroPositions: CountResult;
  readonly standardOpenOrders: CountResult;
  readonly openAlgoOrders: CountResult;
}

/**
 * The narrow read surface, so a test can supply one without a Binance client.
 *
 * All three take no symbol. That is the contract, not a convenience: a symbol
 * parameter here would be a way to narrow a check whose whole value is that it
 * is not narrowed.
 */
export interface PreShutdownReads {
  getPositionRisk: () => ReturnType<BinanceReadOnlyService["getPositionRisk"]>;
  getOpenOrders: () => ReturnType<BinanceReadOnlyService["getOpenOrders"]>;
  getOpenAlgoOrdersAccountWide: BinanceReadOnlyService["getOpenAlgoOrdersAccountWide"];
}

/**
 * Performs the three reads. Every failure becomes UNKNOWN rather than throwing,
 * so one unreadable endpoint still produces a complete, blocking report instead
 * of a stack trace that says nothing about the other two.
 */
export async function collectPreShutdownCounts(reads: PreShutdownReads): Promise<PreShutdownCounts> {
  const count = async (read: () => Promise<{ length: number }>): Promise<CountResult> => {
    try {
      return { known: true, count: (await read()).length };
    } catch {
      return { known: false };
    }
  };

  return {
    // Already filtered to non-zero by the service.
    nonZeroPositions: await count(() => reads.getPositionRisk()),
    standardOpenOrders: await count(() => reads.getOpenOrders()),
    openAlgoOrders: await count(() => reads.getOpenAlgoOrdersAccountWide()),
  };
}

export type PreShutdownVerdict = { pass: true } | { pass: false; reasons: string[] };

/**
 * PASS only when all three counts are KNOWN and all three are zero.
 *
 * Every other combination blocks, including a count we could not read. The
 * reasons name the category and the number; they never name a symbol.
 */
export function evaluatePreShutdownExchange(counts: PreShutdownCounts): PreShutdownVerdict {
  const reasons: string[] = [];
  const check = (label: string, result: CountResult): void => {
    if (!result.known) {
      reasons.push(`${label} could not be read; it is not assumed to be zero.`);
      return;
    }
    if (result.count > 0) reasons.push(`${label}: ${result.count} outstanding.`);
  };
  check("non-zero positions", counts.nonZeroPositions);
  check("standard open orders", counts.standardOpenOrders);
  check("open conditional (algo) orders", counts.openAlgoOrders);
  return reasons.length === 0 ? { pass: true } : { pass: false, reasons };
}

const show = (result: CountResult): string => (result.known ? String(result.count) : "UNKNOWN");

/** The report. Three counts; nothing else leaves this function. */
export function renderPreShutdownReport(
  counts: PreShutdownCounts,
  verdict: PreShutdownVerdict
): string[] {
  const lines = [
    "",
    "PRE-SHUTDOWN EXCHANGE CHECK",
    "",
    `binding             = accepted`,
    `nonZeroPositions    = ${show(counts.nonZeroPositions)}`,
    `standardOpenOrders  = ${show(counts.standardOpenOrders)}`,
    `openAlgoOrders      = ${show(counts.openAlgoOrders)}`,
    `exchangeMutation    = none`,
    "",
  ];
  if (verdict.pass) {
    lines.push("PASS — exchange reports no positions or open orders for this account.");
    return lines;
  }
  lines.push("BLOCKED — do NOT stop this account's execution worker:");
  for (const reason of verdict.reasons) lines.push(`  - ${reason}`);
  return lines;
}
