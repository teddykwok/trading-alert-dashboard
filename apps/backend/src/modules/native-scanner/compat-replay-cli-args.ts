import {
  NATIVE_TIMING_MODES,
  NativeSignalInputError,
  SWITCHOVER_TRUNCATED_CLOSED_BARS,
  createNativeEngineConfig,
  pinePercentInputToFraction,
  type NativeSourceTf,
  type NativeTimingMode,
} from "@trading-alert-dashboard/shared";

import { SCANNER_MARKET_TYPE, ScannerDataError, assertScannerSymbol, intervalMsOf, type ScannerChartInterval } from "./binance-public-futures";
import { CompatReplayError, compatReplayRanges, type CompatReplayRequest } from "./compat-replay";
import { CONSERVATIVE_REQUEST_POLICY, assertRequestPolicy, type PublicRequestPolicy } from "./kline-fetcher";
import { MAX_REPLAY_BARS, parseUtcInstant, ReplayCliUsageError } from "./replay-cli-args";

/**
 * Arguments for ONE compatibility replay of ONE symbol.
 *
 * Everything that shapes the state is REQUIRED: the history start, the fixed
 * switchover, every engine input and the partial-period policy. There is no
 * universe mode and no network unless `--fetch` is given.
 */

export class CompatReplayCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompatReplayCliUsageError";
  }
}

const REQUIRED = [
  "--symbol",
  "--interval",
  "--history-start",
  "--switchover",
  "--end",
  "--min-move-percent",
  "--touch-tolerance-percent",
  "--cooldown-bars",
  "--min-bars-after-creation",
  "--min-bars-after-arming",
  "--source-timeframes",
  "--max-levels",
  "--timing",
  "--partial-period-policy",
] as const;
const OPTIONAL_VALUES = ["--max-requests", "--request-spacing-ms"] as const;
const FLAGS = ["--fetch"] as const;

export const COMPAT_REPLAY_CLI_USAGE = [
  "Usage (ONE symbol per run; every state-shaping input explicit):",
  "  scanner:compat-replay --symbol LDOUSDT --interval 15m",
  "    --history-start 2026-01-01T00:00:00Z --switchover 2026-09-12T01:00:00Z --end 2026-09-15T22:00:00Z",
  "    --min-move-percent 7 --touch-tolerance-percent 1",
  "    --cooldown-bars 10 --min-bars-after-creation 5 --min-bars-after-arming 4",
  "    --source-timeframes 1D,1W,1M,3M,6M,12M --max-levels 500 --timing Immediate",
  `    --partial-period-policy ${SWITCHOVER_TRUNCATED_CLOSED_BARS}`,
  "    [--fetch] [--max-requests 40] [--request-spacing-ms 1000]",
  "Times are UTC and must end in Z. Context bars from the start of every enabled HTF period",
  "containing --history-start are required. Without --fetch the run is cache-only and makes no request.",
].join("\n");

export interface CompatReplayCliOptions {
  readonly request: CompatReplayRequest;
  readonly fetch: boolean;
  readonly policy: PublicRequestPolicy;
  /** Bars in [htfContextStart, end): the fetch ceiling for this run. */
  readonly maxBars: number;
}

function usage(message: string): never {
  throw new CompatReplayCliUsageError(message);
}

function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) usage(`${name} must be a non-negative integer`);
  return Number(value);
}

function percent(value: string, name: string): number {
  if (!/^\d+(\.\d+)?$/.test(value)) usage(`${name} must be a number of percentage points, e.g. 7`);
  return pinePercentInputToFraction(Number(value));
}

export function parseCompatReplayCliArgs(argv: readonly string[]): CompatReplayCliOptions {
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
    if (values.has(token)) usage(`${token} given twice — one run replays one symbol with one lineage`);
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
    if (!(NATIVE_TIMING_MODES as readonly string[]).includes(timing)) usage(`--timing must be one of: ${NATIVE_TIMING_MODES.join(", ")}`);
    if (get("--partial-period-policy") !== SWITCHOVER_TRUNCATED_CLOSED_BARS) {
      usage(`--partial-period-policy must be ${SWITCHOVER_TRUNCATED_CLOSED_BARS} (the only approved policy)`);
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
    const instant = (name: string): number => {
      try {
        return parseUtcInstant(get(name), name);
      } catch (error) {
        if (error instanceof ReplayCliUsageError) usage(error.message);
        throw error;
      }
    };
    const request: CompatReplayRequest = {
      symbol,
      marketType: SCANNER_MARKET_TYPE,
      chartInterval,
      historyStartMs: instant("--history-start"),
      switchoverMs: instant("--switchover"),
      endMs: instant("--end"),
      engine,
      partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
    };
    const { totalBars } = compatReplayRanges(request);
    if (totalBars > MAX_REPLAY_BARS) usage(`the range (with HTF context) holds ${totalBars} bars; one run may hold at most ${MAX_REPLAY_BARS}`);

    const policy = assertRequestPolicy({
      ...CONSERVATIVE_REQUEST_POLICY,
      ...(values.has("--max-requests") ? { maxRequests: integer(get("--max-requests"), "--max-requests") } : {}),
      ...(values.has("--request-spacing-ms") ? { minSpacingMs: integer(get("--request-spacing-ms"), "--request-spacing-ms") } : {}),
    });
    return { request, fetch: flags.has("--fetch"), policy, maxBars: totalBars };
  } catch (error) {
    if (error instanceof ScannerDataError || error instanceof NativeSignalInputError || error instanceof CompatReplayError) usage(error.message);
    throw error;
  }
}
