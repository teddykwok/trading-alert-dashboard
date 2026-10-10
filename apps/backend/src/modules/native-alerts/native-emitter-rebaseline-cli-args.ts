import { RUN_ID_PATTERN } from "../native-scanner/supervisor-run-manifest";

/**
 * Arguments for NATIVE_EMITTER_CURSOR_REBASELINE_V1: one profile, one pinned
 * STOPPED supervisor run, one expected engine fingerprint.
 *
 * DRY RUN by default: it writes nothing at all. Advancing the production
 * cursors takes `--commit-rebaseline` AND `--expect-plan-sha256 <hash>` — the
 * plan hash the operator reviewed in a dry run — so a commit can only ever
 * apply exactly the plan that was reviewed. There is no account, execution,
 * order, Binance or database option: anything unlisted is refused.
 */

export class RebaselineCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RebaselineCliUsageError";
  }
}

export type RebaselineMode = "DRY_RUN" | "COMMIT_REBASELINE";

export interface RebaselineCliRequest {
  readonly profileName: string;
  readonly runId: string;
  readonly engineFingerprint: string;
  readonly mode: RebaselineMode;
  /** COMMIT only (required there): the plan hash a dry run printed. */
  readonly expectPlanSha256: string | null;
  /** Lanes listed in the summary, largest backlog first (0 = none). */
  readonly top: number;
  /** List every lane. */
  readonly verbose: boolean;
  /** Print the full machine-readable plan as JSON (stdout only; nothing is written). */
  readonly json: boolean;
}

const REQUIRED = ["--profile", "--run-id", "--expect-engine-fingerprint"] as const;
const OPTIONAL_VALUES = ["--expect-plan-sha256", "--top"] as const;
const FLAGS = ["--commit-rebaseline", "--verbose", "--json"] as const;

export const REBASELINE_DEFAULTS = Object.freeze({ top: 10 });

export const REBASELINE_CLI_USAGE = [
  "Usage (EMITTER DELIVERY CURSORS ONLY — no Alert, no database, no Binance, no execution):",
  "  native-alerts:rebaseline-cursors --profile <teddy-aggressive|teddy-7-all-active> --run-id <STOPPED supervisor run id> --expect-engine-fingerprint <sha256>",
  `    [--top ${REBASELINE_DEFAULTS.top}] [--verbose] [--json]                       (dry run: prints the plan and its hash; writes nothing)`,
  "    [--commit-rebaseline --expect-plan-sha256 <hash from the dry run>] (advances production cursors to the run's durable EOF)",
  "Without --commit-rebaseline it is a DRY RUN and writes nothing at all.",
  "REBASELINE IS NOT A SCANNER RESET: scanner checkpoints and strategy state are never touched.",
].join("\n");

const usage = (message: string): never => {
  throw new RebaselineCliUsageError(message);
};

export function parseRebaselineCliArgs(argv: readonly string[]): RebaselineCliRequest {
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

  const commit = flags.has("--commit-rebaseline");
  const planHash = values.get("--expect-plan-sha256") ?? null;
  if (commit && planHash === null) usage("--commit-rebaseline requires --expect-plan-sha256 <the plan hash a dry run printed>: a commit applies exactly a reviewed plan");
  if (!commit && planHash !== null) usage("--expect-plan-sha256 only applies with --commit-rebaseline");
  if (planHash !== null && !/^[0-9a-f]{64}$/.test(planHash)) usage("--expect-plan-sha256 must be a SHA-256 hex digest");
  if (commit && flags.has("--json")) usage("--json is a dry-run output");

  let top: number = REBASELINE_DEFAULTS.top;
  if (values.has("--top")) {
    const raw = values.get("--top") as string;
    if (!/^\d+$/.test(raw) || Number(raw) > 1000) usage("--top must be an integer 0..1000");
    top = Number(raw);
  }

  return {
    profileName: values.get("--profile") as string,
    runId,
    engineFingerprint,
    mode: commit ? "COMMIT_REBASELINE" : "DRY_RUN",
    expectPlanSha256: planHash,
    top,
    verbose: flags.has("--verbose"),
    json: flags.has("--json"),
  };
}
