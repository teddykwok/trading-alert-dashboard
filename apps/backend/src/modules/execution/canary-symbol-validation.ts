import { normalizeTradingSymbol } from "../../utils/symbol";
import { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import type { BinanceSymbolFiltersDto } from "../binance/binance.types";

/**
 * Phase 11B.0 — proves a proposed canary symbol is a real, tradable USDⓈ-M
 * perpetual before it becomes the profile's allowlist.
 *
 * The gap this closes was not theoretical: the literal placeholder `<SYMBOL>`
 * was accepted verbatim and written into `allowedSymbols`, because the shared
 * symbol validator only rejects list separators and over-long input. A string
 * that no exchange has ever listed passed every check up to the point where it
 * would have mattered.
 *
 * Everything here is READ-ONLY. The only calls made are the GETs
 * `BinanceReadOnlyService.inspectSymbol()` already performs (`exchangeInfo`,
 * `leverageBracket`, `symbolConfig`) — the same metadata the Phase 3 planner
 * consumes, so "valid here" means "the executor can actually plan this".
 */

/**
 * Binance USDⓈ-M symbols are uppercase alphanumeric with no punctuation:
 * BTCUSDT, ETHUSDT, 1000PEPEUSDT. Brackets, angle brackets and lower case are
 * not near-misses to be corrected — they mean the operator pasted a template.
 */
const FUTURES_SYMBOL_PATTERN = /^[A-Z0-9]{4,24}$/;

/** Filters the planner and executor cannot work without. */
const REQUIRED_FILTERS = ["tickSize", "stepSize", "minQty", "minNotional"] as const;

export const CANARY_SYMBOL_FAILURES = [
  "CANARY_SYMBOL_MALFORMED",
  "CANARY_SYMBOL_NOT_LISTED",
  "CANARY_SYMBOL_NOT_TRADING",
  "CANARY_SYMBOL_NOT_PERPETUAL",
  "CANARY_SYMBOL_FILTERS_INCOMPLETE",
  "CANARY_SYMBOL_LOOKUP_FAILED",
] as const;

export type CanarySymbolFailure = (typeof CANARY_SYMBOL_FAILURES)[number];

export type CanarySymbolValidation =
  | { ok: true; symbol: string; filters: BinanceSymbolFiltersDto }
  | { ok: false; reasonCode: CanarySymbolFailure; message: string };

function isPositiveDecimalString(value: string | null): boolean {
  if (value === null) return false;
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return false;
  return /[1-9]/.test(trimmed);
}

/**
 * Normalizes, then confirms against live exchange metadata.
 *
 * Fails closed on every uncertainty, including a lookup that could not be
 * completed: an unreachable exchange is a reason not to open a canary window,
 * never a reason to assume the symbol is fine.
 */
export async function validateCanarySymbol(
  input: string,
  readOnly: BinanceReadOnlyService = new BinanceReadOnlyService()
): Promise<CanarySymbolValidation> {
  // --- Format, before anything leaves the process ---------------------------
  let symbol: string;
  try {
    symbol = normalizeTradingSymbol(input).normalizedSymbol.toUpperCase();
  } catch (error) {
    return {
      ok: false,
      reasonCode: "CANARY_SYMBOL_MALFORMED",
      message: error instanceof Error ? error.message : "The symbol could not be normalized.",
    };
  }

  if (!FUTURES_SYMBOL_PATTERN.test(symbol)) {
    return {
      ok: false,
      reasonCode: "CANARY_SYMBOL_MALFORMED",
      message: `"${symbol}" is not a Binance USDⓈ-M symbol (expected uppercase letters and digits, e.g. BTCUSDT).`,
    };
  }

  // --- Live metadata, GET only ---------------------------------------------
  let filters: BinanceSymbolFiltersDto;
  try {
    filters = (await readOnly.inspectSymbol(symbol)).filters;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `inspectSymbol` raises UNSUPPORTED_SYMBOL when exchangeInfo has no such
    // row — the case that matters most here.
    if (/not listed|UNSUPPORTED_SYMBOL/i.test(message)) {
      return {
        ok: false,
        reasonCode: "CANARY_SYMBOL_NOT_LISTED",
        message: `${symbol} is not listed on Binance USDⓈ-M futures.`,
      };
    }
    return {
      ok: false,
      reasonCode: "CANARY_SYMBOL_LOOKUP_FAILED",
      message: `Could not confirm ${symbol} against exchange metadata: ${message}`,
    };
  }

  // --- Usable right now, by the same rules the execution stack applies ------
  if ((filters.status ?? "").toUpperCase() !== "TRADING") {
    return {
      ok: false,
      reasonCode: "CANARY_SYMBOL_NOT_TRADING",
      message: `${symbol} status is ${filters.status ?? "unknown"}, not TRADING.`,
    };
  }
  // contractType is absent on some responses; only a KNOWN non-perpetual fails.
  if (filters.contractType !== null && filters.contractType.toUpperCase() !== "PERPETUAL") {
    return {
      ok: false,
      reasonCode: "CANARY_SYMBOL_NOT_PERPETUAL",
      message: `${symbol} contract type is ${filters.contractType}, not PERPETUAL.`,
    };
  }

  const missing = REQUIRED_FILTERS.filter((name) => !isPositiveDecimalString(filters[name]));
  if (missing.length > 0) {
    return {
      ok: false,
      reasonCode: "CANARY_SYMBOL_FILTERS_INCOMPLETE",
      message: `${symbol} is missing usable exchange filters: ${missing.join(", ")}.`,
    };
  }

  return { ok: true, symbol, filters };
}
