import { NATIVE_DELIVERY_CHART_INTERVALS, type NativeDeliveryChartInterval } from "./native-delivery-policy";
import type { NativeEmitterMode } from "./native-alert-emitter";

/**
 * Arguments for ONE native alert emitter: one symbol, one chart interval, one
 * explicitly named lineage.
 *
 * Read-only by default. Writing dashboard Alerts takes the explicit
 * `--commit-dashboard-alerts` flag. There is no account, profile, execution,
 * order or Binance option, and no way to express one: anything not listed
 * here is refused as an unexpected argument.
 */

export class NativeEmitterCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeEmitterCliUsageError";
  }
}

export interface NativeEmitterCliRequest {
  readonly symbol: string;
  readonly chartInterval: NativeDeliveryChartInterval;
  readonly lineageId: string;
  /** Null: the scanner's default live-shadow directory for this symbol and interval. */
  readonly shadowDir: string | null;
  readonly mode: NativeEmitterMode;
  readonly follow: boolean;
  readonly pollMs: number;
}

const REQUIRED = ["--symbol", "--interval", "--lineage-id"] as const;
const OPTIONAL_VALUES = ["--shadow-dir", "--poll-ms"] as const;
const FLAGS = ["--commit-dashboard-alerts", "--follow"] as const;

export const DEFAULT_POLL_MS = 2_000;
const POLL_MS_RANGE = [250, 60_000] as const;

export const NATIVE_EMITTER_CLI_USAGE = [
  "Usage (ONE symbol; DASHBOARD ALERTS ONLY — native alerts are never executed):",
  "  native-alerts:emitter --symbol LDOUSDT --interval 15m --lineage-id <sha256>",
  "    [--shadow-dir <dir>] [--follow [--poll-ms 2000]] [--commit-dashboard-alerts]",
  "Without --commit-dashboard-alerts it is a DRY RUN: it reads the shadow log and the ledger and writes nothing.",
].join("\n");

export function parseNativeEmitterCliArgs(argv: readonly string[]): NativeEmitterCliRequest {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((FLAGS as readonly string[]).includes(arg)) {
      if (flags.has(arg)) throw new NativeEmitterCliUsageError(`${arg} given twice`);
      flags.add(arg);
      continue;
    }
    if (!(REQUIRED as readonly string[]).includes(arg) && !(OPTIONAL_VALUES as readonly string[]).includes(arg)) {
      throw new NativeEmitterCliUsageError(`unexpected argument ${JSON.stringify(arg)}`);
    }
    if (values.has(arg)) throw new NativeEmitterCliUsageError(`${arg} given twice`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new NativeEmitterCliUsageError(`${arg} needs a value`);
    values.set(arg, value);
    i += 1;
  }
  for (const name of REQUIRED) if (!values.has(name)) throw new NativeEmitterCliUsageError(`${name} is required`);

  const symbol = values.get("--symbol") as string;
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new NativeEmitterCliUsageError("--symbol must be ONE bare uppercase Binance symbol such as LDOUSDT");
  const interval = values.get("--interval") as string;
  if (!Object.prototype.hasOwnProperty.call(NATIVE_DELIVERY_CHART_INTERVALS, interval)) {
    throw new NativeEmitterCliUsageError(`--interval must be one of: ${Object.keys(NATIVE_DELIVERY_CHART_INTERVALS).join(", ")}`);
  }
  const lineageId = values.get("--lineage-id") as string;
  if (!/^[0-9a-f]{64}$/.test(lineageId)) throw new NativeEmitterCliUsageError("--lineage-id must be the scanner lineage's SHA-256 hex digest");

  const follow = flags.has("--follow");
  let pollMs = DEFAULT_POLL_MS;
  if (values.has("--poll-ms")) {
    if (!follow) throw new NativeEmitterCliUsageError("--poll-ms only applies with --follow");
    pollMs = Number(values.get("--poll-ms"));
    if (!Number.isSafeInteger(pollMs) || pollMs < POLL_MS_RANGE[0] || pollMs > POLL_MS_RANGE[1]) {
      throw new NativeEmitterCliUsageError(`--poll-ms must be an integer from ${POLL_MS_RANGE[0]} to ${POLL_MS_RANGE[1]}`);
    }
  }

  return {
    symbol,
    chartInterval: interval as NativeDeliveryChartInterval,
    lineageId,
    shadowDir: values.get("--shadow-dir") ?? null,
    mode: flags.has("--commit-dashboard-alerts") ? "COMMIT_DASHBOARD_ALERTS" : "DRY_RUN",
    follow,
    pollMs,
  };
}
