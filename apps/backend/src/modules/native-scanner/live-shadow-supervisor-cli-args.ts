import { MAX_TOTAL_REQUESTS_CEILING } from "./candidate-rank-runner";
import { CONSERVATIVE_REQUEST_POLICY, REQUEST_POLICY_LIMITS } from "./kline-fetcher";
import { MAX_STREAMS_PER_COMBINED_CONNECTION } from "./live-kline-stream";
import { LINEAGE_CONFIG_OPTIONS, LiveShadowCliUsageError, parseLineageConfig, type LineageConfig } from "./live-shadow-cli-args";
import { SUPERVISOR_LIMITS } from "./live-shadow-supervisor";
import type { UniverseSelectionSpec } from "./usdm-universe";

/**
 * Arguments for the multi-symbol live SHADOW supervisor.
 *
 * Selection is always explicit. `--universe usdt-perpetual` alone is refused:
 * it needs either `--max-symbols N` or the deliberate `--all-active`
 * acknowledgement, so a typo can never start hundreds of symbols. There is no
 * account, order, alert, emitter or database option, and none can be
 * expressed: anything unlisted is refused.
 */

export class SupervisorCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorCliUsageError";
  }
}

const SELECTION = ["--universe", "--symbols", "--include-symbols", "--exclude-symbols", "--max-symbols"] as const;
const TUNING = [
  "--symbols-per-connection",
  "--max-connections",
  "--rest-concurrency",
  "--queue-capacity",
  "--max-lag-ms",
  "--stale-symbol-ms",
  "--max-recovery-attempts",
  "--max-total-requests",
  "--request-spacing-ms",
  "--status-every-s",
  "--duration-minutes",
] as const;
const FLAGS = ["--all-active", "--json-status"] as const;
const VALUES: readonly string[] = [...LINEAGE_CONFIG_OPTIONS, ...SELECTION, ...TUNING];

export const SUPERVISOR_DEFAULTS = Object.freeze({
  symbolsPerConnection: 50,
  maxConnections: 4,
  restConcurrency: 2,
  queueCapacity: 20_000,
  maxProcessingLagMs: 30_000,
  /** Two full 15m bars: silence alone is normal for illiquid symbols. */
  staleSymbolMs: 1_800_000,
  maxRecoveryAttempts: 10,
  maxTotalRequests: 4_000,
  statusEverySeconds: 60,
});

export const SUPERVISOR_CLI_USAGE = [
  "Usage (LIVE SHADOW ONLY — no Alert, no order, no database):",
  "  scanner:live-shadow-supervisor (--symbols A,B,... | --universe usdt-perpetual (--max-symbols N | --all-active))",
  "    [--include-symbols A,B] [--exclude-symbols C]   (with --universe only)",
  "    <the scanner's lineage flags: --interval 15m --history-start ... --partial-period-policy ...>",
  `    [--symbols-per-connection ${SUPERVISOR_DEFAULTS.symbolsPerConnection}] [--max-connections ${SUPERVISOR_DEFAULTS.maxConnections}] [--rest-concurrency ${SUPERVISOR_DEFAULTS.restConcurrency}]`,
  `    [--queue-capacity ${SUPERVISOR_DEFAULTS.queueCapacity}] [--max-lag-ms ${SUPERVISOR_DEFAULTS.maxProcessingLagMs}] [--stale-symbol-ms ${SUPERVISOR_DEFAULTS.staleSymbolMs}]`,
  `    [--max-total-requests ${SUPERVISOR_DEFAULTS.maxTotalRequests}] [--request-spacing-ms ${CONSERVATIVE_REQUEST_POLICY.minSpacingMs}] [--status-every-s ${SUPERVISOR_DEFAULTS.statusEverySeconds}]`,
  "    [--duration-minutes N] [--json-status]",
].join("\n");

export interface SupervisorCliOptions {
  readonly lineage: LineageConfig;
  readonly selection: UniverseSelectionSpec;
  readonly symbolsPerConnection: number;
  readonly maxConnections: number;
  readonly restConcurrency: number;
  readonly queueCapacity: number;
  readonly maxProcessingLagMs: number;
  readonly staleSymbolMs: number;
  readonly maxRecoveryAttempts: number;
  readonly maxTotalRequests: number;
  readonly minSpacingMs: number;
  readonly statusEverySeconds: number;
  readonly durationMinutes: number | null;
  readonly jsonStatus: boolean;
}

