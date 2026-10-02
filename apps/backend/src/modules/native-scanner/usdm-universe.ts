import { ScannerDataError } from "./binance-public-futures";

/**
 * The Binance USD-M USDT-PERPETUAL universe, discovered from PUBLIC contract
 * metadata (`/fapi/v1/exchangeInfo`) — never a hard-coded list or count.
 *
 * Pure: it is handed the parsed payload and returns a deterministic answer.
 * The canonical symbol is Binance's bare one ("BTCUSDT"); TradingView's ".P"
 * appears only in `displaySymbol`, never as an identity.
 */

export const UNIVERSE_NAME = "USDM_PERPETUAL_USDT" as const;

/** Exactly the scanner's symbol rule (assertScannerSymbol), as a predicate. */
const SYMBOL = /^[A-Z0-9]{3,30}$/;

export interface UsdmContract {
  readonly symbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly contractType: string;
  readonly status: string;
  /** Listing time per Binance; null when the payload omits it or carries something unusable. */
  readonly onboardDateMs: number | null;
  readonly underlyingType: string | null;
  /** Display only: TradingView's perpetual notation. Never an identity. */
  readonly displaySymbol: string;
}

export type UniverseExclusionReason =
  | "NOT_TRADING"
  | "NOT_PERPETUAL"
  | "NOT_USDT_QUOTED"
  | "INVALID_SYMBOL"
  | "CONFLICTING_DUPLICATE";

export interface UsdmUniverse {
  readonly name: typeof UNIVERSE_NAME;
  /** Eligible contracts, deduplicated, in ascending code-unit order of symbol. */
  readonly contracts: readonly UsdmContract[];
  readonly totalListed: number;
  readonly excluded: Readonly<Record<UniverseExclusionReason, number>>;
  /** Identical duplicate rows collapsed into one. */
  readonly identicalDuplicatesCollapsed: number;
}

const str = (value: unknown, field: string, at: number): string => {
  if (typeof value !== "string" || value === "") throw new ScannerDataError("MALFORMED_RESPONSE", `exchangeInfo symbols[${at}].${field} must be a non-empty string`);
  return value;
};

/** Strict structural parse of exchangeInfo's `symbols` array. Unknown extra fields are ignored. */
export function parseExchangeInfoContracts(payload: unknown): UsdmContract[] {
  const symbols = (payload as { symbols?: unknown } | null)?.symbols;
  if (!Array.isArray(symbols)) throw new ScannerDataError("MALFORMED_RESPONSE", "exchangeInfo must carry a symbols array");
  return symbols.map((row, at) => {
    if (row === null || typeof row !== "object") throw new ScannerDataError("MALFORMED_RESPONSE", `exchangeInfo symbols[${at}] is not an object`);
    const r = row as Record<string, unknown>;
    const symbol = str(r.symbol, "symbol", at);
    // Listing metadata is advisory: a missing or malformed onboardDate is "unknown"
    // (null), never a reason to refuse the universe or to exclude the symbol.
    const onboard = r.onboardDate;
    const onboardDateMs = typeof onboard === "number" && Number.isSafeInteger(onboard) && onboard > 0 ? onboard : null;
    return {
      symbol,
      baseAsset: str(r.baseAsset, "baseAsset", at),
      quoteAsset: str(r.quoteAsset, "quoteAsset", at),
      contractType: str(r.contractType, "contractType", at),
      status: str(r.status, "status", at),
      onboardDateMs,
      underlyingType: typeof r.underlyingType === "string" ? r.underlyingType : null,
      displaySymbol: `${symbol}.P`,
    };
  });
}

function exclusionOf(c: UsdmContract): UniverseExclusionReason | null {
  if (c.status !== "TRADING") return "NOT_TRADING";
  if (c.contractType !== "PERPETUAL") return "NOT_PERPETUAL";
  // quoteAsset decides — never the symbol's suffix.
  if (c.quoteAsset !== "USDT") return "NOT_USDT_QUOTED";
  if (!SYMBOL.test(c.symbol)) return "INVALID_SYMBOL";
  return null;
}

