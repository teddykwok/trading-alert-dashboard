import { normalizeTradingSymbol } from "../../utils/symbol";
import type { BinanceSymbolFiltersDto } from "../binance/binance.types";

/**
 * Parsing and eligibility for the operator-managed symbol allowlist.
 *
 * Everything here is PURE: it takes text and exchange metadata and returns a
 * verdict. No Prisma, no Binance client, no environment. That is what lets the
 * whole surface — including the ~600-symbol paste — be tested without a
 * database, a network or a running runtime.
 *
 * Two rules shape the design:
 *
 *   1. There is exactly ONE normalizer. Every entry goes through the shared
 *      `normalizeTradingSymbol`, the same function the webhook uses, so a
 *      symbol the operator allows is spelled the way an inbound alert will be.
 *   2. An empty result is a REFUSAL, never a wildcard. `allowedSymbols = []`
 *      means "allow all" to the admission engine, so a textarea that parsed to
 *      nothing must never reach the database.
 */

/** The paste is an operator convenience, not an import pipeline. */
export const ALLOWLIST_MAX_INPUT_LENGTH = 64_000;
export const ALLOWLIST_MAX_ENTRIES = 1_000;
export const ALLOWLIST_MAX_ACCEPTED = 800;

/**
 * Binance USDⓈ-M symbols are uppercase alphanumeric with no punctuation.
 * Identical to the canary validator's rule, and the reason Unicode tickers,
 * `ETH/BTC` style pairs and template placeholders fail before any lookup.
 */
const FUTURES_SYMBOL_PATTERN = /^[A-Z0-9]{4,24}$/;

/** Filters the planner and executor cannot work without. */
const REQUIRED_FILTERS = ["tickSize", "stepSize", "minQty", "minNotional"] as const;

/** The only collateral asset this execution profile supports. */
const USDT_ASSET = "USDT";

export const ALLOWLIST_REJECTIONS = [
  "INVALID_SYNTAX",
  "UNSUPPORTED_CONTRACT",
  "NOT_FUTURES_ELIGIBLE",
  "NOT_TRADABLE",
  "NOT_EXECUTION_ENGINE_SUPPORTED",
  /**
   * Deliberately the SAME name the admission engine uses for this refusal.
   *
   * The two layers are independent — the execution gate does not trust this
   * one — but they enforce one product policy, and an operator who sees the
   * code here and again in an execution journal should not have to work out
   * whether they are looking at the same rule.
   */
  "USDT_ONLY_CONTRACT_REQUIRED",
] as const;

export type AllowlistRejection = (typeof ALLOWLIST_REJECTIONS)[number];

export interface AllowlistRejectedEntry {
  /** The operator's own text, so they can find it in their paste. */
  input: string;
  /** Present once normalization succeeded and a later rule refused it. */
  symbol: string | null;
  reasonCode: AllowlistRejection;
  detail: string;
}

export interface AllowlistParseResult {
  /** Non-empty entries found in the raw text, before any normalization. */
  inputCount: number;
  /** Entries that produced a usable futures symbol, before de-duplication. */
  normalizedCount: number;
  /** Normalized symbols in first-seen order, de-duplicated. */
  symbols: string[];
  /** How many normalized entries were repeats of an earlier one. */
  duplicateCount: number;
  rejected: AllowlistRejectedEntry[];
}

/** Commas, newlines, semicolons and tabs all separate; runs collapse. */
const SEPARATORS = /[\s,;]+/;

/**
 * Splits and normalizes an operator paste.
 *
 * Deliberately linear: one pass over the entries, a Set for membership, so a
 * 600-symbol list costs 600 normalizations and 600 hash lookups rather than a
 * quadratic scan. Order is preserved because the operator recognises their own
 * list better than an alphabetical one.
 */
