import { RUN_ID_PATTERN } from "../native-scanner/supervisor-run-manifest";
import { MULTI_EMITTER_QUEUE_LIMITS, type MultiEmitterMode } from "./multi-symbol-emitter";

/**
 * Arguments for the MULTI-SYMBOL native emitter: one profile, one pinned
 * supervisor run, one expected engine fingerprint.
 *
 * DRY RUN by default, and a dry run touches no database at all. Writing
 * dashboard Alerts takes `--commit-dashboard-alerts`, and a symbol that was
 * never activated additionally takes `--activate-at-eof` (which starts at the
 * current end of its log and never replays history). There is no account,
 * execution, order or Binance option: anything unlisted is refused.
 */

export class MultiEmitterCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultiEmitterCliUsageError";
  }
}

export interface MultiEmitterCliRequest {
  readonly profileName: string;
  readonly runId: string;
  readonly engineFingerprint: string;
  readonly mode: MultiEmitterMode;
  readonly activateAtEof: boolean;
  readonly baseline: "PRODUCTION_CURSOR" | "DRY_RUN_FROM_START";
  readonly follow: boolean;
  readonly pollMs: number;
  readonly durationMinutes: number | null;
  readonly queueCapacity: number;
  readonly statusEverySeconds: number;
}

const REQUIRED = ["--profile", "--run-id", "--expect-engine-fingerprint"] as const;
const OPTIONAL_VALUES = ["--poll-ms", "--duration-minutes", "--queue-capacity", "--status-every-s"] as const;
const FLAGS = ["--follow", "--commit-dashboard-alerts", "--activate-at-eof", "--dry-run-from-start"] as const;

export const MULTI_EMITTER_DEFAULTS = Object.freeze({ pollMs: 2_000, queueCapacity: 10_000, statusEverySeconds: 30 });

export const MULTI_EMITTER_CLI_USAGE = [
  "Usage (DASHBOARD ALERTS ONLY — native alerts are never executed):",
  "  native-alerts:multi-emitter --profile <teddy-aggressive|teddy-7-all-active> --run-id <supervisor run id> --expect-engine-fingerprint <sha256>",
  `    [--follow [--poll-ms ${MULTI_EMITTER_DEFAULTS.pollMs}]] [--duration-minutes N] [--queue-capacity ${MULTI_EMITTER_DEFAULTS.queueCapacity}] [--status-every-s ${MULTI_EMITTER_DEFAULTS.statusEverySeconds}]`,
  "    [--dry-run-from-start]                        (dry run only: evaluate each whole log; writes nothing)",
  "    [--commit-dashboard-alerts [--activate-at-eof]] (persistent delivery; first activation starts at current EOF)",
  "Without --commit-dashboard-alerts it is a DRY RUN: it reads the shadow logs and writes no database row and no cursor.",
].join("\n");

const usage = (message: string): never => {
  throw new MultiEmitterCliUsageError(message);
};

function bounded(value: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) usage(`${name} must be an integer ${min}..${max}`);
  return Number(value);
}

export function parseMultiEmitterCliArgs(argv: readonly string[]): MultiEmitterCliRequest {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((FLAGS as readonly string[]).includes(arg)) {
      if (flags.has(arg)) usage(`${arg} given twice`);
      flags.add(arg);
      continue;
    }
    if (!(REQUIRED as readonly string[]).includes(arg) && !(OPTIONAL_VALUES as readonly string[]).includes(arg)) usage(`unexpected argument ${JSON.stringify(arg)}`);
    if (values.has(arg)) usage(`${arg} given twice`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usage(`${arg} needs a value`);
    values.set(arg, value);
    i += 1;
  }
  for (const name of REQUIRED) if (!values.has(name)) usage(`${name} is required`);

  const runId = values.get("--run-id") as string;
  if (!RUN_ID_PATTERN.test(runId)) usage("--run-id must be a supervisor run id such as 20261003T120000Z-1a2b3c4d");
  const engineFingerprint = values.get("--expect-engine-fingerprint") as string;
  if (!/^[0-9a-f]{64}$/.test(engineFingerprint)) usage("--expect-engine-fingerprint must be the profile engine's SHA-256 hex digest");

  const commit = flags.has("--commit-dashboard-alerts");
  if (flags.has("--activate-at-eof") && !commit) usage("--activate-at-eof only applies with --commit-dashboard-alerts");
  if (flags.has("--dry-run-from-start") && commit) usage("--dry-run-from-start is a dry-run diagnostic; persistent delivery never replays history");
  const follow = flags.has("--follow");
  if (values.has("--poll-ms") && !follow) usage("--poll-ms only applies with --follow");
  if (values.has("--duration-minutes") && !follow) usage("--duration-minutes only applies with --follow");

  return {
    profileName: values.get("--profile") as string,
    runId,
    engineFingerprint,
    mode: commit ? "COMMIT_DASHBOARD_ALERTS" : "DRY_RUN",
    activateAtEof: flags.has("--activate-at-eof"),
    baseline: flags.has("--dry-run-from-start") ? "DRY_RUN_FROM_START" : "PRODUCTION_CURSOR",
    follow,
    pollMs: bounded(values.get("--poll-ms"), "--poll-ms", 250, 60_000, MULTI_EMITTER_DEFAULTS.pollMs),
    durationMinutes: values.has("--duration-minutes") ? bounded(values.get("--duration-minutes"), "--duration-minutes", 1, 100_000, 0) : null,
    queueCapacity: bounded(values.get("--queue-capacity"), "--queue-capacity", MULTI_EMITTER_QUEUE_LIMITS.min, MULTI_EMITTER_QUEUE_LIMITS.max, MULTI_EMITTER_DEFAULTS.queueCapacity),
    statusEverySeconds: bounded(values.get("--status-every-s"), "--status-every-s", 5, 3_600, MULTI_EMITTER_DEFAULTS.statusEverySeconds),
  };
}