const sameContract = (a: UsdmContract, b: UsdmContract) =>
  a.symbol === b.symbol &&
  a.baseAsset === b.baseAsset &&
  a.quoteAsset === b.quoteAsset &&
  a.contractType === b.contractType &&
  a.status === b.status &&
  a.onboardDateMs === b.onboardDateMs &&
  a.underlyingType === b.underlyingType;

/**
 * TRADING + PERPETUAL + quoteAsset USDT + a valid scanner symbol, deduplicated
 * defensively: identical repeated rows collapse to one; rows that share a
 * symbol but disagree are all excluded (the metadata cannot be trusted).
 */
export function selectUsdtPerpetualUniverse(contracts: readonly UsdmContract[]): UsdmUniverse {
  const excluded: Record<UniverseExclusionReason, number> = {
    NOT_TRADING: 0,
    NOT_PERPETUAL: 0,
    NOT_USDT_QUOTED: 0,
    INVALID_SYMBOL: 0,
    CONFLICTING_DUPLICATE: 0,
  };
  const bySymbol = new Map<string, UsdmContract[]>();
  for (const contract of contracts) bySymbol.set(contract.symbol, [...(bySymbol.get(contract.symbol) ?? []), contract]);

  const eligible: UsdmContract[] = [];
  let identicalDuplicatesCollapsed = 0;
  for (const rows of bySymbol.values()) {
    if (!rows.every((row) => sameContract(row, rows[0]))) {
      excluded.CONFLICTING_DUPLICATE += 1;
      continue;
    }
    identicalDuplicatesCollapsed += rows.length - 1;
    const reason = exclusionOf(rows[0]);
    if (reason !== null) excluded[reason] += 1;
    else eligible.push(rows[0]);
  }
  eligible.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { name: UNIVERSE_NAME, contracts: eligible, totalListed: contracts.length, excluded, identicalDuplicatesCollapsed };
}

// ---------------------------------------------------------------------------
// Operator selection over the universe
// ---------------------------------------------------------------------------

export class UniverseSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniverseSelectionError";
  }
}

export type UniverseSelectionSpec =
  | {
      readonly mode: "UNIVERSE";
      readonly include: readonly string[];
      readonly exclude: readonly string[];
      readonly maxSymbols: number | null;
    }
  | { readonly mode: "EXPLICIT"; readonly symbols: readonly string[] };

export interface UniverseSelection {
  readonly mode: UniverseSelectionSpec["mode"];
  readonly symbols: readonly string[];
  readonly contracts: readonly UsdmContract[];
  /** Universe symbols left out only because of --max-symbols. */
  readonly truncatedByMaxSymbols: number;
}

const refuse = (message: string): never => {
  throw new UniverseSelectionError(message);
};

export interface UniverseCandidate {
  readonly contract: UsdmContract;
  /** Named by the operator (--include-symbols): it must be accepted, never replaced. */
  readonly required: boolean;
}

/**
 * The deterministic WALK ORDER for backfilled selection: included symbols
 * first (sorted, required), then the rest of the eligible universe in order,
 * excluded symbols removed. Nothing is truncated here: the caller accepts
 * candidates from the front until its target is met or the walk ends. The
 * same validation as `selectSymbols` applies (unknown, malformed, duplicate,
 * included-and-excluded all refuse).
 */
export function universeWalk(universe: UsdmUniverse, spec: Extract<UniverseSelectionSpec, { mode: "UNIVERSE" }>): UniverseCandidate[] {
  selectSymbols(universe, { ...spec, maxSymbols: null });
  if (spec.maxSymbols !== null && (!Number.isSafeInteger(spec.maxSymbols) || spec.maxSymbols < 1)) refuse("--max-symbols must be a positive integer");
  if (spec.maxSymbols !== null && spec.include.length > spec.maxSymbols) refuse(`--include-symbols lists ${spec.include.length} symbols, more than --max-symbols ${spec.maxSymbols}`);
  const byName = new Map(universe.contracts.map((c) => [c.symbol, c]));
  const excluded = new Set(spec.exclude);
  const included = [...spec.include].sort();
  const rest = universe.contracts.filter((c) => !excluded.has(c.symbol) && !spec.include.includes(c.symbol));
  return [...included.map((s) => ({ contract: byName.get(s) as UsdmContract, required: true })), ...rest.map((contract) => ({ contract, required: false }))];
}

