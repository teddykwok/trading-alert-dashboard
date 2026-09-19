import type {
  HistoricalFillTargetedCanary,
  TargetedCanaryResult,
} from "./historical-fill-targeted-canary.service";

/**
 * The operator boundary for ONE targeted historical read.
 *
 * One flag, and it names a window this account already has. There is no
 * profile, account, campaign, symbol, date, force or yes flag, and there never
 * will be one that this parser accepts: the account comes from configuration,
 * the campaign must already exist and be shaped for a single dispatch, and a
 * command whose whole purpose is one supervised exchange request has nothing to
 * force past.
 *
 * ## Why the window id may be printed
 *
 * It is an opaque row identifier for work this operator just named themselves.
 * It reveals no account, no credential and no position. The bound execution
 * profile id, by contrast, is never printed -- and neither is the breaker
 * generation, which is internal fencing state rather than something an operator
 * acts on.
 */

export const CANARY_CLI_EXIT = { OK: 0, REFUSED: 1, USAGE: 2 } as const;

export const CANARY_USAGE = [
  "Usage:",
  "  pnpm execution:fill-window-canary --window-id=<id>",
  "",
  "Executes EXACTLY ONE already-existing historical ingest window, once.",
  "",
  "Acts on the configured, environment-bound execution profile; no profile,",
  "account, campaign, symbol, date or force flag exists. Requires an ACTIVE",
  "campaign shaped for a single dispatch (maxDispatches=1, dispatchesUsed=0)",
  "and a configured EXECUTION_FILL_GLOBAL_USER_TRADES_WEIGHT_PER_MINUTE.",
  "",
  "Creates no campaign, materializes no roots, and never falls back to another",
  "window: at most ONE /fapi/v1/userTrades request, or none at all.",
].join("\n");

export interface CanaryCliResult {
  exitCode: (typeof CANARY_CLI_EXIT)[keyof typeof CANARY_CLI_EXIT];
}

export interface CanaryCliDependencies {
  canary: Pick<HistoricalFillTargetedCanary, "run">;
  /** Operational identity for the claim's `claimOwner`. Never a credential. */
  workerId: string;
  out?: (line: string) => void;
}

function line(out: (line: string) => void, label: string, value: unknown): void {
  out(`  ${label.padEnd(24)} ${value === null || value === undefined ? "—" : String(value)}`);
}

/** The one flag this command understands. Everything else is a usage error. */
const WINDOW_ID = "--window-id=";

/** Every outcome that is a refusal rather than a completed attempt. */
function refused(result: TargetedCanaryResult): boolean {
  return result.outcome !== "EXECUTED";
}

export async function runFillWindowCanaryCli(
  argv: string[],
  deps: CanaryCliDependencies
): Promise<CanaryCliResult> {
  const out = deps.out ?? ((text: string) => console.log(text));

  // EXACTLY ONE argument, and it must be this one. Counted rather than found,
  // so a repeated flag is a usage error instead of a silent first-wins choice
  // between two window ids an operator may have meant differently.
  const windowFlags = argv.filter((entry) => entry.startsWith(WINDOW_ID));
  if (argv.length !== 1 || windowFlags.length !== 1) {
    out(CANARY_USAGE);
    return { exitCode: CANARY_CLI_EXIT.USAGE };
  }

  const windowId = windowFlags[0]!.slice(WINDOW_ID.length).trim();
  if (windowId === "") {
    out(CANARY_USAGE);
    return { exitCode: CANARY_CLI_EXIT.USAGE };
  }

  const result = await deps.canary.run({ workerId: deps.workerId, windowId });

  // FIELD BY FIELD, never a spread of the service result. The bound profile id
  // and the breaker generation must not reach a terminal, and a spread would
  // print whatever this result grows next without anybody deciding it is safe.
  out("targeted historical window canary");
  line(out, "outcome", result.outcome);
  line(out, "window id", result.windowId);
  line(out, "symbol", result.symbol);
  line(out, "start time ms", result.startTimeMs);
  line(out, "end time ms", result.endTimeMs);
  line(out, "ineligibility", result.ineligibility);
  line(out, "profile reason", result.profileReasonCode);
  line(out, "executor outcome", result.executorOutcome);
  line(out, "executor reason", result.executorReasonCode);
  line(out, "userTrades requests", result.userTradesRequests);
  line(out, "userTrades weight", result.userTradesWeightUsed);
  line(out, "campaign status", result.campaignStatus);
  line(out, "dispatches used", result.dispatchesUsed);
  line(out, "max dispatches", result.maxDispatches);
  line(out, "circuit state", result.circuit?.state ?? null);
  line(out, "circuit family", result.circuit?.failureFamily ?? null);
  line(out, "circuit reason", result.circuit?.lastReasonCode ?? null);
  line(out, "circuit count", result.circuit?.consecutiveCount ?? null);
  line(out, "circuit opened at", result.circuit?.openedAt?.toISOString() ?? null);
  line(out, "circuit opened now", result.circuitOpened);

  return { exitCode: refused(result) ? CANARY_CLI_EXIT.REFUSED : CANARY_CLI_EXIT.OK };
}
