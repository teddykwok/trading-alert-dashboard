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
import { CONSERVATIVE_REQUEST_POLICY, assertRequestPolicy, type PublicRequestPolicy } from "./kline-fetcher";
import { ReplayCliUsageError, parseUtcInstant } from "./replay-cli-args";
import type { LiveShadowRequest } from "./live-shadow-session";

/**
 * Arguments for ONE live SHADOW scanner of ONE symbol.
 *
 * Every lineage input is REQUIRED. There is no universe mode, no account
 * selector, no execution account, no replay window and no Alert option:
 * anything not listed here is refused as an unexpected argument.
 */

export class LiveShadowCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveShadowCliUsageError";
  }
}

const REQUIRED = [
  "--symbol",
  "--interval",
  "--history-start",
  "--switchover",
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
const OPTIONAL_VALUES = ["--expect-lineage-id", "--max-requests", "--request-spacing-ms"] as const;
const FLAGS = ["--fetch"] as const;

export const LIVE_SHADOW_CLI_USAGE = [
  "Usage (ONE symbol; LIVE SHADOW ONLY — no Alert, no order):",
  "  scanner:live-shadow --symbol LDOUSDT --interval 15m",
  "    --history-start 2026-01-01T00:00:00Z --switchover 2026-09-12T01:00:00Z",
  "    --min-move-percent 7 --touch-tolerance-percent 1",
  "    --cooldown-bars 10 --min-bars-after-creation 5 --min-bars-after-arming 4",
  "    --source-timeframes 1D,1W,1M,3M,6M,12M --max-levels 500 --timing Immediate",
  `    --partial-period-policy ${SWITCHOVER_TRUNCATED_CLOSED_BARS}`,
  "    [--expect-lineage-id <sha256>] [--fetch] [--max-requests 40] [--request-spacing-ms 1000]",
  "Times are UTC and must end in Z. Without --fetch, the local cache must already hold every",
  "closed bar from the HTF context start to the latest closed bar.",
].join("\n");

export interface LiveShadowCliOptions {
  readonly request: LiveShadowRequest;
  readonly fetch: boolean;
  readonly policy: PublicRequestPolicy;
}

function usage(message: string): never {
  throw new LiveShadowCliUsageError(message);
}

function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) usage(`${name} must be a non-negative integer`);
  return Number(value);
}

function percent(value: string, name: string): number {
  if (!/^\d+(\.\d+)?$/.test(value)) usage(`${name} must be a number of percentage points, e.g. 7`);
  return pinePercentInputToFraction(Number(value));
}

export function parseLiveShadowCliArgs(argv: readonly string[]): LiveShadowCliOptions {
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
    if (values.has(token)) usage(`${token} given twice — one process scans one symbol with one lineage`);
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
    const intervalMs = intervalMsOf(chartInterval);
    const timing = get("--timing");
    if (!(NATIVE_TIMING_MODES as readonly string[]).includes(timing)) usage(`--timing must be one of: ${NATIVE_TIMING_MODES.join(", ")}`);
    if (get("--partial-period-policy") !== SWITCHOVER_TRUNCATED_CLOSED_BARS) {
      usage(`--partial-period-policy must be ${SWITCHOVER_TRUNCATED_CLOSED_BARS} (the only approved policy)`);
    }
    const expectedLineageId = values.has("--expect-lineage-id") ? get("--expect-lineage-id") : null;
    if (expectedLineageId !== null && !/^[0-9a-f]{64}$/.test(expectedLineageId)) usage("--expect-lineage-id must be a lowercase SHA-256 hex digest");
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
    const historyStartMs = instant("--history-start");
    const switchoverMs = instant("--switchover");
    if (historyStartMs % intervalMs !== 0 || switchoverMs % intervalMs !== 0 || !(historyStartMs < switchoverMs)) {
      usage("--history-start and --switchover must be bar boundaries with history-start < switchover");
    }
    const policy = assertRequestPolicy({
      ...CONSERVATIVE_REQUEST_POLICY,
      ...(values.has("--max-requests") ? { maxRequests: integer(get("--max-requests"), "--max-requests") } : {}),
      ...(values.has("--request-spacing-ms") ? { minSpacingMs: integer(get("--request-spacing-ms"), "--request-spacing-ms") } : {}),
    });
    return {
      request: {
        symbol,
        marketType: SCANNER_MARKET_TYPE,
        chartInterval,
        historyStartMs,
        switchoverMs,
        engine,
        partialPeriodPolicy: SWITCHOVER_TRUNCATED_CLOSED_BARS,
        expectedLineageId,
      },
      fetch: flags.has("--fetch"),
      policy,
    };
  } catch (error) {
    if (error instanceof ScannerDataError || error instanceof NativeSignalInputError) usage(error.message);
    throw error;
  }
}