/** Validates a requested symbol list: well-formed, no duplicates. Nothing is silently dropped. */
export function assertRequestedSymbols(symbols: readonly string[], flag: string): void {
  const bad = symbols.filter((s) => !SYMBOL.test(s));
  if (bad.length > 0) refuse(`${flag} contains malformed symbols: ${bad.join(", ")} (bare uppercase Binance symbols, e.g. BTCUSDT — no ".P", no exchange prefix)`);
  const seen = new Set<string>();
  const dupes = symbols.filter((s) => (seen.has(s) ? true : (seen.add(s), false)));
  if (dupes.length > 0) refuse(`${flag} lists a symbol more than once: ${[...new Set(dupes)].join(", ")}`);
}

/**
 * The deterministic selection. Every requested symbol must be in the eligible
 * universe; one that is not (unknown, delisted, not USDT, not perpetual, not
 * trading) is a refusal that names it, never a silent omission.
 *
 * With --max-symbols, included symbols come first (sorted), then the rest of
 * the universe in order until the limit.
 */
export function selectSymbols(universe: UsdmUniverse, spec: UniverseSelectionSpec): UniverseSelection {
  const byName = new Map(universe.contracts.map((c) => [c.symbol, c]));
  const notEligible = (list: readonly string[]) => list.filter((s) => !byName.has(s));

  if (spec.mode === "EXPLICIT") {
    if (spec.symbols.length === 0) refuse("--symbols is empty");
    assertRequestedSymbols(spec.symbols, "--symbols");
    const missing = notEligible(spec.symbols);
    if (missing.length > 0) refuse(`--symbols names symbols that are not active USDT perpetuals: ${missing.join(", ")}`);
    const symbols = [...spec.symbols].sort();
    return { mode: "EXPLICIT", symbols, contracts: symbols.map((s) => byName.get(s) as UsdmContract), truncatedByMaxSymbols: 0 };
  }

  assertRequestedSymbols(spec.include, "--include-symbols");
  assertRequestedSymbols(spec.exclude, "--exclude-symbols");
  const both = spec.include.filter((s) => spec.exclude.includes(s));
  if (both.length > 0) refuse(`symbols both included and excluded: ${both.join(", ")}`);
  const missingInclude = notEligible(spec.include);
  if (missingInclude.length > 0) refuse(`--include-symbols names symbols that are not active USDT perpetuals: ${missingInclude.join(", ")}`);
  const missingExclude = notEligible(spec.exclude);
  if (missingExclude.length > 0) refuse(`--exclude-symbols names symbols that are not active USDT perpetuals: ${missingExclude.join(", ")}`);
  if (spec.maxSymbols !== null) {
    if (!Number.isSafeInteger(spec.maxSymbols) || spec.maxSymbols < 1) refuse("--max-symbols must be a positive integer");
    if (spec.include.length > spec.maxSymbols) refuse(`--include-symbols lists ${spec.include.length} symbols, more than --max-symbols ${spec.maxSymbols}`);
  }

  const excluded = new Set(spec.exclude);
  const included = [...spec.include].sort();
  const rest = universe.contracts.map((c) => c.symbol).filter((s) => !excluded.has(s) && !spec.include.includes(s));
  const all = [...included, ...rest];
  const limit = spec.maxSymbols ?? all.length;
  const symbols = all.slice(0, limit).sort();
  return {
    mode: "UNIVERSE",
    symbols,
    contracts: symbols.map((s) => byName.get(s) as UsdmContract),
    truncatedByMaxSymbols: all.length - symbols.length,
  };
}