const usage = (message: string): never => {
  throw new SupervisorCliUsageError(message);
};

function bounded(value: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) usage(`${name} must be an integer ${min}..${max}`);
  return Number(value);
}

const list = (value: string) => value.split(",").map((s) => s.trim());

export function parseSupervisorCliArgs(argv: readonly string[]): SupervisorCliOptions {
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
  let lineage: LineageConfig;
  try {
    lineage = parseLineageConfig((name) => values.get(name) as string);
  } catch (error) {
    if (error instanceof LiveShadowCliUsageError) usage(error.message);
    throw error;
  }

  const hasUniverse = values.has("--universe");
  const hasSymbols = values.has("--symbols");
  if (hasUniverse === hasSymbols) usage("give exactly one of --symbols or --universe usdt-perpetual");
  let selection: UniverseSelectionSpec;
  if (hasUniverse) {
    if (values.get("--universe") !== "usdt-perpetual") usage("--universe must be usdt-perpetual");
    const all = flags.has("--all-active");
    const max = values.has("--max-symbols");
    if (all === max) usage("--universe usdt-perpetual needs exactly one of --max-symbols N or the explicit --all-active acknowledgement");
    selection = {
      mode: "UNIVERSE",
      include: values.has("--include-symbols") ? list(values.get("--include-symbols") as string) : [],
      exclude: values.has("--exclude-symbols") ? list(values.get("--exclude-symbols") as string) : [],
      maxSymbols: max ? bounded(values.get("--max-symbols"), "--max-symbols", 1, SUPERVISOR_LIMITS.maxSymbols, 0) : null,
    };
  } else {
    for (const flag of ["--include-symbols", "--exclude-symbols", "--max-symbols"]) {
      if (values.has(flag)) usage(`${flag} only applies with --universe; with --symbols, list exactly the symbols wanted`);
    }
    if (flags.has("--all-active")) usage("--all-active only applies with --universe usdt-perpetual");
    selection = { mode: "EXPLICIT", symbols: list(values.get("--symbols") as string) };
  }

  return {
    lineage,
    selection,
    symbolsPerConnection: bounded(values.get("--symbols-per-connection"), "--symbols-per-connection", 1, MAX_STREAMS_PER_COMBINED_CONNECTION, SUPERVISOR_DEFAULTS.symbolsPerConnection),
    maxConnections: bounded(values.get("--max-connections"), "--max-connections", 1, SUPERVISOR_LIMITS.maxConnections, SUPERVISOR_DEFAULTS.maxConnections),
    restConcurrency: bounded(values.get("--rest-concurrency"), "--rest-concurrency", 1, 8, SUPERVISOR_DEFAULTS.restConcurrency),
    queueCapacity: bounded(values.get("--queue-capacity"), "--queue-capacity", 100, SUPERVISOR_LIMITS.maxQueueCapacity, SUPERVISOR_DEFAULTS.queueCapacity),
    maxProcessingLagMs: bounded(values.get("--max-lag-ms"), "--max-lag-ms", 1_000, 600_000, SUPERVISOR_DEFAULTS.maxProcessingLagMs),
    staleSymbolMs: bounded(values.get("--stale-symbol-ms"), "--stale-symbol-ms", 10_000, 14_400_000, SUPERVISOR_DEFAULTS.staleSymbolMs),
    maxRecoveryAttempts: bounded(values.get("--max-recovery-attempts"), "--max-recovery-attempts", 1, 100, SUPERVISOR_DEFAULTS.maxRecoveryAttempts),
    maxTotalRequests: bounded(values.get("--max-total-requests"), "--max-total-requests", 4, MAX_TOTAL_REQUESTS_CEILING, SUPERVISOR_DEFAULTS.maxTotalRequests),
    minSpacingMs: bounded(values.get("--request-spacing-ms"), "--request-spacing-ms", REQUEST_POLICY_LIMITS.minSpacingFloorMs, 60_000, CONSERVATIVE_REQUEST_POLICY.minSpacingMs),
    statusEverySeconds: bounded(values.get("--status-every-s"), "--status-every-s", 5, 3_600, SUPERVISOR_DEFAULTS.statusEverySeconds),
    durationMinutes: values.has("--duration-minutes") ? bounded(values.get("--duration-minutes"), "--duration-minutes", 1, 100_000, 0) : null,
    jsonStatus: flags.has("--json-status"),
  };
}
