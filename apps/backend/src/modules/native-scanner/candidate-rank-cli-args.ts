import { SOURCE_TIMEFRAMES, type NativeSourceTf } from "@trading-alert-dashboard/shared";

import { DEFAULT_DELIVERY_SOURCE_TFS, type RankingOptions } from "./candidate-ranker";
import { MAX_TOTAL_REQUESTS_CEILING, type CandidateRankRequest } from "./candidate-rank-runner";
import { CONSERVATIVE_REQUEST_POLICY, REQUEST_POLICY_LIMITS } from "./kline-fetcher";
import { LINEAGE_CONFIG_OPTIONS, LiveShadowCliUsageError, parseLineageConfig } from "./live-shadow-cli-args";
import type { UniverseSelectionSpec } from "./usdm-universe";

/**
 * Arguments for the READ-ONLY candidate ranker.
 *
 * The signal configuration is parsed by the SAME function the live shadow
 * scanner uses, so a ranking and a live scan of the same flags reconstruct the
 * same lineage. There is no account, execution, order, alert or database
 * option, and none can be expressed: anything unlisted is refused.
 */

export class CandidateRankCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateRankCliUsageError";
  }
}

const SELECTION_VALUES = ["--universe", "--symbols", "--include-symbols", "--exclude-symbols", "--max-symbols"] as const;
const RANKING_VALUES = ["--delivery-source-timeframes", "--top", "--max-per-symbol", "--concurrency", "--max-total-requests", "--request-spacing-ms"] as const;
const FLAGS = ["--json", "--include-not-ready", "--universe-only", "--cache-only"] as const;
const VALUES: readonly string[] = [...LINEAGE_CONFIG_OPTIONS, ...SELECTION_VALUES, ...RANKING_VALUES];

export const UNIVERSE_USDT_PERPETUAL = "usdt-perpetual";
export const DEFAULT_TOP = 20;
export const DEFAULT_MAX_PER_SYMBOL = 1;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 4;
/** Enough for one warm run over a few hundred symbols (server time + one page each). */
export const DEFAULT_MAX_TOTAL_REQUESTS = 2_000;

export const CANDIDATE_RANK_CLI_USAGE = [
  "Usage (READ-ONLY CANDIDATE RANKING — not an alert, not actionable, no order authority):",
  "  scanner:candidate-rank (--universe usdt-perpetual | --symbols A,B,...) --interval 15m",
  "    --history-start 2026-01-01T00:00:00Z --switchover 2026-09-12T01:00:00Z",
  "    --min-move-percent 7 --touch-tolerance-percent 1 --cooldown-bars 10",
  "    --min-bars-after-creation 5 --min-bars-after-arming 4",
  "    --source-timeframes 1D,1W,1M,3M,6M,12M --max-levels 500 --timing Immediate",
  "    --partial-period-policy SWITCHOVER_TRUNCATED_CLOSED_BARS",
  "    [--include-symbols A,B] [--exclude-symbols C] [--max-symbols N]   (with --universe only)",
  "    [--delivery-source-timeframes 1D,1W] [--top 20] [--max-per-symbol 1] [--include-not-ready]",
  `    [--concurrency ${DEFAULT_CONCURRENCY}] [--max-total-requests ${DEFAULT_MAX_TOTAL_REQUESTS}] [--request-spacing-ms ${CONSERVATIVE_REQUEST_POLICY.minSpacingMs}]`,
  "    [--cache-only] [--universe-only] [--json]",
].join("\n");

export interface CandidateRankCliOptions {
  readonly request: CandidateRankRequest;
  readonly json: boolean;
  readonly maxTotalRequests: number;
  readonly minSpacingMs: number;
}

const usage = (message: string): never => {
  throw new CandidateRankCliUsageError(message);
};

function boundedInt(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) usage(`${name} must be an integer`);
  const n = Number(value);
  if (n < min || n > max) usage(`${name} must be ${min}..${max}`);
  return n;
}

const list = (value: string) => value.split(",").map((s) => s.trim());