export function parseAllowlistInput(raw: string): AllowlistParseResult {
  const rejected: AllowlistRejectedEntry[] = [];

  if (raw.length > ALLOWLIST_MAX_INPUT_LENGTH) {
    return {
      inputCount: 0,
      normalizedCount: 0,
      symbols: [],
      duplicateCount: 0,
      rejected: [
        {
          input: "",
          symbol: null,
          reasonCode: "INVALID_SYNTAX",
          detail: `The pasted list is larger than ${ALLOWLIST_MAX_INPUT_LENGTH} characters.`,
        },
      ],
    };
  }

  const entries = raw.split(SEPARATORS).filter((entry) => entry.length > 0);

  if (entries.length > ALLOWLIST_MAX_ENTRIES) {
    return {
      inputCount: entries.length,
      normalizedCount: 0,
      symbols: [],
      duplicateCount: 0,
      rejected: [
        {
          input: "",
          symbol: null,
          reasonCode: "INVALID_SYNTAX",
          detail: `The pasted list has ${entries.length} entries; at most ${ALLOWLIST_MAX_ENTRIES} are accepted.`,
        },
      ],
    };
  }

  const seen = new Set<string>();
  const symbols: string[] = [];
  let normalizedCount = 0;
  let duplicateCount = 0;

  for (const entry of entries) {
    let symbol: string;
    try {
      // The shared normalizer: strips an EXCHANGE: prefix, folds the ".P"
      // perpetual suffix into market type, uppercases and rejects list junk.
      symbol = normalizeTradingSymbol(entry).normalizedSymbol.toUpperCase();
    } catch (error) {
      rejected.push({
        input: entry,
        symbol: null,
        reasonCode: "INVALID_SYNTAX",
        detail: error instanceof Error ? error.message : "The symbol could not be normalized.",
      });
      continue;
    }

    if (!FUTURES_SYMBOL_PATTERN.test(symbol)) {
      rejected.push({
        input: entry,
        symbol,
        reasonCode: "INVALID_SYNTAX",
        detail: `"${symbol}" is not a Binance USDⓈ-M symbol (expected 4-24 uppercase letters and digits).`,
      });
      continue;
    }

    // Counted only once the entry has produced a symbol the executor could
    // actually use, so "normalized" never flatters a template placeholder.
    normalizedCount += 1;

    if (seen.has(symbol)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(symbol);
    symbols.push(symbol);
  }

  return { inputCount: entries.length, normalizedCount, symbols, duplicateCount, rejected };
}

// ---------------------------------------------------------------------------
// Eligibility against exchange metadata
// ---------------------------------------------------------------------------

/** One symbol's metadata, keyed by symbol. Built from ONE exchangeInfo read. */
export type SymbolMetadataIndex = ReadonlyMap<string, BinanceSymbolFiltersDto>;

function isPositiveDecimalString(value: string | null): boolean {
  if (value === null) return false;
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return false;
  return /[1-9]/.test(trimmed);
}

/**
 * Applies the SAME rules `validateCanarySymbol` applies to a single symbol.
 *
 * Kept as a pure function over an already-fetched index so validating 600
 * symbols costs one exchange read rather than 600. The rules themselves are
 * not relaxed: listed, TRADING, PERPETUAL, and carrying every filter the
 * planner needs. Anything else the execution engine cannot safely trade.
 */
export function judgeSymbolEligibility(
  symbol: string,
  metadata: SymbolMetadataIndex
): { ok: true } | { ok: false; reasonCode: AllowlistRejection; detail: string } {
  const filters = metadata.get(symbol);
  if (!filters) {
    return {
      ok: false,
      reasonCode: "NOT_FUTURES_ELIGIBLE",
      detail: `${symbol} is not listed on Binance USDⓈ-M futures.`,
    };
  }

  if ((filters.status ?? "").toUpperCase() !== "TRADING") {
    return {
      ok: false,
      reasonCode: "NOT_TRADABLE",
      detail: `${symbol} status is ${filters.status ?? "unknown"}, not TRADING.`,
    };
  }

  // contractType is absent on some rows; only a KNOWN non-perpetual fails.
  if (filters.contractType !== null && filters.contractType.toUpperCase() !== "PERPETUAL") {
    return {
      ok: false,
      reasonCode: "UNSUPPORTED_CONTRACT",
      detail: `${symbol} contract type is ${filters.contractType}, not PERPETUAL.`,
    };
  }

  /**
   * USDT-only collateral, the same positive allow rule the admission engine
   * applies. Both assets must be READ and both must be USDT.
   *
   * `USDCUSDT` passes and `BNBUSDC` does not, which is the case a substring or
   * suffix test gets wrong in both directions — the base asset is irrelevant,
   * only what the contract is quoted and margined in matters.
   *
   * Unlike `contractType` above, a MISSING asset is refused rather than waved
   * through. That asymmetry is intentional: contract type has a documented
   * default shape, whereas an unconfirmed collateral asset is exactly what
   * this rule exists to refuse. Validation has no retry to fall back on, so
   * "cannot confirm" must fail here, with a detail that does not accuse the
   * contract of being something it was never shown to be.
   */
  const quoteAsset = (filters.quoteAsset ?? "").trim().toUpperCase();
  const marginAsset = (filters.marginAsset ?? "").trim().toUpperCase();
  if (quoteAsset === "" || marginAsset === "") {
    return {
      ok: false,
      reasonCode: "USDT_ONLY_CONTRACT_REQUIRED",
      detail: `${symbol} did not report both a quote asset and a margin asset, so it cannot be confirmed as a ${USDT_ASSET}-margined contract.`,
    };
  }
  if (quoteAsset !== USDT_ASSET || marginAsset !== USDT_ASSET) {
    return {
      ok: false,
      reasonCode: "USDT_ONLY_CONTRACT_REQUIRED",
      detail: `${symbol} is quoted in ${quoteAsset} and margined in ${marginAsset}; only ${USDT_ASSET}-quoted, ${USDT_ASSET}-margined contracts are supported.`,
    };
  }

  const missing = REQUIRED_FILTERS.filter((name) => !isPositiveDecimalString(filters[name]));
  if (missing.length > 0) {
    return {
      ok: false,
      reasonCode: "NOT_EXECUTION_ENGINE_SUPPORTED",
      detail: `${symbol} is missing usable exchange filters: ${missing.join(", ")}.`,
    };
  }

  return { ok: true };
}

export interface AllowlistValidation {
  /** True only when at least one symbol survived every rule. */
  ok: boolean;
  counts: {
    input: number;
    normalized: number;
    valid: number;
    duplicates: number;
    rejected: number;
  };
  /** The symbols that would be saved, in first-seen order. */
  accepted: string[];
  rejected: AllowlistRejectedEntry[];
  /** Set when `ok` is false and nothing may be saved. */
  refusal: string | null;
}

/**
 * The complete verdict for a paste: parse, then judge each survivor.
 *
 * An empty accepted list is reported as a refusal rather than an empty save,
 * because the admission engine reads `[]` as "no restriction". That is the one
 * outcome this feature must never produce by accident.
 */
export function validateAllowlist(raw: string, metadata: SymbolMetadataIndex): AllowlistValidation {
  const parsed = parseAllowlistInput(raw);
  const rejected = [...parsed.rejected];
  const accepted: string[] = [];

  for (const symbol of parsed.symbols) {
    const verdict = judgeSymbolEligibility(symbol, metadata);
    if (verdict.ok) accepted.push(symbol);
    else rejected.push({ input: symbol, symbol, reasonCode: verdict.reasonCode, detail: verdict.detail });
  }

  const counts = {
    input: parsed.inputCount,
    normalized: parsed.normalizedCount,
    valid: accepted.length,
    duplicates: parsed.duplicateCount,
    rejected: rejected.length,
  };

  if (accepted.length === 0) {
    return {
      ok: false,
      counts,
      accepted,
      rejected,
      refusal:
        "No symbol survived validation. An empty allowlist would mean ALL symbols are permitted, so nothing was saved.",
    };
  }

  if (accepted.length > ALLOWLIST_MAX_ACCEPTED) {
    return {
      ok: false,
      counts,
      accepted,
      rejected,
      refusal: `${accepted.length} symbols were accepted; at most ${ALLOWLIST_MAX_ACCEPTED} may be saved.`,
    };
  }

  return { ok: true, counts, accepted, rejected, refusal: null };
}

/**
 * A short, log-safe description of a validation.
 *
 * Deliberately counts-only: a 600-symbol paste must not put 600 lines into the
 * application log, and the operator already sees the detail in the browser.
 */
export function summarizeAllowlist(validation: AllowlistValidation): string {
  const { input, normalized, valid, duplicates, rejected } = validation.counts;
  return `input=${input} normalized=${normalized} valid=${valid} duplicates=${duplicates} rejected=${rejected}`;
}

/** A concise preview for panels and confirmation dialogs. */
export function previewSymbols(symbols: readonly string[], limit = 6): string {
  if (symbols.length === 0) return "(none)";
  if (symbols.length <= limit) return symbols.join(", ");
  return `${symbols.slice(0, limit).join(", ")}, … (+${symbols.length - limit} more)`;
}
