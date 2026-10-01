import {
  NATIVE_TIMING_MODES,
  NativeSignalInputError,
  createNativeEngineConfig,
  pinePercentInputToFraction,
  type NativeSourceTf,
  type NativeTimingMode,
} from "@trading-alert-dashboard/shared";

import {
  SCANNER_MARKET_TYPE,
  ScannerDataError,
  assertScannerSymbol,
  intervalMsOf,
  type ScannerChartInterval,
} from "./binance-public-futures";
import { CONSERVATIVE_REQUEST_POLICY, assertRequestPolicy, type PublicRequestPolicy } from "./kline-fetcher";
import { assertReplayRequest, type HistoricalReplayRequest } from "./historical-replay";

/**
 * Arguments for ONE historical replay of ONE symbol.
 *
 * Everything that shapes the result is REQUIRED — the warmup anchor and every
 * engine input — because a default here would be a silent choice about levels
 * that never expire. There is no universe, list or "all symbols" mode, and no
 * network unless `--fetch` is given.
 */

export class ReplayCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayCliUsageError";
  }
}

const REQUIRED = [
  "--symbol",
  "--interval",
  "--warmup-start",
  "--output-start",
  "--end",
  "--min-move-percent",
  "--touch-tolerance-percent",
  "--cooldown-bars",
  "--min-bars-after-creation",
  "--min-bars-after-arming",
  "--source-timeframes",
  "--max-levels",
  "--timing",
] as const;
const OPTIONAL_VALUES = ["--max-requests", "--request-spacing-ms"] as const;
const FLAGS = ["--fetch"] as const;

/** Upper bound on a single replay, in bars (about five and a half years of 15m). */
export const MAX_REPLAY_BARS = 200_000;
/** Rows per kline page. */
export const REPLAY_PAGE_LIMIT = 1000;
/** A bar is closed only once Binance's clock is this far past its close. */
export const REPLAY_SETTLE_MS = 5_000;

export const REPLAY_CLI_USAGE = [
  "Usage (ONE symbol per run; every engine input explicit):",
  "  scanner:replay --symbol BTCUSDT --interval 15m",
  "    --warmup-start 2025-01-01T00:00:00Z --output-start 2025-06-01T00:00:00Z --end 2025-07-01T00:00:00Z",
  "    --min-move-percent 7 --touch-tolerance-percent 1",
  "    --cooldown-bars 10 --min-bars-after-creation 5 --min-bars-after-arming 4",
  "    --source-timeframes 1D,1W,1M,3M,6M,12M --max-levels 500 --timing Immediate",
  "    [--fetch] [--max-requests 40] [--request-spacing-ms 1000]",
  "Times are UTC and must end in Z. Without --fetch the run is cache-only and makes no request.",
].join("\n");

export interface ReplayCliOptions {
  readonly request: HistoricalReplayRequest;
  readonly fetch: boolean;
  readonly policy: PublicRequestPolicy;
  readonly maxBars: number;
}

function usage(message: string): never {
  throw new ReplayCliUsageError(message);
}

/** A UTC instant written with an explicit Z; every field is checked, nothing is normalised. */
export function parseUtcInstant(value: string, name: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z$/.exec(value);
  if (!match) usage(`${name} must be a UTC time like 2025-01-01T00:00:00Z`);
  const [y, mo, d, h, mi, s] = match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const at = new Date(ms);
  if (
    at.getUTCFullYear() !== y ||
    at.getUTCMonth() !== mo - 1 ||
    at.getUTCDate() !== d ||
    at.getUTCHours() !== h ||
    at.getUTCMinutes() !== mi ||
    at.getUTCSeconds() !== s
  ) {
    usage(`${name} is not a real calendar time`);
  }
  return ms;
}

function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) usage(`${name} must be a non-negative integer`);
  return Number(value);
}

function percent(value: string, name: string): number {
  if (!/^\d+(\.\d+)?$/.test(value)) usage(`${name} must be a number of percentage points, e.g. 7`);
  return pinePercentInputToFraction(Number(value));
}

export function parseReplayCliArgs(argv: readonly string[]): ReplayCliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if ((FLAGS as readonly string[]).includes(token)) {
      if (flags.has(token)) usage(`${token} given twice`);
      flags.add(token);
      continue;
    }
    if (!(REQUIRED as readonly string[]).includes(token) && !(OPTIONAL_VALUES as readonly string[]).includes(token)) {
      usage(`unexpected argument: ${token}`);
    }
    if (values.has(token)) usage(`${token} given twice — one run replays one symbol with one configuration`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usage(`${token} needs a value`);
    values.set(token, value);
    i += 1;
  }
  const missing = REQUIRED.filter((name) => !values.has(name));
  if (missing.length > 0) usage(`missing required: ${missing.join(", ")}`);
  const get = (name: string) => values.get(name) as string;

  try {
    const symbol = assertScannerSymbol(get("--symbol"));
    const chartInterval = get("--interval") as ScannerChartInterval;
    intervalMsOf(chartInterval);
    const timing = get("--timing");
    if (!(NATIVE_TIMING_MODES as readonly string[]).includes(timing)) {
      usage(`--timing must be one of: ${NATIVE_TIMING_MODES.join(", ")}`);
    }
    const engine = createNativeEngineConfig({
      minMovePct: percent(get("--min-move-percent"), "--min-move-percent"),
      touchTolerancePct: percent(get("--touch-tolerance-percent"), "--touch-tolerance-percent"),
      touchCooldownBars: integer(get("--cooldown-bars"), "--cooldown-bars"),
      minBarsAfterCreation: integer(get("--min-bars-after-creation"), "--min-bars-after-creation"),
      minBarsAfterArming: integer(get("--min-bars-after-arming"), "--min-bars-after-arming"),
      maxLevels: integer(get("--max-levels"), "--max-levels"),
      enabledSourceTfs: get("--source-timeframes").split(",") as NativeSourceTf[],
      timing: timing as NativeTimingMode,
    });
    const request: HistoricalReplayRequest = {
      symbol,
      marketType: SCANNER_MARKET_TYPE,
      chartInterval,
      warmupStartMs: parseUtcInstant(get("--warmup-start"), "--warmup-start"),
      outputStartMs: parseUtcInstant(get("--output-start"), "--output-start"),
      endMs: parseUtcInstant(get("--end"), "--end"),
      engine,
    };
    const intervalMs = assertReplayRequest(request);
    const maxBars = (request.endMs - request.warmupStartMs) / intervalMs;
    if (maxBars > MAX_REPLAY_BARS) usage(`the range holds ${maxBars} bars; one replay may hold at most ${MAX_REPLAY_BARS}`);

    const policy = assertRequestPolicy({
      ...CONSERVATIVE_REQUEST_POLICY,
      ...(values.has("--max-requests") ? { maxRequests: integer(get("--max-requests"), "--max-requests") } : {}),
      ...(values.has("--request-spacing-ms")
        ? { minSpacingMs: integer(get("--request-spacing-ms"), "--request-spacing-ms") }
        : {}),
    });
    return { request, fetch: flags.has("--fetch"), policy, maxBars };
  } catch (error) {
    if (error instanceof ScannerDataError || error instanceof NativeSignalInputError) usage(error.message);
    throw error;
  }
}