export function parseCandidateRankCliArgs(argv: readonly string[]): CandidateRankCliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if ((FLAGS as readonly string[]).includes(token)) {
      if (flags.has(token)) usage(`${token} given twice`);
      flags.add(token);
      continue;
    }
    if (!VALUES.includes(token)) usage(`unexpected argument: ${token}`);
    if (values.has(token)) usage(`${token} given twice`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usage(`${token} needs a value`);
    values.set(token, value);
    i += 1;
  }
  const missing = LINEAGE_CONFIG_OPTIONS.filter((name) => !values.has(name));
  if (missing.length > 0) usage(`missing required: ${missing.join(", ")}`);
  const get = (name: string) => values.get(name) as string;

  let lineage;
  try {
    lineage = parseLineageConfig(get);
  } catch (error) {
    if (error instanceof LiveShadowCliUsageError) usage(error.message);
    throw error;
  }

  // ---- selection: exactly one base, and only compatible modifiers ----------
  const hasUniverse = values.has("--universe");
  const hasSymbols = values.has("--symbols");
  if (hasUniverse === hasSymbols) usage("give exactly one of --universe usdt-perpetual or --symbols");
  let selection: UniverseSelectionSpec;
  if (hasUniverse) {
    if (get("--universe") !== UNIVERSE_USDT_PERPETUAL) usage(`--universe must be ${UNIVERSE_USDT_PERPETUAL}`);
    selection = {
      mode: "UNIVERSE",
      include: values.has("--include-symbols") ? list(get("--include-symbols")) : [],
      exclude: values.has("--exclude-symbols") ? list(get("--exclude-symbols")) : [],
      maxSymbols: values.has("--max-symbols") ? boundedInt(get("--max-symbols"), "--max-symbols", 1, 10_000) : null,
    };
  } else {
    for (const flag of ["--include-symbols", "--exclude-symbols", "--max-symbols"]) {
      if (values.has(flag)) usage(`${flag} only applies with --universe; with --symbols, list exactly the symbols wanted`);
    }
    selection = { mode: "EXPLICIT", symbols: list(get("--symbols")) };
  }

  // ---- ranking --------------------------------------------------------------
  // Default: NATIVE_DELIVERY_V1's allowlist, limited to the timeframes this lineage enables.
  // An explicit list must be a subset of the enabled ones (checked below).
  const deliverySourceTfs = values.has("--delivery-source-timeframes")
    ? (list(get("--delivery-source-timeframes")) as NativeSourceTf[])
    : DEFAULT_DELIVERY_SOURCE_TFS.filter((tf) => lineage.engine.enabledSourceTfs.includes(tf));
  if (deliverySourceTfs.length === 0) usage("no delivery source timeframe is enabled in --source-timeframes");
  const unknownTf = deliverySourceTfs.filter((tf) => !(SOURCE_TIMEFRAMES as readonly string[]).includes(tf));
  if (unknownTf.length > 0) usage(`--delivery-source-timeframes has unknown timeframes: ${unknownTf.join(", ")}`);
  if (new Set(deliverySourceTfs).size !== deliverySourceTfs.length) usage("--delivery-source-timeframes lists a timeframe twice");
  const notEnabled = deliverySourceTfs.filter((tf) => !lineage.engine.enabledSourceTfs.includes(tf));
  if (notEnabled.length > 0) usage(`--delivery-source-timeframes must be enabled in --source-timeframes: ${notEnabled.join(", ")}`);
  const ranking: RankingOptions = {
    deliverySourceTfs,
    includeNotReady: flags.has("--include-not-ready"),
    top: values.has("--top") ? boundedInt(get("--top"), "--top", 1, 1_000) : DEFAULT_TOP,
    maxPerSymbol: values.has("--max-per-symbol") ? boundedInt(get("--max-per-symbol"), "--max-per-symbol", 1, 1_000) : DEFAULT_MAX_PER_SYMBOL,
  };

  const universeOnly = flags.has("--universe-only");
  if (universeOnly && (flags.has("--include-not-ready") || flags.has("--cache-only") || values.has("--top") || values.has("--max-per-symbol"))) {
    usage("--universe-only lists the universe and selection only; ranking options do not apply");
  }

  return {
    request: {
      lineage,
      selection,
      ranking,
      concurrency: values.has("--concurrency") ? boundedInt(get("--concurrency"), "--concurrency", 1, MAX_CONCURRENCY) : DEFAULT_CONCURRENCY,
      cacheOnly: flags.has("--cache-only"),
      universeOnly,
    },
    json: flags.has("--json"),
    maxTotalRequests: values.has("--max-total-requests")
      ? boundedInt(get("--max-total-requests"), "--max-total-requests", 4, MAX_TOTAL_REQUESTS_CEILING)
      : DEFAULT_MAX_TOTAL_REQUESTS,
    minSpacingMs: values.has("--request-spacing-ms")
      ? boundedInt(get("--request-spacing-ms"), "--request-spacing-ms", REQUEST_POLICY_LIMITS.minSpacingFloorMs, 60_000)
      : CONSERVATIVE_REQUEST_POLICY.minSpacingMs,
  };
}
