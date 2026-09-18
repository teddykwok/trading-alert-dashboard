import type { HistoricalFillCampaign, PrismaClient } from "@prisma/client";

import {
  bindConfiguredExecutionProfileEnvironment,
  type BinanceProfileBindingResult,
} from "./binance-profile-binding";
import {
  HistoricalFillCampaignConflictError,
  HistoricalFillCampaignNotFoundError,
  HistoricalFillCampaignStateError,
  HistoricalFillCampaignValidationError,
  MAX_CAMPAIGN_DISPATCHES,
} from "./historical-fill-campaign.service";
import {
  HistoricalFillCircuitInvariantError,
  type HistoricalFillCircuitAcknowledgement,
  type HistoricalFillCircuitSnapshot,
} from "./historical-fill-circuit-breaker.service";

/**
 * The operator boundary for bounded historical backfills.
 *
 * Five commands, all acting on EXACTLY the configured, environment-bound
 * profile -- the same binder the bootstrap, the executor and the operational
 * snapshot use, so the CLI can only ever touch the account the runtime would.
 * None accepts an arbitrary profile, none edits `.env`, none contacts Binance,
 * and none has a --force.
 *
 * ## Why starting is the only command that demands an argument
 *
 * `start` is the one act that authorises spending a real account's exchange
 * allowance, so it requires `--max-dispatches` explicitly and has NO default:
 * a number nobody chose is not consent. Pausing and aborting move toward
 * safety, so they ask for nothing and stay easy to run in a hurry.
 *
 * ## Targeting
 *
 * `pause`, `resume` and `abort` act on the profile's ONE LIVE campaign, which
 * is unambiguous because at most one can exist. Reaching anything else -- an
 * exhausted campaign somebody wants to close out for good, say -- requires
 * naming it with `--campaign-id`, precisely so a hurried abort can never land
 * on an old terminal row instead of the one the operator meant.
 */

export const CLI_EXIT = { OK: 0, REFUSED: 1, USAGE: 2 } as const;

export const USAGE = [
  "Usage:",
  "  pnpm execution:fill-campaign-start  --max-dispatches=<1..100> [--note=\"why\"]",
  "  pnpm execution:fill-campaign-pause  [--campaign-id=<id>]",
  "  pnpm execution:fill-campaign-resume [--campaign-id=<id>]",
  "  pnpm execution:fill-campaign-abort  [--campaign-id=<id>] [--note=\"why\"]",
  "  pnpm execution:fill-campaign-status [--campaign-id=<id>]",
  "  pnpm execution:fill-circuit-acknowledge",
  "",
  "Acts on the configured, environment-bound execution profile. No profile flag exists.",
  "Acknowledging the circuit clears the latch ONLY. It starts and resumes nothing.",
].join("\n");

export interface CliResult {
  exitCode: (typeof CLI_EXIT)[keyof typeof CLI_EXIT];
}

/** Exactly the campaign operations this CLI may perform. Nothing wider. */
export interface FillCampaignCliCampaignService {
  createCampaign: (input: {
    executionProfileId: string;
    maxDispatches: number;
    note?: string | null;
  }) => Promise<HistoricalFillCampaign>;
  pauseCampaign: (campaignId: string) => Promise<HistoricalFillCampaign>;
  resumeCampaign: (campaignId: string) => Promise<HistoricalFillCampaign>;
  abortCampaign: (campaignId: string, note?: string | null) => Promise<HistoricalFillCampaign>;
  getLiveCampaign: (executionProfileId: string) => Promise<HistoricalFillCampaign | null>;
  getCampaignStatus: (campaignId: string) => Promise<HistoricalFillCampaign | null>;
}

/**
 * Exactly the breaker operations this CLI may perform.
 *
 * Two methods, and neither of them writes anything a campaign can run on.
 * `readState` is the status display; `acknowledge` is the one explicit operator
 * recovery action. There is deliberately no way from here to open a circuit, to
 * reset an epoch, or to start or resume work.
 */
export interface FillCampaignCliCircuitService {
  readState: (options: {
    executionProfileId: string;
  }) => Promise<HistoricalFillCircuitSnapshot>;
  acknowledge: (options: {
    executionProfileId: string;
  }) => Promise<HistoricalFillCircuitAcknowledgement>;
}

export interface FillCampaignCliDependencies {
  prisma: PrismaClient;
  campaigns: FillCampaignCliCampaignService;
  /** The systemic latch. Required: status must always be able to report it. */
  circuit: FillCampaignCliCircuitService;
  /** Injectable only so tests can drive a binding failure; the default is the real binder. */
  bindProfile?: (prisma: PrismaClient) => Promise<BinanceProfileBindingResult>;
  /** Injectable so tests can read output instead of a terminal. */
  out?: (line: string) => void;
}

function writer(deps: FillCampaignCliDependencies): (line: string) => void {
  return deps.out ?? ((line: string) => console.log(line));
}

/** `--name=value`, the repo's flag shape. Returns null when absent. */
function flag(argv: string[], name: string): string | null {
  const prefix = `--${name}=`;
  const match = argv.find((entry) => entry.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : null;
}

/** Flags this command understands; anything else is a usage error, never ignored. */
function unknownFlags(argv: string[], allowed: readonly string[]): string[] {
  return argv.filter((entry) => !allowed.some((name) => entry.startsWith(`--${name}=`)));
}

function line(out: (line: string) => void, label: string, value: unknown): void {
  out(`  ${label.padEnd(24)} ${value === null || value === undefined ? "—" : String(value)}`);
}

/** Every field this CLI is allowed to print. `note` is the operator's own text. */
function describe(out: (line: string) => void, campaign: HistoricalFillCampaign): void {
  line(out, "campaign id", campaign.id);
  line(out, "status", campaign.status);
  line(out, "dispatches used", `${campaign.dispatchesUsed} of ${campaign.maxDispatches}`);
  line(out, "dispatches remaining", Math.max(0, campaign.maxDispatches - campaign.dispatchesUsed));
  line(out, "startedAt", campaign.startedAt.toISOString());
  line(out, "lastAdmissionAt", campaign.lastAdmissionAt?.toISOString() ?? null);
  line(out, "endedAt", campaign.endedAt?.toISOString() ?? null);
}

/**
 * The systemic latch, printed whatever state it is in.
 *
 * Every field here is a classification or a count -- `HARD_CONFIGURATION`,
 * `AUTH`, a streak length, three timestamps. None of it is a secret, and none
 * of it is `generation`: the epoch that fences a late refund is internal
 * accounting an operator cannot act on, so it is not printed here or anywhere
 * else a person reads.
 */
function describeCircuit(out: (line: string) => void, circuit: HistoricalFillCircuitSnapshot): void {
  line(out, "state", circuit.state);
  line(out, "failureFamily", circuit.failureFamily);
  line(out, "lastReasonCode", circuit.lastReasonCode);
  line(out, "consecutiveCount", circuit.consecutiveCount);
  line(out, "firstFailureAt", circuit.firstFailureAt?.toISOString() ?? null);
  line(out, "lastFailureAt", circuit.lastFailureAt?.toISOString() ?? null);
  line(out, "openedAt", circuit.openedAt?.toISOString() ?? null);
}

/**
 * Whether this profile has a PERSISTED breaker row.
 *
 * `readState` answers an absent row as a logical CLOSED-and-clean snapshot,
 * which is the right answer for admission and the wrong one for a status
 * display: it would tell an operator the account has a circuit that is closed
 * when nothing has ever recorded one. A row is never created to find out.
 */
async function persistedCircuitRow(
  deps: FillCampaignCliDependencies,
  executionProfileId: string
): Promise<boolean> {
  const row = await deps.prisma.historicalFillCircuitBreaker.findUnique({
    where: { executionProfileId },
    select: { executionProfileId: true },
  });
  return row !== null;
}

/**
 * The account this CLI may act on, or a refusal.
 *
 * The SAME binder the runtime uses, taking no profile id, so there is no way
 * to point a campaign at an account the process was not configured for.
 */
async function boundProfile(
  deps: FillCampaignCliDependencies,
  out: (line: string) => void
): Promise<string | null> {
  const bind = deps.bindProfile ?? bindConfiguredExecutionProfileEnvironment;
  const binding = await bind(deps.prisma);
  if (!binding.ok) {
    out(`Refused: the configured execution profile could not be bound (${binding.reasonCode}).`);
    out("Nothing was changed.");
    return null;
  }
  return binding.context.executionProfileId;
}

/**
 * The campaign a lifecycle command should act on.
 *
 * An explicit `--campaign-id` always wins, and is checked to belong to THIS
 * profile -- an id from another environment must never be actionable here.
 * Without one, the profile's single live campaign is the target; if there is
 * none, the command refuses rather than reaching for the most recent terminal
 * row, because "abort" landing on a finished campaign would look like success
 * while the thing the operator meant to stop kept running.
 */
async function resolveTarget(
  deps: FillCampaignCliDependencies,
  out: (line: string) => void,
  executionProfileId: string,
  explicitId: string | null,
  verb: string
): Promise<HistoricalFillCampaign | null> {
  if (explicitId !== null) {
    if (explicitId === "") {
      out("Refused: --campaign-id was given but empty. Nothing was changed.");
      return null;
    }
    const campaign = await deps.campaigns.getCampaignStatus(explicitId);
    if (!campaign) {
      out(`Refused: no campaign with id ${explicitId}. Nothing was changed.`);
      return null;
    }
    if (campaign.executionProfileId !== executionProfileId) {
      out(`Refused: campaign ${explicitId} belongs to a different execution profile.`);
      out("Nothing was changed.");
      return null;
    }
    return campaign;
  }

  const live = await deps.campaigns.getLiveCampaign(executionProfileId);
  if (!live) {
    out(`Refused: this profile has no live campaign to ${verb}.`);
    out("Pass --campaign-id=<id> to act on a specific campaign. Nothing was changed.");
    return null;
  }
  return live;
}

/** Domain refusals are information, so they print and exit REFUSED, never throw. */
function reportDomainError(out: (line: string) => void, error: unknown): CliResult | null {
  if (
    error instanceof HistoricalFillCampaignValidationError ||
    error instanceof HistoricalFillCampaignConflictError ||
    error instanceof HistoricalFillCampaignStateError ||
    error instanceof HistoricalFillCampaignNotFoundError
  ) {
    out(`Refused: ${error.message}`);
    out("Nothing was changed.");
    return { exitCode: CLI_EXIT.REFUSED };
  }
  return null;
}

/**
 * Opens a campaign. The only command that authorises spending.
 *
 * `--max-dispatches` is REQUIRED and has no default, because a ceiling nobody
 * chose is not consent. It is parsed strictly here and re-proven by the service
 * and again by a database CHECK; none of the three is load-bearing alone.
 */
export async function startCommand(
  argv: string[],
  deps: FillCampaignCliDependencies
): Promise<CliResult> {
  const out = writer(deps);
  const unknown = unknownFlags(argv, ["max-dispatches", "note"]);
  if (unknown.length > 0) {
    out(USAGE);
    return { exitCode: CLI_EXIT.USAGE };
  }

  const raw = flag(argv, "max-dispatches");
  if (raw === null || raw === "") {
    out("Refused: --max-dispatches is required and has no default.");
    out(`State how many historical dispatches this backfill may spend (1..${MAX_CAMPAIGN_DISPATCHES}).`);
    out("Nothing was changed.");
    return { exitCode: CLI_EXIT.USAGE };
  }
  // Parsed strictly: `Number()` rejects "5x" where parseInt would read a 5, and
  // a ceiling silently read as something other than what was typed is the one
  // misreading that spends an account's allowance.
  const maxDispatches = Number(raw);

  const executionProfileId = await boundProfile(deps, out);
  if (executionProfileId === null) return { exitCode: CLI_EXIT.REFUSED };

  try {
    const campaign = await deps.campaigns.createCampaign({
      executionProfileId,
      maxDispatches,
      note: flag(argv, "note"),
    });
    out("Historical fill campaign started.");
    describe(out, campaign);
    out("");
    out("The worker will begin spending it on its next scheduled tick.");
    return { exitCode: CLI_EXIT.OK };
  } catch (error) {
    const reported = reportDomainError(out, error);
    if (reported) return reported;
    throw error;
  }
}

/** Stops admissions without giving the remaining budget up. */
export async function pauseCommand(
  argv: string[],
  deps: FillCampaignCliDependencies
): Promise<CliResult> {
  return lifecycle(argv, deps, {
    verb: "pause",
    allowedFlags: ["campaign-id"],
    apply: (campaignId, d) => d.campaigns.pauseCampaign(campaignId),
    success: "Campaign paused. The worker will admit no further dispatches for it.",
  });
}

/** Puts a paused campaign back to work with whatever budget remains. */
export async function resumeCommand(
  argv: string[],
  deps: FillCampaignCliDependencies
): Promise<CliResult> {
  return lifecycle(argv, deps, {
    verb: "resume",
    allowedFlags: ["campaign-id"],
    apply: (campaignId, d) => d.campaigns.resumeCampaign(campaignId),
    success: "Campaign resumed. The worker may spend its remaining budget from the next tick.",
  });
}

/** Ends a campaign for good. Moves toward safety, so it asks for nothing. */
export async function abortCommand(
  argv: string[],
  deps: FillCampaignCliDependencies
): Promise<CliResult> {
  return lifecycle(argv, deps, {
    verb: "abort",
    allowedFlags: ["campaign-id", "note"],
    apply: (campaignId, d, argvInner) =>
      d.campaigns.abortCampaign(campaignId, flag(argvInner, "note")),
    success: "Campaign aborted. No further dispatch will be admitted for it, ever.",
  });
}

async function lifecycle(
  argv: string[],
  deps: FillCampaignCliDependencies,
  spec: {
    verb: string;
    allowedFlags: readonly string[];
    apply: (
      campaignId: string,
      deps: FillCampaignCliDependencies,
      argv: string[]
    ) => Promise<HistoricalFillCampaign>;
    success: string;
  }
): Promise<CliResult> {
  const out = writer(deps);
  if (unknownFlags(argv, spec.allowedFlags).length > 0) {
    out(USAGE);
    return { exitCode: CLI_EXIT.USAGE };
  }

  const executionProfileId = await boundProfile(deps, out);
  if (executionProfileId === null) return { exitCode: CLI_EXIT.REFUSED };

  const target = await resolveTarget(
    deps,
    out,
    executionProfileId,
    flag(argv, "campaign-id"),
    spec.verb
  );
  if (target === null) return { exitCode: CLI_EXIT.REFUSED };

  try {
    const campaign = await spec.apply(target.id, deps, argv);
    out(spec.success);
    describe(out, campaign);
    return { exitCode: CLI_EXIT.OK };
  } catch (error) {
    const reported = reportDomainError(out, error);
    if (reported) return reported;
    throw error;
  }
}

/**
 * Reads the campaign. Writes nothing, and takes no lock.
 *
 * Without `--campaign-id` it shows the live campaign if there is one, and
 * otherwise says plainly that there is none -- an operator checking whether a
 * backfill is running must never have a finished campaign presented as if it
 * were the current one.
 */
export async function statusCommand(
  argv: string[],
  deps: FillCampaignCliDependencies
): Promise<CliResult> {
  const out = writer(deps);
  if (unknownFlags(argv, ["campaign-id"]).length > 0) {
    out(USAGE);
    return { exitCode: CLI_EXIT.USAGE };
  }

  const executionProfileId = await boundProfile(deps, out);
  if (executionProfileId === null) return { exitCode: CLI_EXIT.REFUSED };

  const explicitId = flag(argv, "campaign-id");
  if (explicitId !== null) {
    const target = await resolveTarget(deps, out, executionProfileId, explicitId, "inspect");
    if (target === null) return { exitCode: CLI_EXIT.REFUSED };
    out("Historical fill campaign:");
    describe(out, target);
    return { exitCode: CLI_EXIT.OK };
  }

  const live = await deps.campaigns.getLiveCampaign(executionProfileId);
  if (live) {
    out("Live historical fill campaign:");
    describe(out, live);
  } else {
    out("No live historical fill campaign for the configured profile.");
    out("The worker will admit no historical dispatches until one is started.");
  }

  // NEVER an early return above this. The circuit is PROFILE-level: it outlives
  // every campaign, and the single most important case for an operator is the
  // one where a systemic fault stopped the account and left no live campaign
  // behind to ask about. Returning on "no live campaign" would hide exactly the
  // state the operator came here to find.
  await reportCircuit(deps, out, executionProfileId);
  return { exitCode: CLI_EXIT.OK };
}

/** The latch, printed after the campaign and regardless of it. */
async function reportCircuit(
  deps: FillCampaignCliDependencies,
  out: (line: string) => void,
  executionProfileId: string
): Promise<void> {
  out("");
  if (!(await persistedCircuitRow(deps, executionProfileId))) {
    out("Historical fill circuit: CLOSED (no persisted breaker state).");
    return;
  }
  const circuit = await deps.circuit.readState({ executionProfileId });
  out("Historical fill circuit:");
  describeCircuit(out, circuit);
  if (circuit.state === "OPEN") {
    out("");
    out("The circuit is OPEN: no historical dispatch will be admitted for this profile.");
    out("Investigate the cause above, then run: pnpm execution:fill-circuit-acknowledge");
    out("Acknowledging clears the latch only. Resuming or starting a campaign stays separate.");
  }
}

/**
 * THE one explicit operator recovery action.
 *
 * Deliberately its own command rather than a flag on status or a side effect of
 * resume. Clearing a systemic latch is a person saying "I looked at this and it
 * is fixed", and that claim should cost a separate, deliberate keystroke --
 * which is also why there is no `--force`, no `--yes` and no profile selector.
 *
 * It does exactly one thing. The campaign it paused stays paused; a campaign
 * that exhausted its budget stays exhausted. Work resumes only when somebody
 * explicitly resumes or starts it.
 */
export async function acknowledgeCircuitCommand(
  argv: string[],
  deps: FillCampaignCliDependencies
): Promise<CliResult> {
  const out = writer(deps);
  // Zero arguments. Nothing here is tunable, so anything supplied is either a
  // misunderstanding or an attempt to point this at another account.
  if (argv.length > 0) {
    out(USAGE);
    return { exitCode: CLI_EXIT.USAGE };
  }

  const executionProfileId = await boundProfile(deps, out);
  if (executionProfileId === null) return { exitCode: CLI_EXIT.REFUSED };

  try {
    const result = await deps.circuit.acknowledge({ executionProfileId });
    if (result.result === "ALREADY_CLOSED") {
      // Idempotent and unremarkable: an operator who runs this twice, or who
      // acknowledges a circuit somebody else already cleared, has done nothing
      // wrong and nothing happened.
      out("Historical fill circuit is already CLOSED. Nothing was changed.");
      return { exitCode: CLI_EXIT.OK };
    }
    out("Historical fill circuit ACKNOWLEDGED and CLOSED.");
    describeCircuit(out, result.circuit);
    out("");
    out("No campaign was started, resumed or changed.");
    out("Run pnpm execution:fill-campaign-status to confirm, then resume or start explicitly.");
    return { exitCode: CLI_EXIT.OK };
  } catch (error) {
    if (error instanceof HistoricalFillCircuitInvariantError) {
      // The service refuses to clear a latch while an ACTIVE campaign exists,
      // because opening the circuit is supposed to have paused it. Reaching
      // here means something bypassed that, and clearing the latch would expose
      // runnable work to a fault nobody has finished investigating. Surfaced as
      // a refusal, never repaired automatically and never softened into
      // ALREADY_CLOSED.
      out(`Refused: ${error.message}`);
      out("The circuit is still OPEN and nothing was changed.");
      out("Resolve the ACTIVE campaign first, then acknowledge again.");
      return { exitCode: CLI_EXIT.REFUSED };
    }
    throw error;
  }
}

/** Dispatches one subcommand. Unknown or missing commands are a usage error. */
export async function runFillCampaignCli(
  argv: string[],
  deps: FillCampaignCliDependencies
): Promise<CliResult> {
  const [command, ...rest] = argv;
  switch (command) {
    case "start":
      return startCommand(rest, deps);
    case "pause":
      return pauseCommand(rest, deps);
    case "resume":
      return resumeCommand(rest, deps);
    case "abort":
      return abortCommand(rest, deps);
    case "status":
      return statusCommand(rest, deps);
    case "acknowledge-circuit":
      return acknowledgeCircuitCommand(rest, deps);
    default:
      writer(deps)(USAGE);
      return { exitCode: CLI_EXIT.USAGE };
  }
}
